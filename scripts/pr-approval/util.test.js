// SPDX-License-Identifier: Apache-2.0
const test = require('node:test');
const assert = require('node:assert/strict');
const util = require('./util.js');

test('globToRegExp: * stays within a path segment', () => {
  const re = util.globToRegExp('src/*.js');
  assert.ok(re.test('src/a.js'));
  assert.ok(!re.test('src/sub/a.js'));
});

test('globToRegExp: **/ matches zero or more directories', () => {
  const re = util.globToRegExp('**/package.json');
  assert.ok(re.test('package.json'));
  assert.ok(re.test('a/b/package.json'));
  assert.ok(!re.test('a/package.jsonx'));
});

test('globToRegExp: trailing ** matches everything below', () => {
  const re = util.globToRegExp('rules/_schema/**');
  assert.ok(re.test('rules/_schema/a.json'));
  assert.ok(re.test('rules/_schema/x/y.json'));
  assert.ok(!re.test('rules/a.json'));
});

test('globToRegExp: ? is one non-slash character; regex metacharacters are literal', () => {
  assert.ok(util.globToRegExp('v?.txt').test('v1.txt'));
  assert.ok(!util.globToRegExp('v?.txt').test('v/.txt'));
  assert.ok(!util.globToRegExp('a.b').test('axb'));
  assert.ok(util.globToRegExp('a+(b)').test('a+(b)'));
  assert.ok(util.globToRegExp('release-please--branches--*').test('release-please--branches--main'));
});

test('matchesAnyGlob accepts a string or a list, and nothing matches an empty list', () => {
  assert.ok(util.matchesAnyGlob('main', 'main'));
  assert.ok(util.matchesAnyGlob('release/1.0', ['main', 'release/*']));
  assert.ok(!util.matchesAnyGlob('dev', ['main', 'release/*']));
  assert.ok(!util.matchesAnyGlob('main', undefined));
  assert.ok(!util.matchesAnyGlob('main', []));
});

test('filesMatchPaths: every file must match; an empty or unknown list proves nothing', () => {
  assert.ok(util.filesMatchPaths(['CHANGELOG.md', 'package.json'], ['CHANGELOG.md', 'package.json']));
  assert.ok(!util.filesMatchPaths(['CHANGELOG.md', 'src/x.js'], ['CHANGELOG.md']));
  assert.ok(!util.filesMatchPaths([], ['**']));
  assert.ok(!util.filesMatchPaths(null, ['**']));
  assert.ok(!util.filesMatchPaths(['a'], []));
  assert.ok(util.filesMatchPaths(['a'], 'a'));
});

test('toList normalises undefined, null, scalars and lists', () => {
  assert.deepEqual(util.toList(undefined), []);
  assert.deepEqual(util.toList(null), []);
  assert.deepEqual(util.toList('a'), ['a']);
  assert.deepEqual(util.toList(['a', 'b']), ['a', 'b']);
});

test('parseConventionalTitle', () => {
  assert.deepEqual(util.parseConventionalTitle('chore: promote'), { type: 'chore', breaking: false });
  assert.deepEqual(util.parseConventionalTitle('chore(main): release 1.2.0'), { type: 'chore', breaking: false });
  assert.deepEqual(util.parseConventionalTitle('Fix(scope)!: x'), { type: 'fix', breaking: true });
  assert.deepEqual(util.parseConventionalTitle('feat!: x'), { type: 'feat', breaking: true });
  assert.equal(util.parseConventionalTitle('Promote dev to main'), null);
  assert.equal(util.parseConventionalTitle(''), null);
  assert.equal(util.parseConventionalTitle(undefined), null);
});

test('compareVersions: numeric, v-prefix, missing parts, text parts', () => {
  assert.equal(util.compareVersions('1.2.0', '1.10.0'), -1);
  assert.equal(util.compareVersions('v2.0.0', '1.9.9'), 1);
  assert.equal(util.compareVersions('1.2', '1.2.0'), 0);
  assert.equal(util.compareVersions('1.2.0', 'v1.2.0'), 0);
  assert.equal(util.compareVersions('1.0.0-alpha', '1.0.0-beta'), -1);
  assert.equal(util.compareVersions('1.0.0-beta', '1.0.0-alpha'), 1);
});

