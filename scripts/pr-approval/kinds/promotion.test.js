// SPDX-License-Identifier: Apache-2.0
// Unit tests for kind: promotion. Ported from strspc-pr-review's
// promotion.test.js; the cases that went through decide.js there call
// evaluate() directly here, with a ctx built the way decide.js builds it.
// Run with: node --test scripts/pr-approval/kinds/promotion.test.js

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { compareHead } = require('../util.js');
const promotion = require('./promotion.js');

const {
  promotionTitleBlocker,
  hasStandingApproval,
  checkProvenance,
  MAX_LISTED_COMMITS,
} = promotion;

const HEAD = 'cafe0002';
const MERGED_AT = '2026-10-01T11:00:00Z';
const source = (number, overrides = {}) => ({
  number, merged_at: MERGED_AT, head: { sha: `h${number}` }, base: { ref: 'develop' }, ...overrides,
});
// A source PR's review, in the shape SOURCE_REVIEWS_QUERY returns.
const approval = (number, overrides = {}) => ({
  state: 'APPROVED',
  submittedAt: '2026-10-01T10:00:00Z',
  authorCanPushToRepository: true,
  author: { login: 'someone' },
  commit: { oid: `h${number}` },
  ...overrides,
});

// A repo with commits c1 (from PR 11) and HEAD (from PR 12) on develop, both
// approved. Each test overrides the one fact it is about.
function makeRepo({
  commits = [{ sha: 'cafe0001' }, { sha: HEAD }],
  associated = { cafe0001: [source(11)], [HEAD]: [source(12)] },
  reviews = { 11: [approval(11)], 12: [approval(12)] },
  truncated = [],
} = {}) {
  const calls = { listCommits: 0, sourceReviews: 0, compare: 0 };
  const github = {
    paginate: async (fn, params) => (await fn(params)).data,
    graphql: async (query, { number }) => {
      assert.match(query, /authorCanPushToRepository/);
      calls.sourceReviews += 1;
      const page = { nodes: reviews[number] || [], pageInfo: { hasNextPage: truncated.includes(number) } };
      return { repository: { pullRequest: { reviews: page } } };
    },
    rest: {
      repos: {
        listPullRequestsAssociatedWithCommit: async ({ commit_sha }) => ({ data: associated[commit_sha] || [] }),
        compareCommitsWithBasehead: async () => {
          calls.compare += 1;
          return { data: { files: [], merge_base_commit: { sha: 'mb' } } };
        },
      },
      pulls: {
        listCommits: async () => {
          calls.listCommits += 1;
          return { data: commits };
        },
      },
    },
  };
  return { github, calls };
}

function promotionPr(overrides = {}) {
  return {
    number: 171,
    draft: false,
    title: 'chore: promote develop to main',
    user: { login: 'someone' },
    head: { ref: 'develop', sha: HEAD },
    base: { ref: 'main' },
    ...overrides,
  };
}

// The ctx decide.js hands a kind, with the same memoised compare().
function makeCtx({ repo = makeRepo(), pr = promotionPr(), options = {} } = {}) {
  const owner = 'acme';
  const name = 'widgets';
  let compared = null;
  const compare = async () => {
    if (!compared) {
      compared = await compareHead({ github: repo.github, owner, repo: name, baseRef: pr.base.ref, headSha: pr.head.sha });
    }
    return compared;
  };
  return {
    github: repo.github, owner, repo: name, pr, policy: { id: 'p', kind: 'promotion', options }, options,
    compare, checkRuns: [], core: { info() {}, warning() {} }, botLogin: 'approver-bot',
  };
}

// -- Kind contract ---------------------------------------------------------

test('kind: name and requiresTip', () => {
  assert.equal(promotion.name, 'promotion');
  assert.equal(promotion.requiresTip, true);
  assert.equal(typeof promotion.evaluate, 'function');
});

test('defaultMatch: develop into main', () => {
  assert.deepEqual(promotion.defaultMatch({}), { head: 'develop', base: 'main' });
});

