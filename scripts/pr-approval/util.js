// SPDX-License-Identifier: Apache-2.0
// Helpers shared by decide.js, the kinds and merge.js. Most are ported from
// strspc-pr-review's decide.js, where the comments explain the incidents that
// shaped them; the short versions are kept here.

// Every client is built here so a transient 5xx is retried (3 times, through
// @octokit/plugin-retry, which github-script v9's getOctokit carries). 4xx stay
// unretried. Do NOT use github-script's `retries` input instead: it retries
// every status, exempt ones included, with no delay.
const API_RETRIES = 3;
function makeApiClient(getOctokit, token) {
  return getOctokit(token, { retry: { enabled: true, retries: API_RETRIES } });
}

// Drop the API host so a reason stays readable in a check summary.
const stripApiHost = (url) => String(url).replace(/^https?:\/\/[^/]+/, '');

const describeError = (err) => `${(err && err.status) || ''} ${(err && err.message) || err}`.trim();

// A completed check that blocks approval (APPROVE-002). cancelled and stale
// pass, as in strspc-pr-review: a concurrency group cancels superseded runs
// (other approval bots' included), and the dedupe below keeps only the latest
// attempt per check, so a cancelled run left standing is not hiding a newer
// failure. Merging stays safe either way: GitHub treats a cancelled REQUIRED
// check as failing, and merge.js merges only a `clean` PR.
const CHECK_OK_CONCLUSIONS = ['success', 'neutral', 'skipped', 'cancelled', 'stale'];
const isFailedCheck = (cr) =>
  cr.status === 'completed' && !CHECK_OK_CONCLUSIONS.includes(cr.conclusion);

// Deduping by (name, app) means a later run with the same name hides an
// earlier failure, so a workflow that can run from the PR head could mask a
// red check. Every kind closes that by proving who made the head's commits
// (the bot, or merged approved PRs, or match.authors for custom), so no
// unreviewed workflow file reaches the head. Keep that true for new kinds.
//
// Check runs for a SHA, without this workflow's own run or an UNFINISHED run
// of a check with this job's name (a sibling the concurrency group is about to
// cancel), deduped by (name, app) keeping the latest attempt. A completed run
// with the same name still counts: names are not unique across workflows, so
// it may be someone's CI. A cancelled sibling passes anyway (see above).
// Job names of the companion approver, strspc-pr-review (its caller's job id).
// Both actions start on the same events, so each finds the other's job still
// running; waiting on it stalls the PR, since its completion re-triggers
// nothing. Like this action's own job, it gates approval rather than testing
// the code, so an UNFINISHED run of it is ignored (APPROVE-002).
const COMPANION_JOBS = ['auto-approve'];

// A name alone does not identify the companion: a repository may have CI
// named the same. An unfinished run is only taken for the companion when
// GitHub Actions runs it from the companion's caller workflow file (the
// `companion-workflow` input, default .github/workflows/auto-approve.yml) for
// an event an approver listens to; CI runs on pull_request, push or
// merge_group. These events run the workflow from the default branch, except
// pull_request_review, which a same-repository PR could define; that PR author
// already controls its own CI, so it gains nothing. companion-workflow 'off'
// (an empty value here) turns the exemption off. Anything unproven, a failed
// lookup included, still counts as pending.
const DEFAULT_COMPANION_WORKFLOW = '.github/workflows/auto-approve.yml';
const COMPANION_EVENTS = new Set(['pull_request_target', 'pull_request_review', 'check_run', 'workflow_run']);
const ACTIONS_APP_SLUG = 'github-actions';
const RUN_ID_RE = /\/actions\/runs\/(\d+)(?:\/|$)/;

// A run's path can carry the ref it ran from ("file.yml@refs/heads/x").
const workflowFile = (p) => String(p || '').split('@')[0];

// The GitHub Actions run behind a check, or null when it is not one or cannot
// be read. Cached per run: a run's jobs share it.
function workflowRunOf({ github, owner, repo, cr, cache }) {
  if (!cr.app || cr.app.slug !== ACTIONS_APP_SLUG) return null;
  const m = RUN_ID_RE.exec(cr.details_url || '');
  if (!m) return null;
  if (!cache.has(m[1])) {
    cache.set(m[1], github.rest.actions.getWorkflowRun({ owner, repo, run_id: Number(m[1]) })
      .then(({ data }) => data, () => null));
  }
  return cache.get(m[1]);
}

