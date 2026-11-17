import assert from 'node:assert/strict';
import { test } from 'node:test';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHttpNetwork, parseWindowsProxy, windowsBypasses } from '../lib/http-network.js';
import { createDecisionPipeline, createHttpEngine } from '../lib/engine.js';
import { createHostProxyLoader } from '../lib/host-proxy.js';
import { normalizeConfig } from '../index.js';

const env = values => ({ get: name => values[name] === undefined ? undefined : { value: values[name] } });
const registry = (server, override = '') => `\n ProxyEnable REG_DWORD 0x1\n ProxyServer REG_SZ ${server}\n ProxyOverride REG_SZ ${override}\n`;

test('missing host injection is a safe deployment error, without private path details', async () => {
  for (const ctx of [undefined, {get:()=>({installAnchor:'https://untrusted.invalid/package.json'})},
    {get:()=>({installAnchor:path.resolve('missing-host/package.json')})}]) {
    await assert.rejects(createHostProxyLoader(ctx)(), error => {
      assert.equal(error.code,'JEV_PROXY_MODULE_UNAVAILABLE');
      assert.equal(error.providerFailure,false);assert.equal(error.retryable,false);
      assert.match(error.message,/No HTTP request was sent/);
      assert.ok(!error.message.includes('missing-host') && !error.message.includes('untrusted.invalid'));
      return true;
    });
  }
});

test('deployment failure sends zero HTTP requests, does not retry or open the provider breaker', async () => {
  let sent = 0;
  const network = createHttpNetwork({environment:env({HTTPS_PROXY:'http://127.0.0.1:1'}),fetchFn:()=>{sent++;}});
  const engine = createHttpEngine({id:'typesafe',endpoint:'https://never-send.invalid',model:'jev-1.13.0',
    resolveKey:()=> 'synthetic',fetchFn:network.fetch});
  const pipeline = createDecisionPipeline({config:normalizeConfig({backend:'typesafe'}),engines:[engine]});
  try {
    for (let i=0;i<3;i++) {
      const outcome = await pipeline.decide({channel:'authorize',state:'synthetic '+i,timeoutMs:1000,cuts:{threshold:.85,askBand:.55}});
      assert.equal(outcome.ok,false);assert.match(outcome.reason,/JEV_PROXY_MODULE_UNAVAILABLE/);
      assert.equal(outcome.transport.httpRequests,0);assert.equal(outcome.transport.retries,0);
    }
    assert.equal(sent,0);assert.equal(pipeline.breaker.state().open,false);assert.equal(pipeline.breaker.state().consecutive,0);
  } finally {await network.dispose();}
});

test('Windows manual HTTP proxy parsing; disabled, PAC, SOCKS and malformed inputs', () => {
  assert.deepEqual(parseWindowsProxy(registry('127.0.0.1:7897', '<local>;*.example.test')), {
    http: 'http://127.0.0.1:7897/', https: 'http://127.0.0.1:7897/', bypass: '<local>;*.example.test',
  });
  assert.deepEqual(parseWindowsProxy(registry('https=proxy.test:8080;http=other.test:8081')), {
    http: 'http://other.test:8081/', https: 'http://proxy.test:8080/', bypass: '',
  });
  assert.equal(parseWindowsProxy('ProxyEnable REG_DWORD 0x0'), undefined);
  for (const text of ['AutoConfigURL REG_SZ https://example.test/proxy.pac', 'AutoDetect REG_DWORD 0x1',
    registry('socks=127.0.0.1:1'), registry('socks5://127.0.0.1:1'), registry('proxy.test/path'),
    registry('http=one:80;http=two:80'), registry('https=one:80;socks=two:80')]) {
    assert.throws(() => parseWindowsProxy(text), /JEV:/);
  }
});

test('Windows bypass keeps exact-host and wildcard semantics, including ports and local hosts', () => {
  const yes = (pattern, url) => assert.equal(windowsBypasses(pattern, new URL(url)), true);
  const no = (pattern, url) => assert.equal(windowsBypasses(pattern, new URL(url)), false);
  yes('<local>', 'http://intranet'); no('<local>', 'http://example.test');
  yes('*.example.test', 'https://api.example.test'); no('example.test', 'https://api.example.test');
  yes('192.168.*', 'http://192.168.1.2'); no('example.test', 'https://evil-example.test');
  yes('example.test:443', 'https://example.test'); no('example.test:80', 'https://example.test');
});

