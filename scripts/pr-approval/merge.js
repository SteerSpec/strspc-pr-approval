// SPDX-License-Identifier: Apache-2.0
// Merging an approved pull request (realm entity MERGE).
//
//   MERGE-001  only when the matching policy enables merging (default off)
//   MERGE-002  only with the merge token, never with GITHUB_TOKEN
//   MERGE-003  only the evaluated head, only when GitHub reports it clean
//   MERGE-004  the policy's method, else the one the base rules allow; never
//              when the two disagree
//   MERGE-005  (release) enforced by the kind's mergeBlocker
//
// mergePullRequest never throws for an API error: a merge that does not happen
// is an ordinary outcome ({ merged: false, reason }) and the approval stands.
// The next event retries.

const { describeError } = require('./util.js');

const METHODS = ['merge', 'squash', 'rebase'];

// Repository settings field for each merge method.
const REPO_SETTING = {
  merge: 'allow_merge_commit',
  squash: 'allow_squash_merge',
  rebase: 'allow_rebase_merge',
};

// The merge methods the base branch's effective rules allow.
//   null   no pull_request rule constrains the method (or the rules cannot be
//          read: 404 when none apply, 403 when the token may not read them)
//   [...]  the intersection of every pull_request rule's allowed methods;
//          possibly empty when two rules disagree, which allows nothing
async function allowedByRules({ github, owner, repo, branch }) {
  let rules;
  try {
    ({ data: rules } = await github.request('GET /repos/{owner}/{repo}/rules/branches/{branch}', {
      owner, repo, branch, per_page: 100,
    }));
  } catch (err) {
    if (err.status === 404 || err.status === 403) return null;
    throw err;
  }
  let allowed = null;
  for (const rule of Array.isArray(rules) ? rules : []) {
    if (!rule || rule.type !== 'pull_request') continue;
    const methods = rule.parameters && rule.parameters.allowed_merge_methods;
    // A pull_request rule without the parameter does not constrain the method.
    if (!Array.isArray(methods)) continue;
    const set = methods.filter((m) => METHODS.includes(m));
    allowed = allowed === null ? set : allowed.filter((m) => set.includes(m));
  }
  return allowed;
}

// MERGE-004. Returns { method } or { reason }.
//
// The brief folded "no rule" and "rules allow nothing" together; they are kept
// apart here because falling back to the repository settings when the rules
// intersect to nothing would ignore the rules.
async function chooseMethod({ github, owner, repo, branch, wanted }) {
  const allowed = await allowedByRules({ github, owner, repo, branch });
  if (allowed !== null && allowed.length === 0) {
    return { reason: `the rules of ${branch} allow no merge method (their pull_request rules disagree)` };
  }
  if (wanted) {
    // The policy names a method: it must be one the rules allow. Without rules
    // GitHub itself refuses a method the repository disables (405).
    if (allowed !== null && !allowed.includes(wanted)) {
      return { reason: `policy merge.method is ${wanted} but the rules of ${branch} allow only ${allowed.join(', ')}` };
    }
    return { method: wanted };
  }
  if (allowed !== null) {
    if (allowed.length === 1) return { method: allowed[0] };
    return { reason: `merge method is ambiguous (the rules of ${branch} allow ${allowed.join(', ')}); set merge.method` };
  }
  // No rule: the repository settings decide, and only when they leave one.
  const { data: settings } = await github.rest.repos.get({ owner, repo });
  const enabled = METHODS.filter((m) => settings && settings[REPO_SETTING[m]] === true);
  if (enabled.length === 1) return { method: enabled[0] };
  return { reason: 'merge method is ambiguous; set merge.method' };
}

// Why GitHub's mergeable_state forbids the merge, or null when it is clean.
//
// 'clean' already folds in what branch protection and rulesets demand:
// required checks, required reviews, resolved review threads, stale-review
// dismissal, linear history. None of that is re-implemented here; GitHub is
// the authority, and the merge call below is refused anyway if it disagrees.
function mergeableStateBlocker(state) {
  if (state === 'clean') return null;
  if (state === undefined || state === null || state === 'unknown') {
    return 'GitHub has not computed mergeability yet; the next event retries';
  }
  const why = {
    blocked: 'branch protection or rules block it',
    behind: 'the head branch is behind its base',
    dirty: 'it has merge conflicts',
    unstable: 'a non-required check is failing or pending',
    draft: 'it is a draft',
  }[state];
  return `mergeable_state is ${state}${why ? ` (${why})` : ''}`;
}

