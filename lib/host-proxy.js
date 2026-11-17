// Resolve a public host export from the host-owned installation anchor. The
// plugin may be a junction outside the profile; its own ancestor node_modules
// chain and optional global resolver hooks are not an installation contract.
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export function proxyModuleUnavailable() {
  const error = new Error('JEV: host proxy module unavailable; repair the Harness installation or use the standard preset (JEV_PROXY_MODULE_UNAVAILABLE). No HTTP request was sent.');
  error.code = 'JEV_PROXY_MODULE_UNAVAILABLE';
  error.providerFailure = false;
  error.retryable = false;
  return error;
}

export function createHostProxyLoader(ctx) {
  let loaded;
  return () => loaded ??= (async () => {
    try {
      // This is injected by the profile launcher, never supplied by model/tool
      // arguments, a workspace search, process.cwd(), or an inferred ASAR path.
      const anchor = ctx?.get?.('profileContext')?.installAnchor;
      if (typeof anchor !== 'string' || !path.isAbsolute(anchor)) throw proxyModuleUnavailable();
      const entry = createRequire(anchor).resolve('@deepseek-ai/dsh-http-proxy');
      const module = await import(pathToFileURL(entry).href);
      if (typeof module.createRouteDispatcher !== 'function') throw proxyModuleUnavailable();
      return module;
    } catch {
      // Do not leak filesystem locations, registry data or nested module errors.
      throw proxyModuleUnavailable();
    }
  })();
}
