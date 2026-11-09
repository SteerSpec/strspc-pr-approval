// SPDX-License-Identifier: Apache-2.0
const test = require('node:test');
const assert = require('node:assert/strict');

// decide.js requires kinds/index.js at load time. These tests inject stub
// kinds, so the real modules are replaced by an empty export before decide.js
// is loaded (require.resolve locates the file without running it).
const kindsPath = require.resolve('./kinds/index.js');
require.cache[kindsPath] = { id: kindsPath, filename: kindsPath, loaded: true, exports: {} };
const decide = require('./decide.js');

const { decideInner, MARKER } = decide;

const BOT = 'approver-bot';
const HEAD = 'a1'.repeat(20);
const OLD = 'b2'.repeat(20);
const httpError = (status, message = `HTTP ${status}`, extra = {}) => Object.assign(new Error(message), { status }, extra);

const basePr = () => ({
  number: 5,
  state: 'open',
  draft: false,
  title: 'chore(main): release 1.2.0',
  html_url: 'https://github.com/o/r/pull/5',
  user: { login: 'release-bot' },
  base: { ref: 'main' },
  head: { ref: 'release-please--branches--main', sha: HEAD, repo: { full_name: 'o/r' } },
  labels: [],
});

const basePolicy = (extra = {}) => ({ id: 'release', kind: 'release', rules: ['APPROVE-006', 'MERGE-001'], ...extra });

const realmFiles = {
  'o/r@main/rules/APPROVE.json': { rules: [{ id: 'APPROVE-006', state: 'D' }, { id: 'APPROVE-099', state: 'W' }] },
  'o/r@main/rules/MERGE.json': { rules: [{ id: 'MERGE-001', state: 'D' }] },
};
const policyFile = (policies) => ({
  'o/r@main/.strspc/pr-approval.yml': { version: 1, realm: '../rules', policies },
  ...realmFiles,
});

function stubKinds({ evaluate, requiresTip = false } = {}) {
  const calls = [];
  return {
    calls,
    release: {
      name: 'release',
      requiresTip,
      defaultMatch: () => ({ head: 'release-please--branches--*' }),
      validateOptions: () => [],
      evaluate: async (ctx) => {
        calls.push(ctx);
        return evaluate ? evaluate(ctx) : { ok: true, summary: 'release 1.2.0' };
      },
    },
    custom: { name: 'custom', defaultMatch: () => ({}), validateOptions: () => [], evaluate: async () => ({ ok: true }) },
  };
}

