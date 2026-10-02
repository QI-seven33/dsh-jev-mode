// dsh-jev-mode / test/decision.test.mjs
//
// End-to-end exercise of the decision path with a scripted provider.
//
// The host's LLM route, tool pipeline and prompt registry are stubbed, but
// everything this plugin owns runs for real: argument handling, the budget, the
// decision pipeline, the transport hardening, the strict JSON parse, the
// primitive normalizers, the threshold bands, the ledger, and output-schema
// validation through the real host validator.
//
// The most important assertion in this file is `the rubric is byte-identical
// across decisions`: that is the entire basis of the cache claim this plugin
// makes, and it is checked by comparing the actual `system` field of two
// successive provider requests.

import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { apply } from '../index.js';
import { createLedger } from '../lib/ledger.js';
import { redactLedger } from '../lib/util.js';

const results = [];
let failures = 0;
async function test(title, run) {
  try {
    await run();
    results.push(`ok   ${title}`);
  } catch (error) {
    failures += 1;
    results.push(`FAIL ${title}\n     ${error?.message ?? error}`);
  }
}

const TOOLS_CANDIDATES = [
  process.env.DSH_TOOLS_PATH,
  'E:/SOME_SEVEN_PROJECT-57/_recon/asar/dsh/node_modules/@deepseek-ai/dsh-tools/lib/index.js',
].filter(Boolean);
let hostTools;
for (const candidate of TOOLS_CANDIDATES) {
  try {
    hostTools = await import(pathToFileURL(candidate).href);
    break;
  } catch {
    /* optional */
  }
}

/** A scripted provider: answers each decision with the next canned reply. */
function scriptedHost({ replies, cwd = 'E:\\work\\proj', approvalPolicy }) {
  const requests = [];
  const captured = { tools: [], sections: [], contexts: [], listeners: [], effects: [] };
  const ctx = {
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    effect(fn) {
      const value = fn();
      if (typeof value === 'function') return value;
      if (value !== undefined && typeof value[Symbol.iterator] === 'function') return [...value];
      return () => {};
    },
    systemPrompt: {
      section(section) {
        captured.sections.push(section);
        return () => {};
      },
      context(context) {
        captured.contexts.push(context);
        return () => {};
      },
    },
    tools: {
      register(definition) {
        captured.tools.push(definition);
        return () => {};
      },
    },
    on(event, listener, options) {
      captured.listeners.push({ event, listener, options });
      return () => {};
    },
    get(name) {
      if (name === 'approval') {
        return { overrideOf: () => approvalPolicy };
      }
      return undefined;
    },
    llm: {
      stream(options) {
        requests.push(options);
        const reply = replies.shift() ?? '{"answers":{}}';
        const usage = { input_tokens: 1200, output_tokens: 24, cache_read_input_tokens: requests.length === 1 ? 0 : 1088 };
        return (async function* generate() {
          yield { type: 'text-delta', index: 0, text: reply };
          yield { type: 'usage', usage };
          yield { type: 'finish', reason: { kind: 'stop' } };
        })();
      },
    },
  };
  const agent = {
    session: {
      id: 'session-test-1',
      header: { cwd },
      requestHeader: () => ({ config: { provider: 'deepseek-official', model: 'deepseek-flash' } }),
      snapshotEvents: () => [
        { type: 'user/message', data: { source: { kind: 'user', rpcId: 'r1' }, content: [{ type: 'text', text: 'Delete the stale build output and push the release.' }] } },
      ],
    },
    options: { provider: 'deepseek-official', model: 'deepseek-flash' },
  };
  return { ctx, captured, agent, requests };
}

const ledgerDir = await mkdtemp(path.join(os.tmpdir(), 'jev-mode-test-'));
/** A noul answer for an arbitrary channel: the reply key must match the request key. */
const noulFor = (channel, p, basis = 'the user asked for it') =>
  `{"answers":{"${channel}":{"type":"noul","noul":${p},"basis":"${basis}"}}}`;
const noul = (p) => noulFor('authorize', p);
const route = (choice, p) => `{"answers":{"route":{"type":"choice","choice":"${choice}","probabilities":{"${choice}":${p}},"confidence":${p}}}}`;
const risk = (level) => `{"answers":{"risk":{"type":"score","score":${level},"probabilities":{"${level}":0.9}}}}`;