test('validateOptions: only an empty options block is accepted', () => {
  assert.deepEqual(promotion.validateOptions({}), []);
  assert.deepEqual(promotion.validateOptions({ provenance: false }), ['unknown option provenance']);
  assert.deepEqual(promotion.validateOptions({ a: 1, b: 2 }), ['unknown option a', 'unknown option b']);
});

// -- Title -----------------------------------------------------------------

test('promotionTitleBlocker: only a plain chore title passes', () => {
  assert.equal(promotionTitleBlocker('chore: promote develop to main'), null);
  assert.equal(promotionTitleBlocker('chore(release): 1.2.0'), null);
  assert.match(promotionTitleBlocker('feat: promote'), /type 'feat'/);
  assert.match(promotionTitleBlocker('fix(api): promote'), /type 'fix'/);
  assert.match(promotionTitleBlocker('chore!: promote'), /breaking/);
  assert.match(promotionTitleBlocker('promote develop'), /not a Conventional Commit/);
  assert.match(promotionTitleBlocker(undefined), /not a Conventional Commit/);
});

// -- Provenance ------------------------------------------------------------

const FACTS = { headSha: 'h1', mergedAt: MERGED_AT };
const standing = (reviews, facts = FACTS) => hasStandingApproval(reviews, facts);
const review = (state, submittedAt = '2026-10-01T10:00:00Z', overrides = {}) =>
  approval(1, { state, submittedAt, ...overrides });

test('hasStandingApproval: a reviewer\'s latest decisive review counts', () => {
  assert.equal(standing([]), false);
  assert.equal(standing([review('COMMENTED')]), false);
  assert.equal(standing([review('APPROVED')]), true);
  assert.equal(standing([review('DISMISSED')]), false);
  assert.equal(standing([review('APPROVED'), review('COMMENTED', '2026-10-01T10:30:00Z')]), true);
  assert.equal(standing([review('APPROVED'), review('DISMISSED', '2026-10-01T10:30:00Z')]), false);
  assert.equal(standing([
    review('CHANGES_REQUESTED', '2026-10-01T10:30:00Z'),
    review('APPROVED'),
  ]), false, 'order comes from submitted_at, not from the list');
  assert.equal(standing([review('APPROVED', '2026-10-01T10:00:00Z', { author: null })]), false);
});

test('hasStandingApproval: an approval must name the commit that merged', () => {
  assert.equal(standing([review('APPROVED', '2026-10-01T10:00:00Z', { commit: { oid: 'older' } })]), false);
  assert.equal(standing([review('APPROVED', '2026-10-01T10:00:00Z', { commit: null })]), false);
});

test('hasStandingApproval: an approval after the merge does not count', () => {
  assert.equal(standing([review('APPROVED', '2026-10-01T11:00:01Z')]), false);
  assert.equal(standing([review('APPROVED', MERGED_AT)]), false, 'a tie cannot be shown to precede the merge');
  assert.equal(standing([review('APPROVED', '2026-10-01T10:00:00Z')], { ...FACTS, mergedAt: undefined }), false);
});

test('hasStandingApproval: no head to compare against proves nothing', () => {
  const noOid = review('APPROVED', '2026-10-01T10:00:00Z', { commit: {} });
  assert.equal(standing([noOid], { ...FACTS, headSha: undefined }), false);
});

test('hasStandingApproval: another reviewer\'s open change request blocks', () => {
  assert.equal(standing([
    review('APPROVED'),
    review('CHANGES_REQUESTED', '2026-10-01T10:30:00Z', { author: { login: 'other' } }),
  ]), false);
});

test('hasStandingApproval: a reviewer who cannot push does not count', () => {
  const noPush = { authorCanPushToRepository: false };
  assert.equal(standing([review('APPROVED', '2026-10-01T10:00:00Z', noPush)]), false);
  assert.equal(standing([
    review('APPROVED', '2026-10-01T10:00:00Z', noPush),
    review('APPROVED', '2026-10-01T10:00:00Z', { author: { login: 'other' } }),
  ]), true);
});

