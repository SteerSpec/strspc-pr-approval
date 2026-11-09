// SPDX-License-Identifier: Apache-2.0
// kind: release. Approving a release-please PR without a human review, because
// all it holds is what release-please generated. Ported from strspc-pr-review's
// release.js.
//
// decide.js keeps everything the kinds share: the guards, the branch-tip check
// (requiresTip), the check gate, the re-reads around the approval and the
// approval itself. This module only answers the questions that are specific to
// a release PR.
//
// options:
//   author  (required) the login release-please opens its PRs as, e.g.
//           'steerspec-sync[bot]'. The branch name alone proves nothing.
//   source  (optional) the branch promoted into the base, e.g. 'develop'. When
//           set, a changelog-visible commit still on it blocks the approval
//           and, through mergeBlocker, the merge (MERGE-005).
//
// The default match (`head: release-please--branches--*`) only selects
// candidates; evaluate() binds the head to the PR's own base with
// isReleaseHead, so a policy that widens match.head cannot widen the check.

const { parseConventionalTitle, describeError, compareHead } = require('../util.js');

// pulls.listCommits stops at 250 commits, so a list that long may be truncated.
const MAX_LISTED_COMMITS = 250;
// The most commits a compare call returns on one page. A source branch further
// ahead than this is refused rather than judged on a partial list.
const COMPARE_PAGE = 100;
const MAX_NAMED_COMMITS = 3;
const MAX_SUBJECT_LENGTH = 60;

const CONFIG_PATH = 'release-please-config.json';
const MANIFEST_PATH = '.release-please-manifest.json';

// Files a release type writes on its own, beyond the changelog and manifest.
// Checked against SteerSpec's go, node and simple repos. An unknown type adds
// nothing, so its version file fails the gate and is named in the reason.
const RELEASE_TYPE_FILES = {
  go: [],
  node: ['package.json', 'package-lock.json', 'npm-shrinkwrap.json'],
};

// What release-please shows when a repo sets no changelog-sections.
const DEFAULT_VISIBLE_TYPES = ['feat', 'fix', 'perf', 'revert'];
// Types that set the version whether or not the changelog shows them.
const VERSION_TYPES = new Set(['feat', 'fix']);

const OPTION_KEYS = ['author', 'source'];

const isNonEmptyString = (v) => typeof v === 'string' && v.trim() !== '';

// author is required: without it a release PR cannot be told from a hand-made
// one. source, when present, must name a branch: an empty string would turn
// the unpromoted gate off without saying so.
function validateOptions(options) {
  const opts = options || {};
  const errors = [];
  for (const k of Object.keys(opts)) if (!OPTION_KEYS.includes(k)) errors.push(`unknown option ${k}`);
  if (!('author' in opts)) errors.push('author is required (the login release-please opens its PRs as)');
  else if (!isNonEmptyString(opts.author)) errors.push('author must be a non-empty string');
  if ('source' in opts && !isNonEmptyString(opts.source)) errors.push('source must be a non-empty branch name');
  return errors;
}

function defaultMatch(options) {
  const author = options && options.author;
  return {
    head: 'release-please--branches--*',
    ...(isNonEmptyString(author) ? { authors: [author] } : {}),
  };
}

// release-please--branches--<base>, plus --components--<name> when the package
// has a component, as a node package does by default.
function isReleaseHead(ref, base) {
  const prefix = `release-please--branches--${base}`;
  const value = String(ref || '');
  if (!value.startsWith(prefix)) return false;
  const rest = value.slice(prefix.length);
  return rest === '' || /^--components--[\w.@-]+$/.test(rest);
}

// The branch name alone proves nothing: anyone with write access can push one,
// and the file gate has to allow package.json in a node repo.
function releaseAuthorBlocker(pr, author) {
  if (!author) return 'options.author is not set, so a release PR cannot be told from a hand-made one';
  const login = pr.user && pr.user.login;
  return login === author ? null : `release PR author ${login || 'unknown'} is not the release author ${author}`;
}

// The union across packages, each read with the top level as its defaults.
const packagesOf = (config) => Object.entries(config.packages || {})
  .map(([path, pkg]) => [path, { ...config, ...pkg }]);

function allowedReleaseFiles(config) {
  const allowed = new Set([MANIFEST_PATH]);
  for (const [path, pkg] of packagesOf(config)) {
    const inPackage = (file) => (path === '.' ? file : `${path}/${file}`);
    allowed.add(inPackage(pkg['changelog-path'] || 'CHANGELOG.md'));
    const type = pkg['release-type'];
    for (const file of RELEASE_TYPE_FILES[type] || []) allowed.add(inPackage(file));
    if (pkg['version-file']) allowed.add(inPackage(pkg['version-file']));
    else if (type === 'simple') allowed.add(inPackage('version.txt'));
    for (const extra of pkg['extra-files'] || []) {
      // A glob can't be allow-listed by name, so what it matches fails the gate.
      if (extra.glob) continue;
      const file = typeof extra === 'string' ? extra : extra.path;
      if (file) allowed.add(file.startsWith('/') ? file.slice(1) : inPackage(file));
    }
  }
  return allowed;
}

