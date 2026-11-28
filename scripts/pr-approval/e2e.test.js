// SPDX-License-Identifier: Apache-2.0
// Guards the e2e suite against silently covering less than the action does
// (E2E-001). Ported from strspc-pr-review's scripts/pr-auto-approve/e2e.test.js,
// which exists because inputs reached @v1 there without a scenario.
//
// Narrow on purpose, like docs.test.js: it proves that a scenario claims each
// input and each rule, or that an exemption says why none does. Whether a claim
// holds is what the suite itself checks against the sandbox.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const yaml = require('../../vendor/js-yaml/js-yaml.js');

const ROOT = path.join(__dirname, '..', '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

const manifest = JSON.parse(read('e2e/pr-approval/scenarios.json'));
const harness = read('e2e/pr-approval/run.sh');
const scenarios = manifest.scenarios;

// What expect() in run.sh knows how to assert.
const DECISIONS = new Set(['approved', 'merged', 'skip', 'dry-run']);
// Events the sandbox's caller runs on (a scenario's "event" filter).
const EVENTS = new Set(['pull_request_target', 'pull_request_review', 'check_run', 'workflow_run', 'workflow_dispatch']);

const inputs = new Set(Object.keys(yaml.load(read('action.yml')).inputs));
const rules = ['APPROVE', 'POLICY', 'MERGE'].flatMap((e) => JSON.parse(read(`rules/${e}.json`)).rules);
const claimedInputs = new Set(scenarios.flatMap((s) => s.inputs || []));
const citedRules = new Set(scenarios.flatMap((s) => s.rules || []));

test('every action.yml input has a scenario or a stated exemption', () => {
  const exempt = new Set(Object.keys(manifest.exemptions));
  const missing = [...inputs].filter((i) => !claimedInputs.has(i) && !exempt.has(i));
  assert.deepEqual(missing, [], `no scenario covers: ${missing.join(', ')}`);
});

test('every input a scenario or exemption names exists in action.yml', () => {
  const named = [...claimedInputs, ...Object.keys(manifest.exemptions)];
  assert.deepEqual(named.filter((i) => !inputs.has(i)), []);
});

test('an input with a scenario has no exemption left over', () => {
  const stale = Object.keys(manifest.exemptions).filter((i) => claimedInputs.has(i));
  assert.deepEqual(stale, [], `remove these exemptions: ${stale.join(', ')}`);
});

test('every APPROVE, POLICY and MERGE rule has a scenario or a stated exemption', () => {
  const exempt = new Set(Object.keys(manifest.rule_exemptions));
  const missing = rules.map((r) => r.id).filter((id) => !citedRules.has(id) && !exempt.has(id));
  assert.deepEqual(missing, [], `nothing proves: ${missing.join(', ')}`);
});

test('every rule a scenario or exemption names exists', () => {
  const ids = new Set(rules.map((r) => r.id));
  const named = [...citedRules, ...Object.keys(manifest.rule_exemptions)];
  assert.deepEqual(named.filter((id) => !ids.has(id)), []);
});

test('a rule with a scenario has no exemption left over', () => {
  const stale = Object.keys(manifest.rule_exemptions).filter((id) => citedRules.has(id));
  assert.deepEqual(stale, [], `remove these exemptions: ${stale.join(', ')}`);
});

// Implemented is what fail_on enforces, so it has to mean a scenario proves it.
test('a rule in state I is cited by a scenario', () => {
  const unproven = rules.filter((r) => r.state === 'I' && !citedRules.has(r.id)).map((r) => r.id);
  assert.deepEqual(unproven, [], `implemented without a scenario: ${unproven.join(', ')}`);
});

test('every exemption says why', () => {
  for (const [name, why] of Object.entries({ ...manifest.exemptions, ...manifest.rule_exemptions })) {
    assert.ok(typeof why === 'string' && why.trim().length > 20, `${name} needs a reason`);
  }
});

test('scenario names are unique', () => {
  const names = scenarios.map((s) => s.name);
  assert.equal(new Set(names).size, names.length);
});

test('every scenario has a function in run.sh', () => {
  for (const s of scenarios) {
    const fn = `sc_${s.name.replaceAll('-', '_')}() {`;
    assert.ok(harness.includes(fn), `missing ${fn}`);
  }
});

// E2E-002: the decision and its reason are what a scenario asserts, so a
// scenario without them would pass on a crash.
test('every scenario states a decision, a reason, and what it proves', () => {
  for (const s of scenarios) {
    assert.ok(DECISIONS.has(s.decision), `${s.name}: decision ${s.decision}`);
    assert.ok(typeof s.reason === 'string' && s.reason.startsWith('^') && s.reason.endsWith('$'),
      `${s.name}: reason must be an anchored regex`);
    assert.doesNotThrow(() => new RegExp(s.reason), `${s.name}: reason does not compile`);
    if (s.decision === 'approved' || s.decision === 'merged') {
      assert.ok(typeof s.review === 'string' && s.review.startsWith('^'), `${s.name}: an approval needs a review regex`);
      assert.doesNotThrow(() => new RegExp(s.review), `${s.name}: review does not compile`);
    }
    if ('event' in s) assert.ok(EVENTS.has(s.event), `${s.name}: unknown event ${s.event}`);
    assert.ok(typeof s.summary === 'string' && s.summary.length > 0, `${s.name}: summary`);
    assert.ok(Array.isArray(s.inputs) && Array.isArray(s.rules), `${s.name}: inputs and rules are lists`);
    assert.ok(s.inputs.length + s.rules.length > 0, `${s.name}: proves nothing`);
  }
});