const provenance = (repo) => checkProvenance({
  github: repo.github, owner: 'acme', repo: 'widgets', prNumber: 171, headRef: 'develop', headSha: HEAD,
});

test('checkProvenance: every commit from an approved PR passes', async () => {
  assert.deepEqual(await provenance(makeRepo()), { ok: true, commits: 2, prs: 2 });
});

test('checkProvenance: two commits of one PR read its reviews once', async () => {
  const repo = makeRepo({ associated: { cafe0001: [source(11)], [HEAD]: [source(11)] } });
  assert.deepEqual(await provenance(repo), { ok: true, commits: 2, prs: 1 });
  assert.equal(repo.calls.sourceReviews, 1);
});

test('checkProvenance: more reviews than one page cannot be judged, so it fails', async () => {
  const out = await provenance(makeRepo({ truncated: [12] }));
  assert.match(out.reason, /came from #12, which has no standing approval/);
});

test('checkProvenance: a commit with no PR fails and names the commit', async () => {
  const out = await provenance(makeRepo({ associated: { [HEAD]: [source(12)] } }));
  assert.equal(out.ok, false);
  assert.match(out.reason, /commit cafe0001 has no merged PR into develop/);
});

test('checkProvenance: a PR that is open, or merged elsewhere, does not count', async () => {
  const out = await provenance(makeRepo({
    associated: {
      cafe0001: [source(20, { merged_at: null }), source(21, { base: { ref: 'main' } })],
    },
  }));
  assert.match(out.reason, /commit cafe0001 has no merged PR into develop/);
});

test('checkProvenance: a PR with no approval fails and names both', async () => {
  const out = await provenance(makeRepo({ reviews: { 11: [approval(11)], 12: [] } }));
  assert.equal(out.ok, false);
  assert.match(out.reason, new RegExp(`commit ${HEAD} came from #12, which has no standing approval`));
});

test('checkProvenance: an approval of an earlier commit of the PR fails', async () => {
  const out = await provenance(makeRepo({
    reviews: { 11: [approval(11)], 12: [approval(12, { commit: { oid: 'earlier' } })] },
  }));
  assert.match(out.reason, /came from #12, which has no standing approval/);
});

test('checkProvenance: a missing source head fails rather than matching nothing to nothing', async () => {
  const out = await provenance(makeRepo({
    associated: { cafe0001: [source(11, { head: null })], [HEAD]: [source(12)] },
    reviews: { 11: [approval(11, { commit: null })], 12: [approval(12)] },
  }));
  assert.match(out.reason, /came from #11, which has no standing approval/);
});

test('checkProvenance: every associated merged PR must be approved', async () => {
  const associated = { cafe0001: [source(11), source(13)], [HEAD]: [source(12)] };
  const stacked = await provenance(makeRepo({
    associated, reviews: { 11: [], 12: [approval(12)], 13: [approval(13)] },
  }));
  assert.match(stacked.reason, /commit cafe0001 came from #11/);
  const both = await provenance(makeRepo({
    associated, reviews: { 11: [approval(11)], 12: [approval(12)], 13: [approval(13)] },
  }));
  assert.equal(both.ok, true);
});

test('checkProvenance: a full commit list may be partial, so it fails', async () => {
  const commits = Array.from({ length: MAX_LISTED_COMMITS }, (_, i) => ({ sha: `s${i}` }));
  const out = await provenance(makeRepo({ commits }));
  assert.equal(out.ok, false);
  assert.match(out.reason, /250 commits or more/);
});

test('checkProvenance: a list without the evaluated head fails', async () => {
  const out = await provenance(makeRepo({ commits: [{ sha: 'cafe0001' }] }));
  assert.equal(out.ok, false);
  assert.match(out.reason, /does not include the evaluated head/);
});

// -- evaluate --------------------------------------------------------------

test('evaluate: a passing promotion names its commits and approved PRs', async () => {
  const ctx = makeCtx();
  const out = await promotion.evaluate(ctx);
  assert.deepEqual(out, { ok: true, summary: 'promotion (develop to main, 2 commit(s) from 2 approved PR(s))' });
});

test('evaluate: the summary names the PR\'s own refs', async () => {
  const pr = promotionPr({ head: { ref: 'next', sha: HEAD }, base: { ref: 'stable' } });
  const repo = makeRepo({
    associated: { cafe0001: [source(11, { base: { ref: 'next' } })], [HEAD]: [source(12, { base: { ref: 'next' } })] },
  });
  const out = await promotion.evaluate(makeCtx({ repo, pr }));
  assert.equal(out.summary, 'promotion (next to stable, 2 commit(s) from 2 approved PR(s))');
});

test('evaluate: provenance reads the PR\'s own commits, not the diff', async () => {
  const repo = makeRepo();
  await promotion.evaluate(makeCtx({ repo }));
  assert.equal(repo.calls.compare, 0);
  assert.equal(repo.calls.listCommits, 1);
});

test('evaluate: a feat title is refused before any API call', async () => {
  const repo = makeRepo();
  const out = await promotion.evaluate(makeCtx({ repo, pr: promotionPr({ title: 'feat: promote develop to main' }) }));
  assert.equal(out.ok, false);
  assert.match(out.reason, /title type 'feat' would be counted twice/);
  assert.equal(repo.calls.listCommits, 0);
});

test('evaluate: a breaking chore title is refused', async () => {
  const out = await promotion.evaluate(makeCtx({ pr: promotionPr({ title: 'chore!: promote' }) }));
  assert.equal(out.ok, false);
  assert.match(out.reason, /marked breaking/);
});

test('evaluate: a commit whose PR merged with no standing approval is refused, naming the PR', async () => {
  const repo = makeRepo({ reviews: { 11: [], 12: [approval(12)] } });
  const out = await promotion.evaluate(makeCtx({ repo }));
  assert.equal(out.ok, false);
  assert.equal(out.reason, 'commit cafe0001 came from #11, which has no standing approval');
});

test('evaluate: an approval given after the merge does not launder the PR', async () => {
  const late = approval(11, { submittedAt: '2026-10-01T12:00:00Z' });
  const out = await promotion.evaluate(makeCtx({ repo: makeRepo({ reviews: { 11: [late], 12: [approval(12)] } }) }));
  assert.equal(out.ok, false);
  assert.match(out.reason, /#11, which has no standing approval/);
});

test('evaluate: a commit with no PR is refused', async () => {
  const out = await promotion.evaluate(makeCtx({ repo: makeRepo({ associated: { [HEAD]: [source(12)] } }) }));
  assert.equal(out.ok, false);
  assert.match(out.reason, /commit cafe0001 has no merged PR into develop/);
});

test('evaluate: the bot\'s own approval counts for provenance', async () => {
  const bot = { author: { login: 'approver-bot' } };
  const out = await promotion.evaluate(makeCtx({
    repo: makeRepo({ reviews: { 11: [approval(11, bot)], 12: [approval(12, bot)] } }),
  }));
  assert.equal(out.ok, true, out.reason);
});

test('evaluate: 250 commits or more is refused', async () => {
  const commits = Array.from({ length: 251 }, (_, i) => ({ sha: `s${i}` }));
  const out = await promotion.evaluate(makeCtx({ repo: makeRepo({ commits }) }));
  assert.equal(out.ok, false);
  assert.match(out.reason, /250 commits or more/);
});

test('evaluate: a failed read throws, so decide.js withdraws and reports it', async () => {
  const repo = makeRepo();
  repo.github.rest.pulls.listCommits = async () => {
    throw Object.assign(new Error('boom'), { status: 502 });
  };
  await assert.rejects(promotion.evaluate(makeCtx({ repo })), /boom/);
});
