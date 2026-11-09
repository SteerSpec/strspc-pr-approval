// SPDX-License-Identifier: Apache-2.0
// Orchestration: resolve the PR, load the policy from the base branch, apply
// the universal guards, the matched kind, the policy's `require`, the vetoes,
// then approve and (when the policy opts in) merge.
//
// Usage from action.yml (github-script):
//   const decide = require(`${process.env.ACTION_PATH}/scripts/pr-approval/decide.js`);
//   await decide({ github, botGithub, mergeGithub, policyGithub, context, core });
//
// Environment:
//   PR_APPROVAL_BOT_LOGIN        login of the approving account (approve-token)
//   PR_APPROVAL_POLICY_FILE      policy path in the repository (default .strspc/pr-approval.yml)
//   PR_APPROVAL_DRY_RUN          'true' = decide and report, write nothing
//   PR_APPROVAL_ALLOW_NO_CHECKS  'true' = a head with no checks may be approved

const defaultKinds = require('./kinds/index.js');
const { loadPolicy, matchPolicy, requireBlocker, PolicyError } = require('./policy.js');
const { mergePullRequest } = require('./merge.js');
const {
  makeApiClient, stripApiHost, describeError, isFailedCheck, fetchCheckRuns, compareHead, dismissReview,
} = require('./util.js');

const DEFAULT_POLICY_FILE = '.strspc/pr-approval.yml';
// Every approval carries the marker with the base it was given for, so a
// retargeted PR loses it (APPROVE-004) and only our own approvals are touched.
const MARKER_PREFIX = '<!-- strspc-pr-approval';
const marker = (base) => `${MARKER_PREFIX} base=${encodeURIComponent(base)} -->`;
const MARKER = MARKER_PREFIX;
// Anchored at the end of the body, where marker() puts it. A missing or
// malformed marker yields null, which never equals a base, so the approval is
// withdrawn rather than the run throwing (fail closed).
function markerBase(review) {
  const m = /<!-- strspc-pr-approval base=([A-Za-z0-9%._~-]+) -->\s*$/.exec(String(review.body || ''));
  if (!m) return null;
  try {
    return decodeURIComponent(m[1]);
  } catch {
    return null;
  }
}

const labelSet = (p) => (p.labels || []).map((l) => (typeof l === 'string' ? l : l.name)).sort().join('\n');
const truthy = (v) => String(v || '').trim().toLowerCase() === 'true';

function readConfig(env = process.env) {
  return {
    botLogin: String(env.PR_APPROVAL_BOT_LOGIN || '').trim(),
    policyFile: String(env.PR_APPROVAL_POLICY_FILE || '').trim() || DEFAULT_POLICY_FILE,
    dryRun: truthy(env.PR_APPROVAL_DRY_RUN),
    allowNoChecks: truthy(env.PR_APPROVAL_ALLOW_NO_CHECKS),
  };
}

// Vetoes run after every approving check and can only refuse (APPROVE-011).
// v1 ships none; the v1.1 evaluator plugs in here. Each is
//   async (ctx) => null | { reason, downgrade?: boolean }
const DEFAULT_VETOES = [];

async function decide(args) {
  const { core } = args;
  try {
    return await decideInner(args);
  } catch (err) {
    // An unexpected API error becomes a clean skip, so the job never turns red
    // for a reason unrelated to the PR. Name the request that failed.
    const req = err.request || {};
    const reason = ['evaluation failed:', err.status || '',
      req.url ? `${req.method || 'GET'} ${stripApiHost(req.url)}` : '', err.message || err]
      .filter((p) => p !== '' && p !== undefined && p !== null).join(' ');
    core.error(`pr-approval ${reason}`);
    setOutputs(core, { decision: 'skip', reason });
    return { decision: 'skip', reason };
  }
}

function setOutputs(core, { decision, reason, policy = null, merged = false, pr = null }) {
  core.setOutput('decision', decision);
  core.setOutput('reason', reason);
  core.setOutput('policy', policy ? policy.id : '');
  core.setOutput('rules', policy ? policy.rules.join(',') : '');
  core.setOutput('merged', merged ? 'true' : 'false');
  core.setOutput('pr_number', pr ? String(pr.number) : '');
  core.setOutput('pr_url', pr ? pr.html_url || '' : '');
}

