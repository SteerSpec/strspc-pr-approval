// SPDX-License-Identifier: Apache-2.0
// Policy resolution (realm entity POLICY).
//
// A policy file is the executable form of a realm's prose rules: each policy
// selects pull requests (match), names the built-in kind whose hard checks
// apply, may tighten them (require), and cites the realm rule IDs it enforces.
//
//   POLICY-001  read from the base branch, never the head
//   POLICY-002  extends only a tag or a full commit SHA, never a branch
//   POLICY-003  no cycles, bounded depth
//   POLICY-004  an invalid policy means no action at all
//   POLICY-005  every policy cites rule IDs; decisions quote them
//   POLICY-006  first match wins, in file order after extends are merged

const path = require('path');
const yaml = require('../../vendor/js-yaml/js-yaml.js');
const { toList, matchesAnyGlob } = require('./util.js');

const POLICY_VERSION = 1;
const MAX_EXTENDS_DEPTH = 3;
const MAX_EXTENDS_PER_FILE = 5;
const MAX_POLICY_BYTES = 64 * 1024;
const MAX_TITLE_REGEX = 200;
const SHA_RE = /^[0-9a-f]{40}$/;
const ID_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;
const RULE_ID_RE = /^(?:([a-z][a-z0-9]*(?:\.[a-z][a-z0-9]*)*):)?([A-Za-z0-9]{3,18})-(\d{3,})$/;
const MERGE_METHODS = ['merge', 'squash', 'rebase'];

class PolicyError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PolicyError';
  }
}

