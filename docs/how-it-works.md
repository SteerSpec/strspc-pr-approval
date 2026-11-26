# How it works

Back to the [README](../README.md).

One run per event (`pull_request_target`, `pull_request_review`, `check_run`, `workflow_run`),
serialized per PR, plus an hourly [sweep](#the-sweep) of the open PRs. Every step is an API call;
nothing from the PR is checked out or executed.

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
    again and withdraw if anything moved (APPROVE-003), or if a check on the head has failed since
    the gate (APPROVE-015): runs on one PR can overlap, and another may have withdrawn on that
    failure before this approval landed.
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
`merge_group`, so a CI job that happens to share the name is still waited for. Both actions' sweeps
are ignored too ([below](#the-sweep)). The lookup needs
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
no run of the PR's own re-evaluates it when the review lands. The [sweep](#the-sweep) does, within the
hour, or the next push, label or check sooner. That wait is safe: the PR waits, it is never approved
early.

## The sweep

Every rule above depends on an event of the PR starting a run, and GitHub does not always deliver
one: the run Copilot's review starts is held, and CI's `workflow_run` can go missing. The template's
`schedule:` (hourly, at minute 53) and `workflow_dispatch:` triggers start a sweep (APPROVE-014). It
carries no PR, so the action lists the open PRs, most recently opened first, and evaluates each one
that is not a draft and whose head is in this repository, exactly as a run of its own event would,
policy and all. It differs in three ways:

- It evaluates the 30 most recently opened such PRs at most, and warns when there are more.
- Its outputs sum it up: `decision` is the most telling result (`error`, `merged`, `approved`,
  `dry-run`, then `skip`), `reason` lists every PR that did not skip, and the other outputs describe
  the PR behind `decision`. Each PR still logs its own `pr-approval pr=<n> decision=…` line.
- It never cancels, and is never cancelled by, a PR's own run: sweeps share their own concurrency
  group, `pr-approval-<repo>-sweep`. So a sweep and a PR's run can judge the same head at once:
  the checks are read again after approving (APPROVE-015), and the worst case is a skipped merge
  ("already merged") or two approvals of that head.

A sweep runs on the default branch's tip, which is also the head of a promotion from it. Its check
there judged other PRs, so a run of this job, or of strspc-pr-review's `auto-approve`, from its own
workflow file for a schedule or a dispatch of the default branch is ignored, finished or not
(APPROVE-002). Otherwise one red sweep would refuse every promotion until the next tick. Runs this
job's own events start (`check_run`, `workflow_run`) land on that tip as well and still count, so a
red one refuses a promotion until a later run of the same name succeeds. A dispatch
of another branch runs that branch's copy of the file, so it counts like any check, and the
template's job `if:` admits a dispatch of the default branch only.

Cost: one short run per tick, about a minute billed on a private repository (some 720 minutes a
month), and a dozen API calls per open PR. GitHub runs schedules from the default branch's copy of
the workflow only, may start them late, and disables them in a public repository with no activity
for 60 days. Delete `schedule:` to keep only the manual run: `gh workflow run pr-approval.yml`.

## Why a policy file and a realm

Realm rules are prose — reviewable, versioned, citeable — but prose cannot be evaluated
deterministically. The policy file is their executable form, and every decision names the rules
it enforced, so a reviewer can check the YAML against the prose. A later version adds an optional
evaluator that reads the realm prose itself; it will only ever be able to *refuse* (APPROVE-011),
so a prompt hidden in a PR title or diff cannot get a PR approved.
