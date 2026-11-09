// SPDX-License-Identifier: Apache-2.0
// The built-in kinds. Each module exports the same shape:
//
//   name              the value of a policy's `kind`
//   requiresTip       true when the head must be the tip of its branch
//   defaultMatch(options) -> match keys used when the policy leaves them out
//   validateOptions(options) -> string[] of errors for the `options` block
//   evaluate(ctx) -> { ok: true, summary, mergeBase? } | { ok: false, reason }
//   mergeBlocker(ctx) -> reason | null      (optional; checked again before a merge)
//
// ctx = { github, owner, repo, pr, policy, options, compare, checkRuns, core }
// where compare() is a memoised compareHead() of the evaluated head against
// its base (util.js), and checkRuns are the head's deduped check runs.
//
// A kind's checks are the floor (APPROVE-010): `options` may only narrow them,
// and validateOptions refuses any option that would widen one.

const kinds = {
  promotion: require('./promotion.js'),
  release: require('./release.js'),
  'sync-back': require('./sync-back.js'),
  pin: require('./pin.js'),
  'template-sync': require('./template-sync.js'),
  custom: require('./custom.js'),
};

module.exports = kinds;