test('compareVersions follows semver precedence for prereleases and build metadata', () => {
  assert.equal(util.compareVersions('1.0.0-rc.1', '1.0.0'), -1);
  assert.equal(util.compareVersions('1.0.0', '1.0.0-rc.1'), 1);
  assert.equal(util.compareVersions('1.0.0-rc.2', '1.0.0-rc.10'), -1);
  assert.equal(util.compareVersions('1.0.0-alpha', '1.0.0-alpha.1'), -1);
  assert.equal(util.compareVersions('1.0.0-alpha.1', '1.0.0-alpha.beta'), -1);
  assert.equal(util.compareVersions('1.0.0-alpha.beta', '1.0.0-alpha.1'), 1);
  assert.equal(util.compareVersions('1.0.0-rc.1', '1.0.0-rc.1'), 0);
  assert.equal(util.compareVersions('1.0.0+build.5', '1.0.0+build.9'), 0);
  assert.equal(util.compareVersions('1.0.0-rc.1+b', '1.0.0'), -1);
  assert.equal(util.compareVersions('1.1.0-rc.1', '1.0.0'), 1);
});

test('changedFileNames: includes previous names of renames; null at the 300-file cap', () => {
  assert.deepEqual(
    util.changedFileNames([{ filename: 'b' }, { filename: 'c', previous_filename: 'a' }]),
    ['b', 'c', 'a'],
  );
  const many = Array.from({ length: util.MAX_LISTED_FILES }, (_, i) => ({ filename: `f${i}` }));
  assert.equal(util.changedFileNames(many), null);
  assert.equal(util.changedFileNames(many.slice(1)).length, util.MAX_LISTED_FILES - 1);
});

test('APPROVE-002: isFailedCheck refuses failure-like conclusions and ignores unfinished runs', () => {
  for (const conclusion of ['failure', 'timed_out', 'action_required', 'startup_failure', null]) {
    assert.equal(util.isFailedCheck({ status: 'completed', conclusion }), true, String(conclusion));
  }
  // cancelled and stale pass, as in strspc-pr-review (see util.js).
  assert.deepEqual(util.CHECK_OK_CONCLUSIONS, ['success', 'neutral', 'skipped', 'cancelled', 'stale']);
  for (const conclusion of ['success', 'neutral', 'skipped', 'cancelled', 'stale']) {
    assert.equal(util.isFailedCheck({ status: 'completed', conclusion }), false, conclusion);
  }
  // Unfinished is "pending", not "failed"; decide.js handles it separately.
  assert.equal(util.isFailedCheck({ status: 'in_progress', conclusion: null }), false);
});

test('stripApiHost and describeError', () => {
  assert.equal(util.stripApiHost('https://api.github.com/repos/o/r/pulls/1'), '/repos/o/r/pulls/1');
  assert.equal(util.describeError({ status: 404, message: 'Not Found' }), '404 Not Found');
  assert.equal(util.describeError(new Error('boom')), 'boom');
  assert.equal(util.describeError('plain'), 'plain');
});

test('makeApiClient enables retries for transient errors', () => {
  let seen;
  const client = util.makeApiClient((token, opts) => { seen = { token, opts }; return 'client'; }, 't0k');
  assert.equal(client, 'client');
  assert.deepEqual(seen, { token: 't0k', opts: { retry: { enabled: true, retries: util.API_RETRIES } } });
});

// --- fetchCheckRuns ---------------------------------------------------------

function checksGithub(pages) {
  const calls = [];
  return {
    calls,
    rest: {
      checks: {
        listForRef: async (params) => {
          calls.push(params);
          const total = pages.reduce((n, p) => n + p.length, 0);
          return { data: { total_count: total, check_runs: pages[params.page - 1] || [] } };
        },
      },
    },
  };
}

