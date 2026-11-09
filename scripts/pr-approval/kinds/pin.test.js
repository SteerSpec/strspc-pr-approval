// SPDX-License-Identifier: Apache-2.0
const test = require('node:test');
const assert = require('node:assert/strict');
const pin = require('./pin.js');
const { compareHead } = require('../util.js');

const AUTHOR = 'strspc-rules[bot]';
const HEAD = 'a'.repeat(40);
const PIN_FILES = ['rules/realm.json', '.strspc/config.yaml', 'rules/_schema/realm.schema.json'];

const commit = (sha, login = AUTHOR, { verified = true, committer = 'web-flow' } = {}) => ({
  sha,
  author: login ? { login } : null,
  committer: committer ? { login: committer } : null,
  commit: { verification: { verified } },
});

function fakeGithub({ files = PIN_FILES.map((f) => ({ filename: f, status: 'modified' })), openPrs = [], commits = [commit(HEAD)] } = {}) {
  const listCalls = [];
  return {
    listCalls,
    rest: {
      pulls: {
        listCommits: async () => ({ data: commits }),
        list: async (params) => {
          listCalls.push(params);
          return { data: openPrs };
        },
      },
      repos: {
        compareCommitsWithBasehead: async () => ({ data: { files, merge_base_commit: { sha: 'm'.repeat(40) } } }),
      },
    },
    paginate: async (fn, params) => (await fn(params)).data,
  };
}

const openPr = (number, ref, login = AUTHOR) => ({ number, head: { ref }, user: { login } });

function makeCtx({ github = fakeGithub(), options = { author: AUTHOR }, user = AUTHOR, head = 'chore/core-1.24.0', compare } = {}) {
  const pr = { number: 10, user: { login: user }, head: { ref: head, sha: HEAD }, base: { ref: 'develop' } };
  return {
    github, owner: 'o', repo: 'r', pr, options, policy: { id: 'pin', kind: 'pin', options },
    compare: compare || (() => compareHead({ github, owner: 'o', repo: 'r', baseRef: 'develop', headSha: HEAD })),
  };
}

test('pin: interface', () => {
  assert.equal(pin.name, 'pin');
  assert.equal(pin.requiresTip, false);
  assert.equal(typeof pin.mergeBlocker, 'function');
});

test('pin: defaultMatch', () => {
  assert.deepEqual(pin.defaultMatch({ author: AUTHOR }), { head: 'chore/core-*', authors: [AUTHOR] });
  assert.deepEqual(pin.defaultMatch({}), { head: 'chore/core-*' });
  assert.deepEqual(pin.defaultMatch(), { head: 'chore/core-*' });
});

test('pin: validateOptions', () => {
  assert.deepEqual(pin.validateOptions({ author: AUTHOR }), []);
  assert.deepEqual(pin.validateOptions({ author: AUTHOR, files: ['rules/realm.json', 'rules/_schema/*.json'] }), []);
  assert.deepEqual(pin.validateOptions({ author: AUTHOR, files: ['rules/_schema/**', '.strspc/config.yaml'] }), []);
  assert.deepEqual(pin.validateOptions({ author: AUTHOR, files: ['rules/_schema/realm.schema.json'] }), []);
  assert.match(pin.validateOptions({}).join(), /author is required/);
  assert.match(pin.validateOptions({ author: ' ' }).join(), /author must be a non-empty string/);
  assert.match(pin.validateOptions({ author: AUTHOR, label: 'x' }).join(), /unknown key 'label'/);
  assert.match(pin.validateOptions({ author: AUTHOR, files: 'rules/realm.json' }).join(), /non-empty list/);
  assert.match(pin.validateOptions({ author: AUTHOR, files: [] }).join(), /non-empty list/);
  assert.match(pin.validateOptions({ author: AUTHOR, files: [3] }).join(), /non-empty list/);
});

test('pin: validateOptions refuses files that would widen the allow-list', () => {
  for (const g of ['**', 'rules/**', 'src/**', '*.json', 'rules/*.json', 'rules/_schema/', 'rules/_schema/../x',
    'rules/_schema/./x', 'rules//realm.json', 'README.md', 'rules/realm.json*', '**/realm.json']) {
    const errors = pin.validateOptions({ author: AUTHOR, files: [g] });
    assert.equal(errors.length, 1, g);
    assert.match(errors[0], /outside the built-in allow-list/);
  }
});

