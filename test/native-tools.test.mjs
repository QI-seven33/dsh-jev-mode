import test from 'node:test';
import assert from 'node:assert/strict';
import { executeNativeTool } from '../lib/native-tools.js';
import { sessionCwd } from '../lib/session-cwd.js';
import { createGate } from '../lib/gate.js';
import { normalizeConfig } from '../index.js';

test('batch bridge preserves native ownership, cancellation, denial and deferred context', async () => {
  const agent = {}, signal = new AbortController().signal;
  const deferred = [{ id: 'fixture-notice', role: 'user', content: [] }];
  let calls = 0;
  const tools = { setExecutor() {}, async execute(input) {
    calls++;
    assert.equal(input.agent, agent);
    assert.equal(input.signal, signal);
    assert.equal(input.log, undefined, 'pre-step read must not invent model tool history');
    assert.deepEqual(input.calls, [{ type: 'tool-call', id: 'read-1', name: 'read', arguments: '{"file_path":"fixture.json"}' }]);
    return { results: [{ callId: 'read-1', result: { isError: true, content: [{ type: 'text', text: 'denied' }] } }], additionalContexts: deferred };
  } };
  const result = await executeNativeTool(tools, { agent, signal, name: 'read', callId: 'read-1', arguments: { file_path: 'fixture.json' } });
  assert.equal(calls, 1);
  assert.equal(result.isError, true);
  assert.equal(result.additionalContexts, deferred);
});

test('a failed or uncorrelated batch is not retried through legacy execution', async () => {
  for (const behavior of ['throw', 'wrong-id']) {
    let calls = 0;
    const tools = { setExecutor() {}, async execute() {
      calls++;
      if (behavior === 'throw') throw Error('native permission service unavailable');
      return { results: [{ callId: 'other', result: {} }] };
    } };
    await assert.rejects(executeNativeTool(tools, { name: 'read', arguments: {}, callId: 'read-1' }));
    assert.equal(calls, 1);
  }
});

test('native working-directory transitions change scope and invalidate pending authorization', async () => {
  const events = [];
  const session = { id: 'fixture', header: { cwd: 'E:/fixture/original' }, snapshotEvents: () => events };
  assert.equal(sessionCwd(session), 'E:/fixture/original');
  events.push({ type: 'working-directory/change', data: { cwd: 'E:/fixture/current' } });
  assert.equal(sessionCwd(session), 'E:/fixture/current');
  const noop = async () => {};
  const gate = createGate({ config: normalizeConfig({}), logger: {},
    ledger: { recordDegraded: noop, recordDecision: noop, recordGate: noop },
    decide: async ({ state }) => {
      assert.equal(JSON.parse(state).workingDirectory, 'E:/fixture/current');
      events.push({ type: 'working-directory/change', data: { cwd: 'E:/fixture/changed-again' } });
      return { ok: true, answers: { authorize: { type: 'noul', noul: .99 } }, via: 'fixture' };
    } });
  const result = await gate.evaluate({ session, exec: { name: 'bash', callId: 'cwd-change', arguments: { command: 'npm publish' } } });
  assert.equal(result.verdict, 'ask');
  assert.equal(result.failure, true);
});