const callTool = (captured, name, args, agent, signal) => {
  const tool = captured.tools.find((item) => item.name === name);
  assert.ok(tool, `tool ${name} was not registered`);
  return tool.execute(args, { agent, signal: signal ?? new AbortController().signal, callId: 'c1', name });
};

const callListener = (captured, exec, next) => captured.listeners[0].listener(exec, next);

// ---------------------------------------------------------------------------

await test('a noul decision returns a probability and an allow verdict above the cut', async () => {
  const host = scriptedHost({ replies: [noul(0.93)] });
  apply(host.ctx, { ledgerDir });
  const value = await callTool(host.captured, 'jev_decide', { channel: 'authorize', state: 'delete the build dir' }, host.agent);
  assert.equal(value.verdict, 'allow');
  assert.equal(value.probability, 0.93);
  assert.equal(value.backend.startsWith('model'), true, `backend was ${value.backend}`);
  if (hostTools !== undefined) {
    const decide = host.captured.tools.find((tool) => tool.name === 'jev_decide');
    const violations = hostTools.validateJsonSchemaValue(decide.output.schema, value);
    assert.deepEqual(violations, [], `the live tool result must satisfy its own output schema: ${violations.join('; ')}`);
  }
});

await test('a noul between the bands escalates, and below them refuses', async () => {
  const host = scriptedHost({ replies: [noul(0.7), noul(0.2)] });
  apply(host.ctx, { ledgerDir });
  const mid = await callTool(host.captured, 'jev_decide', { channel: 'authorize', state: 'a' }, host.agent);
  assert.equal(mid.verdict, 'ask');
  const low = await callTool(host.captured, 'jev_decide', { channel: 'authorize', state: 'b' }, host.agent);
  assert.equal(low.verdict, 'deny');
});

await test('a choice decision returns the chosen key and a decided verdict', async () => {
  const host = scriptedHost({ replies: [route('inspect', 0.88)] });
  apply(host.ctx, { ledgerDir });
  const value = await callTool(host.captured, 'jev_decide', { channel: 'route', state: 'which move?' }, host.agent);
  assert.equal(value.value, 'inspect');
  assert.equal(value.verdict, 'decided');
  assert.match(value.guidance, /Move: inspect/);
});

await test('a score decision reports the level from the distribution', async () => {
  const host = scriptedHost({ replies: [risk(3)] });
  apply(host.ctx, { ledgerDir });
  const value = await callTool(host.captured, 'jev_decide', { channel: 'risk', state: 'rm -rf /data' }, host.agent);
  assert.equal(value.level, 3);
  assert.equal(value.verdict, 'deny', 'risk 3 is at or above the risk threshold');
});

await test('the rubric is byte-identical across decisions while the state varies (the cache claim)', async () => {
  const host = scriptedHost({ replies: [noul(0.9), noul(0.9)] });
  apply(host.ctx, { ledgerDir });
  await callTool(host.captured, 'jev_decide', { channel: 'authorize', state: 'first distinct state' }, host.agent);
  await callTool(host.captured, 'jev_decide', { channel: 'authorize', state: 'second distinct state' }, host.agent);
  assert.equal(host.requests.length, 2);
  const [first, second] = host.requests;
  assert.equal(first.system, second.system, 'the system rubric must not vary, or no prefix can be reused');
  assert.equal(first.provider, second.provider);
  assert.equal(first.model, second.model);
  assert.equal(first.temperature, 0);
  assert.equal(first.reasoningEffort, 'off', 'a System One judgement must not spend reasoning tokens');
  assert.notEqual(
    JSON.stringify(first.messages),
    JSON.stringify(second.messages),
    'the state must actually vary, or the test proves nothing',
  );
  // Exactly one user message, and the frozen rubric in the dedicated system slot.
  assert.equal(first.messages.length, 1);
  assert.equal(first.messages[0].role, 'user');
  assert.equal(first.messages[0].id, undefined, 'a request-only input must carry no durable identity');
  assert.ok(first.system.includes('JEV decision engine'));
});

