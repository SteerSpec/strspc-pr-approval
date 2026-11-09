#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Replays the decision over a repository's PR history, writing nothing.
//
//   node scripts/backtest.js --repo SteerSpec/strspc-sync [--since 2026-09-01] [--limit 200]
//                            [--pr 186] [--policy presets/steerspec.yml] [--bot-login cnslr-bt] [--json]
//
// Token: $GITHUB_TOKEN, else `gh auth token`. Read-only API calls only.
//
// The policy is read from a LOCAL file (default presets/steerspec.yml), with
// relative extends and the realm resolved on disk, so a repository that has no
// policy yet can be measured. Each merged or open PR is evaluated as if it were
// open at its head: the tip check, the re-reads and every write are skipped.
//
// Not replayable, and reported as such: a release policy's `source` check reads
// today's branches, not the branches at the time, so it is switched off here;
// a sync-back compares its files with today's release branch, so an older
// sync-back reads as "differs" once a later release moved that branch on;
// pin/template supersession reads today's open PRs.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { decideInner } = require('./pr-approval/decide.js');
const kinds = require('./pr-approval/kinds/index.js');
const policyLib = require('./pr-approval/policy.js');

function parseArgs(argv) {
  const args = { since: null, limit: 200, policy: 'presets/steerspec.yml', botLogin: 'cnslr-bt', json: false, pr: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--repo') args.repo = next();
    else if (a === '--since') args.since = next();
    else if (a === '--limit') args.limit = Number(next());
    else if (a === '--policy') args.policy = next();
    else if (a === '--bot-login') args.botLogin = next();
    else if (a === '--pr') args.pr = Number(next());
    else if (a === '--json') args.json = true;
    else throw new Error(`unknown argument ${a}`);
  }
  if (!args.repo || !/^[^/]+\/[^/]+$/.test(args.repo)) throw new Error('--repo Owner/repo is required');
  return args;
}

function token() {
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;
  return execFileSync('gh', ['auth', 'token'], { encoding: 'utf8' }).trim();
}

// A read-only client: any non-GET REST call or a mutation throws, so a bug
// here can never write to a real repository.
function readOnly(octokit) {
  octokit.hook.before('request', (options) => {
    const method = String(options.method || 'GET').toUpperCase();
    const isGraphql = /\/graphql$/.test(options.url || '');
    if (isGraphql) {
      if (/^\s*mutation\b/.test(String((options.query) || ''))) throw new Error('backtest: refused a GraphQL mutation');
      return;
    }
    if (method !== 'GET' && method !== 'HEAD') throw new Error(`backtest: refused ${method} ${options.url}`);
  });
  return octokit;
}

// Loads the local policy file with relative sources read from disk.
async function loadLocalPolicy(file) {
  const root = path.resolve(file);
  const repoRoot = path.resolve(__dirname, '..');
  const fakeGithub = {
    rest: {
      repos: {
        getContent: async ({ path: p }) => {
          const abs = path.join(repoRoot, p);
          if (!fs.existsSync(abs)) { const e = new Error('Not Found'); e.status = 404; throw e; }
          const content = fs.readFileSync(abs);
          return { data: { type: 'file', size: content.length, encoding: 'base64', content: content.toString('base64') } };
        },
      },
      git: { getRef: async () => ({ data: {} }) },
    },
  };
  const rel = path.relative(repoRoot, root).split(path.sep).join('/');
  return policyLib.loadPolicy({
    github: fakeGithub,
    policyGithub: fakeGithub,
    kinds,
    root: { owner: 'local', repo: 'local', ref: 'local', path: rel, remote: false },
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  // ESM-only since v9, so imported rather than required.
  const { getOctokit } = await import('@actions/github');
  const github = readOnly(getOctokit(token(), { retry: { enabled: true, retries: 3 } }));
  const [owner, repo] = args.repo.split('/');

  const loaded = await loadLocalPolicy(args.policy);
  if (!loaded) throw new Error(`${args.policy} not found`);
  // Not replayable: see the header.
  const policies = loaded.policies.map((p) => (p.kind === 'release' && p.options && p.options.source
    ? { ...p, options: { ...p.options, source: undefined }, _note: 'source check not replayed' }
    : p));

  let prs;
  if (args.pr) {
    prs = [(await github.rest.pulls.get({ owner, repo, pull_number: args.pr })).data];
  } else {
    let seen = 0;
    prs = await github.paginate(github.rest.pulls.list, { owner, repo, state: 'all', per_page: 100, sort: 'created', direction: 'desc' },
      (resp, done) => {
        seen += resp.data.length;
        if (seen >= args.limit) done();
        return resp.data;
      });
    prs = prs.slice(0, args.limit);
    if (args.since) prs = prs.filter((p) => p.created_at >= args.since);
  }

  const rows = [];
  for (const pr of prs) {
    if (pr.state === 'closed' && !pr.merged_at) {
      rows.push({ number: pr.number, title: pr.title, policy: '', decision: 'closed-unmerged', reason: 'not replayed', actual: 'closed' });
      continue;
    }
    const outputs = {};
    const core = {
      info: () => {}, warning: () => {}, error: () => {}, setFailed: () => {},
      setOutput: (k, v) => { outputs[k] = v; },
    };
    const context = { repo: { owner, repo }, payload: { pull_request: pr }, runId: 0, job: 'backtest' };
    let result;
    try {
      result = await decideInner({
        github,
        botGithub: github,
        mergeGithub: null,
        context,
        core,
        env: { PR_APPROVAL_BOT_LOGIN: args.botLogin, PR_APPROVAL_DRY_RUN: 'true' },
        kinds,
        replay: true,
        loadPolicyFn: async () => ({ policies, files: loaded.files }),
      });
    } catch (err) {
      result = { decision: 'error', reason: err.message };
    }
    rows.push({
      number: pr.number,
      title: pr.title,
      head: pr.head.ref,
      base: pr.base.ref,
      author: pr.user && pr.user.login,
      policy: outputs.policy || '',
      decision: result.decision,
      reason: result.reason,
      actual: pr.merged_at ? `merged ${pr.merged_at.slice(0, 10)}` : pr.state,
    });
  }

  if (args.json) {
    process.stdout.write(`${JSON.stringify(rows, null, 2)}\n`);
    return;
  }
  const matched = rows.filter((r) => r.policy);
  const byPolicy = {};
  for (const r of matched) {
    const b = (byPolicy[r.policy] = byPolicy[r.policy] || { 'would approve': 0, refused: 0 });
    if (r.decision === 'dry-run') b['would approve']++; else b.refused++;
  }
  console.log(`${args.repo}: ${rows.length} PR(s), ${matched.length} matched a policy`);
  for (const [p, c] of Object.entries(byPolicy)) console.log(`  ${p}: ${c['would approve']} would approve, ${c.refused} refused`);
  console.log('');
  for (const r of matched) {
    console.log(`#${r.number}\t${r.policy}\t${r.decision}\t${r.actual}\t${r.title}\n\t${r.reason}`);
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`backtest: ${err.message}`);
    process.exit(1);
  });
}

module.exports = { parseArgs, readOnly, loadLocalPolicy };
