// Request-scoped networking. Never install a global dispatcher or change proxy
// settings: an existing HTTP proxy still decides its own rules for each domain.
import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import { createHostProxyLoader } from './host-proxy.js';

const runFile = promisify(execFile);
const PROXY_NAMES = ['https_proxy', 'HTTPS_PROXY', 'http_proxy', 'HTTP_PROXY', 'all_proxy', 'ALL_PROXY'];
const NAMES = [...PROXY_NAMES, 'no_proxy', 'NO_PROXY'];
const REGISTRY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';

export function parseWindowsProxy(text) {
  const values = {};
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*(ProxyEnable|ProxyServer|ProxyOverride|AutoConfigURL|AutoDetect)\s+REG_\w+\s+(.*?)\s*$/.exec(line);
    if (match) values[match[1]] = match[2];
  }
  if (Number(values.ProxyEnable) !== 1) {
    if (values.AutoConfigURL || Number(values.AutoDetect) === 1) throw Error('JEV: automatic system proxy (PAC/WPAD) is unsupported; configure an HTTP proxy in Harness');
    return undefined;
  }
  const server = values.ProxyServer?.trim();
  if (!server) throw Error('JEV: enabled system proxy has no server');
  const valid = value => {
    try {
      const url = new URL(value.includes('://') ? value : `http://${value}`);
      if (!['http:', 'https:'].includes(url.protocol) || url.pathname !== '/' || url.search || url.hash) throw Error();
      return url.href;
    } catch { throw Error('JEV: system proxy requires a valid HTTP(S) server'); }
  };
  let http, https;
  if (server.includes('=')) {
    const entries = server.split(';').map(entry => entry.trim()).filter(Boolean);
    const schemes = new Map();
    for (const entry of entries) {
      const equal = entry.indexOf('=');
      if (equal < 1) throw Error('JEV: unsupported system proxy configuration');
      const scheme = entry.slice(0, equal).trim().toLowerCase();
      if (!['http', 'https', 'ftp'].includes(scheme)) throw Error('JEV: system proxy requires an HTTP(S) server; SOCKS is unsupported');
      if (schemes.has(scheme)) throw Error('JEV: ambiguous system proxy configuration');
      schemes.set(scheme, entry.slice(equal + 1).trim());
    }
    http = schemes.has('http') ? valid(schemes.get('http')) : undefined;
    https = schemes.has('https') ? valid(schemes.get('https')) : undefined;
    if (!http && !https) throw Error('JEV: system proxy requires an HTTP(S) server; SOCKS is unsupported');
  } else http = https = valid(server);
  return { http, https, bypass: values.ProxyOverride ?? '' };
}

export function windowsBypasses(bypass, url) {
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  const port = url.port || (url.protocol === 'https:' ? '443' : '80');
  return bypass.split(';').some(raw => {
    const entry = raw.trim().toLowerCase();
    if (!entry) return false;
    if (entry === '<local>') return !host.includes('.') && !host.includes(':');
    // Windows uses exact hosts and wildcard patterns, not NO_PROXY suffixes.
    const pattern = entry.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
    return new RegExp(`^(?:${pattern})$`).test(host) || new RegExp(`^(?:${pattern})$`).test(`${host}:${port}`);
  });
}

export async function readWindowsProxy({ environment } = {}) {
  const systemRoot = environment?.getFrom?.('SystemRoot', ['process'])?.value ?? process.env.SystemRoot;
  if (!systemRoot || !path.win32.isAbsolute(systemRoot)) throw Error('JEV: cannot locate Windows system proxy reader');
  try {
    const { stdout } = await runFile(path.win32.join(systemRoot, 'System32', 'reg.exe'), ['query', REGISTRY], {
      encoding: 'utf8', timeout: 1200, maxBuffer: 65536, windowsHide: true,
    });
    return parseWindowsProxy(stdout);
  } catch (error) {
    if (error.message?.startsWith('JEV:')) throw error;
    // Never copy raw registry/process errors: proxy URLs can contain passwords.
    throw Error('JEV: could not read Windows system proxy');
  }
}