async function isCompanionRun({ github, owner, repo, cr, cache, companionWorkflow }) {
  if (!companionWorkflow) return false;
  const run = await workflowRunOf({ github, owner, repo, cr, cache });
  return Boolean(run) && COMPANION_EVENTS.has(run.event) && workflowFile(run.path) === companionWorkflow;
}

// A sweep (APPROVE-014) runs on the default branch's tip, which is the head of
// every promotion from it. Its check there judged other PRs, not that code,
// and one red sweep would refuse every such promotion until the next one. So a
// run of this job or of the companion's, from its own workflow file, started
// by a schedule or by a dispatch of the default branch, is ignored whether or
// not it has finished (APPROVE-002). A dispatch of another branch runs that
// branch's copy of the file, so it still counts.
const SWEEP_EVENTS = new Set(['schedule', 'workflow_dispatch']);
async function isSweepRun({ github, owner, repo, cr, cache, workflow, defaultBranch }) {
  if (!workflow) return false;
  const run = await workflowRunOf({ github, owner, repo, cr, cache });
  if (!run || workflowFile(run.path) !== workflow || !SWEEP_EVENTS.has(run.event)) return false;
  return run.event === 'schedule' || (Boolean(defaultBranch) && run.head_branch === defaultBranch);
}

async function fetchCheckRuns({
  github, context, owner, repo, headSha, selfJobNames = [], companionWorkflow = DEFAULT_COMPANION_WORKFLOW,
  selfWorkflow = '', defaultBranch = '',
}) {
  const all = [];
  let page = 1;
  while (true) {
    const { data } = await github.rest.checks.listForRef({ owner, repo, ref: headSha, per_page: 100, page });
    const runs = data.check_runs || [];
    all.push(...runs);
    if (all.length >= data.total_count || runs.length === 0) break;
    page++;
  }
  const selfRunRe = new RegExp(`/runs/${String(context.runId)}(/|$)`);
  // A companion name always goes through the provenance check, even when a
  // caller named its own job the same: a name shortcut would let CI of that
  // name through. This run is already dropped by its URL above.
  const companionJobs = new Set(COMPANION_JOBS);
  const selfJobs = new Set(['strspc-pr-approval', context.job, ...selfJobNames]
    .filter((n) => n && !companionJobs.has(n)));
  const cache = new Map();
  const notSelf = [];
  for (const cr of all) {
    if (cr == null) continue;
    if (cr.details_url && selfRunRe.test(cr.details_url)) continue;
    const sweepOf = selfJobs.has(cr.name) ? selfWorkflow : (companionJobs.has(cr.name) ? companionWorkflow : '');
    if (sweepOf && await isSweepRun({ github, owner, repo, cr, cache, workflow: sweepOf, defaultBranch })) continue;
    if (cr.status !== 'completed') {
      if (selfJobs.has(cr.name)) continue;
      if (companionJobs.has(cr.name) && await isCompanionRun({ github, owner, repo, cr, cache, companionWorkflow })) continue;
    }
    notSelf.push(cr);
  }
  const latest = new Map();
  for (const cr of notSelf) {
    const key = `${cr.name}::${cr.app && cr.app.id}`;
    const stamp = cr.started_at || cr.completed_at;
    const ts = stamp ? (Date.parse(stamp) || 0) : Infinity;
    const prev = latest.get(key);
    if (!prev || ts > prev._ts || (ts === prev._ts && (cr.id || 0) > (prev.id || 0))) {
      latest.set(key, Object.assign({}, cr, { _ts: ts }));
    }
  }
  return [...latest.values()];
}

// The compare endpoint lists at most 300 files, so a list that long cannot
// prove anything about the files it leaves out. null means "cannot tell".
const MAX_LISTED_FILES = 300;
function changedFileNames(changed) {
  if (changed.length >= MAX_LISTED_FILES) return null;
  return changed.flatMap((f) => [f.filename, f.previous_filename]).filter(Boolean);
}

// Changed files of exactly `headSha` (three-dot against `heads/<base>`, so a
// tag of the same name cannot shadow the branch), plus the merge base that
// proves the base was not rewritten between the listing and the approval.
// `baseSha` (backtest only) compares against the base as it was, since a
// merged head is already contained in today's base branch.
async function compareHead({ github, owner, repo, baseRef, headSha, baseSha = null }) {
  const { data } = await github.rest.repos.compareCommitsWithBasehead({
    owner, repo, basehead: `${baseSha || `heads/${baseRef}`}...${headSha}`, per_page: 1,
  });
  return {
    names: Array.isArray(data.files) ? changedFileNames(data.files) : null,
    files: Array.isArray(data.files) && data.files.length < MAX_LISTED_FILES ? data.files : null,
    mergeBase: (data.merge_base_commit && data.merge_base_commit.sha) || null,
    totalCommits: data.total_commits,
    // Commits on the base that the head lacks.
    behindBy: Number(data.behind_by) || 0,
  };
}

