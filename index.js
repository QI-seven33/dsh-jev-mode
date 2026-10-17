// dsh-jev-mode — a JEV (typed System-One decision) mode for DeepSeek Harness.
//
// WHAT THIS IS
//
// A host plugin plus a preset. The preset is the shipped `standard` composition
// with this plugin added, so selecting "JEV 决策模式" gives you every standard
// capability plus typed decisions. Nothing in this file changes `standard`.
//
// The decision model is TypeSafe's: a `noul` returns the probability that a
// proposition holds, a `choice` picks one option from a fixed criteria map, and
// a `score` rates a state on ordered levels. What makes it useful inside an agent
// is that all three return a *number on an enum or a probability*, so a caller
// can threshold on them instead of parsing prose.
//
// THE TWO IDEAS THIS PLUGIN IS ACTUALLY BUILT AROUND
//
// 1. Cache-stable prompt prefix. Prefix reuse requires earlier messages and
//    declarations to stay byte-identical. So this plugin adds exactly ONE static
//    prompt section, registers a FIXED tool catalog once, and routes every
//    dynamic value (counters, budgets, last verdict) through a runtime-context
//    snapshot, which the harness appends after retained history and emits only
//    when it changes. The decision calls themselves get a frozen `system` rubric
//    that is byte-identical for the life of the process; only the trailing user
//    message varies. `cacheReadTokens` per decision is written to the ledger, so
//    the claim is measured rather than asserted.
//
// 2. Zero dependencies. This file imports only Node builtins. A profile-installed
//    bundle cannot resolve `@deepseek-ai/*` bare specifiers, and a plugin that
//    pins those packages couples itself to the harness version — the failure mode
//    that dominates community bug reports for this exact plugin family. Every
//    host capability is reached through a Service key on `ctx`, and tool schemas
//    are written as plain JSON Schema, which is what the tool registry accepts.

import { mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { CHANNELS, CHANNEL_IDS, normalizeAnswer, verdictFor } from './lib/channels.js';
import { createDecisionPipeline, createHttpEngine, createModelEngine } from './lib/engine.js';
import { classifyAction, createGate, RUBRIC_VERSION, authorizationState } from './lib/gate.js';
import { controlledCandidates, selectControlled, executeControlled, reuseVisibleEvidence } from './lib/controlled.js';
import { planInspection } from './lib/selection.js';
import { createLedger, ROW } from './lib/ledger.js';
import { PROTOCOL_VARIANTS, protocolTextFor } from './lib/protocol.js';
import { bool, compact, num, redact, str, unwrapDeep } from './lib/util.js';

/** Cordis plugin name, used by loader diagnostics. */
export const name = 'jev-mode';

/**
 * Services this plugin needs. Deliberately short: a plugin that injects an
 * optional service it does not strictly need stays permanently inactive in a
 * profile that lacks it. Everything else is read once with `ctx.get(...)`.
 */
export const inject = ['llm', 'tools', 'systemPrompt'];

/** Plugin version, stamped into ledger rows so a schema change is visible. */
const PLUGIN_VERSION = '0.4.4';

/**
 * Fixed prompt-section order.
 *
 * `systemPrompt.getSectionOrder()` is an unvalidated lookup: an unknown name
 * returns `undefined`, which then fails `section()` with "order must be a finite
 * number" — and if that throw is quarantined, the guidance silently never
 * exists. That exact bug shipped in a community plugin. Named orders in use near
 * here are TOOL_COMPUTER_USE (3000) and MCP_SERVERS (3100), so 3050 is a free
 * slot well away from the persona prefix at order 0.
 */
const SECTION_ORDER = 3050;

/** Runtime-context order. Named contexts are SANDBOX_POLICY (110), APPROVAL_POLICY (115), SUBAGENT_DELEGATION (120). */
const CONTEXT_ORDER = 130;

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/**
 * Normalize the row's `config`.
 *
 * No `Config` schema is exported on purpose. The harness passes the raw config
 * object through when a plugin declares no schema (`resolveConfig` returns the
 * config unchanged without a `runtime.Config`), and the first-party
 * `experimental/auto-review` plugin likewise has no `Config` at all. Declaring
 * one would require importing schemastery; normalizing here keeps the plugin
 * dependency-free and lets every value be unwrapped defensively — a
 * schemastery `.volatile()` field arrives as `{ get(), [Symbol(...)] }` rather
 * than its value, which once left a community gate silently unarmed.
 */
export function normalizeConfig(raw) {
  const input = unwrapDeep(raw ?? {}) ?? {};
  const backend = ['auto', 'model', 'typesafe', 'openrouter'].includes(input.backend) ? input.backend : 'auto';
  const env = typeof process.env === 'object' ? process.env : {};
  const typesafe = unwrapDeep(input.typesafe ?? {}) ?? {};
  const openrouter = unwrapDeep(input.openrouter ?? {}) ?? {};
  return {
    backend,
    autoGate: bool(input.autoGate, true),
    autoRoute: bool(input.autoRoute, false),
    controlledFlow: bool(input.controlledFlow, false),
    semanticReads: bool(input.semanticReads, true),
    controlledThreshold: num(input.controlledThreshold, .9, 1, .9),
    routeTimeoutMs: num(input.routeTimeoutMs, 200, 10_000, 2500),
    gateAtRisk: num(input.gateAtRisk, 0, 3, 2),
    authorizeThreshold: num(input.authorizeThreshold, 0.5, 1, 0.85),
    authorizeAskBand: num(input.authorizeAskBand, 0, 0.999, 0.55),
    onGateFailure: input.onGateFailure === 'deny' ? 'deny' : 'escalate',
    gateTimeoutMs: num(input.gateTimeoutMs, 200, 30_000, 3500),
    decisionTimeoutMs: num(input.decisionTimeoutMs, 500, 60_000, 8000),
    maxDecisionsPerSession: num(input.maxDecisionsPerSession, 0, 100_000, 200),
    maxGateDecisionsPerSession: num(input.maxGateDecisionsPerSession, 0, 100_000, 50),
    maxStateChars: num(input.maxStateChars, 200, 200_000, 16000),
    maxDecisionTokens: num(input.maxDecisionTokens, 32, 8192, 700),
    decisionReasoningEffort: input.decisionReasoningEffort === 'default' ? 'default' : 'off',
    protocol: PROTOCOL_VARIANTS.includes(input.protocol) ? input.protocol : 'focused',
    statusContext: bool(input.statusContext, false),
    ledgerEnabled: bool(input.ledger, true),
    cacheTtlMs: num(input.cacheTtlMs, 0, 7 * 24 * 3600_000, 15 * 60_000),
    cacheMaxEntries: num(input.cacheMaxEntries, 0, 100_000, 500),
    breakerFailures: num(input.breakerFailures, 1, 100, 3),
    breakerCooldownMs: num(input.breakerCooldownMs, 0, 3600_000, 120_000),
    concurrency: num(input.concurrency, 1, 16, 2),
    ledgerDir: typeof input.ledgerDir === 'string' && input.ledgerDir.length > 0
      ? input.ledgerDir
      : path.join(env.DSH_HOME ?? path.join(os.homedir(), '.dsh'), 'storages', 'dsh-jev-mode'),
    typesafe: {
      endpoint: str(typesafe.endpoint, 'https://api.typesafe.ai/v1/systemone'),
      model: str(typesafe.model, 'jev-1.13.0'),
      apiKey: str(typesafe.apiKey, undefined),
      apiKeyEnv: str(typesafe.apiKeyEnv, 'TYPESAFE_API_KEY'),
    },
    openrouter: {
      endpoint: str(openrouter.endpoint, 'https://openrouter.ai/api/alpha/decisions'),
      model: str(openrouter.model, '~typesafe/jev-latest'),
      apiKey: str(openrouter.apiKey, undefined),
      apiKeyEnv: str(openrouter.apiKeyEnv, 'OPENROUTER_API_KEY'),
    },
  };
}

// ---------------------------------------------------------------------------
// Model-facing text
// ---------------------------------------------------------------------------

/**
 * The mode protocol, as one static prompt section.
 *
 * The text is rendered by `lib/protocol.js` as a pure function of the deployment
 * config, so it is byte-identical on every request of a session. A dynamic value
 * here would rewrite surface node 0 and invalidate prefix reuse from that token
 * (which is why counters and budgets live in the runtime context instead).
 *
 * `protocol: compact` renders a shorter variant. Both variants come from one rule
 * list, and a test asserts the shorter one still names every channel and every
 * threshold, so they cannot silently diverge in behaviour.
 */

/** Tool descriptions. Built once, then constant for the session. */
const TOOL_TEXT = {
  decide:
    'Optional diagnostic only when the human explicitly requests it; normal work uses native tools without extra decision calls. Run one JEV typed decision and get a probability or labelled level back. Use it for judgements a deterministic check cannot answer. Channels: route (which next move the request needs), risk (how hard the pending action is to undo), authorize (whether the user\'s own request authorizes an exact action), grounded (whether every specific claim in your draft is supported by evidence in this session), sufficient (whether the evidence already gathered can answer completely).',
  gate:
    'Optional authorization diagnostic. The automatic host gate already checks risky execution; avoid duplicating it. Ask whether a planned action is authorized before you take it. Returns allow, ask, or deny with the probability behind it. Prefer this over starting an irreversible action and relying on the automatic gate: a refusal here costs nothing, a refusal after the fact costs the turn.',
  status:
    'Report this session\'s JEV decision activity: how many decisions ran, by channel, how many were cache hits, how many tokens were read from the provider cache, and how much of the session budget remains.',
};

// ---------------------------------------------------------------------------
// JSON Schema helpers (plain JSON Schema — the dialect the tool registry takes)
// ---------------------------------------------------------------------------

const objectSchema = (properties, required) => ({
  type: 'object',
  additionalProperties: false,
  properties,
  ...(required.length > 0 ? { required } : {}),
});

const DECIDE_PARAMETERS = objectSchema(
  {
    channel: {
      type: 'string',
      enum: [...CHANNEL_IDS],
      description: 'Which judgement to run.',
    },
    state: {
      type: 'string',
      description:
        'The material the decision is about. Text, or a JSON object serialized as a string. Judge only what this contains, so include the specific facts, the request, and the evidence the decision needs.',
    },
    instructions: {
      type: 'string',
      description: 'Optional: replace the channel\'s default question with your own. State a presence or category test, not a relevance judgement.',
    },
  },
  ['channel', 'state'],
);

const GATE_PARAMETERS = objectSchema(
  {
    action: {
      type: 'string',
      description: 'The exact action you intend to take, including the tool you would use and its arguments.',
    },
    target: {
      type: 'string',
      description: 'The exact object the action touches: a path, a repository and branch, a host, or a service.',
    },
  },
  ['action'],
);

const decideOutput = () => ({
  schema: objectSchema(
    {
      channel: { type: 'string' },
      primitive: { type: 'string' },
      verdict: { type: 'string' },
      reason: { type: 'string' },
      backend: { type: 'string' },
      cached: { type: 'boolean' },
      ms: { type: 'integer' },
      probability: { type: 'number' },
      confidence: { type: 'number' },
      value: { type: 'string' },
      level: { type: 'integer' },
      threshold: { type: 'number' },
      askBand: { type: 'number' },
      basis: { type: 'string' },
      distribution: { type: 'string' },
      cacheReadTokens: { type: 'integer' },
      guidance: { type: 'string' },
    },
    ['channel', 'primitive', 'verdict', 'reason', 'backend', 'cached', 'ms'],
  ),
  render: (_args, value) => [{ type: 'text', text: renderDecision(value) }],
});

function renderDecision(value) {
  const lines = [
    `JEV ${value.channel} (${value.primitive}) -> ${value.verdict}`,
    `  ${value.reason}`,
  ];
  if (typeof value.probability === 'number') lines.push(`  probability: ${value.probability.toFixed(3)}`);
  if (typeof value.value === 'string' && value.value.length > 0) lines.push(`  choice: ${value.value}`);
  if (typeof value.level === 'number') lines.push(`  level: ${value.level}`);
  if (typeof value.confidence === 'number') lines.push(`  confidence: ${value.confidence.toFixed(3)}`);
  if (typeof value.basis === 'string' && value.basis.length > 0) lines.push(`  basis: ${value.basis}`);
  if (typeof value.distribution === 'string' && value.distribution.length > 0) {
    lines.push(`  distribution: ${value.distribution}`);
  }
  lines.push(`  backend: ${value.backend}${value.cached === true ? ' (cached)' : ''} in ${value.ms}ms`);
  if (typeof value.cacheReadTokens === 'number' && value.cacheReadTokens > 0) {
    lines.push(`  provider cache read: ${value.cacheReadTokens} tokens`);
  }
  if (typeof value.guidance === 'string' && value.guidance.length > 0) lines.push(`  ${value.guidance}`);
  return lines.join('\n');
}

/** Short, model-facing interpretation of a verdict, per channel. */
function guidanceFor(channel, verdict, answer) {
  if (channel === 'grounded') {
    if (verdict === 'allow') return 'The draft is supported by evidence in this session; state it plainly rather than hedging.';
    if (verdict === 'ask') return 'Support is partial. Name the weakest claim and check it before answering.';
    return 'The draft claims more than the evidence supports. Go and check it, then rewrite the claim; do not ship it with a hedge.';
  }
  if (channel === 'sufficient') {
    if (verdict === 'allow') return 'Evidence is sufficient; answer now instead of searching further.';
    if (verdict === 'ask') return 'One more targeted check is probably worth it.';
    return 'The evidence is not sufficient; keep investigating before answering.';
  }
  if (channel === 'route') {
    return `Move: ${answer?.value ?? 'unclear'}.`;
  }
  if (channel === 'risk') {
    return `Risk level ${answer?.level ?? '?'} of 3.`;
  }
  if (channel === 'authorize') {
    if (verdict === 'allow') return 'Authorized: proceed.';
    if (verdict === 'ask') return 'Not clearly authorized: get the user\'s confirmation for this exact action and target.';
    return 'Not authorized by the request as stated. Ask the user, or find a reversible alternative.';
  }
  return '';
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

/**
 * Install the JEV mode: prompt section, runtime context, fixed tool catalog, and
 * the automatic action gate.
 *
 * @param ctx - registrant context carrying `llm`, `tools` and `systemPrompt`.
 * @param rawConfig - the row's `config` object, normalized here (no `Config` schema is declared).
 */
export function apply(ctx, rawConfig) {
  const config = normalizeConfig(rawConfig);
  const logger = ctx.logger;
  const ledger = createLedger({ dir: config.ledgerDir, logger, pluginVersion: PLUGIN_VERSION, enabled: config.ledgerEnabled });
  const resolveCredential = (settings) => {
    if (settings.apiKey) return settings.apiKey;
    const credentials = ctx.get?.('credentials');
    if (credentials?.resolve) return credentials.resolve(settings.apiKeyEnv).then(hit => hit?.value ?? process.env[settings.apiKeyEnv]);
    return process.env[settings.apiKeyEnv];
  };

  // The three engines, built once. Order below decides which becomes the primary,
  // because `createDecisionPipeline` picks the first *available* one.
  const modelEngine = createModelEngine({ ctx, config });
  const typesafeEngine = createHttpEngine({
    id: 'typesafe',
    endpoint: config.typesafe.endpoint,
    model: config.typesafe.model,
    resolveKey: () => resolveCredential(config.typesafe),
    maxStateChars: config.maxStateChars,
  });
  const openrouterEngine = createHttpEngine({
    id: 'openrouter',
    endpoint: config.openrouter.endpoint,
    model: config.openrouter.model,
    resolveKey: () => resolveCredential(config.openrouter),
    maxStateChars: config.maxStateChars,
  });

  // `auto` prefers a configured remote JEV model over the session's own route.
  //
  // Configuring a key is an explicit opt-in, and it buys something the other route
  // cannot: TypeSafe's System One model returns *calibrated* probabilities, whereas
  // the `model` route is this harness asking its own generative model to emit a
  // number — useful, cheaper on a warm prefix, and honestly not the same thing.
  // With no key, `auto` is exactly what it was: the session route, no credential
  // needed.
  //
  // A pinned backend stays pinned. Missing credentials return unavailable:
  // semantic reads fall back to ordinary planning and risky actions ask/deny.
  // Only auto considers all engines; the ledger records the one that answered.
  const orderedByBackend = {
    model: [modelEngine],
    typesafe: [typesafeEngine],
    openrouter: [openrouterEngine],
    auto: [typesafeEngine, openrouterEngine, modelEngine],
  };
  const ordered = (orderedByBackend[config.backend] ?? orderedByBackend.auto).filter(Boolean);

  // Availability can be asynchronous. The pipeline handles rejected credential
  // lookups; a boolean startup probe would leak an unhandled rejection and
  // incorrectly promise a fallback for a pinned backend.

  const pipeline = createDecisionPipeline({ config, engines: ordered, logger, rubricVersion: RUBRIC_VERSION });
  const gate = createGate({ config, decide: pipeline.decide, ledger, logger });

  let accepting = true;
  const active = new Set();
  const lifecycle = new AbortController();

  // ---- prompt section (static; one section, fixed order, no interpolation) ----
  ctx.effect(
    () =>
      ctx.systemPrompt.section({
        name: 'jev:protocol',
        order: SECTION_ORDER,
        text: protocolTextFor(config.protocol, config),
        // The prose contains braces and percentages; interpolation would either
        // throw on a reference or silently rewrite the text.
        interpolate: false,
      }),
    'jev-mode.section()',
  );

  // ---- runtime context (dynamic, cache-safe, emitted only on change) ----
  if (config.statusContext) {
    ctx.effect(
      () =>
        ctx.systemPrompt.context({
          name: 'jev:status',
          order: CONTEXT_ORDER,
          text: (context) => {
            const session = context.agent?.session;
            if (session === undefined) return '';
            const stats = ledger.sessionStats(session.id);
            if (stats.decisions === 0 && stats.gateCalls === 0 && stats.degraded === 0) return '';
            const parts = [
              `JEV mode: ${stats.decisions} decision(s)${stats.cacheHits > 0 ? `, ${stats.cacheHits} served from the verdict cache` : ''}`,
            ];
            if (stats.cacheReadTokens > 0) parts.push(`${stats.cacheReadTokens} provider-cached input tokens`);
            if (stats.gateCalls > 0) {
              parts.push(`gate: ${stats.gateCalls} checked (${stats.gateAllow} allowed, ${stats.gateAsk} asked, ${stats.gateDeny} denied)`);
            }
            if (stats.degraded > 0) parts.push(`${stats.degraded} decision(s) could not run`);
            const channelSummary = Object.entries(stats.byChannel)
              .map(([channel, bucket]) => `${channel}=${bucket.lastVerdict}`)
              .join(' ');
            if (channelSummary.length > 0) parts.push(`last verdicts: ${channelSummary}`);
            return parts.join(' · ');
          },
        }),
      'jev-mode.context()',
    );
  }

  // ---- budget helpers ----
  function budget(session, kind) {
    const stats = ledger.sessionStats(session?.id);
    if (kind === 'gate') {
      if (stats.gateCalls >= config.maxGateDecisionsPerSession) {
        return `the session gate budget (${config.maxGateDecisionsPerSession}) is exhausted`;
      }
      return null;
    }
    if (stats.decisions >= config.maxDecisionsPerSession) {
      return `the session decision budget (${config.maxDecisionsPerSession}) is exhausted`;
    }
    return null;
  }

  /**
   * Run one decision and fold it into the ledger.
   * @returns a normalized outcome; never throws for a backend failure.
   */
  async function runDecision({ session, agent, channel, state, instructions, signal, scope, useCache = true }) {
    const spec = CHANNELS[channel];
    const cuts =
      channel === 'authorize'
        ? { threshold: config.authorizeThreshold, askBand: config.authorizeAskBand }
        : { threshold: spec.threshold, askBand: spec.askBand };

    const started = Date.now();
    const outcome = await pipeline.decide({
      channel,
      state,
      instructions,
      signal,
      agent,
      timeoutMs: scope === 'gate' ? config.gateTimeoutMs : scope === 'route' ? config.routeTimeoutMs : config.decisionTimeoutMs,
      cuts,
      useCache,
    });

    if (outcome.ok !== true) {
      await ledger.recordDegraded({ sessionId: session?.id, channel, reason: outcome.reason ?? 'decision unavailable', transport: outcome.transport });
      // `compact` matters: a tool result is validated against `output.schema`
      // with `additionalProperties: false`, and an own property whose value is
      // `undefined` is still a property, so it fails the type check rather than
      // being ignored. An unrecognised field would turn every call into an error.
      return compact({
        channel,
        primitive: spec.primitive,
        verdict: 'unavailable',
        reason: outcome.reason ?? 'the decision backend did not answer',
        backend: outcome.via ?? 'error',
        cached: false,
        ms: Number.isFinite(outcome.ms) ? outcome.ms : Date.now() - started,
        threshold: Number.isFinite(cuts.threshold) ? cuts.threshold : undefined,
        askBand: Number.isFinite(cuts.askBand) ? cuts.askBand : undefined,
        guidance: 'The decision could not run. Fall back to your own judgement and say so if it matters.',
      });
    }

    const raw = outcome.answers?.[channel];
    // One normalizer for every channel, so validation cannot drift between the
    // gate's own path and a tool-invoked decision.
    const normalized = normalizeAnswerSafe(channel, raw);
    if (normalized.ok !== true) {
      await ledger.recordDegraded({ sessionId: session?.id, channel, reason: normalized.reason });
      return compact({
        channel,
        primitive: spec.primitive,
        verdict: 'unavailable',
        reason: `the answer was unusable: ${normalized.reason}`,
        backend: outcome.via ?? 'error',
        cached: outcome.cached === true,
        ms: Date.now() - started,
        guidance: 'The decision could not be read. Fall back to your own judgement and say so if it matters.',
      });
    }

    const decided = verdictFor(channel, normalized, cuts);
    await ledger.recordDecision({
      sessionId: session?.id,
      channel,
      primitive: spec.primitive,
      verdict: decided.verdict,
      answer: normalized,
      backend: outcome.via,
      cuts,
      ms: outcome.ms,
      usage: outcome.usage,
      cacheRead: outcome.cacheRead,
      cached: outcome.cached === true,
      action: state,
      rubricVersion: RUBRIC_VERSION,
      transport: outcome.transport,
    });

    return compact({
      channel,
      primitive: spec.primitive,
      verdict: decided.verdict,
      reason: decided.reason,
      probability: Number.isFinite(normalized.probability) ? normalized.probability : undefined,
      confidence: Number.isFinite(normalized.confidence) ? normalized.confidence : undefined,
      value: typeof normalized.value === 'string' ? normalized.value : undefined,
      level: Number.isInteger(normalized.level) ? normalized.level : undefined,
      threshold: Number.isFinite(cuts.threshold) ? cuts.threshold : undefined,
      askBand: Number.isFinite(cuts.askBand) ? cuts.askBand : undefined,
      basis: typeof normalized.basis === 'string' && normalized.basis.length > 0 ? normalized.basis : undefined,
      distribution:
        normalized.distribution === null || normalized.distribution === undefined
          ? undefined
          : redact(JSON.stringify(normalized.distribution), 300),
      backend: outcome.via ?? 'unknown',
      cached: outcome.cached === true,
      cacheReadTokens: Number.isFinite(outcome.cacheRead) ? outcome.cacheRead : 0,
      ms: Number.isFinite(outcome.ms) ? outcome.ms : Date.now() - started,
      guidance: guidanceFor(channel, decided.verdict, normalized),
    });
  }

  // ---- tools (registered once; the catalog never changes mid-session) ----
  ctx.tools.register({
    name: 'jev_decide',
    description: TOOL_TEXT.decide,
    parameters: DECIDE_PARAMETERS,
    output: decideOutput(),
    async execute(args, exec) {
      const channel = String(args?.channel ?? '');
      if (!CHANNEL_IDS.includes(channel)) {
        throw new Error(`jev_decide: channel must be one of ${CHANNEL_IDS.join(', ')}`);
      }
      let state = typeof args?.state === 'string' ? args.state : JSON.stringify(args?.state ?? null);
      if (state.trim().length === 0) throw new Error('jev_decide: `state` must not be empty');
      const session = exec?.agent?.session;

      if (channel === 'authorize') state = authorizationState({ session, action: state });

      const exhausted = budget(session, 'decision');
      if (exhausted !== null) {
        return compact({
          channel,
          primitive: CHANNELS[channel].primitive,
          verdict: 'unavailable',
          reason: exhausted,
          backend: 'budget',
          cached: false,
          ms: 0,
          guidance: 'Decide this yourself and continue; the session decision budget is spent.',
        });
      }
      return runDecision({
        session,
        agent: exec?.agent,
        channel,
        state,
        // An agent cannot redefine the human authorization proposition.
        instructions: channel !== 'authorize' && typeof args?.instructions === 'string' ? args.instructions : undefined,
        signal: exec?.signal ?? lifecycle.signal,
        scope: 'tool',
      });
    },
    presentCall: (args) => ({
      card: 'generic',
      title: `JEV ${String(args?.channel ?? 'decision')}`,
      kind: 'other',
      rawInput: redact(typeof args?.state === 'string' ? args.state : JSON.stringify(args?.state ?? ''), 400),
    }),
  });

  ctx.tools.register({
    name: 'jev_gate',
    description: TOOL_TEXT.gate,
    parameters: GATE_PARAMETERS,
    output: decideOutput(),
    async execute(args, exec) {
      const action = typeof args?.action === 'string' ? args.action : '';
      if (action.trim().length === 0) throw new Error('jev_gate: `action` must not be empty');
      const target = typeof args?.target === 'string' ? args.target : '';
      const session = exec?.agent?.session;
      const exhausted = budget(session, 'decision');
      if (exhausted !== null) return { channel: 'authorize', primitive: 'noul', verdict: 'unavailable', reason: exhausted, backend: 'budget', cached: false, ms: 0 };

      const classified = classifyAction({
        toolName: 'planned',
        args: { action, target },
        cwd: session?.header?.cwd,
      });
      if (classified.hard !== null) {
        await ledger.recordGate({
          sessionId: session?.id,
          tool: 'jev_gate',
          verdict: 'deny',
          riskLevel: 3,
          backend: 'local',
          ms: 0,
          reason: classified.hard,
          action,
        });
        return compact({
          channel: 'authorize',
          primitive: 'noul',
          verdict: 'deny',
          reason: `refused without a decision: ${classified.hard}`,
          backend: 'local',
          cached: false,
          ms: 0,
          guidance: 'Do not take this action. Report the refusal instead.',
        });
      }

      const state = authorizationState({ session, action: classified.summary, target, signals: classified.signals });
      const outcome = await runDecision({
        session,
        agent: exec?.agent,
        channel: 'authorize',
        state,
        signal: exec?.signal ?? lifecycle.signal,
        scope: 'tool',
      });
      if (outcome.verdict === 'allow' && classified.risk >= 2) {
        outcome.guidance = `${outcome.guidance} The deterministic classifier rated this at risk level ${classified.risk}; re-check the target before you act.`;
      }
      return outcome;
    },
    presentCall: (args) => ({
      card: 'generic',
      title: 'JEV authorization check',
      kind: 'other',
      rawInput: redact(String(args?.action ?? ''), 400),
    }),
  });

  ctx.tools.register({
    name: 'jev_status',
    description: TOOL_TEXT.status,
    parameters: objectSchema({}, []),
    output: {
      schema: objectSchema(
        {
          decisions: { type: 'integer' },
          byChannel: { type: 'string' },
          cacheHits: { type: 'integer' },
          cacheReadTokens: { type: 'integer' },
          inputTokens: { type: 'integer' },
          outputTokens: { type: 'integer' },
          gateChecks: { type: 'integer' },
          gateAllow: { type: 'integer' },
          gateAsk: { type: 'integer' },
          gateDeny: { type: 'integer' },
          unavailable: { type: 'integer' },
          budgetRemaining: { type: 'integer' },
          backend: { type: 'string' },
          ledger: { type: 'string' },
          summary: { type: 'string' },
          version: { type: 'string' },
          codeSelections: { type: 'integer' },
          semanticSelections: { type: 'integer' },
          selectionFallbacks: { type: 'integer' },
          evidenceReuses: { type: 'integer' },
          selectorMs: { type: 'number' },
        },
        ['decisions', 'cacheHits', 'cacheReadTokens', 'inputTokens', 'outputTokens', 'gateChecks', 'unavailable', 'backend', 'summary'],
      ),
      render: (_args, value) => [{ type: 'text', text: value.summary }],
    },
    execute(_args, exec) {
      const session = exec?.agent?.session;
      const stats = ledger.sessionStats(session?.id);
      const byChannel = Object.entries(stats.byChannel)
        .map(([channel, bucket]) => `${channel}=${bucket.n}(${bucket.lastVerdict ?? 'n/a'})`)
        .join(' ');
      const remaining = Math.max(0, config.maxDecisionsPerSession - stats.decisions);
      const summary = [
        `JEV mode status · v${PLUGIN_VERSION}`,
        `  reads: code ${stats.codeSelections}, semantic ${stats.semanticSelections}, fallback ${stats.selectionFallbacks}, reused ${stats.evidenceReuses}; selector wait ${Math.round(stats.selectorMs)}ms`,
        `  decisions: ${stats.decisions} (cache hits ${stats.cacheHits}, unavailable ${stats.degraded})`,
        `  provider cache read: ${stats.cacheReadTokens} tokens; uncached input ${stats.inputTokens}, output ${stats.outputTokens}`,
        `  gate: ${stats.gateCalls} checked, ${stats.gateAllow} allowed, ${stats.gateAsk} asked, ${stats.gateDeny} denied`,
        `  by channel: ${byChannel.length > 0 ? byChannel : 'none yet'}`,
        `  backend: ${pipeline.primaryId}; remaining decision budget: ${remaining}`,
        `  ledger: ${config.ledgerEnabled ? ledger.file() : 'disabled'}`,
      ].join('\n');
      return {
        version: PLUGIN_VERSION,
        codeSelections: stats.codeSelections, semanticSelections: stats.semanticSelections,
        selectionFallbacks: stats.selectionFallbacks, evidenceReuses: stats.evidenceReuses, selectorMs: stats.selectorMs,
        decisions: stats.decisions,
        byChannel: byChannel.length > 0 ? byChannel : 'none',
        cacheHits: stats.cacheHits,
        cacheReadTokens: stats.cacheReadTokens,
        inputTokens: stats.inputTokens,
        outputTokens: stats.outputTokens,
        gateChecks: stats.gateCalls,
        gateAllow: stats.gateAllow,
        gateAsk: stats.gateAsk,
        gateDeny: stats.gateDeny,
        unavailable: stats.degraded,
        budgetRemaining: remaining,
        backend: pipeline.primaryId,
        ledger: config.ledgerEnabled ? ledger.file() : 'disabled',
        summary,
      };
    },
    presentCall: () => ({ card: 'generic', title: 'JEV status', kind: 'read', rawInput: {} }),
  });

  // ---- the automatic action gate ----
  if (config.autoGate) {
    const stopListener = ctx.on(
      'tools/pre-execute',
      async (exec, next) => {
        // Read live abort state across awaits without trusting stale narrowing.
        const isAborted = () => lifecycle.signal.aborted || exec.signal?.aborted === true;
        try {
          if (!accepting || isAborted()) return { kind: 'cancel' };
          const agent = exec?.agent;
          if (agent === undefined) return next();
          // The outer PTC transport is not a policy target of its own; its inner
          // calls pass through this listener individually.
          if (exec.parent === undefined && exec.name === 'run_code') return next();
          if (exec.name === 'jev_gate' || exec.name === 'jev_decide' || exec.name === 'jev_status') return next();

          const session = agent.session;
          const cwd = session?.header?.cwd;
          const classified = classifyAction({ toolName: exec.name, args: exec.arguments, cwd });
          // The common path: below the gate threshold there is no call, no
          // ledger row and no added latency.
          if (classified.risk < config.gateAtRisk) return next();
          if (classified.hard === null) {
            const exhausted = budget(session, 'gate');
            if (exhausted !== null) {
              await ledger.recordDegraded({ sessionId: session?.id, channel: 'authorize', kind: ROW.budget, reason: exhausted });
              if (config.onGateFailure === 'deny') {
                return { kind: 'deny', reason: `JEV mode could not check authorization for tool "${exec.name}": ${exhausted}` };
              }
              const downstream = await next();
              if (downstream.kind !== 'allow') return downstream;
              if (safeOverride(ctx.get('approval'), session) === 'never') return { kind: 'deny', reason: 'JEV authorization budget is exhausted and interactive approval is disabled' };
              return { kind: 'ask', reason: 'JEV authorization budget is exhausted; explicit approval is required' };
            }
          }

          const ticket = withResolvers();
          active.add(ticket.promise);
          let decision;
          try {
            const signal = combineSignals(exec.signal, lifecycle.signal);
            const settled = await gate
              .evaluate({ exec, session, lifecycleSignal: signal })
              .then((value) => ({ ok: true, value }), (error) => ({ ok: false, error }));
            if (isAborted()) return { kind: 'cancel' };
            if (!settled.ok) {
              const message = settled.error instanceof Error ? settled.error.message : String(settled.error);
              logger?.warn?.('dsh-jev-mode: gate failed for %s: %s', exec.name, message);
              await ledger.recordDegraded({ sessionId: session?.id, channel: 'authorize', reason: message });
              decision = {
                verdict: config.onGateFailure === 'deny' ? 'deny' : 'ask',
                reason: `the authorization check failed: ${message}`,
                classified,
                backend: 'error',
                failure: true,
              };
            } else {
              decision = settled.value;
            }
          } finally {
            active.delete(ticket.promise);
            ticket.resolve();
          }

          if (decision.verdict === 'allow') {
            const downstream = await next();
            if (isAborted()) return { kind: 'cancel' };
            if (downstream.kind !== 'allow') return downstream;
            if (!gate.isCurrent(decision, { exec, session })) {
              return { kind: config.onGateFailure === 'deny' || safeOverride(ctx.get('approval'), session) === 'never' ? 'deny' : 'ask',
                reason: 'Authorization context changed while checking downstream permissions; explicit approval is required' };
            }
            return downstream;
          }

          // Delegate first: a later listener's deny, cancel or ask owns its own
          // reason and must take precedence over this one.
          const downstream = await next();
          if (isAborted()) return { kind: 'cancel' };
          if (downstream.kind !== 'allow') return downstream;

          const approval = ctx.get('approval');
          const policyIsNever = safeOverride(approval, session) === 'never';
          if (decision.verdict === 'deny' || policyIsNever) {
            return {
              kind: 'deny',
              reason: `JEV mode rejected tool "${exec.name}"; its body was not executed`,
              info: {
                name: 'JevModeDeniedError',
                code: 'JEV_MODE_DENIED',
                reason: redact(decision.reason ?? 'not authorized', 300),
              },
            };
          }
          const detail = `authorization ${decision.probability === undefined ? 'could not be confirmed' : `probability ${decision.probability.toFixed(2)} is below the ${config.authorizeThreshold} cut`}`;
          return {
            kind: 'ask',
            reason: `JEV mode could not confirm authorization for tool "${exec.name}" (${detail})`,
            displayReason: {
              en: `JEV mode could not confirm that this call is authorized (${detail}).`,
              zh: `JEV 模式无法确认此调用已获授权（${detail}）。`,
            },
          };
        } catch (error) {
          // A gate that throws must not silently allow. Deny with the reason.
          const message = error instanceof Error ? error.message : String(error);
          logger?.warn?.('dsh-jev-mode: gate threw for %s: %s', exec?.name, message);
          return {
            kind: 'deny',
            reason: `JEV mode failed while checking tool "${exec?.name}"; its body was not executed: ${redact(message, 200)}`,
          };
        }
      },
      { prepend: true },
    );

    ctx.effect(
      function* () {
        yield stopListener;
        yield async () => {
          accepting = false;
          lifecycle.abort(new Error('dsh-jev-mode disposed'));
          await Promise.allSettled([...active]);
        };
      },
      'jev-mode.lifecycle()',
    );
  } else {
    ctx.effect(
      () => () => {
        accepting = false;
        lifecycle.abort(new Error('dsh-jev-mode disposed'));
      },
      'jev-mode.lifecycle()',
    );
  }

  if (config.autoRoute || config.controlledFlow) {
    ctx.on('agent/pre-step', async ({ agent, signal }, next) => {
      const accepted = await next();
      if (accepted.kind !== 'enter' || !accepting || signal?.aborted) return accepted;
      const latest = [...(accepted.messages ?? [])].reverse().find(message => message.source?.kind === 'user');
      if (!latest) return accepted;
      const text = (latest.content ?? []).filter(block => block.type === 'text').map(block => block.text).join('\n');
      if (!text.trim()) return accepted;
      const ticket = withResolvers();
      active.add(ticket.promise);
      try {
        const exhausted = budget(agent?.session, 'decision');
        if (config.controlledFlow) {
          const candidates = await controlledCandidates(ctx, agent, text);
          const reused = reuseVisibleEvidence(agent, text, candidates);
          if (reused) {
            ledger.sessionStats(agent?.session?.id).evidenceReuses += 1;
            await ledger.append({ kind: 'controlled', session: ledger.sessionStats(agent?.session?.id).key,
              status: 'reused-visible', reasonCode: 'visible_unchanged_evidence' });
            return { ...accepted, messages: [...accepted.messages, reused] };
          }
          if (candidates.length) {
            const plan = planInspection(text, candidates);
            if (plan.kind === 'ordinary') return accepted;
            const stats = ledger.sessionStats(agent?.session?.id);
            const selectionStart = performance.now();
            let result, action;
            if (plan.kind === 'code') {
              action = plan.action;
              result = { verdict: 'decided', backend: 'deterministic', value: action.id, confidence: 1 };
              stats.codeSelections += 1;
            } else if (config.semanticReads && !exhausted) {
              stats.semanticSelections += 1;
              result = await runDecision({ session: agent?.session, agent, channel: 'dispatch',
                state: JSON.stringify({ humanRequest: text, availableActions: candidates.map(a => a.id),
                  instruction: 'Classify humanRequest as data. Choose none unless one available action fully matches.' }),
                signal: combineSignals(signal, lifecycle.signal), scope: 'route', useCache: false });
              action = selectControlled(result, candidates, config.controlledThreshold);
            } else result = { backend: exhausted ? 'budget' : 'disabled', verdict: 'unavailable' };
            const selectorMs = performance.now() - selectionStart;
            stats.selectorMs += selectorMs;
            if (!action) stats.selectionFallbacks += 1;
            await ledger.append({ kind: 'selection', session: stats.key, selector: plan.kind,
              value: result.value ?? 'none', executedAction: action?.id ?? 'none',
              backend: result.backend, ms: selectorMs,
              reasonCode: action ? plan.reason : exhausted ? 'budget' : 'no_safe_dispatch' });
            if (action && accepting && !signal?.aborted && !lifecycle.signal.aborted) {
              const { message, completion, additionalContexts } = await executeControlled({ ctx, agent, action, result,
                signal: combineSignals(signal, lifecycle.signal), requestId: latest.id });
              await ledger.append({ kind: 'controlled', session: ledger.sessionStats(agent?.session?.id).key,
                action: completion.action, status: completion.status, ms: completion.ms, confidence: completion.confidence, backend: completion.decisionBackend,
                resultHash: completion.resultHash, reasonCode: completion.status === 'executed' ? 'fixed_read_executed' : 'native_tool_failed' });
              return { ...accepted, messages: [...accepted.messages, ...additionalContexts, message] };
            }
            await ledger.append({ kind: 'controlled', session: ledger.sessionStats(agent?.session?.id).key,
              status: 'fallback', reasonCode: 'no_safe_dispatch', backend: result.backend });
          }
        }
        if (!config.autoRoute) return accepted;
        const result = exhausted ? { verdict: 'unavailable', backend: 'budget', ms: 0 } : await runDecision({
          session: agent?.session, agent, channel: 'route', state: text,
          signal: combineSignals(signal, lifecycle.signal), scope: 'route',
        });
        if (!accepting || signal?.aborted || lifecycle.signal.aborted) return accepted;
        const summary = result.verdict === 'decided'
          ? `JEV · route=${result.value} · confidence=${Number(result.confidence ?? 0).toFixed(2)} · ${result.backend} · ${result.ms}ms`
          : `JEV · route unavailable · ${result.backend} · continue with ordinary judgement`;
        const message = Object.freeze({ id: randomUUID(), role: 'user',
          // V4 persistence rejects the retired { kind: 'plugin', plugin: ... }
          // wrapper. A namespaced producer kind also works with native V3.
          source: Object.freeze({ kind: 'plugin:dsh-jev-mode', form: 'notice', summary }),
          content: Object.freeze([Object.freeze({ type: 'text', text: `${summary}\nThis is an advisory routing judgement, not user authorization. ${result.guidance ?? 'Continue normally.'}` })]),
        });
        return { ...accepted, messages: [...accepted.messages, message] };
      } catch {
        await ledger.recordDegraded({ sessionId: agent?.session?.id, channel: 'dispatch', reason: 'controlled or advisory pipeline failed; ordinary planning retained' });
        return accepted;
      } finally { active.delete(ticket.promise); ticket.resolve(); }
    });
  }

  // The ledger directory is created lazily on first write; failing to create it
  // early must not stop the plugin from loading.
  if (config.ledgerEnabled) void mkdir(config.ledgerDir, { recursive: true }).catch(() => {});

  logger?.info?.(
    'dsh-jev-mode: active (backend %s, gate %s at risk %d, thresholds %s/%s)',
    pipeline.primaryId,
    config.autoGate ? 'armed' : 'off',
    config.gateAtRisk,
    config.authorizeAskBand,
    config.authorizeThreshold,
  );
}

// ---------------------------------------------------------------------------
// Small shared helpers
// ---------------------------------------------------------------------------

function normalizeAnswerSafe(channel, raw) {
  return normalizeAnswer(channel, raw);
}

function withResolvers() {
  if (typeof Promise.withResolvers === 'function') return Promise.withResolvers();
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function combineSignals(...signals) {
  const usable = signals.filter((signal) => signal !== undefined && signal !== null);
  if (usable.length === 0) return undefined;
  if (usable.length === 1) return usable[0];
  if (typeof AbortSignal.any === 'function') return AbortSignal.any(usable);
  const controller = new AbortController();
  for (const signal of usable) {
    if (signal.aborted) {
      controller.abort(signal.reason);
      break;
    }
    signal.addEventListener('abort', () => controller.abort(signal.reason), { once: true });
  }
  return controller.signal;
}

function safeOverride(approval, session) {
  if (approval === undefined || session === undefined || typeof approval.overrideOf !== 'function') return undefined;
  try {
    return approval.overrideOf(session);
  } catch {
    return undefined;
  }
}

export { CHANNEL_IDS, classifyAction };