test('pin: pinVersion', () => {
  assert.equal(pin.pinVersion('chore/core-1.24.0'), '1.24.0');
  assert.equal(pin.pinVersion('chore/core-v2.0.0-rc.1'), 'v2.0.0-rc.1');
  for (const ref of ['chore/core-', 'chore/core-latest', 'chore/core-1.2.x', 'chore/core-1.2/x', 'feat/core-1.2.0', undefined]) {
    assert.equal(pin.pinVersion(ref), null, String(ref));
  }
});

test('pin: approves a pin of only allowed files', async () => {
  const github = fakeGithub({ openPrs: [openPr(10, 'chore/core-1.24.0'), openPr(9, 'chore/core-1.23.0'), openPr(3, 'feat/x')] });
  const res = await pin.evaluate(makeCtx({ github }));
  assert.deepEqual(res, { ok: true, summary: 'pin (dev.steerspec.core 1.24.0, 3 file(s))' });
  assert.deepEqual(github.listCalls[0], { owner: 'o', repo: 'r', state: 'open', per_page: 100 });
});

test('pin: refuses without options.author', async () => {
  const res = await pin.evaluate(makeCtx({ options: {}, user: undefined }));
  assert.equal(res.ok, false);
  assert.match(res.reason, /options.author is not set/);
});

test('pin: refuses another author', async () => {
  const res = await pin.evaluate(makeCtx({ user: 'mallory' }));
  assert.equal(res.ok, false);
  assert.match(res.reason, /author mallory is not strspc-rules\[bot\]/);
});

test('pin: refuses a head that names no version', async () => {
  const res = await pin.evaluate(makeCtx({ head: 'chore/core-next' }));
  assert.equal(res.ok, false);
  assert.match(res.reason, /head chore\/core-next is not chore\/core-<version>/);
});

test('pin: refuses when the files cannot be listed', async () => {
  const res = await pin.evaluate(makeCtx({ compare: async () => ({ names: null, files: null }) }));
  assert.equal(res.ok, false);
  assert.match(res.reason, /cannot be completely listed/);
  const many = Array.from({ length: 300 }, () => ({ filename: 'rules/realm.json' }));
  const res2 = await pin.evaluate(makeCtx({ github: fakeGithub({ files: many }) }));
  assert.match(res2.reason, /cannot be completely listed/);
});

test('pin: refuses an empty change', async () => {
  const res = await pin.evaluate(makeCtx({ github: fakeGithub({ files: [] }) }));
  assert.equal(res.ok, false);
  assert.match(res.reason, /changes no files/);
});

test('pin: refuses a file outside the built-in allow-list', async () => {
  const github = fakeGithub({ files: [{ filename: 'rules/realm.json' }, { filename: 'rules/APPROVE.json' }] });
  const res = await pin.evaluate(makeCtx({ github }));
  assert.equal(res.ok, false);
  assert.match(res.reason, /changes rules\/APPROVE.json, outside the pin allow-list/);
});

test('pin: a rename counts its old path too', async () => {
  const github = fakeGithub({ files: [{ filename: 'rules/realm.json', previous_filename: 'src/x.json', status: 'renamed' }] });
  const res = await pin.evaluate(makeCtx({ github }));
  assert.equal(res.ok, false);
  assert.match(res.reason, /changes src\/x.json/);
});

test('pin: options.files narrows the allow-list', async () => {
  const options = { author: AUTHOR, files: ['rules/realm.json', '.strspc/config.yaml'] };
  const res = await pin.evaluate(makeCtx({ options }));
  assert.equal(res.ok, false);
  assert.match(res.reason, /changes rules\/_schema\/realm.schema.json, outside options.files/);
  const ok = await pin.evaluate(makeCtx({ options, github: fakeGithub({ files: [{ filename: 'rules/realm.json' }] }) }));
  assert.deepEqual(ok, { ok: true, summary: 'pin (dev.steerspec.core 1.24.0, 1 file(s))' });
});

