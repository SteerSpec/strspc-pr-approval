# Responsible use

This action approves and can merge code without a human looking at it. It is safe only for PRs
whose content is fully determined by something that was already reviewed or generated:

- **Promotions** carry commits that each merged through an approved PR (provenance).
- **Release PRs** carry only release-please output, by the release identity.
- **Sync-backs** copy files that are byte-identical to the released branch.
- **Pins and template syncs** change a fixed, small set of files, by a bot.

Do not use `kind: custom` to auto-approve human-authored code. Keep `extends:` pinned to tags you
control; a tag you do not control is someone else's merge button. Start every new repository in
dry-run and backtest it.

## Known limit: provenance reads today's access

A promotion's provenance counts an approval only from a reviewer with push access, and GitHub
reports that access as it is *now*, not as it was when the source PR merged: there is no API for
historical access. A reviewer who gained push access later can therefore make an old approval
count. Keep push access tight, and review access grants as you would a merge.
