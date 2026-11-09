// SPDX-License-Identifier: Apache-2.0
const test = require('node:test');
const assert = require('node:assert/strict');
const ts = require('./template-sync.js');
const { compareHead } = require('../util.js');

const AUTHOR = 'steerspec-sync[bot]';
const HEAD = 'a'.repeat(40);

const commit = (sha, login = AUTHOR, { verified = true, committer = 'web-flow' } = {}) => ({
  sha,
  author: login ? { login } : null,
  committer: committer ? { login: committer } : null,
  commit: { verification: { verified } },
});

function fakeGithub({ files = [{ filename: '.github/workflows/ci.yml', status: 'modified' }], openPrs = [], commits = [commit(HEAD)] } = {}) {
  const calls = { list: [], compare: 0 };
  return {
    calls,
    rest: {
      pulls: {
        listCommits: async () => ({ data: commits }),
        list: async (params) => {
          calls.list.push(params);
          return { data: openPrs };
        },
      },
      repos: {
        compareCommitsWithBasehead: async () => {
          calls.compare++;
          return { data: { files, merge_base_commit: { sha: 'm'.repeat(40) } } };
        },
      },
    },
    paginate: async (fn, params) => (await fn(params)).data,
  };
}

const openPr = (number, ref, login = AUTHOR) => ({ number, head: { ref }, user: { login } });

function makeCtx({
  github = fakeGithub(), options = { author: AUTHOR }, user = AUTHOR,
  head = 'steerspec-sync/ci-workflow/1.0.1', labels = [{ name: 'steerspec-sync' }],
} = {}) {
  const pr = { number: 20, user: { login: user }, head: { ref: head, sha: HEAD }, base: { ref: 'develop' }, labels };
  return {
    github, owner: 'o', repo: 'r', pr, options, policy: { id: 'ts', kind: 'template-sync', options },
    compare: () => compareHead({ github, owner: 'o', repo: 'r', baseRef: 'develop', headSha: HEAD }),
  };
}

test('template-sync: interface', () => {
  assert.equal(ts.name, 'template-sync');
  assert.equal(ts.requiresTip, false);
  assert.equal(typeof ts.mergeBlocker, 'function');
});

test('template-sync: defaultMatch', () => {
  assert.deepEqual(ts.defaultMatch({ author: AUTHOR }), {
    head: 'steerspec-sync/*/*', labels: ['steerspec-sync'], authors: [AUTHOR],
  });
  assert.deepEqual(ts.defaultMatch({ author: AUTHOR, label: 'sync' }).labels, ['sync']);
  assert.deepEqual(ts.defaultMatch({}), { head: 'steerspec-sync/*/*', labels: ['steerspec-sync'] });
  assert.deepEqual(ts.defaultMatch(), { head: 'steerspec-sync/*/*', labels: ['steerspec-sync'] });
});

test('template-sync: validateOptions', () => {
  assert.deepEqual(ts.validateOptions({ author: AUTHOR }), []);
  assert.deepEqual(ts.validateOptions({ author: AUTHOR, label: 'sync', paths: ['.github/**'] }), []);
  assert.match(ts.validateOptions({}).join(), /author is required/);
  assert.match(ts.validateOptions({ author: [] }).join(), /author must be a non-empty string/);
  assert.match(ts.validateOptions({ author: AUTHOR, label: '' }).join(), /label must be/);
  assert.match(ts.validateOptions({ author: AUTHOR, label: ['x'] }).join(), /label must be/);
  assert.match(ts.validateOptions({ author: AUTHOR, paths: '.github/**' }).join(), /paths must be/);
  assert.match(ts.validateOptions({ author: AUTHOR, paths: [] }).join(), /paths must be/);
  assert.match(ts.validateOptions({ author: AUTHOR, files: ['x'] }).join(), /unknown key 'files'/);
});

