# Changelog

## [1.1.0](https://github.com/SteerSpec/strspc-pr-approval/compare/v1.0.1...v1.1.0) (2026-11-26)


### Features

* let Copilot's latest review veto an approval ([#19](https://github.com/SteerSpec/strspc-pr-approval/issues/19)) ([29d9288](https://github.com/SteerSpec/strspc-pr-approval/commit/29d92883a257f43e7f57d64363b8a78a65c6f5f9))

## [1.0.1](https://github.com/SteerSpec/strspc-pr-approval/compare/v1.0.0...v1.0.1) (2026-11-16)


### Bug Fixes

* an empty companion-workflow means the default, 'off' disables it ([#10](https://github.com/SteerSpec/strspc-pr-approval/issues/10)) ([3ac2f3b](https://github.com/SteerSpec/strspc-pr-approval/commit/3ac2f3b940effae3495cef61f2ab725b2c7d38ac))
* identify strspc-pr-review's job by its run, not its name alone ([#9](https://github.com/SteerSpec/strspc-pr-approval/issues/9)) ([a9e928b](https://github.com/SteerSpec/strspc-pr-approval/commit/a9e928b109623163fc84e4a3d7627b43447c7946))
* ignore strspc-pr-review's unfinished auto-approve check ([#7](https://github.com/SteerSpec/strspc-pr-approval/issues/7)) ([76abeec](https://github.com/SteerSpec/strspc-pr-approval/commit/76abeec4c3d858592c27ae09f40f8ac5ce4b9c4c))

## 1.0.0 (2026-11-10)


### Features

* policy-driven approval and merge of promotion, release and bot PRs ([9607c5c](https://github.com/SteerSpec/strspc-pr-approval/commit/9607c5c5d8cacbe8adc12cc61263e9d9f44b8acc))
* policy-driven approval and merge of promotion, release and bot PRs ([754d3fc](https://github.com/SteerSpec/strspc-pr-approval/commit/754d3fc3ee1029ee61b91794f53f3947d27db28d))


### Bug Fixes

* address Copilot review on merge, re-reads and rule states ([ab818f3](https://github.com/SteerSpec/strspc-pr-approval/commit/ab818f3562abd83e7c000a86dc7b0e1461a8832c))
* address second Copilot review on merge-time revalidation ([be64f11](https://github.com/SteerSpec/strspc-pr-approval/commit/be64f118cf4839852c7ef7ef2dfc9ea7a04725c2))
* anchor the approval marker and fail closed on a malformed one ([005f05e](https://github.com/SteerSpec/strspc-pr-approval/commit/005f05ec5948754e7880ba2fa3143cce438c487e))
* refuse release PRs that are behind their base ([fa050d7](https://github.com/SteerSpec/strspc-pr-approval/commit/fa050d7b589a09c52ed3744590ae3754960a32fc))
* scope withdrawals to marked approvals, withdraw on retarget, prove custom commits ([a7d6e63](https://github.com/SteerSpec/strspc-pr-approval/commit/a7d6e633cbc6dbc25d07b6b6a59b25c4ab7a51d0))
* wait for mergeability after approving, accept cancelled checks, pin first release to 1.0.0 ([edbe653](https://github.com/SteerSpec/strspc-pr-approval/commit/edbe65391cae439361317ac7fec43f37235c7085))
