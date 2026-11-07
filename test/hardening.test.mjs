import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { request as httpRequest } from 'node:http';
import { toM3u, safeHeaders, sensitiveHeader, PLAYLIST_FORMAT } from '../src/playlist.mjs';
import { PlaylistService, retryAfterMs } from '../src/service.mjs';
import { allowedPort, assertPublicUrl } from '../src/network.mjs';
import { createApp, parseTokenList } from '../src/http.mjs';
import { SettingsService } from '../src/settings.mjs';
import { AggregateService } from '../src/aggregate.mjs';

const payload = () => ({ success: true, channels: [
  { id: 'a', tvgId: 'news.id', name: 'News', groupTitle: 'News', headers: { Authorization: 'Bearer upstream', Referer: 'https://origin.test/' }, sources: [
    { url: 'https://media.test/a.m3u8', headers: { 'User-Agent': 'Player', Cookie: 'sid=1' } },
    { url: 'http://plain.test/b.m3u8', headers: {} },
  ] },
] });

async function serve(t, options) {
  const server = createApp(options);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  return { base: `http://127.0.0.1:${server.address().port}`, server };
}

const liveService = () => ({ data: payload(), fetchedAt: '2026-11-07T00:00:00.000Z', lastAttemptAt: null,
  status: () => ({ state: 'ready', revision: 'rev-123', channelCount: 1, sourceCount: 2 }), getCatalog: () => [] });

test('sensitive headers never reach the exported playlist', () => {
  assert.ok(sensitiveHeader('Authorization'));
  assert.ok(sensitiveHeader('X-Api-Key'));
  assert.ok(sensitiveHeader('X-Session-Token'));
  assert.ok(!sensitiveHeader('User-Agent'));
  assert.deepEqual(safeHeaders({ Authorization: 'secret', Cookie: 'sid', Referer: 'https://origin.test/', 'X-Evil': 'v\r\nInjected: 1' }),
    { referer: 'https://origin.test/', 'x-evil': 'v  Injected: 1' });
  const m3u = toM3u(payload());
  assert.ok(!/upstream|sid=1|Bearer/i.test(m3u), m3u);
  assert.ok(m3u.includes('http-user-agent=Player'));
});

