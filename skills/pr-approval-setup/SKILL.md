---
name: pr-approval-setup
description: Use when adding strspc-pr-approval to a repository — wiring the caller workflow, the approving account and App token, and writing or extending the .strspc/pr-approval.yml policy, including a customer's own central policy and realm.
---

# Setting up strspc-pr-approval

The policy decides; the caller only wires events and tokens. Read `docs/usage.md` for the full
walk-through and `docs/policy-reference.md` for every field.

## 1. Check the repository

```bash
gh api repos/<owner>/<repo> --jq '{default_branch, allow_auto_merge}'
gh api repos/<owner>/<repo>/rules/branches/main --jq '[.[] | select(.type=="pull_request") | .parameters.allowed_merge_methods]'
ls .github/workflows   # every workflow that gates PRs goes under workflow_run.workflows
```

Note who opens each kind of PR (`gh pr list --state merged --limit 50 --json author,headRefName,title`):
the approving account must differ from every author.

## 2. Caller

Copy `templates/pr-approval.yml` to `.github/workflows/pr-approval.yml`; replace `['CI']` with the
gating workflow names. Variables: `STRSPC_PR_APPROVAL_BOT_LOGIN`, `STRSPC_PR_APPROVAL_DRY_RUN=true`,
and `STRSPC_PR_APPROVAL_MERGE=true` only if a policy merges. Secret: `BOT_GITHUB_TOKEN`.

## 3. Policy

On **every** branch PRs target (it is read from the base):

```yaml
version: 1
extends:
  - github://SteerSpec/strspc-pr-approval@v1/presets/steerspec.yml
```

For a customer's own rules: a central repository holding a realm (`strspc realm init`, rules
written with `strspc rule add`) and a policy file citing its rule IDs, tagged; consumers extend
`github://<Org>/<repo>@<tag>/<path>.yml`. A private central repository needs `policy-token`.

Validate locally before opening the PR:

```bash
node -e "const p=require('<path-to-action>/scripts/pr-approval/policy.js');const k=require('<path-to-action>/scripts/pr-approval/kinds/index.js');const d=p.parseYaml(require('fs').readFileSync('.strspc/pr-approval.yml','utf8'),'policy');console.log(p.validatePolicyFile(d,'policy',k))"
```

## 4. Prove it, then switch dry-run off

`node scripts/backtest.js --repo <owner>/<repo> --since <date>` from a checkout of this action, then
watch a few dry-run summaries before setting `STRSPC_PR_APPROVAL_DRY_RUN=false`.
