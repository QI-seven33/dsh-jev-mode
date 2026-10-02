// dsh-jev-mode / test/boot.test.mjs
//
// A boot test that goes through the real contracts rather than counting things.
//
// Two shipped bugs in this plugin family motivate the shape of this file:
//  1. A tool whose parameter schema used an unsupported keyword (`minItems`)
//     threw inside `defineTool`, the per-tool quarantine swallowed the throw, and
//     the release shipped a headline tool no host could call — because the test
//     asserted a tool *count*.
//  2. A prompt section asked for a slot name that resolved to `undefined`, and
//     `section()` threw "order must be a finite number" into the same quarantine,
//     so the guidance silently never existed.
//
// So: every schema here is compiled by the REAL host validator, and every prompt
// order is asserted finite. If the host packages are not reachable, the schema
// assertions are reported as skipped rather than silently passing.

import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { CHANNELS, CHANNEL_IDS, DECISION_RUBRIC, buildRequestText, normalizeAnswer, parseAnswers, verdictFor } from '../lib/channels.js';
import { CHANNEL_HINTS, PROTOCOL_VARIANTS, protocolTextFor } from '../lib/protocol.js';
import { classifyAction } from '../lib/gate.js';
import { backoffMs, createBreaker, createLimiter, createResultCache, foldStream, isRetryableStatus } from '../lib/engine.js';
import { redact, unwrapDeep } from '../lib/util.js';
import { apply, inject, name, normalizeConfig } from '../index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const results = [];
let failures = 0;

function test(title, run) {
  try {
    run();
    results.push(`ok   ${title}`);
  } catch (error) {
    failures += 1;
    results.push(`FAIL ${title}\n     ${error?.message ?? error}`);
  }
}

// ---------------------------------------------------------------------------
// A fake host context: captures exactly what the plugin registers.
// ---------------------------------------------------------------------------