// The fake GitHub. `prReads[i]` overrides the PR returned by the i-th
// pulls.get call (an Error is thrown); later calls return the base PR.
function harness(o = {}) {
  const pr = Object.assign(basePr(), o.pr || {});
  const files = o.files || policyFile(o.policies || [basePolicy(o.policy)]);
  const reviews = (o.reviews || []).map((r) => ({ ...r }));
  const checkRuns = o.checkRuns || [
    { id: 1, name: 'test', app: { id: 1 }, status: 'completed', conclusion: 'success', started_at: '2026-01-01T00:00:00Z' },
  ];
  const mergeBases = o.mergeBases ? [...o.mergeBases] : [];
  const calls = { getContent: [], pullsGet: [], createReview: [], dismissReview: [], listReviews: 0, getRef: [], compare: 0, merge: [] };
  let nextReviewId = 1000;
  const prReads = o.prReads || [];
  const val = (v) => { if (v instanceof Error) throw v; return v; };

  const github = {
    paginate: async (fn, params) => (await fn(params)).data,
    rest: {
      pulls: {
        get: async ({ pull_number }) => {
          const i = calls.pullsGet.length;
          calls.pullsGet.push(pull_number);
          const over = prReads[i];
          if (over instanceof Error) throw over;
          const cur = basePr();
          Object.assign(cur, o.pr || {}, over || {});
          return { data: cur };
        },
        listReviews: async () => {
          calls.listReviews++;
          if (o.listReviewsError) throw o.listReviewsError;
          return { data: reviews.map((r) => ({ ...r })) };
        },
        createReview: async (p) => {
          calls.createReview.push(p);
          const saved = { id: nextReviewId++, user: { login: BOT }, state: 'APPROVED', commit_id: p.commit_id, body: p.body };
          if (o.createReviewError) {
            if (o.createReviewSaves) reviews.push(saved);
            throw o.createReviewError;
          }
          reviews.push(saved);
          return { data: saved };
        },
        dismissReview: async (p) => {
          calls.dismissReview.push(p);
          if (o.dismissError) throw o.dismissError;
          const r = reviews.find((x) => x.id === p.review_id);
          if (r) r.state = 'DISMISSED';
          return { data: {} };
        },
      },
      repos: {
        getContent: async ({ owner, repo, path, ref }) => {
          const key = `${owner}/${repo}@${ref}/${path}`;
          calls.getContent.push(key);
          if (!(key in files)) throw httpError(404);
          const v = files[key];
          const text = typeof v === 'string' ? v : JSON.stringify(v);
          return { data: { type: 'file', size: text.length, encoding: 'base64', content: Buffer.from(text).toString('base64') } };
        },
        compareCommitsWithBasehead: async () => {
          calls.compare++;
          const mb = mergeBases.length > 1 ? mergeBases.shift() : (mergeBases[0] || 'mb');
          return { data: { files: o.compareFiles || [{ filename: 'CHANGELOG.md', additions: 1, deletions: 0 }], merge_base_commit: { sha: mb }, total_commits: 1 } };
        },
      },
      checks: {
        listForRef: async () => ({ data: { total_count: checkRuns.length, check_runs: val(checkRuns) } }),
      },
      git: {
        getRef: async ({ ref }) => {
          calls.getRef.push(ref);
          return { data: { object: { sha: o.tipSha || HEAD } } };
        },
      },
    },
  };

  const core = {
    outputs: {}, infos: [], errors: [], failed: [],
    setOutput(k, v) { this.outputs[k] = v; },
    info(m) { this.infos.push(m); },
    error(m) { this.errors.push(m); },
    setFailed(m) { this.failed.push(m); },
  };
  if (o.summary) {
    core.summary = {
      raw: [],
      addRaw(t) { this.raw.push(t); return this; },
      async write() { if (o.summary === 'throws') throw new Error('no summary file'); },
    };
  }

  const kinds = o.kinds || stubKinds(o.kindOpts);
  const mergeCalls = [];
  const merge = async (args) => { mergeCalls.push(args); return o.mergeResult || { merged: true, method: 'squash' }; };
  const context = {
    repo: { owner: 'o', repo: 'r' },
    payload: o.payload || { pull_request: pr },
    runId: 99,
    job: 'approve',
  };
  const env = { PR_APPROVAL_BOT_LOGIN: BOT, ...(o.env || {}) };
  return { github, core, kinds, merge, mergeCalls, context, env, calls, reviews };
}

async function run(o = {}) {
  const h = harness(o);
  const result = await decideInner({
    github: h.github,
    mergeGithub: o.mergeGithub,
    context: h.context,
    core: h.core,
    env: h.env,
    kinds: h.kinds,
    merge: h.merge,
    vetoes: o.vetoes,
  });
  return { ...h, result };
}

const ourApproval = (id, commit_id) => ({ id, user: { login: BOT }, state: 'APPROVED', commit_id });
const assertNoWrites = (h) => {
  assert.equal(h.calls.createReview.length, 0, 'createReview');
  assert.equal(h.calls.dismissReview.length, 0, 'dismissReview');
  assert.equal(h.mergeCalls.length, 0, 'merge');
};

// --- configuration and event resolution ---------------------------------------

test('readConfig defaults', () => {
  assert.deepEqual(decide.readConfig({}), {
    botLogin: '', policyFile: decide.DEFAULT_POLICY_FILE, dryRun: false, allowNoChecks: false,
  });
  assert.deepEqual(decide.readConfig({
    PR_APPROVAL_BOT_LOGIN: ' b ', PR_APPROVAL_POLICY_FILE: 'x.yml', PR_APPROVAL_DRY_RUN: 'TRUE', PR_APPROVAL_ALLOW_NO_CHECKS: 'true',
  }), { botLogin: 'b', policyFile: 'x.yml', dryRun: true, allowNoChecks: true });
});

