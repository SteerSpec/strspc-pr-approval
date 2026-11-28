# SPDX-License-Identifier: Apache-2.0
# shellcheck shell=bash
#
# Shared helpers for the pr-approval e2e harness. Ported from
# SteerSpec/strspc-pr-review e2e/pr-auto-approve/lib.sh; only what this
# harness uses so far.
#
# Entrypoints own `set -euo pipefail`; this file only defines state and
# functions, so sourcing it never changes the caller's shell options.
#
# Environment variables:
#   E2E_REPO                — the sandbox (default testbed-multi-org/strspc-pr-approval-sandbox)
#   E2E_GH_RETRIES, E2E_GH_RETRY_DELAY — retries of a gh call on a transient error (3, 10s)

if ((BASH_VERSINFO[0] < 4)); then
  printf 'error: Bash 4+ required (you are running %s). On macOS: brew install bash\n' "$BASH_VERSION" >&2
  exit 2
fi

REPO="${E2E_REPO:-testbed-multi-org/strspc-pr-approval-sandbox}"

log()  { printf '\033[1;34m[e2e]\033[0m %s\n' "$*"; }
ok()   { printf '\033[1;32m[ok]\033[0m  %s\n' "$*"; }
warn() { printf '\033[1;33m[warn]\033[0m %s\n' "$*" >&2; }
fail() { printf '\033[1;31m[fail]\033[0m %s\n' "$*" >&2; exit 1; }

# Every gh call goes through this and retries GitHub's transient failures: a
# 5xx, GraphQL's "Something went wrong" catch-all, or a connection that never
# reached GitHub. A 4xx fails at once, so a real refusal still fails. Only the
# last attempt's output is kept. Retry notes go to fd 3, a copy of stderr, so
# callers that parse `gh ... 2>&1` don't read them as output.
GH_TRANSIENT_RE='HTTP 5[0-9][0-9]|Something went wrong while executing your query|error connecting to api\.github\.com|i/o timeout|connection reset by peer'
exec 3>&2
gh() {
  local retries="${E2E_GH_RETRIES:-3}" delay="${E2E_GH_RETRY_DELAY:-10}" attempt=1 rc out err input=""
  local stdin=false
  [[ " $* " == *" --input - "* ]] && { input=$(cat); stdin=true; }
  out=$(mktemp) err=$(mktemp)
  while true; do
    if $stdin; then
      command gh "$@" >"$out" 2>"$err" <<<"$input" && rc=0 || rc=$?
    else
      command gh "$@" >"$out" 2>"$err" && rc=0 || rc=$?
    fi
    if ((rc == 0 || attempt > retries)) || ! grep -Eq "$GH_TRANSIENT_RE" "$err"; then
      cat "$out"
      cat "$err" >&2
      rm -f "$out" "$err"
      return "$rc"
    fi
    warn "transient GitHub error on gh ${1:-} ${2:-}, retry $attempt of $retries: $(head -c 160 "$err")" 2>&3
    sleep $((attempt * delay))
    attempt=$((attempt + 1))
  done
}

# Single-line base64: the contents API rejects wrapped payloads. BSD and GNU.
b64_oneline() {
  base64 | tr -d '\n\r '
}

require_gh() { # expected login
  local actor
  command -v gh >/dev/null || fail "gh not installed"
  actor=$(gh api user -q .login)
  [[ "$actor" == "$1" ]] || fail "gh is authed as '$actor', expected '$1'"
}

# One signed commit through createCommitOnBranch: the enterprise Signed Commit
# ruleset refuses an unsigned push, and this API signs as GitHub.
commit_file() { # branch, path, text, message
  local branch="$1" path="$2" text="$3" message="$4" head
  head=$(gh api "repos/$REPO/git/ref/heads/$branch" -q .object.sha)
  [[ -n "$head" ]] || fail "could not read $branch from $REPO"
  jq -n --arg repo "$REPO" --arg branch "$branch" --arg head "$head" --arg path "$path" \
    --arg message "$message" --arg contents "$(printf '%s' "$text" | b64_oneline)" '{
      query: "mutation($i: CreateCommitOnBranchInput!) { createCommitOnBranch(input: $i) { commit { oid } } }",
      variables: {i: {
        branch: {repositoryNameWithOwner: $repo, branchName: $branch},
        message: {headline: $message}, expectedHeadOid: $head,
        fileChanges: {additions: [{path: $path, contents: $contents}]}}}}' \
    | gh api graphql --input - -q .data.createCommitOnBranch.commit.oid
}

