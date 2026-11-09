// SPDX-License-Identifier: Apache-2.0
// custom: the escape hatch for PRs no built-in kind describes. It has no proof
// of its own beyond decide.js's universal guards (checks green, head repo,
// not draft, fresh approval per head) and the policy's own match and require.
//
// Three floors keep it from approving arbitrary PRs: policy.js refuses a
// custom policy without match.base and match.authors, or without a require
// that bounds the diff (paths or max-files); and every commit must be a
// verified commit by one of match.authors, since the PR author says nothing
// about commits pushed on top. `checks` does not bound anything here: a PR
// that can add a workflow can post a check of any name.

const { commitsBlocker } = require('./commits.js');

const BOUNDING_KEYS = ['paths', 'max-files'];

function defaultMatch() {
  return {};
}

// No options: anything here would be a knob nothing reads.
function validateOptions(options = {}) {
  return Object.keys(options).map((k) => `unknown key '${k}' (kind custom takes no options)`);
}

async function evaluate(ctx) {
  const req = ctx.policy && ctx.policy.require;
  // Same keys as policy.js's load-time check.
  if (!req || typeof req !== 'object' || !BOUNDING_KEYS.some((k) => k in req)) {
    return { ok: false, reason: `custom policy requires none of ${BOUNDING_KEYS.join(', ')}, so it would approve any matching PR` };
  }
  const authors = (ctx.policy.match && ctx.policy.match.authors) || [];
  if (!authors.length) return { ok: false, reason: 'custom policy names no match.authors' };
  const blocker = await commitsBlocker({
    github: ctx.github, owner: ctx.owner, repo: ctx.repo, pr: ctx.pr, author: authors, label: 'custom PR',
  });
  if (blocker) return { ok: false, reason: blocker };
  return { ok: true, summary: 'custom (policy conditions met)' };
}

module.exports = {
  name: 'custom',
  requiresTip: false,
  defaultMatch,
  validateOptions,
  evaluate,
  BOUNDING_KEYS,
};
