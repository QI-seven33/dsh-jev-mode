// dsh-jev-mode / lib/util.js
//
// Dependency-free helpers: hashing, shape-preserving redaction, defensive config
// normalization, and an abort-signal deadline.
//
// Deliberately imports nothing but Node builtins. A profile-installed bundle
// cannot resolve `@deepseek-ai/*` bare specifiers (the profile's node_modules
// links point into the app archive), and a published plugin that pins those
// packages couples itself to a harness version. Everything this plugin needs
// from the host is reached through a Service key on `ctx` instead.

import { createHash } from 'node:crypto';

/** Short stable hex digest, used for session attribution and cache keys. */
export function sha256Hex(text, length = 16) {
  return createHash('sha256').update(String(text)).digest('hex').slice(0, length);
}

/** Local-time day stamp `YYYY-MM-DD` for the ledger filename. */
export function dayStamp(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** Clamp a possibly-garbage number into a finite range, else return the default. */
export function num(value, min, max, fallback) {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/** A finite boolean with a default; anything non-boolean falls back. */
export function bool(value, fallback) {
  return typeof value === 'boolean' ? value : fallback;
}

/** A non-empty string with a default. */
export function str(value, fallback) {
  return typeof value === 'string' && value.length > 0 ? value : fallback;
}

/**
 * Unwrap a schemastery `.volatile()` field.
 *
 * A composition that declares `z.string().volatile()` hands the plugin
 * `{ get(), [Symbol(cosmokit.volatile.write)] }` instead of the string. The
 * community's `dsh-jev-verify` lost a whole release to this: `enabled === false`
 * was never true, so the guard was silently unarmed. This plugin declares no
 * Config schema, so it normalizes every value itself — but a profile patch can
 * still supply a volatile-shaped value through `!!js`, so unwrap defensively.
 */
export function unwrapField(value) {
  if (value === null || typeof value !== 'object') return value;
  const writer = Symbol.for('cosmokit.volatile.write');
  if (typeof value.get === 'function' && (writer in value || 'get' in value)) {
    try {
      return value.get();
    } catch {
      return undefined;
    }
  }
  return value;
}

/** Recursively unwrap volatile fields through plain objects and arrays (depth-capped). */
export function unwrapDeep(value, depth = 0) {
  if (depth > 6) return value;
  const unwrapped = unwrapField(value);
  if (unwrapped === null || typeof unwrapped !== 'object') return unwrapped;
  if (Array.isArray(unwrapped)) return unwrapped.map((item) => unwrapDeep(item, depth + 1));
  const out = {};
  for (const [key, item] of Object.entries(unwrapped)) out[key] = unwrapDeep(item, depth + 1);
  return out;
}

// ---------------------------------------------------------------------------
// Redaction
// ---------------------------------------------------------------------------
//
// Shape-preserving: the *shape* of a value (it is a path / an email / a token)
// survives so a decision can still reason about it, while the *value* does not
// leave the machine. This is a mitigation, not a permission: an unrecognised
// secret in free text still passes through, and this comment is the honest
// statement of that limit — the same one `dsh-jev-core` publishes about its
// own `redact()`.
//
// Applied to third-party backends and to the ledger. NOT applied to the
// session's own provider: the state handed to a DeepSeek-backed decision is
// conversation-derived material that the same provider already receives, so
// masking it would trade judgment quality for no privacy gain. The community
// measured that cost: a masked hostname scored 0.29 on an "internal
// information" axis partly because it was masked before the model saw it.

const REDACTIONS = [
  // Windows and POSIX user homes: keep the shape, drop the account name.
  [/\b([A-Za-z]:\\Users\\)[^\\\s"']+/g, '$1<user>'],
  [/\b(\/Users\/)[^/\s"']+/g, '$1<user>'],
  [/\b(\/home\/)[^/\s"']+/g, '$1<user>'],
  // Known token prefixes. The prefix is the only signal available, so these run
  // before the keyword rules below.
  [/\b(ghp_|github_pat_)[A-Za-z0-9_]{16,}/g, '<GITHUB_TOKEN>'],
  [/\b(sk-|apikey_)[A-Za-z0-9_\-]{16,}/g, '<API_KEY>'],
  [/\bAKIA[0-9A-Z]{16}\b/g, '<AWS_ACCESS_KEY_ID>'],
  [/\bASIA[0-9A-Z]{16}\b/g, '<AWS_SESSION_KEY_ID>'],
  [/\bglpat-[A-Za-z0-9_\-]{16,}/g, '<GITLAB_TOKEN>'],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, '<SLACK_TOKEN>'],
  [/\bnpm_[A-Za-z0-9]{30,}/g, '<NPM_TOKEN>'],
  [/\beyJ[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}/g, '<JWT>'],
  [/(\bBearer\s+)[A-Za-z0-9\-._~+/]{16,}=*/gi, '$1<TOKEN>'],
  // Keyword-assigned values. This is what a shell command actually looks like
  // when it carries a secret: `export TOKEN=...`, `--password=...`,
  // `aws_secret_access_key = ...`. The keyword is what makes the value a secret,
  // since nothing about the value's own shape says so.
  [
    /\b([A-Za-z0-9_.-]*(?:api[_-]?key|secret|token|passwd|password|passphrase|credential|private[_-]?key|access[_-]?key)[A-Za-z0-9_.-]*\s*[=:]\s*)(["']?)([^\s"',;]{8,})\2/gi,
    '$1$2<SECRET>$2',
  ],
  [/(--(?:password|passwd|token|secret|api-key)[= ])(["']?)([^\s"',;]{8,})\2/gi, '$1$2<SECRET>$2'],
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '<EMAIL>'],
  [/\b(?:10\.\d{1,3}|192\.168|172\.(?:1[6-9]|2\d|3[01]))\.\d{1,3}\.\d{1,3}\b/g, '<private-ip>'],
  [/\b[a-z0-9][a-z0-9.-]*\.(?:internal|intranet|corp|lan|local)\b/gi, '<internal-host>'],
];

/**
 * Rules applied ONLY where text is persisted locally (the ledger).
 *
 * `redact` is tuned for a request whose recipient already holds the conversation,
 * so it stays conservative. Anything written to disk has no such excuse, and the
 * ledger is the one place this plugin keeps raw command text at rest. These rules
 * are strictly additional: every `redact` masking still happens, and a value that
 * merely *looks* like a bare secret-shaped blob is now masked too.
 *
 * Residual limit, stated rather than implied: an unrecognised secret split across
 * separately-quoted fragments (`'apikey_' + '<40 hex>'`) is not caught by shape.
 * No pattern can catch that; the guard against it is not putting secrets in
 * command text, and `ledger: false` if a project must not have the file at all.
 */
const LEDGER_REDACTIONS = [
  // A bare long hex run: an AWS secret access key, a webhook HMAC, a session
  // token. Scoped to the ledger because free text in a model prompt may
  // legitimately contain a 32-hex digest and masking it would cost judgment.
  [/\b[0-9a-f]{32,}\b/gi, '<HEX_SECRET>'],
  // `KEY=...` for any uppercase-ish name, which covers the shell idiom that the
  // keyword list above misses (`DATABASE_URL=`, `STRIPE_SK=`, `NPM_TOKEN=`).
  [/\b([A-Z][A-Z0-9_]{5,}\s*=\s*)(["']?)([^\s"',;]{8,})\2/g, '$1$2<SECRET>$2'],
];

/** Apply a rule set, ignoring a malformed pattern rather than failing a decision. */
function applyRules(text, rules) {
  let out = String(text ?? '');
  for (const [pattern, replacement] of rules) {
    try {
      out = out.replace(pattern, replacement);
    } catch {
      // A malformed pattern must never break a decision.
    }
  }
  return out.replace(/\s+/g, ' ').trim();
}

/** Clamp to `limit`, marking the cut so a reader knows the text is partial. */
function clamp(text, limit) {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit - 1)}…`;
}

/** Redact well-known secret and identity shapes, then clamp the length. */
export function redact(text, limit = 160) {
  return clamp(applyRules(text, REDACTIONS), limit);
}

/**
 * Redaction for text this plugin writes to disk. Strictly stronger than `redact`:
 * the persistence-only rules run first, then the standard ones, then a single
 * clamp. Ordering matters — masking before truncating means a cut can never split
 * a secret and leave its head in the file.
 *
 * Used by the ledger for every field that can carry command text.
 */
export function redactLedger(text, limit = 120) {
  return clamp(applyRules(applyRules(text, LEDGER_REDACTIONS), REDACTIONS), limit);
}

// ---------------------------------------------------------------------------
// Deadlines
// ---------------------------------------------------------------------------

/**
 * Combine an upstream signal with a timeout.
 *
 * `@deepseek-ai/dsh-timeout` owns the canonical helper, but importing it would
 * reintroduce the bare-specifier problem this plugin exists to avoid. The
 * DeepSeek adapter's own idle timeout (default 300 s) is far too long for a
 * decision on the critical path, so every engine call is bounded here.
 */
export function deadlineSignal(parent, timeoutMs) {
  const timeout = AbortSignal.timeout(Math.max(1, Math.floor(timeoutMs)));
  if (!parent) return timeout;
  if (typeof AbortSignal.any === 'function') return AbortSignal.any([parent, timeout]);
  // Fallback for a runtime without AbortSignal.any: a controller that follows both.
  const controller = new AbortController();
  const abort = (signal) => () => controller.abort(signal.reason);
  if (parent.aborted) controller.abort(parent.reason);
  else parent.addEventListener('abort', abort(parent), { once: true });
  timeout.addEventListener('abort', abort(timeout), { once: true });
  return controller.signal;
}

/** `Date.now()` deltas as a whole-millisecond integer. */
export function nowMs() {
  return Date.now();
}

/** Safe `JSON.parse` that reports instead of throwing. */
export function tryJson(text) {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (error) {
    return { ok: false, error };
  }
}

/**
 * Drop `undefined` entries from a plain object.
 *
 * A tool result is validated against the tool's `output.schema` with
 * `additionalProperties: false`, and an own property whose value is `undefined`
 * is still a property: it fails the type check rather than being ignored. Every
 * tool result this plugin returns goes through here, because the live
 * consequence of getting it wrong is that the call errors instead of answering.
 */
export function compact(object) {
  const out = {};
  for (const [key, value] of Object.entries(object)) {
    if (value !== undefined) out[key] = value;
  }
  return out;
}
