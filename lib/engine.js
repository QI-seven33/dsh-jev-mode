// dsh-jev-mode / lib/engine.js
//
// Transport hardening for decision calls: a circuit breaker, a FIFO concurrency
// limiter, a hashed verdict cache, retry classification, per-call-site
// timeouts, and token budgets. Plus the two engines themselves — the host's own
// LLM route, and an optional HTTP decision endpoint (TypeSafe `systemone`, or
// OpenRouter's decisions endpoint, which share one wire shape).
//
// Everything here is copied in spirit from what the JEV plugin ecosystem
// learned by shipping: a non-retryable status must not be retried, a down
// endpoint must not cost the full timeout on every call, a verdict cache key
// must include the thresholds and the wording fingerprint or a threshold change
// replays decisions made under the old rules, and an upstream error body must
// never be forwarded because it can carry credentials.

import { deadlineSignal, nowMs, redact, sha256Hex } from './util.js';
import { CHANNELS, DECISION_RUBRIC, parseAnswers, buildRequestText, normalizeAnswer, truncateState } from './channels.js';

// ---------------------------------------------------------------------------
// Resilience primitives
// ---------------------------------------------------------------------------

/**
 * Consecutive-failure circuit breaker.
 *
 * `openedAt` is `null` and not `0`: an injectable clock legitimately starts at
 * zero, and using zero as the "never opened" sentinel makes the breaker
 * permanently closed. The ecosystem shipped that bug once.
 */
export function createBreaker({ failures = 3, cooldownMs = 120_000, now = nowMs } = {}) {
  let consecutive = 0;
  let openedAt = null;
  let probeInFlight = false;
  return {
    /** Whether a call may proceed right now, admitting exactly one half-open probe. */
    admit() {
      if (openedAt === null) return { ok: true };
      const elapsed = now() - openedAt;
      if (elapsed < cooldownMs) return { ok: false, retryInMs: cooldownMs - elapsed };
      // Half-open: let this one through; its outcome decides.
      if (probeInFlight) return { ok: false, retryInMs: cooldownMs };
      probeInFlight = true;
      return { ok: true, probe: true };
    },
    success() {
      consecutive = 0;
      openedAt = null;
      probeInFlight = false;
    },
    failure() {
      probeInFlight = false;
      consecutive += 1;
      if (consecutive >= failures) openedAt = now();
    },
    cancel(admission) {
      // Abandoning a recovery probe must release its slot without reporting
      // success, erasing failures or restarting the cooldown.
      if (admission?.probe) probeInFlight = false;
    },
    state() {
      return { consecutive, open: openedAt !== null, openedAt };
    },
  };
}

/** FIFO semaphore. A burst of decisions must not open a burst of sockets. */
export function createLimiter(limit = 2) {
  let active = 0;
  const queue = [];
  const pump = () => {
    while (active < limit && queue.length) queue.shift()();
  };
  return async function run(task, signal) {
    signal?.throwIfAborted();
    if (active >= limit) await new Promise((resolve, reject) => {
      const start = () => {
        signal?.removeEventListener('abort', abort);
        active += 1;
        resolve();
      };
      const abort = () => {
        const index = queue.indexOf(start);
        if (index < 0) return;
        queue.splice(index, 1);
        reject(signal.reason ?? new Error('aborted'));
      };
      queue.push(start);
      signal?.addEventListener('abort', abort, { once: true });
    });
    else active += 1;
    try {
      signal?.throwIfAborted();
      return await task();
    } finally {
      active -= 1;
      pump();
    }
  };
}

/**
 * Bounded TTL cache keyed on a hash of everything a verdict depends on.
 *
 * Never used for fallback or error verdicts: a cached fallback verdict would
 * keep answering after the primary recovered.
 */
