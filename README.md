<div align="center">

<img src="https://steerspec.dev/assets/logo-transparent.svg" alt="SteerSpec logo" width="96" height="96">

# SteerSpec PR Approval

**A GitHub Action that approves — and, when a policy opts in, merges — the pull requests Copilot never reviews: promotions (`develop` → `main`), release-please PRs, release sync-backs, rules pins and template syncs. Every decision follows a policy you control and cites the realm rules it enforced.**

[![CI](https://github.com/SteerSpec/strspc-pr-approval/actions/workflows/ci.yml/badge.svg)](https://github.com/SteerSpec/strspc-pr-approval/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/SteerSpec/strspc-pr-approval?labelColor=161B22&color=161B22)](https://github.com/SteerSpec/strspc-pr-approval/releases)
[![License](https://img.shields.io/badge/License-Apache%202.0-161B22.svg?labelColor=161B22)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D22-161B22.svg?labelColor=161B22)](.nvmrc)
[![Conventional Commits](https://img.shields.io/badge/Conventional%20Commits-1.0.0-161B22.svg?labelColor=161B22)](https://www.conventionalcommits.org)

</div>

Part of the SteerSpec automation suite:

| Repo | Role |
|---|---|
| [strspc-sync](https://github.com/SteerSpec/strspc-sync) | Keeps shared files in sync across repositories |
| [strspc-pr-review](https://github.com/SteerSpec/strspc-pr-review) | Approves PRs once Copilot's review is clean |
| **strspc-pr-approval** | Approves and merges the PRs Copilot never reviews, under a policy you control |

## How it decides

1. It reads `.strspc/pr-approval.yml` **from the base branch** (a PR can't loosen its own policy).
2. The policy may `extends:` a central policy pinned to a tag or SHA, e.g. your organisation's.
3. The first matching policy applies. Its **kind** (`promotion`, `release`, `sync-back`, `pin`,
   `template-sync`, `custom`) carries hard safety checks that a policy can tighten but never relax.
4. Every policy cites rule IDs from a SteerSpec realm; reviews and logs quote them.
5. Merging is off unless the policy says `merge: { enabled: true }`, and then uses an App token so
   downstream workflows (release-please) still run.

```yaml
# .strspc/pr-approval.yml
version: 1
realm: github://SteerSpec/strspc-pr-approval@v1/rules
extends:
  - github://SteerSpec/strspc-pr-approval@v1/presets/steerspec.yml
policies:
  - id: release
    kind: release
    rules: [APPROVE-006]
    match: { base: main, authors: ['steerspec-sync[bot]'] }
    merge: { enabled: true }
```

See [docs/usage.md](docs/usage.md) to wire it up and [docs/policy-reference.md](docs/policy-reference.md)
for every field.

## Documentation

| Page | What it covers |
|---|---|
| [Usage](docs/usage.md) | Accounts, tokens, the caller workflow, the first policy, dry-run rollout |
| [Policy reference](docs/policy-reference.md) | Every field, the kinds and what each proves |
| [How it works](docs/how-it-works.md) | The decision sequence, and living next to strspc-pr-review |
| [Merging](docs/merging.md) | When and how it merges, and the release train |
| [Inputs and outputs](docs/inputs.md) | The action's interface |
| [Troubleshooting](docs/troubleshooting.md) | Every `reason`, what it means, what to do |
| [Responsible use](docs/responsible-use.md) | What is safe to auto-approve, and the known limits |

Claude Code skills: [`pr-approval-setup`](skills/pr-approval-setup/SKILL.md),
[`pr-approval-diagnose`](skills/pr-approval-diagnose/SKILL.md),
[`pr-approval-caller-sync`](skills/pr-approval-caller-sync/SKILL.md).

## Contributing

Branch from `develop`, Conventional Commits, `npm test` and `npm run lint` before a PR. Rules under
`rules/` change only through the `strspc` CLI. See [CLAUDE.md](CLAUDE.md).

## License

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
