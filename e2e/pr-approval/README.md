# e2e harness — pr-approval

End-to-end tests for the action, run against a sandbox repository in the `testbed-multi-org`
organization. Ported from strspc-pr-review's `e2e/pr-auto-approve`.

| File | Role |
|---|---|
| `scenarios.json` | **The suite.** Each scenario's expected decision, the reason or review it must match, and the inputs and rules it proves. |
| `run.sh` | Sets each scenario's scene, and asserts the outcome from the logged decision and the review GitHub holds. |
| `sandbox.sh` | Keeps the sandbox in a known shape, as code: `setup`, `sync <sha>`, `reset`, `check-tokens <sha>`, `status`. |
| `token-check.sh` | Checks the tokens a workflow was given, without printing them. |
| `lib.sh` | Shared helpers. Sourced, not executed. |

## The sandbox

`testbed-multi-org/strspc-pr-approval-sandbox`. Its caller reads only sandbox secrets, never a
production one, because it runs whichever commit of this repo is under test:

| Secret | Where | What |
|---|---|---|
| `BOT_TOKEN_SANDBOX` | testbed-multi-org org secret, granted to the sandbox | cnslr-bt's sandbox-only token; approves |
| `TESTBED_APP_ID` | sandbox repo secret | the `steerspec-sync-testbed` App, installed on the sandbox; merges |
| `TESTBED_PRIVATE_KEY` | sandbox repo secret | that App's private key |
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

`sync <sha>` puts a commit under test: it renders the caller from `templates/pr-approval.yml` at that
SHA with `uses:` pinned to it and the secrets renamed to the sandbox's (it refuses if a production
secret name survives), and drops the hourly sweep. It commits to `main`, with the caller, a CI stub,
a `Downstream` stub that runs on every push to `main`, a `release-please-config.json` (one `simple`
package) and the sandbox policy. The policy reads its realm at the same SHA:

| Policy | Kind | What it admits |
|---|---|---|
| `release` | release, **merge on** | `release-please--branches--main` → `main` by the admin, only release-please's files; the testbed App merges it |
| `promotion` | promotion | `develop` → `main`, every commit from an approved PR |
| `e2e-change` | custom | the harness's PRs into `develop`: `e2e/**` heads by the admin, only `e2e/**` files, at most two |

## Run

```bash
e2e/pr-approval/sandbox.sh sync "$(git rev-parse HEAD)"
E2E_EXPECT_SHA="$(git rev-parse HEAD)" e2e/pr-approval/run.sh            # every scenario
e2e/pr-approval/run.sh promotion-approved promotion-unapproved           # some
```

Or run the **E2E** workflow from the Actions tab, on the default branch, with the SHA to test (empty
for the default branch's tip). The harness always runs the default branch's copy, because it holds
the enterprise owner's token; only the action under test comes from the SHA, and it runs in the
sandbox with the sandbox's secrets. To test a branch's scenario changes, run `run.sh` locally.

Each scenario starts from `sandbox.sh reset`: no harness PRs open, `develop` back on `main`, dry-run
and merging off. `main` only moves forward (the enterprise Compliance ruleset forbids a force-push to
the default branch), so the promotion scenarios close their promotion instead of merging it. Only
`release-merged` lands on `main`: it bumps the manifest's patch version from whatever `main` holds,
so it can run any number of times.

The admin's API commits are verified commits by the admin with GitHub as committer, as an App's are,
so the release policy names the admin as the release author. `release-merged` then checks what only
the merge token can do: the PR's `merged_by` is the testbed App, the merge is a merge commit (main's
only allowed method), and a `Downstream` run started on the merge commit. A merge made with
`GITHUB_TOKEN` would start none, and release-please would never run after it.

`sweep-approves` keeps the PR's own events in dry-run, waits for the caller to go idle, turns dry-run
off, and dispatches the caller: only a `workflow_dispatch` run's decision counts.

A scenario asserts what the action decided, not just that no approval appeared: a crash, a wrong
token and a skipped job all look like a refusal. It reads the line every evaluation logs,

```
pr-approval pr=42 decision=skip reason=[e2e-change: APPROVE-002] failing check: check (failure)
```

and, for an approval, the review's body. A failure is recorded and the run carries on; it ends with a
pass/fail table, also written to `$GITHUB_STEP_SUMMARY`.

The sandbox's rulesets dismiss an approval on a push, so `ci-fail-withdraws` proves the action's own
withdrawal by failing CI on the **same** head: it retitles the approved PR with `[e2e-ci-fail]`.

## Coverage

Each scenario lists the `action.yml` inputs and the `APPROVE`, `POLICY` and `MERGE` rules it proves.
`scripts/pr-approval/e2e.test.js`, part of `npm test`, fails when an input or a rule has neither a
scenario nor an entry under `exemptions` or `rule_exemptions` saying why not (E2E-001), when an
exemption outlives its scenario, and when a scenario states no decision and reason (E2E-002). Adding
an input or a rule therefore means adding a scenario or writing down why there is none.