export function createResultCache({ ttlMs = 15 * 60_000, maxEntries = 500, now = nowMs } = {}) {
  const entries = new Map();
  return {
    get(key) {
      if (ttlMs <= 0 || maxEntries <= 0) return undefined;
      const hit = entries.get(key);
      if (!hit) return undefined;
      if (now() - hit.at >= ttlMs) {
        entries.delete(key);
        return undefined;
      }
      return hit.value;
    },
    set(key, value) {
      if (ttlMs <= 0 || maxEntries <= 0) return;
      entries.delete(key);
      entries.set(key, { at: now(), value });
      while (entries.size > maxEntries) entries.delete(entries.keys().next().value);
    },
    size() {
      return entries.size;
    },
  };
}

/** Only these statuses can succeed on a second attempt. */
export function isRetryableStatus(status) {
  return status === 408 || status === 409 || status === 425 || status === 429 || status === 529 || status >= 500;
}

/** Server minimum delay: delta seconds or HTTP-date (RFC 9110, section 10.2.3). */
export function retryAfterMs(header, now = nowMs()) {
  if (typeof header !== 'string' || !header.trim()) return undefined;
  const value = header.trim();
  if (/^\d+(?:\.\d+)?$/.test(value)) {
    const ms = Number(value) * 1000;
    return Number.isFinite(ms) ? ms : undefined;
  }
  // Do not let Date.parse interpret invalid numeric delays as calendar dates.
  const date = /^[A-Za-z]+[, ]/.test(value) ? Date.parse(value) : NaN;
  return Number.isFinite(date) ? Math.max(0, date - now) : undefined;
}

/** Only the local exponential backoff is capped; never shorten a server delay. */
export function backoffMs(attempt, retryAfterHeader, now = nowMs()) {
  const serverDelay = retryAfterMs(retryAfterHeader, now);
  if (serverDelay !== undefined) return serverDelay;
  return Math.min(5000, 400 * 2 ** attempt);
}

const sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    const finish = (fn, value) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      fn(value);
    };
    const abort = () => finish(reject, signal.reason ?? new Error('aborted'));
    const timer = setTimeout(() => finish(resolve), Math.min(ms, 2 ** 31 - 1));
    if (signal?.aborted) abort();
    else signal?.addEventListener('abort', abort, { once: true });
  });

// A credential service may ignore AbortSignal. Bound our wait while consuming
// any late resolution/rejection; no decision request is started after abort.
function awaitWithSignal(promise, signal) {
  if (!signal) return Promise.resolve(promise);
  return new Promise((resolve, reject) => {
    const finish = (fn, value) => { signal.removeEventListener('abort', abort); fn(value); };
    const abort = () => finish(reject, signal.reason ?? new Error('aborted'));
    Promise.resolve(promise).then(value => finish(resolve, value), error => finish(reject, error));
    if (signal.aborted) abort();
    else signal.addEventListener('abort', abort, { once: true });
  });
}

// ---------------------------------------------------------------------------
// Stream folding
// ---------------------------------------------------------------------------

/**
 * Fold a raw `ctx.llm.stream()` chunk sequence into text, usage and finish.
 *
 * `BlockAssembler` from `@deepseek-ai/dsh-llm` does this properly, but importing
 * it would reintroduce the bare-specifier dependency this plugin avoids. Only
 * three things are needed here, and the chunk protocol is small: `text-delta`
 * carries text, `usage` carries token counts, `finish` carries the terminal
 * reason. `block-end` is a fallback for a provider that sends whole blocks.
 *
 * Adapter and transport failures arrive as a *terminal* `finish` chunk with
 * `reason.kind` of `error` or `aborted`, so they must be read, not thrown.
 */
