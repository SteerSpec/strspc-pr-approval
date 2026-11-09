# Agent Instructions

This project uses **bd** (beads) for issue tracking. Run `bd prime` for full workflow context.

## Quick Reference

```bash
bd ready              # Find available work
bd show <id>          # View issue details
bd update <id> --claim  # Claim work atomically
bd close <id>         # Complete work
bd dolt push          # Push beads data to remote
```

## Non-Interactive Shell Commands

**ALWAYS use non-interactive flags** with file operations to avoid hanging on confirmation prompts.

Shell commands like `cp`, `mv`, and `rm` may be aliased to include `-i` (interactive) mode on some systems, causing the agent to hang indefinitely waiting for y/n input.

**Use these forms instead:**
```bash
# Force overwrite without prompting
cp -f source dest           # NOT: cp source dest
mv -f source dest           # NOT: mv source dest
rm -f file                  # NOT: rm file

# For recursive operations
rm -rf directory            # NOT: rm -r directory
cp -rf source dest          # NOT: cp -r source dest
```

**Other commands that may prompt:**
- `scp` - use `-o BatchMode=yes` for non-interactive
- `ssh` - use `-o BatchMode=yes` to fail instead of prompting
- `apt-get` - use `-y` flag
- `brew` - use `HOMEBREW_NO_AUTO_UPDATE=1` env var

<!-- BEGIN BEADS INTEGRATION v:1 profile:minimal hash:ca08a54f -->
## Beads Issue Tracker

This project uses **bd (beads)** for issue tracking. Run `bd prime` to see full workflow context and commands.

### Quick Reference

```bash
bd ready              # Find available work
bd show <id>          # View issue details
bd update <id> --claim  # Claim work
bd close <id>         # Complete work
```

### Rules

- Use `bd` for ALL task tracking — do NOT use TodoWrite, TaskCreate, or markdown TODO lists
- Run `bd prime` for detailed command reference and session close protocol
- Use `bd remember` for persistent knowledge — do NOT use MEMORY.md files

## Session Completion

**When ending a work session**, you MUST complete ALL steps below. Work is NOT complete until `git push` succeeds.

**MANDATORY WORKFLOW:**

1. **File issues for remaining work** - Create issues for anything that needs follow-up
2. **Run quality gates** (if code changed) - Tests, linters, builds
3. **Update issue status** - Close finished work, update in-progress items
4. **PUSH TO REMOTE** - This is MANDATORY:
   ```bash
   git pull --rebase
   bd dolt push
   git push
   git status  # MUST show "up to date with origin"
   ```
5. **Clean up** - Clear stashes, prune remote branches
6. **Verify** - All changes committed AND pushed
7. **Hand off** - Provide context for next session

**CRITICAL RULES:**
- Work is NOT complete until `git push` succeeds
- NEVER stop before pushing - that leaves work stranded locally
- NEVER say "ready to push when you are" - YOU must push
- If push fails, resolve and retry until it succeeds
<!-- END BEADS INTEGRATION -->


## Build & Test

Node 22 (`.nvmrc`). The unit tests use the native test runner.

```bash
npm install
npm test               # unit tests: scripts/pr-approval/**/*.test.js
npm run test:coverage  # same tests + coverage gate (80% line / 70% branch); this is what CI runs
npm run lint           # actionlint (workflows + template) + strspc lint (rules/)
node scripts/backtest.js --repo SteerSpec/strspc-sync --since 2026-09-01   # dry-run replay over PR history
```

`npm run lint` shells out to `actionlint` and `strspc` — install them separately.

## Architecture Overview