function fakeContext() {
  const captured = { tools: [], sections: [], contexts: [], listeners: [], effects: [] };
  const ctx = {
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    effect(fn, label) {
      captured.effects.push(label);
      const result = fn();
      if (typeof result === 'function') return result;
      if (result !== undefined && typeof result[Symbol.iterator] === 'function') {
        const disposers = [...result];
        return disposers;
      }
      if (result !== undefined && typeof result.then === 'function') return result;
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
      getSectionOrder() {
        return undefined;
      },
      getContextOrder() {
        return undefined;
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
    get() {
      return undefined;
    },
  };
  return { ctx, captured };
}

// ---------------------------------------------------------------------------
// 1. The real host schema compiler
// ---------------------------------------------------------------------------

// An explicit DSH_TOOLS_PATH is authoritative — it must resolve, or the run
// reports a skip (or a failure, unless the skip is allowed). Only when it is
// unset does the suite look in the known local homes of a DSH installation, so
// that a developer gets the strong assertions for free while CI (which sets the
// variable to nothing and allows a skip) reports the gap honestly.
const LOCAL_TOOLS_HOMES = [
  // A source checkout, then two extracted installation bundles.
  'E:/Deepseek-Harness/dsh-learn/deepseek-harness/packages/core/tools/lib/index.js',
  'E:/SOME_SEVEN_PROJECT-57/_recon/asar/dsh/node_modules/@deepseek-ai/dsh-tools/lib/index.js',
  'E:/Deepseek-Harness/dsh-desktop/resources/app.asar.unpacked/dsh/node_modules/@deepseek-ai/dsh-tools/lib/index.js',
];
const TOOLS_CANDIDATES = process.env.DSH_TOOLS_PATH ? [process.env.DSH_TOOLS_PATH] : LOCAL_TOOLS_HOMES;

let hostTools;
let hostToolsNote = 'not found (schema assertions skipped)';
for (const candidate of TOOLS_CANDIDATES) {
  try {
    hostTools = await import(pathToFileURL(candidate).href);
    hostToolsNote = candidate;
    break;
  } catch {
    // try the next candidate
  }
}

const built = fakeContext();
apply(built.ctx, { statusContext: true });

test('plugin exports the module contract (no default export, which would drop inject)', () => {
  assert.equal(name, 'jev-mode');
  assert.deepEqual(inject, ['llm', 'tools', 'systemPrompt']);
  assert.equal(typeof apply, 'function');
});

test('the tool catalog is fixed and complete', () => {
  const names = built.captured.tools.map((tool) => tool.name).sort();
  assert.deepEqual(names, ['jev_decide', 'jev_gate', 'jev_status']);
});

test('every tool declares output { schema, render } and a description', () => {
  for (const tool of built.captured.tools) {
    assert.equal(typeof tool.description, 'string', `${tool.name} has no description`);
    assert.ok(tool.description.length > 20, `${tool.name} description is too short to guide the model`);
    assert.equal(typeof tool.output?.render, 'function', `${tool.name} has no render`);
    assert.equal(typeof tool.output?.schema, 'object', `${tool.name} has no output schema`);
    assert.equal(typeof tool.execute, 'function', `${tool.name} has no execute`);
    assert.equal(typeof tool.parameters, 'object', `${tool.name} has no parameters`);
  }
});

test('every tool schema and parameter schema is accepted by the REAL host validator', () => {
  if (hostTools === undefined) return; // reported as skipped below
  for (const tool of built.captured.tools) {
    hostTools.assertSupportedJsonSchema(tool.parameters);
    hostTools.assertSupportedJsonSchema(tool.output.schema);
  }
});

test('the decider output schema validates a real returned shape', () => {
  if (hostTools === undefined) return;
  const decide = built.captured.tools.find((tool) => tool.name === 'jev_decide');
  const violations = hostTools.validateJsonSchemaValue(decide.output.schema, {
    channel: 'route',
    primitive: 'choice',
    verdict: 'decided',
    reason: 'value answer',
    backend: 'model+cache',
    cached: true,
    ms: 412,
    value: 'inspect',
    probability: 0.91,
    cacheReadTokens: 384,
  });
  assert.deepEqual(violations, []);
});

test('an incomplete decider output is rejected by the host validator', () => {
  if (hostTools === undefined) return;
  const decide = built.captured.tools.find((tool) => tool.name === 'jev_decide');
  const violations = hostTools.validateJsonSchemaValue(decide.output.schema, { channel: 'route' });
  assert.ok(violations.length > 0, 'a missing required field must be a violation');
});

test('the model-facing parameter schema is object-rooted and closed', () => {
  for (const tool of built.captured.tools) {
    assert.equal(tool.parameters.type, 'object');
    assert.equal(tool.parameters.additionalProperties, false, `${tool.name} parameters are open`);
  }
  const decide = built.captured.tools.find((tool) => tool.name === 'jev_decide');
  assert.deepEqual(decide.parameters.properties.channel.enum, CHANNEL_IDS);
  assert.deepEqual(decide.parameters.required, ['channel', 'state']);
});

// ---------------------------------------------------------------------------
// 2. Prompt assembly: finite orders, byte-stable text
// ---------------------------------------------------------------------------

test('exactly one prompt section is registered, at a finite order', () => {
  assert.equal(built.captured.sections.length, 1);
  const [section] = built.captured.sections;
  assert.equal(section.name, 'jev:protocol');
  assert.ok(Number.isFinite(section.order), 'a non-finite order throws at registration and can be swallowed');
  // Far from the persona prefix at order 0: a change there invalidates the whole
  // request prefix from token 0.
  assert.ok(section.order > 1000, 'the section must not sit in the early prefix');
  assert.equal(section.interpolate, false, 'prose containing braces must not be interpolated');
});

test('the prompt section text is byte-identical across activations (prefix stability)', () => {
  const second = fakeContext();
  apply(second.ctx, { statusContext: true });
  assert.equal(second.captured.sections[0].text, built.captured.sections[0].text);
  assert.equal(second.captured.contexts[0].name, built.captured.contexts[0].name);
});

test('the section text contains no dynamic value (no clock, no id, no absolute path)', () => {
  const text = built.captured.sections[0].text;
  assert.ok(!/\d{4}-\d{2}-\d{2}T\d{2}:/.test(text), 'an ISO timestamp in the prefix would break reuse every turn');
  assert.ok(!/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}/i.test(text), 'a session identifier in the prefix would break reuse');
  assert.ok(!/[A-Za-z]:\\|\/(?:home|Users)\//.test(text), 'an absolute path in the prefix would break reuse across projects');
  assert.ok(!/\b\d{10,}\b/.test(text), 'an epoch-like number in the prefix would break reuse');
  assert.ok(text.includes('JEV DECISION MODE'));
});

test('the runtime context is dynamic and carries no bodies', () => {
  const [context] = built.captured.contexts;
  assert.equal(context.name, 'jev:status');
  assert.ok(Number.isFinite(context.order));
  // No session yet -> empty text, which the registry drops rather than emitting.
  assert.equal(context.text({ agent: undefined }), '');
});

// ---------------------------------------------------------------------------
// 3. Configuration
// ---------------------------------------------------------------------------

test('an empty config yields the documented defaults', () => {
  const config = normalizeConfig({});
  assert.equal(config.backend, 'auto');
  assert.equal(config.autoGate, true);
  assert.equal(config.gateAtRisk, 2);
  assert.equal(config.authorizeThreshold, 0.85);
  assert.equal(config.authorizeAskBand, 0.55);
  assert.equal(config.onGateFailure, 'escalate');
  assert.equal(config.decisionReasoningEffort, 'off');
});

test('a schemastery volatile field is unwrapped rather than used as an object', () => {
  const writer = Symbol.for('cosmokit.volatile.write');
  const volatileFlag = { get: () => false, [writer]: () => {} };
  const volatileNumber = { get: () => 0.9, [writer]: () => {} };
  const config = normalizeConfig({ autoGate: volatileFlag, authorizeThreshold: volatileNumber });
  // The community failure this guards: `config.enabled === false` was never true,
  // so a guard was silently unarmed while every log said it was installed.
  assert.equal(config.autoGate, false);
  assert.equal(config.authorizeThreshold, 0.9);
});

test('garbage config values fall back instead of propagating NaN', () => {
  const config = normalizeConfig({
    gateAtRisk: 'lots',
    authorizeThreshold: Number.NaN,
    concurrency: -5,
    onGateFailure: 'explode',
    backend: 'nonsense',
  });
  assert.equal(config.gateAtRisk, 2);
  assert.equal(config.authorizeThreshold, 0.85);
  assert.equal(config.concurrency, 1);
  assert.equal(config.onGateFailure, 'escalate');
  assert.equal(config.backend, 'auto');
  assert.equal(unwrapDeep({ a: { b: [1, 2] } }).a.b.length, 2);
});

// ---------------------------------------------------------------------------
// 4. The deterministic classifier
// ---------------------------------------------------------------------------

const CWD = 'E:\\work\\proj';

test('ordinary work is never gated', () => {
  const cases = [
    { toolName: 'read', args: { path: 'E:\\work\\proj\\a.ts' } },
    { toolName: 'grep', args: { pattern: 'rm -rf' } },
    { toolName: 'write', args: { path: 'E:\\work\\proj\\a.ts', content: 'x' } },
    { toolName: 'pwsh', args: { command: 'npm test' } },
    { toolName: 'pwsh', args: { command: 'git status' } },
    { toolName: 'pwsh', args: { command: 'git commit -m "wip"' } },
    { toolName: 'todo_write', args: { todos: [] } },
  ];
  for (const item of cases) {
    const verdict = classifyAction({ ...item, cwd: CWD });
    assert.ok(
      verdict.risk < 2,
      `${item.toolName} ${JSON.stringify(item.args)} was classified risk ${verdict.risk} (${verdict.signals})`,
    );
    assert.equal(verdict.hard, null);
  }
});

test('irreversible and external actions are classified at or above the gate', () => {
  const cases = [
    { toolName: 'pwsh', args: { command: 'git push --force origin main' } },
    { toolName: 'pwsh', args: { command: 'git push origin main' } },
    { toolName: 'pwsh', args: { command: 'npm publish --access public' } },
    { toolName: 'pwsh', args: { command: 'Remove-Item -Recurse -Force C:\\data' } },
    { toolName: 'pwsh', args: { command: 'rm -rf /var/lib/thing' } },
    { toolName: 'pwsh', args: { command: 'chmod 777 /etc/passwd' } },
    { toolName: 'write', args: { path: 'C:\\Windows\\System32\\drivers\\etc\\hosts', content: 'x' } },
  ];
  for (const item of cases) {
    const verdict = classifyAction({ ...item, cwd: CWD });
    assert.ok(verdict.risk >= 2, `${JSON.stringify(item.args)} was classified risk ${verdict.risk}`);
  }
});

test('a disk-destroying command is a hard denial that needs no model call', () => {
  const verdict = classifyAction({ toolName: 'pwsh', args: { command: 'format D: /q' }, cwd: CWD });
  assert.equal(verdict.hard !== null, true);
  assert.equal(verdict.class, 'catastrophic');
});

// ---------------------------------------------------------------------------
// 4b. The delete family: target decides the risk, not the verb
// ---------------------------------------------------------------------------
//
// A gate that asks about `rm -rf node_modules` trains its user to route around
// the gate, which is worse than not having one. So the classifiers below are
// asserted in both directions: routine cleanup is untouched, and every destroy
// is still caught.

test('deleting a regenerable directory is ordinary work, not a gated action', () => {
  const routine = [
    'rm -rf node_modules',
    'rm -rf ./node_modules',
    'rm -rf node_modules dist',
    'rm -rf .next .turbo',
    'rm -rf coverage __pycache__',
    'rm -rf .\\target',
    'Remove-Item -Recurse -Force .\\node_modules',
    'rmdir /s /q .\\build',
    'rm -rf ~/proj/node_modules',
  ];
  for (const command of routine) {
    const verdict = classifyAction({ toolName: 'pwsh', args: { command }, cwd: CWD });
    assert.ok(verdict.risk < 2, `routine cleanup was gated: "${command}" -> risk ${verdict.risk} (${verdict.signals})`);
    assert.equal(verdict.hard, null);
  }
});

test('deleting anything else recursively is still gated', () => {
  const destructive = [
    'rm -rf src',
    'rm -rf ../../other/src',
    'rm -rf /var/lib/postgresql',
    'Remove-Item -Recurse -Force C:\\data',
    'rm -rf unknown-thing',
  ];
  for (const command of destructive) {
    const verdict = classifyAction({ toolName: 'pwsh', args: { command }, cwd: CWD });
    assert.ok(verdict.risk >= 2, `destructive delete was not gated: "${command}" -> risk ${verdict.risk}`);
  }
});

test('a root or home delete is hard-denied without any model call', () => {
  for (const command of ['rm -rf /', 'rm -rf ~', 'rm -rf $HOME', 'rm -rf C:\\', 'rm -rf C:/', 'Remove-Item -Recurse -Force C:\\']) {
    const verdict = classifyAction({ toolName: 'pwsh', args: { command }, cwd: CWD });
    assert.equal(verdict.hard !== null, true, `"${command}" was gated but not hard-denied (risk ${verdict.risk})`);
    assert.equal(verdict.class, 'catastrophic');
  }
});

test('a path argument is read from the value, not from the serialized envelope', () => {
  // Regression: matching against JSON.stringify(args) left the closing quote and
  // brace glued to the last token (`node_modules"}`), so the delete target list
  // came back empty and EVERY single-target recursive delete was classified as
  // destructive. The same wrapping also defeated an end-anchored hard rule, so
  // `rm -rf /` arrived as `{"command":"rm -rf /"}` and missed the deny.
  const single = classifyAction({ toolName: 'pwsh', args: { command: 'rm -rf node_modules' }, cwd: CWD });
  assert.ok(single.risk < 2, 'a single disposable target must not be gated');
  assert.equal(single.signals.includes('recursive-delete-disposable'), true);

  const root = classifyAction({ toolName: 'pwsh', args: { command: 'rm -rf /' }, cwd: CWD });
  assert.equal(root.hard !== null, true, 'an end-anchored hard rule must still match through the argument value');
});

test('mutating another system, or discarding uncommitted work, is gated', () => {
  const gated = [
    'terraform apply -auto-approve',
    'terraform destroy',
    'kubectl delete deployment api',
    'helm uninstall payments',
    'aws s3 rm s3://prod-bucket --recursive',
    'docker rm -f api',
    'psql -c "DROP TABLE users"',
    'mysql -e "DELETE FROM orders"',
    'git checkout .',
    'git restore .',
    'git stash clear',
  ];
  for (const command of gated) {
    const verdict = classifyAction({ toolName: 'pwsh', args: { command }, cwd: CWD });
    assert.ok(verdict.risk >= 2, `not gated: "${command}" -> risk ${verdict.risk}`);
  }
});

test('reading infrastructure state is not gated', () => {
  for (const command of ['terraform plan', 'kubectl get pods', 'docker ps', 'aws s3 ls']) {
    const verdict = classifyAction({ toolName: 'pwsh', args: { command }, cwd: CWD });
    assert.ok(verdict.risk < 2, `read-only infrastructure command was gated: "${command}" -> risk ${verdict.risk}`);
  }
});

test('writing to a credential store is a hard denial', () => {
  const verdict = classifyAction({
    toolName: 'write',
    args: { path: 'C:\\Users\\dev\\.dsh\\.credentials.yaml', content: 'x' },
    cwd: CWD,
  });
  assert.equal(verdict.hard !== null, true);
});

// ---------------------------------------------------------------------------
// 5. Answer parsing and verdict bands
// ---------------------------------------------------------------------------

test('a clean JSON answer parses', () => {
  const parsed = parseAnswers('{"answers":{"authorize":{"type":"noul","noul":0.9}}}', ['authorize']);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.answers.authorize.noul, 0.9);
});

test('a fenced answer parses (models add fences)', () => {
  const parsed = parseAnswers('```json\n{"answers":{"a":{"type":"noul","noul":0.5}}}\n```', ['a']);
  assert.equal(parsed.ok, true);
});

test('a reply with prose around the object still parses', () => {
  const parsed = parseAnswers('Here you go: {"answers":{"a":{"type":"noul","noul":0.2}}} — done', ['a']);
  assert.equal(parsed.ok, true);
});

test('a repeated JSON member is rejected (JSON.parse would keep the last one)', () => {
  const parsed = parseAnswers('{"answers":{"a":{"type":"noul","noul":0.9}},"answers":{"a":{"type":"noul","noul":0.1}}}', ['a']);
  assert.equal(parsed.ok, false);
  assert.match(parsed.reason, /repeated a JSON member/);
});

test('a reply that omits a requested key is a failure, not a partial success', () => {
  const parsed = parseAnswers('{"answers":{"a":{"type":"noul","noul":0.9}}}', ['a', 'b']);
  assert.equal(parsed.ok, false);
});

test('noul has no confidence field and the probability is the answer', () => {
  const answer = normalizeAnswer('authorize', { type: 'noul', noul: 0.73, basis: 'user said delete it' });
  assert.equal(answer.ok, true);
  assert.equal(answer.probability, 0.73);
  assert.equal(answer.confidence, 0.73);
});

test('a choice outside the criteria map is rejected', () => {
  const answer = normalizeAnswer('route', { type: 'choice', choice: 'teleport' });
  assert.equal(answer.ok, false);
});

test('a score level comes from the distribution peak, not from rounding the mean', () => {
  // The ecosystem's documented trap: score 1.6 with {1: 0.6, 2: 0.4} is level 1.
  const answer = normalizeAnswer('risk', { type: 'score', score: 1.6, probabilities: { 1: 0.6, 2: 0.4 } });
  assert.equal(answer.ok, true);
  assert.equal(answer.level, 1);
  const other = normalizeAnswer('risk', { type: 'score', score: 2.98, probabilities: { 2: 0.02, 3: 0.98 } });
  assert.equal(other.level, 3);
});

test('the authorization bands are exactly as documented', () => {
  const cuts = { threshold: 0.85, askBand: 0.55 };
  const at = (p) => verdictFor('authorize', { ok: true, primitive: 'noul', probability: p }, cuts).verdict;
  assert.equal(at(0.86), 'allow');
  assert.equal(at(0.85), 'allow');
  assert.equal(at(0.7), 'ask');
  assert.equal(at(0.55), 'ask');
  assert.equal(at(0.54), 'deny');
  assert.equal(at(0), 'deny');
});

test('an advisory channel returns unavailable rather than a fabricated verdict', () => {
  const decided = verdictFor('grounded', { ok: false, reason: 'backend down' }, { threshold: 0.8, askBand: 0.5 });
  assert.equal(decided.verdict, 'unavailable');
});

// ---------------------------------------------------------------------------
// 6. Request construction stays cache-shaped
// ---------------------------------------------------------------------------

test('the decision request puts the varying part last and the rubric never varies', () => {
  const first = buildRequestText({ channel: 'authorize', state: 'A', maxStateChars: 1000 });
  const second = buildRequestText({ channel: 'authorize', state: 'B', maxStateChars: 1000 });
  assert.notEqual(first, second, 'the state must actually reach the request');
  assert.ok(first.startsWith('JEV REQUEST\n'));
  // The channel and question shape are constant for a given channel, so the
  // provider can reuse everything up to the state.
  const head = (text) => text.slice(0, text.indexOf('"state"'));
  assert.equal(head(first), head(second));
});

test('an oversized state is truncated, keeping head and tail', () => {
  const text = buildRequestText({ channel: 'sufficient', state: 'x'.repeat(20_000), maxStateChars: 1000 });
  assert.ok(text.length < 2000, `request text was ${text.length} chars`);
  assert.ok(text.includes('[truncated'));
});

test('the frozen rubric clears the provider cache unit and names all three primitives', () => {
  // 64 tokens is the provider's documented cache storage unit, and the cacheable
  // prefix is the rubric plus the request head. A rough 3.5 chars/token puts this
  // far above the unit, so a shared prefix is genuinely cacheable.
  assert.ok(DECISION_RUBRIC.length > 1200, `rubric is only ${DECISION_RUBRIC.length} chars`);
  for (const primitive of ['noul', 'choice', 'score']) {
    assert.ok(DECISION_RUBRIC.includes(primitive), `the rubric never mentions ${primitive}`);
  }
  assert.ok(DECISION_RUBRIC.includes('Output ONE JSON object'), 'the rubric must fix the output envelope');
  assert.equal(Object.keys(CHANNELS).length, 6); // five public plus internal dispatch
  assert.ok(!CHANNEL_IDS.includes('dispatch'));
});

// ---------------------------------------------------------------------------
// 7. Stream folding and transport hardening
// ---------------------------------------------------------------------------

async function foldOf(chunks) {
  return foldStream(
    (async function* generate() {
      for (const chunk of chunks) yield chunk;
    })(),
  );
}

const foldResults = [];
await (async () => {
  try {
    const ok = await foldOf([
      { type: 'text-delta', index: 0, text: '{"answers"' },
      { type: 'text-delta', index: 0, text: ':{"a":{"type":"noul","noul":0.4}}}' },
      { type: 'usage', usage: { input_tokens: 900, output_tokens: 20, cache_read_input_tokens: 832 } },
      { type: 'finish', reason: { kind: 'stop' } },
    ]);
    assert.equal(ok.text.endsWith('0.4}}}'), true);
    assert.equal(ok.usage.cache_read_input_tokens, 832);
    foldResults.push('ok   a normal stream folds text, usage and finish');

    let errored = false;
    try {
      await foldOf([{ type: 'finish', reason: { kind: 'error', failure: { code: 'RATE_LIMIT', message: 'slow down' } } }]);
    } catch (error) {
      errored = true;
      assert.equal(error.code, 'RATE_LIMIT');
      assert.equal(error.retryable, true);
    }
    assert.equal(errored, true, 'a terminal error finish must throw, not be ignored');
    foldResults.push('ok   a terminal error finish throws with its code');

    let truncated = false;
    try {
      await foldOf([{ type: 'finish', reason: { kind: 'max-tokens' } }]);
    } catch {
      truncated = true;
    }
    assert.equal(truncated, true, 'a truncated decision must not be parsed as a complete answer');
    foldResults.push('ok   a max-tokens finish is a failure');

    let empty = false;
    try {
      await foldOf([{ type: 'text-delta', index: 0, text: 'x' }]);
    } catch {
      empty = true;
    }
    assert.equal(empty, true, 'a stream with no terminal finish must not be trusted');
    foldResults.push('ok   a stream with no terminal finish is a failure');
  } catch (error) {
    foldResults.push(`FAIL stream folding\n     ${error?.message ?? error}`);
    failures += 1;
  }
})();

test('the breaker opens on consecutive failures and admits one probe after cooldown', () => {
  let clock = 0; // an injectable clock legitimately starts at zero
  const breaker = createBreaker({ failures: 3, cooldownMs: 1000, now: () => clock });
  assert.equal(breaker.admit().ok, true, 'a clock starting at 0 must not look like an opened breaker');
  breaker.failure();
  breaker.failure();
  assert.equal(breaker.admit().ok, true);
  breaker.failure();
  assert.equal(breaker.admit().ok, false, 'three failures must open the breaker');
  clock = 999;
  assert.equal(breaker.admit().ok, false);
  clock = 1000;
  assert.equal(breaker.admit().ok, true, 'after cooldown exactly one probe is admitted');
  breaker.success();
  assert.equal(breaker.admit().ok, true);
});

test('only retryable statuses are retried', () => {
  for (const status of [408, 409, 425, 429, 529, 500, 503]) assert.equal(isRetryableStatus(status), true, String(status));
  for (const status of [400, 401, 403, 404, 422]) assert.equal(isRetryableStatus(status), false, String(status));
  assert.equal(backoffMs(0), 400);
  assert.equal(backoffMs(9), 5000, 'backoff is capped');
  assert.equal(backoffMs(0, '2'), 2000, 'Retry-After wins');
});

test('the verdict cache expires and is bounded', () => {
  let clock = 0;
  const cache = createResultCache({ ttlMs: 100, maxEntries: 2, now: () => clock });
  cache.set('a', 1);
  assert.equal(cache.get('a'), 1);
  clock = 101;
  assert.equal(cache.get('a'), undefined, 'an entry past its TTL must not be served');
  cache.set('x', 1);
  cache.set('y', 2);
  cache.set('z', 3);
  assert.equal(cache.size(), 2, 'the cache must stay bounded');
  assert.equal(cache.get('x'), undefined, 'the oldest entry is evicted first');
  const disabled = createResultCache({ ttlMs: 0, now: () => 1 });
  disabled.set('x', 'must-not-cache'); assert.equal(disabled.get('x'), undefined); assert.equal(disabled.size(), 0);
});

test('the limiter admits at most its concurrency', async () => {
  const run = createLimiter(2);
  let active = 0;
  let peak = 0;
  await Promise.all(
    Array.from({ length: 8 }, () =>
      run(async () => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        active -= 1;
      }),
    ),
  );
  assert.ok(peak <= 2, `peak concurrency was ${peak}`);
});

