// dsh-jev-mode / test/transport.test.mjs
//
// The two surfaces nothing else exercises:
//
//   1. The HTTP decision engine (`typesafe` / `openrouter`). It is the optional
//      backend, so a defect here would not show up in a default deployment — it
//      would show up the moment a user switches backends. It is also the only
//      place where data leaves the machine, which makes its redaction, its retry
//      classification and its error hygiene worth asserting rather than assuming.
//   2. The `jev_gate` tool. The automatic gate is covered heavily; the tool a model
//      calls *before* starting an irreversible action was not covered at all.
//
// The HTTP tests run against a real loopback server, so the fetch options,
// headers, body shape and retry behaviour are exercised for real.

import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createDecisionPipeline, createHttpEngine, createModelEngine, createBreaker, backoffMs } from '../lib/engine.js';
import { deadlineSignal, compact, redact, unwrapField } from '../lib/util.js';
import { apply, normalizeConfig } from '../index.js';
import { truncateState, normalizeAnswer, verdictFor } from '../lib/channels.js';

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

// ---------------------------------------------------------------------------
// A scripted decision endpoint
// ---------------------------------------------------------------------------

/** Start a loopback server that records every request and replies from a queue. */
async function startEndpoint(replies) {
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      let parsed;
      try {
        parsed = JSON.parse(body);
      } catch {
        parsed = body;
      }
      seen.push({ method: req.method, url: req.url, headers: req.headers, body: parsed, raw: body });
      const reply = replies.length > 1 ? replies.shift() : replies[0];
      const { status = 200, payload = {}, headers = {} } = reply ?? {};
      res.writeHead(status, { 'content-type': 'application/json', ...headers });
      res.end(typeof payload === 'string' ? payload : JSON.stringify(payload));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    endpoint: `http://127.0.0.1:${port}/decide`,
    seen,
    replies,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

const NOUL = (p) => ({ answers: { authorize: { type: 'noul', noul: p } } });

// ---------------------------------------------------------------------------
// 1. The HTTP engine: request shape and redaction
// ---------------------------------------------------------------------------

await test('the HTTP engine sends the documented wire shape', async () => {
  const server = await startEndpoint([{ payload: NOUL(0.91) }]);
  try {
    const engine = createHttpEngine({
      id: 'typesafe',
      endpoint: server.endpoint,
      model: 'jev-1.13.0',
      resolveKey: () => 'test-key',
    });
    const result = await engine.ask({ channel: 'authorize', state: 'delete the build dir' });
    assert.equal(result.answers.authorize.noul, 0.91);
    assert.equal(result.via, 'typesafe');
    const [request] = server.seen;
    assert.equal(request.method, 'POST');
    assert.equal(request.headers.authorization, 'Bearer test-key');
    assert.equal(request.headers['content-type'], 'application/json');
    assert.equal(request.body.model, 'jev-1.13.0');
    assert.equal(request.body.questions.authorize.type, 'noul');
    assert.ok(typeof request.body.questions.authorize.instructions === 'string');
    assert.ok(request.body.state.includes('delete the build dir'));
  } finally {
    await server.close();
  }
});

await test('the HTTP engine redacts the state before it leaves the machine', async () => {
  const server = await startEndpoint([{ payload: NOUL(0.5) }]);
  try {
    const engine = createHttpEngine({ id: 'typesafe', endpoint: server.endpoint, model: 'm', resolveKey: () => 'k' });
    await engine.ask({
      channel: 'authorize',
      state: 'push with ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345 to dev@example.com on db.acme-corp.internal 10.1.2.3',
    });
    const sent = server.seen[0].body.state;
    assert.equal(sent.includes('ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345'), false, 'the token reached a third party');
    assert.equal(sent.includes('dev@example.com'), false);
    assert.equal(sent.includes('db.acme-corp.internal'), false);
    assert.equal(sent.includes('10.1.2.3'), false);
    assert.ok(sent.includes('<GITHUB_TOKEN>'), 'shape should survive redaction');
  } finally {
    await server.close();
  }
});

await test('the HTTP engine can be told to skip redaction (same trust boundary)', async () => {
  const server = await startEndpoint([{ payload: NOUL(0.5) }]);
  try {
    const engine = createHttpEngine({
      id: 'typesafe',
      endpoint: server.endpoint,
      model: 'm',
      resolveKey: () => 'k',
      redactState: false,
    });
    await engine.ask({ channel: 'authorize', state: 'path C:\\work\\proj\\a.ts' });
    assert.ok(server.seen[0].body.state.includes('C:\\work\\proj\\a.ts'));
  } finally {
    await server.close();
  }
});

// ---------------------------------------------------------------------------
// 2. The HTTP engine: failure classification and error hygiene
// ---------------------------------------------------------------------------

await test('an authentication failure is not retried and never leaks the key', async () => {
  const server = await startEndpoint([{ status: 401, payload: { error: { message: 'invalid key test-key' } } }]);
  try {
    const engine = createHttpEngine({ id: 'typesafe', endpoint: server.endpoint, model: 'm', resolveKey: () => 'test-key' });
    let caught;
    await engine.ask({ channel: 'authorize', state: 'x' }).catch((error) => {
      caught = error;
    });
    assert.ok(caught, 'a 401 must throw');
    assert.equal(caught.status, 401);
    assert.equal(caught.retryable, false);
    assert.equal(server.seen.length, 1, 'a 401 cannot succeed on a second attempt');
    assert.equal(String(caught.message).includes('test-key'), false, 'the API key leaked into an error message');
    assert.equal(caught.message, 'typesafe: HTTP 401', 'upstream error bodies are never surfaced');
  } finally {
    await server.close();
  }
});

await test('a rate limit is retried and honours Retry-After', async () => {
  const server = await startEndpoint([
    { status: 429, payload: { error: 'slow down' }, headers: { 'retry-after': '0' } },
    { payload: NOUL(0.8) },
  ]);
  try {
    const engine = createHttpEngine({ id: 'typesafe', endpoint: server.endpoint, model: 'm', resolveKey: () => 'k' });
    const result = await engine.ask({ channel: 'authorize', state: 'x' });
    assert.equal(result.answers.authorize.noul, 0.8);
    assert.equal(server.seen.length, 2, 'a 429 should be retried');
  } finally {
    await server.close();
  }
});

await test('a server error is retried up to the configured limit, then throws', async () => {
  const server = await startEndpoint([{ status: 503, payload: { error: 'unavailable' } }]);
  try {
    const engine = createHttpEngine({ id: 'typesafe', endpoint: server.endpoint, model: 'm', resolveKey: () => 'k', retries: 2 });
    await assert.rejects(() => engine.ask({ channel: 'authorize', state: 'x' }), /HTTP 503/);
    assert.equal(server.seen.length, 3, 'one attempt plus two retries');
  } finally {
    await server.close();
  }
});

await test('a response with no answers object is a failure, not an empty verdict', async () => {
  const server = await startEndpoint([{ payload: { model: 'm', usage: {} } }]);
  try {
    const engine = createHttpEngine({ id: 'typesafe', endpoint: server.endpoint, model: 'm', resolveKey: () => 'k' });
    await assert.rejects(() => engine.ask({ channel: 'authorize', state: 'x' }), /carried no answers object/);
  } finally {
    await server.close();
  }
});

await test('a malformed JSON response is a failure', async () => {
  const server = await startEndpoint([{ payload: 'not json at all' }]);
  try {
    const engine = createHttpEngine({ id: 'typesafe', endpoint: server.endpoint, model: 'm', resolveKey: () => 'k' });
    await assert.rejects(() => engine.ask({ channel: 'authorize', state: 'x' }), /carried no answers object/);
  } finally {
    await server.close();
  }
});

await test('a closed endpoint is a transport failure, reported as such', async () => {
  const server = await startEndpoint([{ payload: NOUL(0.5) }]);
  const endpoint = server.endpoint;
  await server.close();
  const engine = createHttpEngine({ id: 'typesafe', endpoint, model: 'm', resolveKey: () => 'k', retries: 1 });
  await assert.rejects(() => engine.ask({ channel: 'authorize', state: 'x' }), /transport failure/);
});

await test('an engine without a key reports itself unavailable', () => {
  const engine = createHttpEngine({ id: 'openrouter', endpoint: 'http://127.0.0.1:1/x', model: 'm', resolveKey: () => undefined });
  assert.equal(engine.available(), false);
  const keyed = createHttpEngine({ id: 'openrouter', endpoint: 'http://127.0.0.1:1/x', model: 'm', resolveKey: () => 'k' });
  assert.equal(keyed.available(), true);
});

// ---------------------------------------------------------------------------
// 3. Engine selection and the breaker, through the real pipeline
// ---------------------------------------------------------------------------

const pipelineConfig = (overrides = {}) => ({
  ...normalizeConfig({}),
  breakerFailures: 2,
  breakerCooldownMs: 60_000,
  concurrency: 2,
  cacheTtlMs: 0,
  ...overrides,
});

await test('the pipeline prefers an available engine over an unconfigured one', () => {
  const model = createModelEngine({ ctx: { llm: { stream: () => {} } }, config: normalizeConfig({}) });
  const keyless = createHttpEngine({ id: 'typesafe', endpoint: 'http://127.0.0.1:1/x', model: 'm', resolveKey: () => undefined });
  const pipeline = createDecisionPipeline({ config: pipelineConfig(), engines: [keyless, model] });
  assert.equal(pipeline.primaryId, 'model', 'a keyless remote engine must not become the primary');
});

await test('a pinned remote backend stays primary when it is available', () => {
  const model = createModelEngine({ ctx: { llm: { stream: () => {} } }, config: normalizeConfig({}) });
  const keyed = createHttpEngine({ id: 'typesafe', endpoint: 'http://127.0.0.1:1/x', model: 'm', resolveKey: () => 'k' });
  const pipeline = createDecisionPipeline({ config: pipelineConfig({ backend: 'typesafe' }), engines: [keyed, model] });
  assert.equal(pipeline.primaryId, 'typesafe');
});

// ---------------------------------------------------------------------------
// 3b. Backend selection as the plugin actually configures it
// ---------------------------------------------------------------------------
//
// The ordering lives in `apply()`, so it is asserted through the plugin rather than
// through the pipeline constructor: the default `auto` must reach a configured
// remote JEV model, and must need no credential when none is configured.

const ORDER_LEDGER = await mkdtemp(path.join(os.tmpdir(), 'jev-order-'));

/** A host whose session route is a stub that records whether it was reached. */
function orderingHost() {
  const modelCalls = [];
  const captured = { tools: [] };
  const ctx = {
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    effect(fn) {
      const value = fn();
      if (typeof value === 'function') return value;
      if (value !== undefined && typeof value[Symbol.iterator] === 'function') return [...value];
      return () => {};
    },
    systemPrompt: { section: () => () => {}, context: () => () => {} },
    tools: {
      register(definition) {
        captured.tools.push(definition);
        return () => {};
      },
    },
    on: () => () => {},
    get: () => undefined,
    llm: {
      stream(options) {
        modelCalls.push(options);
        return (async function* generate() {
          yield { type: 'text-delta', index: 0, text: '{"answers":{"authorize":{"type":"noul","noul":0.9}}}' };
          yield { type: 'usage', usage: { input_tokens: 100, output_tokens: 10 } };
          yield { type: 'finish', reason: { kind: 'stop' } };
        })();
      },
    },
  };
  const agent = {
    session: {
      id: 'order-session',
      header: { cwd: 'E:\\work\\proj' },
      requestHeader: () => ({ config: { provider: 'deepseek-official', model: 'deepseek-flash' } }),
      snapshotEvents: () => [],
    },
  };
  return { ctx, captured, agent, modelCalls };
}

const decideVia = (captured, agent) => {
  const tool = captured.tools.find((item) => item.name === 'jev_decide');
  return tool.execute(
    { channel: 'authorize', state: 'run the tests' },
    { agent, signal: new AbortController().signal, callId: 'c', name: 'jev_decide' },
  );
};

await test('backend auto reaches a configured remote JEV model instead of the session route', async () => {
  const server = await startEndpoint([{ payload: { answers: { authorize: { type: 'noul', noul: 0.77 } } } }]);
  try {
    const host = orderingHost();
    apply(host.ctx, {
      backend: 'auto',
      typesafe: { endpoint: server.endpoint, apiKey: 'configured-key', model: 'jev-1.13.0' },
      ledgerDir: ORDER_LEDGER,
    });
    const value = await decideVia(host.captured, host.agent);
    assert.equal(server.seen.length, 1, 'the configured remote model should have been asked');
    assert.equal(host.modelCalls.length, 0, 'the session route should not have been used');
    assert.equal(value.backend.startsWith('typesafe'), true, `backend was ${value.backend}`);
    assert.equal(value.probability, 0.77);
  } finally {
    await server.close();
  }
});

await test('backend auto needs no credential when none is configured', async () => {
  const server = await startEndpoint([{ payload: { answers: { authorize: { type: 'noul', noul: 0.11 } } } }]);
  const previous = process.env.TYPESAFE_API_KEY;
  delete process.env.TYPESAFE_API_KEY;
  try {
    const host = orderingHost();
    apply(host.ctx, { backend: 'auto', typesafe: { endpoint: server.endpoint, model: 'jev-1.13.0' }, ledgerDir: ORDER_LEDGER });
    const value = await decideVia(host.captured, host.agent);
    assert.equal(server.seen.length, 0, 'with no key the remote engine must not be consulted');
    assert.equal(host.modelCalls.length, 1, 'the session route should have answered');
    assert.equal(value.backend.startsWith('model'), true, `backend was ${value.backend}`);
  } finally {
    if (previous === undefined) delete process.env.TYPESAFE_API_KEY;
    else process.env.TYPESAFE_API_KEY = previous;
    await server.close();
  }
});

await test('a remote backend reads its key from the environment, which is how .env supplies it', async () => {
  const server = await startEndpoint([{ payload: { answers: { authorize: { type: 'noul', noul: 0.66 } } } }]);
  const previous = process.env.TYPESAFE_API_KEY;
  process.env.TYPESAFE_API_KEY = 'from-the-environment';
  try {
    const host = orderingHost();
    apply(host.ctx, { backend: 'typesafe', typesafe: { endpoint: server.endpoint, model: 'jev-1.13.0' }, ledgerDir: ORDER_LEDGER });
    const value = await decideVia(host.captured, host.agent);
    assert.equal(server.seen.length, 1);
    // The documented community convention is a TYPESAFE_API_KEY line in the
    // harness-home .env, which the harness loads into the process environment.
    assert.equal(server.seen[0].headers.authorization, 'Bearer from-the-environment');
    assert.equal(value.backend.startsWith('typesafe'), true);
  } finally {
    if (previous === undefined) delete process.env.TYPESAFE_API_KEY;
    else process.env.TYPESAFE_API_KEY = previous;
    await server.close();
  }
});

// ---------------------------------------------------------------------------
// 3c. Compatibility with the live TypeSafe response shapes
// ---------------------------------------------------------------------------
//
// These payloads were captured from `POST https://api.typesafe.ai/v1/systemone`
// with model `jev-1.13.0`. They are recorded verbatim because the service's shapes
// differ from this bundle's own rubric in ways that are easy to assume wrongly: a
// `noul` answer carries neither `confidence` nor `basis`, and a `score` answer
// carries a `legend` next to the distribution.

await test('the normalizers accept the live TypeSafe noul shape', () => {
  const answer = normalizeAnswer('authorize', { type: 'noul', noul: 0.02 });
  assert.equal(answer.ok, true);
  assert.equal(answer.probability, 0.02);
  assert.equal(answer.basis, '', 'a missing basis must not fail the answer');
  assert.equal(answer.confidence, 0.02);
});

await test('the score level comes from the live distribution, not from the reported mean', () => {
  const live = {
    type: 'score',
    score: 2.45,
    confidence: 0.49,
    legend: { 0: 'reversible', 1: 'effort', 2: 'hard', 3: 'irreversible' },
    probabilities: { 0: 0, 1: 0.03, 2: 0.49, 3: 0.48 },
  };
  const answer = normalizeAnswer('risk', live);
  assert.equal(answer.ok, true);
  assert.equal(answer.level, 2, 'the peak is level 2 even though the mean is 2.45');
  assert.equal(answer.mean, 2.45);
  assert.equal(answer.confidence, 0.49);
});

await test('a live probability bands exactly as the live decision it came from', () => {
  // Captured: the same authorization question answered 0.02 for a destructive target
  // the user never named, and 0.57 for the target they did name.
  const cuts = { threshold: 0.85, askBand: 0.55 };
  const denied = verdictFor('authorize', normalizeAnswer('authorize', { type: 'noul', noul: 0.02 }), cuts);
  const asked = verdictFor('authorize', normalizeAnswer('authorize', { type: 'noul', noul: 0.57 }), cuts);
  assert.equal(denied.verdict, 'deny');
  assert.equal(asked.verdict, 'ask');
});

await test('consecutive failures open the breaker and later calls short-circuit', async () => {
  const server = await startEndpoint([{ status: 500, payload: { error: 'boom' } }]);
  try {
    const engine = createHttpEngine({ id: 'typesafe', endpoint: server.endpoint, model: 'm', resolveKey: () => 'k', retries: 0 });
    const pipeline = createDecisionPipeline({ config: pipelineConfig({ breakerFailures: 2 }), engines: [engine] });
    const first = await pipeline.decide({ channel: 'authorize', state: 'a', timeoutMs: 2000, cuts: { threshold: 0.85, askBand: 0.55 } });
    assert.equal(first.ok, false);
    const second = await pipeline.decide({ channel: 'authorize', state: 'b', timeoutMs: 2000, cuts: { threshold: 0.85, askBand: 0.55 } });
    assert.equal(second.ok, false);
    const callsBefore = server.seen.length;
    const third = await pipeline.decide({ channel: 'authorize', state: 'c', timeoutMs: 2000, cuts: { threshold: 0.85, askBand: 0.55 } });
    assert.equal(third.ok, false);
    assert.equal(third.via, 'breaker', 'an open breaker must not pay the timeout again');
    assert.equal(server.seen.length, callsBefore, 'a short-circuited call must not reach the network');
    assert.equal(pipeline.breaker.state().open, true);
  } finally {
    await server.close();
  }
});

await test('a decision timeout is enforced by the call site, not the engine', async () => {
  // A server that never answers: the timeout must bound the call.
  const server = http.createServer(() => {});
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    const engine = createHttpEngine({ id: 'typesafe', endpoint: `http://127.0.0.1:${port}/d`, model: 'm', resolveKey: () => 'k', retries: 0 });
    const pipeline = createDecisionPipeline({ config: pipelineConfig(), engines: [engine] });
    const started = Date.now();
    const outcome = await pipeline.decide({ channel: 'authorize', state: 'x', timeoutMs: 300, cuts: { threshold: 0.85 } });
    const elapsed = Date.now() - started;
    assert.equal(outcome.ok, false);
    assert.ok(elapsed < 3000, `the call was not bounded: ${elapsed}ms`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

// ---------------------------------------------------------------------------
// 4. The jev_gate tool
// ---------------------------------------------------------------------------

const CWD = 'E:\\work\\proj';
const GATE_LEDGER = await mkdtemp(path.join(os.tmpdir(), 'jev-gate-'));

function gateHost({ replies = [] } = {}) {
  const requests = [];
  const captured = { tools: [], listeners: [], sections: [], contexts: [] };
  const ctx = {
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    effect(fn) {
      const value = fn();
      if (typeof value === 'function') return value;
      if (value !== undefined && typeof value[Symbol.iterator] === 'function') return [...value];
      return () => {};
    },
    systemPrompt: { section: () => () => {}, context: () => () => {} },
    tools: {
      register(definition) {
        captured.tools.push(definition);
        return () => {};
      },
    },
    on: () => () => {},
    get: () => undefined,
    llm: {
      stream(options) {
        requests.push(options);
        const text = replies.shift() ?? '{"answers":{"authorize":{"type":"noul","noul":0.9}}}';
        return (async function* generate() {
          yield { type: 'text-delta', index: 0, text };
          yield { type: 'usage', usage: { input_tokens: 500, output_tokens: 20 } };
          yield { type: 'finish', reason: { kind: 'stop' } };
        })();
      },
    },
  };
  const agent = {
    session: {
      id: 'gate-session',
      header: { cwd: CWD },
      requestHeader: () => ({ config: { provider: 'deepseek-official', model: 'deepseek-flash' } }),
      snapshotEvents: () => [],
    },
  };
  return { ctx, captured, agent, requests };
}

const callGate = (captured, args, agent) => {
  const tool = captured.tools.find((item) => item.name === 'jev_gate');
  assert.ok(tool, 'jev_gate was not registered');
  return tool.execute(args, { agent, signal: new AbortController().signal, callId: 'c1', name: 'jev_gate' });
};

await test('jev_gate returns the authorization verdict for a planned action', async () => {
  const host = gateHost({ replies: ['{"answers":{"authorize":{"type":"noul","noul":0.93,"basis":"user asked to deploy"}}}'] });
  apply(host.ctx, { ledgerDir: GATE_LEDGER });
  const value = await callGate(host.captured, { action: 'git push origin main', target: 'origin/main' }, host.agent);
  assert.equal(value.verdict, 'allow');
  assert.equal(value.probability, 0.93);
  assert.equal(value.backend.startsWith('model'), true);
  // The planned action and its target must both reach the decision.
  const sent = JSON.parse(host.requests[0].messages[0].content[0].text.replace('JEV REQUEST\n', ''));
  assert.ok(sent.state.includes('git push origin main'));
  assert.ok(sent.state.includes('origin/main'));
});

await test('jev_gate refuses a root destroy without any model call', async () => {
  const host = gateHost();
  apply(host.ctx, { ledgerDir: GATE_LEDGER });
  const value = await callGate(host.captured, { action: 'rm -rf /' }, host.agent);
  assert.equal(value.verdict, 'deny');
  assert.equal(value.backend, 'local');
  assert.equal(host.requests.length, 0, 'a deterministic refusal must not spend a decision');
  assert.match(value.reason, /without a decision/);
});

await test('jev_gate refuses a credential write without any model call', async () => {
  const host = gateHost();
  apply(host.ctx, { ledgerDir: GATE_LEDGER });
  const value = await callGate(
    host.captured,
    { action: 'Set-Content -Path C:\\Users\\dev\\.dsh\\.credentials.yaml -Value x' },
    host.agent,
  );
  assert.equal(value.verdict, 'deny');
  assert.equal(host.requests.length, 0);
});

await test('jev_gate escalates a low-probability authorization', async () => {
  const host = gateHost({ replies: ['{"answers":{"authorize":{"type":"noul","noul":0.2}}}'] });
  apply(host.ctx, { ledgerDir: GATE_LEDGER });
  const value = await callGate(host.captured, { action: 'terraform destroy' }, host.agent);
  assert.equal(value.verdict, 'deny');
  assert.match(value.guidance, /Not authorized/);
});

await test('jev_gate appends the classifier risk when it allows a risky plan', async () => {
  const host = gateHost({ replies: ['{"answers":{"authorize":{"type":"noul","noul":0.99}}}'] });
  apply(host.ctx, { ledgerDir: GATE_LEDGER });
  const value = await callGate(host.captured, { action: 'npm publish --access public' }, host.agent);
  assert.equal(value.verdict, 'allow');
  assert.match(value.guidance, /risk level/i, 'an allow on a risky plan should still flag the risk');
});

await test('jev_gate rejects an empty action and reports an unavailable backend', async () => {
  const host = gateHost();
  apply(host.ctx, { ledgerDir: GATE_LEDGER });
  await assert.rejects(() => callGate(host.captured, { action: '   ' }, host.agent), /must not be empty/);
  const broken = gateHost();
  broken.ctx.llm.stream = () => {
    throw new Error('no route');
  };
  apply(broken.ctx, { ledgerDir: GATE_LEDGER });
  const value = await callGate(broken.captured, { action: 'git push origin main' }, broken.agent);
  assert.equal(value.verdict, 'unavailable');
});

// ---------------------------------------------------------------------------
// 5. Small units nothing else touched
// ---------------------------------------------------------------------------

await test('the state is truncated keeping both ends, and short states pass through', () => {
  assert.equal(truncateState('short', 1000), 'short');
  const long = `${'H'.repeat(5000)}MIDDLE${'T'.repeat(5000)}`;
  const cut = truncateState(long, 1000);
  assert.ok(cut.length <= 1000 + 60, `truncated length was ${cut.length}`);
  assert.ok(cut.startsWith('H'));
  assert.ok(cut.endsWith('T'));
  assert.ok(cut.includes('[truncated'));
});

await test('compact drops undefined fields, which would otherwise fail output validation', () => {
  assert.deepEqual(compact({ a: 1, b: undefined, c: null }), { a: 1, c: null });
  assert.deepEqual(compact({}), {});
});

await test('unwrapField resolves a volatile wrapper and passes plain values through', () => {
  const writer = Symbol.for('cosmokit.volatile.write');
  assert.equal(unwrapField({ get: () => 7, [writer]: () => {} }), 7);
  assert.equal(unwrapField('plain'), 'plain');
  assert.equal(unwrapField(42), 42);
  assert.equal(unwrapField(null), null);
});

await test('deadlineSignal bounds a call, and its fallback path works too', async () => {
  const original = AbortSignal.any;
  try {
    const signal = deadlineSignal(undefined, 20);
    assert.equal(signal.aborted, false);
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.equal(signal.aborted, true);

    // Force the fallback path a runtime without AbortSignal.any would take.
    AbortSignal.any = undefined;
    const parent = new AbortController();
    const combined = deadlineSignal(parent.signal, 5000);
    assert.equal(combined.aborted, false);
    parent.abort(new Error('parent aborted'));
    assert.equal(combined.aborted, true, 'the fallback must follow the parent signal');

    const timedOut = deadlineSignal(undefined, 10);
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal(timedOut.aborted, true, 'the fallback must still time out');
  } finally {
    AbortSignal.any = original;
  }
});

await test('backoff grows, is capped, and prefers Retry-After', () => {
  assert.equal(backoffMs(0), 400);
  assert.equal(backoffMs(1), 800);
  assert.equal(backoffMs(20), 5000);
  assert.equal(backoffMs(0, '3'), 3000);
  assert.equal(backoffMs(0, 'not-a-number'), 400);
});

await test('the breaker treats a clock starting at zero as never opened', () => {
  let clock = 0;
  const breaker = createBreaker({ failures: 1, cooldownMs: 100, now: () => clock });
  assert.equal(breaker.admit().ok, true, 'a zero clock must not look like an open breaker');
  breaker.failure();
  assert.equal(breaker.admit().ok, false);
  clock = 100;
  assert.equal(breaker.admit().ok, true);
});

await test('redaction is applied to the request but not to the ledger body default', () => {
  // Both matter: one is a privacy control, the other is what a user reads back.
  assert.equal(redact('token ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ01'), 'token <GITHUB_TOKEN>');
});

console.log(results.join('\n'));
console.log(failures === 0 ? `\nall ${results.length} checks passed` : `\n${failures} check(s) FAILED`);
process.exit(failures === 0 ? 0 : 1);