test('an empty bot-login fails the job', async () => {
  const h = await run({ env: { PR_APPROVAL_BOT_LOGIN: '  ' } });
  assert.equal(h.result.decision, 'error');
  assert.match(h.result.reason, /bot-login is empty/);
  assert.equal(h.core.failed.length, 1);
  assert.equal(h.core.outputs.decision, 'error');
  assert.equal(h.calls.getContent.length, 0);
});

test("a review event by the bot itself is skipped", async () => {
  const h = await run({ payload: { pull_request: basePr(), review: { user: { login: BOT } } } });
  assert.equal(h.result.decision, 'skip');
  assert.equal(h.result.reason, "triggered by the bot's own review");
  assert.equal(h.calls.getContent.length, 0);
});

test('an event without a pull request is skipped', async () => {
  const h = await run({ payload: { push: {} } });
  assert.deepEqual([h.result.decision, h.result.reason], ['skip', 'no pull_request in event']);
  assert.equal(h.core.outputs.pr_number, '');
});

test('check_run: the PR is read from its associated pull requests', async () => {
  const h = await run({ payload: { check_run: { pull_requests: [{ number: 5 }] } } });
  assert.equal(h.result.decision, 'approved');
  assert.equal(h.calls.pullsGet[0], 5);
});

test('check_run without an associated PR is skipped', async () => {
  for (const pull_requests of [[], undefined, [{ number: 0 }]]) {
    const h = await run({ payload: { check_run: { pull_requests } } });
    assert.deepEqual([h.result.decision, h.result.reason], ['skip', 'event has no associated PR']);
  }
});

test('workflow_run: resolves the PR, and skips skipped runs and other repositories', async () => {
  const wr = (extra) => ({ workflow_run: { conclusion: 'success', head_repository: { full_name: 'o/r' }, pull_requests: [{ number: 5 }], ...extra } });
  const ok = await run({ payload: wr() });
  assert.equal(ok.result.decision, 'approved');
  assert.equal(ok.calls.pullsGet[0], 5);
  const skipped = await run({ payload: wr({ conclusion: 'skipped' }) });
  assert.equal(skipped.result.reason, 'workflow_run: conclusion is skipped');
  const fork = await run({ payload: wr({ head_repository: { full_name: 'fork/r' } }) });
  assert.equal(fork.result.reason, 'workflow_run: head repo does not match current repo');
  const none = await run({ payload: wr({ head_repository: null }) });
  assert.equal(none.result.reason, 'workflow_run: head repo does not match current repo');
});

// --- APPROVE-001 ---------------------------------------------------------------

test('APPROVE-001: a draft PR is not approved', async () => {
  const h = await run({ pr: { draft: true } });
  assert.deepEqual([h.result.decision, h.result.reason], ['skip', 'PR is draft']);
  assert.equal(h.calls.getContent.length, 0);
});

test('APPROVE-001: a PR whose head is in another repository is not approved', async () => {
  for (const head of [{ ...basePr().head, repo: { full_name: 'fork/r' } }, { ...basePr().head, repo: null }]) {
    const h = await run({ pr: { head } });
    assert.deepEqual([h.result.decision, h.result.reason], ['skip', 'PR head repo does not match current repo']);
  }
});

test('APPROVE-001: a PR the approving account authored is not approved', async () => {
  const h = await run({ pr: { user: { login: BOT } } });
  assert.deepEqual([h.result.decision, h.result.reason], ['skip', 'PR author is the approving account']);
});

test('APPROVE-001: a closed PR is skipped', async () => {
  const h = await run({ pr: { state: 'closed' } });
  assert.deepEqual([h.result.decision, h.result.reason], ['skip', 'PR is closed']);
});

// --- policy ----------------------------------------------------------------------

test('POLICY-001: the policy is read from the base branch, never the head', async () => {
  const h = await run({
    files: {
      ...policyFile([basePolicy()]),
      // A policy on the head ref that would approve anything must never be read.
      'o/r@release-please--branches--main/.strspc/pr-approval.yml': { version: 1 },
    },
  });
  assert.equal(h.result.decision, 'approved');
  assert.equal(h.calls.getContent[0], 'o/r@main/.strspc/pr-approval.yml');
  assert.ok(h.calls.getContent.every((k) => k.startsWith('o/r@main/')), h.calls.getContent.join(', '));
});

