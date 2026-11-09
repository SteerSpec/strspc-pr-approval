---
name: pr-approval-diagnose
description: Use when strspc-pr-approval did not approve or merge a promotion, release, sync-back, pin or template-sync PR, or approved/merged one unexpectedly — "why wasn't the release PR approved", "the promotion is stuck", "pr-approval skipped", "why did it merge".
---

# Diagnosing strspc-pr-approval

Each run writes one `decision=` line and a job summary naming the policy and the rule IDs. Find it
before guessing.

```bash
gh run list --workflow=pr-approval.yml --limit 10 --json databaseId,event,conclusion,createdAt,headBranch
gh run view <id> --log | grep 'pr-approval pr='
```

Then match the `reason` in `docs/troubleshooting.md`. Common causes:

- **No run at all**: the gating workflow is not under `workflow_run.workflows`, or the job `if:`
  filtered the event (fork, draft, the bot's own review).
- **`no policy matches`**: compare the PR's head/base/author/labels with the policy's `match` and the
  kind defaults. `gh pr view <n> --json headRefName,baseRefName,author,labels`.
- **Policy read from the wrong place**: it is read from the *base* branch. A fix on `develop` does
  not help a PR into `main` until promoted.
- **Promotion provenance**: the reason names the develop PR that merged without a standing approval.
  `gh pr view <N> --json reviews,mergedAt,mergedBy`.
- **Not merged**: `mergeable_state` not `clean`, no merge token, or a merge-method disagreement with
  the branch rules (`gh api repos/<o>/<r>/rules/branches/<base>`).

To reproduce a decision without writing anything:
`node scripts/backtest.js --repo <owner>/<repo> --pr <n>`.
