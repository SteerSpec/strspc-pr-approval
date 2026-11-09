# Reference: inputs and outputs

Every input and output of the action. Back to the [README](../README.md).
Settings that decide *what* gets approved live in the policy file, not here — see
[policy-reference.md](policy-reference.md).

## Inputs

| Input | Default | Description |
| ----- | ------- | ----------- |
| `bot-login` | | Login of the approving account. Must differ from the account that opens the PRs (GitHub rejects self-approval) |
| `approve-token` | | Token of `bot-login`, used only to post and dismiss approvals. A fine-grained PAT with `Pull requests: write` |
| `github-token` | `${{ github.token }}` | Every read: the PR, reviews, check runs, commits, the policy and the realm. Needs `contents: read`, `pull-requests: write`, `checks: read` |
| `merge-token` | `''` | Token used to merge when a policy enables it. Use a GitHub App token; `GITHUB_TOKEN` merges start no workflow (MERGE-002). Empty = never merge |
| `policy-token` | `''` | Reads `extends:`/`realm:` sources in other repositories. Defaults to `github-token` (public repositories only) |
| `policy-file` | `.strspc/pr-approval.yml` | Policy path, always read from the PR's base branch (POLICY-001) |
| `dry-run` | `false` | `true` decides and reports without approving, withdrawing or merging |
| `allow-no-checks` | `false` | `true` lets a head with no check runs be approved |

## Outputs

| Output | Description |
| ------ | ----------- |
| `decision` | `approved`, `merged`, `skip`, `dry-run` or `error` |
| `reason` | One line, prefixed with `[policy-id: RULE-IDS]` once a policy matched |
| `policy` | Id of the matching policy, or empty |
| `rules` | Comma-separated rule IDs the matching policy cites |
| `merged` | `true` when this run merged the PR |
| `pr-number` | Number of the evaluated PR |
| `pr-url` | URL of the evaluated PR |
