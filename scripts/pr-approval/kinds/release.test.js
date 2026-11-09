// SPDX-License-Identifier: Apache-2.0
// Unit tests for kind: release. Ported from strspc-pr-review's release.test.js;
// the cases that went through decide.js there call evaluate() and
// mergeBlocker() directly here, with a ctx built the way decide.js builds it.
// Run with: node --test scripts/pr-approval/kinds/release.test.js

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { compareHead } = require('../util.js');
const release = require('./release.js');

const {
  isReleaseHead,
  releaseAuthorBlocker,
  readReleaseConfig,
  allowedReleaseFiles,
  visibleTypes,
  unpromotedVisible,
  isReleaseCommit,
  MAX_LISTED_COMMITS,
} = release;

const AUTHOR = 'release-app[bot]';
const HEAD = 'cafe0002';
const HEAD_REF = 'release-please--branches--main';

// The shapes SteerSpec repos use, reduced to what the gates read.
const GO_CONFIG = {
  packages: {
    '.': {
      'release-type': 'go',
      'changelog-sections': [
        { type: 'feat', section: 'Features' },
        { type: 'fix', section: 'Bug Fixes' },
        { type: 'docs', section: 'Documentation' },
        { type: 'chore', section: 'Miscellaneous', hidden: true },
      ],
    },
  },
};
const NODE_CONFIG = { 'release-type': 'node', packages: { '.': {} } };
const SIMPLE_CONFIG = { packages: { '.': { 'release-type': 'simple', 'version-file': 'VERSION' } } };
const EXTRA_FILES_CONFIG = {
  packages: {
    '.': {
      'release-type': 'simple',
      'extra-files': [{ type: 'json', path: 'rules/realm.json', jsonpath: '$.realm.version' }],
      'changelog-sections': [
        { type: 'feat', section: 'Features' },
        { type: 'docs', section: 'Documentation', hidden: true },
      ],
    },
  },
};

const commit = (message, sha = 'beef0001') => ({ sha, commit: { message } });
// A commit in the shape a release app's API commit really has.
const appCommit = (sha = HEAD, overrides = {}) => ({
  sha,
  author: { login: AUTHOR },
  committer: { login: 'web-flow' },
  commit: { verification: { verified: true } },
  ...overrides,
});
const encode = (config) => Buffer.from(JSON.stringify(config)).toString('base64');

function makeRepo({
  config = GO_CONFIG,
  rawConfig,
  configError,
  changedFiles = ['CHANGELOG.md', '.release-please-manifest.json'],
  mergeBase = 'mb000001',
  prCommits = [appCommit()],
  unpromoted = [],
  totalUnpromoted,
  compareSourceError,
} = {}) {
  const calls = { getContent: [], headCompare: [], sourceCompare: [], listCommits: 0 };
  const github = {
    paginate: async (fn, params) => (await fn(params)).data,
    rest: {
      repos: {
        getContent: async (args) => {
          calls.getContent.push(args);
          if (configError) throw configError;
          return { data: { content: rawConfig === undefined ? encode(config) : rawConfig, encoding: 'base64' } };
        },
        compareCommitsWithBasehead: async ({ basehead }) => {
          if (basehead.endsWith(`...${HEAD}`)) {
            calls.headCompare.push(basehead);
            return {
              data: {
                merge_base_commit: mergeBase ? { sha: mergeBase } : null,
                files: changedFiles.map((filename) => ({ filename })),
              },
            };
          }
          calls.sourceCompare.push(basehead);
          if (compareSourceError) throw compareSourceError;
          return { data: { total_commits: totalUnpromoted ?? unpromoted.length, commits: unpromoted } };
        },
      },
      pulls: {
        listCommits: async () => {
          calls.listCommits += 1;
          return { data: prCommits };
        },
      },
    },
  };
  return { github, calls };
}

function releasePr(overrides = {}) {
  return {
    number: 172,
    draft: false,
    title: 'chore(main): release 1.29.0',
    user: { login: AUTHOR },
    head: { ref: HEAD_REF, sha: HEAD },
    base: { ref: 'main' },
    ...overrides,
  };
}

