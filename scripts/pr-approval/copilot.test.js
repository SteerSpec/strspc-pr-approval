// SPDX-License-Identifier: Apache-2.0
const test = require('node:test');
const assert = require('node:assert/strict');

const { overviewBlocker, latestCopilotReview, copilotRequireBlocker, copilotVeto } = require('./copilot.js');

const COPILOT = 'copilot-pull-request-reviewer[bot]';
const HEAD = 'a1'.repeat(20);
const OLD = 'b2'.repeat(20);
const CLEAN = '<!-- ccr-overview-v2 -->\n\n### 🟢 Approval recommended\n\nFine.\n\n**No open issues** 🎉\n\n<details>\n<summary><strong>What changed in this PR</strong></summary>\n\nx\n</details>\n';
const review = (id, commit, body, at, login = COPILOT) => ({ id, user: { login }, state: 'COMMENTED', commit_id: commit, body, submitted_at: at });

test('APPROVE-013: only an Approval recommended overview with no open issues is clean', () => {
  assert.equal(overviewBlocker(CLEAN), '');
  assert.equal(overviewBlocker(CLEAN.replace('Approval recommended', 'Needs a closer look')), "has verdict '🟢 Needs a closer look'");
  assert.equal(overviewBlocker(CLEAN.replace('**No open issues** 🎉\n', '')), 'does not state no open issues');
  assert.equal(overviewBlocker(`${CLEAN}<details><summary><strong>1 open issue</strong></summary></details>`), 'lists 1 open issue(s)');
  assert.equal(overviewBlocker(`${CLEAN}<details><summary>1 previously missed issue</summary></details>`), 'lists a previously missed issue');
  assert.equal(overviewBlocker(`${CLEAN}<details><summary>Low confidence</summary></details>`), "has section 'Low confidence'");
  assert.equal(overviewBlocker(`${CLEAN}<details>x</details>`), "has section 'unlabelled'");
});

test('APPROVE-013: an errored, quota-limited or empty review is not clean', () => {
  assert.equal(overviewBlocker('Copilot encountered an error and was unable to review this pull request.'), 'has no verdict overview');
  assert.equal(overviewBlocker(''), 'has no verdict overview');
  // A fence can hide what proves a review clean, never what blocks it.
  assert.equal(overviewBlocker(CLEAN.replace('**No open issues** 🎉', '```\n**No open issues**\n```')), 'does not state no open issues');
});

test('APPROVE-013: the latest Copilot review wins, other logins and pending reviews are ignored', () => {
  const reviews = [
    review(1, OLD, CLEAN, '2026-11-25T10:00:00Z'),
    review(2, HEAD, CLEAN, '2026-11-25T11:00:00Z'),
    review(3, HEAD, 'x', '2026-11-25T12:00:00Z', 'copilot-lookalike[bot]'),
    { ...review(4, HEAD, 'x', null), state: 'PENDING' },
  ];
  assert.equal(latestCopilotReview(reviews).id, 2);
  assert.equal(latestCopilotReview([]), null);
});

test('APPROVE-013: require.copilot-review needs a Copilot review of the head', () => {
  assert.equal(copilotRequireBlocker({ reviews: [], headSha: HEAD }), 'Copilot has not reviewed the PR yet');
  assert.equal(copilotRequireBlocker({ reviews: [review(1, OLD, CLEAN, '2026-11-25T10:00:00Z')], headSha: HEAD }),
    "Copilot's latest review is of b2b2b2b2, not the head a1a1a1a1");
  assert.equal(copilotRequireBlocker({ reviews: [review(1, HEAD, CLEAN, '2026-11-25T10:00:00Z')], headSha: HEAD }), null);
});

test('APPROVE-013: the veto passes a PR Copilot never reviewed and refuses a flagged one', async () => {
  assert.equal(await copilotVeto({ listReviews: async () => [] }), null);
  const v = await copilotVeto({ listReviews: async () => [review(9, HEAD, CLEAN.replace('Approval recommended', 'Changes recommended'), '2026-11-25T10:00:00Z')] });
  assert.deepEqual(v, { reason: "Copilot's latest review (9) has verdict '🟢 Changes recommended'" });
});