test('redaction preserves shape and drops secrets', () => {
  // Every literal here is deliberately synthetic. Real credential material must
  // never appear in a fixture: this repository is meant to be publishable, and a
  // copied prefix is still a leak. See the "no credential material" check in
  // test/manifest.test.mjs, which fails on any credential-shaped literal that is
  // not on the obviously-fake allowlist below.
  assert.match(redact('token ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345'), /<GITHUB_TOKEN>/);
  assert.match(redact('key sk-abcdefghijklmnopqrstuvwx'), /<API_KEY>/);
  assert.match(redact('key apikey_0123456789abcdef0123456789abcdef'), /<API_KEY>/);
  assert.match(redact('mail dev@example.com'), /<EMAIL>/);
  assert.match(redact('host db.acme-corp.internal'), /<internal-host>/);
  assert.match(redact('ip 10.1.2.3'), /<private-ip>/);
  assert.match(redact('path C:\\Users\\sevan\\secret.txt'), /C:\\Users\\<user>\\secret\.txt/);
  assert.match(redact('bearer Bearer abcdefghijklmnopqrstuvwx'), /<TOKEN>/);
  assert.equal(redact('x'.repeat(500)).length, 160);
});

test('the gate listener is prepended and handles exactly one event', () => {
  assert.equal(built.captured.listeners.length, 1);
  const [listener] = built.captured.listeners;
  assert.equal(listener.event, 'tools/pre-execute');
  assert.equal(listener.options?.prepend, true, 'the gate must run before later policy listeners');
});