const DEFAULT_OPTIONS = { author: AUTHOR, source: 'develop' };

// The ctx decide.js hands a kind, with the same memoised compare().
function makeCtx({ repo = makeRepo(), pr = releasePr(), options = DEFAULT_OPTIONS } = {}) {
  const owner = 'acme';
  const name = 'widgets';
  let compared = null;
  const compare = async () => {
    if (!compared) {
      compared = await compareHead({ github: repo.github, owner, repo: name, baseRef: pr.base.ref, headSha: pr.head.sha });
    }
    return compared;
  };
  return {
    github: repo.github, owner, repo: name, pr, policy: { id: 'p', kind: 'release', options }, options,
    compare, checkRuns: [], core: { info() {}, warning() {} }, botLogin: 'approver-bot',
  };
}

const evaluate = (args) => release.evaluate(makeCtx(args));

// -- Kind contract ---------------------------------------------------------

test('kind: name, requiresTip and mergeBlocker', () => {
  assert.equal(release.name, 'release');
  assert.equal(release.requiresTip, true);
  assert.equal(typeof release.evaluate, 'function');
  assert.equal(typeof release.mergeBlocker, 'function');
});

test('defaultMatch: release-please branches by the release author', () => {
  assert.deepEqual(release.defaultMatch({ author: AUTHOR }), {
    head: 'release-please--branches--*', authors: [AUTHOR],
  });
  assert.deepEqual(release.defaultMatch({ author: AUTHOR, source: 'develop' }), {
    head: 'release-please--branches--*', authors: [AUTHOR],
  });
  assert.deepEqual(release.defaultMatch({}), { head: 'release-please--branches--*' });
  assert.deepEqual(release.defaultMatch(undefined), { head: 'release-please--branches--*' });
});

test('validateOptions: author is required, source optional', () => {
  assert.deepEqual(release.validateOptions({ author: AUTHOR }), []);
  assert.deepEqual(release.validateOptions({ author: AUTHOR, source: 'develop' }), []);
  assert.match(release.validateOptions({}).join('; '), /author is required/);
  assert.match(release.validateOptions({ author: '' }).join('; '), /author must be a non-empty string/);
  assert.match(release.validateOptions({ author: '  ' }).join('; '), /author must be a non-empty string/);
  assert.match(release.validateOptions({ author: 42 }).join('; '), /author must be a non-empty string/);
});

test('validateOptions: a source that is not a branch name is refused, not ignored', () => {
  assert.match(release.validateOptions({ author: AUTHOR, source: 3 }).join('; '), /source must be/);
  assert.match(release.validateOptions({ author: AUTHOR, source: '' }).join('; '), /source must be/);
  assert.match(release.validateOptions({ author: AUTHOR, source: null }).join('; '), /source must be/);
});

test('validateOptions: unknown keys are refused', () => {
  assert.deepEqual(release.validateOptions({ author: AUTHOR, files: ['x'] }), ['unknown option files']);
});

// -- Helpers ---------------------------------------------------------------

test('isReleaseHead: the exact branch, with an optional component', () => {
  assert.equal(isReleaseHead('release-please--branches--main', 'main'), true);
  assert.equal(isReleaseHead('release-please--branches--main--components--pr-auto-approve', 'main'), true);
  assert.equal(isReleaseHead('release-please--branches--main--components--', 'main'), false);
  assert.equal(isReleaseHead('release-please--branches--main-2', 'main'), false);
  assert.equal(isReleaseHead('release-please--branches--main--other', 'main'), false);
  assert.equal(isReleaseHead('release-please--branches--stable', 'main'), false);
  assert.equal(isReleaseHead('develop', 'main'), false);
  assert.equal(isReleaseHead(undefined, 'main'), false);
});