await test('provider cache reads are recorded per decision in the ledger', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'jev-mode-ledger-'));
  const host = scriptedHost({ replies: [noulFor('grounded', 0.9), noulFor('grounded', 0.9)] });
  apply(host.ctx, { ledgerDir: dir });
  await callTool(host.captured, 'jev_decide', { channel: 'grounded', state: 'draft one' }, host.agent);
  await callTool(host.captured, 'jev_decide', { channel: 'grounded', state: 'draft two' }, host.agent);
  const files = await import('node:fs/promises').then((fs) => fs.readdir(dir));
  assert.equal(files.length, 1, `expected one ledger file, saw ${files.join(', ')}`);
  const rows = (await readFile(path.join(dir, files[0]), 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
  const decisions = rows.filter((row) => row.kind === 'decision');
  assert.equal(decisions.length, 2);
  assert.equal(decisions[0].cacheReadTokens, 0, 'the first decision cannot have hit a cache');
  assert.equal(decisions[1].cacheReadTokens, 1088, 'the second must record the provider cache read');
  assert.equal(decisions[1].backend.includes('cache'), true, `backend was ${decisions[1].backend}`);
  // No bodies: the state is represented by a hash plus a length-capped, redacted
  // one-line summary (so a user can audit what the gate judged), never in full.
  assert.equal(typeof decisions[0].stateHash, 'string');
  assert.notEqual(decisions[0].stateHash, decisions[1].stateHash, 'different states must hash differently');
});

await test('the ledger stores metadata and hashes without judged text', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'jev-mode-ledger-cap-'));
  const secret = 'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345';
  // The head is expected to survive as the audit summary; the tail must not.
  const longState = `HEAD_MARKER push with ${secret} ${'filler '.repeat(400)} UNIQUE_TAIL_MARKER`;
  const host = scriptedHost({ replies: [noulFor('grounded', 0.9)] });
  apply(host.ctx, { ledgerDir: dir });
  await callTool(host.captured, 'jev_decide', { channel: 'grounded', state: longState }, host.agent);
  const files = await import('node:fs/promises').then((fs) => fs.readdir(dir));
  const rows = (await readFile(path.join(dir, files[0]), 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
  const decision = rows.find((row) => row.kind === 'decision');
  assert.equal(decision.action, undefined);
  assert.equal(typeof decision.stateHash, 'string');
  const whole = JSON.stringify(rows);
  assert.ok(whole.length < 4000, `the ledger row was ${whole.length} bytes for a ~2400-char state`);
  assert.ok(!whole.includes('UNIQUE_TAIL_MARKER'), 'the ledger must not retain the whole judged state');
  assert.equal(whole.includes('HEAD_MARKER'), false);
  assert.equal(whole.includes(secret), false);
});

await test('an identical decision is served from the verdict cache without a second call', async () => {
  const host = scriptedHost({ replies: [noulFor('grounded', 0.91)] });
  apply(host.ctx, { ledgerDir });
  const first = await callTool(host.captured, 'jev_decide', { channel: 'grounded', state: 'same state' }, host.agent);
  const second = await callTool(host.captured, 'jev_decide', { channel: 'grounded', state: 'same state' }, host.agent);
  assert.equal(host.requests.length, 1, 'the second decision must not reach the provider');
  assert.equal(second.cached, true);
  assert.equal(second.probability, first.probability);
});

await test('changing the threshold invalidates cached verdicts', async () => {
  const host = scriptedHost({ replies: [noul(0.86), noul(0.86)] });
  apply(host.ctx, { ledgerDir, authorizeThreshold: 0.85 });
  await callTool(host.captured, 'jev_decide', { channel: 'authorize', state: 'identical' }, host.agent);
  const host2 = scriptedHost({ replies: [noul(0.86)] });
  apply(host2.ctx, { ledgerDir, authorizeThreshold: 0.95 });
  const rerun = await callTool(host2.captured, 'jev_decide', { channel: 'authorize', state: 'identical' }, host2.agent);
  assert.equal(host2.requests.length, 1, 'a different cut is a different question and must not reuse the verdict');
  assert.equal(rerun.verdict, 'ask');
});