raw() { # repo, path, ref
  gh api "repos/$1/contents/$2?ref=$3" -H 'Accept: application/vnd.github.raw'
}

has_branch() { gh api "repos/$REPO/branches/$1" >/dev/null 2>&1; }

# --- PRs ------------------------------------------------------------------
#
# Scenario state, set by run.sh: the identities, the caller workflow, the poll
# interval and timeout, and LOG_DIR where finished runs' decision lines are kept.
BOT_LOGIN="${E2E_APPROVER_LOGIN:-cnslr-bt}"
# shellcheck disable=SC2034  # used by run.sh and sandbox.sh
ADMIN_LOGIN="${E2E_ADMIN_LOGIN:-pleberre}"
CALLER_WORKFLOW="${E2E_CALLER_WORKFLOW:-pr-approval.yml}"
# The App the sandbox's caller merges with (TESTBED_APP_ID), as GitHub names it
# in merged_by and on the runs its merges start.
# shellcheck disable=SC2034  # used by run.sh
MERGE_APP_LOGIN="${E2E_MERGE_APP_LOGIN:-steerspec-sync-testbed[bot]}"
TIMEOUT="${E2E_TIMEOUT:-300}"
POLL_INTERVAL="${E2E_POLL_INTERVAL:-10}"

new_branch() { # scenario
  printf 'e2e/%s-%s' "$1" "$(date -u +%Y%m%d-%H%M%S)"
}

# A branch off $1 with one commit adding $4, and a PR into $1. Prints the number.
open_pr() { # base, branch, title, path, [file content]
  local base="$1" branch="$2" title="$3" path="$4" text="${5:-e2e run: $2}" sha url
  sha=$(gh api "repos/$REPO/git/ref/heads/$base" -q .object.sha)
  [[ -n "$sha" ]] || fail "could not read $base from $REPO"
  gh api -X POST "repos/$REPO/git/refs" -f ref="refs/heads/$branch" -f sha="$sha" >/dev/null
  commit_file "$branch" "$path" "$text" "$title" >/dev/null
  url=$(gh pr create -R "$REPO" --base "$base" --head "$branch" --title "$title" \
    --body "e2e scenario PR, closed by the harness." 2>/dev/null | grep -E '/pull/[0-9]+$') ||
    fail "could not open a PR from $branch"
  printf '%s\n' "${url##*/}"
}

# Exit codes: 0 an approval of ours whose body matches $2 stands, 1 none, 2 the
# reviews could not be read.
has_bot_approval() { # pr, body regex
  local reviews
  reviews=$(gh api "repos/$REPO/pulls/$1/reviews?per_page=100" 2>/dev/null) || return 2
  jq -e --arg login "$BOT_LOGIN" --arg re "${2:-}" \
    'any(.[]; .user.login == $login and .state == "APPROVED" and ((.body // "") | test($re)))' \
    <<<"$reviews" >/dev/null
}

wait_for_approval() { # pr, body regex
  local deadline=$(($(date +%s) + TIMEOUT))
  while (($(date +%s) < deadline)); do
    has_bot_approval "$1" "${2:-}" && return 0
    sleep "$POLL_INTERVAL"
  done
  return 1
}

# No approval of ours stands, read without an API error.
not_approved() { # pr
  local rc=0 attempt
  for attempt in 1 2 3; do
    rc=0
    has_bot_approval "$1" || rc=$?
    ((rc != 2)) && break
    sleep "$POLL_INTERVAL"
  done
  ((rc == 1))
}

# An approval of ours was dismissed, and none stands.
wait_withdrawn() { # pr
  local deadline=$(($(date +%s) + TIMEOUT)) reviews
  while (($(date +%s) < deadline)); do
    if reviews=$(gh api "repos/$REPO/pulls/$1/reviews?per_page=100" 2>/dev/null) &&
      jq -e --arg login "$BOT_LOGIN" '
        any(.[]; .user.login == $login and .state == "DISMISSED") and
        (any(.[]; .user.login == $login and .state == "APPROVED") | not)' <<<"$reviews" >/dev/null; then
      return 0
    fi
    sleep "$POLL_INTERVAL"
  done
  return 1
}