test('releaseAuthorBlocker: needs a configured author, and the PR to be theirs', () => {
  assert.equal(releaseAuthorBlocker({ user: { login: AUTHOR } }, AUTHOR), null);
  assert.match(releaseAuthorBlocker({ user: { login: AUTHOR } }, ''), /options.author is not set/);
  assert.match(releaseAuthorBlocker({ user: { login: 'someone' } }, AUTHOR),
    /release PR author someone is not the release author release-app\[bot\]/);
  assert.match(releaseAuthorBlocker({ user: null }, AUTHOR), /release PR author unknown/);
});

test('isReleaseCommit: the author, a verified signature and GitHub or the author as committer', () => {
  assert.equal(isReleaseCommit(appCommit(), AUTHOR), true);
  assert.equal(isReleaseCommit(appCommit(HEAD, { committer: { login: AUTHOR } }), AUTHOR), true);
  assert.equal(isReleaseCommit(appCommit(HEAD, { author: null }), AUTHOR), false);
  assert.equal(isReleaseCommit(appCommit(HEAD, { commit: {} }), AUTHOR), false);
  assert.equal(isReleaseCommit(appCommit(HEAD, { committer: { login: 'someone' } }), AUTHOR), false);
  assert.equal(isReleaseCommit(appCommit(), 'other[bot]'), false);
});

const sorted = (set) => [...set].sort();

test('allowedReleaseFiles: go owns the changelog and the manifest', () => {
  assert.deepEqual(sorted(allowedReleaseFiles(GO_CONFIG)), ['.release-please-manifest.json', 'CHANGELOG.md']);
});

test('allowedReleaseFiles: node adds its package files, from a top-level release type', () => {
  assert.deepEqual(sorted(allowedReleaseFiles(NODE_CONFIG)), [
    '.release-please-manifest.json', 'CHANGELOG.md', 'npm-shrinkwrap.json', 'package-lock.json', 'package.json',
  ]);
});

test('allowedReleaseFiles: simple uses version-file, else version.txt', () => {
  assert.ok(allowedReleaseFiles(SIMPLE_CONFIG).has('VERSION'));
  assert.ok(!allowedReleaseFiles(SIMPLE_CONFIG).has('version.txt'));
  assert.ok(allowedReleaseFiles({ packages: { '.': { 'release-type': 'simple' } } }).has('version.txt'));
});

test('allowedReleaseFiles: extra-files, as objects or strings, under the package path', () => {
  assert.ok(allowedReleaseFiles(EXTRA_FILES_CONFIG).has('rules/realm.json'));
  const nested = {
    packages: {
      'apps/web': {
        'release-type': 'node',
        'changelog-path': 'docs/CHANGES.md',
        'extra-files': ['src/version.ts', '/README.md', { type: 'generic', path: 'a/*.ts', glob: true }],
      },
    },
  };
  const out = allowedReleaseFiles(nested);
  assert.ok(out.has('apps/web/docs/CHANGES.md'));
  assert.ok(out.has('apps/web/package.json'));
  assert.ok(out.has('apps/web/src/version.ts'));
  assert.ok(out.has('README.md'), 'a leading slash is repo-relative');
  assert.ok(!out.has('apps/web/a/*.ts'), 'a glob cannot be allow-listed by name');
});

test('allowedReleaseFiles: an unknown release type adds nothing', () => {
  assert.deepEqual(
    sorted(allowedReleaseFiles({ packages: { '.': { 'release-type': 'python' } } })),
    ['.release-please-manifest.json', 'CHANGELOG.md'],
  );
});

test('visibleTypes: package sections, else top-level, else release-please defaults', () => {
  assert.deepEqual(sorted(visibleTypes(GO_CONFIG)), ['docs', 'feat', 'fix']);
  assert.deepEqual(sorted(visibleTypes(EXTRA_FILES_CONFIG)), ['feat']);
  assert.deepEqual(sorted(visibleTypes(NODE_CONFIG)), ['feat', 'fix', 'perf', 'revert']);
  const top = { 'changelog-sections': [{ type: 'build', section: 'Build' }], packages: { '.': {} } };
  assert.deepEqual(sorted(visibleTypes(top)), ['build']);
});