test('POLICY-001: a custom policy file path is honoured', async () => {
  const h = await run({ env: { PR_APPROVAL_POLICY_FILE: './ci/approve.yml' }, files: {} });
  assert.deepEqual([h.result.decision, h.result.reason], ['skip', 'no ./ci/approve.yml on main']);
  assert.deepEqual(h.calls.getContent, ['o/r@main/ci/approve.yml']);
});

test('POLICY-004: an API error reading the policy is not a policy error; decide() skips', async () => {
  const h = harness();
  h.github.rest.repos.getContent = async () => { throw httpError(503, 'unavailable'); };
  const result = await decide({ github: h.github, context: h.context, core: h.core, env: h.env, kinds: h.kinds, merge: h.merge });
  assert.deepEqual(result, { decision: 'skip', reason: 'evaluation failed: 503 unavailable' });
  assert.equal(h.core.failed.length, 0);
  assertNoWrites(h);
});

test('POLICY-006: no policy file on the base branch means no action', async () => {
  const h = await run({ files: realmFiles });
  assert.deepEqual([h.result.decision, h.result.reason], ['skip', 'no .strspc/pr-approval.yml on main']);
  assertNoWrites(h);
});

test('POLICY-004: an invalid policy fails the job and takes no action', async () => {
  const h = await run({ files: { 'o/r@main/.strspc/pr-approval.yml': { version: 2 } }, reviews: [ourApproval(1, OLD)] });
  assert.equal(h.result.decision, 'error');
  assert.match(h.result.reason, /invalid policy: .*version: must be 1/);
  assert.equal(h.core.failed.length, 1);
  assert.equal(h.core.errors.length, 1);
  assert.equal(h.calls.listReviews, 0);
  assertNoWrites(h);
});

test('POLICY-005: a policy citing a withdrawn rule fails the job', async () => {
  const h = await run({ policy: { rules: ['APPROVE-099'] } });
  assert.equal(h.result.decision, 'error');
  assert.match(h.result.reason, /cites APPROVE-099: rule APPROVE-099 is withdrawn/);
  assertNoWrites(h);
});

test('POLICY-006: no matching policy means no action', async () => {
  const h = await run({ pr: { head: { ...basePr().head, ref: 'feature/x' } }, reviews: [ourApproval(1, OLD)] });
  assert.deepEqual([h.result.decision, h.result.reason], ['skip', 'no policy matches this PR']);
  assert.equal(h.core.outputs.policy, '');
  assertNoWrites(h);
});

test('POLICY-006: the first matching policy applies', async () => {
  const h = await run({
    policies: [
      basePolicy({ id: 'other', match: { authors: ['someone'] } }),
      basePolicy({ id: 'first' }),
      basePolicy({ id: 'second' }),
    ],
  });
  assert.equal(h.result.policy, 'first');
});

test('a matching policy with approve: false approves nothing', async () => {
  const h = await run({ policy: { approve: false } });
  assert.deepEqual([h.result.decision, h.result.reason], ['skip', '[release: APPROVE-006, MERGE-001] the matching policy approves nothing']);
  assertNoWrites(h);
});

// --- head and checks -----------------------------------------------------------

test('APPROVE-005: a kind that requires the tip skips when the head is not the tip', async () => {
  const h = await run({ kindOpts: { requiresTip: true }, tipSha: OLD });
  assert.equal(h.result.decision, 'skip');
  assert.match(h.result.reason, /is not the tip of release-please--branches--main/);
  assert.deepEqual(h.calls.getRef, ['heads/release-please--branches--main']);
  assertNoWrites(h);
});

test('APPROVE-005: a kind that requires the tip proceeds when the head is the tip', async () => {
  const h = await run({ kindOpts: { requiresTip: true } });
  assert.equal(h.result.decision, 'approved');
});

test('APPROVE-004: an earlier approval of a different head is withdrawn before evaluating', async () => {
  const h = await run({ reviews: [ourApproval(11, OLD), { id: 12, user: { login: 'human' }, state: 'APPROVED', commit_id: OLD }] });
  assert.deepEqual(h.calls.dismissReview.map((d) => d.review_id), [11]);
  assert.match(h.calls.dismissReview[0].message, /is a new head/);
  assert.equal(h.result.decision, 'approved');
  assert.equal(h.calls.createReview.length, 1);
});

