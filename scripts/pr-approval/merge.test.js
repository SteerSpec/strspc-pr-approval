// SPDX-License-Identifier: Apache-2.0
const test = require('node:test');
const assert = require('node:assert/strict');
const { mergePullRequest, mergeableStateBlocker } = require('./merge.js');

const HEAD = 'b'.repeat(40);
const httpError = (status, message = `HTTP ${status}`) => Object.assign(new Error(message), { status });

// A fake read client (rules, repo settings, PR re-read) and a fake merge
// client. Every option can be a value or an Error to throw.
function setup({
  rules = [],
  settings = { allow_merge_commit: true, allow_squash_merge: false, allow_rebase_merge: false },
  current = {},
  mergeResult = { merged: true, sha: 'm' },
  policyMerge = { enabled: true },
  kind = {},
} = {}) {
  const calls = { request: [], reposGet: 0, pullsGet: 0, merge: [], info: [] };
  const val = (v) => { if (v instanceof Error) throw v; return v; };
  const github = {
    request: async (route, params) => { calls.request.push({ route, params }); return { data: val(rules) }; },
    rest: {
      repos: { get: async () => { calls.reposGet++; return { data: val(settings) }; } },
      pulls: {
        get: async () => {
          calls.pullsGet++;
          return { data: val(current instanceof Error ? current : { state: 'open', head: { sha: HEAD }, mergeable_state: 'clean', ...current }) };
        },
        merge: async () => { throw new Error('merged with the workflow client'); },
      },
    },
  };
  const mergeGithub = {
    rest: { pulls: { merge: async (p) => { calls.merge.push(p); return { data: val(mergeResult) }; } } },
  };
  const core = { info: (m) => calls.info.push(m) };
  const args = {
    github, mergeGithub, owner: 'o', repo: 'r',
    pr: { number: 7, base: { ref: 'main' } }, headSha: HEAD,
    policy: { id: 'p', rules: ['MERGE-001'], merge: policyMerge }, kind, ctx: { marker: 'ctx' }, core,
  };
  return { args, calls, github, mergeGithub };
}

const prRule = (methods) => ({ type: 'pull_request', parameters: methods ? { allowed_merge_methods: methods } : {} });

test('MERGE-001: refuses when the policy does not enable merging', async () => {
  for (const policyMerge of [undefined, {}, { enabled: false }]) {
    const { args, calls } = setup();
    const r = await mergePullRequest({ ...args, policy: { ...args.policy, merge: policyMerge } });
    assert.equal(r.merged, false);
    assert.match(r.reason, /MERGE-001/);
    assert.equal(calls.merge.length, 0);
  }
});

test('MERGE-002: refuses without merge token', async () => {
  const { args, calls } = setup();
  const r = await mergePullRequest({ ...args, mergeGithub: null });
  assert.deepEqual(r, { merged: false, reason: 'merge-token is not set; merging with GITHUB_TOKEN would start no workflow (MERGE-002)' });
  assert.equal(calls.request.length, 0);
  assert.equal(calls.info.length, 1);
});

test('MERGE-002: refuses when the merge client is the workflow client', async () => {
  const { args } = setup();
  const r = await mergePullRequest({ ...args, mergeGithub: args.github });
  assert.match(r.reason, /MERGE-002/);
});

test('MERGE-003: merges the evaluated head with the merge client and logs one line', async () => {
  const { args, calls } = setup();
  const r = await mergePullRequest(args);
  assert.deepEqual(r, { merged: true, method: 'merge' });
  assert.deepEqual(calls.merge, [{ owner: 'o', repo: 'r', pull_number: 7, sha: HEAD, merge_method: 'merge' }]);
  assert.deepEqual(calls.request[0], {
    route: 'GET /repos/{owner}/{repo}/rules/branches/{branch}',
    params: { owner: 'o', repo: 'r', branch: 'main', per_page: 100 },
  });
  assert.deepEqual(calls.info, ['pr-approval merge pr=7 merged=true method=merge']);
});

// --- MERGE-004 ----------------------------------------------------------------

test('MERGE-004: the policy method is used when the rules allow it', async () => {
  const { args, calls } = setup({ rules: [prRule(['squash', 'rebase'])], policyMerge: { enabled: true, method: 'rebase' } });
  assert.deepEqual(await mergePullRequest(args), { merged: true, method: 'rebase' });
  assert.equal(calls.merge[0].merge_method, 'rebase');
  assert.equal(calls.reposGet, 0);
});

test('MERGE-004: refuses when the policy method and the rules disagree, naming both', async () => {
  const { args, calls } = setup({ rules: [prRule(['squash'])], policyMerge: { enabled: true, method: 'merge' } });
  const r = await mergePullRequest(args);
  assert.equal(r.merged, false);
  assert.match(r.reason, /policy merge\.method is merge but the rules of main allow only squash \(MERGE-004\)/);
  assert.equal(calls.merge.length, 0);
});

test('MERGE-004: the policy method is used as-is when no rule constrains the method', async () => {
  const { args, calls } = setup({ rules: [], policyMerge: { enabled: true, method: 'squash' } });
  assert.deepEqual(await mergePullRequest(args), { merged: true, method: 'squash' });
  assert.equal(calls.reposGet, 0);
});