function cancellable(promise, signal) {
  if (!signal) return promise;
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason ?? Error('aborted'));
    signal.addEventListener('abort', abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

// Use the dispatcher's own public request API. Passing a host undici v8
// dispatcher to an older Node built-in fetch mixes incompatible handler APIs.
// This small response surface is private to createHttpEngine (POST JSON only).
async function decisionFetch(input, init) {
  if (!init.dispatcher) return globalThis.fetch(input, init);
  const url = new URL(input);
  const response = await init.dispatcher.request({ origin: url.origin, path: url.pathname + url.search,
    method: init.method ?? 'GET', headers: init.headers, body: init.body, signal: init.signal, maxRedirections: 0 });
  const cancel = async () => {
    response.body.on('error', () => {});
    response.body.destroy();
  };
  if (response.statusCode >= 300 && response.statusCode < 400 && init.redirect === 'error') {
    await cancel();
    throw Error('JEV: HTTP redirect refused');
  }
  return { ok: response.statusCode >= 200 && response.statusCode < 300, status: response.statusCode,
    headers: { get: name => {
      const value = response.headers[name.toLowerCase()];
      return Array.isArray(value) ? value.join(', ') : value ?? null;
    } },
    body: { cancel },
    json: () => response.body.json(), text: () => response.body.text() };
}

export function createHttpNetwork({ hostContext, environment, platform = process.platform, fetchFn = decisionFetch,
  readSystemProxy = readWindowsProxy, loadProxy = createHostProxyLoader(hostContext), now = Date.now } = {}) {
  // Capture only launch-time proxy names. Project working-directory changes do
  // not replace transport policy, and no proxy credentials enter model state.
  const entries = Object.fromEntries(NAMES.map(name => [name, environment ? environment.get(name)?.value : process.env[name]]));
  const explicit = PROXY_NAMES.some(name => entries[name] !== undefined);
  const dispatchers = new Map();
  let system, expires = 0, disposed = false;
  async function route(url) {
    if (!explicit && platform !== 'win32') return undefined;
    let selected = entries;
    if (!explicit) {
      if (!system || now() >= expires) {
        system = Promise.resolve().then(() => readSystemProxy({ environment }));
        expires = now() + 30_000;
      }
      const proxy = await system;
      if (disposed) throw Error('JEV: network disposed');
      if (!proxy || windowsBypasses(proxy.bypass, url)) return undefined;
      if (url.protocol === 'https:' ? !proxy.https : !proxy.http) return undefined;
      selected = { http_proxy: proxy.http ?? '', https_proxy: proxy.https ?? '', no_proxy: entries.no_proxy ?? entries.NO_PROXY };
    }
    const key = JSON.stringify(selected);
    if (!dispatchers.has(key)) {
      if (dispatchers.size >= 8) throw Error('JEV: proxy configuration changed repeatedly; restart the session');
      dispatchers.set(key, loadProxy().then(module => module.createRouteDispatcher({
        get: name => selected[name] === undefined ? undefined : { value: selected[name] },
      }, { allowH2: false })));
    }
    return dispatchers.get(key);
  }
  return {
    async fetch(input, init = {}) {
      if (disposed) throw Error('JEV: network disposed');
      init.signal?.throwIfAborted();
      const dispatcher = await cancellable(route(new URL(input)), init.signal);
      init.signal?.throwIfAborted();
      if (disposed) throw Error('JEV: network disposed');
      // A failed proxy request never triggers a direct fallback.
      return fetchFn(input, dispatcher ? { ...init, dispatcher } : init);
    },
    async dispose() {
      disposed = true;
      await Promise.allSettled([...dispatchers.values()].map(async promise => (await promise).destroy()));
    },
  };
}
