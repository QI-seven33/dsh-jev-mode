import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeAnswer, verdictFor } from '../lib/channels.js';
import { createBreaker, createLimiter, createDecisionPipeline, createModelEngine } from '../lib/engine.js';
import { createGate } from '../lib/gate.js';
import { normalizeConfig } from '../index.js';
import { execFileSync } from 'node:child_process';

const malformed = [1.5, -0.1, '1', true, false, null, undefined, Infinity, NaN, {}, []];
const cuts = { threshold: .85, askBand: .55 };
test('auxiliary request immutability leaves AbortSignal compatible with native composition', async () => {
  const controller = new AbortController();
  let request, combined;
  const engine = createModelEngine({ config: normalizeConfig({}), ctx: { llm: { stream(options) {
    request = options;
    combined = typeof AbortSignal.any === 'function' ? AbortSignal.any([options.signal]) : options.signal;
    return (async function* () { yield { type: 'text-delta', text: '{"answers":{"grounded":{"noul":0.9}}}' };
      yield { type: 'finish', reason: { kind: 'stop' } }; })();
  } } } });
  await engine.ask({ channel: 'grounded', state: 'synthetic', signal: controller.signal,
    agent: { options: { provider: 'synthetic', model: 'synthetic' } } });
  assert.ok(Object.isFrozen(request)); assert.ok(Object.isFrozen(request.messages));
  assert.ok(Object.isFrozen(request.messages[0].content[0])); assert.equal(Object.isFrozen(controller.signal), false);
  controller.abort(); assert.equal(combined.aborted, true);
});

test('credential service rejection cannot crash plugin startup', () => {
  const code = `import {apply} from ${JSON.stringify(new URL('../index.js', import.meta.url).href)};
    const ctx={logger:{info(){},warn(){}},effect(fn){const v=fn();if(v?.[Symbol.iterator])[...v];},
      systemPrompt:{section(){return()=>{};}},tools:{register(){return()=>{};}},on(){return()=>{};},
      get(name){return name==='credentials'?{resolve:async()=>{throw Error('synthetic credential failure')}}:undefined;},llm:{}};
    apply(ctx,{backend:'typesafe',ledger:false,autoGate:false,controlledFlow:false});
    await new Promise(r=>setTimeout(r,30));`;
  execFileSync(process.execPath, ['--unhandled-rejections=strict', '--input-type=module', '-e', code], { stdio: 'pipe', timeout: 5000 });
});
test('malformed probabilities never become authorization through coercion or clamping', () => {
  for (const channel of ['authorize', 'grounded', 'sufficient']) {
    for (const noul of malformed) assert.equal(normalizeAnswer(channel, { noul }).ok, false);
  }
  assert.equal(normalizeAnswer('authorize', { type: 'score', noul: 1 }).ok, false);
  for (const p of malformed) assert.equal(verdictFor('authorize', { ok: true, probability: p }, cuts).verdict, 'unavailable');
  for (const p of [0, .55, .85, 1]) assert.equal(normalizeAnswer('authorize', { noul: p }).ok, true);
});

test('all malformed upstream authorizations escalate or deny at the actual action gate', async () => {
  for (const onGateFailure of ['escalate', 'deny']) {
    for (const noul of malformed) {
      const gate = createGate({ config: normalizeConfig({ onGateFailure }),
        decide: async () => ({ ok: true, answers: { authorize: { noul } }, via: 'fixture' }),
        ledger: { recordDegraded: async () => {}, recordDecision: async () => {}, recordGate: async () => {} } });
      const result = await gate.evaluate({ exec: { name: 'bash', arguments: { command: 'npm publish' } },
        session: { id: 'fixture', header: { cwd: '/fixture' }, snapshotEvents: () => [] } });
      assert.equal(result.verdict, onGateFailure === 'deny' ? 'deny' : 'ask');
    }
  }
});

test('malformed advisory responses are rejected before entering the result cache', async () => {
  let calls = 0;
  const pipeline = createDecisionPipeline({ config: normalizeConfig({ breakerFailures: 20 }), engines: [{
    id: 'fixture', available: () => true, ask: async () => { calls++; return { answers: { grounded: { noul: '1' } } }; },
  }] });
  for (let i = 0; i < 2; i++) assert.equal((await pipeline.decide({ channel: 'grounded', state: 'fixture', timeoutMs: 500 })).ok, false);
  assert.equal(calls, 2); assert.equal(pipeline.cache.size(), 0);
});

test('a recovering breaker admits one probe, then resets or starts another cooldown', () => {
  let clock = 0;
  const breaker = createBreaker({ failures: 1, cooldownMs: 100, now: () => clock });
  breaker.failure(); clock = 100;
  assert.equal(Array.from({ length: 8 }, () => breaker.admit()).filter(r => r.ok).length, 1);
  breaker.failure(); assert.equal(breaker.admit().ok, false);
  clock = 200; assert.equal(breaker.admit().probe, true);
  assert.equal(breaker.admit().ok, false);
  breaker.success(); assert.equal(breaker.admit().ok, true);
});

test('queued abort settles before the occupied slot is released and never runs the task', async () => {
  const run = createLimiter(1); let release; let called = false;
  const held = run(() => new Promise(r => { release = r; }));
  const controller = new AbortController();
  const queued = run(() => { called = true; }, controller.signal);
  controller.abort(new Error('fixture cancellation'));
  let timer;
  try {
    await Promise.race([assert.rejects(queued, /fixture cancellation/), new Promise((_, reject) => { timer = setTimeout(() => reject(Error('queued abort did not settle')), 500); })]);
    assert.equal(called, false);
  } finally { clearTimeout(timer); release(); await held; }
  assert.equal(await run(() => 7), 7, 'cancellation must not leak a semaphore permit');
});