test('MERGE-004: without a policy method, a single method allowed by the rules is used', async () => {
  const { args, calls } = setup({ rules: [{ type: 'deletion' }, prRule(['squash'])] });
  assert.deepEqual(await mergePullRequest(args), { merged: true, method: 'squash' });
  assert.equal(calls.reposGet, 0);
});

test('MERGE-004: several pull_request rules are intersected', async () => {
  const { args } = setup({ rules: [prRule(['merge', 'squash']), prRule(['squash', 'rebase']), prRule(null)] });
  assert.deepEqual(await mergePullRequest(args), { merged: true, method: 'squash' });
});

test('MERGE-004: rules that intersect to nothing refuse, even with a policy method', async () => {
  for (const method of [undefined, 'merge']) {
    const { args, calls } = setup({ rules: [prRule(['merge']), prRule(['squash'])], policyMerge: { enabled: true, method } });
    const r = await mergePullRequest(args);
    assert.match(r.reason, /allow no merge method.*\(MERGE-004\)/);
    assert.equal(calls.reposGet, 0);
  }
});

test('MERGE-004: several methods allowed by the rules and no policy method is ambiguous', async () => {
  const { args } = setup({ rules: [prRule(['merge', 'squash'])] });
  const r = await mergePullRequest(args);
  assert.match(r.reason, /merge method is ambiguous .*set merge\.method \(MERGE-004\)/);
});

test('MERGE-004: without rules, the single method the repository allows is used', async () => {
  const { args, calls } = setup({ settings: { allow_merge_commit: false, allow_squash_merge: false, allow_rebase_merge: true } });
  assert.deepEqual(await mergePullRequest(args), { merged: true, method: 'rebase' });
  assert.equal(calls.reposGet, 1);
});

test('MERGE-004: without rules, several or no repository methods are ambiguous', async () => {
  for (const settings of [
    { allow_merge_commit: true, allow_squash_merge: true, allow_rebase_merge: false },
    {},
  ]) {
    const { args, calls } = setup({ settings });
    const r = await mergePullRequest(args);
    assert.equal(r.reason, 'merge method is ambiguous; set merge.method (MERGE-004)');
    assert.equal(calls.merge.length, 0);
  }
});

test('MERGE-004: a 404 or 403 on the rules endpoint counts as no rules', async () => {
  for (const status of [404, 403]) {
    const { args, calls } = setup({ rules: httpError(status) });
    assert.deepEqual(await mergePullRequest(args), { merged: true, method: 'merge' });
    assert.equal(calls.reposGet, 1);
  }
});

test('MERGE-004: any other error reading the rules refuses without throwing', async () => {
  const { args, calls } = setup({ rules: httpError(500, 'boom') });
  const r = await mergePullRequest(args);
  assert.deepEqual(r, { merged: false, reason: 'could not prepare the merge: 500 boom' });
  assert.equal(calls.merge.length, 0);
});

test('MERGE-004: an error reading the repository settings refuses without throwing', async () => {
  const { args } = setup({ settings: httpError(502, 'bad gateway') });
  assert.deepEqual(await mergePullRequest(args), { merged: false, reason: 'could not prepare the merge: 502 bad gateway' });
});

// --- kind.mergeBlocker (MERGE-005 for release) --------------------------------

test('MERGE-005: the kind mergeBlocker refuses with its reason and receives ctx', async () => {
  let seen;
  const { args, calls } = setup({ kind: { mergeBlocker: async (ctx) => { seen = ctx; return 'source branch has an unreleased commit'; } } });
  const r = await mergePullRequest(args);
  assert.deepEqual(r, { merged: false, reason: 'source branch has an unreleased commit' });
  assert.equal(seen.marker, 'ctx');
  assert.equal(calls.pullsGet, 0);
  assert.equal(calls.merge.length, 0);
});

test('MERGE-005: a mergeBlocker returning null lets the merge proceed; one that throws refuses', async () => {
  const ok = setup({ kind: { mergeBlocker: () => null } });
  assert.equal((await mergePullRequest(ok.args)).merged, true);
  const bad = setup({ kind: { mergeBlocker: async () => { throw new Error('cannot list commits'); } } });
  assert.deepEqual(await mergePullRequest(bad.args), { merged: false, reason: 'could not prepare the merge: cannot list commits' });
  assert.equal(bad.calls.merge.length, 0);
});

// --- MERGE-003 ----------------------------------------------------------------

test('MERGE-003: refuses when the head moved since evaluation', async () => {
  const { args, calls } = setup({ current: { head: { sha: 'c'.repeat(40) } } });
  const r = await mergePullRequest(args);
  assert.equal(r.reason, `head moved from bbbbbbbb to cccccccc (MERGE-003)`);
  assert.equal(calls.merge.length, 0);
});

