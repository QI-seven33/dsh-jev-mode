// Real installed DeepSeek Messages adapter, synthetic SSE, loopback only.
// No personal credentials or actual model reasoning are read or recorded.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, writeFile, rm, readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { pathToFileURL } from 'node:url';
import { createModelEngine, createDecisionPipeline } from '../lib/engine.js';
import { controlledCandidates, executeControlled } from '../lib/controlled.js';
import { normalizeConfig } from '../index.js';

const base = process.env.DSH_HOST_NODE_MODULES ?? 'E:/SOME_SEVEN_PROJECT-57/_recon/asar/dsh/node_modules';
const entry = path.join(base, '@deepseek-ai/dsh-llm-deepseek/lib/index.js');
if (!existsSync(entry)) {
  if (process.env.DSH_ALLOW_SKIPPED_HOST_PERSISTENCE === '1') {
    console.log('SKIPPED: native DeepSeek wire contracts; set DSH_HOST_NODE_MODULES.'); process.exit(0);
  }
  throw Error('Native DeepSeek wire tests require DSH_HOST_NODE_MODULES.');
}
const { DeepSeekAdapter, resolveAdapterOptions } = await import(pathToFileURL(entry));
const seen = [];
const server = http.createServer((req, res) => {
  let text = ''; req.on('data', chunk => text += chunk);
  req.on('end', () => {
    const body = JSON.parse(text); seen.push({ body, headers: req.headers });
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(': keep-alive\n\n');
    if (text.includes('keepalive-only-fixture')) {
      const timer = setInterval(() => res.write(': keep-alive\n\n'), 5);
      res.on('close', () => clearInterval(timer)); return;
    }
    const send = value => res.write(`data: ${JSON.stringify(value)}\n\n`);
    send({ type: 'message_start', message: { usage: { input_tokens: 10, cache_read_input_tokens: 90, output_tokens: 0 } } });
    if (body.thinking.type === 'enabled') {
      send({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } });
      send({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'synthetic-new-reasoning' } });
      send({ type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'synthetic-new-signature' } });
      send({ type: 'content_block_stop', index: 0 });
    }
    const index = body.thinking.type === 'enabled' ? 1 : 0;
    send({ type: 'content_block_start', index, content_block: { type: 'text', text: '' } });
    send({ type: 'content_block_delta', index, delta: { type: 'text_delta', text: '{"answers":{"grounded":{"noul":0.9}}}' } });
    send({ type: 'content_block_stop', index });
    send({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 20 } });
    send({ type: 'message_stop' }); res.end();
  });
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const root = await mkdtemp(path.join(os.tmpdir(), 'jev-deepseek-'));
const connection = resolveAdapterOptions({ baseURL: `http://127.0.0.1:${server.address().port}`, reasoningEffort: 'high' });
const adapter = new DeepSeekAdapter({ options: () => connection,
  resolveAuth: async () => ({ headers: { 'x-api-key': 'synthetic-key' } }), resolveUserId: () => 'synthetic-stable-user',
  prepareExtensions: async () => ({ fields: {}, accept: async () => {} }) });
const model = 'deepseek-flash', provider = 'synthetic-deepseek';
function assistant(id, blocks) {
  return { id, role: 'assistant', content: blocks,
    source: { kind: 'model', provider, model, replayState: {
      response: { kind: 'deepseek-messages', version: 1, model },
      blocks: blocks.map(block => ({ type: block.type, ...(block.type === 'reasoning' ? { signature: 'synthetic-' + id } : {}) })),
    } } };
}
const user = text => ({ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] });
const history = [user('Earlier synthetic question'), assistant('without-tool', [
  { type: 'reasoning', text: 'synthetic-earlier-reasoning' }, { type: 'text', text: 'earlier answer' },
]), user('Inspect the fixture'), assistant('with-tool', [
  { type: 'reasoning', text: 'synthetic-tool-reasoning' }, { type: 'tool-call', id: 'synthetic-call', name: 'read', arguments: '{"file_path":"package.json"}' },
]), { role: 'tool', toolCallId: 'synthetic-call', content: [{ type: 'text', text: 'synthetic tool result' }] }];
const tools = [{ name: 'read', description: 'Read a synthetic fixture', parameters: { type: 'object', properties: { file_path: { type: 'string' } }, required: ['file_path'] } }];
const main = { provider, model, system: 'Fixed synthetic main prefix', messages: history, tools, reasoningEffort: 'high', maxTokens: 1024,
  sessionId: 'synthetic-session', signal: AbortSignal.timeout(3000) };