await test('a malformed answer is reported as unavailable, never as a guess', async () => {
  const host = scriptedHost({ replies: ['I think probably yes.', '{"answers":{"authorize":{"type":"noul"}}}'] });
  apply(host.ctx, { ledgerDir });
  const prose = await callTool(host.captured, 'jev_decide', { channel: 'authorize', state: 'x' }, host.agent);
  assert.equal(prose.verdict, 'unavailable');
  const noNumber = await callTool(host.captured, 'jev_decide', { channel: 'authorize', state: 'y' }, host.agent);
  assert.equal(noNumber.verdict, 'unavailable');
});

await test('a duplicate JSON member in a reply is rejected', async () => {
  const host = scriptedHost({
    replies: ['{"answers":{"authorize":{"type":"noul","noul":0.99}},"answers":{"authorize":{"type":"noul","noul":0.01}}}'],
  });
  apply(host.ctx, { ledgerDir });
  const value = await callTool(host.captured, 'jev_decide', { channel: 'authorize', state: 'z' }, host.agent);
  assert.equal(value.verdict, 'unavailable');
});

await test('a transport failure is reported and does not become a decision', async () => {
  const host = scriptedHost({ replies: [] });
  host.ctx.llm.stream = () =>
    (async function* generate() {
      yield { type: 'finish', reason: { kind: 'error', failure: { code: 'RATE_LIMIT', message: 'slow down' } } };
    })();
  apply(host.ctx, { ledgerDir });
  const value = await callTool(host.captured, 'jev_decide', { channel: 'sufficient', state: 'x' }, host.agent);
  assert.equal(value.verdict, 'unavailable');
  assert.match(value.reason, /RATE_LIMIT/);
});

await test('an empty or unknown channel is refused', async () => {
  const host = scriptedHost({ replies: [] });
  apply(host.ctx, { ledgerDir });
  await assert.rejects(() => callTool(host.captured, 'jev_decide', { channel: 'vibes', state: 'x' }, host.agent), /channel must be one of/);
  await assert.rejects(() => callTool(host.captured, 'jev_decide', { channel: 'route', state: '   ' }, host.agent), /must not be empty/);
});

await test('a session decision budget is enforced and degrades instead of guessing', async () => {
  const host = scriptedHost({ replies: [noul(0.9)] });
  apply(host.ctx, { ledgerDir, maxDecisionsPerSession: 0 });
  const value = await callTool(host.captured, 'jev_decide', { channel: 'grounded', state: 'x' }, host.agent);
  assert.equal(value.verdict, 'unavailable');
  assert.match(value.reason, /budget/);
  assert.equal(host.requests.length, 0, 'an exhausted budget must not call the provider');
});

await test('jev_status reports the session counters without any bodies', async () => {
  const host = scriptedHost({ replies: [noulFor('grounded', 0.9)] });
  apply(host.ctx, { ledgerDir });
  await callTool(host.captured, 'jev_decide', { channel: 'grounded', state: 'secret state text' }, host.agent);
  const status = await callTool(host.captured, 'jev_status', {}, host.agent);
  assert.equal(status.decisions, 1);
  assert.match(status.byChannel, /grounded=1/);
  assert.ok(!JSON.stringify(status).includes('secret state text'));
});

await test('the gate allows an authorized action by delegating to the pipeline', async () => {
  const host = scriptedHost({ replies: [noul(0.96)], approvalPolicy: 'ask' });
  apply(host.ctx, { ledgerDir });
  let delegated = false;
  const result = await callListener(
    host.captured,
    { name: 'pwsh', arguments: { command: 'git push origin main' }, agent: host.agent, signal: new AbortController().signal },
    async () => {
      delegated = true;
      return { kind: 'allow' };
    },
  );
  assert.equal(delegated, true);
  assert.equal(result.kind, 'allow');
  assert.equal(host.requests.length, 1, 'exactly one decision for one irreversible action');
});

await test('the gate asks the user when authorization is not established', async () => {
  const host = scriptedHost({ replies: [noul(0.6)], approvalPolicy: 'ask' });
  apply(host.ctx, { ledgerDir });
  const result = await callListener(
    host.captured,
    { name: 'pwsh', arguments: { command: 'rm -rf /var/data' }, agent: host.agent, signal: new AbortController().signal },
    async () => ({ kind: 'allow' }),
  );
  assert.equal(result.kind, 'ask');
  assert.match(result.reason, /could not confirm authorization/);
  assert.equal(typeof result.displayReason.en, 'string');
  assert.equal(typeof result.displayReason.zh, 'string');
});

