# How it works

Back to the [README](../README.md).

One run per event (`pull_request_target`, `pull_request_review`, `check_run`, `workflow_run`),
serialized per PR. Every step is an API call; nothing from the PR is checked out or executed.

1. **Resolve the PR.** `check_run`/`workflow_run` carry none, so it is read from their associated PRs.
2. **Universal guards** (APPROVE-001): open, not draft, head in this repository, not authored by the
   approving account.
3. **Load the policy from the base branch** (POLICY-001), resolve `extends:` (tags/SHAs only,
   POLICY-002/003), validate (POLICY-004), check every cited rule ID against its realm (POLICY-005).
4. **Match** the first policy (POLICY-006). No match: the PR is not this action's business.
5. **Tip check** for kinds whose proof covers a branch (promotion, release).
6. **Withdraw** our approvals of older heads (APPROVE-004).
7. **Checks**: none yet waits (unless `allow-no-checks`); a failing one refuses and withdraws; a
   running one waits for the next event (APPROVE-002).
8. **Kind proof** (APPROVE-005..009). A refusal withdraws any approval of ours.
9. **`require`** conditions (APPROVE-010) and **vetoes** (APPROVE-011; none ship in v1).
10. **Re-read** head, base, title, draft and merge base; approve pinned to the head SHA; re-read
    again and withdraw if anything moved (APPROVE-003).
11. **Merge**, only when the policy enables it (MERGE-001..005, [merging.md](merging.md)).

Unexpected API errors become a `skip` with the failing request named, so the job does not turn red
for reasons unrelated to the PR. Configuration errors (no `bot-login`, an invalid policy) and an
approval that could not be withdrawn fail the job.

## Living next to strspc-pr-review

strspc-pr-review approves PRs once Copilot's review is clean. Copilot does not review PRs into
`main`, and bot housekeeping PRs need no review, so those are this action's. To keep the two from
acting on the same PR, give strspc-pr-review `exclude-heads`/`exclude-bases` matching the policies
here (or keep its `base-branch` to `develop` and the bot heads out of it), and unset its deprecated
`promotion-branches`, `release-branches` and `release-author`.

## Why a policy file and a realm

Realm rules are prose — reviewable, versioned, citeable — but prose cannot be evaluated
deterministically. The policy file is their executable form, and every decision names the rules
it enforced, so a reviewer can check the YAML against the prose. A later version adds an optional
evaluator that reads the realm prose itself; it will only ever be able to *refuse* (APPROVE-011),
so a prompt hidden in a PR title or diff cannot get a PR approved.
