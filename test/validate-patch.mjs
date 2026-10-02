// Validate the bundle patch YAML with a real parser.
//
// A syntax error in cordis.patch.yml is not a cosmetic problem: the profile layer
// fails to reconcile and the mode simply does not exist. This script parses the
// file with the `yaml` package shipped inside the DSH installation, registering
// `!!js` as an inert scalar so the Cordis loader dialect parses.
//
// It also asserts the properties that make the patch correct rather than merely
// parseable: one `insert`, a preset row whose `config.id` matches the registry's
// expectation, a unique order, and exactly one `dsh-jev-mode` child row.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const bundle = process.argv[2] ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const yamlEntry = process.argv[3] ?? process.env.DSH_YAML_PATH;

// Candidates may be a bare specifier (resolved from node_modules, which is how
// CI runs after installing the devDependency) or an absolute path into a DSH
// installation (which is how a developer gets a real parse without installing
// anything here).
const YAML_CANDIDATES = [
  yamlEntry,
  'yaml',
  'E:/Deepseek-Harness/dsh-learn/deepseek-harness/node_modules/yaml/dist/index.js',
  'E:/SOME_SEVEN_PROJECT-57/_recon/asar/dsh/node_modules/yaml/dist/index.js',
].filter(Boolean);

let YAML;
let used = 'none';
for (const candidate of YAML_CANDIDATES) {
  try {
    YAML = await import(candidate.includes('/') || candidate.includes('\\') ? pathToFileURL(candidate).href : candidate);
    used = candidate;
    break;
  } catch {
    // try the next candidate
  }
}
if (YAML === undefined) {
  console.log('SKIP: no yaml parser found. Pass its entry point as the second argument, set DSH_YAML_PATH,');
  console.log('      or install the devDependency (npm i yaml).');
  process.exit(0);
}
// yaml v2 exposes named exports; older builds expose a default namespace object.
const parse = YAML.parse ?? YAML.default?.parse;
if (typeof parse !== 'function') {
  console.error(`the yaml package at ${used} exposes no parse export`);
  process.exit(2);
}

const file = path.join(bundle, 'cordis.patch.yml');
const raw = fs.readFileSync(file, 'utf8');
// `!!js` is the Cordis loader dialect: an expression evaluated at load time. It is
// stripped to a plain scalar so the *structure* can be validated with a stock
// parser; the expressions themselves are exercised by the live install instead.
const text = raw.replace(/!!js\s+/g, '');
const doc = parse(text);

const checks = [];
const check = (label, condition, detail = '') => checks.push({ label, ok: Boolean(condition), detail });

check('the patch parses as YAML', Array.isArray(doc), `top level is ${Array.isArray(doc) ? 'an array' : typeof doc}`);
check('the patch has exactly one layer entry', doc.length === 1, `saw ${doc.length}`);
check('the layer inserts a row list', Array.isArray(doc[0]?.insert), 'missing insert:');

const rows = doc[0]?.insert ?? [];
const preset = rows.find((row) => row?.config?.id === 'jev');
check('it inserts a preset row with config.id "jev"', preset !== undefined);
check('the preset row names the preset package', preset?.name === '@deepseek-ai/dsh-agent-preset', String(preset?.name));
check('the preset order is a finite number', Number.isFinite(preset?.config?.order), String(preset?.config?.order));
check(
  'the preset order does not collide with a shipped preset',
  ![1, 2, 3, 4].includes(preset?.config?.order),
  `order ${preset?.config?.order}; shipped orders are standard 1, ptc 2, minimal 3, cordis 4`,
);
check('the preset declares a display name', typeof preset?.config?.name === 'string' && preset.config.name.length > 0);

check('exactly one global settings anchor', rows.filter(row => row?.name === 'dsh-jev-mode' && row.id === 'jev-settings').length === 1);

const children = preset?.config?.plugins ?? [];
const jevRows = children.filter((row) => row?.name === 'dsh-jev-mode/mode');
check('exactly one dsh-jev-mode child row', jevRows.length === 1, `saw ${jevRows.length}`);
check('the dsh-jev-mode row carries a config object', typeof jevRows[0]?.config === 'object' && jevRows[0].config !== null);
check('the row id is unique inside the preset', new Set(children.map((row) => row?.id)).size === children.length);

// The mode must reproduce the whole shipped standard capability set or it is not
// "standard plus decisions" but a different, smaller mode.
const standard = fs.readFileSync(path.join(bundle, 'cordis.patch.yml'), 'utf8');
check('the patch is not empty', standard.length > 1000, `${standard.length} bytes`);
const expectedChildren = ['persona', 'agent-instructions', 'tool-fs', 'tool-fs-search', 'tool-jobs', 'tool-ask-user', 'tool-todo', 'tool-web', 'present'];
for (const id of expectedChildren) {
  check(`the standard row "${id}" is present`, children.some((row) => row?.id === id));
}
check('the plan-mode group is present', children.some((row) => row?.id === 'planning' && row?.group === true));
check('the compaction group is present', children.some((row) => row?.id === 'compaction' && row?.group === true));
check('the delegation group is present', children.some((row) => row?.id === 'delegation' && row?.group === true));

const failed = checks.filter((entry) => !entry.ok);
for (const entry of checks) console.log(`${entry.ok ? 'ok  ' : 'FAIL'} ${entry.label}${entry.detail ? `  (${entry.detail})` : ''}`);
console.log(failed.length === 0 ? `\n${checks.length} patch checks passed` : `\n${failed.length} patch check(s) FAILED`);
process.exit(failed.length === 0 ? 0 : 1);
