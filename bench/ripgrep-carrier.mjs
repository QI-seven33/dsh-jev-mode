// The extracted ASAR omits optional platform-package metadata. Use the exact
// binary from that installed application's unpacked directory, not another rg.
import path from 'node:path';
import { existsSync } from 'node:fs';
const native = process.env.DSH_HOST_NATIVE_NODE_MODULES ?? 'E:/Deepseek-Harness/dsh-desktop/resources/app.asar.unpacked/dsh/node_modules';
export const rgPath = path.join(native, `@vscode/ripgrep-${process.platform}-${process.arch}`, 'bin', process.platform === 'win32' ? 'rg.exe' : 'rg');
if (!existsSync(rgPath)) throw Error('benchmark carrier missing installed ripgrep binary');