test('the pipeline applies a queued decision deadline before calling the provider', async () => {
  let release; let calls = 0;
  const pipeline = createDecisionPipeline({ config: normalizeConfig({ concurrency: 1, breakerFailures: 20 }), engines: [{
    id: 'fixture', available: () => true,
    ask: async () => { calls++; return await new Promise(r => { release = () => r({ answers: { authorize: { noul: .9 } } }); }); },
  }] });
  const first = pipeline.decide({ channel: 'authorize', state: 'first', timeoutMs: 1000 });
  while (!release) await new Promise(r => setImmediate(r));
  let timer;
  try {
    const result = await Promise.race([pipeline.decide({ channel: 'authorize', state: 'queued', timeoutMs: 20 }),
      new Promise((_, reject) => { timer = setTimeout(() => reject(Error('queued deadline ignored')), 500); })]);
    assert.equal(result.ok, false); assert.equal(calls, 1);
  } finally { clearTimeout(timer); release(); await first; }
});

test('user cancellations do not open the provider circuit breaker', async () => {
  let calls = 0;
  const pipeline = createDecisionPipeline({ config: normalizeConfig({ breakerFailures: 3 }), engines: [{
    id: 'fixture', available: () => true, ask: async ({ signal }) => {
      if (++calls > 3) return { answers: { authorize: { noul: .9 } } };
      return await new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    },
  }] });
  for (let i = 0; i < 3; i++) {
    const controller = new AbortController();
    const pending = pipeline.decide({ channel: 'authorize', state: 'cancel fixture '+i, signal: controller.signal, timeoutMs: 1000 });
    while (calls <= i) await new Promise(r => setImmediate(r));
    controller.abort(); assert.equal((await pending).via, 'cancelled');
  }
  assert.equal(pipeline.breaker.state().open, false);
  assert.equal(pipeline.stats.failures, 0); assert.equal(pipeline.stats.cancelled, 3);
  assert.equal((await pipeline.decide({ channel: 'authorize', state: 'healthy', timeoutMs: 500 })).ok, true);
});

test('abandoning a half-open probe releases it without clearing failure history', () => {
  let clock = 0;
  const breaker = createBreaker({ failures: 1, cooldownMs: 100, now: () => clock });
  breaker.failure(); clock = 100;
  const first = breaker.admit(); breaker.cancel(first);
  assert.equal(breaker.state().open, true); assert.equal(breaker.state().consecutive, 1);
  assert.equal(breaker.admit().probe, true); assert.equal(breaker.admit().ok, false);
});

test('credential lookup is deadline bounded without issuing a provider request', async () => {
  let calls = 0, timer;
  const pipeline = createDecisionPipeline({ config: normalizeConfig({}), engines: [{
    id: 'fixture', available: () => new Promise(() => {}), ask: () => { calls++; },
  }] });
  try {
    const result = await Promise.race([pipeline.decide({ channel: 'authorize', state: 'fixture', timeoutMs: 20 }),
      new Promise((_, reject) => { timer = setTimeout(() => reject(Error('credential deadline ignored')), 500); })]);
    assert.equal(result.via, 'timeout'); assert.equal(calls, 0); assert.equal(pipeline.breaker.state().open, false);
  } finally { clearTimeout(timer); }
});

test('an expired queued call does not count as a provider failure', async () => {
  let release, timer;
  const pipeline = createDecisionPipeline({ config: normalizeConfig({ concurrency: 1, breakerFailures: 1 }), engines: [{
    id: 'fixture', available: () => true, ask: async () => await new Promise(r => { release = () => r({ answers: { authorize: { noul: .9 } } }); }),
  }] });
  const first = pipeline.decide({ channel: 'authorize', state: 'first', timeoutMs: 1000 });
  while (!release) await new Promise(r => setImmediate(r));
  try {
    await Promise.race([pipeline.decide({ channel: 'authorize', state: 'queued', timeoutMs: 20 }),
      new Promise((_, reject) => { timer = setTimeout(() => reject(Error('queued deadline ignored')), 500); })]);
    assert.equal(pipeline.breaker.state().open, false);
  } finally { clearTimeout(timer); release(); await first; }
});

test('changed authorization, arguments, cancellation or ledger-time revocation invalidates an allow', async () => {
  const instruction = text => ({ type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text }] } });
  for (const change of ['revocation', 'arguments', 'cancel', 'ledger']) {
    const events = [instruction('Publish this package once.')], controller = new AbortController();
    const session = { id: 'freshness-fixture', header: { cwd: '/fixture' }, snapshotEvents: () => events };
    const exec = { name: 'bash', callId: 'call-fixture', arguments: { command: 'npm publish' }, signal: controller.signal };
    let release;
    const gate = createGate({ config: normalizeConfig({}), ledger: {
      recordDecision: async () => {}, recordDegraded: async () => {},
      recordGate: async () => { if (change === 'ledger') events.push(instruction('I revoke permission.')); },
    }, decide: async () => await new Promise(r => { release = () => r({ ok: true, answers: { authorize: { noul: .99 } } }); }) });
    const pending = gate.evaluate({ exec, session });
    while (!release) await new Promise(r => setImmediate(r));
    if (change === 'revocation') events.push(instruction('I revoke permission.'));
    if (change === 'arguments') exec.arguments.command = 'npm publish --registry https://other.example';
    if (change === 'cancel') controller.abort();
    release(); assert.equal((await pending).verdict, 'ask', change);
  }
});