A composite GitHub Action (`action.yml`) that approves, and when a policy opts in merges, the pull
requests that never get a Copilot review: promotions (`develop` → `main`), release-please PRs,
release sync-backs, rules pins and template syncs. Copilot-gated PRs belong to
[strspc-pr-review](https://github.com/SteerSpec/strspc-pr-review); the two never act on the same PR.
Everything is API calls; the action never checks out PR code.

- `action.yml` — inputs, outputs, and the github-script step that calls `decide.js`.
- `scripts/pr-approval/decide.js` — orchestration and the universal guards (same repo, not draft,
  approver ≠ author, checks green, re-read around the approval, withdraw stale approvals).
- `scripts/pr-approval/policy.js` — loads `.strspc/pr-approval.yml` **from the base branch**, resolves
  `extends:` (tags/SHAs only), validates it, and picks the first matching policy.
- `scripts/pr-approval/kinds/*.js` — one module per PR kind. Each holds the hard safety checks of
  its kind; a policy can tighten them but never relax them (APPROVE-010).
- `scripts/pr-approval/merge.js` — merge with the App token, pinned to the evaluated head, only
  when a policy enables it (MERGE-001..005).
- `presets/steerspec.yml` — the SteerSpec org policy; consumers `extends:` it or write their own.
- `templates/pr-approval.yml` — the caller workflow repos copy.
- `rules/` — the `dev.steerspec.prapproval` realm (`POLICY`, `APPROVE`, `MERGE`). A behaviour
  change in the scripts goes with a rule change. Edit only through the `strspc` CLI, with a
  `chore(rules):` title.
- `vendor/js-yaml/` — js-yaml 4.1.0 (MIT), vendored because a composite action has no install step.

## Conventions & Patterns

- Branch from `develop` and open PRs against `develop`; `main` only receives release promotions.
  release-please tags `vX.Y.Z` on merge to `main` and moves the `@v1` tag.
- Squash only into `develop`, merge commit only into `main` (rulesets).
- Conventional Commits (`@commitlint/config-conventional`), enforced by the husky `commit-msg`
  hook and, for PR titles, by the `commits` CI job (120 characters at most).
- Tokens: approvals use the bot PAT (`approve-token`), merges use the App token (`merge-token`),
  every read uses `github-token`. Never merge with `GITHUB_TOKEN`: it starts no workflow, so
  release-please would never run after a promotion.
- `docs.test.js` fails if `docs/inputs.md` drifts from `action.yml`.
- `AGENTS.md` is a symlink to this file. `CLAUDE.md` must stay a regular file: SteerSpec Sync
  rewrites it in place.

<!-- STEERSPEC:BEGIN:org-standards -->
## SteerSpec org standards

Managed by [SteerSpec/.claude](https://github.com/SteerSpec/.claude) through
[strspc-sync](https://github.com/SteerSpec/strspc-sync). Change
`templates/CLAUDE.md.mustache` there; edits made here are overwritten by the
next sync.

- **Tiers.** strspc-rules (rule definitions) → strspc-manager (Go engine) →
  strspc-CLI and the other consumers of strspc-manager. Dependencies point
  downward only. Release and tag upstream before bumping a downstream `go.mod`
  or core pin.
- **Pull requests only.** Org rulesets reject direct pushes to the default
  branch and require verified commit signatures; Copilot review and
  pr-auto-approve gate the merge. Agents open PRs and never merge them.
- **Conventional commits** (`type(scope): subject`). Where a repo uses
  release-please, it derives versions and changelogs from them; other repos
  follow the release process in their own README or AGENTS.md.
- **Rules live next to the code.** Each repo owns a realm under `rules/` that
  depends on `dev.steerspec.core`. Author rules through `strspc rule …` so the
  content hashes stay valid; never hand-edit rule JSON.
- **Rule states.** Draft text may still change. Published text is final while
  the code may still violate it. Implemented is enforced in CI (`fail_on: [I]`);
  promote to Implemented only once the code complies.
- **Work tracking.** Multi-session work is tracked in beads (`bd`), not in
  markdown todo files.
- **Org agents.** Architect, Agile PM, Code Review and Release come from the
  `strspc-agents` plugin: `/plugin marketplace add SteerSpec/.claude`, then
  `/plugin install strspc-agents@steerspec`.
<!-- STEERSPEC:END:org-standards -->