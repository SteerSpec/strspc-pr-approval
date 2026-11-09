# strspc-pr-approval

Approve — and, when you opt in, merge — the pull requests nobody should have to click through by hand:
promotions (`develop` → `main`), release-please PRs, release sync-backs, rules pins and template syncs.

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

## License

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
