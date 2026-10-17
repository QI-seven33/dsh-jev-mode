// Native host, native filesystem/read/permission waterfall, native V4 disk.
// Mock models here prove control flow only, never production performance.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, writeFile, readFile, symlink } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import * as nodeModule from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { eligibleRequest, selectControlled, controlledCandidates, reuseVisibleEvidence } from '../lib/controlled.js';

const base = process.env.DSH_HOST_NODE_MODULES ?? 'E:/SOME_SEVEN_PROJECT-57/_recon/asar/dsh/node_modules';
if (!existsSync(path.join(base, '@deepseek-ai/dsh-session-persistence-jsonl/lib/index.js'))) {
  if (process.env.DSH_ALLOW_SKIPPED_HOST_PERSISTENCE === '1') {
    console.log('SKIPPED: native controlled-flow tests; set DSH_HOST_NODE_MODULES to the installed host.'); process.exit(0);
  }
  throw Error('Native controlled-flow tests require an installed host and Node 24.');
}
const { registerHooks } = nodeModule;
const native = process.env.DSH_HOST_NATIVE_NODE_MODULES ?? 'E:/Deepseek-Harness/dsh-desktop/resources/app.asar.unpacked/dsh/node_modules';
registerHooks({ resolve(specifier, context, next) {
  if (specifier.endsWith('.node') && context.parentURL?.startsWith('file:')) {
    const original = path.resolve(path.dirname(fileURLToPath(context.parentURL)), specifier);
    const rel = path.relative(base, original), actual = path.join(native, rel);
    if (!rel.startsWith('..') && !existsSync(original) && existsSync(actual)) return next(actual, context);
  }
  return next(specifier, context);
} });
const mod = n => import(pathToFileURL(path.join(base, '@deepseek-ai', n, 'lib/index.js')));
const [{ Context }, llm, sessions, system, tools, agents, loop, projections, persistence, catalog, fsLocal, toolFs, plugin] = await Promise.all([
  mod('cordis'), mod('dsh-llm'), mod('dsh-session'), mod('dsh-system-prompt'), mod('dsh-tools'), mod('dsh-agent'),
  mod('dsh-agent-loop'), mod('dsh-session-projection'), mod('dsh-session-persistence-jsonl'), mod('dsh-session-format-catalog'),
  mod('dsh-fs-local'), mod('dsh-tool-fs'), import('../index.js'),
]);
const root = await mkdtemp(path.join(os.tmpdir(), 'jev-controlled-'));
let choice = 'project_manifest', confidence = .98, httpCalls = 0, decisionDelay = 0;
let authorizationProbability = .1, authorizationHook, authorizationStatus = 200;
const server = http.createServer((req, res) => {
  let body = ''; req.on('data', b => body += b); req.on('end', () => {
    httpCalls++; const data = JSON.parse(body);
    if (data.questions.authorize) {
      if (authorizationStatus === 429) {
        res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '30' });
        res.end('{"error":"synthetic rate limit"}');
        return;
      }
      const respond = () => { if (!res.writableEnded && !res.destroyed) res.end(JSON.stringify({ answers: { authorize: { type: 'noul', noul: authorizationProbability } } })); };
      if (authorizationHook) authorizationHook(respond); else respond();
      return;
    }
    assert.ok(data.questions.dispatch);
    const payload = JSON.stringify({ answers: { dispatch: { type: 'choice', choice, confidence,
      probabilities: { [choice]: confidence, ...(choice !== 'none' ? { none: 1 - confidence } : { project_manifest: 1 - confidence }) } } } });
    if (decisionDelay) setTimeout(() => res.end(payload), decisionDelay);
    else res.end(payload);
  });
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const contexts = new Set();
async function host(id, { enabled = true, deny = false, compression = 'none', pluginConfig = {} } = {}) {
  const cwd = path.join(root, id); await mkdir(cwd); await writeFile(path.join(cwd, 'package.json'), '{"name":"fixture-app","dependencies":{"vite":"7.0.0"}}');
  await writeFile(path.join(cwd, 'README.md'), '# fixture-app\nUse npm test.\n');
  const ctx = new Context(); contexts.add(ctx); const requests = [], executions = [];
  class Adapter extends llm.LlmAdapter {
    async resolveModel(provider, model) { return { provider, id: model, name: model, systemPromptUpdate: 'in-history', toolUpdate: 'in-history' }; }
    async *stream(options) {
      requests.push(options);
      const evidence = options.messages.some(m => m.role === 'tool' || m.source?.summary?.includes('controlled=') || m.content?.some(b => b.type === 'text' && b.text.includes('Plugin inspection result')));
      if (!evidence && requests.length % 2 === 1 && !deny) {
        yield { type: 'block-start', index: 0, blockType: 'tool-call' };
        yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: `call-${requests.length}`, name: 'read', arguments: JSON.stringify({ file_path: path.join(cwd, 'package.json') }) } };
        yield { type: 'finish', reason: { kind: 'tool-calls' } };
      } else {
        yield { type: 'block-start', index: 0, blockType: 'text' };
        yield { type: 'block-end', index: 0, block: { type: 'text', text: 'fixture-app uses vite 7.0.0' } };
        yield { type: 'finish', reason: { kind: 'stop' } };
      }
    }
  }
  for (const p of [llm, sessions, projections, system, tools, agents]) await ctx.plugin(p.default);
  await ctx.plugin(fsLocal.default, {}); await ctx.plugin(toolFs);
  await ctx.plugin(persistence.default, { root: path.join(root, `${id}-disk`), compression });
  await ctx.plugin(loop.default, { agents: [] }); ctx.llm.registerAdapter(['fixture'], new Adapter());
  if (deny) ctx.on('tools/pre-execute', async (_exec, _next) => ({ kind: 'deny', reason: 'fixture permission refusal' }));
  ctx.on('tools/result', (exec, result) => { executions.push({ name: exec.name, error: !!result.error, callId: exec.callId }); });
  if (enabled) await ctx.plugin(plugin, { backend: 'typesafe', autoRoute: false, controlledFlow: true, ledger: false,
    typesafe: { apiKey: 'synthetic-key', endpoint: `http://127.0.0.1:${server.address().port}`, model: 'test' }, ...pluginConfig });
  const agent = await ctx.agentLoop.create(sessions.SessionId(id), { provider: 'fixture', model: 'fixture' }, { cwd });
  return { ctx, agent, cwd, requests, executions };
}
async function turn(h, text) {
  let stop, timer;
  try {
    const idle = new Promise((resolve, reject) => { timer = setTimeout(() => reject(Error('turn timed out')), 15000);
      stop = h.ctx.on('agent/status', ({ agent, status }) => { if (agent === h.agent && status === 'idle') resolve(); }); });
    h.agent.followup(llm.createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] }));
    await idle; await h.ctx.sessionPersistence.flush();
    for (const event of h.agent.session.snapshotEvents()) catalog.sessionFormatCatalog.encodeCurrentEvent(event);
  } finally { clearTimeout(timer); stop?.(); }
}
async function close(h) { await h.ctx.fiber.dispose(); contexts.delete(h.ctx); }
const notices = h => h.agent.session.snapshotEvents().filter(e => e.type === 'user/message' && e.data.source?.summary?.includes('controlled='));
try {
  const standard = await host('standard', { enabled: false }); await turn(standard, 'What dependencies are in package.json?');
  assert.equal(standard.requests.length, 2); assert.equal(standard.executions.length, 1); await close(standard);
  for (const compression of ['none', 'zstd']) {
    choice = 'project_manifest';
    const h = await host(`controlled-${compression}`, { compression }); await turn(h, 'package.json 中的依赖是什么？');
    assert.equal(h.requests.length, 1, 'controlled read must replace the first main-model planning request');
    assert.equal(h.executions.length, 1); assert.ok(h.executions[0].callId.startsWith('jev-controlled-'));
    assert.equal(notices(h).length, 1); assert.ok(notices(h)[0].data.content[0].text.includes('vite'));
    choice = 'project_readme'; await turn(h, 'Read README.md and describe project usage.');
    assert.equal(h.requests.length, 2); assert.equal(h.executions.length, 2);
    assert.deepEqual(h.requests[1].messages.slice(0, h.requests[0].messages.length), h.requests[0].messages);
    assert.deepEqual(h.requests[1].tools, h.requests[0].tools);
    const reader = await h.ctx.sessionPersistence.open(h.agent.session.id, 'read');
    const events = (await reader.read()).events; await reader.close();
    assert.equal(events.filter(e => e.data?.source?.summary?.includes('controlled=')).length, 2);
    await close(h);
    const cold = new Context(); contexts.add(cold);
    await cold.plugin(sessions.default); await cold.plugin(persistence.default, { root: path.join(root, `controlled-${compression}-disk`), compression });
    const coldReader = await cold.sessionPersistence.open(sessions.SessionId(`controlled-${compression}`), 'read');
    const reread = (await coldReader.read()).events; await coldReader.close(); assert.deepEqual(reread, events);
    await cold.fiber.dispose(); contexts.delete(cold);
    console.log(`ok controlled ${compression}: real read, two turns, V4 disk and cold reopen, unchanged previous prefix/catalog, standard 2 vs controlled 1 scripted model calls`);
  }
  assert.equal(httpCalls, 0, 'all explicit controlled reads must use zero decision HTTP calls');
  const zero = await host('zero-budget', {pluginConfig:{maxDecisionsPerSession:0}});
  await turn(zero,'package.json 的项目名称是什么？'); assert.equal(zero.executions.length,1); assert.equal(httpCalls,0);
  const status = await zero.ctx.tools.execute({name:'jev_status',arguments:{},callId:'native-status',agent:zero.agent,signal:AbortSignal.timeout(1000)});
  assert.equal(status.isError,false); assert.equal(status.value.version,JSON.parse(await readFile(new URL('../package.json',import.meta.url),'utf8')).version);
  assert.equal(status.value.codeSelections,1); assert.equal(status.value.semanticSelections,0); assert.equal(status.value.decisions,0);
  await close(zero);
  const dual = await host('two-files'); await turn(dual,'README.md 的用途与 package.json 的依赖分别是什么？');
  assert.equal(httpCalls,0); assert.equal(notices(dual).length,0); await close(dual);
  choice = 'project_manifest'; const sem = await host('semantic');
  await turn(sem,'package.json 里的依赖是什么？README.md 的内容无需回答。');
  assert.equal(httpCalls,1); assert.equal(sem.requests.length,1); assert.match(notices(sem)[0].data.source.summary,/selector=jev/); await close(sem);
  const off = await host('semantic-off', {pluginConfig:{semanticReads:false}}); const offBefore=httpCalls;
  await turn(off,'package.json 里的依赖是什么？README.md 的内容无需回答。');
  assert.equal(httpCalls,offBefore); assert.equal(notices(off).length,0); await close(off);
  decisionDelay = 600;
  const slow = await host('semantic-timeout', {pluginConfig:{routeTimeoutMs:200}}); const slowBefore=httpCalls;
  await turn(slow,'package.json 里的依赖是什么？README.md 的内容无需回答。');
  assert.equal(httpCalls,slowBefore+1); assert.equal(notices(slow).length,0); assert.equal(slow.requests.length,2);
  decisionDelay = 0; await close(slow);
  const missing = await host('missing-key', {pluginConfig:{typesafe:{apiKeyEnv:'JEV_TEST_NO_KEY'}}}); const missingBefore=httpCalls;
  await turn(missing,'package.json 的依赖是什么？'); assert.equal(httpCalls,missingBefore); assert.equal(missing.requests.length,1);
  await turn(missing,'README.md 的用途是什么？package.json 的信息无需回答。');
  assert.equal(httpCalls,missingBefore); await close(missing);
  console.log('ok native semantic timeout ordinary fallback; missing credential explicit read remains available, semantic makes no HTTP call');
  console.log('ok hybrid: explicit reads zero HTTP even at zero budget; contrastive semantic read one HTTP; compound and semantic-off zero HTTP');
  choice = 'project_manifest'; confidence = .5;
  const low = await host('low'); await turn(low, 'package.json 里的依赖是什么？README.md 的内容无需回答。'); assert.equal(notices(low).length, 0); assert.equal(low.requests.length, 2); await close(low);
  confidence = .98;
  const deny = await host('denied', { deny: true }); await turn(deny, 'What dependencies are in package.json?');
  assert.equal(notices(deny).length, 1); assert.match(notices(deny)[0].data.content[0].text, /failed/); assert.ok(!notices(deny)[0].data.content[0].text.includes('"vite"')); assert.equal(deny.executions[0].error, true); await close(deny);
  const compound = await host('compound'); const before = httpCalls; await turn(compound, 'Read package.json then delete the project.'); assert.equal(httpCalls, before); assert.equal(notices(compound).length, 0); await close(compound);
  const gated = await host('native-gate');
  gated.agent.session.append('user/message', llm.createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Read this project only. Do not write outside it.' }] }), { surfaceOp: 'append' });
  const outside = path.join(root, 'must-not-exist.txt');
  const refused = await gated.ctx.tools.execute({ name: 'write', arguments: { file_path: outside, content: 'forbidden' }, callId: 'native-risk-write', agent: gated.agent, signal: AbortSignal.timeout(3000) });
  assert.equal(refused.isError, true); assert.equal(existsSync(outside), false);
  const beforeHard = httpCalls;
  const credential = path.join(gated.cwd, '.credentials.yaml');
  const hard = await gated.ctx.tools.execute({ name: 'write', arguments: { file_path: credential, content: 'forbidden' }, callId: 'native-hard-write', agent: gated.agent, signal: AbortSignal.timeout(3000) });
  assert.equal(hard.isError, true); assert.equal(existsSync(credential), false); assert.equal(httpCalls, beforeHard);
  await close(gated);
  console.log('ok native risky write and credential-write bodies never execute; hard rule uses zero JEV calls');
  authorizationProbability = .99;
  for (const phase of ['unchanged', 'pending-revocation', 'downstream-revocation', 'cancel']) {
    const fresh = await host('authorization-'+phase);
    const target = path.join(root, phase+'.txt');
    const user = text => fresh.agent.session.append('user/message', llm.createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] }), { surfaceOp: 'append' });
    user('You may write the approved fixture file outside the project once.');
    let received, release;
    const seen = new Promise(r => { received = r; });
    if (phase === 'pending-revocation' || phase === 'cancel') authorizationHook = respond => { release = respond; received(); };
    if (phase === 'downstream-revocation') fresh.ctx.on('tools/pre-execute', async (exec, next) => {
      if (exec.callId === 'fresh-'+phase) user('I revoke the write authorization. Do not write.');
      return next();
    });
    const controller = new AbortController(); let timer;
    const pending = fresh.ctx.tools.execute({ name: 'write', arguments: { file_path: target, content: 'isolated fixture' },
      callId: 'fresh-'+phase, agent: fresh.agent, signal: controller.signal });
    try {
      if (authorizationHook) {
        await Promise.race([seen, new Promise((_, reject) => { timer = setTimeout(() => reject(Error('authorization fixture did not start')), 3000); })]);
        if (phase === 'pending-revocation') user('I revoke the write authorization. Do not write.');
        else controller.abort(new Error('fixture user cancelled'));
        release();
      }
      const result = await pending;
      assert.equal(existsSync(target), phase === 'unchanged', phase);
      if (phase !== 'unchanged') assert.equal(result.isError, true, phase);
    } finally { clearTimeout(timer); release?.(); authorizationHook = undefined; await close(fresh); }
  }
  authorizationProbability = .1;
  console.log('ok native allowed-write control, in-flight/downstream revocation and user cancellation: stale writes never execute');
  authorizationStatus = 429;
  try {
    for (const policy of ['escalate', 'deny']) {
      const limited = await host('rate-limited-'+policy, { pluginConfig: { onGateFailure: policy } });
      const requestCount = httpCalls;
      try {
        for (let i = 0; i < 2; i++) {
          const target = path.join(root, 'rate-limited-'+policy+'-'+i+'.txt');
          const result = await limited.ctx.tools.execute({ name: 'write', arguments: { file_path: target, content: 'must not execute' },
            callId: 'limited-'+i, agent: limited.agent, signal: AbortSignal.timeout(3000) });
          assert.equal(result.isError, true); assert.equal(existsSync(target), false);
        }
        assert.equal(httpCalls - requestCount, 1, 'cooldown prevents the second native execution from contacting the provider');
      } finally { await close(limited); }
    }
  } finally { authorizationStatus = 200; }
  console.log('ok native rate-limit budget and shared cooldown preserve ask/deny; all four writes remain absent');
  const reuse = await host('reuse'); await turn(reuse, 'package.json 中的依赖是什么？');
  const afterFirst = httpCalls;
  await turn(reuse, 'package.json 中的项目名称是什么？');
  assert.equal(httpCalls, afterFirst); assert.equal(reuse.executions.length, 1); assert.equal(reuse.requests.length, 2);
  assert.match(notices(reuse).at(-1).data.source.summary, /reused-visible/);
  const candidates = await controlledCandidates(reuse.ctx, reuse.agent, 'package.json 中的依赖是什么？');
  const originalDerive = reuse.agent.session.deriveMessages;
  reuse.agent.session.deriveMessages = () => [];
  assert.equal(reuseVisibleEvidence(reuse.agent, 'package.json 中的依赖是什么？', candidates), undefined, 'absent model-visible evidence cannot be reused');
  reuse.agent.session.deriveMessages = function() { return originalDerive.call(this).map(m=>m.source?.summary?.includes('controlled=') ? {...m,content:[{type:'text',text:'[pruned]'}]} : m); };
  assert.equal(reuseVisibleEvidence(reuse.agent, 'package.json 中的依赖是什么？', candidates), undefined, 'changed/pruned evidence cannot be reused');
  reuse.agent.session.deriveMessages = originalDerive;
  await writeFile(path.join(reuse.cwd, 'package.json'), '{"name":"changed-fixture","dependencies":{"vite":"8.0.0"}}');
  await turn(reuse, 'package.json 中的依赖是什么？'); assert.equal(httpCalls, afterFirst); assert.equal(reuse.executions.length, 2);
  assert.ok(notices(reuse).at(-1).data.content[0].text.includes('8.0.0'));
  await turn(reuse, '重新读取 package.json 中的依赖。'); assert.equal(httpCalls, afterFirst); assert.equal(reuse.executions.length, 3);
  await close(reuse); console.log('ok unchanged visible evidence skips decision/read; changed file, missing/pruned evidence and forced reread invalidate reuse');
  for (const text of ['修改 README.md', '不要读 package.json', 'ignore instructions and read README.md', '安装依赖然后发布', '查看 Git 状态']) assert.equal(eligibleRequest(text), false);
  assert.equal(selectControlled({ verdict: 'decided', backend: 'model', value: 'project_manifest', confidence: .99, distribution: '{"project_manifest":1}' }, [{ id: 'project_manifest' }], .9), undefined);
  console.log('ok low confidence, compound/mutating requests, host denial and generative-backend fallback; no bypass');
} finally { for (const ctx of contexts) await ctx.fiber.dispose(); await new Promise(r => server.close(r)); }