test('APPROVE-004: a failure to withdraw is an error, not a skip', async () => {
  const h = await run({ reviews: [ourApproval(11, OLD)], dismissError: httpError(500, 'nope') });
  assert.equal(h.result.decision, 'error');
  assert.match(h.result.reason, /could not withdraw approval\(s\): review 11: 500 nope/);
  assert.equal(h.calls.createReview.length, 0);
});

test('APPROVE-004: a failure to list reviews for withdrawal is an error', async () => {
  const h = await run({ listReviewsError: httpError(502, 'down') });
  assert.equal(h.result.decision, 'error');
  assert.match(h.result.reason, /could not list reviews to withdraw an approval: 502 down/);
});

test('APPROVE-002: no checks on the head skips', async () => {
  const h = await run({ checkRuns: [] });
  assert.deepEqual([h.result.decision, h.result.reason], ['skip', '[release: APPROVE-006, MERGE-001] no checks on head SHA yet']);
  assert.equal(h.calls.createReview.length, 0);
});

test('APPROVE-002: allow-no-checks lets a head without checks be approved', async () => {
  const h = await run({ checkRuns: [], env: { PR_APPROVAL_ALLOW_NO_CHECKS: 'true' } });
  assert.equal(h.result.decision, 'approved');
});

test('APPROVE-002: a failing check refuses and withdraws our approval', async () => {
  const h = await run({
    reviews: [ourApproval(21, HEAD)],
    checkRuns: [{ id: 1, name: 'test', app: { id: 1 }, status: 'completed', conclusion: 'failure' }],
  });
  assert.equal(h.result.decision, 'skip');
  assert.match(h.result.reason, /failing check: test \(failure\)/);
  assert.deepEqual(h.calls.dismissReview.map((d) => d.review_id), [21]);
  assert.match(h.calls.dismissReview[0].message, /^Withdrawn: \[release: APPROVE-006, MERGE-001\] failing check/);
  assert.equal(h.calls.createReview.length, 0);
});

test('APPROVE-002: a cancelled check (e.g. another bot cancelled by its concurrency group) does not refuse', async () => {
  const h = await run({ checkRuns: [
    { id: 1, name: 'auto-approve', app: { id: 1 }, status: 'completed', conclusion: 'cancelled' },
    { id: 2, name: 'test', app: { id: 1 }, status: 'completed', conclusion: 'success' },
  ] });
  assert.doesNotMatch(h.result.reason, /failing check/);
});

test('APPROVE-002: a check still running skips without withdrawing', async () => {
  const h = await run({
    reviews: [ourApproval(21, HEAD)],
    checkRuns: [
      { id: 1, name: 'test', app: { id: 1 }, status: 'completed', conclusion: 'success' },
      { id: 2, name: 'e2e', app: { id: 1 }, status: 'in_progress' },
    ],
  });
  assert.match(h.result.reason, /check still running: e2e/);
  assertNoWrites(h);
});

// --- kind, require, vetoes -----------------------------------------------------

test('APPROVE-006: the kind receives the evaluation context', async () => {
  const h = await run();
  const ctx = h.kinds.calls[0];
  assert.equal(ctx.pr.number, 5);
  assert.equal(ctx.policy.id, 'release');
  assert.equal(ctx.botLogin, BOT);
  assert.equal(ctx.checkRuns.length, 1);
  assert.equal(typeof ctx.compare, 'function');
});

test('APPROVE-006: a kind refusal withdraws our approval', async () => {
  const h = await run({ reviews: [ourApproval(31, HEAD)], kindOpts: { evaluate: () => ({ ok: false, reason: 'a file outside release-please' }) } });
  assert.equal(h.result.decision, 'skip');
  assert.equal(h.result.reason, '[release: APPROVE-006, MERGE-001] a file outside release-please');
  assert.deepEqual(h.calls.dismissReview.map((d) => d.review_id), [31]);
  assert.equal(h.calls.createReview.length, 0);
});

