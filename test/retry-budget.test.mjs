import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHttpEngine, createDecisionPipeline, retryAfterMs, backoffMs } from '../lib/engine.js';
import { createGate } from '../lib/gate.js';
import { createLedger } from '../lib/ledger.js';
import { normalizeConfig } from '../index.js';

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function endpoint(replies) {
  const seen = [];
  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      seen.push(Date.now());
      const reply = replies[Math.min(seen.length - 1, replies.length - 1)];
      const respond = () => {
        res.writeHead(reply.status ?? 200, { 'content-type': 'application/json', ...reply.headers });
        res.end(JSON.stringify(reply.body ?? { answers: { authorize: { noul: .9 }, grounded: { noul: .9 } } }));
      };
      if (reply.delayMs) setTimeout(respond, reply.delayMs);
      else respond();
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { seen, url: `http://127.0.0.1:${server.address().port}/decide`,
    async close() { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); } };
}
function setup(url, options = {}, config = {}) {
  const engine = createHttpEngine({ id: 'typesafe', endpoint: url, model: 'jev-1.13.0', resolveKey: () => 'synthetic-test-key', ...options });
  const pipeline = createDecisionPipeline({ config: normalizeConfig({ cacheTtlMs: 0, ...config }), engines: [engine] });
  return { engine, pipeline, decide: input => pipeline.decide({ channel: 'authorize', state: 'Synthetic decision only', timeoutMs: 1000, ...input }) };
}

test('server delays support seconds and HTTP-date without the old five-second cap', () => {
  const now = Date.UTC(2026, 9, 17, 0, 0, 0);
  assert.equal(backoffMs(0, '30'), 30000);
  assert.equal(retryAfterMs('Sat, 17 Oct 2026 00:00:30 GMT', now), 30000);
  assert.equal(retryAfterMs('Sat, 17 Oct 2026 00:00:00 GMT', now + 1), 0);
  assert.equal(retryAfterMs('0'), 0);
  assert.equal(retryAfterMs('0.25'), 250);
  for (const invalid of [null, '', ' ', '-1', 'Infinity', 'NaN', 'later', '1e3']) assert.equal(retryAfterMs(invalid), undefined);
});

test('a server delay outside the remaining budget fails promptly after one HTTP request', async () => {
  const server = await endpoint([{ status: 429, headers: { 'retry-after': '30' } }]);
  try {
    const { decide, pipeline } = setup(server.url);
    const started = Date.now();
    const result = await decide({ timeoutMs: 1000 });
    assert.equal(result.ok, false); assert.equal(result.via, 'retry-budget');
    assert.ok(Date.now() - started < 800, 'must not consume the whole decision deadline');
    assert.equal(server.seen.length, 1);
    assert.equal(pipeline.stats.httpRequests, 1); assert.equal(pipeline.stats.retries, 0);
    assert.equal(result.transport.retryBudgetSkips, 1); assert.equal(result.transport.retryWaitMs, 0);
    assert.equal(pipeline.cache.size(), 0);
  } finally { await server.close(); }
});

test('local backoff also stops before a retry that cannot fit the budget', async () => {
  const server = await endpoint([{ status: 503 }]);
  try {
    const { decide } = setup(server.url);
    const result = await decide({ timeoutMs: 200 });
    assert.equal(result.via, 'retry-budget'); assert.equal(server.seen.length, 1);
  } finally { await server.close(); }
});

test('explicit cooldown protects following calls even when retries are disabled, and is instance-local', async () => {
  const server = await endpoint([{ status: 429, headers: { 'retry-after': '30' } }]);
  try {
    const { decide, pipeline } = setup(server.url, { retries: 0 }, { breakerFailures: 10 });
    assert.equal((await decide()).via, 'error');
    for (let i = 0; i < 4; i++) assert.equal((await decide({ state: 'different-' + i })).via, 'cooldown');
    assert.equal(server.seen.length, 1);
    assert.equal(pipeline.stats.cooldownSkips, 4);
    assert.equal(pipeline.breaker.state().consecutive, 1, 'skipped calls must not add provider failures');
    await setup(server.url, { retries: 0 }).decide();
    assert.equal(server.seen.length, 2, 'another engine does not inherit global cooldown or credentials');
  } finally { await server.close(); }
});

