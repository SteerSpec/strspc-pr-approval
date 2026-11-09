// SPDX-License-Identifier: Apache-2.0
const test = require('node:test');
const assert = require('node:assert/strict');
const syncBack = require('./sync-back.js');
const { compareHead } = require('../util.js');

const AUTHOR = 'steerspec-sync[bot]';
const HEAD = 'a'.repeat(40);
const ALLOWED = new Set(['CHANGELOG.md', '.release-please-manifest.json', 'package.json']);

// A stand-in for release.js, so these tests don't depend on it.
function fakeRelease({ ok = true, reason = 'no config' } = {}) {
  const calls = [];
  return {
    calls,
    readReleaseConfig: async (args) => {
      calls.push(args);
      return ok ? { ok: true, config: { packages: { '.': { 'release-type': 'node' } } } } : { ok: false, reason };
    },
    allowedReleaseFiles: () => ALLOWED,
  };
}

function fakeGithub({ commits, files, onRelease = {} } = {}) {
  const contentCalls = [];
  const github = {
    contentCalls,
    rest: {
      pulls: {
        listCommits: async () => ({ data: commits }),
      },
      repos: {
        compareCommitsWithBasehead: async () => ({ data: { files, merge_base_commit: { sha: 'm'.repeat(40) } } }),
        getContent: async ({ path, ref }) => {
          contentCalls.push({ path, ref });
          const entry = onRelease[path];
          if (entry === undefined) {
            const err = new Error('Not Found');
            err.status = 404;
            throw err;
          }
          if (entry instanceof Error) throw entry;
          return { data: entry };
        },
      },
    },
    paginate: async (fn, params) => (await fn(params)).data,
  };
  return github;
}

const commit = (sha, login = AUTHOR, { verified = true, committer = 'web-flow' } = {}) => ({
  sha,
  author: login ? { login } : null,
  committer: committer ? { login: committer } : null,
  commit: { verification: { verified } },
});
const file = (filename, sha, extra = {}) => ({ filename, sha, status: 'modified', additions: 1, deletions: 1, ...extra });
const blob = (sha) => ({ type: 'file', sha });

function makeCtx({ github, options = { author: AUTHOR }, user = AUTHOR, base = 'develop', head = 'chore/sync-release-files' } = {}) {
  const pr = { number: 7, user: { login: user }, head: { ref: head, sha: HEAD }, base: { ref: base } };
  return {
    github, owner: 'o', repo: 'r', pr, options, policy: { id: 'sync', kind: 'sync-back', options },
    compare: () => compareHead({ github, owner: 'o', repo: 'r', baseRef: base, headSha: HEAD }),
  };
}

const happyGithub = (over = {}) => fakeGithub({
  commits: [commit('b'.repeat(40)), commit(HEAD)],
  files: [file('CHANGELOG.md', 's1'), file('.release-please-manifest.json', 's2'), file('package.json', 's3')],
  onRelease: { 'CHANGELOG.md': blob('s1'), '.release-please-manifest.json': blob('s2'), 'package.json': blob('s3') },
  ...over,
});

test('sync-back: interface', () => {
  assert.equal(syncBack.name, 'sync-back');
  assert.equal(syncBack.requiresTip, false);
});

test('sync-back: defaultMatch', () => {
  assert.deepEqual(syncBack.defaultMatch({ author: AUTHOR }), {
    head: ['chore/sync-release-*'], base: 'develop', authors: [AUTHOR],
  });
  assert.deepEqual(syncBack.defaultMatch({}), { head: ['chore/sync-release-*'], base: 'develop' });
  assert.deepEqual(syncBack.defaultMatch(), { head: ['chore/sync-release-*'], base: 'develop' });
});

test('sync-back: validateOptions', () => {
  assert.deepEqual(syncBack.validateOptions({ author: AUTHOR }), []);
  assert.deepEqual(syncBack.validateOptions({ author: AUTHOR, 'release-branch': 'release' }), []);
  assert.match(syncBack.validateOptions({}).join(), /author is required/);
  assert.match(syncBack.validateOptions({ author: '' }).join(), /author must be a non-empty string/);
  assert.match(syncBack.validateOptions({ author: 3 }).join(), /author must be/);
  assert.match(syncBack.validateOptions({ author: AUTHOR, 'release-branch': 5 }).join(), /release-branch/);
  assert.match(syncBack.validateOptions({ author: AUTHOR, 'release-branch': 'ma*' }).join(), /release-branch/);
  assert.match(syncBack.validateOptions({ author: AUTHOR, paths: ['x'] }).join(), /unknown key 'paths'/);
});

