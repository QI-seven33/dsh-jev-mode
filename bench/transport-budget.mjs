// Loopback fault injection only; never calls a billable endpoint or executes tools.
// Compare the immutable v0.4.3 transport with the current working tree.
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as candidate from '../lib/engine.js';
import { normalizeConfig } from '../index.js';

const root = fileURLToPath(new URL('../', import.meta.url));
let source = execFileSync('git', ['show', 'v0.4.3:lib/engine.js'], { cwd: root, encoding: 'utf8' });
for (const name of ['util', 'channels']) source = source.replace(`'./${name}.js'`, JSON.stringify(new URL(`../lib/${name}.js`, import.meta.url).href));
const baseline = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
const versions = { baseline: '0.4.3', candidate: JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')).version };
let requests = 0;
const server = http.createServer((req, res) => {
  req.resume(); req.on('end', () => {
    requests++;
    res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '30' });
    res.end('{"error":"synthetic rate limit"}');
  });
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const endpoint = `http://127.0.0.1:${server.address().port}/decide`;
const config = normalizeConfig({ cacheTtlMs: 0, breakerFailures: 100 });
function setup(implementation) {
  const engine = implementation.createHttpEngine({ id: 'synthetic', endpoint, model: 'synthetic', resolveKey: () => 'synthetic-key' });
  return implementation.createDecisionPipeline({ config, engines: [engine] });
}
const rows = [];
try {
  for (let pair = 0; pair < 8; pair++) {
    for (const arm of pair % 2 ? ['candidate', 'baseline'] : ['baseline', 'candidate']) {
      const pipeline = setup(arm === 'baseline' ? baseline : candidate);
      const before = requests, started = performance.now();
      const outcome = await pipeline.decide({ channel: 'authorize', state: 'Synthetic only', timeoutMs: 250 });
      rows.push({ pair, arm, ms: Math.round((performance.now() - started) * 10) / 10,
        httpRequests: requests - before, ok: outcome.ok, via: outcome.via });
    }
  }
  const burst = {};
  for (const [arm, implementation] of Object.entries({ baseline, candidate })) {
    const pipeline = setup(implementation), before = requests, started = performance.now();
    const outcomes = [];
    for (let i = 0; i < 5; i++) outcomes.push(await pipeline.decide({ channel: 'authorize', state: 'Synthetic-' + i, timeoutMs: 250 }));
    burst[arm] = { httpRequests: requests - before, ms: Math.round(performance.now() - started),
      unavailable: outcomes.filter(outcome => !outcome.ok).length, via: outcomes.map(outcome => outcome.via) };
  }
  const aggregate = {};
  for (const arm of ['baseline', 'candidate']) {
    const sample = rows.filter(row => row.arm === arm), sorted = sample.map(row => row.ms).sort((a, b) => a - b);
    aggregate[arm] = { n: sample.length, medianMs: (sorted[3] + sorted[4]) / 2, p95Ms: sorted[7],
      httpRequests: sample.reduce((sum, row) => sum + row.httpRequests, 0), unavailable: sample.filter(row => !row.ok).length };
  }
  const report = { measuredAt: new Date().toISOString(), versions, fixture: 'loopback 429; Retry-After: 30; 250ms decision budget',
    boundary: 'Fault-path latency only. No live-model, task-speed, cache-hit or safety-accuracy claim.', rows, aggregate, burst };
  const output = path.resolve(process.env.JEV_TRANSPORT_REPORT ?? path.join(root, 'bench/results/transport-budget.json'));
  await mkdir(path.dirname(output), { recursive: true }); await writeFile(output, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ output, aggregate, burst }, null, 2));
} finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