test('a call from the outer PTC transport is delegated without a decision', async () => {
  const [listener] = built.captured.listeners;
  let delegated = false;
  const result = await listener.listener(
    { name: 'run_code', parent: undefined, arguments: {}, signal: new AbortController().signal },
    async () => {
      delegated = true;
      return { kind: 'allow' };
    },
  );
  assert.equal(delegated, true);
  assert.equal(result.kind, 'allow');
});

test('an untrusted call with no agent is delegated without a decision', async () => {
  const [listener] = built.captured.listeners;
  let delegated = false;
  const result = await listener.listener({ name: 'pwsh', arguments: { command: 'rm -rf /' }, signal: new AbortController().signal }, async () => {
    delegated = true;
    return { kind: 'allow' };
  });
  assert.equal(delegated, true);
  assert.equal(result.kind, 'allow');
});

test('an ordinary workspace write is delegated with no ledger activity', async () => {
  const { ctx, captured } = fakeContext();
  apply(ctx, {});
  const [listener] = captured.listeners;
  let delegated = false;
  const agent = { session: { id: 's1', header: { cwd: CWD }, snapshotEvents: () => [] } };
  const result = await listener.listener(
    { name: 'write', arguments: { path: 'E:\\work\\proj\\a.ts', content: 'x' }, agent, signal: new AbortController().signal },
    async () => {
      delegated = true;
      return { kind: 'allow' };
    },
  );
  assert.equal(delegated, true);
  assert.equal(result.kind, 'allow');
});

