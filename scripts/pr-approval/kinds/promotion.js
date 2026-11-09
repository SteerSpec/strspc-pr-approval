// SPDX-License-Identifier: Apache-2.0
// kind: promotion. Approving a long-lived branch into another (develop to main)
// without a fresh review, because the code was already reviewed where it first
// merged. Ported from strspc-pr-review's promotion.js.
//
// decide.js keeps everything the kinds share: the guards, the branch-tip check
// (requiresTip), the check gate, the re-reads around the approval and the
// approval itself. This module only answers the questions that are specific to
// a promotion: is the title safe for release-please, and did every commit reach
// the head branch through an approved PR.

const { parseConventionalTitle } = require('../util.js');

// pulls.listCommits stops at 250 commits, so a list that long may be truncated
// and cannot prove anything about the commits it leaves out.
const MAX_LISTED_COMMITS = 250;

// release-please reads a promotion's merge commit, so a title it would show in
// the changelog counts the same changes twice. Allow-listed rather than read
// from a repo's changelog-sections: chore is hidden unless a repo goes out of
// its way, and a promotion needs no other type.
const PROMOTION_TITLE_TYPE = 'chore';

// Why the title stops this promotion, or null. The `!` matters here: a breaking
// marker on the promotion would be counted twice too.
function promotionTitleBlocker(title) {
  const parsed = parseConventionalTitle(title);
  if (!parsed) return `promotion title is not a Conventional Commit; use ${PROMOTION_TITLE_TYPE}:`;
  if (parsed.type !== PROMOTION_TITLE_TYPE) {
    return `promotion title type '${parsed.type}' would be counted twice by release-please; use ${PROMOTION_TITLE_TYPE}:`;
  }
  if (parsed.breaking) return `promotion title is marked breaking, which release-please would count twice; use ${PROMOTION_TITLE_TYPE}:`;
  return null;
}

// GraphQL, not the REST reviews list: authorCanPushToRepository is the access
// that makes an approval count on GitHub. Anyone can post an APPROVED review on a
// public PR, even after it merged, and REST's author_association says what the
// reviewer is rather than what they can do. It reads the access held today, not
// at the merge.
const SOURCE_REVIEWS_QUERY = `query ($owner: String!, $repo: String!, $number: Int!) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      reviews(first: 100) {
        pageInfo { hasNextPage }
        nodes {
          state
          submittedAt
          authorCanPushToRepository
          author { login }
          commit { oid }
        }
      }
    }
  }
}`;

// True when the PR had a real approval at the moment it merged: the latest
// decisive review of someone with push access approves the commit that merged,
// and nobody still requested changes. Reviews after the merge are ignored, so an
// approval cannot launder a PR afterwards. A COMMENTED review leaves an approval
// standing, as GitHub does. A bot approval counts: it means that PR passed its
// own gates.
//
// Bound to `headSha` because a repo without dismiss_stale_reviews_on_push keeps
// an approval across later pushes. Replayed over 24 promotions (2026-10-31), see
// checkProvenance: these rules cost nothing beyond the PRs that had no approval
// when they merged. `reviews` are SOURCE_REVIEWS_QUERY nodes.
function hasStandingApproval(reviews, { headSha, mergedAt } = {}) {
  if (!headSha) return false;
  const latest = new Map();
  // Strictly before: timestamps have one-second precision, so a tie cannot be
  // shown to precede the merge.
  const ordered = reviews
    .filter((r) => r.author && Date.parse(r.submittedAt) < Date.parse(mergedAt))
    .sort((a, b) => Date.parse(a.submittedAt) - Date.parse(b.submittedAt));
  for (const r of ordered) {
    if (r.state === 'APPROVED' || r.state === 'CHANGES_REQUESTED') latest.set(r.author.login, r);
    if (r.state === 'DISMISSED') latest.delete(r.author.login);
  }
  const standing = [...latest.values()];
  if (standing.some((r) => r.state === 'CHANGES_REQUESTED')) return false;
  return standing.some((r) => r.authorCanPushToRepository && r.commit && r.commit.oid === headSha);
}

