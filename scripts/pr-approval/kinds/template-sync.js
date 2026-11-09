// SPDX-License-Identifier: Apache-2.0
// template-sync (APPROVE-009): strspc-sync opens a PR per template update
// (head steerspec-sync/<template>/<version>, label steerspec-sync), usually
// touching one file.
//
// The proof: the configured bot wrote it and every commit on it (verified,
// see commits.js), it carries the configured label, its head names a template
// and a version, and no newer PR for the same template is open, so an older
// sync can never be approved over the one that supersedes it.
//
// options.paths is optional and may narrow the files it may change. Without
// it there is no file bound: the proof then rests on bot authorship plus
// verification alone, i.e. on trusting what the bot itself commits.

const { matchesAnyGlob, compareVersions } = require('../util.js');
const { commitsBlocker } = require('./commits.js');

const HEAD_PREFIX = 'steerspec-sync';
const DEFAULT_LABEL = 'steerspec-sync';
const VERSION_RE = /^v?\d+(?:\.\d+)*(?:-[0-9A-Za-z][0-9A-Za-z.-]*)?$/;
const TEMPLATE_RE = /^[A-Za-z0-9._-]+$/;
const OPTION_KEYS = ['author', 'label', 'paths'];

const isNonEmptyString = (v) => typeof v === 'string' && v.trim() !== '';
const labelNames = (pr) => (pr.labels || []).map((l) => (typeof l === 'string' ? l : l && l.name));

// steerspec-sync/<template>/<version> -> { template, version }, or null.
function parseSyncHead(ref) {
  const parts = String(ref || '').split('/');
  if (parts.length !== 3 || parts[0] !== HEAD_PREFIX) return null;
  const [, template, version] = parts;
  if (!TEMPLATE_RE.test(template) || template === '.' || template === '..') return null;
  if (!VERSION_RE.test(version)) return null;
  return { template, version };
}

function defaultMatch(options = {}) {
  const label = isNonEmptyString(options.label) ? options.label : DEFAULT_LABEL;
  const match = { head: `${HEAD_PREFIX}/*/*`, labels: [label] };
  if (isNonEmptyString(options.author)) match.authors = [options.author];
  return match;
}

function validateOptions(options = {}) {
  const errors = [];
  for (const k of Object.keys(options)) if (!OPTION_KEYS.includes(k)) errors.push(`unknown key '${k}'`);
  if (!('author' in options)) errors.push('author is required (the login that opens template sync PRs)');
  else if (!isNonEmptyString(options.author)) errors.push('author must be a non-empty string');
  if ('label' in options && !isNonEmptyString(options.label)) errors.push('label must be a non-empty string');
  // There is no built-in path list, so any list of paths only narrows.
  if ('paths' in options && (!Array.isArray(options.paths) || options.paths.length === 0 || !options.paths.every(isNonEmptyString))) {
    errors.push('paths must be a non-empty list of globs');
  }
  return errors;
}

// The open PR by `author` for `template` with the highest version above
// `version`, or null.
async function newerSync({ github, owner, repo, pr, template, version, author }) {
  const open = await github.paginate(github.rest.pulls.list, { owner, repo, state: 'open', per_page: 100 });
  let newest = null;
  for (const other of open) {
    if (other.number === pr.number) continue;
    // Only the bot's own PRs supersede: anyone can open a branch named like
    // a newer version, and that must not block every sync.
    if (!(other.user && other.user.login === author)) continue;
    const parsed = parseSyncHead(other.head && other.head.ref);
    if (!parsed || parsed.template !== template || compareVersions(parsed.version, version) <= 0) continue;
    if (!newest || compareVersions(parsed.version, newest.version) > 0) newest = { number: other.number, version: parsed.version };
  }
  return newest;
}

async function evaluate(ctx) {
  const { github, owner, repo, pr } = ctx;
  const options = ctx.options || {};
  const author = options.author;
  const label = isNonEmptyString(options.label) ? options.label : DEFAULT_LABEL;

  // The policy's match may override head, authors and labels, so check again.
  if (!isNonEmptyString(author)) return { ok: false, reason: 'template-sync: options.author is not set' };
  const login = pr.user && pr.user.login;
  if (login !== author) return { ok: false, reason: `template-sync PR author ${login || 'unknown'} is not ${author}` };
  const head = pr.head && pr.head.ref;
  const parsed = parseSyncHead(head);
  if (!parsed) return { ok: false, reason: `head ${head} is not ${HEAD_PREFIX}/<template>/<version>` };
  if (!labelNames(pr).includes(label)) return { ok: false, reason: `template-sync PR does not carry label '${label}'` };
  const blocker = await commitsBlocker({ github, owner, repo, pr, author, label: 'template-sync PR' });
  if (blocker) return { ok: false, reason: blocker };

  if (options.paths) {
    const c = await ctx.compare();
    if (!c.names) return { ok: false, reason: 'template-sync PR changed files cannot be completely listed' };
    if (c.names.length === 0) return { ok: false, reason: 'template-sync PR changes no files' };
    const outside = c.names.find((n) => !matchesAnyGlob(n, options.paths));
    if (outside) return { ok: false, reason: `template-sync PR changes ${outside}, outside options.paths` };
  }

  const newer = await newerSync({ github, owner, repo, pr, ...parsed, author });
  if (newer) return { ok: false, reason: `superseded by #${newer.number} (${newer.version})` };

  return { ok: true, summary: `template-sync (${parsed.template} ${parsed.version})` };
}

// A newer sync of the same template can open between the approval and the merge.
async function mergeBlocker(ctx) {
  const parsed = parseSyncHead(ctx.pr.head && ctx.pr.head.ref);
  if (!parsed) return `head ${ctx.pr.head && ctx.pr.head.ref} is not ${HEAD_PREFIX}/<template>/<version>`;
  const newer = await newerSync({ ...ctx, ...parsed, author: (ctx.options || {}).author });
  return newer ? `superseded by #${newer.number} (${newer.version})` : null;
}

module.exports = {
  name: 'template-sync',
  requiresTip: false,
  defaultMatch,
  validateOptions,
  evaluate,
  mergeBlocker,
  parseSyncHead,
};