test('launch policy wins; dispatcher is scoped, shared and destroyed without environment changes', async () => {
  const before = { ...process.env }, seen = [];
  let reads = 0, creates = 0, destroys = 0;
  const dispatcher = { destroy: async () => { destroys++; } };
  const network = createHttpNetwork({ environment: env({ HTTPS_PROXY: 'http://explicit.test:1', NO_PROXY: 'private.test' }), platform: 'win32',
    readSystemProxy: () => { reads++; throw Error('must not read'); },
    loadProxy: async () => ({ createRouteDispatcher: async (values, options) => {
      creates++;
      assert.equal(values.get('HTTPS_PROXY').value, 'http://explicit.test:1');
      assert.equal(values.get('NO_PROXY').value, 'private.test');
      assert.equal(options.allowH2, false);
      return dispatcher;
    } }), fetchFn: async (url, init) => { seen.push(init); return 'ok'; } });
  const signal = AbortSignal.timeout(3000);
  assert.equal(await network.fetch('https://api.example.test', { signal, redirect: 'error', headers: { authorization: 'synthetic' } }), 'ok');
  await network.fetch('https://api.example.test');
  assert.equal(reads, 0); assert.equal(creates, 1);
  assert.equal(seen[0].dispatcher, dispatcher); assert.equal(seen[0].signal, signal);
  assert.equal(seen[0].redirect, 'error'); assert.equal(seen[0].headers.authorization, 'synthetic');
  assert.deepEqual({ ...process.env }, before);
  await network.dispose(); assert.equal(destroys, 1);
  await assert.rejects(network.fetch('https://api.example.test'), /disposed/);
});

test('system proxy refresh and bypass do not silently borrow a server for an unconfigured scheme', async () => {
  let reads = 0, time = 0, loads = 0;
  const seen = [];
  const network = createHttpNetwork({ environment: env({}), platform: 'win32', now: () => time,
    readSystemProxy: async () => { reads++; return { http: 'http://proxy.test:1', bypass: 'exact.test' }; },
    loadProxy: async () => ({ createRouteDispatcher: async () => { loads++; return { destroy() {} }; } }),
    fetchFn: async (_, init) => { seen.push(init.dispatcher); } });
  await network.fetch('https://api.example.test'); await network.fetch('http://exact.test');
  assert.deepEqual(seen, [undefined, undefined]); assert.equal(loads, 0);
  await network.fetch('http://api.example.test'); assert.ok(seen[2]);
  time = 30001; await network.fetch('http://api.example.test');
  assert.equal(reads, 2); assert.equal(loads, 1);
  await network.dispose();
});

test('cancel while reading settings starts no HTTP request; failed proxy never retries directly', async () => {
  let fetches = 0, release;
  const network = createHttpNetwork({ environment: env({}), platform: 'win32',
    readSystemProxy: () => new Promise(resolve => { release = resolve; }),
    fetchFn: () => { fetches++; } });
  const abort = new AbortController();
  const task = network.fetch('https://api.example.test', { signal: abort.signal });
  await new Promise(resolve => setImmediate(resolve)); abort.abort(Error('cancelled'));
  await assert.rejects(task, /cancelled/); release(undefined);
  await new Promise(resolve => setImmediate(resolve)); assert.equal(fetches, 0);
  await network.dispose();
  const failed = createHttpNetwork({ environment: env({ HTTPS_PROXY: 'http://proxy.test:1' }),
    loadProxy: async () => ({ createRouteDispatcher: async () => ({ destroy() {} }) }),
    fetchFn: () => { fetches++; throw Error('proxy failed'); } });
  await assert.rejects(failed.fetch('https://api.example.test'), /proxy failed/);
  assert.equal(fetches, 1); await failed.dispose();
  let finishRead, loads = 0;
  const closing = createHttpNetwork({ environment: env({}), platform: 'win32',
    readSystemProxy: () => new Promise(resolve => { finishRead = resolve; }),
    loadProxy: async () => { loads++; throw Error('must not load after disposal'); } });
  const pending = closing.fetch('https://api.example.test');
  await new Promise(resolve => setImmediate(resolve));
  await closing.dispose();
  finishRead({ http: 'http://proxy.test:1', https: 'http://proxy.test:1', bypass: '' });
  await assert.rejects(pending, /disposed/); assert.equal(loads, 0);
});