test('a hard-denied action is refused without any model call', async () => {
  const { ctx, captured } = fakeContext();
  apply(ctx, {});
  const [listener] = captured.listeners;
  const agent = { session: { id: 's2', header: { cwd: CWD }, snapshotEvents: () => [] } };
  const result = await listener.listener(
    { name: 'pwsh', arguments: { command: 'format D: /q' }, agent, signal: new AbortController().signal },
    async () => ({ kind: 'allow' }),
  );
  assert.equal(result.kind, 'deny');
  assert.match(result.reason, /JEV mode rejected tool "pwsh"/);
  assert.equal(result.info.code, 'JEV_MODE_DENIED');
  // The raw reason is durable detail, never model-visible content.
  assert.ok(!result.reason.includes('destroys a volume'));
  assert.match(result.info.reason, /destroys a volume/);
});

test('with no LLM route the gate escalates instead of allowing', async () => {
  const { ctx, captured } = fakeContext();
  apply(ctx, {});
  const [listener] = captured.listeners;
  const agent = {
    session: { id: 's3', header: { cwd: CWD }, snapshotEvents: () => [], requestHeader: () => undefined },
    options: {},
  };
  const result = await listener.listener(
    { name: 'pwsh', arguments: { command: 'git push --force origin main' }, agent, signal: new AbortController().signal },
    async () => ({ kind: 'allow' }),
  );
  // `escalate` is the default: a gate that cannot judge must not answer "yes".
  assert.equal(result.kind, 'ask');
  assert.equal(typeof result.displayReason.zh, 'string');
});