function visibleTypes(config) {
  const visible = new Set();
  for (const [, pkg] of packagesOf(config)) {
    const sections = pkg['changelog-sections'];
    if (!sections) {
      DEFAULT_VISIBLE_TYPES.forEach((t) => visible.add(t));
      continue;
    }
    for (const s of sections) if (!s.hidden) visible.add(s.type);
  }
  return visible;
}

// Commits that would change the release if they were left behind: a type the
// changelog shows, or anything that sets the version, hidden or not.
// Non-conventional subjects don't count, because release-please ignores them too.
function unpromotedVisible(commits, visible) {
  return commits.filter((c) => {
    const message = c.commit.message;
    const parsed = parseConventionalTitle(message);
    if (!parsed) return false;
    return visible.has(parsed.type) || VERSION_TYPES.has(parsed.type) || parsed.breaking ||
      /^(BREAKING[ -]CHANGE|Release-As):/mi.test(message.split('\n').slice(1).join('\n'));
  });
}

// Read at the base ref, never the head: a release PR must not be able to widen
// its own allow-list.
async function readReleaseConfig({ github, owner, repo, base }) {
  let content;
  try {
    ({ data: { content } } = await github.rest.repos.getContent({
      owner, repo, path: CONFIG_PATH, ref: `refs/heads/${base}`,
    }));
  } catch (err) {
    if (err.status !== 404) throw err;
    return { ok: false, reason: `cannot read ${CONFIG_PATH} at ${base} (404)` };
  }
  let config;
  try {
    config = JSON.parse(Buffer.from(content, 'base64').toString('utf8'));
  } catch {
    return { ok: false, reason: `${CONFIG_PATH} at ${base} is not valid JSON` };
  }
  if (Object.keys((config && config.packages) || {}).length === 0) {
    return { ok: false, reason: `${CONFIG_PATH} at ${base} has no packages` };
  }
  return { ok: true, config };
}

// GitHub's committer for a commit it creates and signs, as it does for an App's
// API commits (verified on real release PRs in two repos).
const GITHUB_COMMITTER = 'web-flow';

// A git author is only an email, and anyone can forge one, so a locally made
// commit needs a verified signature too. That stops an accident or a forged local
// commit, not a deliberate actor: a verified web-flow commit proves GitHub made
// it, not who asked. An actor who can do that is out of scope here, see the
// threat model epic.
function isReleaseCommit(c, author) {
  const verified = Boolean(c.commit && c.commit.verification && c.commit.verification.verified);
  const committer = c.committer && c.committer.login;
  return Boolean(c.author) && c.author.login === author && verified &&
    (committer === GITHUB_COMMITTER || committer === author);
}

// Every commit must be the release author's too: a person pushing on top of a
// release PR leaves its author unchanged.
async function commitsBlocker({ github, owner, repo, prNumber, headSha, author }) {
  const commits = await github.paginate(github.rest.pulls.listCommits, {
    owner, repo, pull_number: prNumber, per_page: 100,
  });
  if (commits.length >= MAX_LISTED_COMMITS) {
    return `release PR has ${MAX_LISTED_COMMITS} commits or more, so its authors cannot be proven`;
  }
  if (!commits.some((c) => c.sha === headSha)) {
    return `commit list does not include the evaluated head ${headSha.slice(0, 8)}`;
  }
  const stranger = commits.find((c) => !isReleaseCommit(c, author));
  return stranger ? `commit ${stranger.sha.slice(0, 8)} is not a verified commit by the release author ${author}` : null;
}

// Everything about the PR's own contents. `names` and `mergeBase` come from
// ctx.compare() (util.compareHead), which pins them to the evaluated head.
async function checkReleasePr({ github, owner, repo, pr, author, names, mergeBase }) {
  const base = pr.base.ref;
  if (names === null) return { ok: false, reason: 'release PR changes 300 files or more, so the list may be partial' };
  if (!mergeBase) return { ok: false, reason: 'the comparison reported no merge base, so the diff cannot be re-verified' };
  const read = await readReleaseConfig({ github, owner, repo, base });
  if (!read.ok) return read;
  const allowed = allowedReleaseFiles(read.config);
  const foreign = names.find((f) => !allowed.has(f));
  if (foreign) return { ok: false, reason: `release PR changes ${foreign}, which release-please does not own` };
  const blocker = await commitsBlocker({
    github, owner, repo, prNumber: pr.number, headSha: pr.head.sha, author,
  });
  return blocker ? { ok: false, reason: blocker } : { ok: true, config: read.config };
}

