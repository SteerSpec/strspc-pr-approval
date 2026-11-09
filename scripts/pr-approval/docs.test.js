// SPDX-License-Identifier: Apache-2.0
// Guards docs/inputs.md against drifting from action.yml, and
// schema/pr-approval.v1.json against drifting from policy.js. Narrow on
// purpose: it checks that the lists match, not that the prose is true.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const policy = require('./policy.js');
const kinds = require('./kinds/index.js');

const ROOT = path.join(__dirname, '..', '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

function declared(section, next) {
  const src = read('action.yml');
  const start = src.indexOf(`\n${section}:`);
  const end = src.indexOf(`\n${next}:`);
  assert.ok(start !== -1 && end > start, `action.yml must have ${section}: then ${next}:`);
  return new Set([...src.slice(start, end).matchAll(/^ {2}([a-z0-9_-]+):$/gm)].map((m) => m[1]));
}

function documented(heading, next) {
  const src = read('docs/inputs.md');
  const start = src.indexOf(`\n## ${heading}\n`);
  const end = next === undefined ? src.length : src.indexOf(`\n## ${next}\n`);
  assert.ok(start !== -1 && end > start, `docs/inputs.md must have ## ${heading}`);
  return new Set([...src.slice(start, end).matchAll(/^\| `([a-z0-9_-]+)`/gm)].map((m) => m[1]));
}

const sorted = (s) => [...s].sort();

test('docs/inputs.md Inputs table matches action.yml inputs', () => {
  assert.deepEqual(sorted(documented('Inputs', 'Outputs')), sorted(declared('inputs', 'outputs')));
});

test('docs/inputs.md Outputs table matches action.yml outputs', () => {
  assert.deepEqual(sorted(documented('Outputs')), sorted(declared('outputs', 'runs')));
});

test('editor schema lists the same keys and kinds as policy.js', () => {
  const schema = JSON.parse(read('schema/pr-approval.v1.json'));
  const p = schema.$defs.policy;
  assert.deepEqual(sorted(Object.keys(schema.properties)), sorted(policy.FILE_KEYS));
  assert.deepEqual(sorted(Object.keys(p.properties)), sorted(policy.POLICY_KEYS));
  assert.deepEqual(sorted(Object.keys(p.properties.match.properties)), sorted(policy.MATCH_KEYS));
  assert.deepEqual(sorted(Object.keys(p.properties.require.properties)), sorted(policy.REQUIRE_KEYS));
  assert.deepEqual(sorted(p.properties.kind.enum), sorted(Object.keys(kinds)));
  assert.deepEqual(sorted(p.properties.merge.properties.method.enum), sorted(policy.MERGE_METHODS));
});

test('the shipped preset and this repository policy validate', () => {
  for (const f of ['presets/steerspec.yml', '.strspc/pr-approval.yml']) {
    const doc = policy.parseYaml(read(f), f);
    assert.deepEqual(policy.validatePolicyFile(doc, f, kinds), [], f);
  }
});

test('every rule ID the preset cites exists in rules/', () => {
  const doc = policy.parseYaml(read('presets/steerspec.yml'), 'preset');
  for (const p of doc.policies) {
    for (const id of p.rules) {
      const entity = id.replace(/-\d+$/, '');
      const rules = JSON.parse(read(`rules/${entity}.json`)).rules;
      assert.ok(rules.some((r) => r.id === id), `${p.id} cites ${id}, missing from rules/${entity}.json`);
    }
  }
});
