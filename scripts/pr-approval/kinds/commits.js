// SPDX-License-Identifier: Apache-2.0
// Commit provenance for the bot kinds (sync-back, pin, template-sync).
//
// A person with push access can add a commit to the bot's branch and the PR
// author stays the bot, so the PR author proves nothing about the content.
// Every commit must be the bot's own: authored by it, signed (verified), and
// committed by GitHub (web-flow) or the bot itself. The rule is release.js's
// isReleaseCommit, loaded lazily so a kind module loads on its own; this file
// only adds the shared listing guards and the refusal wording.

const GITHUB_COMMITTER = 'web-flow';

// null when every commit on the PR is a verified commit by `author`, else the
// refusal reason.
async function commitsBlocker({ github, owner, repo, pr, author, label = 'PR' }) {
  const { isReleaseCommit, MAX_LISTED_COMMITS } = require('./release.js');
  const commits = await github.paginate(github.rest.pulls.listCommits, {
    owner, repo, pull_number: pr.number, per_page: 100,
  });
  // listCommits stops at 250, so a list that long may hide a commit.
  if (commits.length >= MAX_LISTED_COMMITS) {
    return `${label} has ${MAX_LISTED_COMMITS} commits or more, so its authors cannot be proven`;
  }
  // A list without the evaluated head describes some other head.
  const headSha = String((pr.head && pr.head.sha) || '');
  if (!commits.some((c) => c.sha === headSha)) {
    return `commit list does not include the evaluated head ${headSha.slice(0, 8)}`;
  }
  const stranger = commits.find((c) => !isReleaseCommit(c, author));
  if (!stranger) return null;
  const sha8 = String(stranger.sha).slice(0, 8);
  const committer = stranger.committer && stranger.committer.login;
  const byAuthor = Boolean(stranger.author) && stranger.author.login === author &&
    (committer === GITHUB_COMMITTER || committer === author);
  return byAuthor ? `commit ${sha8} is not verified` : `commit ${sha8} is not by ${author}`;
}

module.exports = { commitsBlocker, GITHUB_COMMITTER };