// More reviews than one page cannot be judged, so the PR reads as unapproved.
async function sourceIsApproved({ github, owner, repo, source }) {
  const data = await github.graphql(SOURCE_REVIEWS_QUERY, { owner, repo, number: source.number });
  const { nodes, pageInfo } = data.repository.pullRequest.reviews;
  if (pageInfo.hasNextPage) return false;
  return hasStandingApproval(nodes, {
    headSha: source.head && source.head.sha, mergedAt: source.merged_at,
  });
}

// Proves every commit of the promotion reached headRef through a merged PR with
// a standing approval. That is what stands in for a fresh review here, and it
// is what catches a push that bypassed review. Returns at the first failure.
//
// Back-merges need no exemption: replayed over 24 promotions across 6 repos
// (2026-10-31), every commit had a merged PR, merge commits included. 17 pass;
// the other 7 each hold a PR with no standing approval when it merged.
async function checkProvenance({ github, owner, repo, prNumber, headRef, headSha }) {
  const commits = await github.paginate(github.rest.pulls.listCommits, {
    owner, repo, pull_number: prNumber, per_page: 100,
  });
  if (commits.length >= MAX_LISTED_COMMITS) {
    return {
      ok: false,
      reason: `promotion has ${MAX_LISTED_COMMITS} commits or more, so the list may be partial and provenance cannot be proven`,
    };
  }
  // listCommits describes whatever the PR's head is when it is called, and the
  // head re-reads around the approval cannot see a force-push away and back.
  if (!commits.some((c) => c.sha === headSha)) {
    return { ok: false, reason: `commit list does not include the evaluated head ${headSha.slice(0, 8)}` };
  }

  const approved = new Map();
  const isApproved = async (source) => {
    if (!approved.has(source.number)) {
      approved.set(source.number, await sourceIsApproved({ github, owner, repo, source }));
    }
    return approved.get(source.number);
  };

  for (const { sha } of commits) {
    const short = sha.slice(0, 8);
    const associated = await github.paginate(github.rest.repos.listPullRequestsAssociatedWithCommit, {
      owner, repo, commit_sha: sha, per_page: 100,
    });
    const merged = associated.filter((p) => p.merged_at && p.base && p.base.ref === headRef);
    if (merged.length === 0) {
      return { ok: false, reason: `commit ${short} has no merged PR into ${headRef}` };
    }
    // Every one, not any: a stacked PR's approval covers its own diff, not the
    // commits it inherited from an unapproved PR merged before it.
    for (const p of merged) {
      if (!(await isApproved(p))) {
        return { ok: false, reason: `commit ${short} came from #${p.number}, which has no standing approval` };
      }
    }
  }
  return {
    ok: true,
    commits: commits.length,
    prs: [...approved.values()].filter(Boolean).length,
  };
}

function defaultMatch() {
  return { head: 'develop', base: 'main' };
}

// No options yet. Anything set is refused rather than ignored, so a policy that
// believes it configured something cannot pass silently.
function validateOptions(options) {
  return Object.keys(options || {}).map((k) => `unknown option ${k}`);
}

// The title first: it costs no API call. Provenance reads every commit of the
// PR and the reviews of every PR they came from. API errors propagate, so
// decide.js withdraws any approval of ours before reporting the failure.
async function evaluate(ctx) {
  const { github, owner, repo, pr } = ctx;
  const blocker = promotionTitleBlocker(pr.title);
  if (blocker) return { ok: false, reason: blocker };
  const head = pr.head.ref;
  const base = pr.base.ref;
  const proof = await checkProvenance({
    github, owner, repo, prNumber: pr.number, headRef: head, headSha: pr.head.sha,
  });
  if (!proof.ok) return { ok: false, reason: proof.reason };
  return {
    ok: true,
    summary: `promotion (${head} to ${base}, ${proof.commits} commit(s) from ${proof.prs} approved PR(s))`,
  };
}

module.exports = {
  name: 'promotion',
  requiresTip: true,
  defaultMatch,
  validateOptions,
  evaluate,
  MAX_LISTED_COMMITS,
  SOURCE_REVIEWS_QUERY,
  promotionTitleBlocker,
  hasStandingApproval,
  checkProvenance,
};
