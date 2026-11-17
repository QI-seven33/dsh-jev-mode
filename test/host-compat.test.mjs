// Compare against the installed host, not a second copy of our own preset.
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const base = process.env.DSH_HOST_NODE_MODULES;
const standard = base && path.join(base, '@deepseek-ai/dsh-web-app/presets/standard.patch.yml');
if (!standard || !existsSync(standard)) {
  if (process.env.DSH_ALLOW_SKIPPED_HOST_PERSISTENCE === '1') {
    console.log('SKIPPED: installed-host preset compatibility; set DSH_HOST_NODE_MODULES.');
    process.exit(0);
  }
  throw Error('Installed-host preset compatibility requires DSH_HOST_NODE_MODULES.');
}
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(path.join(base, '../package.json'));
const { parse } = await import(pathToFileURL(require.resolve('yaml')));
const load = file => parse(readFileSync(file, 'utf8').replace(/!!js\s+/g, ''));
const native = load(standard)[0].insert[0].config.plugins;
const preset = load(path.join(root, 'cordis.patch.yml'))[0].insert.find(r => r.config?.id === 'jev');
const extra = preset.config.plugins.filter(r => r.name === 'dsh-jev-mode/mode');
assert.equal(extra.length, 1);
assert.deepEqual(preset.config.plugins.filter(r => r.name !== 'dsh-jev-mode/mode'), native);
let resolved = 0;
function walk(rows) {
  for (const row of rows) {
    if (row.disabled === true) continue;
    if (row.name?.startsWith('@deepseek-ai/')) {
      assert.ok(require.resolve(row.name), row.name);
      resolved++;
    }
    if (row.group) walk(row.config);
  }
}
walk(preset.config.plugins);
const hostVersion = JSON.parse(readFileSync(path.join(base, '@deepseek-ai/dsh-agent-preset/package.json'), 'utf8')).version;
const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
assert.equal(pkg.engines.dsh, hostVersion);
assert.equal(extra[0].config.authorizeThreshold, 0.85);
assert.equal(extra[0].config.authorizeAskBand, 0.55);
assert.equal(extra[0].config.gateAtRisk, 2);
console.log(`ok installed Desktop ${hostVersion}: exact standard capability parity and ${resolved} native plugin exports resolve`);
