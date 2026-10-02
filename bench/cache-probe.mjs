// dsh-jev-mode / bench/cache-probe.mjs
//
// Measures the design's central claim against the REAL provider, not against a
// double and not against this side of the wire.
//
// Everything else in `bench/` establishes that the request prefix is byte-stable
// and that a scripted provider would reuse it. This script asks the actual
// service, because "the provider reuses an identical prefix" is the one thing a
// plugin cannot prove about itself — and it is the thing this plugin's whole
// prompt discipline is for.
//
// It sends only this bundle's own frozen decision rubric as `system`, and short
// invented states as the user message. No session content, no user data, no file
// paths. Every call is a few hundred input tokens.
//
// Four calls:
//   1. warm      - is the rubric cacheable at all?
//   2. repeat    - does an identical request reuse it?
//   3. new tail  - does a DIFFERENT user message still reuse the rubric prefix?
//                  (this is the design's core bet)
//   4. head bump - does changing the rubric EARLY forfeit the reuse?
//                  (this is why nothing dynamic may sit at the top of a prompt)
//
// Credentials: the harness's own account token when present, else
// $DEEPSEEK_API_KEY. Without either, the probe reports SKIP and exits 0, so CI can
// run it unconditionally.
//
// Run:  node bench/cache-probe.mjs            (reads .credentials.yaml or the env)
//       DSH_PROBE_MODEL=deepseek-flash node bench/cache-probe.mjs

import { readFileSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { DECISION_RUBRIC, buildRequestText } from '../lib/channels.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// ---------------------------------------------------------------------------
// Credential resolution: never printed, never logged
// ---------------------------------------------------------------------------

const DSH_HOME = process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh');
const CREDENTIALS = path.join(DSH_HOME, '.credentials.yaml');

const YAML_CANDIDATES = [
  process.env.DSH_YAML_PATH,
  'yaml',
  'E:/Deepseek-Harness/dsh-learn/deepseek-harness/node_modules/yaml/dist/index.js',
  'E:/SOME_SEVEN_PROJECT-57/_recon/asar/dsh/node_modules/yaml/dist/index.js',
].filter(Boolean);

/** Resolve `{ header, value, source }` for the provider call, or undefined. */
async function resolveCredential() {
  if (typeof process.env.DEEPSEEK_API_KEY === 'string' && process.env.DEEPSEEK_API_KEY.length > 0) {
    return { headers: { 'x-api-key': process.env.DEEPSEEK_API_KEY }, source: 'DEEPSEEK_API_KEY' };
  }
  if (!existsSync(CREDENTIALS)) return undefined;
  for (const candidate of YAML_CANDIDATES) {
    try {
      const module = await import(candidate.includes('/') || candidate.includes('\\') ? pathToFileURL(candidate).href : candidate);
      const parse = module.parse ?? module.default?.parse;
      if (typeof parse !== 'function') continue;
      const document = parse(readFileSync(CREDENTIALS, 'utf8'));
      const token = document?.records?.['deepseek-account-platform/default']?.payload?.token;
      if (typeof token === 'string' && token.length > 0) {
        return { headers: { 'x-dsh-auth-token': token }, source: 'the harness account token' };
      }
      return undefined;
    } catch {
      // try the next parser
    }
  }
  return undefined;
}

const credential = await resolveCredential();
if (credential === undefined) {
  console.log('SKIP: no provider credential found.');
  console.log(`      looked for $DEEPSEEK_API_KEY, then the account token in ${CREDENTIALS}`);
  console.log('      this probe is opt-in because it spends real tokens and needs a real key.');
  process.exit(0);
}
console.log(`credential: ${credential.source} (value withheld)`);

const MODEL = process.env.DSH_PROBE_MODEL ?? 'deepseek-flash';
const BASE = process.env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com/anthropic';
const ENDPOINTS = [`${BASE.replace(/\/+$/, '')}/v1/messages`, `${BASE.replace(/\/+$/, '')}/messages`];

/** One decision-shaped call. Mirrors lib/engine.js: frozen system, varying tail. */
async function call({ system, user }) {
  const body = {
    model: MODEL,
    max_tokens: 48,
    thinking: { type: 'disabled' },
    system,
    messages: [{ role: 'user', content: [{ type: 'text', text: user }] }],
  };
  let lastError;
  for (const url of ENDPOINTS) {
    let response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'anthropic-version': '2023-06-01', ...credential.headers },
        body: JSON.stringify(body),
      });
    } catch (error) {
      lastError = `${url}: transport failure: ${String(error?.message ?? error).slice(0, 140)}`;
      continue;
    }
    if (response.status === 404) {
      lastError = `${url}: HTTP 404`;
      continue;
    }
    const text = await response.text();
    if (!response.ok) {
      lastError = `${url}: HTTP ${response.status}: ${text.slice(0, 200)}`;
      continue;
    }
    const json = JSON.parse(text);
    const usage = json.usage ?? {};
    // Anthropic-shaped usage: input_tokens counts the UNCACHED prompt only, so the
    // full prompt is input + cacheRead + cacheWrite.
    const input = usage.input_tokens ?? 0;
    const cacheRead = usage.cache_read_input_tokens ?? 0;
    const cacheWrite = usage.cache_creation_input_tokens ?? 0;
    return {
      prompt: input + cacheRead + cacheWrite,
      input,
      cacheRead,
      cacheWrite,
      output: usage.output_tokens ?? 0,
      stop: json.stop_reason,
      reply: (json.content ?? []).filter((block) => block.type === 'text').map((block) => block.text).join('').slice(0, 48),
    };
  }
  throw new Error(lastError ?? 'no endpoint answered');
}