test('current native dispatcher really proxies requests, refuses redirects and bypasses loopback', async t => {
  const base = process.env.DSH_HOST_NODE_MODULES;
  if (!base) {
    if (process.env.DSH_ALLOW_SKIPPED_HOST_PERSISTENCE === '1') return t.skip('installed host required');
    throw Error('DSH_HOST_NODE_MODULES required');
  }
  const { getGlobalDispatcher } = await import(pathToFileURL(path.join(base, 'undici/index.js')));
  const globalBefore = getGlobalDispatcher(), envBefore = { ...process.env };
  const target = http.createServer((req, res) => {
    if (req.url === '/redirect') { res.writeHead(302, { location: 'http://never-follow.invalid/' }); res.end(); return; }
    if (req.url === '/limited') { res.writeHead(429, { 'retry-after': '60' }); res.end('not forwarded'); return; }
    if (req.url === '/decide') {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        assert.equal(req.method, 'POST');
        assert.equal(req.headers.authorization, 'Bearer synthetic');
        assert.equal(JSON.parse(body).model, 'jev-1.13.0');
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ answers: { authorize: { type: 'noul', noul: 0.06 } } }));
      });
      return;
    }
    res.writeHead(200, { 'content-type': 'text/plain' }); res.end('fixture');
  });
  await new Promise(resolve => target.listen(0, '127.0.0.1', resolve));
  const port = target.address().port, connects = [], forwards = [], sockets = new Set();
  const proxy = http.createServer((req, res) => {
    forwards.push(req.url);
    const url = new URL(req.url);
    const remote = http.request({ hostname: '127.0.0.1', port, path: url.pathname, method: req.method, headers: req.headers }, incoming => {
      res.writeHead(incoming.statusCode, incoming.headers); incoming.pipe(res);
    });
    remote.on('error', () => res.destroy()); req.pipe(remote);
  });
  proxy.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  proxy.on('connect', (req, socket, head) => {
    connects.push(req.url);
    const remote = net.connect(port, '127.0.0.1', () => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) remote.write(head);
      socket.pipe(remote); remote.pipe(socket);
    });
    socket.on('error', () => remote.destroy()); remote.on('error', () => socket.destroy());
    socket.on('close', () => remote.destroy());
  });
  await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
  const proxyUrl = `http://127.0.0.1:${proxy.address().port}`;
  const hostContext = {get:name=>name === 'profileContext' ? {installAnchor:path.resolve(base,'../package.json')} : undefined};
  const network = createHttpNetwork({ hostContext, environment: env({}), platform: 'win32',
    readSystemProxy: async () => parseWindowsProxy(registry(proxyUrl)) });
  try {
    assert.equal(await (await network.fetch(`http://synthetic.invalid:${port}/test`, { signal: AbortSignal.timeout(3000) })).text(), 'fixture');
    assert.equal(connects.length + forwards.length, 1);
    assert.ok(connects[0] === `synthetic.invalid:${port}` || forwards[0] === `http://synthetic.invalid:${port}/test`);
    assert.equal(await (await network.fetch(`http://127.0.0.1:${port}/test`, { signal: AbortSignal.timeout(3000) })).text(), 'fixture');
    assert.equal(connects.length + forwards.length, 1);
    await assert.rejects(network.fetch(`http://synthetic.invalid:${port}/redirect`, {
      redirect: 'error', signal: AbortSignal.timeout(3000),
    }), /redirect refused/);
    assert.equal(connects.length + forwards.length, 2);
    const engine = endpoint => createHttpEngine({ id: 'typesafe', endpoint, model: 'jev-1.13.0',
      resolveKey: () => 'synthetic', retries: 0, fetchFn: network.fetch });
    const ask = selected => selected.ask({ channel: 'authorize', state: 'synthetic only', signal: AbortSignal.timeout(3000) });
    assert.equal((await ask(engine(`http://synthetic.invalid:${port}/decide`))).answers.authorize.noul, 0.06);
    const limited = engine(`http://synthetic.invalid:${port}/limited`);
    await assert.rejects(ask(limited), error => error.status === 429);
    const afterLimited = connects.length + forwards.length;
    await assert.rejects(ask(limited), error => error.code === 'PROVIDER_COOLDOWN');
    assert.equal(connects.length + forwards.length, afterLimited);
    assert.equal(getGlobalDispatcher(), globalBefore); assert.deepEqual({ ...process.env }, envBefore);
  } finally {
    await network.dispose();
    for (const socket of sockets) socket.destroy();
    target.closeAllConnections();
    await Promise.all([new Promise(resolve => proxy.close(resolve)), new Promise(resolve => target.close(resolve))]);
  }
});