test('marker line exposes format, revision and totals without changing entries', () => {
  const m3u = toM3u(payload(), {}, { revision: 'rev-123', updatedAt: '2026-11-07T00:00:00.000Z', state: 'ready' });
  const lines = m3u.split('\n');
  assert.equal(lines[0], '#EXTM3U');
  assert.equal(lines[1], `#COSMIC:format=${PLAYLIST_FORMAT} revision=rev-123 updated-at=2026-11-07T00:00:00.000Z state=ready channels=1 streams=2`);
  assert.equal(m3u.match(/^#EXTINF:/gm).length, 2, 'one entry per stream');
  assert.ok(!toM3u(payload()).includes('#COSMIC:'), 'marker only when meta is provided');
});

test('cleartext sources are marked and can be filtered out', () => {
  const mixed = toM3u(payload());
  assert.ok(mixed.includes('x-cosmic-cleartext="1"'));
  assert.match(mixed, /^http:\/\/plain\.test/m);
  const secure = toM3u(payload(), { scheme: 'https' });
  assert.ok(!secure.includes('plain.test'));
  assert.ok(!secure.includes('x-cosmic-cleartext'));
});

test('read token list parsing ignores short entries', () => {
  assert.deepEqual(parseTokenList(' short , abcdefghijklmnop ,,second-token-value-123456'), ['abcdefghijklmnop', 'second-token-value-123456']);
  assert.deepEqual(parseTokenList(undefined), []);
});

test('read endpoints require a token once READ_TOKENS is configured', async t => {
  const { base } = await serve(t, { service: liveService(), adminToken: 'admin-test', publicDir: '', allowAdmin: false, readTokens: ['client-token-value-123456'] });
  assert.equal((await fetch(`${base}/playlist.m3u`)).status, 401);
  const wrong = await fetch(`${base}/playlist.m3u`, { headers: { Authorization: 'Bearer nope' } });
  assert.equal(wrong.status, 401);
  assert.equal(wrong.headers.get('www-authenticate'), 'Bearer realm="cosmic-tv"');
  assert.equal((await fetch(`${base}/playlist.m3u`, { headers: { Authorization: 'Bearer client-token-value-123456' } })).status, 200);
  assert.equal((await fetch(`${base}/playlist.m3u?token=client-token-value-123456`)).status, 200);
  assert.equal((await fetch(`${base}/api/v1/channels`, { headers: { Authorization: 'Bearer client-token-value-123456' } })).status, 200);
  assert.equal((await fetch(`${base}/api/v1/catalog`)).status, 401);
  assert.equal((await fetch(`${base}/api/v1/status`)).status, 200);
});

test('read-only listener hides dashboard and management routes entirely', async t => {
  const { base } = await serve(t, { service: liveService(), adminToken: 'admin-test', publicDir: '', allowAdmin: false });
  assert.equal((await fetch(`${base}/`)).status, 404);
  assert.equal((await fetch(`${base}/api/v1/refresh`, { method: 'POST', headers: { Authorization: 'Bearer admin-test' } })).status, 404);
  assert.equal((await fetch(`${base}/api/v1/sources`, { headers: { Authorization: 'Bearer admin-test' } })).status, 404);
  assert.equal((await fetch(`${base}/playlist.m3u`)).status, 200);
});

test('responses are private by default and expose the marker through the API', async t => {
  const { base } = await serve(t, { service: liveService(), adminToken: 'admin-test', publicDir: '', allowAdmin: true });
  const response = await fetch(`${base}/playlist.m3u`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('cache-control'), /^private/);
  assert.equal(response.headers.get('vary'), 'Authorization');
  assert.equal(response.headers.get('x-playlist-state'), 'ready');
  const text = await response.text();
  assert.ok(text.includes('revision=rev-123'));
  const channels = await fetch(`${base}/api/v1/channels`);
  assert.match(channels.headers.get('cache-control'), /^private/);
});

test('rate limiting answers 429 with Retry-After', async t => {
  const { base } = await serve(t, { service: liveService(), adminToken: 'admin-test', publicDir: '', allowAdmin: false, rateLimit: 3 });
  for (let i = 0; i < 3; i++) assert.equal((await fetch(`${base}/api/v1/status`)).status, 200);
  const limited = await fetch(`${base}/api/v1/status`);
  assert.equal(limited.status, 429);
  assert.ok(Number(limited.headers.get('retry-after')) >= 1);
});

test('invalid JSON is 400 while unexpected service failures are 500', async t => {
  const service = { ...liveService(), getSelection: () => ({ channelIds: [] }), listSources: () => [], async addSource() { const error = new Error('disk on fire'); error.code = 'EIO'; throw error; },
    async setSelection() { throw new Error('Pilih maksimal 3.000 ID channel yang valid.'); } };
  const { base } = await serve(t, { service, adminToken: 'admin-test', publicDir: '', allowAdmin: true, rateLimit: 0 });
  const headers = { Authorization: 'Bearer admin-test', 'Content-Type': 'application/json' };
  const bad = await fetch(`${base}/api/v1/sources`, { method: 'POST', headers, body: '{nope' });
  assert.equal(bad.status, 400);
  assert.match((await bad.json()).error, /JSON/);
  const failed = await fetch(`${base}/api/v1/sources`, { method: 'POST', headers, body: JSON.stringify({ name: 'x', url: 'https://feed.test/list.m3u' }) });
  assert.equal(failed.status, 500);
  assert.equal((await failed.json()).error, 'Permintaan gagal diproses.');
  const selection = await fetch(`${base}/api/v1/selection`, { method: 'PUT', headers, body: JSON.stringify({ channelIds: [] }) });
  assert.equal(selection.status, 400);
});

test('Retry-After parsing accepts seconds and HTTP dates and caps the wait', () => {
  assert.equal(retryAfterMs('120'), 120000);
  assert.equal(retryAfterMs('999999'), 86400000);
  assert.equal(retryAfterMs(new Date(Date.now() + 60000).toUTCString()) > 55000, true);
  assert.equal(retryAfterMs(undefined), null);
  assert.equal(retryAfterMs('not-a-date'), null);
});

test('backoff grows on failure, honours Retry-After and resets on success', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'backoff-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  let mode = 'ok';
  const service = new PlaylistService({ cacheFile: join(dir, 'snapshot.json'), upstream: 'https://upstream.test/channels', secret: 's', deviceId: 'd', refreshSeconds: 60,
    fetcher: async () => mode === 'ok' ? Response.json(payload()) : mode === 'retry' ? new Response('slow down', { status: 429, headers: { 'retry-after': '90' } }) : new Response('denied', { status: 403 }) });
  assert.equal(service.nextDelayMs(), 60000);
  mode = 'retry';
  assert.equal(await service.refresh(), false);
  assert.equal(service.status().lastStatus, 429);
  assert.equal(service.status().lastErrorKind, 'rate-limited');
  assert.ok(Math.abs(service.nextDelayMs() - 90000) < 2000, 'Retry-After wins over the base interval');
  mode = 'denied';
  await service.refresh();
  assert.equal(service.status().lastErrorKind, 'denied');
  assert.equal(service.failures, 2);
  assert.ok(service.nextDelayMs() >= 120000);
  mode = 'ok';
  assert.equal(await service.refresh(), true);
  assert.equal(service.failures, 0);
  assert.equal(service.retryAt, null);
  assert.equal(service.nextDelayMs(), 60000);
});

test('destination ports are constrained without breaking media providers on high ports', async () => {
  assert.equal(allowedPort(443), true);
  assert.equal(allowedPort(80), true);
  assert.equal(allowedPort(8443), true);
  assert.equal(allowedPort(1935), true);
  assert.equal(allowedPort(22), false);
  assert.equal(allowedPort(6379), false);
  assert.equal(allowedPort(22, [22]), true);
  assert.equal(allowedPort(0), false);
  const resolver = async () => [{ address: '93.184.216.34', family: 4 }];
  await assert.rejects(() => assertPublicUrl('http://example.test:22/', resolver), /Port/);
  await assert.rejects(() => assertPublicUrl('http://example.test:6379/', resolver), /Port/);
  assert.equal((await assertPublicUrl('http://example.test:8080/', resolver)).url.port, '8080');
});

test('only selected channels are probed by default', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'probe-scope-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const data = { success: true, channels: [
    { id: 'one', tvgId: 'one.id', name: 'One', sources: [{ url: 'https://media.test/one.m3u8' }] },
    { id: 'two', tvgId: 'two.id', name: 'Two', sources: [{ url: 'https://media.test/two.m3u8' }] },
  ] };
  let probes = 0;
  const primary = { data: null, async refresh() { this.data = data; return true; } };
  const service = new AggregateService({ primary, directory: dir, refreshSeconds: 900, verificationSeconds: 1800, reuseSeconds: 0,
    probe: async () => { probes++; return { state: 'working', reason: 'ok', checkedAt: new Date().toISOString() }; } });
  await service.load();
  await service.refresh();
  assert.equal(probes, 2, 'both channels are selected after the first import');
  const [first, second] = service.getCatalog();
  await service.setSelection([first.id]);
  probes = 0;
  await service.refresh();
  assert.equal(probes, 1, 'unselected channels are no longer probed');
  assert.equal(service.status().probeSelectedOnly, true);
  await service.setSelection([first.id, second.id]);
  probes = 0;
  await service.refresh();
  assert.equal(probes, 2);
});

