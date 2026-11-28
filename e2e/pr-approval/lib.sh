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
