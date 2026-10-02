// Test/benchmark carrier only: match installed ASAR native binaries.
import { registerHooks } from 'node:module';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const base = process.env.DSH_HOST_NODE_MODULES ?? 'E:/SOME_SEVEN_PROJECT-57/_recon/asar/dsh/node_modules';
const native = process.env.DSH_HOST_NATIVE_NODE_MODULES ?? 'E:/Deepseek-Harness/dsh-desktop/resources/app.asar.unpacked/dsh/node_modules';
registerHooks({ resolve(specifier, context, next) {
  if (specifier === '@vscode/ripgrep') return next(new URL('./ripgrep-carrier.mjs', import.meta.url).href, context);
  if (specifier === '@deepseek-ai/dsh-subprocess-local/runner') return next(new URL('./runner-carrier.mjs', import.meta.url).href, context);
  if (/^@vscode\/ripgrep-[^/]+\/bin\/rg(?:\.exe)?$/.test(specifier)) {
    const actual = path.join(native, specifier);
    if (existsSync(actual)) return next(actual, context);
  }
  if (specifier.endsWith('.node') && context.parentURL?.startsWith('file:')) {
    const original = path.resolve(path.dirname(fileURLToPath(context.parentURL)), specifier);
    const rel = path.relative(base, original), actual = path.join(native, rel);
    if (!rel.startsWith('..') && !existsSync(original) && existsSync(actual)) return next(actual, context);
  }
  return next(specifier, context);
} });
