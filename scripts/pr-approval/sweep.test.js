// SPDX-License-Identifier: Apache-2.0
const test = require('node:test');
const assert = require('node:assert/strict');

const { sweep, isSweep, SWEEP_MAX_PRS } = require('./sweep.js');

const listed = (number, extra = {}) => ({
  number, draft: false, head: { repo: { full_name: 'o/r' } }, ...extra,
});

function setup({ pages = [[]], listError = null, getError = {}, results = {} } = {}) {
  const calls = { list: [], get: [], evaluated: [] };
  const github = {
    rest: {
      pulls: {
        list: async (p) => {
          calls.list.push(p);
          if (listError) throw listError;
          return { data: pages[p.page - 1] || [] };
        },
        get: async ({ pull_number }) => {
          calls.get.push(pull_number);
          if (getError[pull_number]) throw getError[pull_number];
          return { data: { number: pull_number, full: true } };
        },
      },
    },
  };
  const core = {
    outputs: {}, infos: [], errors: [], warnings: [],
    setOutput(k, v) { this.outputs[k] = v; },
    info(m) { this.infos.push(m); },
    error(m) { this.errors.push(m); },
    warning(m) { this.warnings.push(m); },
  };
  const context = {
    eventName: 'schedule', payload: { repository: { default_branch: 'develop' } }, repo: { owner: 'o', repo: 'r' }, runId: 7, job: 'strspc-pr-approval',
  };
  const evaluate = async (args) => {
    calls.evaluated.push(args);
    const pr = args.context.payload.pull_request;
    if (!pr) return { decision: 'error', reason: 'bot-login is empty' };
    const r = results[pr.number] || { decision: 'skip', reason: 'no policy matches this PR' };
    // What decide's finish() would write.
    args.core.setOutput('decision', r.decision);
    args.core.setOutput('policy', r.policy || '');
    args.core.setOutput('rules', r.rules || '');
    args.core.setOutput('pr_number', String(pr.number));
    args.core.setOutput('pr_url', `https://github.com/o/r/pull/${pr.number}`);
    return { merged: false, ...r };
  };
  const env = { PR_APPROVAL_BOT_LOGIN: 'bot' };
  const go = (extra = {}) => sweep({ evaluate, args: { github, context, core, env, ...extra.args }, ...extra.opts });
  return { calls, core, context, go };
}

test('isSweep: schedule and dispatch without a PR only', () => {
  assert.equal(isSweep({ eventName: 'schedule', payload: {} }), true);
  assert.equal(isSweep({ eventName: 'workflow_dispatch', payload: {} }), true);
  assert.equal(isSweep({ eventName: 'workflow_dispatch', payload: { pull_request: { number: 1 } } }), false);
  assert.equal(isSweep({ eventName: 'pull_request_target', payload: { pull_request: {} } }), false);
  assert.equal(isSweep({ eventName: 'check_run', payload: {} }), false);
  assert.equal(isSweep(undefined), false);
});

test('APPROVE-014: evaluates each admitted open PR, newest first, as its own event would', async () => {
  const s = setup({
    pages: [[
      listed(9),
      listed(8, { draft: true }),
      listed(7, { head: { repo: { full_name: 'fork/r' } } }),
      listed(6, { head: { repo: null } }),
      listed(5),
    ]],
    results: { 5: { decision: 'approved', reason: 'sync-back 1.1.0', policy: 'sync-back', rules: 'APPROVE-007' } },
  });
  const result = await s.go();
  assert.deepEqual(s.calls.list[0], { owner: 'o', repo: 'r', state: 'open', sort: 'created', direction: 'desc', per_page: 100, page: 1 });
  assert.deepEqual(s.calls.get, [9, 5]);
  // The full PR, not the list's copy, and the sweep's own run identity.
  const ctx = s.calls.evaluated[0].context;
  assert.deepEqual(ctx.payload.pull_request, { number: 9, full: true });
  assert.equal(ctx.eventName, 'schedule');
  assert.equal(ctx.runId, 7);
  assert.equal(ctx.job, 'strspc-pr-approval');
  assert.deepEqual(ctx.payload.repository, { default_branch: 'develop' });
  // Per-PR outputs stay out of the step's; the sweep sets its own once.
  assert.equal(result.decision, 'approved');
  assert.equal(s.core.outputs.decision, 'approved');
  assert.equal(s.core.outputs.pr_number, '5');
  assert.equal(s.core.outputs.policy, 'sync-back');
  assert.equal(s.core.outputs.rules, 'APPROVE-007');
  assert.equal(s.core.outputs.merged, 'false');
  assert.equal(s.core.outputs.reason, 'sweep: #5 approved (sync-back 1.1.0); 1 other PR(s) skipped');
  assert.ok(s.core.infos.includes('pr-approval: sweep: 2 of 5 open PR(s) to evaluate'));
});