test('unpromotedVisible: visible types, breaking marks and footers count', () => {
  const visible = new Set(['feat', 'fix']);
  const held = (message) => unpromotedVisible([commit(message)], visible).length === 1;
  assert.equal(held('fix: a'), true);
  assert.equal(held('feat(api): a'), true);
  assert.equal(held('chore: a'), false);
  assert.equal(held('chore!: a'), true);
  assert.equal(held('chore(deps)!: a'), true);
  assert.equal(held('chore: a\n\nBREAKING CHANGE: b'), true);
  assert.equal(held('chore: a\n\nBREAKING-CHANGE: b'), true);
  assert.equal(held('chore: a\n\nRelease-As: 2.0.0'), true);
  assert.equal(held('chore: mentions BREAKING CHANGE: in the subject'), false);
  assert.equal(held('Merge branch main into develop'), false, 'release-please ignores these too');
});

test('readReleaseConfig: reads at the base branch, never the head', async () => {
  const repo = makeRepo();
  const out = await readReleaseConfig({ github: repo.github, owner: 'acme', repo: 'widgets', base: 'main' });
  assert.deepEqual(out, { ok: true, config: GO_CONFIG });
  assert.equal(repo.calls.getContent[0].ref, 'refs/heads/main');
  assert.equal(repo.calls.getContent[0].path, 'release-please-config.json');
});

test('readReleaseConfig: a non-404 error propagates', async () => {
  const repo = makeRepo({ configError: Object.assign(new Error('boom'), { status: 502 }) });
  await assert.rejects(readReleaseConfig({ github: repo.github, owner: 'acme', repo: 'widgets', base: 'main' }), /boom/);
});

// -- evaluate: approve -----------------------------------------------------

test('evaluate: a passing release PR with a source names it, and returns the merge base', async () => {
  const repo = makeRepo({ unpromoted: [commit('chore: sync')] });
  const out = await evaluate({ repo });
  assert.deepEqual(out, {
    ok: true, summary: `release-pr (${HEAD_REF}, nothing unpromoted on develop)`, mergeBase: 'mb000001',
  });
  assert.deepEqual(repo.calls.headCompare, [`heads/main...${HEAD}`]);
  assert.deepEqual(repo.calls.sourceCompare, ['heads/main...heads/develop']);
});

test('evaluate: without a source there is no unpromoted gate', async () => {
  const repo = makeRepo({ unpromoted: [commit('fix: a')] });
  const out = await evaluate({ repo, options: { author: AUTHOR } });
  assert.equal(out.ok, true, out.reason);
  assert.equal(out.summary, `release-pr (${HEAD_REF})`);
  assert.equal(repo.calls.sourceCompare.length, 0);
});

test('evaluate: the config comes from the base branch, never the head', async () => {
  const repo = makeRepo();
  await evaluate({ repo });
  assert.equal(repo.calls.getContent[0].ref, 'refs/heads/main');
  assert.equal(repo.calls.getContent[0].path, 'release-please-config.json');
});

test('evaluate: a node repo with a component head and its package files', async () => {
  const headRef = 'release-please--branches--main--components--pr-auto-approve';
  const out = await evaluate({
    pr: releasePr({ head: { ref: headRef, sha: HEAD } }),
    repo: makeRepo({
      config: NODE_CONFIG,
      changedFiles: ['.release-please-manifest.json', 'CHANGELOG.md', 'package-lock.json', 'package.json'],
    }),
  });
  assert.equal(out.ok, true, out.reason);
  assert.equal(out.summary, `release-pr (${headRef}, nothing unpromoted on develop)`);
});

test('evaluate: simple with version-file, and extra-files', async () => {
  const simple = await evaluate({ repo: makeRepo({ config: SIMPLE_CONFIG, changedFiles: ['VERSION', 'CHANGELOG.md'] }) });
  assert.equal(simple.ok, true, simple.reason);
  const extra = await evaluate({
    repo: makeRepo({ config: EXTRA_FILES_CONFIG, changedFiles: ['rules/realm.json', 'CHANGELOG.md'] }),
  });
  assert.equal(extra.ok, true, extra.reason);
});

