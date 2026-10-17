// Metadata-only ledger and session counters. Actions, reasons and basis are
// hashes only. Disabling persistence keeps counters and never touches disk.

import { appendFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { dayStamp, sha256Hex } from './util.js';

/** Ledger row kinds. `decision` and `gate` are outcomes; the rest are accounting. */
export const ROW = Object.freeze({
  decision: 'decision',
  gate: 'gate',
  degraded: 'degraded',
  error: 'error',
  budget: 'budget',
});

// Numeric transport accounting only. Never persist arbitrary provider objects,
// headers, errors, credentials or request/response bodies through this field.
function transportMetadata(value) {
  if (!value) return undefined;
  return Object.fromEntries(['httpRequests', 'retries', 'retryWaitMs', 'cooldownSkips', 'retryBudgetSkips']
    .filter(key => Number.isFinite(value[key]) && value[key] >= 0)
    .map(key => [key, Math.round(value[key])]));
}

/**
 * Create the ledger writer and the in-memory session counters.
 *
 * Writes are fire-and-forget: a decision must never wait on the filesystem, and
 * a ledger failure must never change a decision. Write failures are logged once
 * per day-file and then dropped.
 */
export function createLedger({ dir, logger, pluginVersion, enabled = true }) {
  const warned = new Set();
  let writeChain = Promise.resolve();
  let day = dayStamp();
  let file = path.join(dir, `ledger-${day}.jsonl`);

  const sessions = new Map();

  function sessionStats(sessionId) {
    const key = typeof sessionId === 'string' && sessionId.length > 0 ? sha256Hex(sessionId, 12) : 'anonymous';
    let stats = sessions.get(key);
    if (!stats) {
      stats = {
        key,
        decisions: 0,
        cacheHits: 0,
        cacheReadTokens: 0,
        inputTokens: 0,
        outputTokens: 0,
        gateCalls: 0,
        gateAllow: 0,
        gateAsk: 0,
        gateDeny: 0,
        degraded: 0,
        byChannel: {},
        codeSelections: 0, semanticSelections: 0, selectionFallbacks: 0, evidenceReuses: 0, selectorMs: 0,
      };
      sessions.set(key, stats);
    }
    return stats;
  }

  function append(row) {
    if (!enabled) return Promise.resolve();
    const stamped = { at: new Date().toISOString(), plugin: pluginVersion, ...row };
    const line = `${JSON.stringify(stamped)}\n`;
    const currentDay = dayStamp();
    if (currentDay !== day) {
      day = currentDay;
      file = path.join(dir, `ledger-${day}.jsonl`);
    }
    const target = file;
    writeChain = writeChain
      .then(async () => {
        await mkdir(dir, { recursive: true });
        await appendFile(target, line, 'utf8');
      })
      .catch((error) => {
        const tag = `${target}`;
        if (!warned.has(tag)) {
          warned.add(tag);
          logger?.warn?.('dsh-jev-mode: ledger write to %s failed: %s', target, String(error?.message ?? error));
        }
      });
    return writeChain;
  }

  /** Record one decision outcome and fold it into the session counters. */
  function recordDecision({ sessionId, channel, primitive, verdict, answer, backend, cuts, ms, usage, cacheRead, cached, action, rubricVersion, transport }) {
    const stats = sessionStats(sessionId);
    stats.decisions += 1;
    if (cached) stats.cacheHits += 1;
    stats.cacheReadTokens += Number(cacheRead) || 0;
    stats.inputTokens += Number(usage?.input_tokens ?? usage?.inputTokens ?? 0) || 0;
    stats.outputTokens += Number(usage?.output_tokens ?? usage?.outputTokens ?? 0) || 0;
    const bucket = (stats.byChannel[channel] ??= { n: 0, lastVerdict: undefined, lastValue: undefined });
    bucket.n += 1;
    bucket.lastVerdict = verdict;
    bucket.lastValue = answer?.probability ?? answer?.value ?? undefined;

    return append({
      kind: ROW.decision,
      session: stats.key,
      channel,
      primitive,
      backend,
      verdict,
      value: answer?.ok === true ? (answer.probability ?? answer.value ?? null) : null,
      confidence: answer?.ok === true ? (answer.confidence ?? null) : null,
      threshold: cuts?.threshold ?? null,
      askBand: cuts?.askBand ?? null,
      basisHash: answer?.basis ? sha256Hex(answer.basis, 32) : undefined,
      ms: Number.isFinite(ms) ? ms : undefined,
      cached: cached === true,
      cacheReadTokens: Number(cacheRead) || 0,
      inputTokens: Number(usage?.input_tokens ?? usage?.inputTokens ?? 0) || 0,
      outputTokens: Number(usage?.output_tokens ?? usage?.outputTokens ?? 0) || 0,
      rubric: rubricVersion,
      transport: transportMetadata(transport),
      stateHash: sha256Hex(typeof action === 'string' ? action : JSON.stringify(action ?? null), 12),
    });
  }

  /** Record the automatic gate's own outcome, including what it decided to do. */
  function recordGate({ sessionId, tool, verdict, riskLevel, backend, ms, cached, reason, action, reasonCode }) {
    const stats = sessionStats(sessionId);
    stats.gateCalls += 1;
    if (verdict === 'allow') stats.gateAllow += 1;
    if (verdict === 'ask') stats.gateAsk += 1;
    if (verdict === 'deny') stats.gateDeny += 1;
    return append({
      kind: ROW.gate,
      session: stats.key,
      tool,
      verdict,
      riskLevel: riskLevel ?? null,
      backend,
      ms: Number.isFinite(ms) ? ms : undefined,
      cached: cached === true,
      reasonHash: reason === undefined ? undefined : sha256Hex(reason, 32),
      reasonCode: ['hard_rule', 'authorization_allow', 'authorization_ask', 'authorization_deny', 'backend_unavailable'].includes(reasonCode) ? reasonCode : undefined,
      stateHash: action === undefined ? undefined : sha256Hex(action, 32),
    });
  }

  /** Record a decision that did not happen, with its reason. Never silently. */
  function recordDegraded({ sessionId, channel, reason, kind = ROW.degraded, transport }) {
    sessionStats(sessionId).degraded += 1;
    return append({ kind, session: sessionStats(sessionId).key, channel, reasonHash: sha256Hex(reason, 32), transport: transportMetadata(transport) });
  }

  return {
    append,
    recordDecision,
    recordGate,
    recordDegraded,
    sessionStats,
    flush: () => writeChain,
    file: () => file,
  };
}