const ctx = { runId: 777, job: 'approve' };

test('fetchCheckRuns pages until total_count and keeps the latest attempt per (name, app)', async () => {
  const github = checksGithub([
    [
      { id: 1, name: 'build', app: { id: 1 }, status: 'completed', conclusion: 'failure', started_at: '2026-01-01T00:00:00Z' },
      { id: 2, name: 'lint', app: { id: 1 }, status: 'completed', conclusion: 'success', started_at: '2026-01-01T00:00:00Z' },
    ],
    [
      { id: 3, name: 'build', app: { id: 1 }, status: 'completed', conclusion: 'success', started_at: '2026-01-01T01:00:00Z' },
      { id: 4, name: 'build', app: { id: 2 }, status: 'completed', conclusion: 'neutral', started_at: '2026-01-01T00:00:00Z' },
    ],
  ]);
  const runs = await util.fetchCheckRuns({ github, context: ctx, owner: 'o', repo: 'r', headSha: 'abc' });
  assert.equal(github.calls.length, 2);
  assert.equal(github.calls[0].ref, 'abc');
  const byKey = Object.fromEntries(runs.map((r) => [`${r.name}:${r.app.id}`, r.id]));
  assert.deepEqual(byKey, { 'build:1': 3, 'lint:1': 2, 'build:2': 4 });
});

test('fetchCheckRuns breaks ties on the same timestamp by the higher id', async () => {
  const at = '2026-01-01T00:00:00Z';
  const github = checksGithub([[
    { id: 9, name: 'x', app: { id: 1 }, status: 'completed', conclusion: 'success', started_at: at },
    { id: 5, name: 'x', app: { id: 1 }, status: 'completed', conclusion: 'failure', started_at: at },
  ]]);
  const runs = await util.fetchCheckRuns({ github, context: ctx, owner: 'o', repo: 'r', headSha: 'abc' });
  assert.deepEqual(runs.map((r) => r.id), [9]);
});

test('fetchCheckRuns drops this run and unfinished runs named like its job; keeps finished ones', async () => {
  const github = checksGithub([[
    { id: 1, name: 'anything', status: 'in_progress', details_url: 'https://github.com/o/r/actions/runs/777/job/1' },
    { id: 2, name: 'approve', status: 'queued', details_url: 'https://github.com/o/r/actions/runs/555' },
    { id: 3, name: 'pr-approval', status: 'in_progress' },
    { id: 4, name: 'extra-self', status: 'in_progress' },
    { id: 5, name: 'approve', status: 'completed', conclusion: 'success' },
    { id: 6, name: 'other', status: 'completed', conclusion: 'success', details_url: 'https://github.com/o/r/actions/runs/7770' },
    null,
  ]]);
  const runs = await util.fetchCheckRuns({
    github, context: ctx, owner: 'o', repo: 'r', headSha: 'abc', selfJobNames: ['extra-self'],
  });
  // 5 is a finished 'approve' (context.job): names are not unique across
  // workflows, so a completed run of that name may be someone's CI.
  assert.deepEqual(runs.map((r) => r.id).sort(), [5, 6]);
});

test('APPROVE-002: a failing CI job sharing this job\'s name still blocks; cancelled siblings pass', async () => {
  const github = checksGithub([[
    { id: 1, name: 'pr-approval', app: { id: 1 }, status: 'completed', conclusion: 'cancelled' },
    { id: 2, name: 'approve', app: { id: 1 }, status: 'completed', conclusion: 'cancelled' },
    { id: 3, name: 'ci', app: { id: 1 }, status: 'completed', conclusion: 'failure' },
    { id: 4, name: 'lint', app: { id: 1 }, status: 'completed', conclusion: 'cancelled' },
    { id: 5, name: 'pr-approval', app: { id: 2 }, status: 'completed', conclusion: 'failure' },
  ]]);
  const runs = await util.fetchCheckRuns({ github, context: ctx, owner: 'o', repo: 'r', headSha: 'abc' });
  assert.deepEqual(runs.map((r) => r.id).sort(), [1, 2, 3, 4, 5]);
  assert.deepEqual(runs.filter(util.isFailedCheck).map((r) => r.id).sort(), [3, 5]);
});

