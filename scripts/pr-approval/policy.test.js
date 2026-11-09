// SPDX-License-Identifier: Apache-2.0
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const policy = require('./policy.js');

const { PolicyError } = policy;
const SHA = 'a'.repeat(40);

// Stub kinds, so these tests do not depend on the real kind modules.
const kinds = {
  release: {
    defaultMatch: (o) => ({ head: o['head-pattern'] || 'release-please--branches--*' }),
    validateOptions: (o) => (o.bad ? ['bad is not an option'] : []),
  },
  promotion: { defaultMatch: () => ({ base: 'main', head: 'dev' }), validateOptions: () => [] },
  custom: { validateOptions: () => [] },
};

const httpError = (status) => Object.assign(new Error(`HTTP ${status}`), { status });

// A fake client serving files by "owner/repo@ref/path". A value that is not a
// string is served as JSON (valid YAML too). `refs` lists existing
// "owner/repo:heads/x" or "owner/repo:tags/x".
function fakeRepo({ files = {}, refs = [] } = {}) {
  const calls = { getContent: [], getRef: [] };
  return {
    calls,
    rest: {
      repos: {
        getContent: async ({ owner, repo, path: p, ref }) => {
          const key = `${owner}/${repo}@${ref}/${p}`;
          calls.getContent.push(key);
          if (!(key in files)) throw httpError(404);
          const v = files[key];
          if (v && v.__data) return { data: v.__data };
          const text = typeof v === 'string' ? v : JSON.stringify(v);
          return { data: { type: 'file', size: text.length, encoding: 'base64', content: Buffer.from(text).toString('base64') } };
        },
      },
      git: {
        getRef: async ({ owner, repo, ref }) => {
          calls.getRef.push(`${owner}/${repo}:${ref}`);
          if (refs.includes(`${owner}/${repo}:${ref}`)) return { data: { ref } };
          throw httpError(404);
        },
      },
    },
  };
}

const ROOT = { owner: 'o', repo: 'r', ref: 'main', path: '.strspc/pr-approval.yml', remote: false };
const rootKey = (p = ROOT.path, ref = 'main') => `o/r@${ref}/${p}`;
const entity = (rules) => ({ entity: { id: 'X' }, rules });
const REALM_FILES = {
  'o/r@main/rules/APPROVE.json': entity([
    { id: 'APPROVE-005', state: 'D' },
    { id: 'APPROVE-006', state: 'D' },
    { id: 'APPROVE-099', state: 'R' },
    { id: 'APPROVE-098', state: 'T' },
  ]),
};
const pol = (id, extra = {}) => ({ id, kind: 'release', rules: ['APPROVE-006'], ...extra });
const file = (policies, extra = {}) => ({ version: 1, realm: '../rules', policies, ...extra });

// --- parseSource ------------------------------------------------------------

test('parseSource: github:// form', () => {
  assert.deepEqual(policy.parseSource('github://SteerSpec/strspc-rules@v1.2.3/presets/./a.yml'), {
    owner: 'SteerSpec', repo: 'strspc-rules', ref: 'v1.2.3', path: 'presets/a.yml', remote: true,
  });
});

test('parseSource: github:// path that escapes its repository is refused', () => {
  assert.throws(() => policy.parseSource('github://O/r@v1/../x.yml'), PolicyError);
});

