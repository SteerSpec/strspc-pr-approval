// SPDX-License-Identifier: Apache-2.0
// pin (APPROVE-008): strspc-rules opens a PR in every consumer that pins
// dev.steerspec.core to a new version (head chore/core-<version>, e.g.
// chore/core-1.24.0), touching only rules/realm.json, .strspc/config.yaml and
// the vendored schemas under rules/_schema/.
//
// The proof: the configured bot wrote it and every commit on it (verified,
// see commits.js, so no one can push onto the bot's branch), the head names a
// version, every
// changed file is in the built-in allow-list (and in options.files, which may
// only narrow it), and no newer pin PR is open, so an older pin can never be
// approved over the one that supersedes it.

const { matchesAnyGlob, compareVersions } = require('../util.js');
const { commitsBlocker } = require('./commits.js');

const HEAD_PREFIX = 'chore/core-';
const ALLOWED_FILES = ['rules/realm.json', '.strspc/config.yaml', 'rules/_schema/**'];
const SCHEMA_DIR = 'rules/_schema/';
const VERSION_RE = /^v?\d+(?:\.\d+)*(?:-[0-9A-Za-z][0-9A-Za-z.-]*)?$/;
const OPTION_KEYS = ['author', 'files'];

const isNonEmptyString = (v) => typeof v === 'string' && v.trim() !== '';

// The version a pin head names, or null.
function pinVersion(ref) {
  const value = String(ref || '');
  if (!value.startsWith(HEAD_PREFIX)) return null;
  const version = value.slice(HEAD_PREFIX.length);
  return VERSION_RE.test(version) ? version : null;
}

// True when `glob` can only match paths the built-in allow-list already
// allows. Conservative on purpose: anything it cannot prove is refused.
function withinAllowList(glob) {
  if (ALLOWED_FILES.includes(glob)) return true;
  if (glob.split('/').some((seg) => seg === '..' || seg === '.' || seg === '')) return false;
  if (!/[*?]/.test(glob)) return matchesAnyGlob(glob, ALLOWED_FILES);
  return glob.startsWith(SCHEMA_DIR) && glob.length > SCHEMA_DIR.length;
}

function defaultMatch(options = {}) {
  const match = { head: `${HEAD_PREFIX}*` };
  if (isNonEmptyString(options.author)) match.authors = [options.author];
  return match;
}

function validateOptions(options = {}) {
  const errors = [];
  for (const k of Object.keys(options)) if (!OPTION_KEYS.includes(k)) errors.push(`unknown key '${k}'`);
  if (!('author' in options)) errors.push('author is required (the login that opens pin PRs)');
  else if (!isNonEmptyString(options.author)) errors.push('author must be a non-empty string');
  if ('files' in options) {
    const files = options.files;
    if (!Array.isArray(files) || files.length === 0 || !files.every(isNonEmptyString)) {
      errors.push('files must be a non-empty list of globs');
    } else {
      // APPROVE-010: options may only narrow the built-in allow-list.
      for (const g of files) {
        if (!withinAllowList(g)) errors.push(`files: '${g}' is outside the built-in allow-list (${ALLOWED_FILES.join(', ')})`);
      }
    }
  }
  return errors;
}

// The open pin PR by `author` with the highest version above `version`, or null.
async function newerPin({ github, owner, repo, pr, version, author }) {
  const open = await github.paginate(github.rest.pulls.list, { owner, repo, state: 'open', per_page: 100 });
  let newest = null;
  for (const other of open) {
    if (other.number === pr.number) continue;
    // Only the bot's own PRs supersede: anyone can open a branch named like
    // a newer version, and that must not block every pin.
    if (!(other.user && other.user.login === author)) continue;
    const v = pinVersion(other.head && other.head.ref);
    if (!v || compareVersions(v, version) <= 0) continue;
    if (!newest || compareVersions(v, newest.version) > 0) newest = { number: other.number, version: v };
  }
  return newest;
}

async function evaluate(ctx) {
  const { github, owner, repo, pr } = ctx;
  const options = ctx.options || {};
  const author = options.author;

  // The policy's match may override head and authors, so check again here.
  if (!isNonEmptyString(author)) return { ok: false, reason: 'pin: options.author is not set' };
  const login = pr.user && pr.user.login;
  if (login !== author) return { ok: false, reason: `pin PR author ${login || 'unknown'} is not ${author}` };
  const head = pr.head && pr.head.ref;
  const version = pinVersion(head);
  if (!version) return { ok: false, reason: `head ${head} is not ${HEAD_PREFIX}<version>` };
  const blocker = await commitsBlocker({ github, owner, repo, pr, author, label: 'pin PR' });
  if (blocker) return { ok: false, reason: blocker };

  const c = await ctx.compare();
  if (!c.names) return { ok: false, reason: 'pin PR changed files cannot be completely listed' };
  if (c.names.length === 0) return { ok: false, reason: 'pin PR changes no files' };
  // Both lists, always: the built-in one is the floor whatever options say.
  for (const name of c.names) {
    if (!matchesAnyGlob(name, ALLOWED_FILES)) return { ok: false, reason: `pin PR changes ${name}, outside the pin allow-list` };
    if (options.files && !matchesAnyGlob(name, options.files)) {
      return { ok: false, reason: `pin PR changes ${name}, outside options.files` };
    }
  }

  const newer = await newerPin({ github, owner, repo, pr, version, author });
  if (newer) return { ok: false, reason: `superseded by #${newer.number} (${newer.version})` };

  const files = new Set(c.names).size;
  return { ok: true, summary: `pin (dev.steerspec.core ${version}, ${files} file(s))` };
}

// A newer pin can open between the approval and the merge.
async function mergeBlocker(ctx) {
  const version = pinVersion(ctx.pr.head && ctx.pr.head.ref);
  if (!version) return `head ${ctx.pr.head && ctx.pr.head.ref} is not ${HEAD_PREFIX}<version>`;
  const newer = await newerPin({ ...ctx, version, author: (ctx.options || {}).author });
  return newer ? `superseded by #${newer.number} (${newer.version})` : null;
}

module.exports = {
  name: 'pin',
  requiresTip: false,
  defaultMatch,
  validateOptions,
  evaluate,
  mergeBlocker,
  ALLOWED_FILES,
  pinVersion,
  withinAllowList,
};
