# Policy reference

The policy file is YAML (`.strspc/pr-approval.yml` by default). Editors can validate it against
[`schema/pr-approval.v1.json`](../schema/pr-approval.v1.json); the action validates it itself and,
when it is invalid, takes no action and fails the job (POLICY-004).

```yaml
version: 1                       # required
realm: <source>                  # required when the file declares policies
extends: [<source>, ...]         # at most 5
policies:
  - id: release                  # unique, lower-case
    kind: release                # promotion | release | sync-back | pin | template-sync | custom
    rules: [APPROVE-006]         # realm rule IDs this policy enforces (at least one)
    description: free text
    match: {...}                 # which PRs this policy is for
    require: {...}               # extra conditions (tightening only)
    options: {...}               # kind-specific
    approve: true                # false = matched, but take no action (blocks later policies)
    merge: { enabled: false, method: merge }
```

## Sources

`github://Owner/repo@<ref>/path` or a path relative to the file that names it (same repository, same
ref). `<ref>` must be a **tag or a full commit SHA**; a branch is refused (POLICY-002). Chains deeper
than 3 or with a cycle are refused (POLICY-003).

## Realm and rule IDs

Each policy cites the prose rules it enforces. At load time every cited ID must exist, not withdrawn,
in the realm its own file names (`<realm>/<ENTITY>.json`). Reviews, logs and the `reason` output quote
them (POLICY-005). The realm is the human-readable contract; the policy is its executable form.

## Order

The root file's policies come first, in file order; a root policy with the `id` of an inherited one
replaces it. Inherited policies follow, in `extends` order. The first policy whose `match` the PR
satisfies applies (POLICY-006). A PR no policy matches is left alone.

## match

| Key | Meaning |
|---|---|
| `base`, `head` | glob or list of globs on the branch names (`*` stops at `/`, `**` does not) |
| `authors` | logins, exact (`steerspec-sync[bot]`) |
| `title` | Unicode regular expression, at most 200 characters |
| `labels` | every label must be present |

A key the policy leaves out takes the kind's default (below).

## require

Conditions on top of the kind's own checks. They can only refuse (APPROVE-010).

| Key | Refuses when |
|---|---|
| `checks` | a named check has not run on the head or did not succeed |
| `paths` | a changed file matches none of the globs |
| `forbid-paths` | a changed file matches one of the globs |
| `max-files`, `max-additions`, `max-deletions` | the diff is larger |
| `no-labels` | the PR carries one of the labels |

## Kinds

Every kind first passes the universal guards: same-repository head, not draft, not authored by the
approving account, every check on the head green (APPROVE-001..004).

| Kind | Default match | Options | Proves (realm rule) |
|---|---|---|---|
| `promotion` | head `develop`, base `main` | — | head is the branch tip; title `chore:` and not breaking; every commit came from a merged PR into the head branch with a standing approval of its final head by someone with push access (APPROVE-005) |
| `release` | head `release-please--branches--*`, author = `options.author` | `author` (required), `source` | head is the tip; the author wrote the PR and every commit (verified, web-flow); every file is owned by release-please as configured at the base; `source` holds nothing the changelog would show (APPROVE-006). Re-checked before a merge (MERGE-005) |
| `sync-back` | head `chore/sync-release-*`, base `develop`, author | `author` (required), `release-branch` (default `main`) | every commit by the author; every file release-please-owned and identical to the release branch (APPROVE-007) |
| `pin` | head `chore/core-*`, author | `author` (required), `files` (narrows) | files within `rules/realm.json`, `.strspc/config.yaml`, `rules/_schema/**`; no newer pin PR open (APPROVE-008) |
| `template-sync` | head `steerspec-sync/*/*`, author, label | `author` (required), `label` (default `steerspec-sync`), `paths` (narrows) | label present; no newer PR for the same template open (APPROVE-009) |
| `custom` | — (must set `match.base` and `match.authors`) | — | nothing beyond the guards, so it needs at least one `require` condition |

## merge

Off unless `enabled: true` (MERGE-001). See [merging.md](merging.md).
