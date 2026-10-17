import test from 'node:test';
import assert from 'node:assert/strict';
import { streamMetrics } from '../bench/stream-metrics.mjs';

test('separates reasoning, visible text and tool timestamps without retaining content', () => {
  let clock = 0;
  const metrics = streamMetrics({ now: () => clock });
  clock = 10; metrics.accept({ type: 'usage', usage: {} });
  assert.equal(metrics.snapshot().firstOutputMs, null);
  clock = 20; metrics.accept({ type: 'reasoning-delta', index: 0, text: 'synthetic-private-marker' });
  clock = 30; metrics.accept({ type: 'block-end', index: 0, block: { type: 'reasoning', text: 'synthetic-private-marker' } });
  clock = 40; metrics.accept({ type: 'text-delta', index: 1, text: 'visible marker' });
  clock = 50; metrics.accept({ type: 'block-start', index: 2, blockType: 'tool-call' });
  clock = 60; metrics.accept({ type: 'tool-call-delta', index: 2 });
  assert.deepEqual(metrics.snapshot(), { firstOutputMs: 20, firstReasoningMs: 20, firstTextMs: 40, firstToolCallMs: 50,
    reasoningChars: 'synthetic-private-marker'.length });
  assert.ok(!JSON.stringify(metrics.snapshot()).includes('marker'));
});

test('whole-block fallback counts each reasoning block and preserves time zero', () => {
  let clock = 0;
  const metrics = streamMetrics({ now: () => clock });
  metrics.accept({ type: 'block-end', index: 0, block: { type: 'reasoning', text: 'first' } });
  clock = 5; metrics.accept({ type: 'block-end', index: 1, block: { type: 'reasoning', text: 'second' } });
  assert.equal(metrics.snapshot().firstReasoningMs, 0); assert.equal(metrics.snapshot().reasoningChars, 11);
  assert.equal(metrics.snapshot().firstTextMs, null); assert.equal(metrics.snapshot().firstToolCallMs, null);
});
