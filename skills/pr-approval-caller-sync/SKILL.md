---
name: pr-approval-caller-sync
description: Use when templates/pr-approval.yml or action.yml inputs change and caller workflows in other repositories must be updated, or when rolling strspc-pr-approval out to more repositories.
---

# Keeping caller workflows in sync

Callers own the triggers, the job `if:`, the concurrency group and the token wiring; the action
owns the decision. A caller that is not updated simply never forwards a new event or input.

## 1. What changed

```bash
git diff <last-tag> -- action.yml templates/pr-approval.yml
```

| Change | Caller must update |
|---|---|
| New event | `on:` and the matching `if:` branch |
| New input | wire it to `vars.STRSPC_PR_APPROVAL_<INPUT>` |
| New token | a step that mints it, scoped as narrowly as the template's |

## 2. Find the callers

```bash
gh search code "uses: SteerSpec/strspc-pr-approval" --json repository,path
```

## 3. Per repository

- `workflow_run.workflows` lists that repo's gating workflows — never copy it blindly.
- `.strspc/pr-approval.yml` exists on every base branch.
- strspc-pr-review in the same repo no longer has `promotion-branches`/`release-branches` set and
  excludes what this action handles.

Open one PR per repository (`chore(ci): sync pr-approval caller`); never merge it yourself.
