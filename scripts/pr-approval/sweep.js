// SPDX-License-Identifier: Apache-2.0
// The sweep (APPROVE-014): the fallback for an event that never arrives.
//
// A PR is evaluated by a run one of its own events starts, and GitHub does not
// always deliver one. The pull_request_review run that Copilot's review starts
// is held at action_required (#17), and CI's workflow_run can go missing. The
// PR then waits until someone pushes. A run started by `schedule` or
// `workflow_dispatch` carries no PR, so it evaluates every open PR the caller's
// job `if:` would admit, one after another, each exactly as if its own event
// had arrived. The per-PR rules are the same; only the trigger differs.
//
// Ported from strspc-pr-review (scripts/pr-auto-approve/decide.js, sweep,
// v1.12.0). That action filters on its base-branch input; this one has none,
// because the policy read from each PR's base decides.

const SWEEP_EVENTS = new Set(['schedule', 'workflow_dispatch']);
// Most PRs one sweep evaluates, most recently opened first. Each costs a dozen
// or so API calls, more when its policy extends a remote file.
const SWEEP_MAX_PRS = 30;
const PER_PAGE = 100;

function isSweep(context) {
  return Boolean(context) && SWEEP_EVENTS.has(context.eventName) && !(context.payload && context.payload.pull_request);
}

// Which per-PR results the sweep's own outputs report, most telling first. An
// error has already failed the job through core.setFailed.
const RANK = ['error', 'merged', 'approved', 'dry-run'];

async function sweep({ evaluate, args, maxPrs = SWEEP_MAX_PRS }) {
  const { github, context, core } = args;
  const env = args.env || process.env;
  // An empty bot-login fails exactly as it does on an event run (APPROVE-012),
  // before any PR is read.
  if (!String(env.PR_APPROVAL_BOT_LOGIN || '').trim()) return evaluate(args);

  const finish = (decision, reason, first = null, merged = false) => {
    core.info(`pr-approval sweep decision=${decision} reason=${reason}`);
    const out = (first && first.outputs) || {};
    core.setOutput('decision', decision);
    core.setOutput('reason', reason);
    core.setOutput('policy', out.policy || '');
    core.setOutput('rules', out.rules || '');
    core.setOutput('merged', merged ? 'true' : 'false');
    core.setOutput('pr_number', out.pr_number || '');
    core.setOutput('pr_url', out.pr_url || '');
    return { decision, reason, policy: out.policy || null, merged };
  };

  const { owner, repo } = context.repo;
  // The job if: applies these to an event run; a PR they stop leaves no
  // decision line behind here either.
  const admit = (p) => !p.draft && p.head && p.head.repo && p.head.repo.full_name === `${owner}/${repo}`;

  let listed = 0;
  let candidates = [];
  let more = false;
  try {
    for (let page = 1; ; page++) {
      const { data } = await github.rest.pulls.list({
        owner, repo, state: 'open', sort: 'created', direction: 'desc', per_page: PER_PAGE, page,
      });
      listed += data.length;
      candidates.push(...data.filter(admit));
      if (data.length < PER_PAGE) break;
      // Stop paging once the cap is filled: hundreds of open PRs must not cost
      // hundreds of list calls every tick.
      if (candidates.length >= maxPrs) {
        more = true;
        break;
      }
    }
  } catch (err) {
    const reason = `sweep failed: could not list the open PRs: ${err.status || ''} ${err.message || err}`.replace(/\s+/g, ' ').trim();
    core.error(`pr-approval ${reason}`);
    return finish('skip', reason);
  }
  if (candidates.length > maxPrs || (candidates.length === maxPrs && more)) {
    core.warning(`pr-approval: sweep: evaluating the ${maxPrs} most recently opened PRs; older ones are not evaluated`);
    candidates = candidates.slice(0, maxPrs);
  } else {
    core.info(`pr-approval: sweep: ${candidates.length} of ${listed} open PR(s) to evaluate`);
  }

  const results = [];
  for (const item of candidates) {
    // Each PR's outputs go to its own record; the step's outputs are the
    // sweep's, set once at the end. Logs, the summary and setFailed go through.
    const outputs = {};
    const prCore = Object.assign(Object.create(core), {
      setOutput: (key, value) => { outputs[key] = value; },
    });
    let result;
    try {
      // The PR as its own event would carry it, not the list's abridged copy.
      const { data: pr } = await github.rest.pulls.get({ owner, repo, pull_number: item.number });
      const prContext = {
        eventName: context.eventName,
        payload: { pull_request: pr, repository: context.payload && context.payload.repository },
        repo: context.repo,
        runId: context.runId,
        job: context.job,
      };
      result = await evaluate({ ...args, context: prContext, core: prCore });
    } catch (err) {
      // evaluate() turns its own failures into a skip, so only the read above
      // lands here. One unreadable PR must not stop the others.
      const reason = `evaluation failed: ${err.status || ''} ${err.message || err}`.replace(/\s+/g, ' ').trim();
      core.error(`pr-approval pr=${item.number} decision=skip reason=${reason}`);
      result = { decision: 'skip', reason };
    }
    results.push({ number: item.number, ...result, outputs });
  }

  const notable = results.filter((r) => RANK.includes(r.decision));
  if (notable.length === 0) return finish('skip', `sweep: ${results.length} PR(s) evaluated, none approved`);
  const byRank = [...notable].sort((a, b) => RANK.indexOf(a.decision) - RANK.indexOf(b.decision));
  const top = byRank[0];
  const rest = results.length - notable.length;
  const reason = `sweep: ${notable.map((r) => `#${r.number} ${r.decision} (${r.reason})`).join(', ')}` +
    (rest > 0 ? `; ${rest} other PR(s) skipped` : '');
  return finish(top.decision, reason, top, results.some((r) => r.merged));
}

module.exports = { sweep, isSweep, SWEEP_EVENTS, SWEEP_MAX_PRS };
