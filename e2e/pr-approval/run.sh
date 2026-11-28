#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
#
# Runs the e2e scenarios against the sandbox, which `sandbox.sh sync <sha>`
# must have put under test.
#
#   run.sh [scenario...]   default: every scenario in scenarios.json
#
# Each scenario starts from `sandbox.sh reset` (no harness PRs, develop on main,
# dry-run off), sets its scene, and asserts the outcome scenarios.json states:
# the decision the action logged, and the review GitHub holds. A failure is
# recorded and the run carries on. It ends with a pass/fail table, also written
# to $GITHUB_STEP_SUMMARY, and exits 1 if anything failed.
#
# Needs Bash 4+, jq, and gh authenticated as the enterprise owner (E2E_ADMIN_LOGIN):
# the harness commits to main, merges with bypass and opens every PR.
# The scenarios are called by name (sc_<name>), which shellcheck cannot follow.
# shellcheck disable=SC2329
set -euo pipefail

SCRIPT_DIR="$(cd "${BASH_SOURCE[0]%/*}" && pwd)"
# shellcheck source=e2e/pr-approval/lib.sh
source "$SCRIPT_DIR/lib.sh"

MANIFEST="$SCRIPT_DIR/scenarios.json"
# The body of an approval under the custom policy. Backticks are literal.
# shellcheck disable=SC2016
CUSTOM_APPROVAL_RE='^Approved under policy `e2e-change`'
LOG_DIR=$(mktemp -d)
trap 'rm -rf "$LOG_DIR"' EXIT

field() { # scenario, field
  jq -r --arg n "$1" --arg f "$2" '.scenarios[] | select(.name == $n) | .[$f] // ""' "$MANIFEST"
}

now() { date -u +%Y-%m-%dT%H:%M:%SZ; }

# Asserts what scenarios.json states for $SCENARIO on PR $1, since $2.
expect() { # pr, since
  local decision
  decision=$(field "$SCENARIO" decision)
  case "$decision" in
    approved)
      # From the review, not the log: the run that approves can be cancelled by
      # the next one, and the review is what GitHub holds.
      wait_for_approval "$1" "$(field "$SCENARIO" review)" ||
        fail "$SCENARIO: no approval of #$1 matching /$(field "$SCENARIO" review)/"
      ;;
    skip | dry-run)
      wait_decision "$1" "$decision" "$(field "$SCENARIO" reason)" "$2" || fail "$SCENARIO: wrong decision"
      not_approved "$1" || fail "$SCENARIO: #$1 is approved after all"
      ;;
    *) fail "$SCENARIO: scenarios.json has no decision" ;;
  esac
}

# A merge right after a PR opens can meet a mergeability GitHub has not
# computed yet; it settles within seconds.
merge_pr() { # pr, extra flags...
  local pr="$1" attempt
  shift
  for attempt in 1 2 3 4 5 6; do
    gh pr merge "$pr" -R "$REPO" --squash "$@" >/dev/null 2>&1 && return 0
    sleep $((attempt * 5))
  done
  fail "could not merge #$pr"
}

open_promotion() {
  local url
  url=$(gh pr create -R "$REPO" --base main --head develop --title "chore: promote develop to main" \
    --body "e2e promotion, closed by the harness." 2>/dev/null | grep -E '/pull/[0-9]+$') ||
    fail "could not open the promotion"
  printf '%s\n' "${url##*/}"
}

# --- scenarios ------------------------------------------------------------

sc_custom_approved() {
  local since pr
  since=$(now)
  pr=$(open_pr develop "$(new_branch "$SCENARIO")" "chore(e2e): $SCENARIO" "e2e/$SCENARIO.txt")
  expect "$pr" "$since"
}

sc_no_policy() {
  local since pr
  since=$(now)
  pr=$(open_pr main "$(new_branch "$SCENARIO")" "chore(e2e): $SCENARIO" "e2e/$SCENARIO.txt")
  expect "$pr" "$since"
}

sc_outside_paths() {
  local since pr
  since=$(now)
  pr=$(open_pr develop "$(new_branch "$SCENARIO")" "chore(e2e): $SCENARIO" outside.txt)
  expect "$pr" "$since"
}