test('MERGE-003: refuses when the PR is already merged or closed', async () => {
  assert.equal((await mergePullRequest(setup({ current: { merged: true, state: 'closed' } }).args)).reason, 'already merged');
  assert.equal((await mergePullRequest(setup({ current: { state: 'closed' } }).args)).reason, 'PR is closed');
});

test('MERGE-003: refuses until GitHub has computed mergeability', async () => {
  for (const mergeable_state of ['unknown', null, undefined]) {
    const { args, calls } = setup({ current: { mergeable_state } });
    const r = await mergePullRequest(args);
    assert.equal(r.reason, 'GitHub has not computed mergeability yet; the next event retries (MERGE-003)');
    assert.equal(calls.merge.length, 0);
  }
});

test('MERGE-003: refuses unless mergeable_state is clean, naming the state', async () => {
  for (const state of ['blocked', 'behind', 'dirty', 'unstable', 'draft', 'has_hooks']) {
    const { args, calls } = setup({ current: { mergeable_state: state } });
    const r = await mergePullRequest(args);
    assert.match(r.reason, new RegExp(`^mergeable_state is ${state}.*\\(MERGE-003\\)$`));
    assert.equal(calls.merge.length, 0);
  }
  assert.equal(mergeableStateBlocker('clean'), null);
});

test('MERGE-003: an error re-reading the PR refuses without throwing', async () => {
  const { args } = setup({ current: httpError(500, 'down') });
  assert.deepEqual(await mergePullRequest(args), { merged: false, reason: 'could not prepare the merge: 500 down' });
});

// --- the merge call -----------------------------------------------------------

test('MERGE-003: a 405 from the merge call is reported as not mergeable', async () => {
  const { args } = setup({ mergeResult: httpError(405, 'Pull Request is not mergeable') });
  const r = await mergePullRequest(args);
  assert.equal(r.merged, false);
  assert.match(r.reason, /^GitHub refused the merge: not mergeable \(405 Pull Request is not mergeable\)$/);
});

test('MERGE-003: a 409 from the merge call means the head moved', async () => {
  const { args } = setup({ mergeResult: httpError(409, 'Head branch was modified') });
  const r = await mergePullRequest(args);
  assert.match(r.reason, /^head moved before the merge \(409 Head branch was modified\) \(MERGE-003\)$/);
});

test('MERGE-003: any other merge error is reported, never thrown', async () => {
  const { args, calls } = setup({ mergeResult: httpError(500, 'oops') });
  assert.deepEqual(await mergePullRequest(args), { merged: false, reason: 'merge API call failed: 500 oops' });
  assert.deepEqual(calls.info, ['pr-approval merge pr=7 merged=false reason=merge API call failed: 500 oops']);
});

test('MERGE-003: a 200 response with merged:false is not a merge', async () => {
  const { args } = setup({ mergeResult: { merged: false, message: 'nope' } });
  assert.deepEqual(await mergePullRequest(args), { merged: false, reason: 'GitHub did not merge: nope' });
  const bare = setup({ mergeResult: { merged: false } });
  assert.deepEqual(await mergePullRequest(bare.args), { merged: false, reason: 'GitHub did not merge: no reason given' });
});

test('mergePullRequest works without a core', async () => {
  const { args } = setup();
  assert.equal((await mergePullRequest({ ...args, core: undefined })).merged, true);
});

// --- settle wait after this run's own approval --------------------------------

function sequence(states) {
  const s = setup();
  let i = 0;
  s.github.rest.pulls.get = async () => {
    s.calls.pullsGet++;
    const state = states[Math.min(i++, states.length - 1)];
    return { data: { state: 'open', head: { sha: HEAD }, mergeable_state: state } };
  };
  return s;
}

test('MERGE-003: after approving in this run, waits for blocked -> clean, then merges', async () => {
  const { args, calls } = sequence(['blocked', 'unknown', 'clean']);
  const slept = [];
  const r = await mergePullRequest({ ...args, justApproved: true, sleep: async (ms) => { slept.push(ms); }, settleMs: 5 });
  assert.equal(r.merged, true);
  assert.equal(calls.pullsGet, 3);
  assert.deepEqual(slept, [5, 5]);
  assert.equal(calls.merge.length, 1);
});

test('MERGE-003: the settle wait is bounded and ends with the usual refusal', async () => {
  const { args, calls } = sequence(['blocked']);
  const r = await mergePullRequest({ ...args, justApproved: true, sleep: async () => {}, settleAttempts: 3 });
  assert.equal(r.merged, false);
  assert.match(r.reason, /^mergeable_state is blocked/);
  assert.equal(calls.pullsGet, 4);
  assert.equal(calls.merge.length, 0);
});

test('MERGE-003: no settle wait when the approval predates this run, or for states an approval cannot change', async () => {
  for (const [justApproved, state] of [[false, 'blocked'], [true, 'dirty'], [true, 'behind']]) {
    const { args, calls } = sequence([state, 'clean']);
    let slept = 0;
    const r = await mergePullRequest({ ...args, justApproved, sleep: async () => { slept++; } });
    assert.equal(r.merged, false, `${justApproved} ${state}`);
    assert.equal(slept, 0);
    assert.equal(calls.pullsGet, 1);
  }
});
