// SPDX-License-Identifier: Apache-2.0
const test = require('node:test');
const assert = require('node:assert/strict');
const custom = require('./custom.js');

const HEAD = 'a'.repeat(40);
const commit = (sha, login, { verified = true, committer = 'web-flow' } = {}) => ({
  sha,
  author: { login },
  committer: { login: committer },
  commit: { verification: { verified } },
});
const githubWith = (commits) => ({
  paginate: async () => commits,
  rest: { pulls: { listCommits: () => {} } },
});
const ctxWith = (policy, commits = [commit(HEAD, 'alice')]) => ({
  github: githubWith(commits), owner: 'o', repo: 'r', pr: { number: 1, head: { sha: HEAD } }, policy, options: {},
});
const match = { base: 'main', authors: ['alice', 'bob'] };

test('custom: interface', () => {
  assert.equal(custom.name, 'custom');
  assert.equal(custom.requiresTip, false);
  assert.deepEqual(custom.defaultMatch(), {});
});

test('custom: validateOptions accepts only an empty block', () => {
  assert.deepEqual(custom.validateOptions({}), []);
  assert.deepEqual(custom.validateOptions(), []);
  assert.equal(custom.validateOptions({ author: 'x', paths: ['a'] }).length, 2);
});

test('custom: refuses a policy without a bounding require (paths or max-files)', async () => {
  for (const require of [undefined, {}, null, { 'no-labels': ['wip'] }, { checks: ['ci'] }, { 'max-additions': 10 }]) {
    const res = await custom.evaluate(ctxWith({ id: 'c', match, require }));
    assert.equal(res.ok, false, JSON.stringify(require));
    assert.match(res.reason, /requires none of paths, max-files/);
  }
});

test('custom: approves when bounded and every commit is a verified commit by a matched author', async () => {
  const commits = [commit('b'.repeat(40), 'bob', { committer: 'bob' }), commit(HEAD, 'alice')];
  for (const require of [{ paths: ['docs/**'] }, { 'max-files': 1 }]) {
    const res = await custom.evaluate(ctxWith({ id: 'c', match, require }, commits));
    assert.deepEqual(res, { ok: true, summary: 'custom (policy conditions met)' });
  }
});

test('custom: refuses a commit by someone outside match.authors, or an unverified one', async () => {
  const require = { 'max-files': 3 };
  const stranger = await custom.evaluate(ctxWith({ id: 'c', match, require }, [commit('c'.repeat(40), 'mallory'), commit(HEAD, 'alice')]));
  assert.equal(stranger.ok, false);
  assert.match(stranger.reason, /commit cccccccc is not by alice or bob/);
  const unverified = await custom.evaluate(ctxWith({ id: 'c', match, require }, [commit(HEAD, 'alice', { verified: false })]));
  assert.match(unverified.reason, /is not verified/);
});

test('custom: refuses without match.authors', async () => {
  const res = await custom.evaluate(ctxWith({ id: 'c', match: { base: 'main' }, require: { 'max-files': 1 } }));
  assert.match(res.reason, /names no match.authors/);
});

test('custom: uses the same bounding keys as policy.js', () => {
  assert.deepEqual(custom.BOUNDING_KEYS, ['paths', 'max-files']);
});
