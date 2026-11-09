# Security Policy

## Supported versions

Security fixes go to the latest release of the current major version (`@v1`). There are no
long-term support branches.

## Reporting a vulnerability

**Please do not open a public GitHub issue for security problems.**

Report privately through [GitHub security advisories](https://github.com/SteerSpec/strspc-pr-approval/security/advisories/new),
or email <security@steerspec.dev>, with:

- A description of the issue and why you believe it is a security problem
- Steps to reproduce, or a proof of concept
- The version or commit you tested against
- Any suggested mitigation, if you have one

You can expect an acknowledgement within 5 business days. We will keep you informed as we
investigate, and will credit you in the release notes when a fix ships unless you'd rather stay
anonymous. Please give us a reasonable window to release a fix before disclosing publicly.

## Scope

This action approves pull requests with a bot token and can merge them with a GitHub App token, so
any way to get a pull request approved or merged that the policy should have refused is in scope.
Findings that are especially relevant include:

- A pull request influencing the policy that judges it (the policy must come from the base branch)
- `extends:` or `realm:` resolution reaching a mutable or unintended source
- A kind accepting content that was not produced or reviewed the way its rule requires
  (provenance, file ownership, commit authorship and signatures)
- An approval or merge surviving a change of head, base, title, labels or checks
- Token leakage into logs, outputs, review bodies or job summaries