test('a gate refusal never overrides a later listener denial', async () => {
  const { ctx, captured } = fakeContext();
  apply(ctx, {});
  const [listener] = captured.listeners;
  const agent = { session: { id: 's4', header: { cwd: CWD }, snapshotEvents: () => [], requestHeader: () => undefined }, options: {} };
  const result = await listener.listener(
    { name: 'pwsh', arguments: { command: 'npm publish' }, agent, signal: new AbortController().signal },
    async () => ({ kind: 'deny', reason: 'a later policy refused this' }),
  );
  assert.equal(result.kind, 'deny');
  assert.equal(result.reason, 'a later policy refused this');
});

// ---------------------------------------------------------------------------
// 8. Protocol variants
// ---------------------------------------------------------------------------
//
// Two verbosity levels render from one rule list. The risk of such a pair is
// silent divergence: the shorter prompt quietly stops naming a channel or a
// threshold, and the mode's behaviour changes without any test noticing. These
// checks make that a failure instead of a surprise.

const PROTOCOL_CONFIG = normalizeConfig({});

test('the channel hint table covers exactly the registered channels', () => {
  const hinted = Object.keys(CHANNEL_HINTS).sort();
  assert.deepEqual(hinted, [...CHANNEL_IDS].sort(), 'a channel without a hint disappears from the prompt');
});