# --- Decisions -----------------------------------------------------------
#
# A missing approval proves nothing: a crash, a wrong token and a skipped job
# all look like a correct refusal. So a scenario asserts what the action
# decided, from the line every evaluation logs:
#
#   pr-approval pr=<n> decision=<d> reason=<r>
#   pr-approval sweep decision=<d> reason=<r>    (a sweep's own outcome)
#
# The pr= field is what ties a run to a PR: workflow_run events carry the
# default branch, whichever PR they judged. "sweep" in place of a PR number
# reads the sweep's line.

# The name of the default branch's release-please PR branch for main.
# shellcheck disable=SC2034  # used by run.sh
RELEASE_BRANCH=release-please--branches--main

# "<decision> <reason>" for each evaluation of the PR since $2, oldest first,
# from runs of any event, or only of event $3. Returns 1 if anything could not
# be read, so empty output means "none".
decision_lines() { # pr|sweep, since, [event]
  local runs ids id file text key
  runs=$(gh run list -R "$REPO" --workflow "$CALLER_WORKFLOW" --limit 40 \
    --json databaseId,status,conclusion,createdAt,event 2>/dev/null) || return 1
  ids=$(jq -r --arg s "$2" --arg e "${3:-}" '[.[] | select(.status == "completed" and .createdAt >= $s
      and (.conclusion == "success" or .conclusion == "failure")
      and ($e == "" or .event == $e))]
    | sort_by(.createdAt) | .[].databaseId' <<<"$runs") || return 1
  key="pr=$1"
  [[ "$1" == sweep ]] && key=sweep
  for id in $ids; do
    file="$LOG_DIR/$id.log"
    if [[ ! -e "$file" ]]; then
      text=$(gh run view "$id" -R "$REPO" --log 2>/dev/null) || return 1
      grep -oE 'pr-approval (pr=[0-9a-z]+|sweep) decision=.*' <<<"$text" >"$file" || true
    fi
    sed -nE "s/^pr-approval $key decision=([a-z-]+) reason=(.*)\$/\1 \2/p" "$file"
  done
}

wait_decision() { # pr|sweep, decision, reason regex, since, [event]
  local deadline=$(($(date +%s) + TIMEOUT)) lines="" seen reason who="PR #$1"
  [[ "$1" == sweep ]] && who="the sweep"
  while (($(date +%s) < deadline)); do
    lines=$(decision_lines "$1" "$4" "${5:-}") || lines=""
    while read -r seen reason; do
      [[ "$seen" == "$2" && "$reason" =~ $3 ]] && return 0
    done <<<"$lines"
    sleep "$POLL_INTERVAL"
  done
  warn "$who: no '$2' decision matching /$3/${5:+ from a $5 run}. Decisions seen:"
  printf '%s\n' "${lines:-(none)}" >&2
  return 1
}

# Waits until no run of the caller is queued or in progress, so a scenario can
# change a variable without a run already under way reading the new value.
wait_caller_idle() {
  local deadline=$(($(date +%s) + TIMEOUT)) busy
  while (($(date +%s) < deadline)); do
    busy=$(gh run list -R "$REPO" --workflow "$CALLER_WORKFLOW" --limit 20 --json status \
      --jq '[.[] | select(.status != "completed")] | length' 2>/dev/null) || busy=1
    [[ "$busy" == 0 ]] && return 0
    sleep "$POLL_INTERVAL"
  done
  return 1
}

# Fails unless the sandbox's caller still runs the commit under test: a run
# sharing the sandbox would otherwise test someone else's commit.
assert_pinned() {
  [[ -n "${E2E_EXPECT_SHA:-}" ]] || return 0
  raw "$REPO" ".github/workflows/$CALLER_WORKFLOW" main |
    grep -q "strspc-pr-approval@$E2E_EXPECT_SHA\$" ||
    fail "the sandbox is not pinned to $E2E_EXPECT_SHA: another run changed it"
}

# Waits for a push run of the sandbox's Downstream workflow on commit $1 and
# prints the login that started it. GitHub starts none for a merge made with
# GITHUB_TOKEN, so the run itself is the proof.
wait_downstream() { # sha
  local deadline=$(($(date +%s) + TIMEOUT)) actor
  while (($(date +%s) < deadline)); do
    actor=$(gh api "repos/$REPO/actions/workflows/downstream.yml/runs?head_sha=$1&event=push" \
      --jq '.workflow_runs[0].actor.login // empty' 2>/dev/null) || actor=""
    [[ -n "$actor" ]] && { printf '%s\n' "$actor"; return 0; }
    sleep "$POLL_INTERVAL"
  done
  return 1
}