// github://Owner/repo@ref/path/to/file -> { owner, repo, ref, path }.
// A relative path ("./x.yml", "presets/x.yml") is resolved against the file
// that names it, in the same repository and at the same ref.
function parseSource(source, from) {
  const s = String(source || '').trim();
  const m = /^github:\/\/([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+)@([^/\s]+)\/(.+)$/.exec(s);
  if (m) {
    const p = path.posix.normalize(m[4]);
    if (p.startsWith('..')) throw new PolicyError(`source '${s}' escapes its repository`);
    return { owner: m[1], repo: m[2], ref: m[3], path: p, remote: true };
  }
  if (/^[a-z]+:\/\//i.test(s)) throw new PolicyError(`source '${s}' is not github://Owner/repo@ref/path`);
  if (!from) throw new PolicyError(`relative source '${s}' has nothing to resolve against`);
  const p = path.posix.normalize(path.posix.join(path.posix.dirname(from.path), s));
  if (p.startsWith('..') || path.posix.isAbsolute(p)) throw new PolicyError(`source '${s}' escapes its repository`);
  return { owner: from.owner, repo: from.repo, ref: from.ref, path: p, remote: from.remote, refChecked: from.refChecked };
}

const sourceKey = (s) => `${s.owner}/${s.repo}@${s.ref}/${s.path}`.toLowerCase();

// POLICY-002: a full SHA, or a ref that exists as a tag and not as a branch.
async function assertImmutableRef({ github, owner, repo, ref }) {
  if (SHA_RE.test(ref)) return;
  const exists = async (r) => {
    try {
      await github.rest.git.getRef({ owner, repo, ref: r });
      return true;
    } catch (err) {
      if (err.status === 404) return false;
      throw err;
    }
  };
  if (await exists(`heads/${ref}`)) {
    throw new PolicyError(`${owner}/${repo}@${ref} names a branch; extends must pin a tag or a full commit SHA`);
  }
  if (!(await exists(`tags/${ref}`))) {
    throw new PolicyError(`${owner}/${repo}@${ref} is neither a tag nor a full commit SHA`);
  }
}

async function fetchText({ github, owner, repo, ref, path: p }) {
  let data;
  try {
    ({ data } = await github.rest.repos.getContent({ owner, repo, path: p, ref }));
  } catch (err) {
    if (err.status === 404) return null;
    throw err;
  }
  if (Array.isArray(data) || data.type !== 'file') throw new PolicyError(`${owner}/${repo}@${ref}/${p} is not a file`);
  if (data.size > MAX_POLICY_BYTES) throw new PolicyError(`${owner}/${repo}@${ref}/${p} is larger than ${MAX_POLICY_BYTES} bytes`);
  return Buffer.from(data.content || '', data.encoding || 'base64').toString('utf8');
}

function parseYaml(text, where) {
  try {
    // JSON_SCHEMA: no timestamps, no custom tags, nothing that builds objects
    // beyond plain maps, lists, strings, numbers, booleans and null.
    return yaml.load(text, { schema: yaml.JSON_SCHEMA, filename: where });
  } catch (err) {
    throw new PolicyError(`${where} is not valid YAML: ${err.reason || err.message}`);
  }
}

// ---------------------------------------------------------------------------
// Validation (POLICY-004). Hand-written rather than a JSON Schema engine: the
// action has no install step. schema/pr-approval.v1.json documents the same
// shape for editors, and policy.test.js checks the two agree on the keys.

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isStringOrList = (v) => typeof v === 'string' || (Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === 'string' && x));
const isStringList = (v) => Array.isArray(v) && v.every((x) => typeof x === 'string' && x);
const isPositiveInt = (v) => Number.isInteger(v) && v >= 0;

function unknownKeys(obj, allowed, where, errors) {
  for (const k of Object.keys(obj)) if (!allowed.includes(k)) errors.push(`${where}: unknown key '${k}'`);
}

const MATCH_KEYS = ['base', 'head', 'authors', 'title', 'labels'];
const REQUIRE_KEYS = ['checks', 'paths', 'forbid-paths', 'max-files', 'max-additions', 'max-deletions', 'no-labels'];
const POLICY_KEYS = ['id', 'kind', 'rules', 'description', 'match', 'require', 'options', 'approve', 'merge'];
const FILE_KEYS = ['version', 'realm', 'extends', 'policies'];

function validateMatch(match, where, errors) {
  if (!isPlainObject(match)) { errors.push(`${where}: must be a mapping`); return; }
  unknownKeys(match, MATCH_KEYS, where, errors);
  for (const k of ['base', 'head']) if (k in match && !isStringOrList(match[k])) errors.push(`${where}.${k}: must be a glob or a list of globs`);
  for (const k of ['authors', 'labels']) if (k in match && !isStringList(match[k])) errors.push(`${where}.${k}: must be a list of strings`);
  if ('title' in match) {
    if (typeof match.title !== 'string' || match.title.length > MAX_TITLE_REGEX) {
      errors.push(`${where}.title: must be a regular expression of at most ${MAX_TITLE_REGEX} characters`);
    } else {
      try { new RegExp(match.title, 'u'); } catch (err) { errors.push(`${where}.title: ${err.message}`); }
    }
  }
}

function validateRequire(req, where, errors) {
  if (!isPlainObject(req)) { errors.push(`${where}: must be a mapping`); return; }
  unknownKeys(req, REQUIRE_KEYS, where, errors);
  // Non-empty: an empty `paths` would bound nothing while looking like a bound.
  for (const k of ['checks', 'paths', 'forbid-paths', 'no-labels']) {
    if (k in req && (!isStringList(req[k]) || req[k].length === 0)) errors.push(`${where}.${k}: must be a non-empty list of strings`);
  }
  for (const k of ['max-files', 'max-additions', 'max-deletions']) if (k in req && !isPositiveInt(req[k])) errors.push(`${where}.${k}: must be a non-negative integer`);
}

function validateMergeBlock(merge, where, errors) {
  if (!isPlainObject(merge)) { errors.push(`${where}: must be a mapping`); return; }
  unknownKeys(merge, ['enabled', 'method'], where, errors);
  if ('enabled' in merge && typeof merge.enabled !== 'boolean') errors.push(`${where}.enabled: must be true or false`);
  if ('method' in merge && !MERGE_METHODS.includes(merge.method)) errors.push(`${where}.method: must be one of ${MERGE_METHODS.join(', ')}`);
}

// `kinds` maps a kind name to its module, whose validateOptions checks the
// kind-specific `options` block.
function validatePolicyFile(doc, where, kinds) {
  const errors = [];
  if (!isPlainObject(doc)) return [`${where}: must be a mapping`];
  unknownKeys(doc, FILE_KEYS, where, errors);
  if (doc.version !== POLICY_VERSION) errors.push(`${where}.version: must be ${POLICY_VERSION}`);
  if ('realm' in doc && typeof doc.realm !== 'string') errors.push(`${where}.realm: must be a source string`);
  if ('extends' in doc) {
    if (!isStringList(doc.extends)) errors.push(`${where}.extends: must be a list of sources`);
    else if (doc.extends.length > MAX_EXTENDS_PER_FILE) errors.push(`${where}.extends: at most ${MAX_EXTENDS_PER_FILE} entries`);
  }
  const policies = doc.policies === undefined ? [] : doc.policies;
  if (!Array.isArray(policies)) {
    errors.push(`${where}.policies: must be a list`);
    return errors;
  }
  if (policies.length > 0 && typeof doc.realm !== 'string') {
    errors.push(`${where}.realm: required when the file declares policies, so their rule IDs can be resolved (POLICY-005)`);
  }
  const seen = new Set();
  policies.forEach((p, i) => {
    const w = `${where}.policies[${i}]`;
    if (!isPlainObject(p)) { errors.push(`${w}: must be a mapping`); return; }
    unknownKeys(p, POLICY_KEYS, w, errors);
    if (typeof p.id !== 'string' || !ID_RE.test(p.id)) errors.push(`${w}.id: must match ${ID_RE}`);
    else if (seen.has(p.id)) errors.push(`${w}.id: '${p.id}' is declared twice`);
    else seen.add(p.id);
    if (!kinds[p.kind]) errors.push(`${w}.kind: must be one of ${Object.keys(kinds).join(', ')}`);
    if (!isStringList(p.rules) || p.rules.length === 0) errors.push(`${w}.rules: must cite at least one realm rule ID (POLICY-005)`);
    else {
      for (const r of p.rules) {
        const m = RULE_ID_RE.exec(r);
        if (!m) errors.push(`${w}.rules: '${r}' is not a rule ID such as APPROVE-006`);
        // v1 resolves IDs in the policy file's own realm only; a realm prefix
        // would silently be looked up in the wrong place.
        else if (m[1]) errors.push(`${w}.rules: '${r}' names realm ${m[1]}; cite rules of the realm this file names, without a prefix`);
      }
    }
    if ('description' in p && typeof p.description !== 'string') errors.push(`${w}.description: must be a string`);
    if ('match' in p) validateMatch(p.match, `${w}.match`, errors);
    // custom has no built-in proof, so it must at least pin who and where.
    if (p.kind === 'custom' && !(isPlainObject(p.match) && p.match.base && p.match.authors)) {
      errors.push(`${w}.match: kind custom needs match.base and match.authors`);
    }
    // ...and bound what the diff may contain: a label condition alone restricts nothing.
    if (p.kind === 'custom' && !(isPlainObject(p.require) &&
        ['paths', 'max-files'].some((k) => k in p.require))) {
      errors.push(`${w}.require: kind custom needs paths or max-files`);
    }
    if ('require' in p) validateRequire(p.require, `${w}.require`, errors);
    if ('approve' in p && typeof p.approve !== 'boolean') errors.push(`${w}.approve: must be true or false`);
    if ('merge' in p) validateMergeBlock(p.merge, `${w}.merge`, errors);
    if ('options' in p && !isPlainObject(p.options)) errors.push(`${w}.options: must be a mapping`);
    else if (kinds[p.kind] && typeof kinds[p.kind].validateOptions === 'function') {
      for (const e of kinds[p.kind].validateOptions(p.options || {})) errors.push(`${w}.options: ${e}`);
    }
  });
  return errors;
}

// ---------------------------------------------------------------------------
// Realm citations (POLICY-005): every cited rule must exist in the realm the
// policy's own file names, and must not be withdrawn. An entity file is read
// once per run.

async function makeRuleResolver({ github, cache = new Map() }) {
  return async function ruleExists(realmSource, ruleId) {
    const m = RULE_ID_RE.exec(ruleId);
    const entity = m[2];
    const file = { ...realmSource, path: path.posix.join(realmSource.path, `${entity}.json`) };
    const key = sourceKey(file);
    if (!cache.has(key)) {
      const text = await fetchText({ github, ...file });
      let doc = null;
      if (text !== null) {
        try { doc = JSON.parse(text); } catch { throw new PolicyError(`${key} is not valid JSON`); }
      }
      cache.set(key, doc);
    }
    const doc = cache.get(key);
    if (!doc) return `entity ${entity} not found at ${key}`;
    const rule = (doc.rules || []).find((r) => r.id === `${entity}-${m[3]}`);
    if (!rule) return `rule ${ruleId} not found in ${key}`;
    // R (Retired) and T (Terminated) are the schema's end-of-life states.
    if (rule.state === 'R' || rule.state === 'T') return `rule ${ruleId} is ${rule.state === 'R' ? 'retired' : 'terminated'}`;
    return null;
  };
}

// ---------------------------------------------------------------------------
// Loading and merging.

// Loads `root` (POLICY-001: the caller passes the base ref), resolves extends
// depth-first, validates every file and every rule citation. Returns
//   { policies: [{ ...policy, source, realm }], files: [sourceKey...] }
// Policies of the root file come first, in file order; a root policy with the
// id of an inherited one replaces it. Inherited policies follow in extends
// order (POLICY-006).
async function loadPolicy({ github, policyGithub = github, root, kinds, checkRules = true }) {
  const files = [];
  const ruleExists = await makeRuleResolver({ github: policyGithub });

  async function loadFile(source, depth, chain) {
    const key = sourceKey(source);
    if (chain.includes(key)) throw new PolicyError(`extends cycle: ${[...chain, key].join(' -> ')}`);
    if (depth > MAX_EXTENDS_DEPTH) throw new PolicyError(`extends deeper than ${MAX_EXTENDS_DEPTH} at ${key}`);
    const client = depth === 0 ? github : policyGithub;
    if (depth > 0 && source.remote && !source.refChecked) {
      await assertImmutableRef({ github: client, owner: source.owner, repo: source.repo, ref: source.ref });
      source = { ...source, refChecked: true };
    }
    const text = await fetchText({ github: client, ...source });
    if (text === null) {
      if (depth === 0) return null;
      throw new PolicyError(`extended policy ${key} not found`);
    }
    const doc = parseYaml(text, key);
    const errors = validatePolicyFile(doc, key, kinds);
    if (errors.length) throw new PolicyError(`invalid policy: ${errors.join('; ')}`);
    files.push(key);

    let realm = null;
    if (doc.realm) {
      realm = parseSource(doc.realm, source);
      // Same repository at the same ref as this file needs no check; any other
      // repository does, even when its ref is spelt like this file's branch.
      const sameRef = realm.owner.toLowerCase() === source.owner.toLowerCase() &&
        realm.repo.toLowerCase() === source.repo.toLowerCase() && realm.ref === source.ref;
      if (realm.remote && !sameRef && !realm.refChecked) {
        await assertImmutableRef({ github: policyGithub, owner: realm.owner, repo: realm.repo, ref: realm.ref });
      }
    }
    const own = (doc.policies || []).map((p) => ({ ...p, source: key, realm: realm ? sourceKey(realm) : null, _realm: realm }));
    if (checkRules) {
      for (const p of own) {
        for (const r of p.rules) {
          const problem = await ruleExists(p._realm, r);
          if (problem) throw new PolicyError(`policy '${p.id}' (${key}) cites ${r}: ${problem}`);
        }
      }
    }
    let inherited = [];
    for (const ext of doc.extends || []) {
      const child = parseSource(ext, source);
      const loaded = await loadFile(child, depth + 1, [...chain, key]);
      inherited = inherited.concat(loaded.policies);
    }
    return { policies: mergeById(own, inherited) };
  }

  const loaded = await loadFile(root, 0, []);
  if (!loaded) return null;
  return { policies: loaded.policies.map(({ _realm, ...p }) => p), files };
}

function mergeById(own, inherited) {
  const ids = new Set(own.map((p) => p.id));
  const seen = new Set();
  const rest = [];
  for (const p of inherited) {
    if (ids.has(p.id) || seen.has(p.id)) continue;
    seen.add(p.id);
    rest.push(p);
  }
  return [...own, ...rest];
}

// ---------------------------------------------------------------------------
// Matching (POLICY-006).

// The kind's defaults fill any match key the policy leaves out, so `kind:
// release` alone already selects only release-please branches.
function effectiveMatch(policy, kinds) {
  const kind = kinds[policy.kind];
  const defaults = kind && typeof kind.defaultMatch === 'function' ? kind.defaultMatch(policy.options || {}) : {};
  return { ...defaults, ...(policy.match || {}) };
}

// Why `pr` does not match, or null when it does.
function matchMiss(pr, match) {
  const base = pr.base && pr.base.ref;
  const head = pr.head && pr.head.ref;
  const author = pr.user && pr.user.login;
  const labels = new Set((pr.labels || []).map((l) => (typeof l === 'string' ? l : l.name)));
  if (match.base !== undefined && !matchesAnyGlob(base, match.base)) return `base ${base} not in [${toList(match.base).join(', ')}]`;
  if (match.head !== undefined && !matchesAnyGlob(head, match.head)) return `head ${head} not in [${toList(match.head).join(', ')}]`;
  if (match.authors !== undefined && !toList(match.authors).includes(author)) return `author ${author} not in [${toList(match.authors).join(', ')}]`;
  if (match.title !== undefined && !new RegExp(match.title, 'u').test(String(pr.title || ''))) return 'title does not match';
  const missing = toList(match.labels).filter((l) => !labels.has(l));
  if (missing.length) return `missing label(s) ${missing.join(', ')}`;
  return null;
}

function matchPolicy(policies, pr, kinds) {
  for (const p of policies) {
    if (!matchMiss(pr, effectiveMatch(p, kinds))) return p;
  }
  return null;
}

// ---------------------------------------------------------------------------
// require: conditions any policy may add on top of its kind (APPROVE-010:
// tightening only; nothing here can relax a kind's own checks).
//
// `files` is the compare listing of the evaluated head (null when it cannot be
// listed), `checkRuns` the deduped runs of the head.
function requireBlocker({ pr, require: req = {}, files, checkRuns = [] }) {
  const labels = new Set((pr.labels || []).map((l) => (typeof l === 'string' ? l : l.name)));
  const blocked = toList(req['no-labels']).find((l) => labels.has(l));
  if (blocked) return `carries label '${blocked}'`;
  for (const name of toList(req.checks)) {
    const run = checkRuns.find((cr) => cr.name === name);
    if (!run) return `required check '${name}' has not run on the head`;
    if (run.status !== 'completed') return `required check '${name}' is still running`;
    if (run.conclusion !== 'success') return `required check '${name}' concluded ${run.conclusion}`;
  }
  const needsFiles = ['paths', 'forbid-paths', 'max-files', 'max-additions', 'max-deletions'].some((k) => k in req);
  if (!needsFiles) return null;
  if (!files) return 'changed files cannot be completely listed';
  if ('max-files' in req && files.length > req['max-files']) return `changes ${files.length} files, more than ${req['max-files']}`;
  const add = files.reduce((n, f) => n + (f.additions || 0), 0);
  const del = files.reduce((n, f) => n + (f.deletions || 0), 0);
  if ('max-additions' in req && add > req['max-additions']) return `adds ${add} lines, more than ${req['max-additions']}`;
  if ('max-deletions' in req && del > req['max-deletions']) return `deletes ${del} lines, more than ${req['max-deletions']}`;
  const names = files.flatMap((f) => [f.filename, f.previous_filename]).filter(Boolean);
  if (req.paths) {
    const outside = names.find((n) => !matchesAnyGlob(n, req.paths));
    if (outside) return `changes ${outside}, outside the allowed paths`;
  }
  if (req['forbid-paths']) {
    const hit = names.find((n) => matchesAnyGlob(n, req['forbid-paths']));
    if (hit) return `changes ${hit}, a forbidden path`;
  }
  return null;
}

module.exports = {
  POLICY_VERSION,
  MAX_EXTENDS_DEPTH,
  MAX_EXTENDS_PER_FILE,
  MERGE_METHODS,
  MATCH_KEYS,
  REQUIRE_KEYS,
  POLICY_KEYS,
  FILE_KEYS,
  PolicyError,
  parseSource,
  sourceKey,
  assertImmutableRef,
  fetchText,
  parseYaml,
  validatePolicyFile,
  makeRuleResolver,
  loadPolicy,
  mergeById,
  effectiveMatch,
  matchMiss,
  matchPolicy,
  requireBlocker,
};