test('evaluate: a commit the release author committed and signed itself', async () => {
  const out = await evaluate({ repo: makeRepo({ prCommits: [appCommit(HEAD, { committer: { login: AUTHOR } })] }) });
  assert.equal(out.ok, true, out.reason);
});

test('evaluate: an unpromoted chore does not block', async () => {
  const out = await evaluate({ repo: makeRepo({ unpromoted: [commit('chore: a')] }) });
  assert.equal(out.ok, true, out.reason);
});

// -- evaluate: refuse ------------------------------------------------------

test('evaluate: a release PR by the wrong author is refused before any API call', async () => {
  const repo = makeRepo();
  const out = await evaluate({ repo, pr: releasePr({ user: { login: 'someone' } }) });
  assert.equal(out.ok, false);
  assert.match(out.reason, /release PR author someone is not the release author/);
  assert.equal(repo.calls.headCompare.length, 0);
  assert.equal(repo.calls.getContent.length, 0);
});

test('evaluate: no author in options is refused', async () => {
  const out = await evaluate({ options: {} });
  assert.equal(out.ok, false);
  assert.match(out.reason, /options.author is not set/);
});

test('evaluate: a release branch for another base is refused, whatever match.head allowed', async () => {
  const repo = makeRepo();
  const out = await evaluate({ repo, pr: releasePr({ head: { ref: 'release-please--branches--stable', sha: HEAD } }) });
  assert.equal(out.ok, false);
  assert.equal(out.reason, 'head release-please--branches--stable is not release-please\'s branch for main');
  assert.equal(repo.calls.headCompare.length, 0);
});

test('evaluate: a code file in the release PR is refused', async () => {
  const out = await evaluate({ repo: makeRepo({ changedFiles: ['CHANGELOG.md', 'src/x.go'] }) });
  assert.equal(out.ok, false);
  assert.equal(out.reason, 'release PR changes src/x.go, which release-please does not own');
});

test('evaluate: a renamed file is judged by both of its names', async () => {
  const repo = makeRepo();
  repo.github.rest.repos.compareCommitsWithBasehead = async () => ({
    data: {
      merge_base_commit: { sha: 'mb' },
      files: [{ filename: 'CHANGELOG.md', previous_filename: 'src/x.go' }],
    },
  });
  const out = await evaluate({ repo, options: { author: AUTHOR } });
  assert.equal(out.ok, false);
  assert.match(out.reason, /changes src\/x.go/);
});

test('evaluate: 300 files or more is refused', async () => {
  const changedFiles = Array.from({ length: 300 }, () => 'CHANGELOG.md');
  const out = await evaluate({ repo: makeRepo({ changedFiles }) });
  assert.equal(out.ok, false);
  assert.match(out.reason, /300 files or more/);
});

test('evaluate: no merge base, so the diff cannot be re-verified', async () => {
  const out = await evaluate({ repo: makeRepo({ mergeBase: null }) });
  assert.equal(out.ok, false);
  assert.match(out.reason, /no merge base/);
});

test('evaluate: a missing config is refused', async () => {
  const out = await evaluate({ repo: makeRepo({ configError: Object.assign(new Error('nf'), { status: 404 }) }) });
  assert.equal(out.ok, false);
  assert.equal(out.reason, 'cannot read release-please-config.json at main (404)');
});

test('evaluate: an invalid config is refused', async () => {
  const garbled = await evaluate({ repo: makeRepo({ rawConfig: Buffer.from('{').toString('base64') }) });
  assert.match(garbled.reason, /release-please-config.json at main is not valid JSON/);
  const empty = await evaluate({ repo: makeRepo({ config: { packages: {} } }) });
  assert.match(empty.reason, /has no packages/);
  const notObject = await evaluate({ repo: makeRepo({ config: null }) });
  assert.equal(notObject.reason, 'release-please-config.json at main has no packages');
});