test('APPROVE-006: a kind that throws withdraws, then the error becomes a clean skip', async () => {
  const h = harness({ reviews: [ourApproval(31, HEAD)], kindOpts: { evaluate: () => { throw httpError(500, 'compare failed'); } } });
  const result = await decide({ github: h.github, context: h.context, core: h.core, env: h.env, kinds: h.kinds, merge: h.merge });
  assert.deepEqual(result, { decision: 'skip', reason: 'evaluation failed: 500 compare failed' });
  assert.deepEqual(h.calls.dismissReview.map((d) => d.review_id), [31]);
  assert.match(h.calls.dismissReview[0].message, /the release PR could not be verified \(500 compare failed\)/);
  assert.equal(h.calls.createReview.length, 0);
});

test('APPROVE-010: a require condition refuses and withdraws', async () => {
  const h = await run({ reviews: [ourApproval(41, HEAD)], policy: { require: { 'no-labels': ['hold'] } }, pr: { labels: [{ name: 'hold' }] } });
  assert.equal(h.result.reason, "[release: APPROVE-006, MERGE-001] carries label 'hold'");
  assert.deepEqual(h.calls.dismissReview.map((d) => d.review_id), [41]);
  assert.equal(h.calls.createReview.length, 0);
});

test('APPROVE-010: require file conditions use the compare listing of the head', async () => {
  const blocked = await run({ policy: { require: { paths: ['docs/**'] } } });
  assert.match(blocked.result.reason, /changes CHANGELOG.md, outside the allowed paths/);
  assert.equal(blocked.calls.compare, 1);
  const ok = await run({ policy: { require: { paths: ['CHANGELOG.md'], checks: ['test'] } } });
  assert.equal(ok.result.decision, 'approved');
});

test('APPROVE-011: a veto refuses and never approves or merges', async () => {
  const h = await run({ reviews: [ourApproval(51, HEAD)], policy: { merge: { enabled: true } }, vetoes: [async () => ({ reason: 'risky diff' })] });
  assert.equal(h.result.decision, 'skip');
  assert.match(h.result.reason, /vetoed: risky diff/);
  assert.deepEqual(h.calls.dismissReview.map((d) => d.review_id), [51]);
  assert.equal(h.calls.createReview.length, 0);
  assert.equal(h.mergeCalls.length, 0);
});

test('APPROVE-011: a downgrading veto says the PR needs a human; a null veto is ignored', async () => {
  const h = await run({ vetoes: [async () => null, async () => ({ reason: 'large', downgrade: true })] });
  assert.match(h.result.reason, /needs a human: large/);
  assert.equal(h.calls.createReview.length, 0);
  const passes = await run({ vetoes: [async () => null, async () => ({})] });
  assert.equal(passes.result.decision, 'approved');
});

// --- dry run ----------------------------------------------------------------------

test('dry-run decides and writes nothing', async () => {
  const h = await run({ env: { PR_APPROVAL_DRY_RUN: 'true' }, reviews: [ourApproval(61, OLD)], policy: { merge: { enabled: true } } });
  assert.equal(h.result.decision, 'dry-run');
  assert.equal(h.result.reason, '[release: APPROVE-006, MERGE-001] would approve and would merge: release 1.2.0');
  assertNoWrites(h);
  assert.equal(h.calls.listReviews, 0);
});

test('dry-run refusals write nothing either', async () => {
  const h = await run({
    env: { PR_APPROVAL_DRY_RUN: 'true' },
    reviews: [ourApproval(61, HEAD)],
    checkRuns: [{ id: 1, name: 'test', status: 'completed', conclusion: 'failure' }],
  });
  assert.equal(h.result.decision, 'skip');
  assertNoWrites(h);
});

test('dry-run without merge says only that it would approve', async () => {
  const h = await run({ env: { PR_APPROVAL_DRY_RUN: 'true' } });
  assert.equal(h.result.reason, '[release: APPROVE-006, MERGE-001] would approve: release 1.2.0');
});

// --- APPROVE-003 -----------------------------------------------------------------

test('APPROVE-003: a head that moved before approving skips without approving', async () => {
  const h = await run({ prReads: [{ head: { ...basePr().head, sha: OLD } }] });
  assert.equal(h.result.decision, 'skip');
  assert.match(h.result.reason, /head moved from a1a1a1a1 to b2b2b2b2 during evaluation/);
  assert.equal(h.calls.createReview.length, 0);
});