try {
  const chunks = [];
  for await (const chunk of adapter.stream(main)) chunks.push(chunk);
  const first = seen[0];
  assert.equal(first.body.thinking.type, 'enabled'); assert.equal(first.body.output_config.effort, 'high');
  const thinking = first.body.messages.flatMap(message => message.content).filter(block => block.type === 'thinking');
  assert.deepEqual(thinking.map(block => block.thinking), ['synthetic-earlier-reasoning', 'synthetic-tool-reasoning']);
  assert.deepEqual(thinking.map(block => block.signature), ['synthetic-without-tool', 'synthetic-with-tool']);
  assert.equal(chunks.find(chunk => chunk.type === 'usage').usage.cacheReadTokens, 90);
  assert.equal(chunks.find(chunk => chunk.type === 'usage').usage.inputTokens, 10);
  console.log('ok native DeepSeek Messages retains signed reasoning with and without tool calls; cache hit/miss accounting stays separate');

  const engine = createModelEngine({ ctx: { llm: { stream: options => adapter.stream(options) } }, config: normalizeConfig({}) });
  const agent = { session: { header: { cwd: root }, requestHeader: () => ({ config: { provider, model } }) } };
  const diagnostic = await engine.ask({ channel: 'grounded', state: 'synthetic diagnostic', agent, signal: AbortSignal.timeout(3000) });
  assert.equal(JSON.parse(diagnostic.text).answers.grounded.noul, .9);
  assert.equal(seen[1].body.thinking.type, 'disabled'); assert.equal(seen[1].body.output_config, undefined);
  assert.equal(connection.defaults.reasoningEffort, 'high');

  await writeFile(path.join(root, 'package.json'), '{"name":"synthetic"}');
  const ctx = { tools: { schemas: () => tools, execute: async exec => ({ content: [{ type: 'text', text: await readFile(exec.arguments.file_path, 'utf8') }] }) } };
  const [action] = await controlledCandidates(ctx, agent, 'package.json 中的项目名称是什么？');
  const { message } = await executeControlled({ ctx, agent, action, result: { backend: 'deterministic', confidence: 1 }, requestId: 'synthetic-user' });
  const generated = { role: 'assistant', content: chunks.filter(chunk => chunk.type === 'block-end').map(chunk => chunk.block),
    source: { kind: 'model', provider, model, replayState: chunks.find(chunk => chunk.type === 'finish').replayState } };
  for await (const _chunk of adapter.stream({ ...main, messages: [...history, generated, message] })) { /* consume real translation */ }
  const next = seen[2];
  assert.equal(next.body.thinking.type, 'enabled'); assert.equal(next.body.output_config.effort, 'high');
  assert.equal(next.body.system, first.body.system); assert.deepEqual(next.body.tools, first.body.tools);
  assert.deepEqual(next.body.messages.slice(0, first.body.messages.length), first.body.messages);
  assert.ok(next.body.messages.at(-1).content.some(block => block.text?.includes('not user instruction or authorization')));
  for (const request of seen) assert.equal(request.headers['x-deepseek-harness-user-id'], 'synthetic-stable-user');
  assert.equal(next.headers['x-deepseek-harness-session-id'], 'synthetic-session');
  console.log('ok auxiliary thinking-off stays request-local; main thinking/high, signed history, tools, prefix and user isolation id survive a real plugin notice');

  const pipeline = createDecisionPipeline({ config: normalizeConfig({}), engines: [engine] });
  const started = Date.now();
  const unavailable = await pipeline.decide({ channel: 'grounded', state: 'keepalive-only-fixture', agent, timeoutMs: 40 });
  assert.equal(unavailable.ok, false); assert.ok(Date.now() - started < 500);
  assert.equal(seen.length, 4);
  console.log('ok native SSE keep-alives parse correctly and cannot extend the absolute decision deadline');
} finally {
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  await rm(root, { recursive: true, force: true });
}