test('fetchCheckRuns stops on an empty page even if total_count says more', async () => {
  const github = {
    rest: { checks: { listForRef: async () => ({ data: { total_count: 50, check_runs: [] } }) } },
  };
  assert.deepEqual(await util.fetchCheckRuns({ github, context: ctx, owner: 'o', repo: 'r', headSha: 'a' }), []);
});

// --- compareHead -------------------------------------------------------------

test('compareHead compares heads/<base>...<sha> and reports files and merge base', async () => {
  let params;
  const github = {
    rest: {
      repos: {
        compareCommitsWithBasehead: async (p) => {
          params = p;
          return { data: { files: [{ filename: 'a' }], merge_base_commit: { sha: 'mb' }, total_commits: 2 } };
        },
      },
    },
  };
  const r = await util.compareHead({ github, owner: 'o', repo: 'r', baseRef: 'main', headSha: 'h' });
  assert.equal(params.basehead, 'heads/main...h');
  assert.deepEqual(r, { names: ['a'], files: [{ filename: 'a' }], mergeBase: 'mb', totalCommits: 2 });
});

test('compareHead returns null files and names when the listing is capped or missing', async () => {
  const many = Array.from({ length: util.MAX_LISTED_FILES }, (_, i) => ({ filename: `f${i}` }));
  const mk = (data) => ({ rest: { repos: { compareCommitsWithBasehead: async () => ({ data }) } } });
  const capped = await util.compareHead({ github: mk({ files: many }), owner: 'o', repo: 'r', baseRef: 'm', headSha: 'h' });
  assert.equal(capped.names, null);
  assert.equal(capped.files, null);
  assert.equal(capped.mergeBase, null);
  const none = await util.compareHead({ github: mk({}), owner: 'o', repo: 'r', baseRef: 'm', headSha: 'h' });
  assert.equal(none.names, null);
  assert.equal(none.files, null);
});

// --- dismissReview ------------------------------------------------------------

const httpError = (status, message = 'err') => Object.assign(new Error(message), { status });

test('dismissReview uses the bot client when it succeeds', async () => {
  const calls = [];
  const github = { rest: { pulls: { dismissReview: async () => { calls.push('github'); } } } };
  const botGithub = { rest: { pulls: { dismissReview: async () => { calls.push('bot'); return 'ok'; } } } };
  assert.equal(await util.dismissReview({ github, botGithub, params: {} }), 'ok');
  assert.deepEqual(calls, ['bot']);
});

test('dismissReview falls back to the workflow token on 401/403', async () => {
  for (const status of [401, 403]) {
    const calls = [];
    const github = { rest: { pulls: { dismissReview: async (p) => { calls.push(['github', p.review_id]); return 'fallback'; } } } };
    const botGithub = { rest: { pulls: { dismissReview: async () => { calls.push(['bot']); throw httpError(status); } } } };
    assert.equal(await util.dismissReview({ github, botGithub, params: { review_id: 7 } }), 'fallback');
    assert.deepEqual(calls, [['bot'], ['github', 7]]);
  }
});

test('dismissReview rethrows other errors, and 403 when the bot client is the workflow client', async () => {
  const bot = { rest: { pulls: { dismissReview: async () => { throw httpError(500); } } } };
  const gh = { rest: { pulls: { dismissReview: async () => 'never' } } };
  await assert.rejects(util.dismissReview({ github: gh, botGithub: bot, params: {} }), { status: 500 });
  const same = { rest: { pulls: { dismissReview: async () => { throw httpError(403); } } } };
  await assert.rejects(util.dismissReview({ github: same, botGithub: same, params: {} }), { status: 403 });
});