test('sync-back: approves release files identical to main', async () => {
  const github = happyGithub();
  const rel = fakeRelease();
  const res = await syncBack.evaluate(makeCtx({ github }), rel);
  assert.deepEqual(res, { ok: true, summary: 'sync-back (3 release file(s) identical to main)' });
  assert.deepEqual(rel.calls[0], { github, owner: 'o', repo: 'r', base: 'main' });
  assert.ok(github.contentCalls.every((c) => c.ref === 'refs/heads/main'));
  assert.equal(github.contentCalls.length, 3);
});

test('sync-back: release-branch option is used for config and content', async () => {
  const github = happyGithub();
  const rel = fakeRelease();
  const res = await syncBack.evaluate(makeCtx({ github, options: { author: AUTHOR, 'release-branch': 'stable' } }), rel);
  assert.equal(res.ok, true);
  assert.equal(res.summary, 'sync-back (3 release file(s) identical to stable)');
  assert.equal(rel.calls[0].base, 'stable');
  assert.ok(github.contentCalls.every((c) => c.ref === 'refs/heads/stable'));
});

test('sync-back: refuses without options.author', async () => {
  const res = await syncBack.evaluate(makeCtx({ github: happyGithub(), options: {}, user: undefined }), fakeRelease());
  assert.equal(res.ok, false);
  assert.match(res.reason, /options.author is not set/);
});

test('sync-back: refuses another PR author', async () => {
  const res = await syncBack.evaluate(makeCtx({ github: happyGithub(), user: 'mallory' }), fakeRelease());
  assert.equal(res.ok, false);
  assert.match(res.reason, /author mallory is not steerspec-sync\[bot\]/);
});

test('sync-back: refuses a PR into the release branch itself', async () => {
  const res = await syncBack.evaluate(makeCtx({ github: happyGithub(), base: 'main' }), fakeRelease());
  assert.equal(res.ok, false);
  assert.match(res.reason, /release branch main itself/);
});

test('sync-back: refuses a commit by someone else', async () => {
  const github = happyGithub({ commits: [commit('c'.repeat(40), 'mallory'), commit(HEAD)] });
  const res = await syncBack.evaluate(makeCtx({ github }), fakeRelease());
  assert.deepEqual(res, { ok: false, reason: `commit cccccccc is not by ${AUTHOR}` });
});

test('sync-back: refuses an unverified commit by the bot', async () => {
  const github = happyGithub({ commits: [commit('c'.repeat(40), AUTHOR, { verified: false }), commit(HEAD)] });
  const res = await syncBack.evaluate(makeCtx({ github }), fakeRelease());
  assert.deepEqual(res, { ok: false, reason: 'commit cccccccc is not verified' });
});

test('sync-back: refuses a bot-authored commit committed by a person', async () => {
  const github = happyGithub({ commits: [commit(HEAD, AUTHOR, { committer: 'mallory' })] });
  const res = await syncBack.evaluate(makeCtx({ github }), fakeRelease());
  assert.deepEqual(res, { ok: false, reason: `commit aaaaaaaa is not by ${AUTHOR}` });
});

test('sync-back: accepts a commit the bot committed itself', async () => {
  const github = happyGithub({ commits: [commit(HEAD, AUTHOR, { committer: AUTHOR })] });
  const res = await syncBack.evaluate(makeCtx({ github }), fakeRelease());
  assert.equal(res.ok, true);
});

test('sync-back: refuses a commit with no linked GitHub author', async () => {
  const github = happyGithub({ commits: [commit('c'.repeat(40), null), commit(HEAD)] });
  const res = await syncBack.evaluate(makeCtx({ github }), fakeRelease());
  assert.equal(res.ok, false);
  assert.match(res.reason, /is not by/);
});

test('sync-back: refuses a commit list without the evaluated head', async () => {
  const github = happyGithub({ commits: [commit('b'.repeat(40))] });
  const res = await syncBack.evaluate(makeCtx({ github }), fakeRelease());
  assert.equal(res.ok, false);
  assert.match(res.reason, /does not include the evaluated head/);
});

test('sync-back: refuses 250 commits or more', async () => {
  const commits = Array.from({ length: 249 }, (_, i) => commit(String(i).padStart(40, '0')));
  commits.push(commit(HEAD));
  const res = await syncBack.evaluate(makeCtx({ github: happyGithub({ commits }) }), fakeRelease());
  assert.equal(res.ok, false);
  assert.match(res.reason, /250 commits or more/);
});