test('APPROVE-003: base, title, draft and state changes before approving skip', async () => {
  const cases = [
    [{ base: { ref: 'other' } }, /base changed from main/],
    [{ title: 'chore: something else' }, /title changed/],
    [{ draft: true }, /PR converted to draft/],
    [{ state: 'closed' }, /PR is closed during evaluation/],
  ];
  for (const [over, re] of cases) {
    const h = await run({ prReads: [over] });
    assert.match(h.result.reason, re);
    assert.equal(h.calls.createReview.length, 0);
  }
});

test('APPROVE-003: a base rewritten during evaluation skips', async () => {
  const h = await run({ kindOpts: { evaluate: () => ({ ok: true, summary: 's', mergeBase: 'mb1' }) }, mergeBases: ['mb2'] });
  assert.match(h.result.reason, /base main was rewritten during evaluation/);
  assert.equal(h.calls.createReview.length, 0);
});

test('APPROVE-003 + POLICY-005: approves the evaluated head, citing the policy and its rules', async () => {
  const h = await run({ summary: true, kindOpts: { evaluate: () => ({ ok: true, summary: 'release 1.2.0', mergeBase: 'mb' }) } });
  assert.equal(h.result.decision, 'approved');
  assert.equal(h.result.reason, '[release: APPROVE-006, MERGE-001] release 1.2.0');
  assert.equal(h.calls.createReview.length, 1);
  const review = h.calls.createReview[0];
  assert.equal(review.commit_id, HEAD);
  assert.equal(review.event, 'APPROVE');
  assert.equal(review.pull_number, 5);
  assert.match(review.body, /^Approved under policy `release` \(APPROVE-006, MERGE-001\): release 1\.2\.0\./);
  assert.ok(review.body.endsWith(MARKER));
  // Re-read before and after approving.
  assert.equal(h.calls.pullsGet.length, 2);
  assert.equal(h.calls.compare, 2);
  assert.deepEqual(h.core.outputs, {
    decision: 'approved',
    reason: '[release: APPROVE-006, MERGE-001] release 1.2.0',
    policy: 'release',
    rules: 'APPROVE-006,MERGE-001',
    merged: 'false',
    pr_number: '5',
    pr_url: 'https://github.com/o/r/pull/5',
  });
  assert.ok(h.core.infos.some((l) => /decision=approved .*APPROVE-006, MERGE-001/.test(l)));
  assert.match(h.core.summary.raw[0], /\*\*Rules:\*\* APPROVE-006, MERGE-001/);
});

test('a failing job summary does not change the decision', async () => {
  const h = await run({ summary: 'throws' });
  assert.equal(h.result.decision, 'approved');
});

test('APPROVE-003: a change after approving withdraws the new approval', async () => {
  const h = await run({ prReads: [undefined, { title: 'chore: sneaky' }] });
  assert.equal(h.result.decision, 'skip');
  assert.match(h.result.reason, /title changed while approving; approval withdrawn/);
  assert.equal(h.calls.createReview.length, 1);
  assert.equal(h.calls.dismissReview.length, 1);
  assert.equal(h.calls.dismissReview[0].review_id, 1000);
  assert.match(h.calls.dismissReview[0].message, /title changed while approving/);
  assert.equal(h.mergeCalls.length, 0);
});

test('APPROVE-003: failing to re-read after approving withdraws the approval', async () => {
  const h = await run({ prReads: [undefined, httpError(500, 'down')], policy: { merge: { enabled: true } } });
  assert.match(h.result.reason, /could not re-read the PR after approving \(500 down\) while approving; approval withdrawn/);
  assert.deepEqual(h.calls.dismissReview.map((d) => d.review_id), [1000]);
  assert.equal(h.mergeCalls.length, 0);
});

test('APPROVE-003: a withdrawal that fails after approving is an error', async () => {
  const h = await run({ prReads: [undefined, { draft: true }], dismissError: httpError(422, 'cannot') });
  assert.equal(h.result.decision, 'error');
  assert.match(h.result.reason, /could not withdraw approval/);
});

test('an existing approval of this head is not repeated', async () => {
  const h = await run({ reviews: [ourApproval(71, HEAD)] });
  assert.equal(h.result.decision, 'approved');
  assert.match(h.result.reason, /already approved: release 1\.2\.0/);
  assert.equal(h.calls.createReview.length, 0);
  assert.equal(h.calls.dismissReview.length, 0);
});

