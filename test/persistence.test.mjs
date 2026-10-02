// Exercise the shipped codec AND durable agent loop; an in-memory session alone
// does not validate producer-owned message sources at the V4 write boundary.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import * as nodeModule from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const candidates = process.env.DSH_HOST_NODE_MODULES ? [process.env.DSH_HOST_NODE_MODULES] : [
  'E:/SOME_SEVEN_PROJECT-57/_recon/asar/dsh/node_modules',
  'E:/Deepseek-Harness/dsh-desktop/resources/app.asar.unpacked/dsh/node_modules',
];
const base = candidates.find(p => existsSync(path.join(p, '@deepseek-ai/dsh-session-persistence-jsonl/lib/index.js')));
if (!base) {
  if (process.env.DSH_ALLOW_SKIPPED_HOST_PERSISTENCE === '1') {
    console.log('SKIPPED: native persistence tests; set DSH_HOST_NODE_MODULES to the installed host.');
    process.exit(0);
  }
  throw Error('Native persistence tests require DSH_HOST_NODE_MODULES; no host found.');
}
// ASAR extraction leaves native binaries in app.asar.unpacked. This is only a
// test loader for the borrowed host, never a plugin runtime dependency.
const { registerHooks } = nodeModule;
const nativeBase = process.env.DSH_HOST_NATIVE_NODE_MODULES
  ?? 'E:/Deepseek-Harness/dsh-desktop/resources/app.asar.unpacked/dsh/node_modules';
