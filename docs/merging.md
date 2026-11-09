# Merging

Merging is opt-in per policy: `merge: { enabled: true }`. When it is on, after approving (or finding
its own approval already standing) the action:

1. Refuses without a `merge-token` (MERGE-002). Never `GITHUB_TOKEN`: GitHub starts no workflow for
   events that token causes, so after a promotion release-please would never open its PR, and after
   a release no tag workflow would run.
2. Picks the method: the policy's `method`, checked against what the base branch's rules allow
   (`GET /repos/{owner}/{repo}/rules/branches/{branch}`); without a `method`, the only one allowed.
   Disagreement or ambiguity refuses (MERGE-004). SteerSpec repos allow merge commits into `main`
   and squash into `develop`.
3. Asks the kind for a last-moment blocker — a release re-checks for unpromoted commits (MERGE-005).
4. Re-reads the PR: the head must still be the evaluated SHA, and `mergeable_state` must be `clean`.
   `clean` already means required checks, conversation resolution and review requirements are
   satisfied, so the action does not re-implement them. Anything else waits for the next event.
5. Merges with `sha` pinned to the evaluated head (MERGE-003), so a push in between fails the merge
   instead of merging unreviewed code.

## The release train

With merging enabled on `promotion` and `release`:

```
develop ──promotion PR──▶ main          (merge commit; App token, so release-please runs)
main ──release-please PR──▶ main        (refused while develop holds unpromoted visible commits)
main ──sync-back PR──▶ develop          (release files identical to main)
```

Each step's PR is opened by its own workflow; this action only approves and merges.

## Org standard

SteerSpec's standard says agents open PRs and never merge them. Merges by this action are policy
driven, pinned to a head that passed the policy, and opted into per repository. Recording that
exception in the `SteerSpec/.claude` template is a separate change.
