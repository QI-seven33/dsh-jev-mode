import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
const root = process.env.JEV_BENCH_ROOT ?? path.resolve('bench/results/sdk-smoke');
await mkdir(root, { recursive: true });
const cwd = path.join(root, 'project'); await mkdir(cwd, { recursive: true });
await writeFile(path.join(cwd, 'package.json'), '{"name":"jev-proof","dependencies":{"vite":"7.0.0"}}\n');
await writeFile(path.join(cwd, 'README.md'), '# jev-proof\nUse npm test.\n');
const patch = path.join(root, 'benchmark.patch.yml');
await writeFile(patch, `- id: credentials\n  config:\n    path: '${(process.env.DSH_CREDENTIALS_FILE ?? path.join(os.homedir(), '.dsh', '.credentials.yaml')).replaceAll('\\', '/').replaceAll("'", "''")}'\n    watch: false\n- id: approval\n  config:\n    policy: never\n- id: sandbox-policy\n  config:\n    mode: danger-full-access\n    workspaceRoot: '${cwd.replaceAll('\\', '/')}'\n- id: deepseek-account\n  config:\n    desktopPlatform: win32\n- insert:\n    - id: benchmark-observer\n      name: '${new URL('./observer.js', import.meta.url).href}'\n      config:\n        cwd: '${cwd.replaceAll('\\', '/')}'\n        traceFile: '${root.replaceAll('\\', '/')}/trace.jsonl'\n        allowedFiles: [package.json, README.md]\n` + (process.env.JEV_SMOKE_MODE === 'jev' ? `- insert:\n    - id: jev-benchmark-mode\n      name: '${pathToFileURL(path.resolve(fileURLToPath(new URL('../index.js', import.meta.url)))).href}'\n      config:\n        backend: typesafe\n        autoRoute: false\n        controlledFlow: true\n        protocol: compact\n        ledgerDir: '${root.replaceAll('\\', '/')}/ledger'\n` : ''));
const clientPath = process.env.DSH_SDK_CLIENT ?? 'E:/Deepseek-Harness/dsh-learn/deepseek-harness/packages/sdk/client/lib/index.js';
const { DeepSeekHarness } = await import(pathToFileURL(clientPath));
const loader = new URL('./native-loader.mjs', import.meta.url).href;
const harness = new DeepSeekHarness({
  dshBin: process.env.DSH_BIN ?? 'E:/SOME_SEVEN_PROJECT-57/_recon/asar/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js',
  dshHome: path.join(root, 'home'), profile: 'sdk', patches: [patch], cwd, processCwd: cwd,
  env: { ...process.env, NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --import=${loader}` },
  provider: 'deepseek-account', model: 'deepseek-flash', reasoningEffort: 'high', maxTokens: 4096,
  initializeTimeoutMs: 60000, requestTimeoutMs: 90000,
});
try {
  const start = Date.now(); const result = await harness.run(process.env.JEV_SMOKE_PROMPT ?? 'package.json 中的项目名称和依赖是什么？请简短回答。');
  const report = { mode: process.env.JEV_SMOKE_MODE ?? 'standard', ms: Date.now() - start,
    answer: result.finalResponse, steps: result.events.filter(e => e.type === 'step/start').length,
    calls: result.events.filter(e => e.type === 'tool/call').map(e => e.data.name),
    notices: result.events.filter(e => e.type === 'user/message' && e.data.source?.kind === 'plugin:dsh-jev-mode').map(e => e.data.source.summary),
    usage: result.events.filter(e => e.type === 'assistant/message').map(e => e.data.usage),
    toolErrors: result.events.filter(e => e.type === 'tool/result' && e.data.error).map(e => e.data.error),
    failures: result.events.filter(e => e.type === 'turn/end' || e.type === 'step/end').map(e => e.data),
  };
  await writeFile(path.join(root, 'result.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2));
} finally { await harness.close(); }