test('the protocol variant list is closed, and a junk value falls back to full', () => {
  assert.deepEqual([...PROTOCOL_VARIANTS], ['full', 'compact', 'focused']);
  assert.equal(PROTOCOL_CONFIG.protocol, 'focused');
  assert.equal(normalizeConfig({ protocol: 'compact' }).protocol, 'compact');
  assert.equal(normalizeConfig({ protocol: 'shorter' }).protocol, 'focused');
  assert.equal(normalizeConfig({ protocol: 42 }).protocol, 'focused');
});

test('both variants name every channel, every threshold, and all three primitives', () => {
  for (const variant of PROTOCOL_VARIANTS) {
    const text = protocolTextFor(variant, PROTOCOL_CONFIG);
    for (const channel of CHANNEL_IDS) {
      assert.ok(text.includes(channel), `${variant} never names the ${channel} channel`);
    }
    for (const primitive of ['noul', 'choice', 'score']) {
      assert.ok(text.includes(primitive), `${variant} never names the ${primitive} primitive`);
    }
    assert.ok(
      text.includes(String(PROTOCOL_CONFIG.authorizeThreshold)),
      `${variant} omits the authorization threshold, so the bands it states are unusable`,
    );
    assert.ok(text.includes(String(PROTOCOL_CONFIG.authorizeAskBand)), `${variant} omits the ask band`);
    assert.ok(text.includes(String(PROTOCOL_CONFIG.gateAtRisk)), `${variant} omits the gated risk level`);
    assert.ok(text.startsWith('JEV DECISION MODE'), `${variant} lost its heading`);
  }
});

