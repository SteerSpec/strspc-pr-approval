# Usage

Back to the [README](../README.md).

## 1. Accounts and tokens

| What | Why | Where |
|---|---|---|
| Approving account (e.g. a machine user) | Posts the APPROVE review. Must not be the account that opens the PRs: GitHub rejects self-approval | variable `STRSPC_PR_APPROVAL_BOT_LOGIN` |
| Its PAT, `Pull requests: write` | Posting and dismissing approvals, nothing else | secret `BOT_GITHUB_TOKEN` |
| A GitHub App with `contents: write`, `pull-requests: write` | Merging. Only needed when a policy enables `merge` | secrets `STEERSPEC_APP_ID`, `STEERSPEC_PRIVATE_KEY`, variable `STRSPC_PR_APPROVAL_MERGE=true` |

Reads use the workflow `GITHUB_TOKEN`. Under the SteerSpec org the approving account is the same one
strspc-pr-review uses; the two actions never act on the same PR (see
[how-it-works.md](how-it-works.md#living-next-to-strspc-pr-review)).

If the App must also be allowed to merge past a ruleset, add it to the ruleset's bypass list *only*
for the merge method that ruleset allows — the action already refuses to merge with any other
(MERGE-004).

## 2. The caller workflow

Copy [`templates/pr-approval.yml`](../templates/pr-approval.yml) to `.github/workflows/pr-approval.yml`
and list every workflow that gates PRs under `workflow_run.workflows`.

## 3. The policy

Create `.strspc/pr-approval.yml` **on every branch PRs target** (it is read from the base branch).
The shortest useful one extends the SteerSpec preset:

```yaml
version: 1
extends:
  - github://SteerSpec/strspc-pr-approval@v1/presets/steerspec.yml
```

To use your organisation's own rules, keep them in a central repository with a realm and a policy,
tag it, and extend that instead:

```yaml
version: 1
extends:
  - github://Acme/engineering-policy@v3/pr-approval.yml
```

Override a policy by redeclaring its `id`:

```yaml
version: 1
realm: github://SteerSpec/strspc-pr-approval@v1/rules
extends:
  - github://SteerSpec/strspc-pr-approval@v1/presets/steerspec.yml
policies:
  - id: release            # replaces the preset's release policy
    kind: release
    rules: [APPROVE-006]
    match: { base: main }
    options: { author: steerspec-sync[bot] }   # no develop branch here, so no `source`
    merge: { enabled: true }
```

Every field is in [policy-reference.md](policy-reference.md).

## 4. Roll out in dry-run

Set `STRSPC_PR_APPROVAL_DRY_RUN=true` first. Each run's summary shows the decision it *would*
have taken, the matching policy and the rule IDs. Then measure against history with
`node scripts/backtest.js --repo Owner/repo --since YYYY-MM-DD` and switch dry-run off.

## Branch protection

The action approves a PR only when every check on its head is green, and merges only when GitHub
reports the PR `clean`, so required checks, conversation resolution and stale-review dismissal in
your rulesets keep applying. Turn on "Dismiss stale pull request approvals when new commits are
pushed"; the action also withdraws its own approval of an older head (APPROVE-004).