test('template-sync: parseSyncHead', () => {
  assert.deepEqual(ts.parseSyncHead('steerspec-sync/ci-workflow/1.0.1'), { template: 'ci-workflow', version: '1.0.1' });
  assert.deepEqual(ts.parseSyncHead('steerspec-sync/pr_review.v2/v2.0.0-rc.1'), { template: 'pr_review.v2', version: 'v2.0.0-rc.1' });
  for (const ref of ['steerspec-sync/ci/x', 'steerspec-sync/a/b/1.0.0', 'steerspec-sync//1.0.0', 'steerspec-sync/../1.0.0',
    'other/ci/1.0.0', 'steerspec-sync/ci', undefined]) {
    assert.equal(ts.parseSyncHead(ref), null, String(ref));
  }
});

test('template-sync: approves a sync by the bot with the label', async () => {
  const github = fakeGithub({ openPrs: [openPr(20, 'steerspec-sync/ci-workflow/1.0.1'), openPr(21, 'steerspec-sync/other/9.0.0')] });
  const res = await ts.evaluate(makeCtx({ github }));
  assert.deepEqual(res, { ok: true, summary: 'template-sync (ci-workflow 1.0.1)' });
  assert.deepEqual(github.calls.list[0], { owner: 'o', repo: 'r', state: 'open', per_page: 100 });
  assert.equal(github.calls.compare, 0, 'no paths option, no file listing needed');
});

test('template-sync: labels given as strings are accepted', async () => {
  const res = await ts.evaluate(makeCtx({ labels: ['steerspec-sync'] }));
  assert.equal(res.ok, true);
});

test('template-sync: refuses without options.author', async () => {
  const res = await ts.evaluate(makeCtx({ options: {}, user: undefined }));
  assert.equal(res.ok, false);
  assert.match(res.reason, /options.author is not set/);
});

test('template-sync: refuses another author', async () => {
  const res = await ts.evaluate(makeCtx({ user: 'mallory' }));
  assert.equal(res.ok, false);
  assert.match(res.reason, /author mallory is not/);
});

test('template-sync: refuses a malformed head', async () => {
  const res = await ts.evaluate(makeCtx({ head: 'steerspec-sync/ci-workflow/latest' }));
  assert.equal(res.ok, false);
  assert.match(res.reason, /is not steerspec-sync\/<template>\/<version>/);
});

test('template-sync: refuses a PR without the label', async () => {
  const res = await ts.evaluate(makeCtx({ labels: [{ name: 'dependencies' }] }));
  assert.equal(res.ok, false);
  assert.match(res.reason, /does not carry label 'steerspec-sync'/);
  const res2 = await ts.evaluate(makeCtx({ labels: [] }));
  assert.equal(res2.ok, false);
});

test('template-sync: a configured label replaces the default', async () => {
  const options = { author: AUTHOR, label: 'template' };
  assert.equal((await ts.evaluate(makeCtx({ options }))).ok, false);
  assert.equal((await ts.evaluate(makeCtx({ options, labels: [{ name: 'template' }] }))).ok, true);
});

test('template-sync: options.paths must cover every changed file', async () => {
  const options = { author: AUTHOR, paths: ['.github/workflows/*.yml'] };
  const ok = await ts.evaluate(makeCtx({ options }));
  assert.equal(ok.ok, true);
  const github = fakeGithub({ files: [{ filename: '.github/workflows/ci.yml' }, { filename: 'src/index.js' }] });
  const res = await ts.evaluate(makeCtx({ options, github }));
  assert.equal(res.ok, false);
  assert.match(res.reason, /changes src\/index.js, outside options.paths/);
});

test('template-sync: options.paths refuses unlistable or empty changes', async () => {
  const options = { author: AUTHOR, paths: ['**'] };
  const many = Array.from({ length: 300 }, (_, i) => ({ filename: `f${i}` }));
  const res = await ts.evaluate(makeCtx({ options, github: fakeGithub({ files: many }) }));
  assert.equal(res.ok, false);
  assert.match(res.reason, /cannot be completely listed/);
  const res2 = await ts.evaluate(makeCtx({ options, github: fakeGithub({ files: null }) }));
  assert.match(res2.reason, /cannot be completely listed/);
  const res3 = await ts.evaluate(makeCtx({ options, github: fakeGithub({ files: [] }) }));
  assert.match(res3.reason, /changes no files/);
});