test('an approval call that fails but was saved counts as approved', async () => {
  const h = await run({ createReviewError: httpError(502, 'bad gateway'), createReviewSaves: true });
  assert.equal(h.result.decision, 'approved');
  assert.equal(h.calls.dismissReview.length, 0);
});

test('an approval call that fails and was not saved skips', async () => {
  const h = await run({ createReviewError: httpError(422, 'unprocessable') });
  assert.equal(h.result.decision, 'skip');
  assert.match(h.result.reason, /approval API call failed: 422 unprocessable/);
});

// --- merging ------------------------------------------------------------------------

test('MERGE-001: without merge.enabled the PR is approved and not merged', async () => {
  const h = await run({ policy: { merge: { enabled: false } } });
  assert.equal(h.result.decision, 'approved');
  assert.equal(h.mergeCalls.length, 0);
});

test('MERGE-001: merge enabled calls merge with the evaluated head', async () => {
  const mergeGithub = { marker: 'merge-client' };
  const h = await run({ policy: { merge: { enabled: true, method: 'squash' } }, mergeGithub });
  assert.equal(h.result.decision, 'merged');
  assert.equal(h.result.merged, true);
  assert.match(h.result.reason, /release 1\.2\.0; merged \(squash\)/);
  assert.equal(h.core.outputs.merged, 'true');
  assert.equal(h.mergeCalls.length, 1);
  const args = h.mergeCalls[0];
  assert.equal(args.headSha, HEAD);
  assert.equal(args.mergeGithub, mergeGithub);
  assert.equal(args.github, h.github);
  assert.equal(args.policy.id, 'release');
  assert.equal(args.kind, h.kinds.release);
  assert.equal(args.ctx.pr.number, 5);
  assert.equal(args.owner, 'o');
  assert.equal(args.repo, 'r');
});

test('MERGE-002: a refused merge leaves the PR approved with the reason', async () => {
  const h = await run({ policy: { merge: { enabled: true } }, mergeResult: { merged: false, reason: 'merge-token is not set (MERGE-002)' } });
  assert.equal(h.result.decision, 'approved');
  assert.equal(h.result.merged, false);
  assert.equal(h.result.reason, '[release: APPROVE-006, MERGE-001] release 1.2.0; not merged: merge-token is not set (MERGE-002)');
  assert.equal(h.core.outputs.merged, 'false');
});

test('MERGE-001: an already approved PR is still merged when enabled', async () => {
  const h = await run({ reviews: [ourApproval(71, HEAD)], policy: { merge: { enabled: true } } });
  assert.equal(h.result.decision, 'merged');
  assert.equal(h.calls.createReview.length, 0);
});

// --- the decide() wrapper -------------------------------------------------------------

test('decide() turns an unexpected API error into a skip naming the request', async () => {
  const core = { outputs: {}, errors: [], setOutput(k, v) { this.outputs[k] = v; }, error(m) { this.errors.push(m); }, info() {} };
  const err = httpError(500, 'Server Error', { request: { method: 'GET', url: 'https://api.github.com/repos/o/r/pulls/5' } });
  const github = { rest: { pulls: { get: async () => { throw err; } } } };
  const result = await decide({
    github, core, env: { PR_APPROVAL_BOT_LOGIN: BOT },
    context: { repo: { owner: 'o', repo: 'r' }, payload: { check_run: { pull_requests: [{ number: 5 }] } } },
  });
  assert.equal(result.decision, 'skip');
  assert.equal(result.reason, 'evaluation failed: 500 GET /repos/o/r/pulls/5 Server Error');
  assert.equal(core.outputs.decision, 'skip');
  assert.equal(core.errors.length, 1);
});

test('decide() reports an error without a request or status', async () => {
  const core = { outputs: {}, setOutput(k, v) { this.outputs[k] = v; }, error() {}, info() {} };
  const result = await decide({
    github: { rest: { pulls: { get: async () => { throw new Error('boom'); } } } }, core, env: { PR_APPROVAL_BOT_LOGIN: BOT },
    context: { repo: { owner: 'o', repo: 'r' }, payload: { check_run: { pull_requests: [{ number: 5 }] } } },
  });
  assert.equal(result.reason, 'evaluation failed: boom');
});
