import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import * as anchor from '../settings.js';
const source = await readFile(new URL('../client.js', import.meta.url), 'utf8');
let module;
vm.runInNewContext(source, { window: { __ModuleLoader__: { load(row) {
  assert.equal(row.id, 'dsh-jev-mode');
  module = row.factory(id => { assert.ok(['react', '@deepseek-ai/dsh-client-ui-primitives'].includes(id)); return {}; });
} } } });
const checks = [];
async function test(label, fn) { await fn(); checks.push(label); }
await test('settings anchor has no agent injections or registrations', () => {
  assert.equal(anchor.inject, undefined);
  anchor.apply(new Proxy({}, { get() { throw Error('settings anchor touched an agent service'); } }));
});
await test('browser ABI injects only UI and write-only credential services', () => {
  assert.deepEqual(Array.from(module.inject), ['slots', 'locale', 'remote', 'remote.credentials']);
});
await test('credential reads project metadata and discard any secret or arbitrary fields', async () => {
  const ops = module.createOperations({ describe: async refs => {
    assert.deepEqual(Array.from(refs), ['TYPESAFE_API_KEY']);
    return { ok: true, value: { TYPESAFE_API_KEY: { configured: true, writable: true, source: 'file', value: 'synthetic-private-value', key: 'synthetic-private-value' } } };
  } });
  const result = await ops.describe();
  assert.equal(result.ok, true);
  assert.deepEqual(Object.keys(result.info).sort(), ['configured', 'source', 'writable']);
  assert.ok(!JSON.stringify(result).includes('synthetic-private-value'));
});
await test('save and removal use exactly the runtime credential reference', async () => {
  const calls = [];
  const ops = module.createOperations({ set: async (...args) => { calls.push(args); return { ok: true }; }, unset: async (...args) => { calls.push(args); return { ok: true }; } });
  assert.equal((await ops.save('synthetic-key')).ok, true);
  assert.equal((await ops.remove()).ok, true);
  assert.deepEqual(calls, [['TYPESAFE_API_KEY', 'synthetic-key'], ['TYPESAFE_API_KEY']]);
});
await test('server rejection and thrown network error never echo the credential', async () => {
  const ops = module.createOperations({ describe: async () => ({ ok: false, error: { message: 'synthetic-key' } }), set: async () => { throw Error('synthetic-key'); }, unset: async () => ({ ok: false, error: { message: 'synthetic-key' } }) });
  for (const result of [await ops.describe(), await ops.save('synthetic-key'), await ops.remove()]) {
    assert.equal(result.ok, false); assert.ok(!JSON.stringify(result).includes('synthetic-key'));
  }
});
await test('malformed description fails closed instead of offering a writable form', async () => {
  for (const info of [null, {}, { configured: false }, { writable: true }, { configured: 'yes', writable: true }]) {
    const ops = module.createOperations({ describe: async () => ({ ok: true, value: { TYPESAFE_API_KEY: info } }) });
    assert.equal((await ops.describe()).ok, false);
  }
});
await test('input rejects variable assignments, quotes, whitespace and control characters', () => {
  assert.equal(module.validKey('synthetic-key'), true);
  for (const value of ['', 'TYPESAFE_API_KEY=synthetic-key', '"synthetic-key"', 'two keys', 'key\n', '\u0000', 'x'.repeat(8193)]) assert.equal(module.validKey(value), false);
});
await test('one declared model-footer slot owns the card and is disposed with its styles', () => {
  const effects = [], declarations = [], subscriptions = [];
  let style;
  const sandbox = { window: { __ModuleLoader__: { load(row) { module = row.factory(() => ({})); } } }, document: {
    createElement(tag) { assert.equal(tag, 'style'); style = { remove() { style.removed = true; } }; return style; },
    head: { append(node) { assert.equal(node, style); } },
  } };
  vm.runInNewContext(source, sandbox);
  const ctx = { effect(fn) { effects.push(fn()); }, locale: { register(ns, copy) { assert.equal(ns, 'settings.jev'); assert.equal(Object.keys(copy.zh).length, Object.keys(copy.en).length); return () => {}; }, bind: () => key => key },
    remote: { credentials: {}, $on: name => { subscriptions.push(name); return () => {}; } }, on: name => { subscriptions.push(name); return () => {}; },
    slots: { inject(name, fn) { assert.equal(name, 'settings.models.footer'); return fn(); }, register(row, component) { declarations.push({ row, component }); return () => {}; } },
  };
  module.apply(ctx);
  assert.equal(declarations.length, 1);
  assert.equal(declarations[0].row.id, 'jev-credentials');
  assert.equal(declarations[0].component, module.JevSettingsCard);
  const props = declarations[0].row.inject(); props.subscribe(() => {})();
  assert.deepEqual(subscriptions, ['credentials/reference-updated', 'connection/reset']);
  for (const dispose of effects) dispose?.();
  assert.equal(style.removed, true);
});
console.log(checks.map(x => 'ok   ' + x).join('\n') + `\n\n${checks.length} settings checks passed`);