if (existsSync(nativeBase)) registerHooks({ resolve(specifier, context, nextResolve) {
  if (specifier.endsWith('.node') && context.parentURL?.startsWith('file:')) {
    const parent = fileURLToPath(context.parentURL);
    const original = path.resolve(path.dirname(parent), specifier);
    const relative = path.relative(base, original);
    if (!relative.startsWith('..') && !path.isAbsolute(relative)) {
      const actual = path.join(nativeBase, relative);
      if (!existsSync(original) && existsSync(actual)) return nextResolve(actual, context);
    }
  }
  return nextResolve(specifier, context);
} });
const mod = name => import(pathToFileURL(path.join(base, name, 'lib/index.js')));
const [{ Context }, llm, sessions, system, tools, agents, loop, projections, persistence, catalog, plugin] = await Promise.all([
  mod('@deepseek-ai/cordis'), mod('@deepseek-ai/dsh-llm'), mod('@deepseek-ai/dsh-session'),
  mod('@deepseek-ai/dsh-system-prompt'), mod('@deepseek-ai/dsh-tools'), mod('@deepseek-ai/dsh-agent'),
  mod('@deepseek-ai/dsh-agent-loop'), mod('@deepseek-ai/dsh-session-projection'),
  mod('@deepseek-ai/dsh-session-persistence-jsonl'), mod('@deepseek-ai/dsh-session-format-catalog'),
  import(process.env.JEV_PLUGIN_ENTRY ? pathToFileURL(path.resolve(process.env.JEV_PLUGIN_ENTRY)) : '../index.js'),
]);
const root = await mkdtemp(path.join(os.tmpdir(), 'jev-v4-persistence-'));
const seen = [];
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', x => body += x);
  req.on('end', () => {
    seen.push(JSON.parse(body));
    res.end(JSON.stringify({ answers: { route: { type: 'choice', choice: 'mutate', confidence: .95, probabilities: { mutate: .95 } } } }));
  });
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const live = new Set();
const results = [];
async function host(compression) {
  const ctx = new Context();
  live.add(ctx);
  const requests = [];
  class Adapter extends llm.LlmAdapter {
    async resolveModel(provider, model) { return { provider, id: model, name: model, systemPromptUpdate: 'in-history', toolUpdate: 'in-history' }; }
    async *stream(options) {
      requests.push(options);
      yield { type: 'block-start', index: 0, blockType: 'text' };
      yield { type: 'text-delta', index: 0, text: 'done' };
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'done' } };
      yield { type: 'finish', reason: { kind: 'stop' } };
    }
  }
  for (const p of [llm, sessions, projections, system, tools, agents]) await ctx.plugin(p.default);
  await ctx.plugin(persistence.default, { root: path.join(root, compression), compression });
  await ctx.plugin(loop.default, { agents: [] });
  ctx.llm.registerAdapter(['mock'], new Adapter());
  await ctx.plugin(plugin, { backend: 'typesafe', autoRoute: true, ledger: false,
    typesafe: { apiKey: 'synthetic-key', endpoint: `http://127.0.0.1:${server.address().port}`, model: 'test' } });
  return { ctx, requests };
}
async function close(ctx) { await ctx.fiber.dispose(); live.delete(ctx); }
async function turn(ctx, agent, text) {
  let stop;
  let timer;
  try {
    const idle = new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(Error('agent did not finish the turn')), 15000);
      stop = ctx.on('agent/status', ({ agent: a, status }) => { if (a === agent && status === 'idle') resolve(); });
    });
    agent.followup(llm.createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] }));
    await idle;
    await ctx.sessionPersistence.flush();
  } finally { clearTimeout(timer); stop?.(); }
}
const notices = events => events.filter(e => e.type === 'user/message' && e.data.source?.kind === 'plugin:dsh-jev-mode');
try {
  // Pin the exact screenshot failure with the native V4 encoder, before testing
  // the actual message produced by the plugin through the live durable loop.
  const legacy = { type: 'user/message', seq: 0, time: Date.now(), data: {
    id: 'legacy-regression', role: 'user', source: { kind: 'plugin', plugin: 'dsh-jev-mode' }, content: [{ type: 'text', text: 'advice' }],
  } };
  assert.throws(() => catalog.sessionFormatCatalog.encodeCurrentEvent(legacy), /format v4 message requires a producer-owned source kind/);
  console.log('ok native V4 codec reproduces the exact legacy-source failure');
  for (const compression of ['none', 'zstd']) {
    const id = sessions.SessionId(`jev-v4-${compression}`);
    const first = await host(compression);
    const agent = await first.ctx.agentLoop.create(id, { provider: 'mock', model: 'mock' });
    await turn(first.ctx, agent, 'Fix fixture A');
    await turn(first.ctx, agent, 'Fix fixture B');
    assert.equal(first.requests.length, 2, 'both turns must reach the main model');
    const before = agent.session.snapshotEvents();
    assert.equal(notices(before).length, 2);
    for (const e of before) catalog.sessionFormatCatalog.encodeCurrentEvent(e);
    assert.deepEqual(first.requests[1].messages.slice(0, first.requests[0].messages.length), first.requests[0].messages, 'old model-visible prefix changed');
    assert.deepEqual(first.requests[1].tools, first.requests[0].tools, 'tool catalog changed');
    await close(first.ctx);
    const second = await host(compression);
    const reader = await second.ctx.sessionPersistence.open(id, 'read');
    const reread = (await reader.read()).events;
    await reader.close();
    assert.deepEqual(reread, before, 'cold read must preserve every durable event');
    const resumed = await second.ctx.agentLoop.resume(second.ctx, { resumeSessionId: id, agentOptions: { provider: 'mock', model: 'mock' } });
    await turn(second.ctx, resumed.agent, 'Fix fixture C after reopening');
    assert.equal(second.requests.length, 1);
    assert.deepEqual(second.requests[0].messages.slice(0, first.requests[1].messages.length), first.requests[1].messages, 'reopening changed the previous model-visible prefix');
    assert.equal(notices(resumed.agent.session.snapshotEvents()).length, 3);
    await close(second.ctx);
    const third = await host(compression);
    const finalReader = await third.ctx.sessionPersistence.open(id, 'read');
    const finalEvents = (await finalReader.read()).events;
    await finalReader.close();
    assert.equal(notices(finalEvents).length, 3, 'resumed route notice was not durable');
    const files = await readdir(path.join(root, compression), { recursive: true });
    const filename = files.find(f => f.endsWith(compression === 'none' ? '.jsonl' : '.jsonl.zstd'));
    assert.ok(filename, 'no durable file created');
    if (compression === 'none') {
      const disk = await readFile(path.join(root, compression, filename), 'utf8');
      assert.ok(disk.includes('plugin:dsh-jev-mode'));
      assert.ok(!disk.includes('"kind":"plugin"'));
    }
    await close(third.ctx);
    results.push({ compression, turns: 3, routingNotices: 3, coldReadIdentical: true, resumedTurnSucceeded: true, priorPrefixUnchanged: true, toolCatalogUnchanged: true });
    console.log(`ok ${compression}: two durable turns, cold reopen, resumed third turn, unchanged prefix and tools`);
  }
  assert.equal(seen.length, 6, 'exactly one real HTTP routing request per human turn');
  console.log(JSON.stringify({ format: catalog.sessionFormatCatalog.currentVersion, root, routeHttpCalls: seen.length, results }, null, 2));
} finally {
  for (const ctx of live) await ctx.fiber.dispose();
  await new Promise(resolve => server.close(resolve));
}