test('retry-after-ms is honored, the recovery request is counted, and cooldown expires', async () => {
  const server = await endpoint([{ status: 503, headers: { 'retry-after-ms': '80' } }, {}]);
  try {
    const { decide, pipeline } = setup(server.url);
    const result = await decide();
    assert.equal(result.ok, true); assert.equal(server.seen.length, 2);
    assert.ok(server.seen[1] - server.seen[0] >= 75, 'must not retry before the server minimum');
    assert.equal(result.transport.httpRequests, 2); assert.equal(result.transport.retries, 1);
    assert.ok(result.transport.retryWaitMs >= 75);
    assert.equal((await decide()).ok, true); assert.equal(pipeline.stats.httpRequests, 3);
  } finally { await server.close(); }
});

test('HTTP-date headers drive the actual retry budget path', async () => {
  const server = await endpoint([{ status: 503, headers: { 'retry-after': new Date(Date.now() + 30000).toUTCString() } }]);
  try {
    const { decide } = setup(server.url);
    assert.equal((await decide()).via, 'retry-budget'); assert.equal((await decide()).via, 'cooldown');
    assert.equal(server.seen.length, 1);
  } finally { await server.close(); }
});

test('concurrent in-flight throttles extend cooldown and neither retry runs early', async () => {
  const server = await endpoint([
    { delayMs: 30, status: 429, headers: { 'retry-after-ms': '80' } },
    { delayMs: 50, status: 429, headers: { 'retry-after-ms': '160' } }, {},
  ]);
  try {
    const { decide, pipeline } = setup(server.url);
    const results = await Promise.all([decide({ state: 'first' }), decide({ state: 'second' })]);
    assert.ok(results.every(result => result.ok)); assert.equal(server.seen.length, 4);
    for (const retriedAt of server.seen.slice(2)) assert.ok(retriedAt - server.seen[1] >= 200,
      'a later concurrent server delay must extend the minimum for both retries');
    assert.equal(pipeline.stats.httpRequests, 4); assert.equal(pipeline.stats.retries, 2);
  } finally { await server.close(); }
});

test('cancelling retry sleep sends no later request and does not trip the breaker', async () => {
  const server = await endpoint([{ status: 429, headers: { 'retry-after-ms': '300' } }, {}]);
  try {
    const { decide, pipeline } = setup(server.url);
    const controller = new AbortController();
    const pending = decide({ signal: controller.signal });
    while (!server.seen.length) await pause(1);
    await pause(40); controller.abort();
    const result = await pending;
    assert.equal(result.via, 'cancelled'); assert.equal(result.transport.retries, 0);
    await pause(310); assert.equal(server.seen.length, 1);
    assert.equal(pipeline.breaker.state().consecutive, 0);
    assert.equal((await decide()).ok, true);
  } finally { await server.close(); }
});

test('the second credential lookup is bounded, cannot send a late request, and releases its limiter slot', async () => {
  const server = await endpoint([{}]);
  let resolve;
  try {
    const { engine, decide, pipeline } = setup(server.url, { resolveKey: () => new Promise(r => { resolve = r; }) }, { concurrency: 1, breakerFailures: 1 });
    // The already-covered availability check succeeds; exercise ask()'s own lookup.
    engine.available = () => true;
    const timer = setTimeout(() => {}, 500);
    let result;
    try { result = await decide({ timeoutMs: 30 }); } finally { clearTimeout(timer); }
    assert.equal(result.ok, false); assert.equal(result.transport.httpRequests, 0);
    assert.equal(pipeline.breaker.state().open, false);
    resolve('synthetic-late-key'); await pause(10); assert.equal(server.seen.length, 0);
    // A new per-call lookup must also complete; the timed-out call cannot keep
    // the single concurrency permit occupied.
    resolve = undefined;
    const controller = new AbortController();
    const next = decide({ signal: controller.signal });
    while (!resolve) await pause(1);
    await pause(5); resolve('synthetic-rotated-key');
    assert.equal((await next).ok, true, 'the occupied limiter permit was released');
  } finally { await server.close(); }
});