sc_ci_failing() {
  local since pr
  since=$(now)
  pr=$(open_pr develop "$(new_branch "$SCENARIO")" "chore(e2e): $SCENARIO [e2e-ci-fail]" "e2e/$SCENARIO.txt")
  expect "$pr" "$since"
}

sc_dry_run() {
  local since pr
  gh variable set STRSPC_PR_APPROVAL_DRY_RUN -R "$REPO" --body true
  since=$(now)
  pr=$(open_pr develop "$(new_branch "$SCENARIO")" "chore(e2e): $SCENARIO" "e2e/$SCENARIO.txt")
  expect "$pr" "$since"
}

# The sandbox's rulesets dismiss an approval on a push, so a new head proves
# nothing about the action. A retitle keeps the head and fails CI on it.
sc_ci_fail_withdraws() {
  local pr since
  pr=$(open_pr develop "$(new_branch "$SCENARIO")" "chore(e2e): $SCENARIO" "e2e/$SCENARIO.txt")
  wait_for_approval "$pr" "$CUSTOM_APPROVAL_RE" || fail "$SCENARIO: #$pr was never approved"
  since=$(now)
  gh pr edit "$pr" -R "$REPO" --title "chore(e2e): $SCENARIO [e2e-ci-fail]" >/dev/null
  expect "$pr" "$since"
  wait_withdrawn "$pr" || fail "$SCENARIO: the approval of #$pr was not withdrawn"
}

# develop gains one commit from a PR the action approved; the promotion is
# approved. It is closed, not merged: main only moves forward.
sc_promotion_approved() {
  local pr since promo
  pr=$(open_pr develop "$(new_branch "$SCENARIO")" "chore(e2e): $SCENARIO" "e2e/$SCENARIO.txt")
  wait_for_approval "$pr" "$CUSTOM_APPROVAL_RE" || fail "$SCENARIO: #$pr was never approved"
  merge_pr "$pr"
  since=$(now)
  promo=$(open_promotion)
  expect "$promo" "$since"
}

# develop gains one commit from a PR merged with the owner's bypass and no
# approval, as a hand-merged bootstrap is: the promotion is refused (bead 0w3).
sc_promotion_unapproved() {
  local pr since promo
  pr=$(open_pr develop "$(new_branch "$SCENARIO")" "chore(e2e): $SCENARIO" outside.txt)
  merge_pr "$pr" --admin
  since=$(now)
  promo=$(open_promotion)
  expect "$promo" "$since"
}

# --- run ------------------------------------------------------------------

require_gh "$ADMIN_LOGIN"
mapfile -t all < <(jq -r '.scenarios[].name' "$MANIFEST")
selected=("$@")
((${#selected[@]})) || selected=("${all[@]}")
for name in "${selected[@]}"; do
  printf '%s\n' "${all[@]}" | grep -qxF "$name" || fail "no scenario '$name' in scenarios.json"
  declare -F "sc_${name//-/_}" >/dev/null || fail "scenario '$name' has no sc_${name//-/_} in run.sh"
done

assert_pinned
rows=()
failed=0
for name in "${selected[@]}"; do
  SCENARIO="$name"
  log "--- $name: $(field "$name" summary)"
  "$SCRIPT_DIR/sandbox.sh" reset
  start=$(date +%s)
  # A subshell, so a scenario's fail() ends the scenario, not the run.
  if (sc_"${name//-/_}"); then
    ok "$name"
    rows+=("| \`$name\` | pass | $(($(date +%s) - start))s |")
  else
    warn "$name failed"
    rows+=("| \`$name\` | **fail** | $(($(date +%s) - start))s |")
    failed=1
  fi
  assert_pinned
done
"$SCRIPT_DIR/sandbox.sh" reset

{
  echo "e2e against \`$REPO\`:"
  echo
  echo "| Scenario | Result | Time |"
  echo "|---|---|---|"
  printf '%s\n' "${rows[@]}"
} | tee -a "${GITHUB_STEP_SUMMARY:-/dev/null}"
exit "$failed"