// When this run posted the approval itself, GitHub recomputes mergeable_state
// asynchronously, so the first re-read usually still says blocked or unknown.
// Nothing else re-triggers the run after that: the caller's loop guard drops
// the bot's own review event, and every check already finished. So wait,
// bounded (it bills runner minutes on private repos), and only for the two
// states an approval can still change.
const SETTLE_STATES = new Set([undefined, null, 'unknown', 'blocked']);
const SETTLE_ATTEMPTS = 6;
const SETTLE_MS = 10000;
const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function mergePullRequest({
  github, mergeGithub, owner, repo, pr, headSha, policy, kind, ctx, core,
  justApproved = false, sleep = defaultSleep, settleAttempts = SETTLE_ATTEMPTS, settleMs = SETTLE_MS,
}) {
  const number = pr && pr.number;
  const done = (result) => {
    const line = result.merged
      ? `pr-approval merge pr=${number} merged=true method=${result.method}`
      : `pr-approval merge pr=${number} merged=false reason=${result.reason}`;
    if (core && typeof core.info === 'function') core.info(line);
    return result;
  };
  const refuse = (reason) => done({ merged: false, reason });

  // MERGE-001: decide.js only calls us when the policy enables merging; this
  // is the second lock.
  if (!(policy && policy.merge && policy.merge.enabled === true)) {
    return refuse('the matching policy does not enable merging (MERGE-001)');
  }
  // MERGE-002: action.yml passes null when merge-token is empty. A merge with
  // the workflow client would land, but start no workflow on the base branch.
  if (!mergeGithub || mergeGithub === github) {
    return refuse('merge-token is not set; merging with GITHUB_TOKEN would start no workflow (MERGE-002)');
  }

  try {
    // MERGE-004
    const chosen = await chooseMethod({
      github, owner, repo, branch: pr.base.ref, wanted: policy.merge.method,
    });
    if (chosen.reason) return refuse(`${chosen.reason} (MERGE-004)`);

    // Kind-specific conditions that must hold at the moment of merging (for
    // a release, MERGE-005: nothing new on the source branch).
    if (kind && typeof kind.mergeBlocker === 'function') {
      const blocker = await kind.mergeBlocker(ctx);
      if (blocker) return refuse(blocker);
    }

    // MERGE-003: re-read; the head must still be the evaluated one and GitHub
    // must call it clean.
    let { data: current } = await github.rest.pulls.get({ owner, repo, pull_number: number });
    for (let i = 0; justApproved && i < settleAttempts && SETTLE_STATES.has(current.mergeable_state) &&
      current.head && current.head.sha === headSha && !current.merged; i++) {
      await sleep(settleMs);
      ({ data: current } = await github.rest.pulls.get({ owner, repo, pull_number: number }));
    }
    if (current.merged) return refuse('already merged');
    if (current.state && current.state !== 'open') return refuse(`PR is ${current.state}`);
    if (!current.head || current.head.sha !== headSha) {
      const now = current.head && current.head.sha ? current.head.sha.slice(0, 8) : 'unknown';
      return refuse(`head moved from ${headSha.slice(0, 8)} to ${now} (MERGE-003)`);
    }
    const blocked = mergeableStateBlocker(current.mergeable_state);
    if (blocked) return refuse(`${blocked} (MERGE-003)`);

    // `sha` makes GitHub refuse (409) if the head moved after the re-read.
    let data;
    try {
      ({ data } = await mergeGithub.rest.pulls.merge({
        owner, repo, pull_number: number, sha: headSha, merge_method: chosen.method,
      }));
    } catch (err) {
      if (err.status === 405) return refuse(`GitHub refused the merge: not mergeable (${describeError(err)})`);
      if (err.status === 409) return refuse(`head moved before the merge (${describeError(err)}) (MERGE-003)`);
      return refuse(`merge API call failed: ${describeError(err)}`);
    }
    if (data && data.merged === false) return refuse(`GitHub did not merge: ${data.message || 'no reason given'}`);
    return done({ merged: true, method: chosen.method });
  } catch (err) {
    return refuse(`could not prepare the merge: ${describeError(err)}`);
  }
}

module.exports = {
  SETTLE_ATTEMPTS,
  SETTLE_MS,
  mergePullRequest,
  chooseMethod,
  allowedByRules,
  mergeableStateBlocker,
};