test('credential errors do not surface service-provided secret text', async () => {
  const { engine, decide } = setup('http://127.0.0.1:1/unused', { resolveKey: () => { throw Error('synthetic-private-marker'); } });
  engine.available = () => true;
  const result = await decide();
  assert.equal(result.ok, false); assert.ok(!result.reason.includes('synthetic-private-marker'));
  assert.equal(result.transport.httpRequests, 0);
});

test('cooldown skips release a half-open probe without erasing its failure history', async () => {
  const server = await endpoint([{ status: 429, headers: { 'retry-after-ms': '100' } }, {}]);
  try {
    const { decide, pipeline } = setup(server.url, {}, { breakerFailures: 1, breakerCooldownMs: 0 });
    assert.equal((await decide({ timeoutMs: 50 })).via, 'retry-budget');
    for (let i = 0; i < 3; i++) assert.equal((await decide()).via, 'cooldown');
    assert.equal(pipeline.breaker.state().consecutive, 1);
    await pause(110); assert.equal((await decide()).ok, true);
    assert.equal(pipeline.breaker.state().open, false); assert.equal(server.seen.length, 2);
  } finally { await server.close(); }
});

test('rate limited authorization still asks or denies at the actual gate', async () => {
  const server = await endpoint([{ status: 429, headers: { 'retry-after': '30' } }]);
  try {
    const { pipeline } = setup(server.url);
    for (const policy of ['escalate', 'deny']) {
      const gate = createGate({ config: normalizeConfig({ onGateFailure: policy }), decide: pipeline.decide,
        ledger: { recordDegraded: async () => {}, recordGate: async () => {} } });
      const result = await gate.evaluate({ exec: { name: 'bash', arguments: { command: 'npm publish' } },
        session: { id: 'synthetic', header: { cwd: '/synthetic' }, snapshotEvents: () => [] } });
      assert.equal(result.verdict, policy === 'deny' ? 'deny' : 'ask');
    }
    assert.equal(server.seen.length, 1);
  } finally { await server.close(); }
});

test('advisory cache hits report zero new HTTP work', async () => {
  const server = await endpoint([{}]);
  try {
    const { decide, pipeline } = setup(server.url, {}, { cacheTtlMs: 60000 });
    assert.equal((await decide({ channel: 'grounded' })).transport.httpRequests, 1);
    const cached = await decide({ channel: 'grounded' });
    assert.equal(cached.cached, true); assert.equal(cached.transport.httpRequests, 0);
    assert.equal(pipeline.stats.httpRequests, 1); assert.equal(server.seen.length, 1);
  } finally { await server.close(); }
});

test('ledger transport metadata has an explicit numeric allowlist for success and degradation', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'jev-transport-'));
  try {
    const ledger = createLedger({ dir });
    const transport = { httpRequests: 2, retries: 1, retryWaitMs: 80, cooldownSkips: 0, retryBudgetSkips: NaN,
      secret: 'synthetic-private-marker', headers: { authorization: 'synthetic-private-marker' } };
    await ledger.recordDecision({ sessionId: 'synthetic', channel: 'grounded', transport });
    await ledger.recordDegraded({ sessionId: 'synthetic', channel: 'authorize', reason: 'synthetic failure', transport });
    const text = await readFile(ledger.file(), 'utf8');
    assert.ok(!text.includes('synthetic-private-marker'));
    for (const row of text.trim().split('\n').map(JSON.parse)) assert.deepEqual(row.transport,
      { httpRequests: 2, retries: 1, retryWaitMs: 80, cooldownSkips: 0 });
  } finally { await rm(dir, { recursive: true, force: true }); }
});