test('both variants are pure functions of the config (cache stability)', () => {
  for (const variant of PROTOCOL_VARIANTS) {
    assert.equal(
      protocolTextFor(variant, PROTOCOL_CONFIG),
      protocolTextFor(variant, PROTOCOL_CONFIG),
      `${variant} is not deterministic`,
    );
  }
});

test('neither variant embeds a dynamic value', () => {
  for (const variant of PROTOCOL_VARIANTS) {
    const text = protocolTextFor(variant, PROTOCOL_CONFIG);
    assert.ok(!/\d{4}-\d{2}-\d{2}T\d{2}:/.test(text), `${variant} carries an ISO timestamp`);
    assert.ok(!/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}/i.test(text), `${variant} carries an identifier`);
    assert.ok(!/[A-Za-z]:\\|\/(?:home|Users)\//.test(text), `${variant} carries an absolute path`);
    assert.ok(!/\b\d{10,}\b/.test(text), `${variant} carries an epoch-like number`);
  }
});

test('compact is materially smaller than full but keeps the operational rules', () => {
  const full = protocolTextFor('full', PROTOCOL_CONFIG);
  const compact = protocolTextFor('compact', PROTOCOL_CONFIG);
  const saving = 1 - compact.length / full.length;
  assert.ok(saving >= 0.3, `compact saves only ${Math.round(saving * 100)}%`);
  // Every rule that the full text states as an instruction must survive.
  for (const marker of ['jev_decide', 'jev_gate', 'route', 'grounded', 'sufficient', 'advisory']) {
    assert.ok(compact.includes(marker), `compact lost "${marker}", so it is not the same protocol`);
  }
});

test('the two variants differ only in wording, never in the numbers they state', () => {
  const numbers = (text) => (text.match(/\d+(?:\.\d+)?/g) ?? []).sort().join(',');
  // The config values must appear identically in both; the surrounding prose is
  // what may differ.
  for (const value of [PROTOCOL_CONFIG.authorizeThreshold, PROTOCOL_CONFIG.authorizeAskBand, PROTOCOL_CONFIG.gateAtRisk]) {
    assert.ok(numbers(protocolTextFor('full', PROTOCOL_CONFIG)).includes(String(value)));
    assert.ok(numbers(protocolTextFor('compact', PROTOCOL_CONFIG)).includes(String(value)));
  }
});

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

for (const line of foldResults) results.push(line);

console.log(results.join('\n'));
console.log(`\nhost tool schema compiler: ${hostToolsNote}`);

// The strongest assertions in this file compile every tool schema through the
// real host validator, so their absence must never pass silently. Strict is the
// default: without a DSH installation to borrow the validator from, this suite
// fails. CI sets DSH_ALLOW_SKIPPED_HOST_TOOLS=1 and reports the gap as a skip,
// because a runner has no harness installed — but a local run does not get that
// excuse.
let skipped = 0;
if (hostTools === undefined) {
  if (process.env.DSH_ALLOW_SKIPPED_HOST_TOOLS === '1') {
    skipped = 1;
    console.log('SKIPPED: host schema assertions — no @deepseek-ai/dsh-tools found (DSH_ALLOW_SKIPPED_HOST_TOOLS=1).');
    console.log('         Set DSH_TOOLS_PATH to the real entry to run them.');
  } else {
    failures += 1;
    console.log('FAILED: host schema assertions did not run. Set DSH_TOOLS_PATH to the real');
    console.log('        @deepseek-ai/dsh-tools entry, or set DSH_ALLOW_SKIPPED_HOST_TOOLS=1 to');
    console.log('        accept a skip (CI does the latter, and reports it).');
  }
}

const executed = results.length - skipped;
console.log(
  failures === 0
    ? `\n${executed} check(s) passed${skipped > 0 ? ', 1 group SKIPPED' : ''}`
    : `\n${failures} check(s) FAILED`,
);
process.exit(failures === 0 ? 0 : 1);