function globToRegExp(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') {
      if (glob[i + 2] === '/') { re += '(?:.*/)?'; i += 2; } else { re += '.*'; i += 1; }
    } else if (c === '*') {
      re += '[^/]*';
    } else if (c === '?') {
      re += '[^/]';
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${re}$`);
}

const toList = (v) => (v === undefined || v === null ? [] : Array.isArray(v) ? v : [v]);

// True when `value` matches any glob of `globs` (a string or a list).
function matchesAnyGlob(value, globs) {
  return toList(globs).some((g) => globToRegExp(String(g)).test(String(value)));
}

// True when every file matches one of the globs. An empty or unknown list
// proves nothing, so it does not qualify.
function filesMatchPaths(filenames, globs) {
  const list = toList(globs);
  if (!filenames || !filenames.length || !list.length) return false;
  const res = list.map((g) => globToRegExp(String(g)));
  return filenames.every((f) => res.some((re) => re.test(f)));
}

// Dismissing needs write access, not the bot's identity: retry once with the
// workflow token when the bot PAT is refused.
async function dismissReview({ github, botGithub, params }) {
  try {
    return await botGithub.rest.pulls.dismissReview(params);
  } catch (err) {
    if (botGithub === github || ![401, 403].includes(err.status)) throw err;
    return github.rest.pulls.dismissReview(params);
  }
}

// "fix(scope)!: x" -> { type: 'fix', breaking: true }; null when not conventional.
function parseConventionalTitle(title) {
  const m = /^\s*([A-Za-z]+)(?:\([^)]*\))?(!?):/.exec(String(title || ''));
  if (!m) return null;
  return { type: m[1].toLowerCase(), breaking: Boolean(m[2]) };
}

// Two versions in semver precedence: the release part numerically, then a
// prerelease ranks below its release (1.0.0-rc.1 < 1.0.0) and prerelease
// identifiers compare numerically when both are numbers, else as text.
function compareVersions(a, b) {
  const split = (v) => {
    const s = String(v).replace(/^v/, '').split('+')[0];
    const i = s.indexOf('-');
    return i === -1 ? [s.split('.'), null] : [s.slice(0, i).split('.'), s.slice(i + 1).split('.')];
  };
  const cmpParts = (pa, pb, missing) => {
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
      if (pa[i] === undefined || pb[i] === undefined) {
        if (missing === 'zero') {
          const x = Number(pa[i] === undefined ? 0 : pa[i]);
          const y = Number(pb[i] === undefined ? 0 : pb[i]);
          if (x !== y) return x < y ? -1 : 1;
          continue;
        }
        return pa[i] === undefined ? -1 : 1; // fewer prerelease fields rank lower
      }
      const x = pa[i];
      const y = pb[i];
      const nx = /^\d+$/.test(x) ? Number(x) : NaN;
      const ny = /^\d+$/.test(y) ? Number(y) : NaN;
      if (!Number.isNaN(nx) && !Number.isNaN(ny)) {
        if (nx !== ny) return nx < ny ? -1 : 1;
      } else if (!Number.isNaN(nx)) {
        return -1;
      } else if (!Number.isNaN(ny)) {
        return 1;
      } else if (x !== y) {
        return x < y ? -1 : 1;
      }
    }
    return 0;
  };
  const [ra, pa] = split(a);
  const [rb, pb] = split(b);
  const rel = cmpParts(ra, rb, 'zero');
  if (rel !== 0) return rel;
  if (!pa && !pb) return 0;
  if (!pa) return 1;
  if (!pb) return -1;
  return cmpParts(pa, pb, 'shorter');
}

module.exports = {
  API_RETRIES,
  MAX_LISTED_FILES,
  CHECK_OK_CONCLUSIONS,
  COMPANION_JOBS,
  COMPANION_EVENTS,
  DEFAULT_COMPANION_WORKFLOW,
  makeApiClient,
  stripApiHost,
  describeError,
  isFailedCheck,
  fetchCheckRuns,
  changedFileNames,
  compareHead,
  globToRegExp,
  toList,
  matchesAnyGlob,
  filesMatchPaths,
  dismissReview,
  parseConventionalTitle,
  compareVersions,
};
