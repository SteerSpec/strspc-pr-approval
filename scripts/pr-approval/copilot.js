// SPDX-License-Identifier: Apache-2.0
// Copilot's review as a veto (APPROVE-013). The kinds prove a PR from its
// author, commits and files; none of that can tell a correct template sync
// from one that drops half a config, which Copilot does catch (#17 replaced
// this repo's dependabot.yml and Copilot flagged it, yet template-sync would
// have approved it). So Copilot's latest review can refuse an approval, never
// grant one.
//
// The overview parser is ported from strspc-pr-review
// (scripts/pr-auto-approve/decide.js, overviewBlocker, v1.12.0), which
// documents the samples behind each pattern. Only its strict reading is kept:
// the verdict must be "Approval recommended", with no open issue. It proves a
// review clean rather than looking for known problems, so an unknown wording
// refuses instead of passing.

// Strict allowlist: a substring match on "copilot" could be any bot's login.
const COPILOT_LOGINS = new Set([
  'copilot-pull-request-reviewer[bot]',
  'github-copilot[bot]',
]);

const FENCED_CODE_RE = /```[\s\S]*?```/g;
const OVERVIEW_MARKER_RE = /<!--\s*ccr-overview\b[^>]*-->/i;
const KNOWN_VERDICT_RE = /^#{1,6}\s.*(?:Approval recommended|Changes recommended|Needs a closer look)/im;
const FIRST_HEADING_RE = /^#{1,6}\s+(.+?)\s*$/m;
const APPROVAL_VERDICT_RE = /^[^\p{L}\p{N}]*Approval recommended$/iu;
const PREVIOUSLY_MISSED_RE = /\b[1-9]\d*\s+previously missed|previously missed\s*\((?!0\))/i;
const OPEN_ISSUES_RE = /<summary\b[^>]*>(?:(?!<\/summary>)[\s\S])*?(\d+)\s+open issues?\b/i;
const NO_OPEN_ISSUES_RE = /^\s*\*\*No open issues\*\*/im;
const SECTION_RE = /<summary\b[^>]*>([\s\S]*?)<\/summary>/gi;
const SAFE_SECTION_RE = /^(?:What changed in this PR|\d+ resolved since last review)$/i;

const isCopilot = (review) => Boolean(review && review.user && COPILOT_LOGINS.has(review.user.login));

// The verdict heading of an overview body, '' when it has none; null when the
// body is not an overview.
function overviewVerdict(body) {
  const unfenced = String(body || '').replace(FENCED_CODE_RE, '');
  const isOverview = OVERVIEW_MARKER_RE.test(unfenced)
    || KNOWN_VERDICT_RE.test(unfenced)
    || OPEN_ISSUES_RE.test(unfenced)
    || NO_OPEN_ISSUES_RE.test(unfenced);
  if (!isOverview) return null;
  const heading = FIRST_HEADING_RE.exec(unfenced);
  return heading ? heading[1] : '';
}

// Why a review body is not clean (completes "Copilot's latest review …"), ''
// when it is. What proves it clean is read with code fences removed, what
// blocks it from the raw body, so a fence can only cause a refusal. An errored
// or quota-limited review has no overview, so it refuses too.
function overviewBlocker(body) {
  const verdict = overviewVerdict(body);
  if (verdict === null) return 'has no verdict overview';
  if (!APPROVAL_VERDICT_RE.test(verdict)) return `has verdict '${verdict || 'none'}'`;
  const raw = String(body || '');
  const unfenced = raw.replace(FENCED_CODE_RE, '');
  const open = OPEN_ISSUES_RE.exec(raw);
  if (open) return `lists ${open[1]} open issue(s)`;
  if (!NO_OPEN_ISSUES_RE.test(unfenced.split(/<details\b/i)[0])) return 'does not state no open issues';
  if (PREVIOUSLY_MISSED_RE.test(raw)) return 'lists a previously missed issue';
  const sections = [...raw.matchAll(SECTION_RE)];
  for (const [, inner] of sections) {
    const label = inner.replace(/<[^>]*>/g, '').trim();
    if (!SAFE_SECTION_RE.test(label)) return `has section '${label}'`;
  }
  if ((raw.match(/<details\b/gi) || []).length > sections.length) return "has section 'unlabelled'";
  return '';
}

// Copilot's most recent review on any commit, or null. Its overview covers
// every round, so the latest one is the standing verdict.
function latestCopilotReview(reviews = []) {
  let latest = null;
  for (const r of reviews) {
    if (!isCopilot(r) || r.state === 'PENDING') continue;
    const at = Date.parse(r.submitted_at || '') || 0;
    const best = latest ? (Date.parse(latest.submitted_at || '') || 0) : -1;
    if (!latest || at > best || (at === best && r.id > latest.id)) latest = r;
  }
  return latest;
}

// require.copilot-review: clean (APPROVE-013). Copilot must have reviewed this
// very head; a review of an older commit says nothing about the new one.
function copilotRequireBlocker({ reviews, headSha }) {
  const latest = latestCopilotReview(reviews);
  if (!latest) return 'Copilot has not reviewed the PR yet';
  if (latest.commit_id !== headSha) {
    return `Copilot's latest review is of ${String(latest.commit_id || 'unknown').slice(0, 8)}, not the head ${headSha.slice(0, 8)}`;
  }
  return null;
}

// The veto every policy gets (APPROVE-013): when Copilot has reviewed the PR,
// its latest review must be clean. A PR Copilot never reviewed passes here;
// a policy that needs one says so with require.copilot-review.
async function copilotVeto(ctx) {
  const latest = latestCopilotReview(await ctx.listReviews());
  if (!latest) return null;
  const why = overviewBlocker(latest.body);
  return why ? { reason: `Copilot's latest review (${latest.id}) ${why}` } : null;
}

module.exports = {
  COPILOT_LOGINS,
  isCopilot,
  overviewVerdict,
  overviewBlocker,
  latestCopilotReview,
  copilotRequireBlocker,
  copilotVeto,
};
