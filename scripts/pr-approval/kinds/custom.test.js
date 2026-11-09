// SPDX-License-Identifier: Apache-2.0
const test = require('node:test');
const assert = require('node:assert/strict');
const custom = require('./custom.js');

const ctxWith = (policy) => ({ github: {}, owner: 'o', repo: 'r', pr: { number: 1 }, policy, options: {} });

test('custom: interface', () => {
  assert.equal(custom.name, 'custom');
  assert.equal(custom.requiresTip, false);
});

test('custom: defaultMatch is empty', () => {
  assert.deepEqual(custom.defaultMatch({}), {});
  assert.deepEqual(custom.defaultMatch(), {});
  assert.deepEqual(custom.defaultMatch({ author: 'x' }), {});
});

test('custom: validateOptions accepts only an empty block', () => {
  assert.deepEqual(custom.validateOptions({}), []);
  assert.deepEqual(custom.validateOptions(), []);
  const errors = custom.validateOptions({ author: 'x', paths: ['a'] });
  assert.equal(errors.length, 2);
  assert.match(errors[0], /unknown key 'author'/);
  assert.match(errors[1], /unknown key 'paths'/);
});

test('custom: refuses a policy without require conditions', async () => {
  for (const policy of [{ id: 'c' }, { id: 'c', require: {} }, { id: 'c', require: null }, undefined]) {
    const res = await custom.evaluate(ctxWith(policy));
    assert.equal(res.ok, false);
    assert.match(res.reason, /requires none of paths, max-files, checks/);
  }
});

test('custom: approves when the policy adds a condition', async () => {
  for (const require of [{ paths: ['docs/**'] }, { 'max-files': 1 }, { checks: ['ci'] }]) {
    const res = await custom.evaluate(ctxWith({ id: 'c', require }));
    assert.deepEqual(res, { ok: true, summary: 'custom (policy conditions met)' });
  }
});

test('custom: refuses a require that does not bound the change', async () => {
  // Same keys as policy.js: a label condition alone restricts nothing.
  for (const require of [{ 'no-labels': ['wip'] }, { 'forbid-paths': ['src/**'] }, { 'max-additions': 10 }]) {
    const res = await custom.evaluate(ctxWith({ id: 'c', require }));
    assert.equal(res.ok, false, JSON.stringify(require));
    assert.match(res.reason, /requires none of paths, max-files, checks/);
  }
  const mixed = await custom.evaluate(ctxWith({ id: 'c', require: { 'no-labels': ['wip'], 'max-files': 2 } }));
  assert.equal(mixed.ok, true);
});

test('custom: uses the same bounding keys as policy.js', () => {
  assert.deepEqual(custom.BOUNDING_KEYS, ['paths', 'max-files', 'checks']);
});