// The PR an event is about, or a skip reason. check_run and workflow_run carry
// no pull_request, so it is read from their associated PRs.
async function resolvePr({ github, context }) {
  const { owner, repo } = context.repo;
  const payload = context.payload || {};
  if (payload.pull_request) return { pr: payload.pull_request };
  let assoc;
  if (payload.check_run) {
    assoc = payload.check_run.pull_requests || [];
  } else if (payload.workflow_run) {
    const wr = payload.workflow_run;
    if (wr.conclusion === 'skipped') return { skip: 'workflow_run: conclusion is skipped' };
    if (!wr.head_repository || wr.head_repository.full_name !== `${owner}/${repo}`) {
      return { skip: 'workflow_run: head repo does not match current repo' };
    }
    assoc = wr.pull_requests || [];
  } else {
    return { skip: 'no pull_request in event' };
  }
  const number = assoc[0] && assoc[0].number;
  if (!Number.isInteger(number) || number <= 0) return { skip: 'event has no associated PR' };
  const { data } = await github.rest.pulls.get({ owner, repo, pull_number: number });
  return { pr: data };
}

async function decideInner({
  github,
  botGithub = github,
  mergeGithub = null,
  policyGithub = github,
  context,
  core,
  env = process.env,
  kinds = defaultKinds,
  vetoes = DEFAULT_VETOES,
  merge = mergePullRequest,
  // Backtest only (scripts/backtest.js): evaluate a merged PR as if it were
  // open at its head, always as a dry run, with the policy from loadPolicyFn.
  replay = false,
  loadPolicyFn = null,
}) {
  const cfg = readConfig(env);
  if (replay) cfg.dryRun = true;
  let pr = null;
  let policy = null;

  const tag = (msg) => (policy ? `[${policy.id}: ${policy.rules.join(', ')}] ${msg}` : msg);
  const finish = async (decision, bareReason, { merged = false } = {}) => {
    const reason = tag(bareReason);
    core.info(`pr-approval pr=${pr ? pr.number : 'none'} decision=${decision} reason=${reason}`);
    setOutputs(core, { decision, reason, policy, merged, pr });
    if (core.summary && typeof core.summary.addRaw === 'function') {
      try {
        await core.summary.addRaw(
          `**Decision:** ${decision}\n**Policy:** ${policy ? `${policy.id} (${policy.source})` : 'none'}\n` +
          `**Rules:** ${policy ? policy.rules.join(', ') : '-'}\n**Reason:** ${reason}\n**PR:** ${pr ? pr.html_url : ''}\n`,
        ).write();
      } catch { /* best-effort */ }
    }
    return { decision, reason, policy: policy ? policy.id : null, merged };
  };
  const fail = (reason) => {
    core.error(`pr-approval ${tag(reason)}`);
    if (typeof core.setFailed === 'function') core.setFailed(tag(reason));
    return finish('error', reason);
  };

  // Without a login the caller's loop guard never matches, so every approval
  // would re-trigger the workflow. Fail loudly.
  if (!cfg.botLogin) return fail('bot-login is empty: set STRSPC_PR_APPROVAL_BOT_LOGIN (or the bot-login input)');

  const review = context.payload && context.payload.review;
  if (review && review.user && review.user.login === cfg.botLogin) return finish('skip', "triggered by the bot's own review");

  const resolved = await resolvePr({ github, context });
  if (resolved.skip) return finish('skip', resolved.skip);
  pr = resolved.pr;

  const { owner, repo } = context.repo;
  const prNumber = pr.number;

  // APPROVE-001
  if (!replay && pr.state && pr.state !== 'open') return finish('skip', `PR is ${pr.state}`);
  if (pr.draft) return finish('skip', 'PR is draft');
  if (!pr.head || !pr.head.repo || pr.head.repo.full_name !== `${owner}/${repo}`) {
    return finish('skip', 'PR head repo does not match current repo');
  }
  if (pr.user && pr.user.login === cfg.botLogin) return finish('skip', 'PR author is the approving account');

  // -- approvals of ours ------------------------------------------------------
  let reviews = null;
  const loadReviews = async () => {
    reviews = await github.paginate(github.rest.pulls.listReviews, { owner, repo, pull_number: prNumber, per_page: 100 });
    return reviews;
  };
  // Ours = the approving account AND our marker. strspc-pr-review may approve
  // as the same account; its approvals are never this action's to dismiss.
  const ourApprovals = (list) => list.filter((r) => r.user && r.user.login === cfg.botLogin &&
    r.state === 'APPROVED' && String(r.body || '').includes(MARKER_PREFIX));
  // Withdraws every approval of ours `which` selects. An approval that may
  // still stand after a failure is an error, never a skip.
  const withdraw = async (which, message) => {
    if (cfg.dryRun) return null;
    let list;
    try {
      list = await loadReviews();
    } catch (err) {
      return fail(`could not list reviews to withdraw an approval: ${describeError(err)}`);
    }
    const failures = [];
    for (const r of ourApprovals(list).filter(which)) {
      try {
        await dismissReview({ github, botGithub, params: { owner, repo, pull_number: prNumber, review_id: r.id, message } });
      } catch (err) {
        failures.push(`review ${r.id}: ${describeError(err)}`);
      }
    }
    return failures.length ? fail(`could not withdraw approval(s): ${failures.join('; ')}`) : null;
  };
  // A refusal, or a PR this action no longer governs (retargeted to a base with
  // no policy, or one no policy matches), takes back any approval of ours.
  const refuse = async (reason) => {
    const failed = await withdraw(() => true, `Withdrawn: ${tag(reason)}.`);
    return failed || finish('skip', reason);
  };


  // POLICY-001: from the base branch, never the head.
  let loaded;
  try {
    loaded = loadPolicyFn ? await loadPolicyFn() : await loadPolicy({
      github,
      policyGithub,
      kinds,
      root: { owner, repo, ref: pr.base.ref, path: cfg.policyFile.replace(/^\.?\//, ''), remote: false },
    });
  } catch (err) {
    if (err instanceof PolicyError) return fail(err.message); // POLICY-004: no action
    throw err;
  }
  if (!loaded) return refuse(`no ${cfg.policyFile} on ${pr.base.ref}`);

  policy = matchPolicy(loaded.policies, pr, kinds);
  if (!policy) return refuse('no policy matches this PR'); // POLICY-006
  const kind = kinds[policy.kind];
  const options = policy.options || {};
  if (policy.approve === false) return refuse('the matching policy approves nothing');


  const headSha = pr.head.sha;

  if (kind.requiresTip && !replay) {
    const { data: tip } = await github.rest.git.getRef({ owner, repo, ref: `heads/${pr.head.ref}` });
    if (tip.object.sha !== headSha) {
      return finish('skip', `head ${headSha.slice(0, 8)} is not the tip of ${pr.head.ref} (${tip.object.sha.slice(0, 8)}); the next run re-evaluates it`);
    }
  }

  // APPROVE-004
  {
    const failed = await withdraw((r) => r.commit_id !== headSha || markerBase(r) !== pr.base.ref,
      `Withdrawn: ${headSha.slice(0, 8)} on ${pr.base.ref} is a new head or base, so the approval has to be earned again.`);
    if (failed) return failed;
  }

  // APPROVE-002
  const checkRuns = await fetchCheckRuns({ github, context, owner, repo, headSha });
  if (checkRuns.length === 0 && !cfg.allowNoChecks) return finish('skip', 'no checks on head SHA yet');
  const bad = checkRuns.find(isFailedCheck);
  if (bad) return refuse(`failing check: ${bad.name} (${bad.conclusion})`);
  const pending = checkRuns.find((cr) => cr.status !== 'completed');
  if (pending) return finish('skip', `check still running: ${pending.name}`);

  let compared = null;
  const compare = async () => {
    if (!compared) {
      compared = await compareHead({ github, owner, repo, baseRef: pr.base.ref, headSha, baseSha: replay ? pr.base.sha : null });
    }
    return compared;
  };
  const ctx = { github, owner, repo, pr, policy, options, compare, checkRuns, core, botLogin: cfg.botLogin };

  // The kind's own proof (APPROVE-005..009).
  let proof;
  try {
    proof = await kind.evaluate(ctx);
  } catch (err) {
    const failed = await withdraw(() => true, `Withdrawn: ${tag(`the ${policy.kind} PR could not be verified (${describeError(err)})`)}.`);
    if (failed) return failed;
    throw err;
  }
  if (!proof.ok) return refuse(proof.reason);

  // APPROVE-010: the policy may only add conditions.
  if (policy.require) {
    const needsFiles = ['paths', 'forbid-paths', 'max-files', 'max-additions', 'max-deletions'].some((k) => k in policy.require);
    const files = needsFiles ? (await compare()).files : null;
    const blocked = requireBlocker({ pr, require: policy.require, files, checkRuns });
    if (blocked) return refuse(blocked);
  }

  // APPROVE-011: vetoes can only refuse.
  for (const veto of vetoes) {
    const v = await veto(ctx);
    if (v && v.reason) return refuse(`${v.downgrade ? 'needs a human' : 'vetoed'}: ${v.reason}`);
  }

  const summary = proof.summary || policy.kind;
  const mergeBase = proof.mergeBase || (compared && compared.mergeBase) || null;

  if (cfg.dryRun) {
    const wouldMerge = policy.merge && policy.merge.enabled ? ' and would merge' : '';
    return finish('dry-run', `would approve${wouldMerge}: ${summary}`);
  }

  // APPROVE-003: everything the decision rests on is re-read before and after.
  const changed = async (current) => {
    if (current.head.sha !== headSha) return `head moved from ${headSha.slice(0, 8)} to ${current.head.sha.slice(0, 8)}`;
    if (current.head.ref !== pr.head.ref) return `head branch changed from ${pr.head.ref}`;
    if (!current.base || current.base.ref !== pr.base.ref) return `base changed from ${pr.base.ref}`;
    if ((current.title || '') !== (pr.title || '')) return 'title changed';
    if (current.draft) return 'PR converted to draft';
    if (current.state && current.state !== 'open') return `PR is ${current.state}`;
    // Labels take part in match, require.no-labels and template-sync.
    if (labelSet(current) !== labelSet(pr)) return 'labels changed';
    if (mergeBase) {
      const now = await compareHead({ github, owner, repo, baseRef: pr.base.ref, headSha });
      if (now.mergeBase !== mergeBase) return `base ${pr.base.ref} was rewritten`;
    }
    return '';
  };
  {
    const { data: current } = await github.rest.pulls.get({ owner, repo, pull_number: prNumber });
    const why = await changed(current);
    if (why) return finish('skip', `${why} during evaluation; the next run re-evaluates it`);
  }

  reviews = reviews || await loadReviews();
  const alreadyApproved = ourApprovals(reviews).some((r) => r.commit_id === headSha);
  if (!alreadyApproved) {
    const body = `Approved under policy \`${policy.id}\` (${policy.rules.join(', ')}): ${summary}.\n\n${marker(pr.base.ref)}`;
    let created;
    try {
      ({ data: created } = await botGithub.rest.pulls.createReview({
        owner, repo, pull_number: prNumber, commit_id: headSha, event: 'APPROVE', body,
      }));
    } catch (err) {
      // A retried 5xx may still have saved the approval; look before skipping.
      const saved = ourApprovals(await loadReviews()).filter((r) => r.commit_id === headSha);
      if (saved.length === 0) return finish('skip', `approval API call failed: ${describeError(err)}`);
      created = saved[saved.length - 1];
    }
    let why;
    try {
      const { data: after } = await github.rest.pulls.get({ owner, repo, pull_number: prNumber });
      why = await changed(after);
    } catch (err) {
      why = `could not re-read the PR after approving (${describeError(err)})`;
    }
    if (why) {
      const failed = await withdraw((r) => r.commit_id === headSha || r.id === created.id, `Withdrawn: ${why} while approving.`);
      return failed || finish('skip', `${why} while approving; approval withdrawn`);
    }
  }

  // MERGE-001: only when the policy enables it.
  if (!(policy.merge && policy.merge.enabled)) {
    return finish('approved', alreadyApproved ? `already approved: ${summary}` : summary);
  }
  const result = await merge({
    github, mergeGithub, owner, repo, pr, headSha, policy, kind, ctx, core, justApproved: !alreadyApproved,
  });
  if (result.merged) return finish('merged', `${summary}; merged (${result.method})`, { merged: true });
  return finish('approved', `${summary}; not merged: ${result.reason}`);
}

module.exports = decide;
module.exports.decideInner = decideInner;
module.exports.readConfig = readConfig;
module.exports.resolvePr = resolvePr;
module.exports.makeApiClient = makeApiClient;
module.exports.DEFAULT_POLICY_FILE = DEFAULT_POLICY_FILE;
module.exports.MARKER = MARKER;
module.exports.marker = marker;
module.exports.markerBase = markerBase;