test('pin: options.files can never widen at runtime', async () => {
  // Even if validation were bypassed, the built-in list still applies.
  const github = fakeGithub({ files: [{ filename: 'src/index.js' }] });
  const res = await pin.evaluate(makeCtx({ github, options: { author: AUTHOR, files: ['**'] } }));
  assert.equal(res.ok, false);
  assert.match(res.reason, /outside the pin allow-list/);
});

test('pin: refuses when a newer pin is open, naming the newest', async () => {
  const github = fakeGithub({
    openPrs: [openPr(11, 'chore/core-1.25.0'), openPr(12, 'chore/core-1.26.0'), openPr(8, 'chore/core-1.9.0')],
  });
  const res = await pin.evaluate(makeCtx({ github }));
  assert.deepEqual(res, { ok: false, reason: 'superseded by #12 (1.26.0)' });
});

test('pin: supersession compares numerically and ignores self, equal and unparseable heads', async () => {
  const github = fakeGithub({
    openPrs: [openPr(10, 'chore/core-9.0.0'), openPr(11, 'chore/core-1.24.0'), openPr(12, 'chore/core-1.3.0'),
      openPr(13, 'chore/core-next'), openPr(14, 'chore/core-x.y'), openPr(15, 'other/core-9.0.0')],
  });
  const res = await pin.evaluate(makeCtx({ github }));
  assert.equal(res.ok, true);
});

test('pin: mergeBlocker re-checks supersession', async () => {
  assert.equal(await pin.mergeBlocker(makeCtx()), null);
  const github = fakeGithub({ openPrs: [openPr(11, 'chore/core-2.0.0')] });
  assert.equal(await pin.mergeBlocker(makeCtx({ github })), 'superseded by #11 (2.0.0)');
  assert.match(await pin.mergeBlocker(makeCtx({ head: 'chore/core-x' })), /is not chore\/core-<version>/);
});

test('pin: refuses an unverified commit by the bot', async () => {
  const github = fakeGithub({ commits: [commit('c'.repeat(40), AUTHOR, { verified: false }), commit(HEAD)] });
  const res = await pin.evaluate(makeCtx({ github }));
  assert.deepEqual(res, { ok: false, reason: 'commit cccccccc is not verified' });
});

test('pin: refuses a human commit on the bot branch', async () => {
  const github = fakeGithub({ commits: [commit('c'.repeat(40)), commit(HEAD, 'mallory', { committer: 'mallory' })] });
  const res = await pin.evaluate(makeCtx({ github }));
  assert.deepEqual(res, { ok: false, reason: `commit aaaaaaaa is not by ${AUTHOR}` });
});

test('pin: refuses a bot-authored commit committed by a person', async () => {
  const github = fakeGithub({ commits: [commit(HEAD, AUTHOR, { committer: 'mallory' })] });
  const res = await pin.evaluate(makeCtx({ github }));
  assert.deepEqual(res, { ok: false, reason: `commit aaaaaaaa is not by ${AUTHOR}` });
});

test('pin: refuses a commit list missing the head', async () => {
  const github = fakeGithub({ commits: [commit('c'.repeat(40))] });
  const res = await pin.evaluate(makeCtx({ github }));
  assert.deepEqual(res, { ok: false, reason: 'commit list does not include the evaluated head aaaaaaaa' });
});

test('pin: refuses 250 commits or more', async () => {
  const commits = Array.from({ length: 249 }, (_, i) => commit(String(i).padStart(40, '0')));
  commits.push(commit(HEAD));
  const res = await pin.evaluate(makeCtx({ github: fakeGithub({ commits }) }));
  assert.equal(res.ok, false);
  assert.match(res.reason, /250 commits or more/);
});

test('pin: only the bot\'s own open PRs supersede', async () => {
  const github = fakeGithub({ openPrs: [openPr(30, 'chore/core-9.0.0', 'mallory'), { number: 31, head: { ref: 'chore/core-9.0.0' } }] });
  assert.equal((await pin.evaluate(makeCtx({ github }))).ok, true);
  assert.equal(await pin.mergeBlocker(makeCtx({ github })), null);
  const byBot = fakeGithub({ openPrs: [openPr(32, 'chore/core-9.0.0')] });
  assert.deepEqual(await pin.evaluate(makeCtx({ github: byBot })), { ok: false, reason: 'superseded by #32 (9.0.0)' });
});