test('template-sync: refuses when a newer sync of the same template is open', async () => {
  const github = fakeGithub({
    openPrs: [openPr(21, 'steerspec-sync/ci-workflow/1.0.10'), openPr(22, 'steerspec-sync/ci-workflow/1.0.2'),
      openPr(23, 'steerspec-sync/other/5.0.0')],
  });
  const res = await ts.evaluate(makeCtx({ github }));
  assert.deepEqual(res, { ok: false, reason: 'superseded by #21 (1.0.10)' });
});

test('template-sync: supersession ignores older, equal, other-template and unparseable heads', async () => {
  const github = fakeGithub({
    openPrs: [openPr(21, 'steerspec-sync/ci-workflow/1.0.0'), openPr(22, 'steerspec-sync/ci-workflow/1.0.1'),
      openPr(23, 'steerspec-sync/ci-workflow/next'), openPr(24, 'steerspec-sync/ci-workflow2/9.0.0'),
      openPr(20, 'steerspec-sync/ci-workflow/9.9.9')],
  });
  const res = await ts.evaluate(makeCtx({ github }));
  assert.equal(res.ok, true);
});

test('template-sync: mergeBlocker re-checks supersession', async () => {
  assert.equal(await ts.mergeBlocker(makeCtx()), null);
  const github = fakeGithub({ openPrs: [openPr(21, 'steerspec-sync/ci-workflow/2.0.0')] });
  assert.equal(await ts.mergeBlocker(makeCtx({ github })), 'superseded by #21 (2.0.0)');
  assert.match(await ts.mergeBlocker(makeCtx({ head: 'x' })), /is not steerspec-sync/);
});

test('template-sync: refuses an unverified commit by the bot', async () => {
  const github = fakeGithub({ commits: [commit('c'.repeat(40), AUTHOR, { verified: false }), commit(HEAD)] });
  const res = await ts.evaluate(makeCtx({ github }));
  assert.deepEqual(res, { ok: false, reason: 'commit cccccccc is not verified' });
});

test('template-sync: refuses a human commit on the bot branch', async () => {
  const github = fakeGithub({ commits: [commit('c'.repeat(40)), commit(HEAD, 'mallory', { committer: 'mallory' })] });
  const res = await ts.evaluate(makeCtx({ github }));
  assert.deepEqual(res, { ok: false, reason: `commit aaaaaaaa is not by ${AUTHOR}` });
});

test('template-sync: refuses a bot-authored commit committed by a person', async () => {
  const github = fakeGithub({ commits: [commit(HEAD, AUTHOR, { committer: 'mallory' })] });
  const res = await ts.evaluate(makeCtx({ github }));
  assert.deepEqual(res, { ok: false, reason: `commit aaaaaaaa is not by ${AUTHOR}` });
});

test('template-sync: refuses a commit list missing the head', async () => {
  const github = fakeGithub({ commits: [commit('c'.repeat(40))] });
  const res = await ts.evaluate(makeCtx({ github }));
  assert.deepEqual(res, { ok: false, reason: 'commit list does not include the evaluated head aaaaaaaa' });
});

test('template-sync: refuses 250 commits or more', async () => {
  const commits = Array.from({ length: 249 }, (_, i) => commit(String(i).padStart(40, '0')));
  commits.push(commit(HEAD));
  const res = await ts.evaluate(makeCtx({ github: fakeGithub({ commits }) }));
  assert.equal(res.ok, false);
  assert.match(res.reason, /250 commits or more/);
});

test('template-sync: only the bot\'s own open PRs supersede', async () => {
  const github = fakeGithub({ openPrs: [openPr(30, 'steerspec-sync/ci-workflow/9.0.0', 'mallory'), { number: 31, head: { ref: 'steerspec-sync/ci-workflow/9.0.0' } }] });
  assert.equal((await ts.evaluate(makeCtx({ github }))).ok, true);
  assert.equal(await ts.mergeBlocker(makeCtx({ github })), null);
  const byBot = fakeGithub({ openPrs: [openPr(32, 'steerspec-sync/ci-workflow/9.0.0')] });
  assert.deepEqual(await ts.evaluate(makeCtx({ github: byBot })), { ok: false, reason: 'superseded by #32 (9.0.0)' });
});
