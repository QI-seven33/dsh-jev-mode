// dsh-jev-mode / test/manifest.test.mjs
//
// Bundle integrity: the packaging mistakes that only show up after publication.
//
// Three of these checks correspond to failures that are silent or fatal in a DSH
// profile rather than merely untidy:
//   * a `dsh.client` declaration without a resolvable `exports["./client"]` makes
//     the client-modules loader throw while composing the page graph;
//   * a missing file listed in `files` publishes a package that installs but
//     cannot run;
//   * a runtime dependency is not merely untidy here — a profile-installed bundle
//     cannot resolve harness packages, and pinning them couples the plugin to a
//     harness version, which is this plugin family's dominant failure mode.

import assert from 'node:assert/strict';
import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const results = [];
let failures = 0;

/**
 * Run one check, awaiting it.
 *
 * The async form is not optional: an earlier version of this file passed async
 * callbacks to a synchronous runner, so every `await` inside a check escaped the
 * try/catch and a failing assertion would have been reported as `ok`. A check
 * harness that can report a false pass is worse than no harness.
 */
const test = async (title, fn) => {
  try {
    await fn();
    results.push(`ok   ${title}`);
  } catch (error) {
    failures += 1;
    results.push(`FAIL ${title}\n     ${error?.message ?? error}`);
  }
};

const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));

await test('the package manifest declares the bundle patch', () => {
  assert.equal(pkg.dsh?.bundle?.patch, './cordis.patch.yml');
});

await test('the plugin declares no runtime dependencies', () => {
  const runtime = Object.keys(pkg.dependencies ?? {});
  assert.deepEqual(runtime, [], `runtime dependencies are not allowed here: ${runtime.join(', ')}`);
});

await test('a dsh.client declaration is only allowed with a resolvable ./client export', () => {
  // The client-modules loader reads the row's manifest and throws outright when
  // `dsh.client` is present without `exports["./client"]`.
  const client = pkg.dsh?.client;
  if (client === undefined) {
    assert.equal(pkg.exports?.['./client'], undefined, 'a ./client export without dsh.client is dead weight');
    return;
  }
  assert.equal(client.platform, 'web', 'only the web platform is supported by the browser module table');
  const exportValue = pkg.exports?.['./client'];
  const resolved = typeof exportValue === 'string' ? exportValue : exportValue?.default;
  assert.equal(typeof resolved, 'string', 'exports["./client"] must resolve to a string path');
});

await test('the global settings entry and preset mode resolve to separate modules', async () => {
  const settings = await import('dsh-jev-mode');
  const mode = await import('dsh-jev-mode/mode');
  assert.equal(settings.name, 'jev-settings');
  assert.equal(settings.inject, undefined);
  assert.equal(mode.name, 'jev-mode');
  assert.deepEqual(mode.inject, ['llm', 'tools', 'systemPrompt']);
  const client = await stat(path.join(root, pkg.exports['./client']));
  assert.ok(client.isFile());
});

await test('every file listed in "files" exists', async () => {
  const listed = pkg.files ?? [];
  assert.ok(listed.length > 0, 'files must be declared, or npm publishes whatever is in the directory');
  for (const entry of listed) {
    await stat(path.join(root, entry)); // throws when missing
  }
});

await test('the declared icon exists', async () => {
  if (pkg.icon === undefined) return;
  const info = await stat(path.join(root, pkg.icon));
  assert.ok(info.isFile(), `${pkg.icon} is not a file`);
});

await test('the bundle entry point exists and matches main', async () => {
  const info = await stat(path.join(root, pkg.main ?? 'index.js'));
  assert.ok(info.isFile());
});

await test('the patch row name matches the package name', async () => {
  // A mismatch installs fine and then mounts nothing.
  const patch = await readFile(path.join(root, pkg.dsh.bundle.patch), 'utf8');
  assert.ok(
    patch.includes(`name: '${pkg.name}'`) || patch.includes(`name: "${pkg.name}"`),
    `the patch never names ${pkg.name}`,
  );
});

await test('the locale files are valid JSON and carry display metadata', async () => {
  const dir = path.join(root, 'locale');
  const entries = await readdir(dir);
  assert.ok(entries.includes('en.json') && entries.includes('zh.json'), `locale ids must be language ids: ${entries.join(', ')}`);
  for (const file of entries) {
    const parsed = JSON.parse(await readFile(path.join(dir, file), 'utf8'));
    assert.equal(typeof parsed.meta?.title, 'string', `${file} has no meta.title`);
    assert.equal(typeof parsed.meta?.description, 'string', `${file} has no meta.description`);
  }
});

await test('every text file is strict UTF-8, with no replacement or mojibake characters', async () => {
  // This bundle carries multi-byte text (Chinese in the prompt, the UI copy, and
  // the docs). An editing round-trip through a non-UTF-8 codepage corrupts it in a
  // way that still looks like a text file, and one such accident already cost a
  // repair pass here: eight em dashes lost a byte and the space after them. These
  // three assertions catch that whole class directly, instead of guessing at the
  // character that happened to break.
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const MOJIBAKE = /\u00c3[\u0080-\u00bf]|\u00e2\u20ac|\u00ef\u00bb\u00bf|\ufffd/;
  const text = /\.(js|mjs|json|yml|yaml|md|svg)$/;
  const skip = /[\\/]\.git[\\/]|bench[\\/]results/;
  const offenders = [];
  let scanned = 0;

  const walk = async (dir) => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (skip.test(full)) continue;
      if (entry.isDirectory()) {
        await walk(full);
        continue;
      }
      if (!text.test(entry.name)) continue;
      const bytes = await readFile(full);
      scanned += 1;
      try {
        decoder.decode(bytes);
      } catch {
        offenders.push(`${path.relative(root, full)}: not valid UTF-8`);
        continue;
      }
      const asText = bytes.toString('utf8');
      if (MOJIBAKE.test(asText)) offenders.push(`${path.relative(root, full)}: contains mojibake or U+FFFD`);
    }
  };
  await walk(root);

  assert.ok(scanned > 15, `only scanned ${scanned} files, so this check is not covering the bundle`);
  assert.deepEqual(offenders, [], `text integrity failures:\n  ${offenders.join('\n  ')}`);
});

await test('the manifest stays publishable (no private flag, license and description set)', () => {
  assert.notEqual(pkg.private, true, 'a private package cannot be published');
  assert.equal(typeof pkg.license, 'string');
  assert.equal(typeof pkg.description, 'string');
  assert.ok(pkg.keywords?.includes('dsh-plugin'), 'keywords must make the plugin discoverable');
  assert.equal(pkg.engines?.node !== undefined, true, 'declare the Node floor the plugin actually needs');
});

console.log(results.join('\n'));
console.log(failures === 0 ? `\nall ${results.length} checks passed` : `\n${failures} check(s) FAILED`);
process.exit(failures === 0 ? 0 : 1);