const describeCommit = (c) => {
  const subject = c.commit.message.split('\n')[0];
  const cut = subject.length > MAX_SUBJECT_LENGTH ? `${subject.slice(0, MAX_SUBJECT_LENGTH)}…` : subject;
  return `${c.sha.slice(0, 8)} ${cut}`;
};

// release-please stops at the last release commit on the base, so a commit still
// on the source branch when this PR merges is left out of the changelog for good
// and can no longer bump the version.
async function checkUnpromoted({ github, owner, repo, base, source, config }) {
  let data;
  try {
    ({ data } = await github.rest.repos.compareCommitsWithBasehead({
      owner, repo, basehead: `heads/${base}...heads/${source}`, per_page: COMPARE_PAGE,
    }));
  } catch (err) {
    if (err.status !== 404) throw err;
    return {
      ok: false,
      reason: `cannot compare ${source} with ${base} (404); if the repo has no ${source}, drop options.source from the policy`,
    };
  }
  const commits = data.commits || [];
  if (data.total_commits > commits.length) {
    return { ok: false, reason: `${source} is ${data.total_commits} commits ahead of ${base}, more than can be read; promote first` };
  }
  const held = unpromotedVisible(commits, visibleTypes(config));
  if (held.length === 0) return { ok: true };
  const named = held.slice(0, MAX_NAMED_COMMITS).map(describeCommit).join(', ');
  const more = held.length > MAX_NAMED_COMMITS ? ` (+${held.length - MAX_NAMED_COMMITS} more)` : '';
  return { ok: false, reason: `${source} has ${held.length} unpromoted commit(s): ${named}${more}; promote first` };
}

// Author first: it costs no API call. Then the head must be the release branch
// of this very base, then the diff, the config at the base and the commits,
// and last the source branch. API errors propagate, so decide.js withdraws any
// approval of ours before reporting the failure.
// A release PR that lacks commits now on its base was generated before them:
// merging it would tag a version whose bump and changelog leave them out.
// release-please force-updates its branch after every push to the base, so
// this only waits for that refresh.
function behindBlocker(compared, base) {
  const n = compared && compared.behindBy;
  return n > 0 ? `release PR is ${n} commit(s) behind ${base}; wait for release-please to refresh it` : null;
}

async function evaluate(ctx) {
  const { github, owner, repo, pr } = ctx;
  const options = ctx.options || {};
  const { author, source } = options;
  const head = pr.head.ref;
  const base = pr.base.ref;

  const authorBlocker = releaseAuthorBlocker(pr, author);
  if (authorBlocker) return { ok: false, reason: authorBlocker };
  if (!isReleaseHead(head, base)) {
    return { ok: false, reason: `head ${head} is not release-please's branch for ${base}` };
  }

  const c = await ctx.compare();
  const stale = behindBlocker(c, base);
  if (stale) return { ok: false, reason: stale };
  const proof = await checkReleasePr({
    github, owner, repo, pr, author, names: c.names, mergeBase: c.mergeBase,
  });
  if (!proof.ok) return { ok: false, reason: proof.reason };

  if (source) {
    const held = await checkUnpromoted({ github, owner, repo, base, source, config: proof.config });
    if (!held.ok) return { ok: false, reason: held.reason };
  }
  return {
    ok: true,
    summary: `release-pr (${head}${source ? `, nothing unpromoted on ${source}` : ''})`,
    // The approval rests on the file list, so decide.js re-reads it.
    mergeBase: c.mergeBase,
  };
}

// MERGE-005: never merge a release while the source branch holds a
// changelog-visible commit. Promotions can land between the approval and the
// merge, so this is read again right before merging. The config is re-read at
// the base too. A failed read blocks the merge with its error rather than
// throwing: the approval already stands, and only the merge is in question.
async function mergeBlocker(ctx) {
  const { github, owner, repo, pr } = ctx;
  const source = ctx.options && ctx.options.source;
  const base = pr.base.ref;
  try {
    // Fresh, not ctx.compare(): a promotion may have landed since evaluation.
    const now = await compareHead({ github, owner, repo, baseRef: base, headSha: pr.head.sha });
    const stale = behindBlocker(now, base);
    if (stale) return stale;
    if (!source) return null;
    const read = await readReleaseConfig({ github, owner, repo, base });
    if (!read.ok) return read.reason;
    const held = await checkUnpromoted({ github, owner, repo, base, source, config: read.config });
    return held.ok ? null : held.reason;
  } catch (err) {
    return `the unpromoted commits on ${source} could not be read (${describeError(err)})`;
  }
}

module.exports = {
  name: 'release',
  requiresTip: true,
  defaultMatch,
  validateOptions,
  evaluate,
  mergeBlocker,
  behindBlocker,
  MAX_LISTED_COMMITS,
  isReleaseHead,
  releaseAuthorBlocker,
  readReleaseConfig,
  allowedReleaseFiles,
  visibleTypes,
  unpromotedVisible,
  isReleaseCommit,
  commitsBlocker,
  checkReleasePr,
  checkUnpromoted,
};
