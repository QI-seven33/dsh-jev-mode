// Scan the bundle for credential-shaped literals, so publishing cannot leak one.
//
// A fixture copied from a real conversation looks like any other fixture: nothing
// in the code review screams. This check makes every credential-shaped literal an
// explicit, allowlisted decision, and the allowlist may only contain values that
// are self-evidently synthetic.
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(process.argv[2] ?? path.dirname(fileURLToPath(import.meta.url)), '..');

// Values that are obviously invented. Appending to this list is the only way to
// silence the check, which forces the question "is this actually a secret?".
const SYNTHETIC = new Set([
  'apikey_0123456789abcdef0123456789abcdef',
  'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345',
  'sk-abcdefghijklmnopqrstuvwx',
  'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ01',
]);

const SHAPES = [
  ['api key', /apikey_[A-Za-z0-9_-]{16,}/g],
  ['github token', /\bgh[pous]_[A-Za-z0-9]{16,}/g],
  ['openai-style key', /\bsk-[A-Za-z0-9]{16,}/g],
  ['long hex blob', /\b[0-9a-f]{40,}\b/gi],
];

const TEXT = /\.(js|mjs|json|yml|yaml|md|svg)$/;
const SKIP = /[\\/]\.git[\\/]|bench[\\/]results/;

const findings = [];
let scanned = 0;
const walk = async (dir) => {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (SKIP.test(full)) continue;
    if (entry.isDirectory()) {
      await walk(full);
      continue;
    }
    if (!TEXT.test(entry.name)) continue;
    scanned += 1;
    const text = await readFile(full, 'utf8');
    for (const [label, pattern] of SHAPES) {
      pattern.lastIndex = 0;
      for (const match of text.matchAll(pattern)) {
        const value = match[0];
        if (SYNTHETIC.has(value)) continue;
        const line = text.slice(0, match.index).split('\n').length;
        findings.push(`${path.relative(root, full)}:${line}: ${label} -> ${value.slice(0, 12)}…`);
      }
    }
  }
};
await walk(root);

console.log(`scanned ${scanned} text files`);
if (findings.length === 0) {
  console.log('no credential-shaped literal outside the synthetic allowlist');
  process.exit(0);
}
console.log('\ncredential-shaped literals found:');
for (const finding of findings) console.log(`  ${finding}`);
console.log('\nIf a value is genuinely invented, add it to SYNTHETIC in this file.');
console.log('Never add a value that came from a real key, token, or conversation.');
process.exit(1);
