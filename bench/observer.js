// Benchmark-only sandbox: no real shell/network/publish/delete can execute.
// Both arms use this identical guard. No prompt sections or tools are added.
import { appendFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
export const name = 'jev-benchmark-observer';
export const inject = ['tools', 'llm', 'subprocess'];
const hash = v => createHash('sha256').update(JSON.stringify(v)).digest('hex').slice(0, 32);
export function apply(ctx, config) {
  // An extracted ASAR is not a packaged desktop carrier: its private Win32
  // Job bootstrap cannot reload omitted native files. For short-lived rg only,
  // use the official subprocess provider's documented test platform seam to
  // select its Node process-group fallback. Both arms share it; the strict
  // tool boundary still excludes all user-authored commands and network tools.
  if (ctx.subprocess?.internals && process.platform === 'win32') ctx.subprocess.internals.platform = 'benchmark-node';
  let previous, calls = 0;
  let writes = Promise.resolve();
  const record = row => { writes = writes.then(() => appendFile(config.traceFile, `${JSON.stringify(row)}\n`)); return writes; };
  ctx.on('llm/stream', (options, next) => (async function* () {
    if (++calls > 12) throw Error('benchmark main-model call bound exceeded');
    const started = Date.now();
    const prefixPreserved = previous ? hash(options.messages.slice(0, previous.messages.length)) === hash(previous.messages) : null;
    const toolsUnchanged = previous ? hash(options.tools) === hash(previous.tools) : null;
    previous = { messages: options.messages, tools: options.tools };
    let usage, finish;
    try {
      for await (const chunk of next()) {
        if (chunk.type === 'usage') usage = chunk.usage;
        if (chunk.type === 'finish') finish = chunk.reason?.kind;
        yield chunk;
      }
    } finally {
      await record({ kind: 'main', ms: Date.now() - started, toolsHash: hash(options.tools), prefixPreserved, toolsUnchanged,
        usage: usage ?? null, finish: finish ?? 'failed' });
    }
  })());
  const paths = new Set(config.allowedFiles.map(p => path.resolve(config.cwd, p).toLowerCase()));
  ctx.on('tools/pre-execute', async (exec, next) => {
    if (['jev_decide', 'jev_gate', 'jev_status'].includes(exec.name)) return next();
    const target = exec.arguments?.file_path;
    const searchRoot = exec.arguments?.path ?? '.';
    const searchPattern = exec.arguments?.pattern ?? '';
    const allowed = (['read', 'write', 'edit'].includes(exec.name) && typeof target === 'string' && paths.has(path.resolve(config.cwd, target).toLowerCase()))
      || (['glob', 'grep'].includes(exec.name) && typeof searchRoot === 'string' && path.resolve(config.cwd, searchRoot).toLowerCase() === path.resolve(config.cwd).toLowerCase()
        && (exec.name === 'grep' || (typeof searchPattern === 'string' && !/(?:^|[\\/])\.\.(?:[\\/]|$)|^[\\/]|^[a-z]:/i.test(searchPattern))));
    await record({ kind: 'tool-attempt', tool: exec.name, controlled: exec.callId.startsWith('jev-controlled-'), allowedByTestBoundary: allowed });
    if (!allowed) return { kind: 'deny', reason: 'Isolated benchmark test boundary: tool body was not executed' };
    return next();
  }, { prepend: true });
  ctx.on('tools/result', (exec, result) => { void record({ kind: 'tool-result', tool: exec.name,
    controlled: exec.callId.startsWith('jev-controlled-'), isError: result.isError === true, code: result.error?.code ?? null }); });
  ctx.effect(() => async () => { await writes; }, 'benchmark.flush');
}