test('loopback admin on the public listener is opt-in and local traffic skips the read token', async t => {
  const options = { service: liveService(), adminToken: 'admin-test', publicDir: '', allowAdmin: false, readTokens: ['client-token-value-123456'] };
  const closed = await serve(t, options);
  assert.equal((await fetch(`${closed.base}/`)).status, 404);
  assert.equal((await fetch(`${closed.base}/api/v1/catalog`)).status, 401);

  const open = await serve(t, { ...options, allowLoopbackAdmin: true, readTokenRequired: true });
  assert.equal((await fetch(`${open.base}/api/v1/catalog`)).status, 200, 'loopback reads do not need the token');
  const refresh = await fetch(`${open.base}/api/v1/refresh`, { method: 'POST' });
  assert.equal(refresh.status, 401, 'mutations still need the admin token');
  const runtime = await (await fetch(`${open.base}/runtime.js`)).text();
  assert.match(runtime, /COSMIC_READ_TOKEN_REQUIRED = true/);
});

test('admin token also authorises reads so the panel works on the public port', async t => {
  const { base } = await serve(t, { service: liveService(), adminToken: 'admin-test', publicDir: '', allowAdmin: false, readTokens: ['client-token-value-123456'] });
  assert.equal((await fetch(`${base}/api/v1/channels`)).status, 401);
  const admin = await fetch(`${base}/api/v1/channels`, { headers: { Authorization: 'Bearer admin-test' } });
  assert.equal(admin.status, 200);
  assert.equal((await fetch(`${base}/api/v1/status`, { headers: { Authorization: 'Bearer admin-test' } })).status, 200);
});

