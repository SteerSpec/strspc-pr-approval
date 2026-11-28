#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
#
# Keeps the e2e sandbox in a known shape, as code. Ported from
# SteerSpec/strspc-pr-review e2e/pr-auto-approve/sandbox.sh.
#
#   sandbox.sh setup               one-time, as the enterprise owner: bot access,
#                                  rulesets, a develop branch
#   sandbox.sh sync <sha>          put the action at <sha> under test: the caller,
#                                  a CI stub and the policy on main, develop on main
#   sandbox.sh reset               close the harness's PRs, put develop back on main
#   sandbox.sh check-tokens <sha>  run token-check.sh at <sha> inside the sandbox,
#                                  against the secrets its caller will see
#   sandbox.sh status              show the sandbox's branches, rulesets and secrets
#
# Everything is idempotent: a re-run repairs drift instead of failing on it.
set -euo pipefail

SCRIPT_DIR="$(cd "${BASH_SOURCE[0]%/*}" && pwd)"
# shellcheck source=e2e/pr-approval/lib.sh
source "$SCRIPT_DIR/lib.sh"

ACTION_REPO="${ACTION_REPO:-SteerSpec/strspc-pr-approval}"
# The secrets the sandbox's caller reads. None is a production secret: the code
# under test runs with them, and it can be any commit of this repo.
#   BOT_TOKEN_SANDBOX    cnslr-bt's sandbox-only token (a testbed-multi-org secret)
#   TESTBED_APP_ID       steerspec-sync-testbed, the App that merges here
#   TESTBED_PRIVATE_KEY
BOT_SECRET_NAME=BOT_TOKEN_SANDBOX
APP_ID_SECRET_NAME=TESTBED_APP_ID
APP_KEY_SECRET_NAME=TESTBED_PRIVATE_KEY
# actions/create-github-app-token v3.3.0, as in templates/pr-approval.yml.
APP_TOKEN_ACTION="actions/create-github-app-token@64ab729a6294000f5aa4a4bc0b73d1f32bc45510 # v3.3.0"
CHECKOUT_ACTION="actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1"

# --- setup ------------------------------------------------------------------

# Production's merge-method rulesets: merge commit into main, squash into
# develop, one approval. The enterprise owner may bypass them, because the
# harness commits to main and force-moves develop. The bot and the merge App
# have no bypass, so a merge they make proves the rules were met.
ruleset() { # name, ref, merge method(s) as a JSON array
  jq -n --arg name "$1" --arg ref "$2" --argjson methods "$3" '{
    name: $name, target: "branch", enforcement: "active",
    bypass_actors: [{actor_id: null, actor_type: "EnterpriseOwner", bypass_mode: "always"}],
    conditions: {ref_name: {include: [$ref], exclude: []}},
    rules: [{type: "pull_request", parameters: {
      allowed_merge_methods: $methods,
      dismiss_stale_reviews_on_push: true,
      require_code_owner_review: false,
      require_last_push_approval: false,
      required_approving_review_count: 1,
      required_review_thread_resolution: true}}]}'
}

# Writes the whole definition either way, so a re-run repairs a drifted ruleset.
ensure_ruleset() { # name, ref, methods
  local id
  id=$(gh api "repos/$REPO/rulesets" | jq -r --arg n "$1" '.[] | select(.name == $n) | .id')
  if [[ -n "$id" ]]; then
    ruleset "$@" | gh api -X PUT "repos/$REPO/rulesets/$id" --input - >/dev/null
    log "ruleset $1 updated"
  else
    ruleset "$@" | gh api -X POST "repos/$REPO/rulesets" --input - >/dev/null
    log "ruleset $1 created"
  fi
}

setup() {
  require_gh "$ADMIN_LOGIN"
  # An approval counts only from an account with write access.
  gh api -X PUT "repos/$REPO/collaborators/$BOT_LOGIN" -f permission=push >/dev/null
  log "$BOT_LOGIN has write"
  ensure_ruleset pr-mandatory-main refs/heads/main '["merge"]'
  ensure_ruleset pr-mandatory-develop refs/heads/develop '["squash"]'
  if ! has_branch develop; then
    gh api -X POST "repos/$REPO/git/refs" -f ref=refs/heads/develop \
      -f sha="$(gh api "repos/$REPO/git/ref/heads/main" -q .object.sha)" >/dev/null
    log "develop created from main"
  fi
  ok "$REPO set up"
}

# --- check-tokens -----------------------------------------------------------

# Commits only a real change, so a re-run moves nothing.
put() { # path, content
  local current
  current=$(raw "$REPO" "$1" main 2>/dev/null || true)
  [[ "$current" == "$2" ]] && return 0
  commit_file main "$1" "$2"$'\n' "chore(e2e): sync $1" >/dev/null
  log "updated $1"
}

# Runs token-check.sh at $1 inside the sandbox, so it sees the secrets exactly
# as the caller will: an org secret, unless a repo secret of the same name
# shadows it. It mints the merge token the way the caller does. Dispatch only;
# it reads no PR input.
token_check_workflow() { # sha
  local repo_name="${REPO#*/}" owner="${REPO%%/*}"
  cat <<EOF
name: Token check

# Managed by $ACTION_REPO e2e/pr-approval/sandbox.sh check-tokens.
on:
  workflow_dispatch:

permissions:
  contents: read

jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: $CHECKOUT_ACTION
        with:
          repository: $ACTION_REPO
          ref: $1
          persist-credentials: false
      - id: merge-token
        uses: $APP_TOKEN_ACTION
        with:
          app-id: \${{ secrets.$APP_ID_SECRET_NAME }}
          private-key: \${{ secrets.$APP_KEY_SECRET_NAME }}
          owner: $owner
          repositories: $repo_name
          # As the caller mints it: a token wider than the merge needs would pass
          # here and hide a scope the caller lacks.
          permission-contents: write
          permission-pull-requests: write
      - env:
          $BOT_SECRET_NAME: \${{ secrets.$BOT_SECRET_NAME }}
          MERGE_TOKEN: \${{ steps.merge-token.outputs.token }}
        run: e2e/pr-approval/token-check.sh "\$GITHUB_REPOSITORY" $BOT_SECRET_NAME@$BOT_LOGIN MERGE_TOKEN+contents
EOF
}

# The write probes need an open PR. With none, one is opened from a throwaway
# branch and closed again on exit.
PROBE_BRANCH=""
PROBE_PR=""
# shellcheck disable=SC2329  # invoked by the trap
drop_probe_pr() {
  [[ -n "$PROBE_PR" ]] && gh pr close "$PROBE_PR" -R "$REPO" >/dev/null 2>&1 || true
  [[ -n "$PROBE_BRANCH" ]] && gh api -X DELETE "repos/$REPO/git/refs/heads/$PROBE_BRANCH" >/dev/null 2>&1 || true
}

ensure_open_pr() {
  local open
  open=$(gh pr list -R "$REPO" --state open --limit 1 --json number --jq '.[0].number // empty')
  [[ -n "$open" ]] && return 0
  PROBE_BRANCH="e2e/token-check-$(date -u +%Y%m%d-%H%M%S)"
  trap drop_probe_pr EXIT
  gh api -X POST "repos/$REPO/git/refs" -f ref="refs/heads/$PROBE_BRANCH" \
    -f sha="$(gh api "repos/$REPO/git/ref/heads/main" -q .object.sha)" >/dev/null
  commit_file "$PROBE_BRANCH" e2e-token-check.txt "probe" "chore(e2e): token-check probe" >/dev/null
  PROBE_PR=$(gh pr create -R "$REPO" --base main --head "$PROBE_BRANCH" --draft \
    --title "chore(e2e): token-check probe" --body "Opened by sandbox.sh check-tokens; closed when it ends." |
    grep -oE '[0-9]+$')
  log "opened probe PR #$PROBE_PR"
}

check_tokens() {
  local sha="${1:?usage: sandbox.sh check-tokens <sha>}" since id
  require_gh "$ADMIN_LOGIN"
  put .github/workflows/token-check.yml "$(token_check_workflow "$sha")"
  ensure_open_pr
  since=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  gh workflow run token-check.yml -R "$REPO" --ref main >/dev/null
  for _ in $(seq 1 30); do
    id=$(gh run list -R "$REPO" -w token-check.yml -e workflow_dispatch -L 5 \
      --json databaseId,createdAt --jq "[.[] | select(.createdAt >= \"$since\")][0].databaseId // empty")
    [[ -n "$id" ]] && break
    sleep 2
  done
  [[ -n "${id:-}" ]] || fail "the token check did not start in $REPO"
  log "token check: https://github.com/$REPO/actions/runs/$id"
  # set -e would end the script on a refused token, before the table prints.
  local rc=0
  gh run watch "$id" -R "$REPO" --exit-status >/dev/null 2>&1 || rc=$?
  # Each log line is "job<TAB>step<TAB>timestamp text"; keep the script's table,
  # or the error when a step before it failed (an App key that does not match).
  gh run view "$id" -R "$REPO" --log | tr -d '\r' | sed -E 's/^.*[0-9]Z //' |
    grep -E '^(Tokens checked|\| |##\[error\])' || true
  return "$rc"
}

# --- sync -------------------------------------------------------------------

WORKFLOW=.github/workflows/pr-approval.yml
CI=.github/workflows/ci.yml
POLICY=.strspc/pr-approval.yml

# The template at $1, pinned to $1, reading the sandbox's secrets. Fails if the
# template no longer has the lines this rewrites, or if a production secret
# name survives: the code under test must never be handed one.
render_caller() { # sha
  local out
  out=$(raw "$ACTION_REPO" templates/pr-approval.yml "$1" | awk \
    -v sha="$1" -v repo="$ACTION_REPO" \
    -v bot="$BOT_SECRET_NAME" -v appid="$APP_ID_SECRET_NAME" -v appkey="$APP_KEY_SECRET_NAME" '
    $0 == "      - uses: " repo "@v1" { print "      - uses: " repo "@" sha; used = 1; next }
    # No hourly sweep: one landing mid-scenario would add a decision the scenario
    # did not cause. A sweep scenario dispatches its own (workflow_dispatch).
    $0 == "  schedule:" { unscheduled = 1; next }
    unscheduled == 1 && /^    / { next }
    { unscheduled = 0 }
    /^ *[a-z-]+: \$\{\{ secrets\./ {
      if (sub(/secrets\.PR_APPROVAL_BOT_TOKEN/, "secrets." bot)) b = 1
      if (sub(/secrets\.STEERSPEC_APP_ID/, "secrets." appid)) i = 1
      if (sub(/secrets\.STEERSPEC_PRIVATE_KEY/, "secrets." appkey)) k = 1
    }
    { print }
    END { if (!used || !b || !i || !k) exit 1 }') || return 1
  # Every secrets reference must be a sandbox secret (secret-guard.js parses
  # the workflow; a line regex cannot tell a comment from a run: line).
  node "$SCRIPT_DIR/secret-guard.js" "$BOT_SECRET_NAME" "$APP_ID_SECRET_NAME" "$APP_KEY_SECRET_NAME" GITHUB_TOKEN \
    <<<"$out" || return 1
  printf '%s\n' "$out"
}

ci_workflow() {
  cat <<'EOF'
name: CI

# The caller's workflow_run trigger matches this workflow by NAME, so keep it
# literally "CI". It only has to give the harness a check to wait for. edited:
# ci-fail-withdraws retitles an approved PR to make this check fail on the same
# head.
on:
  pull_request:
    types: [opened, edited, synchronize, reopened]
    branches: [main, develop]

permissions:
  contents: read

jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - run: sleep 10
      # A title with this marker fails the check. Read from env, never
      # interpolated: the title is PR-controlled.
      - env:
          TITLE: ${{ github.event.pull_request.title }}
        run: '[[ "$TITLE" != *"[e2e-ci-fail]"* ]]'
EOF
}

# The sandbox's policy. The realm is read at the commit under test, so its rule
# IDs are the ones that commit cites.
#   promotion   the preset's: develop -> main, every commit from an approved PR
#   e2e-change  custom, for the harness's own PRs into develop: by the admin,
#               only under e2e/, at most two files
policy_file() { # sha
  cat <<EOF
# Managed by $ACTION_REPO e2e/pr-approval/sandbox.sh sync.
version: 1
realm: github://$ACTION_REPO@$1/rules
policies:
  - id: promotion
    kind: promotion
    rules: [APPROVE-005]
    match: { head: develop, base: main }

  - id: e2e-change
    kind: custom
    rules: [APPROVE-002]
    match: { base: develop, head: 'e2e/**', authors: [$ADMIN_LOGIN] }
    require: { paths: ['e2e/**'], max-files: 2 }
EOF
}

sync() {
  local sha="${1:?usage: sandbox.sh sync <sha>}" caller
  require_gh "$ADMIN_LOGIN"
  [[ "$sha" =~ ^[0-9a-f]{40}$ ]] || fail "sync needs a full commit SHA, not '$sha'"
  reset_prs
  caller=$(render_caller "$sha") ||
    fail "template at $sha lacks the expected uses:/secrets lines, or names a production secret"
  put "$WORKFLOW" "$caller"
  put "$CI" "$(ci_workflow)"
  put "$POLICY" "$(policy_file "$sha")"
  gh variable set STRSPC_PR_APPROVAL_BOT_LOGIN -R "$REPO" --body "$BOT_LOGIN"
  reset_vars
  reset_develop
  ok "$REPO at $sha"
}

# --- reset ------------------------------------------------------------------

# Only what the harness opens: e2e/ branches and promotions. Closes without
# deleting branches, because a promotion's head is develop.
reset_prs() {
  local n
  while read -r n; do
    [[ -n "$n" ]] && gh pr close "$n" -R "$REPO" >/dev/null
  done < <(gh pr list -R "$REPO" --state open --limit 100 --json number,headRefName --jq '.[]
    | select(.headRefName == "develop" or (.headRefName | startswith("e2e/")))
    | .number')
  while read -r n; do
    [[ -n "$n" ]] && gh api -X DELETE "repos/$REPO/git/refs/heads/$n" >/dev/null
  done < <(gh api --paginate "repos/$REPO/git/matching-refs/heads/e2e/" --jq '.[].ref | ltrimstr("refs/heads/")')
}

# Every scenario starts with the switches off. Set, never deleted: a deleted
# repo variable would let an org variable of the same name show through.
reset_vars() {
  local name
  for name in DRY_RUN MERGE ALLOW_NO_CHECKS; do
    gh variable set "STRSPC_PR_APPROVAL_$name" -R "$REPO" --body false
  done
}

# main only moves forward: the enterprise Compliance ruleset forbids a
# force-push to the default branch, even for its owner. develop can be
# force-moved, so it is put back on main.
reset_develop() {
  local sha
  sha=$(gh api "repos/$REPO/git/ref/heads/main" -q .object.sha)
  if has_branch develop; then
    gh api -X PATCH "repos/$REPO/git/refs/heads/develop" -f sha="$sha" -F force=true >/dev/null
  else
    gh api -X POST "repos/$REPO/git/refs" -f ref=refs/heads/develop -f sha="$sha" >/dev/null
  fi
}

# --- status -----------------------------------------------------------------

status() {
  log "repo: $REPO"
  log "branches: $(gh api "repos/$REPO/branches" --jq '[.[].name] | join(", ")')"
  log "rulesets: $(gh api "repos/$REPO/rulesets" --jq '[.[].name] | join(", ")')"
  log "repo secrets: $(gh api "repos/$REPO/actions/secrets" --jq '[.secrets[].name] | join(", ")')"
  log "org secrets: $(gh api "repos/$REPO/actions/organization-secrets" --jq '[.secrets[].name] | join(", ")')"
  gh variable list -R "$REPO"
}

case "${1:-}" in
  setup) setup ;;
  sync) sync "${2:-}" ;;
  reset) require_gh "$ADMIN_LOGIN"; reset_prs; reset_vars; reset_develop ;;
  check-tokens) check_tokens "${2:-}" ;;
  status) status ;;
  *) fail "usage: $0 setup|sync <sha>|reset|check-tokens <sha>|status" ;;
esac
