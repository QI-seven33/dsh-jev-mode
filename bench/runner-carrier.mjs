// The official subprocess runner intentionally scrubs NODE_OPTIONS. Bootstrap
// the same ASAR binary loader explicitly before entering that official runner.
import './native-loader.mjs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const base = process.env.DSH_HOST_NODE_MODULES ?? 'E:/SOME_SEVEN_PROJECT-57/_recon/asar/dsh/node_modules';
await import(pathToFileURL(path.join(base, '@deepseek-ai/dsh-subprocess-local/lib/runner.js')).href);
