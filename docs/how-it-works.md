# How it works

Back to the [README](../README.md).

One run per event (`pull_request_target`, `pull_request_review`, `check_run`, `workflow_run`),
serialized per PR. Every step is an API call; nothing from the PR is checked out or executed.

1. **Resolve the PR.** `check_run`/`workflow_run` carry none, so it is read from their associated PRs.
2. **Universal guards** (APPROVE-001): open, not draft, head in this repository, not authored by the
   approving account.
3. **Load the policy from the base branch** (POLICY-001), resolve `extends:` (tags/SHAs only,
   POLICY-002/003), validate (POLICY-004), check every cited rule ID against its realm (POLICY-005).
4. **Match** the first policy (POLICY-006). No match: the action takes no action beyond withdrawing an
   approval of its own, if it gave one (POLICY-008).
5. **Tip check** for kinds whose proof covers a branch (promotion, release).
6. **Withdraw** our approvals of older heads (APPROVE-004).
7. **Checks**: none yet waits (unless `allow-no-checks`); a failing one refuses and withdraws; a
   running one waits for the next event (APPROVE-002).
8. **Kind proof** (APPROVE-005..009). A refusal withdraws any approval of ours.
9. **`require`** conditions (APPROVE-010) and **vetoes** (APPROVE-011). The one v1 veto is Copilot's
   latest review: when Copilot has reviewed the PR, it refuses unless that review is an "Approval
   recommended" overview with no open issue (APPROVE-013).
10. **Re-read** head, base, title, draft and merge base; approve pinned to the head SHA; re-read
    again and withdraw if anything moved (APPROVE-003).
11. **Merge**, only when the policy enables it (MERGE-001..005, [merging.md](merging.md)).

Unexpected API errors become a `skip` with the failing request named, so the job does not turn red
for reasons unrelated to the PR. Configuration errors (no `bot-login`, an invalid policy) and an
approval that could not be withdrawn fail the job.

## Living next to strspc-pr-review

strspc-pr-review approves PRs once Copilot's review is clean. Copilot does not review PRs into
`main`, and bot housekeeping PRs are proven by who wrote them and what they touch, so those are this
action's; Copilot's review of a housekeeping PR can still veto it (below). To keep the two from
acting on the same PR, give strspc-pr-review `exclude-heads`/`exclude-bases` matching the policies
here (or keep its `base-branch` to `develop` and the bot heads out of it), and unset its deprecated
`promotion-branches`, `release-branches` and `release-author`.

The two also run on the same events, so each finds the other's job still running. This action
therefore ignores an unfinished `auto-approve` check (strspc-pr-review's job id), just as it ignores
its own; a finished one counts like any other check (APPROVE-002). A name alone proves nothing, so
the check must also come from a GitHub Actions run of the `companion-workflow` file (default
`.github/workflows/auto-approve.yml`) started by `pull_request_target`, `pull_request_review`,
`check_run` or `workflow_run`. CI runs on `pull_request`, `push` or
`merge_group`, so a CI job that happens to share the name is still waited for. The lookup needs
`actions: read`; without it, the check counts as pending. strspc-pr-review must do the
same for `strspc-pr-approval`, or its PRs stall on this job.

## Copilot's review as a veto

The kinds prove who wrote a PR and which files it touches, not what the change does. A template
sync that replaces a repository's own `dependabot.yml` with a narrower one (this repo's #17) passes
the template-sync proof, while Copilot flags it. So Copilot's latest review can refuse an approval,
and take back one already given, but never grant one (APPROVE-013). The overview is read strictly: only
the verdict "Approval recommended" with "No open issues" passes, and an unknown section, a
previously missed issue, an errored review or a change request refuses. A dismissed review no longer
stands and is skipped. The parser is the one strspc-pr-review uses by default. Reviews are listed
again right before and right after the approval, so a review that lands mid-run still refuses.

A PR Copilot never reviewed passes the veto. A policy that needs a review sets
`require: { copilot-review: clean }`, which also refuses until Copilot has reviewed the head itself.
The SteerSpec preset sets it on `sync-back`, `core-pin` and `template-sync`: they go into `develop`,
where the org's ruleset has Copilot review every push.

Copilot's review starts a `pull_request_review` run that GitHub holds at `action_required`, so
nothing re-evaluates the PR when the review lands; the next push, label or check does. That stall
is safe: the PR waits, it is never approved early.

## Why a policy file and a realm

Realm rules are prose — reviewable, versioned, citeable — but prose cannot be evaluated
deterministically. The policy file is their executable form, and every decision names the rules
it enforced, so a reviewer can check the YAML against the prose. A later version adds an optional
evaluator that reads the realm prose itself; it will only ever be able to *refuse* (APPROVE-011),
so a prompt hidden in a PR title or diff cannot get a PR approved.