export async function foldStream(stream, signal) {
  let text = '';
  let blockEndText = '';
  let usage;
  let finish;
  for await (const chunk of stream) {
    if (signal?.aborted) throw signal.reason ?? new Error('aborted');
    switch (chunk?.type) {
      case 'text-delta':
        text += chunk.text ?? '';
        break;
      case 'block-end':
        if (chunk.block?.type === 'text' && typeof chunk.block.text === 'string') blockEndText += chunk.block.text;
        break;
      case 'usage':
        usage = chunk.usage ?? usage;
        break;
      case 'finish':
        finish = chunk.reason ?? finish;
        break;
      default:
        break;
    }
  }
  if (finish === undefined) throw new Error('decision call emitted no terminal finish');
  if (finish.kind === 'error' || finish.kind === 'aborted') {
    const code = finish.failure?.code ?? finish.kind;
    const message = finish.failure?.message ?? 'no failure detail';
    const error = new Error(`decision call ended with ${finish.kind} ${code}: ${message}`);
    error.code = code;
    error.retryable = code === 'RATE_LIMIT' || code === 'SERVER' || code === 'TRANSPORT' || code === 'TIMEOUT';
    throw error;
  }
  if (finish.kind !== 'stop') throw new Error(`decision call ended with ${finish.kind}`);
  return { text: text.length > 0 ? text : blockEndText, usage, finish };
}

// ---------------------------------------------------------------------------
// Engines
// ---------------------------------------------------------------------------

/** Recursively freeze a hand-built request, since hand-built callers own immutability. */
function deepFreeze(value) {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const item of Object.values(value)) deepFreeze(item);
  return value;
}

/**
 * The host's own LLM route.
 *
 * The route is read from the session's latest `request/header` exactly as
 * first-party auxiliary callers do, so the decision call rides whatever
 * provider, model and credential the session already uses. That is what lets
 * this plugin need no API key of its own.
 *
 * `system` is the frozen rubric — byte-identical for the life of the process —
 * and the varying request text is the trailing user message. Cache reuse of the
 * rubric is therefore structural, and `usage.cacheReadTokens` proves it.
 */
export function createModelEngine({ ctx, config }) {
  return {
    id: 'model',
    kind: 'model',
    available: () => true,
    async ask({ channel, state, instructions, criteria, signal, agent }) {
      const header = safeCall(() => agent?.session?.requestHeader?.());
      const route = {
        provider: header?.config?.provider ?? agent?.options?.provider,
        model: header?.config?.model ?? agent?.options?.model,
      };
      if (typeof route.provider !== 'string' || route.provider.length === 0) {
        throw new Error('no complete request-header route is available for a decision call');
      }
      if (typeof route.model !== 'string' || route.model.length === 0) {
        throw new Error('no complete request-header route is available for a decision call');
      }

      const requestText = buildRequestText({
        channel,
        state,
        instructions,
        criteria,
        maxStateChars: config.maxStateChars,
      });
      const options = deepFreeze({
        provider: route.provider,
        model: route.model,
        system: DECISION_RUBRIC,
        messages: [{ role: 'user', content: [{ type: 'text', text: requestText }] }],
        temperature: 0,
        maxTokens: config.maxDecisionTokens,
        // A decision is a System One judgement: reasoning tokens buy nothing
        // here and cost the latency the mode exists to save.
        ...(config.decisionReasoningEffort === 'off' ? { reasoningEffort: 'off' } : {}),
        signal,
      });

      let folded;
      try {
        folded = await foldStream(ctx.llm.stream(options), signal);
      } catch (error) {
        // A provider that does not publish an "off" effort rejects the explicit
        // value before any I/O. Retry once without it rather than lose the mode
        // on a non-DeepSeek route.
        if (error?.code !== 'UNSUPPORTED_REASONING_EFFORT') throw error;
        const { reasoningEffort, ...withoutEffort } = options;
        const relaxed = deepFreeze(withoutEffort);
        folded = await foldStream(ctx.llm.stream(relaxed), signal);
      }

      return {
        text: folded.text,
        usage: folded.usage,
        route,
        via: 'model',
      };
    },
  };
}

/**
 * A remote HTTP decision endpoint sharing the `{model, state, questions}` wire
 * shape used by TypeSafe's `systemone` API, OpenRouter's decisions endpoint, and
 * the local Jev-Style/Laya servers.
 *
 * State is redacted before dispatch: this is a third-party trust boundary, so
 * shape survives and known secrets are masked. Upstream error bodies are never
 * forwarded. Credentials are resolved per call and never retained in cooldowns.
 */
