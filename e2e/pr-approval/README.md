# e2e harness — pr-approval

End-to-end tests for the action, run against a sandbox repository in the `testbed-multi-org`
organization. Ported from strspc-pr-review's `e2e/pr-auto-approve`. The scenario suite is still to
come (bead `strspc-pr-approval-3ns`); this directory holds the sandbox's setup and its token check.

| File | Role |
|---|---|
| `sandbox.sh` | Keeps the sandbox in a known shape, as code: `setup`, `check-tokens <sha>`, `status`. |
| `token-check.sh` | Checks the tokens a workflow was given, without printing them. |
| `lib.sh` | Shared helpers. Sourced, not executed. |

## The sandbox

`testbed-multi-org/strspc-pr-approval-sandbox`. Its caller reads only sandbox secrets, never a
production one, because it runs whichever commit of this repo is under test:

| Secret | Where | What |
|---|---|---|
| `BOT_TOKEN_SANDBOX` | testbed-multi-org org secret, granted to the sandbox | cnslr-bt's sandbox-only token; approves |
| `TESTBED_APP_ID` | sandbox repo secret | the `steerspec-sync-testbed` App, installed on the sandbox; merges |
| `TESTBED_PRIVATE_KEY` | testbed-multi-org org secret, granted to the sandbox | that App's private key |
| `E2E_ADMIN_TOKEN` | SteerSpec org secret, on this repo | the enterprise owner's token; drives the harness |

The rulesets match production's merge methods (merge commit into `main`, squash into `develop`, one
approval), with one difference: the enterprise owner may bypass them, because the harness commits to
`main` and force-moves `develop`. The bot and the App have no bypass, so a merge they make proves the
rules were met.

## Setup

Needs Bash 4+ (on macOS, `brew install bash`), `jq`, and `gh` authenticated as the enterprise owner.

```bash
# Once: the bot gets write, the rulesets are created, develop is branched from main.
e2e/pr-approval/sandbox.sh setup

# After any secret or token change. <sha> must be pushed: the sandbox checks it out.
e2e/pr-approval/sandbox.sh check-tokens "$(git rev-parse HEAD)"

e2e/pr-approval/sandbox.sh status
```

`check-tokens` runs `token-check.sh` inside the sandbox, so it sees the secrets as the caller will,
and mints the merge token the way the caller does. It checks that `BOT_TOKEN_SANDBOX` is cnslr-bt's
and may review, and that the App token reaches the sandbox and may push. With no open PR it opens a
draft probe PR and closes it when done.

The admin token in this repo is checked by the **Token check** workflow (Actions tab, run it by hand).