test('sync-back: refuses when the files cannot be listed', async () => {
  const many = Array.from({ length: 300 }, (_, i) => file(`f${i}`, 's'));
  for (const files of [undefined, many]) {
    const res = await syncBack.evaluate(makeCtx({ github: happyGithub({ files }) }), fakeRelease());
    assert.equal(res.ok, false);
    assert.match(res.reason, /cannot be completely listed/);
  }
});

test('sync-back: refuses an empty change', async () => {
  const res = await syncBack.evaluate(makeCtx({ github: happyGithub({ files: [] }) }), fakeRelease());
  assert.equal(res.ok, false);
  assert.match(res.reason, /changes no files/);
});

test('sync-back: passes the release config refusal through', async () => {
  const res = await syncBack.evaluate(makeCtx({ github: happyGithub() }),
    fakeRelease({ ok: false, reason: 'cannot read release-please-config.json at main (404)' }));
  assert.deepEqual(res, { ok: false, reason: 'cannot read release-please-config.json at main (404)' });
});

test('sync-back: refuses a file release-please does not own', async () => {
  const github = happyGithub({ files: [file('CHANGELOG.md', 's1'), file('src/index.js', 's9')] });
  const res = await syncBack.evaluate(makeCtx({ github }), fakeRelease());
  assert.equal(res.ok, false);
  assert.match(res.reason, /changes src\/index.js, which release-please does not own/);
  assert.equal(github.contentCalls.length, 0);
});

test('sync-back: refuses a removed file', async () => {
  const github = happyGithub({ files: [file('CHANGELOG.md', 's1', { status: 'removed' })] });
  const res = await syncBack.evaluate(makeCtx({ github }), fakeRelease());
  assert.equal(res.ok, false);
  assert.match(res.reason, /removes CHANGELOG.md/);
});

test('sync-back: refuses a renamed file', async () => {
  const github = happyGithub({
    files: [file('CHANGELOG.md', 's1', { status: 'renamed', previous_filename: 'package.json' })],
  });
  const res = await syncBack.evaluate(makeCtx({ github }), fakeRelease());
  assert.equal(res.ok, false);
  assert.match(res.reason, /renames package.json to CHANGELOG.md/);
});

test('sync-back: refuses a file without a blob sha', async () => {
  const github = happyGithub({ files: [file('CHANGELOG.md', undefined)] });
  const res = await syncBack.evaluate(makeCtx({ github }), fakeRelease());
  assert.equal(res.ok, false);
  assert.match(res.reason, /no blob for CHANGELOG.md/);
});

test('sync-back: refuses content that differs from the release branch', async () => {
  const github = happyGithub({ onRelease: { 'CHANGELOG.md': blob('s1'), '.release-please-manifest.json': blob('OTHER'), 'package.json': blob('s3') } });
  const res = await syncBack.evaluate(makeCtx({ github }), fakeRelease());
  assert.equal(res.ok, false);
  assert.match(res.reason, /.release-please-manifest.json differs from main/);
});

test('sync-back: refuses a file missing on the release branch', async () => {
  const github = happyGithub({ onRelease: { 'CHANGELOG.md': blob('s1'), 'package.json': blob('s3') } });
  const res = await syncBack.evaluate(makeCtx({ github }), fakeRelease());
  assert.equal(res.ok, false);
  assert.match(res.reason, /.release-please-manifest.json does not exist on main/);
});

test('sync-back: refuses a path that is not a file on the release branch', async () => {
  for (const entry of [[blob('s1')], { type: 'dir', sha: 's1' }, { type: 'file' }]) {
    const github = happyGithub({ files: [file('CHANGELOG.md', 's1')], onRelease: { 'CHANGELOG.md': entry } });
    const res = await syncBack.evaluate(makeCtx({ github }), fakeRelease());
    assert.equal(res.ok, false);
    assert.match(res.reason, /CHANGELOG.md on main is not a file/);
  }
});

test('sync-back: an API error other than 404 propagates', async () => {
  const boom = Object.assign(new Error('server error'), { status: 502 });
  const github = happyGithub({ files: [file('CHANGELOG.md', 's1')], onRelease: { 'CHANGELOG.md': boom } });
  await assert.rejects(syncBack.evaluate(makeCtx({ github }), fakeRelease()), /server error/);
});