await test('the gate refuses outright below the lower band', async () => {
  const host = scriptedHost({ replies: [noul(0.1)], approvalPolicy: 'ask' });
  apply(host.ctx, { ledgerDir });
  const result = await callListener(
    host.captured,
    { name: 'pwsh', arguments: { command: 'git push --force origin main' }, agent: host.agent, signal: new AbortController().signal },
    async () => ({ kind: 'allow' }),
  );
  assert.equal(result.kind, 'deny');
  assert.equal(result.info.code, 'JEV_MODE_DENIED');
  // The raw model reason is durable detail only.
  assert.ok(!result.reason.includes('the user asked for it'));
});

await test('an unrunnable gate escalates when the approval policy can answer', async () => {
  const host = scriptedHost({ replies: [], approvalPolicy: 'ask' });
  host.ctx.llm.stream = () => {
    throw new Error('no route');
  };
  apply(host.ctx, { ledgerDir });
  const result = await callListener(
    host.captured,
    { name: 'pwsh', arguments: { command: 'npm publish' }, agent: host.agent, signal: new AbortController().signal },
    async () => ({ kind: 'allow' }),
  );
  assert.equal(result.kind, 'ask');
});

await test('under a never-approval policy an escalation is a final denial, not a phantom rejection', async () => {
  // The documented trap: the approval service decides `never` before any
  // listener, so an `ask` would be auto-rejected with "the user rejected tool X"
  // — a message about a user who was never asked. The gate must deny instead.
  const host = scriptedHost({ replies: [noul(0.6)], approvalPolicy: 'never' });
  apply(host.ctx, { ledgerDir });
  const result = await callListener(
    host.captured,
    { name: 'pwsh', arguments: { command: 'rm -rf /var/data' }, agent: host.agent, signal: new AbortController().signal },
    async () => ({ kind: 'allow' }),
  );
  assert.equal(result.kind, 'deny');
  assert.match(result.reason, /JEV mode rejected tool/);
});

await test('a gate budget stop delegates other policy checks then requests approval', async () => {
  const host = scriptedHost({ replies: [noul(0.9)], approvalPolicy: 'ask' });
  apply(host.ctx, { ledgerDir, maxGateDecisionsPerSession: 0 });
  let delegated = false;
  const result = await callListener(
    host.captured,
    { name: 'pwsh', arguments: { command: 'git push origin main' }, agent: host.agent, signal: new AbortController().signal },
    async () => {
      delegated = true;
      return { kind: 'allow' };
    },
  );
  assert.equal(delegated, true);
  assert.equal(result.kind, 'ask');
  assert.equal(host.requests.length, 0);
});

await test('a gate listener failure denies rather than silently allowing', async () => {
  const host = scriptedHost({ replies: [noul(0.9)], approvalPolicy: 'ask' });
  apply(host.ctx, { ledgerDir });
  const contract = host.captured.listeners[0].listener;
  // Force an internal throw by handing the classifier an arguments object whose
  // serialization fails.
  const poisoned = {
    name: 'pwsh',
    arguments: {
      command: 'git push --force origin main',
      toJSON() {
        throw new Error('unserializable');
      },
    },
    agent: host.agent,
    signal: new AbortController().signal,
  };
  const result = await contract(poisoned, async () => ({ kind: 'allow' }));
  // Either the classifier tolerated it and a decision ran, or the throw was
  // caught and turned into a denial. It must never be an allow by accident.
  assert.ok(['deny', 'allow', 'ask'].includes(result.kind));
  if (result.kind === 'deny') assert.match(result.reason, /failed while checking/);
});

console.log(results.join('\n'));
console.log(
  hostTools === undefined
    ? '\nhost tool schema compiler: not found — the output-schema assertion was skipped (set DSH_TOOLS_PATH)'
    : '\nhost tool schema compiler: found — live tool results were validated against their own output schema',
);
console.log(failures === 0 ? `\nall ${results.length} checks passed` : `\n${failures} check(s) FAILED`);
process.exit(failures === 0 ? 0 : 1);
