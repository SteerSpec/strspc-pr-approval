# Troubleshooting

Every run writes its decision, the matching policy, the rule IDs and a one-line `reason` to the job
summary. Find the reason below.

| Reason starts with | Meaning | Fix |
|---|---|---|
| `bot-login is empty` | `STRSPC_PR_APPROVAL_BOT_LOGIN` unset or not shared with this repo | Set the variable (org variables have a repository-access policy) |
| `no .strspc/pr-approval.yml on <base>` | The policy is read from the base branch | Add it to that branch, not only to `develop` |
| `invalid policy:` | Schema or citation error; the action took no action | Fix the file; the message names the key |
| `… names a branch; extends must pin a tag or a full commit SHA` | POLICY-002 | Pin `@v1`/`@vX.Y.Z` or a SHA |
| `… cites X: rule … not found` | The cited rule is not in the realm at that ref | Fix the ID or the `realm:` ref |
| `no policy matches this PR` | Nothing selected it | Check `match` and the kind's default match ([policy-reference.md](policy-reference.md#kinds)) |
| `PR author is the approving account` | Self-approval is impossible | Open those PRs with a different identity (an App) |
| `no checks on head SHA yet` / `check still running` | Waiting | Make sure the gating workflow is listed under `workflow_run` in the caller |
| `failing check:` | Refused; any approval of ours withdrawn | Fix the check |
| `head … is not the tip of …` | An old event | The next run re-evaluates |
| `promotion title …` | Promotion titles must be `chore:` and not breaking | Retitle |
| `commit X came from #N, which has no standing approval` | Provenance: a develop PR merged without an approval | Approve PRs into develop before merging them, or promote by hand |
| `release PR changes X, which release-please does not own` | A file outside release-please's output | Investigate — this is what the check is for |
| `… unpromoted commit(s) …; promote first` | develop holds a changelog-visible commit | Promote first, then release |
| `release PR is N commit(s) behind <base>` | The base moved since release-please built its PR | Wait: release-please refreshes its branch after every push to the base |
| `superseded by #N` | A newer pin/template PR is open | Close this one |
| `not merged: merge-token is not set` | Merging enabled, no App token | Set `STRSPC_PR_APPROVAL_MERGE=true` and the App secrets |
| `not merged: mergeable_state is …` | GitHub says the PR is not ready | Usually resolves on the next event |
| `evaluation failed: 403 …` | A token lacks a permission | The message names the request |