test('evaluate: a failed config read throws, so decide.js withdraws and reports it', async () => {
  const repo = makeRepo({ configError: Object.assign(new Error('boom'), { status: 502 }) });
  await assert.rejects(evaluate({ repo }), /boom/);
});

test('evaluate: a commit by someone else on top of the release commit', async () => {
  const out = await evaluate({
    repo: makeRepo({ prCommits: [appCommit('beef0001'), appCommit(HEAD, { author: { login: 'someone' } })] }),
  });
  assert.equal(out.ok, false);
  assert.equal(out.reason, `commit ${HEAD} is not a verified commit by the release author ${AUTHOR}`);
});

test('evaluate: a commit with no linked author', async () => {
  const out = await evaluate({ repo: makeRepo({ prCommits: [appCommit(HEAD, { author: null })] }) });
  assert.match(out.reason, /is not a verified commit by the release author/);
});

test('evaluate: a forged author, which no verified signature backs', async () => {
  const unsigned = await evaluate({
    repo: makeRepo({ prCommits: [appCommit(HEAD, { commit: { verification: { verified: false } } })] }),
  });
  assert.match(unsigned.reason, /is not a verified commit by the release author/);
  const noVerification = await evaluate({ repo: makeRepo({ prCommits: [appCommit(HEAD, { commit: {} })] }) });
  assert.match(noVerification.reason, /is not a verified commit by the release author/);
});

test('evaluate: a person signing a commit under the forged author', async () => {
  const out = await evaluate({ repo: makeRepo({ prCommits: [appCommit(HEAD, { committer: { login: 'someone' } })] }) });
  assert.match(out.reason, /is not a verified commit by the release author/);
  const none = await evaluate({ repo: makeRepo({ prCommits: [appCommit(HEAD, { committer: null })] }) });
  assert.match(none.reason, /is not a verified commit by the release author/);
});

test('evaluate: a commit list that may be partial, or misses the head', async () => {
  const prCommits = Array.from({ length: MAX_LISTED_COMMITS }, (_, i) => appCommit(`s${i}`));
  const long = await evaluate({ repo: makeRepo({ prCommits }) });
  assert.match(long.reason, /250 commits or more/);
  const missing = await evaluate({ repo: makeRepo({ prCommits: [appCommit('other')] }) });
  assert.match(missing.reason, /does not include the evaluated head/);
});

test('evaluate: an unpromoted fix is refused, naming it', async () => {
  const out = await evaluate({ repo: makeRepo({ unpromoted: [commit('fix: drop the bad cache', 'abcdef1234')] }) });
  assert.equal(out.ok, false);
  assert.equal(out.reason, 'develop has 1 unpromoted commit(s): abcdef12 fix: drop the bad cache; promote first');
});

test('evaluate: the unpromoted reason names at most 3 commits', async () => {
  const unpromoted = ['fix: a', 'fix: b', 'fix: c', 'fix: d', 'fix: e'].map((m, i) => commit(m, `sha0000${i}`));
  const out = await evaluate({ repo: makeRepo({ unpromoted }) });
  assert.equal(
    out.reason,
    'develop has 5 unpromoted commit(s): sha00000 fix: a, sha00001 fix: b, sha00002 fix: c (+2 more); promote first',
  );
});

test('evaluate: a long subject is cut in the reason', async () => {
  const out = await evaluate({ repo: makeRepo({ unpromoted: [commit(`fix: ${'x'.repeat(200)}`)] }) });
  assert.ok(out.reason.length < 130, out.reason);
});

test('evaluate: a hidden type marked breaking still blocks', async () => {
  const out = await evaluate({ repo: makeRepo({ unpromoted: [commit('chore!: a')] }) });
  assert.match(out.reason, /develop has 1 unpromoted commit/);
});

test('evaluate: visibility is the repo\'s own: docs blocks here and not there', async () => {
  const unpromoted = [commit('docs: a')];
  const blocks = await evaluate({ repo: makeRepo({ unpromoted }) });
  assert.match(blocks.reason, /unpromoted/);
  const passes = await evaluate({
    repo: makeRepo({ unpromoted, config: EXTRA_FILES_CONFIG, changedFiles: ['CHANGELOG.md'] }),
  });
  assert.equal(passes.ok, true, passes.reason);
});