test('APPROVE-014: the outputs report the most telling result; merged is true if any PR merged', async () => {
  const s = setup({
    pages: [[listed(4), listed(3), listed(2), listed(1)]],
    results: {
      4: { decision: 'dry-run', reason: 'would approve: x' },
      3: { decision: 'merged', reason: 'y; merged (squash)', merged: true, policy: 'p3' },
      2: { decision: 'error', reason: 'could not withdraw', policy: 'p2' },
    },
  });
  const result = await s.go();
  assert.equal(result.decision, 'error');
  assert.equal(s.core.outputs.pr_number, '2');
  assert.equal(s.core.outputs.merged, 'true');
  assert.match(s.core.outputs.reason, /^sweep: #4 dry-run \(would approve: x\), #3 merged .*#2 error \(could not withdraw\); 1 other PR\(s\) skipped$/);
});

test('APPROVE-014: nothing to report is a skip', async () => {
  const s = setup({ pages: [[listed(2), listed(1)]] });
  const result = await s.go();
  assert.deepEqual(result, { decision: 'skip', reason: 'sweep: 2 PR(s) evaluated, none approved', policy: null, merged: false });
  assert.equal(s.core.outputs.pr_number, '');
  const empty = setup();
  assert.equal((await empty.go()).reason, 'sweep: 0 PR(s) evaluated, none approved');
});

test('APPROVE-014: caps the PRs evaluated and stops paging once the cap is filled', async () => {
  assert.equal(SWEEP_MAX_PRS, 30);
  const page = (from) => Array.from({ length: 100 }, (_, i) => listed(from - i));
  const s = setup({ pages: [page(300), page(200), page(100)] });
  await s.go();
  assert.equal(s.calls.list.length, 1);
  assert.equal(s.calls.get.length, 30);
  assert.equal(s.calls.get[0], 300);
  assert.match(s.core.warnings[0], /evaluating the 30 most recently opened PRs/);

  // Drafts do not count toward the cap, so paging goes on.
  const drafts = Array.from({ length: 100 }, (_, i) => listed(1000 - i, { draft: true }));
  const t = setup({ pages: [drafts, [listed(5)]] });
  await t.go();
  assert.equal(t.calls.list.length, 2);
  assert.deepEqual(t.calls.get, [5]);
  assert.equal(t.core.warnings.length, 0);

  // Exactly the cap on a last, short page is not "more".
  const u = setup({ pages: [Array.from({ length: 3 }, (_, i) => listed(3 - i))] });
  await u.go({ opts: { maxPrs: 3 } });
  assert.equal(u.core.warnings.length, 0);
});

test('APPROVE-014: a PR that cannot be read does not stop the others', async () => {
  const s = setup({
    pages: [[listed(2), listed(1)]],
    getError: { 2: Object.assign(new Error('Server Error'), { status: 502 }) },
    results: { 1: { decision: 'dry-run', reason: 'would approve: z' } },
  });
  const result = await s.go();
  assert.deepEqual(s.calls.get, [2, 1]);
  assert.ok(s.core.errors.includes('pr-approval pr=2 decision=skip reason=evaluation failed: 502 Server Error'));
  assert.equal(result.decision, 'dry-run');
});

test('APPROVE-014: a failed listing is a skip naming it', async () => {
  const s = setup({ listError: Object.assign(new Error('Bad credentials'), { status: 401 }) });
  const result = await s.go();
  assert.equal(result.decision, 'skip');
  assert.equal(result.reason, 'sweep failed: could not list the open PRs: 401 Bad credentials');
  assert.equal(s.calls.get.length, 0);
});

test('APPROVE-012: an empty bot-login fails as on an event run, before any PR is listed', async () => {
  const s = setup({ pages: [[listed(1)]] });
  const result = await s.go({ args: { env: { PR_APPROVAL_BOT_LOGIN: ' ' } } });
  assert.equal(result.decision, 'error');
  assert.equal(s.calls.list.length, 0);
  assert.equal(s.calls.evaluated.length, 1);
  assert.equal(s.calls.evaluated[0].context, s.context);
});