test('server endpoint setting is admin-only, validated and persisted', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'settings-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const settings = new SettingsService({ file: join(dir, 'settings.json'), defaults: { publicOrigin: 'http://127.0.0.1:8787' } });
  await settings.load();
  const { base } = await serve(t, { service: liveService(), settings, adminToken: 'admin-test', publicDir: '', allowAdmin: true, rateLimit: 0 });
  const headers = { Authorization: 'Bearer admin-test', 'Content-Type': 'application/json' };

  assert.equal((await fetch(`${base}/api/v1/settings`)).status, 401);
  assert.equal((await (await fetch(`${base}/api/v1/settings`, { headers })).json()).publicOrigin, 'http://127.0.0.1:8787');

  for (const bad of ['https://tv.example.test/path', 'ftp://tv.example.test', 'https://user:pw@tv.example.test', 'http://tv.example.test', 'nonsense']) {
    const response = await fetch(`${base}/api/v1/settings`, { method: 'PUT', headers, body: JSON.stringify({ publicOrigin: bad }) });
    assert.equal(response.status, 400, `rejected ${bad}`);
  }
  for (const local of ['http://10.10.12.50:8787', 'http://192.168.1.20:9000', 'http://localhost:8787']) {
    const response = await fetch(`${base}/api/v1/settings`, { method: 'PUT', headers, body: JSON.stringify({ publicOrigin: local }) });
    assert.equal(response.status, 200, `accepted ${local}`);
    assert.equal((await response.json()).publicOrigin, local);
  }

  const saved = await fetch(`${base}/api/v1/settings`, { method: 'PUT', headers, body: JSON.stringify({ publicOrigin: 'https://tv.example.test/' }) });
  assert.equal(saved.status, 200);
  assert.equal((await saved.json()).publicOrigin, 'https://tv.example.test');
  assert.equal(JSON.parse(await readFile(join(dir, 'settings.json'), 'utf8')).publicOrigin, 'https://tv.example.test');
  const runtime = await (await fetch(`${base}/runtime.js`)).text();
  assert.match(runtime, /tv\.example\.test/);
});

test('public and admin listeners can run side by side', async t => {
  const service = liveService();
  const admin = await serve(t, { service, adminToken: 'admin-test', publicDir: '', allowAdmin: true, publicOrigin: 'https://tv.example.test' });
  const publicOnly = await serve(t, { service, adminToken: 'admin-test', publicDir: '', allowAdmin: false, publicOrigin: 'https://tv.example.test' });
  assert.equal((await fetch(`${admin.base}/api/v1/status`)).status, 200);
  assert.equal((await fetch(`${publicOnly.base}/api/v1/status`)).status, 200);
  const runtime = await (await fetch(`${publicOnly.base}/runtime.js`)).text();
  assert.match(runtime, /tv\.example\.test/);
  assert.equal((await fetch(`${admin.base}/api/v1/refresh`, { method: 'POST' })).status, 401);
  assert.equal((await fetch(`${publicOnly.base}/api/v1/refresh`, { method: 'POST' })).status, 404);
});

test('HEAD and conditional requests still work on the public listener', async t => {
  const { base } = await serve(t, { service: liveService(), adminToken: 'admin-test', publicDir: '', allowAdmin: false });
  const head = await fetch(`${base}/playlist.m3u`, { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.ok(Number(head.headers.get('content-length')) > 0);
  const etag = head.headers.get('etag');
  assert.equal((await fetch(`${base}/playlist.m3u`, { headers: { 'If-None-Match': etag } })).status, 304);
});

test('oversized JSON bodies are rejected with 413', async t => {
  const service = { ...liveService(), async addSource() { return { id: 'x' }; }, listSources: () => [] };
  const { base } = await serve(t, { service, adminToken: 'admin-test', publicDir: '', allowAdmin: true, rateLimit: 0 });
  const body = JSON.stringify({ name: 'x', url: 'https://feed.test/a.m3u', content: 'a'.repeat(3 * 1024 * 1024 + 10) });
  const response = await new Promise((resolve, reject) => {
    const req = httpRequest(`${base}/api/v1/sources`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer admin-test', 'Content-Length': Buffer.byteLength(body) } }, res => {
      let text = ''; res.on('data', chunk => { text += chunk; }); res.on('end', () => resolve({ status: res.statusCode, text }));
    });
    req.on('error', reject);
    req.end(body);
  });
  assert.equal(response.status, 413);
  assert.match(response.text, /3 MiB/);
});