test('evaluate: a hidden feat or fix still blocks: the type sets the version, not the changelog', async () => {
  const hidden = { packages: { '.': { 'changelog-sections': [
    { type: 'feat', section: 'Features', hidden: true },
    { type: 'fix', section: 'Bug Fixes', hidden: true },
    { type: 'docs', section: 'Documentation' },
  ] } } };
  for (const message of ['feat: a', 'fix: a']) {
    const out = await evaluate({ repo: makeRepo({ config: hidden, unpromoted: [commit(message)] }) });
    assert.match(out.reason, /develop has 1 unpromoted commit/, message);
  }
  const held = unpromotedVisible([commit('feat: a'), commit('chore: b')], visibleTypes(hidden));
  assert.equal(held.length, 1);
});

test('evaluate: more unpromoted commits than were listed', async () => {
  const out = await evaluate({ repo: makeRepo({ unpromoted: [commit('chore: a')], totalUnpromoted: 500 }) });
  assert.equal(out.ok, false);
  assert.match(out.reason, /develop is 500 commits ahead of main, more than can be read; promote first/);
});

test('evaluate: a source branch that does not exist', async () => {
  const out = await evaluate({
    repo: makeRepo({ compareSourceError: Object.assign(new Error('nf'), { status: 404 }) }),
  });
  assert.equal(out.ok, false);
  assert.match(out.reason, /cannot compare develop with main \(404\).*drop options.source/);
});

test('evaluate: a failed unpromoted read throws', async () => {
  const repo = makeRepo({ compareSourceError: Object.assign(new Error('boom'), { status: 502 }) });
  await assert.rejects(evaluate({ repo }), /boom/);
});

// -- mergeBlocker (MERGE-005) ----------------------------------------------

test('mergeBlocker: none without a source', async () => {
  const repo = makeRepo({ unpromoted: [commit('fix: a')] });
  assert.equal(await release.mergeBlocker(makeCtx({ repo, options: { author: AUTHOR } })), null);
  assert.equal(repo.calls.getContent.length, 0);
  assert.equal(repo.calls.sourceCompare.length, 0);
});

test('mergeBlocker: none when nothing visible is unpromoted', async () => {
  const repo = makeRepo({ unpromoted: [commit('chore: a')] });
  assert.equal(await release.mergeBlocker(makeCtx({ repo })), null);
  assert.equal(repo.calls.getContent[0].ref, 'refs/heads/main', 'the config is re-read at the base');
  assert.deepEqual(repo.calls.sourceCompare, ['heads/main...heads/develop']);
});

test('mergeBlocker: a fix that landed on the source after the approval blocks the merge', async () => {
  const repo = makeRepo({ unpromoted: [commit('fix: late', 'abcdef1234')] });
  assert.equal(
    await release.mergeBlocker(makeCtx({ repo })),
    'develop has 1 unpromoted commit(s): abcdef12 fix: late; promote first',
  );
});

test('mergeBlocker: a config that cannot be read blocks the merge', async () => {
  const repo = makeRepo({ configError: Object.assign(new Error('nf'), { status: 404 }) });
  assert.equal(await release.mergeBlocker(makeCtx({ repo })), 'cannot read release-please-config.json at main (404)');
});

test('mergeBlocker: a failed read blocks the merge rather than passing', async () => {
  const repo = makeRepo({ compareSourceError: Object.assign(new Error('boom'), { status: 502 }) });
  const out = await release.mergeBlocker(makeCtx({ repo }));
  assert.notEqual(out, null);
  assert.match(out, /could not be read \(502 boom\)/);
  const configRepo = makeRepo({ configError: Object.assign(new Error('boom'), { status: 500 }) });
  assert.match(await release.mergeBlocker(makeCtx({ repo: configRepo })), /500 boom/);
});