export function createHttpEngine({ id, endpoint, model, resolveKey, retries = 2, redactState = true, maxStateChars = 16000 }) {
  // Per engine instance, not process/global/account state. New calls fail fast
  // during explicit 429/503 backpressure; only an already retrying call waits.
  let cooldownUntil = 0;
  function coolingError() {
    const error = new Error(`${id}: provider cooldown; retry later`);
    error.code = 'PROVIDER_COOLDOWN';
    error.providerFailure = false;
    error.retryable = true;
    return error;
  }
  return {
    id,
    kind: 'http',
    identity: () => `${id}:${endpoint}:${model}`,
    available: () => {
      const key = resolveKey();
      const present = value => typeof value === 'string' && value.length > 0;
      return key?.then ? key.then(present) : present(key);
    },
    async ask({ channel, state, instructions, criteria, signal, deadlineAt, transport = {} }) {
      const count = (name, value = 1) => { transport[name] = (transport[name] ?? 0) + value; };
      signal?.throwIfAborted();
      if (cooldownUntil > nowMs()) { count('cooldownSkips'); throw coolingError(); }
      let key;
      try {
        // available() and ask() are separate credential lookups: both waits
        // must obey the same deadline, including a service that ignores abort.
        key = await awaitWithSignal(resolveKey(), signal);
      } catch {
        const error = new Error(`${id}: credential resolution failed or cancelled`);
        error.providerFailure = false;
        throw error;
      }
      signal?.throwIfAborted();
      if (typeof key !== 'string' || key.length === 0) {
        const error = new Error(`${id}: no API key is configured`);
        error.providerFailure = false;
        throw error;
      }
      const spec = CHANNELS[channel];
      const question = pruneUndefined({
        type: spec?.primitive,
        instructions: instructions ?? spec?.instructions,
        criteria: criteria ?? (spec?.criteria === null ? undefined : spec?.criteria),
      });
      const body = {
        model,
        state: truncateState(redactState ? redact(typeof state === 'string' ? state : JSON.stringify(state), Number.MAX_SAFE_INTEGER) : state, maxStateChars),
        questions: { [channel]: question },
      };
      async function waitForRetry(delay, error) {
        signal?.throwIfAborted();
        if (Number.isFinite(deadlineAt) && nowMs() + delay >= deadlineAt) {
          count('retryBudgetSkips');
          error.code = 'RETRY_BUDGET';
          throw error;
        }
        const started = nowMs();
        try { await sleep(delay, signal); }
        finally { count('retryWaitMs', nowMs() - started); }
      }
      let lastError;
      for (let attempt = 0; attempt <= retries; attempt += 1) {
        signal?.throwIfAborted();
        // Recheck after credential and retry waits: another in-flight response
        // may have extended the shared server minimum in the meantime.
        while (cooldownUntil > nowMs()) {
          if (attempt === 0) { count('cooldownSkips'); throw coolingError(); }
          await waitForRetry(cooldownUntil - nowMs(), lastError ?? coolingError());
        }
        signal?.throwIfAborted();
        let response;
        try {
          count('httpRequests');
          if (attempt > 0) count('retries');
          response = await fetch(endpoint, {
            method: 'POST',
            // A redirect could carry the Authorization header somewhere else.
            redirect: 'error',
            headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
            body: JSON.stringify(body),
            signal,
          });
        } catch (error) {
          if (signal?.aborted) throw signal.reason ?? new Error('aborted');
          lastError = new Error(`${id}: transport failure: ${scrub(String(error?.message ?? error), key)}`);
          if (attempt < retries) {
            await waitForRetry(Math.ceil(backoffMs(attempt) * (0.75 + Math.random() * 0.25)), lastError);
            continue;
          }
          throw lastError;
        }
        if (!response.ok) {
          await response.body?.cancel().catch(() => {});
          const error = new Error(`${id}: HTTP ${response.status}`);
          error.status = response.status;
          error.retryable = isRetryableStatus(response.status);
          lastError = error;
          const retryMs = response.headers.get('retry-after-ms');
          const serverDelay = retryMs?.trim() && /^\d+(?:\.\d+)?$/.test(retryMs.trim()) && Number.isFinite(Number(retryMs))
            ? Number(retryMs) : retryAfterMs(response.headers.get('retry-after'));
          if ((response.status === 429 || response.status === 503) && serverDelay !== undefined) {
            cooldownUntil = Math.max(cooldownUntil, nowMs() + serverDelay);
          }
          if (!error.retryable || attempt >= retries) throw error;
          await waitForRetry(serverDelay ?? Math.ceil(backoffMs(attempt) * (0.75 + Math.random() * 0.25)), error);
          continue;
        }
        const payload = await response.json().catch(() => undefined);
        if (payload === null || typeof payload !== 'object' || payload.answers === undefined) {
          throw new Error(`${id}: response carried no answers object`);
        }
        return { text: JSON.stringify(payload), answers: payload.answers, usage: payload.usage, via: id };
      }
      throw lastError ?? new Error(`${id}: decision failed`);
    },
  };
}