test('parseSource: other URL schemes are refused', () => {
  assert.throws(() => policy.parseSource('https://example.com/x.yml'), /is not github:\/\//);
});

test('parseSource: relative paths resolve against the naming file, same repo and ref', () => {
  const from = { owner: 'O', repo: 'r', ref: 'v1', path: 'presets/base.yml', remote: true, refChecked: true };
  assert.deepEqual(policy.parseSource('./more/x.yml', from), {
    owner: 'O', repo: 'r', ref: 'v1', path: 'presets/more/x.yml', remote: true, refChecked: true,
  });
  assert.equal(policy.parseSource('../rules', { ...ROOT }).path, 'rules');
});

test('parseSource: a relative path needs a file to resolve against, and may not escape', () => {
  assert.throws(() => policy.parseSource('x.yml'), /nothing to resolve against/);
  assert.throws(() => policy.parseSource('../../x.yml', ROOT), /escapes its repository/);
});

// --- validatePolicyFile (POLICY-004) ----------------------------------------

const errorsOf = (doc) => policy.validatePolicyFile(doc, 'f', kinds);
const expectError = (doc, re) => {
  const errs = errorsOf(doc);
  assert.ok(errs.some((e) => re.test(e)), `expected ${re} in ${JSON.stringify(errs)}`);
};

test('POLICY-004: a valid file has no errors', () => {
  assert.deepEqual(errorsOf(file([pol('a', {
    description: 'x',
    match: { base: 'main', head: ['a', 'b'], authors: ['bot'], title: '^chore', labels: ['l'] },
    require: { checks: ['c'], paths: ['p'], 'forbid-paths': ['f'], 'max-files': 0, 'max-additions': 1, 'max-deletions': 2, 'no-labels': ['n'] },
    options: {},
    approve: true,
    merge: { enabled: true, method: 'squash' },
  })], { extends: ['./x.yml'] })), []);
  assert.deepEqual(errorsOf({ version: 1 }), []);
});

test('POLICY-004: file-level errors', () => {
  assert.deepEqual(errorsOf([]), ['f: must be a mapping']);
  assert.deepEqual(errorsOf(null), ['f: must be a mapping']);
  expectError({ version: 1, nope: 1 }, /unknown key 'nope'/);
  expectError({ version: 2 }, /version: must be 1/);
  expectError({ version: 1, realm: 3 }, /realm: must be a source string/);
  expectError({ version: 1, extends: 'x' }, /extends: must be a list/);
  expectError({ version: 1, extends: ['1', '2', '3', '4', '5', '6'] }, /at most 5/);
  expectError({ version: 1, policies: {} }, /policies: must be a list/);
});

test('POLICY-005: realm is required when the file declares policies', () => {
  expectError({ version: 1, policies: [pol('a')] }, /realm: required/);
});

test('POLICY-004: policy-level errors', () => {
  expectError(file(['x']), /policies\[0\]: must be a mapping/);
  expectError(file([pol('a', { extra: 1 })]), /unknown key 'extra'/);
  expectError(file([pol('Bad_ID')]), /\.id: must match/);
  expectError(file([pol('a'), pol('a')]), /'a' is declared twice/);
  expectError(file([pol('a', { kind: 'nope' })]), /\.kind: must be one of release, promotion, custom/);
  expectError(file([pol('a', { description: 1 })]), /description: must be a string/);
  expectError(file([pol('a', { approve: 'yes' })]), /approve: must be true or false/);
  expectError(file([pol('a', { options: [] })]), /options: must be a mapping/);
  expectError(file([pol('a', { options: { bad: 1 } })]), /options: bad is not an option/);
});

test('POLICY-005: each policy cites at least one well-formed rule ID', () => {
  expectError(file([pol('a', { rules: undefined })]), /must cite at least one realm rule ID/);
  expectError(file([pol('a', { rules: [] })]), /must cite at least one realm rule ID/);
  expectError(file([pol('a', { rules: ['nope'] })]), /'nope' is not a rule ID/);
  // v1 resolves IDs in the file's own realm only, so a realm prefix is refused
  // rather than looked up in the wrong realm.
  expectError(file([pol('a', { rules: ['dev.steerspec.core:CORE-001'] })]), /names realm dev\.steerspec\.core/);
  assert.deepEqual(errorsOf(file([pol('a', { rules: ['CORE-001'] })])), []);
});

test('POLICY-004: match errors', () => {
  expectError(file([pol('a', { match: [] })]), /match: must be a mapping/);
  expectError(file([pol('a', { match: { who: 1 } })]), /match: unknown key 'who'/);
  expectError(file([pol('a', { match: { base: 1 } })]), /match\.base: must be a glob/);
  expectError(file([pol('a', { match: { head: [] } })]), /match\.head: must be a glob/);
  expectError(file([pol('a', { match: { authors: 'bot' } })]), /match\.authors: must be a list/);
  expectError(file([pol('a', { match: { labels: [''] } })]), /match\.labels: must be a list/);
  expectError(file([pol('a', { match: { title: 'x'.repeat(201) } })]), /match\.title: must be a regular expression/);
  expectError(file([pol('a', { match: { title: 5 } })]), /match\.title: must be a regular expression/);
  expectError(file([pol('a', { match: { title: '(' } })]), /match\.title: Invalid regular expression/);
});

test('POLICY-004: kind custom needs match.base and match.authors', () => {
  const req = { paths: ['docs/**'] };
  expectError(file([pol('a', { kind: 'custom', require: req })]), /kind custom needs match\.base and match\.authors/);
  expectError(file([pol('a', { kind: 'custom', require: req, match: { base: 'main' } })]), /kind custom needs match/);
  assert.deepEqual(errorsOf(file([pol('a', { kind: 'custom', require: req, match: { base: 'main', authors: ['bot'] } })])), []);
});

test('APPROVE-010: kind custom needs a require bound on paths or max-files', () => {
  const match = { base: 'main', authors: ['bot'] };
  expectError(file([pol('a', { kind: 'custom', match })]), /require: kind custom needs paths or max-files/);
  expectError(file([pol('a', { kind: 'custom', match, require: { 'no-labels': ['hold'] } })]), /kind custom needs paths or max-files/);
  // A check name proves nothing: a PR that can add a workflow can post any check.
  expectError(file([pol('a', { kind: 'custom', match, require: { checks: ['c'] } })]), /kind custom needs paths or max-files/);
  for (const require of [{ paths: ['a'] }, { 'max-files': 1 }]) {
    assert.deepEqual(errorsOf(file([pol('a', { kind: 'custom', match, require })])), [], JSON.stringify(require));
  }
});

test('POLICY-004: require errors', () => {
  expectError(file([pol('a', { require: 1 })]), /require: must be a mapping/);
  expectError(file([pol('a', { require: { x: 1 } })]), /require: unknown key 'x'/);
  expectError(file([pol('a', { require: { checks: 'c' } })]), /require\.checks: must be a non-empty list/);
  // An empty list would bound nothing while looking like a bound.
  expectError(file([pol('a', { require: { paths: [] } })]), /require\.paths: must be a non-empty list/);
  expectError(file([pol('a', { require: { 'max-files': -1 } })]), /max-files: must be a non-negative integer/);
  expectError(file([pol('a', { require: { 'max-additions': 1.5 } })]), /max-additions: must be a non-negative integer/);
});

test('MERGE-001: merge block errors', () => {
  expectError(file([pol('a', { merge: true })]), /merge: must be a mapping/);
  expectError(file([pol('a', { merge: { auto: 1 } })]), /merge: unknown key 'auto'/);
  expectError(file([pol('a', { merge: { enabled: 'yes' } })]), /merge\.enabled: must be true or false/);
  expectError(file([pol('a', { merge: { method: 'ff' } })]), /merge\.method: must be one of merge, squash, rebase/);
});

test('POLICY-004: the validator and schema/pr-approval.v1.json agree on the keys', () => {
  const schema = JSON.parse(fs.readFileSync(path.join(__dirname, '../../schema/pr-approval.v1.json'), 'utf8'));
  const keys = (o) => Object.keys(o.properties).sort();
  const p = schema.$defs.policy;
  assert.deepEqual(keys(schema), [...policy.FILE_KEYS].sort());
  assert.deepEqual(keys(p), [...policy.POLICY_KEYS].sort());
  assert.deepEqual(keys(p.properties.match), [...policy.MATCH_KEYS].sort());
  assert.deepEqual(keys(p.properties.require), [...policy.REQUIRE_KEYS].sort());
  assert.deepEqual(keys(p.properties.merge), ['enabled', 'method']);
  assert.deepEqual(p.properties.merge.properties.method.enum, policy.MERGE_METHODS);
});

// --- assertImmutableRef (POLICY-002) ----------------------------------------

test('POLICY-002: a full commit SHA is accepted without a lookup', async () => {
  const gh = fakeRepo();
  await policy.assertImmutableRef({ github: gh, owner: 'O', repo: 'r', ref: SHA });
  assert.deepEqual(gh.calls.getRef, []);
});

test('POLICY-002: a branch is refused', async () => {
  const gh = fakeRepo({ refs: ['O/r:heads/main', 'O/r:tags/main'] });
  await assert.rejects(policy.assertImmutableRef({ github: gh, owner: 'O', repo: 'r', ref: 'main' }), /names a branch/);
});

test('POLICY-002: a tag is accepted', async () => {
  const gh = fakeRepo({ refs: ['O/r:tags/v1'] });
  await policy.assertImmutableRef({ github: gh, owner: 'O', repo: 'r', ref: 'v1' });
  assert.deepEqual(gh.calls.getRef, ['O/r:heads/v1', 'O/r:tags/v1']);
});

test('POLICY-002: a ref that is neither tag nor SHA is refused', async () => {
  await assert.rejects(policy.assertImmutableRef({ github: fakeRepo(), owner: 'O', repo: 'r', ref: 'abc123' }),
    /neither a tag nor a full commit SHA/);
});

test('POLICY-002: an unexpected API error while checking the ref propagates', async () => {
  const gh = { rest: { git: { getRef: async () => { throw httpError(500); } } } };
  await assert.rejects(policy.assertImmutableRef({ github: gh, owner: 'O', repo: 'r', ref: 'v1' }), { status: 500 });
});

// --- loadPolicy ----------------------------------------------------------------

test('POLICY-001: loadPolicy reads the root at the ref it is given and returns null when absent', async () => {
  const gh = fakeRepo();
  assert.equal(await policy.loadPolicy({ github: gh, root: ROOT, kinds }), null);
  assert.deepEqual(gh.calls.getContent, [rootKey()]);
});

test('POLICY-001: loadPolicy reads the root file and realm at the base ref', async () => {
  const gh = fakeRepo({
    files: { [rootKey()]: file([pol('a')]), ...REALM_FILES, [rootKey(ROOT.path, 'feature')]: file([pol('evil')]) },
  });
  const loaded = await policy.loadPolicy({ github: gh, root: ROOT, kinds });
  assert.deepEqual(loaded.policies.map((p) => p.id), ['a']);
  assert.deepEqual(loaded.files, [rootKey()]);
  assert.ok(gh.calls.getContent.every((k) => k.startsWith('o/r@main/')), gh.calls.getContent.join(','));
  const [p] = loaded.policies;
  assert.equal(p.source, rootKey());
  assert.equal(p.realm, 'o/r@main/rules');
  assert.ok(!('_realm' in p));
});

test('POLICY-006: extends are merged after the root, in order; a root id overrides an inherited one', async () => {
  const presets = 'Org/presets@v1';
  const gh = fakeRepo({
    refs: ['Org/presets:tags/v1'],
    files: {
      [rootKey()]: file([pol('a'), pol('b')], { extends: ['github://Org/presets@v1/p/base.yml', './local.yml'] }),
      [`${presets}/p/base.yml`]: file([pol('b', { description: 'preset b' }), pol('c', { description: 'preset c' })], { extends: ['./more.yml'] }),
      [`${presets}/p/more.yml`]: file([pol('e', { description: 'more e' })]),
      [`${presets}/rules/APPROVE.json`]: entity([{ id: 'APPROVE-006', state: 'D' }]),
      [rootKey('.strspc/local.yml')]: file([pol('d'), pol('c', { description: 'local c' })]),
      ...REALM_FILES,
    },
  });
  const loaded = await policy.loadPolicy({ github: gh, root: ROOT, kinds });
  assert.deepEqual(loaded.policies.map((p) => `${p.id}:${p.description || ''}`),
    ['a:', 'b:', 'c:preset c', 'e:more e', 'd:']);
  assert.equal(loaded.policies.find((p) => p.id === 'c').source, 'org/presets@v1/p/base.yml');
  assert.equal(loaded.policies.find((p) => p.id === 'c').realm, 'org/presets@v1/rules');
  assert.equal(loaded.files.length, 4);
  // The tag was checked once; the relative extends inside the preset reuse it.
  assert.deepEqual(gh.calls.getRef, ['Org/presets:heads/v1', 'Org/presets:tags/v1']);
});

test('POLICY-002: extends naming a branch is refused', async () => {
  const gh = fakeRepo({
    refs: ['Org/presets:heads/main'],
    files: { [rootKey()]: { version: 1, extends: ['github://Org/presets@main/p.yml'] } },
  });
  await assert.rejects(policy.loadPolicy({ github: gh, root: ROOT, kinds }), /names a branch/);
});

test('POLICY-002: remote files are read through policyGithub, the root through github', async () => {
  const gh = fakeRepo({ files: { [rootKey()]: { version: 1, extends: [`github://Org/presets@${SHA}/p.yml`] } } });
  const policyGh = fakeRepo({ files: { [`Org/presets@${SHA}/p.yml`]: { version: 1 } } });
  const loaded = await policy.loadPolicy({ github: gh, policyGithub: policyGh, root: ROOT, kinds });
  assert.deepEqual(loaded.policies, []);
  assert.deepEqual(gh.calls.getContent, [rootKey()]);
  assert.deepEqual(policyGh.calls.getContent, [`Org/presets@${SHA}/p.yml`]);
});

test('POLICY-003: an extends cycle is refused', async () => {
  const gh = fakeRepo({
    files: {
      [rootKey()]: { version: 1, extends: ['./a.yml'] },
      [rootKey('.strspc/a.yml')]: { version: 1, extends: ['./pr-approval.yml'] },
    },
  });
  await assert.rejects(policy.loadPolicy({ github: gh, root: ROOT, kinds }), /extends cycle/);
});

test('POLICY-003: extends deeper than the limit is refused; the limit itself is allowed', async () => {
  const chain = (n) => {
    const files = {};
    for (let i = 0; i <= n; i++) {
      const p = i === 0 ? ROOT.path : `.strspc/d${i}.yml`;
      files[rootKey(p)] = i < n ? { version: 1, extends: [`./d${i + 1}.yml`] } : { version: 1 };
    }
    return files;
  };
  const ok = await policy.loadPolicy({ github: fakeRepo({ files: chain(policy.MAX_EXTENDS_DEPTH) }), root: ROOT, kinds });
  assert.equal(ok.files.length, policy.MAX_EXTENDS_DEPTH + 1);
  await assert.rejects(
    policy.loadPolicy({ github: fakeRepo({ files: chain(policy.MAX_EXTENDS_DEPTH + 1) }), root: ROOT, kinds }),
    /extends deeper than 3/,
  );
});

test('POLICY-004: a missing extended file, invalid YAML, an invalid file, a directory or an oversized file is refused', async () => {
  const run = (files) => policy.loadPolicy({ github: fakeRepo({ files }), root: ROOT, kinds });
  await assert.rejects(run({ [rootKey()]: { version: 1, extends: ['./gone.yml'] } }), /extended policy .* not found/);
  await assert.rejects(run({ [rootKey()]: 'version: [1' }), /is not valid YAML/);
  await assert.rejects(run({ [rootKey()]: 'version: 1\nwhen: 2026-01-01\nx: !!js/function "f"' }), PolicyError);
  await assert.rejects(run({ [rootKey()]: { version: 2 } }), /invalid policy: .*version: must be 1/);
  await assert.rejects(run({ [rootKey()]: { __data: [] } }), /is not a file/);
  await assert.rejects(run({ [rootKey()]: { __data: { type: 'file', size: 64 * 1024 + 1, content: '' } } }), /larger than/);
});

test('POLICY-004: a non-404 error reading the root propagates', async () => {
  const gh = { rest: { repos: { getContent: async () => { throw httpError(502); } } } };
  await assert.rejects(policy.loadPolicy({ github: gh, root: ROOT, kinds }), { status: 502 });
});

test('POLICY-005: a citation of a missing entity is refused', async () => {
  const gh = fakeRepo({ files: { [rootKey()]: file([pol('a', { rules: ['MERGE-001'] })]), ...REALM_FILES } });
  await assert.rejects(policy.loadPolicy({ github: gh, root: ROOT, kinds }),
    /policy 'a' .* cites MERGE-001: entity MERGE not found at o\/r@main\/rules\/merge.json/i);
});

test('POLICY-005: a citation of a missing rule is refused', async () => {
  const gh = fakeRepo({ files: { [rootKey()]: file([pol('a', { rules: ['APPROVE-042'] })]), ...REALM_FILES } });
  await assert.rejects(policy.loadPolicy({ github: gh, root: ROOT, kinds }), /rule APPROVE-042 not found/);
});

test('POLICY-005: a citation of a retired or terminated rule is refused', async () => {
  const gh = fakeRepo({ files: { [rootKey()]: file([pol('a', { rules: ['APPROVE-099'] })]), ...REALM_FILES } });
  await assert.rejects(policy.loadPolicy({ github: gh, root: ROOT, kinds }), /APPROVE-099 is retired/);
});

test('POLICY-005: an entity file that is not JSON is refused', async () => {
  const gh = fakeRepo({ files: { [rootKey()]: file([pol('a')]), 'o/r@main/rules/APPROVE.json': '{nope' } });
  await assert.rejects(policy.loadPolicy({ github: gh, root: ROOT, kinds }), /is not valid JSON/);
});

test('POLICY-005: each entity file is read once; checkRules:false skips the realm', async () => {
  const gh = fakeRepo({
    files: { [rootKey()]: file([pol('a', { rules: ['APPROVE-005', 'APPROVE-006'] }), pol('b')]), ...REALM_FILES },
  });
  await policy.loadPolicy({ github: gh, root: ROOT, kinds });
  assert.equal(gh.calls.getContent.filter((k) => k.endsWith('APPROVE.json')).length, 1);

  const bare = fakeRepo({ files: { [rootKey()]: file([pol('a', { rules: ['NOPE-001'] })]) } });
  const loaded = await policy.loadPolicy({ github: bare, root: ROOT, kinds, checkRules: false });
  assert.deepEqual(loaded.policies.map((p) => p.id), ['a']);
  assert.deepEqual(bare.calls.getContent, [rootKey()]);
});

test('POLICY-002: a remote realm pinned to a tag is checked and accepted', async () => {
  const gh = fakeRepo({
    refs: ['SteerSpec/strspc-rules:tags/v1.24.0'],
    files: {
      [rootKey()]: file([pol('a', { rules: ['CORE-001'] })], { realm: 'github://SteerSpec/strspc-rules@v1.24.0/rules/core' }),
      'SteerSpec/strspc-rules@v1.24.0/rules/core/CORE.json': entity([{ id: 'CORE-001', state: 'D' }]),
    },
  });
  const loaded = await policy.loadPolicy({ github: gh, root: ROOT, kinds });
  assert.equal(loaded.policies[0].realm, 'steerspec/strspc-rules@v1.24.0/rules/core');
  assert.deepEqual(gh.calls.getRef, ['SteerSpec/strspc-rules:heads/v1.24.0', 'SteerSpec/strspc-rules:tags/v1.24.0']);
});

test('POLICY-002: a remote realm on a branch of the same name as the base is still refused', async () => {
  // The root is read at `main`; a realm in another repository at `main` is a
  // moving target even though the ref names coincide.
  const gh = fakeRepo({
    refs: ['Other/rules:heads/main'],
    files: {
      [rootKey()]: file([pol('a', { rules: ['CORE-001'] })], { realm: 'github://Other/rules@main/rules' }),
      'Other/rules@main/rules/CORE.json': entity([{ id: 'CORE-001', state: 'D' }]),
    },
  });
  await assert.rejects(policy.loadPolicy({ github: gh, root: ROOT, kinds }), /names a branch/);
});

// --- matching (POLICY-006) ---------------------------------------------------

const pr = (o = {}) => ({
  base: { ref: 'main' }, head: { ref: 'dev' }, user: { login: 'bot' }, title: 'chore: promote', labels: [], ...o,
});

test('effectiveMatch fills keys from the kind defaults; the policy overrides them', () => {
  assert.deepEqual(policy.effectiveMatch({ kind: 'promotion' }, kinds), { base: 'main', head: 'dev' });
  assert.deepEqual(policy.effectiveMatch({ kind: 'promotion', match: { head: 'staging' } }, kinds), { base: 'main', head: 'staging' });
  assert.deepEqual(policy.effectiveMatch({ kind: 'release', options: { 'head-pattern': 'rel/*' } }, kinds), { head: 'rel/*' });
  assert.deepEqual(policy.effectiveMatch({ kind: 'custom', match: { base: 'x' } }, kinds), { base: 'x' });
  assert.deepEqual(policy.effectiveMatch({ kind: 'unknown' }, kinds), {});
});

test('matchMiss names each failing condition', () => {
  assert.equal(policy.matchMiss(pr(), {}), null);
  assert.match(policy.matchMiss(pr(), { base: ['release/*'] }), /base main not in \[release\/\*\]/);
  assert.match(policy.matchMiss(pr(), { head: 'feat/*' }), /head dev not in/);
  assert.match(policy.matchMiss(pr(), { authors: ['someone'] }), /author bot not in \[someone\]/);
  assert.equal(policy.matchMiss(pr(), { title: '^fix' }), 'title does not match');
  assert.match(policy.matchMiss(pr(), { labels: ['a', 'b'] }), /missing label\(s\) a, b/);
  assert.equal(policy.matchMiss(pr({ labels: [{ name: 'a' }, 'b'] }), { labels: ['a', 'b'] }), null);
  assert.equal(policy.matchMiss({}, {}), null);
});

test('POLICY-006: matchPolicy returns the first matching policy in order, or null', () => {
  const list = [
    { id: 'rel', kind: 'release' },
    { id: 'promo-a', kind: 'promotion', match: { authors: ['other'] } },
    { id: 'promo-b', kind: 'promotion' },
    { id: 'promo-c', kind: 'promotion' },
  ];
  assert.equal(policy.matchPolicy(list, pr(), kinds).id, 'promo-b');
  assert.equal(policy.matchPolicy(list, pr({ base: { ref: 'dev' } }), kinds), null);
  assert.equal(policy.matchPolicy(list, pr({ head: { ref: 'release-please--branches--main' } }), kinds).id, 'rel');
});

test('mergeById keeps own policies first and drops inherited duplicates', () => {
  const r = policy.mergeById([{ id: 'a' }], [{ id: 'a', x: 1 }, { id: 'b' }, { id: 'b', x: 2 }]);
  assert.deepEqual(r, [{ id: 'a' }, { id: 'b' }]);
});

// --- requireBlocker (APPROVE-010) ---------------------------------------------

const rb = (req, o = {}) => policy.requireBlocker({ pr: pr(o.pr), require: req, files: o.files, checkRuns: o.checkRuns });

test('APPROVE-010: require.no-labels', () => {
  assert.equal(rb({ 'no-labels': ['hold'] }, { pr: { labels: [{ name: 'hold' }] } }), "carries label 'hold'");
  assert.equal(rb({ 'no-labels': ['hold'] }, { pr: { labels: ['ok'] } }), null);
});

test('APPROVE-010: require.checks', () => {
  assert.equal(rb({ checks: ['e2e'] }, { checkRuns: [] }), "required check 'e2e' has not run on the head");
  assert.equal(rb({ checks: ['e2e'] }, { checkRuns: [{ name: 'e2e', status: 'queued' }] }), "required check 'e2e' is still running");
  assert.equal(rb({ checks: ['e2e'] }, { checkRuns: [{ name: 'e2e', status: 'completed', conclusion: 'skipped' }] }),
    "required check 'e2e' concluded skipped");
  assert.equal(rb({ checks: ['e2e'] }, { checkRuns: [{ name: 'e2e', status: 'completed', conclusion: 'success' }] }), null);
});

test('APPROVE-010: file conditions need a complete listing', () => {
  assert.equal(rb({}), null);
  assert.equal(policy.requireBlocker({ pr: pr() }), null);
  assert.equal(rb({ paths: ['**'] }, { files: null }), 'changed files cannot be completely listed');
});

test('APPROVE-010: require.max-files, max-additions, max-deletions', () => {
  const files = [{ filename: 'a', additions: 3, deletions: 1 }, { filename: 'b', additions: 2 }];
  assert.equal(rb({ 'max-files': 1 }, { files }), 'changes 2 files, more than 1');
  assert.equal(rb({ 'max-additions': 4 }, { files }), 'adds 5 lines, more than 4');
  assert.equal(rb({ 'max-deletions': 0 }, { files }), 'deletes 1 lines, more than 0');
  assert.equal(rb({ 'max-files': 2, 'max-additions': 5, 'max-deletions': 1 }, { files }), null);
});

test('APPROVE-010: require.paths and forbid-paths, including the old name of a rename', () => {
  const files = [{ filename: 'docs/a.md' }, { filename: 'docs/b.md', previous_filename: 'src/b.md' }];
  assert.equal(rb({ paths: ['docs/**'] }, { files }), 'changes src/b.md, outside the allowed paths');
  assert.equal(rb({ paths: ['docs/**', 'src/**'] }, { files }), null);
  assert.equal(rb({ 'forbid-paths': ['src/**'] }, { files }), 'changes src/b.md, a forbidden path');
  assert.equal(rb({ 'forbid-paths': ['.github/**'] }, { files }), null);
});
