// SPDX-License-Identifier: Apache-2.0
// Reads a rendered caller workflow on stdin and exits 1 unless every `secrets`
// reference in it names one of the allowed secrets (argv). The workflow is
// parsed, so YAML comments drop out and everything else counts, a `#` line
// inside a run: block included: Actions evaluates expressions there too.
// Contexts are case-insensitive (SECRETS.X works), and any other syntax
// (secrets['X'], toJSON(secrets)) is refused rather than recognised: every
// occurrence of the word must be an allowed dot reference.
'use strict';
const path = require('node:path');
const yaml = require(path.join(__dirname, '../../vendor/js-yaml/js-yaml.js'));

const allowed = new Set(process.argv.slice(2).map((s) => s.toUpperCase()));
const strings = [];
const walk = (v) => {
  if (typeof v === 'string') strings.push(v);
  else if (Array.isArray(v)) v.forEach(walk);
  else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { strings.push(k); walk(x); }
};

let doc;
try {
  doc = yaml.load(require('node:fs').readFileSync(0, 'utf8'));
} catch (err) {
  console.error(`secret-guard: the workflow does not parse: ${err.message}`);
  process.exit(1);
}
walk(doc);
const bad = [];
for (const s of strings) {
  const all = s.match(/secrets/gi) || [];
  const ok = [...s.matchAll(/secrets\.([A-Za-z0-9_]+)/gi)].filter((m) => allowed.has(m[1].toUpperCase()));
  if (all.length !== ok.length) bad.push(s.length > 120 ? `${s.slice(0, 117)}...` : s);
}
if (bad.length) {
  console.error(`secret-guard: references outside ${[...allowed].join(', ')}:\n  ${bad.join('\n  ')}`);
  process.exit(1);
}