function pruneUndefined(object) {
  const out = {};
  for (const [key, value] of Object.entries(object)) if (value !== undefined) out[key] = value;
  return out;
}

/** Remove the credential from any text this plugin could surface. */
function scrub(text, key) {
  if (typeof key === 'string' && key.length > 0) return text.split(key).join('<redacted-key>');
  return text;
}

function safeCall(fn) {
  try {
    return fn();
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

/**
 * Build the decision pipeline shared by every call site.
 *
 * The cache key deliberately includes the channel, the rubric version, the
 * engine id, the resolved cuts and the state hash. Keying on the state alone
 * would replay verdicts computed under different thresholds — the ecosystem
 * shipped exactly that, and it looked like a false-positive storm.
 */
export function createDecisionPipeline({ config, engines, logger, rubricVersion = 1 }) {
  const breaker = createBreaker({
    failures: config.breakerFailures,
    cooldownMs: config.breakerCooldownMs,
  });
  const limiter = createLimiter(config.concurrency);
  const cache = createResultCache({ ttlMs: config.cacheTtlMs, maxEntries: config.cacheMaxEntries });
  const transportKeys = ['httpRequests', 'retries', 'retryWaitMs', 'cooldownSkips', 'retryBudgetSkips'];
  const emptyTransport = () => Object.fromEntries(transportKeys.map(key => [key, 0]));
  const stats = { calls: 0, cacheHits: 0, failures: 0, cancelled: 0, breakerSkips: 0, cacheReadTokens: 0, inputTokens: 0, outputTokens: 0, ...emptyTransport() };

  // Synchronous engines can report immediately; stored credential references
  // resolve asynchronously, per call, so rotation never requires a restart.
  let primaryId = 'unresolved';
  for (const engine of engines) {
    try {
      const available = engine.available();
      if (available?.then) { available.catch(() => {}); break; }
      if (available) { primaryId = engine.id; break; }
    } catch { break; } // Lookup failures belong to the deadline-bounded call path.
  }

  async function decide({ channel, state, instructions, criteria, signal, agent, timeoutMs, cuts, useCache = true }) {
    const started = nowMs();
    const deadlineAt = started + timeoutMs;
    const transport = emptyTransport();
    const bounded = deadlineSignal(signal, timeoutMs);
    const stateText = typeof state === 'string' ? state : JSON.stringify(state ?? null);
    let primary;
    try {
      for (const engine of engines) {
        bounded.throwIfAborted();
        if (await awaitWithSignal(engine.available(), bounded)) { primary = engine; break; }
      }
      bounded.throwIfAborted();
    } catch {
      if (signal?.aborted) {
        stats.cancelled += 1;
        return { ok: false, channel, via: 'cancelled', reason: 'Decision cancelled', ms: nowMs() - started };
      }
      stats.failures += 1;
      return { ok: false, channel, via: bounded.aborted ? 'timeout' : 'error',
        reason: bounded.aborted ? 'Decision credential resolution timed out' : 'Decision credential resolution failed', ms: nowMs() - started };
    }
    if (!primary) return { ok: false, channel, via: 'unconfigured', reason: 'No decision backend credential is configured' };
    primaryId = primary.id;
    // Never replay approvals. Advisory decisions cache the complete input,
    // question, route and session scope, including all state tail bytes.
    const cacheable = useCache && channel !== 'authorize';
    const key = sha256Hex(
      JSON.stringify([channel, rubricVersion, DECISION_RUBRIC, primary.identity?.() ?? primary.id,
        agent?.session?.id ?? null, safeCall(() => agent?.session?.requestHeader?.()?.config) ??
          { provider: agent?.options?.provider, model: agent?.options?.model },
        instructions ?? CHANNELS[channel]?.instructions, criteria ?? CHANNELS[channel]?.criteria,
        cuts ?? null, stateText]),
      32,
    );
    if (cacheable) {
      const hit = cache.get(key);
      if (hit) {
        stats.cacheHits += 1;
        return { ...hit, cached: true, usage: {}, cacheRead: 0, ms: 0, transport };
      }
    }

    const admission = breaker.admit();
    if (!admission.ok) {
      stats.breakerSkips += 1;
      return {
        ok: false,
        channel,
        reason: `decision backend is in cooldown for another ${Math.ceil(admission.retryInMs / 1000)}s`,
        via: 'breaker',
      };
    }

    stats.calls += 1;
    let providerStarted = false;
    try {
      const result = await limiter(() => {
        bounded.throwIfAborted();
        providerStarted = true;
        return primary.ask({
          channel,
          state: stateText,
          instructions,
          criteria,
          signal: bounded,
          agent,
          deadlineAt,
          transport,
        });
      },
        bounded,
      );
      bounded.throwIfAborted();
      const usage = result.usage ?? {};
      stats.inputTokens += Number(usage.input_tokens ?? usage.inputTokens ?? 0) || 0;
      stats.outputTokens += Number(usage.output_tokens ?? usage.outputTokens ?? 0) || 0;
      const cacheRead = Number(usage.cache_read_input_tokens ?? usage.cacheReadTokens ?? 0) || 0;
      stats.cacheReadTokens += cacheRead;

      const answers = result.answers ?? parseAnswers(result.text, [channel]).answers;
      const normalized = normalizeAnswer(channel, answers?.[channel]);
      if (!normalized.ok) throw new Error(`unusable ${channel} answer`);
      breaker.success();
      const value = { ok: true, channel, answers, via: consequenceOf(result, cacheRead), usage, cacheRead, ms: nowMs() - started, cached: false, transport };
      if (cacheable) cache.set(key, value);
      return value;
    } catch (error) {
      if (signal?.aborted) {
        breaker.cancel(admission);
        stats.cancelled += 1;
        return { ok: false, channel, via: 'cancelled', reason: 'Decision cancelled', ms: nowMs() - started, transport };
      }
      // Queue expiry did not contact the provider and says nothing about its
      // health. Provider timeouts and malformed answers still count as failures.
      if (providerStarted && error?.providerFailure !== false) breaker.failure();
      else breaker.cancel(admission);
      stats.failures += 1;
      logger?.warn?.('dsh-jev-mode: decision on %s failed: %s', channel, String(error?.message ?? error));
      return {
        ok: false,
        channel,
        reason: String(error?.message ?? error),
        retryable: error?.retryable === true,
        via: error?.code === 'PROVIDER_COOLDOWN' ? 'cooldown' : error?.code === 'RETRY_BUDGET' ? 'retry-budget' : 'error',
        ms: nowMs() - started,
        transport,
      };
    } finally {
      for (const key of transportKeys) stats[key] += transport[key];
    }
  }

  return { decide, stats, breaker, cache, get primaryId() { return primaryId; } };
}

function consequenceOf(result, cacheRead) {
  if (result.via === 'cache') return 'cache';
  return cacheRead > 0 ? `${result.via}+cache` : result.via;
}

export { DECISION_RUBRIC, parseAnswers };
