// SPDX-License-Identifier: Apache-2.0
// sync-back (APPROVE-007): after a release lands on the release branch, a bot
// opens a PR into develop that copies the release files back
// (chore/sync-release-files, chore/sync-release-<version>).
//
// The branch name and the title prove nothing, so the proof is the content:
// the release author wrote the PR and every commit on it (verified, see
// commits.js), every changed file is one release-please owns (read from the
// release branch, never the head), and every changed file is byte-for-byte the
// file on the release branch. Such a PR
// can only make develop agree with what was already released.

const { commitsBlocker } = require('./commits.js');

const DEFAULT_RELEASE_BRANCH = 'main';
const OPTION_KEYS = ['author', 'release-branch'];

const isNonEmptyString = (v) => typeof v === 'string' && v.trim() !== '';

function defaultMatch(options = {}) {
  const match = { head: ['chore/sync-release-*'], base: 'develop' };
  if (isNonEmptyString(options.author)) match.authors = [options.author];
  return match;
}

function validateOptions(options = {}) {
  const errors = [];
  for (const k of Object.keys(options)) if (!OPTION_KEYS.includes(k)) errors.push(`unknown key '${k}'`);
  if (!('author' in options)) errors.push('author is required (the login that opens sync-back PRs)');
  else if (!isNonEmptyString(options.author)) errors.push('author must be a non-empty string');
  if ('release-branch' in options && (!isNonEmptyString(options['release-branch']) || /[\s*?]/.test(options['release-branch']))) {
    errors.push('release-branch must be a branch name');
  }
  return errors;
}

// The blob sha of `path` on the release branch, or a refusal reason.
async function releaseBlobSha({ github, owner, repo, path, releaseBranch }) {
  let data;
  try {
    ({ data } = await github.rest.repos.getContent({ owner, repo, path, ref: `refs/heads/${releaseBranch}` }));
  } catch (err) {
    if (err && err.status === 404) return { reason: `${path} does not exist on ${releaseBranch}` };
    throw err;
  }
  if (Array.isArray(data) || !data || data.type !== 'file' || !data.sha) {
    return { reason: `${path} on ${releaseBranch} is not a file` };
  }
  return { sha: data.sha };
}

// `deps` is injectable for tests; release.js is loaded lazily so this module
// loads on its own.
async function evaluate(ctx, deps) {
  const { readReleaseConfig, allowedReleaseFiles } = deps || require('./release.js');
  const { github, owner, repo, pr } = ctx;
  const options = ctx.options || {};
  const author = options.author;
  const releaseBranch = options['release-branch'] || DEFAULT_RELEASE_BRANCH;

  // The policy's match may override the default authors, so check again here.
  if (!isNonEmptyString(author)) return { ok: false, reason: 'sync-back: options.author is not set' };
  const login = pr.user && pr.user.login;
  if (login !== author) return { ok: false, reason: `sync-back PR author ${login || 'unknown'} is not ${author}` };
  if (pr.base && pr.base.ref === releaseBranch) {
    return { ok: false, reason: `sync-back PR targets the release branch ${releaseBranch} itself` };
  }

  const blocker = await commitsBlocker({ github, owner, repo, pr, author, label: 'sync-back PR' });
  if (blocker) return { ok: false, reason: blocker };

  const c = await ctx.compare();
  if (!c.files) return { ok: false, reason: 'sync-back PR changed files cannot be completely listed' };
  if (c.files.length === 0) return { ok: false, reason: 'sync-back PR changes no files' };

  // The allow-list is read from the release branch, so the PR cannot widen it.
  const read = await readReleaseConfig({ github, owner, repo, base: releaseBranch });
  if (!read.ok) return { ok: false, reason: read.reason };
  const allowed = allowedReleaseFiles(read.config);

  for (const f of c.files) {
    // A sync-back only copies files; removing or renaming one deletes a path
    // on the target branch, which the release branch cannot vouch for.
    if (f.status === 'removed') return { ok: false, reason: `sync-back PR removes ${f.filename}` };
    if (f.status === 'renamed' || f.previous_filename) {
      return { ok: false, reason: `sync-back PR renames ${f.previous_filename} to ${f.filename}` };
    }
    if (!allowed.has(f.filename)) {
      return { ok: false, reason: `sync-back PR changes ${f.filename}, which release-please does not own` };
    }
    if (!f.sha) return { ok: false, reason: `the comparison reported no blob for ${f.filename}` };
  }
  // Same blob sha = same bytes as what was released.
  for (const f of c.files) {
    const rel = await releaseBlobSha({ github, owner, repo, path: f.filename, releaseBranch });
    if (rel.reason) return { ok: false, reason: rel.reason };
    if (rel.sha !== f.sha) return { ok: false, reason: `${f.filename} differs from ${releaseBranch}` };
  }

  return { ok: true, summary: `sync-back (${c.files.length} release file(s) identical to ${releaseBranch})` };
}

// Re-proved at the moment of merging: the release branch may have moved on
// since the evaluation, and an old copy must not be merged into develop.
async function mergeBlocker(ctx, deps) {
  const res = await evaluate(ctx, deps);
  return res.ok ? null : res.reason;
}

module.exports = {
  name: 'sync-back',
  requiresTip: false,
  defaultMatch,
  validateOptions,
  evaluate,
  mergeBlocker,
};