const rubricChars = DECISION_RUBRIC.length;
console.log(`model: ${MODEL}`);
console.log(`frozen rubric: ${rubricChars} chars (~${Math.round(rubricChars / 3.5)} est tokens), sent byte-identically in calls 1-3\n`);

const stateA = buildRequestText({ channel: 'authorize', state: 'PROBE A: the user asked to run the test suite.', maxStateChars: 600 });
const stateB = buildRequestText({ channel: 'authorize', state: 'PROBE B: the user asked to delete a build directory.', maxStateChars: 600 });
const bumped = `Probe run at ${new Date().toISOString()}.\n${DECISION_RUBRIC}`;

const plan = [
  ['1 warm       rubric + tail A', { system: DECISION_RUBRIC, user: stateA }],
  ['2 repeat     rubric + tail A', { system: DECISION_RUBRIC, user: stateA }],
  ['3 new tail   rubric + tail B', { system: DECISION_RUBRIC, user: stateB }],
  ['4 head bump  date + rubric + A', { system: bumped, user: stateA }],
];

const rows = [];
for (const [label, request] of plan) {
  try {
    const result = await call(request);
    rows.push({ label, ...result });
    console.log(
      `${label.padEnd(32)} prompt=${String(result.prompt).padStart(5)}  cached=${String(result.cacheRead).padStart(5)}  written=${String(result.cacheWrite).padStart(5)}  uncached=${String(result.input).padStart(4)}  out=${result.output}`,
    );
    console.log(`${' '.repeat(32)} stop=${result.stop} reply=${JSON.stringify(result.reply)}`);
  } catch (error) {
    console.log(`${label.padEnd(32)} FAILED: ${String(error?.message ?? error).slice(0, 300)}`);
  }
}

console.log('\nwhat the numbers mean');
if (rows.length < 4) {
  console.log('  the run did not complete, so no conclusion is drawn.');
} else {
  const [warm, repeat, tail, head] = rows;
  const reusedAcrossTails = tail.cacheRead > 0;
  const earlyChangeCosts = head.cacheRead < tail.cacheRead;
  console.log(`  the rubric is cacheable                     : ${repeat.cacheRead > 0 ? 'yes' : 'NO'}`);
  console.log(`  an identical request reuses it              : ${repeat.cacheRead > 0 ? `yes (${repeat.cacheRead} tokens)` : 'NO'}`);
  console.log(`  a DIFFERENT trailing state reuses it        : ${reusedAcrossTails ? `yes (${tail.cacheRead} of ${tail.prompt} prompt tokens)` : 'NO — the core bet would be wrong'}`);
  console.log(`  an early change forfeits the reuse          : ${earlyChangeCosts ? `yes (${head.cacheRead} cached vs ${tail.cacheRead}; ${head.prompt} vs ${tail.prompt} prompt tokens)` : 'NO'}`);
  console.log(`  first call (cold)                           : ${warm.prompt} prompt tokens, ${warm.cacheRead} cached`);
  console.log('');
  if (reusedAcrossTails && earlyChangeCosts) {
    console.log('  => on the live provider, a byte-identical system prefix is reused across');
    console.log('     differing trailing states, and moving one byte near the start forfeits it.');
    console.log('     That is the whole reason this plugin keeps its prompt section static and');
    console.log('     routes every dynamic value through an appended runtime-context snapshot.');
  } else if (!reusedAcrossTails) {
    console.log('  => the provider did not reuse the shared prefix in this run. The plugin-side');
    console.log('     guarantees still hold (the prefix IS byte-identical, see bench/bench.mjs),');
    console.log('     but provider-side reuse was not observed here; record this run as-is.');
  }
}
console.log('\nthis probe sends only this bundle\'s own rubric and invented states: no session or user content.');
console.log('provider cache behaviour is best-effort and can vary by region, load, and account.');
