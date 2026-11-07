import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { toM3u, validatePayload, catalog } from '../src/playlist.mjs';
import { PlaylistService, signRequest } from '../src/service.mjs';
import { createApp } from '../src/http.mjs';

const fixture = () => ({ success: true, channels: [
  { id: 'a', tvgId: 'news.id', name: 'News', groupTitle: 'News', headers: { Referer: 'https://example.test/' }, sources: [
    { url: 'https://example.test/a.m3u8', headers: { 'User-Agent': 'Player' } },
  ] },
  { id: 'b', name: 'Sport', groupTitle: 'Sports', sources: [
    { url: 'https://example.test/b.mpd', manifestType: 'mpd', drmConfig: { type: 'WIDEVINE', licenseUrl: 'https://example.test/license' } },
  ] },
] });

async function setup(t, fetcher = async () => Response.json(fixture())) {
  const dir = await mkdtemp(join(tmpdir(), 'playlist-api-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const service = new PlaylistService({ cacheFile: join(dir, 'snapshot.json'), upstream: 'https://upstream.test/channels', secret: 'fixture-secret', deviceId: 'test-device', refreshSeconds: 900, fetcher });
  return { dir, service };
}

test('M3U preserves channel attributes, inherited headers and license URL', () => {
  const result = toM3u(fixture());
  assert.ok(result.startsWith('#EXTM3U\n'));
  assert.equal(result.match(/#EXTINF:/g).length, 2);
  assert.ok(result.includes('tvg-id="news.id"'));
  assert.ok(result.includes('#EXTVLCOPT:http-user-agent=Player'));
  assert.ok(result.includes('Referer=https%3A%2F%2Fexample.test%2F'));
  assert.ok(result.includes('#KODIPROP:inputstream.adaptive.license_type=com.widevine.alpha'));
  assert.ok(result.includes('#KODIPROP:inputstream.adaptive.license_key=https://example.test/license'));
});

test('filters by category, search and DRM and rejects injected playlist lines', () => {
  assert.equal(toM3u(fixture(), { group: 'Sports', drm: 'exclude' }), '#EXTM3U\n');
  assert.equal(toM3u(fixture(), { q: 'NEWS' }).match(/#EXTINF:/g).length, 1);
  const data = fixture();
  data.channels[0].name = 'Name\n#EXTINF:injection"';
  data.channels[0].sources.push({ url: 'https://example.test/x\n#EXTINF:evil' }, { url: 'file:///secret' });
  const result = toM3u(data);
  assert.equal(result.match(/^#EXTINF:/gm).length, 2);
  assert.ok(!result.includes('\n#EXTINF:injection'));
});

test('validation rejects failed, empty and unusable upstream snapshots', () => {
  for (const data of [{ success: false, channels: fixture().channels }, { channels: [] }, { channels: [{ sources: [{ url: 'javascript:alert(1)' }] }] }]) {
    assert.throws(() => validatePayload(data));
  }
});

test('signature matches the confirmed application request format', () => {
  assert.equal(signRequest('device', 123, 'secret'), createHash('sha256').update('device:123:secret').digest('hex'));
});

test('catalog distinguishes mixed DRM and clear sources for dashboard filters', () => {
  const data = fixture();
  data.channels[1].sources.push({ url: 'https://example.test/clear.m3u8', manifestType: 'hls' });
  const entry = catalog(data)[1];
  assert.equal(entry.sourceCount, 2);
  assert.equal(entry.drmSourceCount, 1);
  assert.deepEqual(entry.clearFormats, ['hls']);
});

test('ClearKey configuration from the source survives M3U export', () => {
  const data = fixture();
  data.channels[1].sources[0].drmConfig = { type: 'CLEARKEY', licenseKey: 'test-kid:test-key' };
  const result = toM3u(data);
  assert.ok(result.includes('#KODIPROP:inputstream.adaptive.license_type=org.w3.clearkey'));
  assert.ok(result.includes('#KODIPROP:inputstream.adaptive.license_key=test-kid:test-key'));
});

test('explicit null DRM on a source overrides channel DRM defaults', () => {
  const data = fixture();
  data.channels[0].drmConfig = { type: 'WIDEVINE', licenseUrl: 'https://example.test/license' };
  data.channels[0].sources[0].drmConfig = null;
  const result = toM3u(data, { group: 'News', drm: 'exclude' });
  assert.equal(result.match(/#EXTINF:/g)?.length, 1);
  assert.ok(!result.includes('license_type'));
  assert.equal(catalog(data)[0].drmSourceCount, 0);
});

test('successful refresh persists a snapshot and restart restores it', async t => {
  const { service } = await setup(t);
  assert.equal(service.status().state, 'unavailable');
  assert.equal(await service.refresh(), true);
  assert.equal(service.status().channelCount, 2);
  assert.equal(service.status().sourceCount, 2);
  assert.ok(JSON.parse(await readFile(service.cacheFile, 'utf8')).fetchedAt);
  const restored = new PlaylistService(service.options);
  await restored.load();
  assert.equal(restored.status().channelCount, 2);
  assert.equal(restored.status().state, 'ready');
});

test('HTTP failure retains the last good snapshot and marks it stale', async t => {
  let broken = false;
  const { service } = await setup(t, async () => broken ? new Response('Denied', { status: 403 }) : Response.json(fixture()));
  await service.refresh();
  const saved = await readFile(service.cacheFile, 'utf8');
  broken = true;
  assert.equal(await service.refresh(), false);
  assert.equal(service.status().state, 'stale');
  assert.equal(service.status().channelCount, 2);
  assert.match(service.status().lastError, /403/);
  assert.equal(await readFile(service.cacheFile, 'utf8'), saved);
});

test('invalid JSON or empty responses cannot replace valid cache', async t => {
  let response = fixture();
  const { service } = await setup(t, async () => Response.json(response));
  await service.refresh();
  response = { channels: [] };
  assert.equal(await service.refresh(), false);
  assert.equal(service.data.channels.length, 2);
});

test('oversized upstream body is rejected without replacing cache', async t => {
  const { service } = await setup(t);
  await service.refresh();
  const old = service.fetchedAt;
  service.options.maxBytes = 10;
  assert.equal(await service.refresh(), false);
  assert.equal(service.fetchedAt, old);
  assert.equal(service.data.channels.length, 2);
});

test('disk persistence failure leaves the previous snapshot active', async t => {
  const { service, dir } = await setup(t);
  await service.refresh();
  const old = service.fetchedAt;
  await writeFile(join(dir, 'blocked'), 'not a directory');
  service.cacheFile = join(dir, 'blocked', 'snapshot.json');
  assert.equal(await service.refresh(), false);
  assert.equal(service.fetchedAt, old);
  assert.equal(service.status().state, 'stale');
});

test('signing headers reach the transport without leaking credentials in status', async t => {
  let request;
  const { service } = await setup(t, async (url, options) => { request = options; return Response.json(fixture()); });
  await service.refresh();
  const headers = request.headers;
  assert.equal(headers['X-Device-Id'], 'test-device');
  assert.equal(headers['X-App-Signature'], signRequest('test-device', headers['X-App-Timestamp'], 'fixture-secret'));
  assert.equal(request.redirect, 'error');
  assert.ok(!JSON.stringify(service.status()).includes(headers['X-App-Signature']));
});

test('concurrent refresh callers share one upstream request', async t => {
  let calls = 0;
  const { service } = await setup(t, async () => { calls++; await new Promise(r => setTimeout(r, 20)); return Response.json(fixture()); });
  await Promise.all([service.refresh(), service.refresh(), service.refresh()]);
  assert.equal(calls, 1);
});

test('corrupted cache stays unavailable until a successful refresh', async t => {
  const { service } = await setup(t);
  await writeFile(service.cacheFile, '{bad json');
  await service.load();
  assert.equal(service.status().state, 'unavailable');
  await service.refresh();
  assert.equal(service.status().state, 'ready');
});

test('API serves filtered playlists, validators and protected refresh', async t => {
  const { service } = await setup(t);
  await service.refresh();
  const server = createApp({ service, adminToken: 'admin-test', publicDir: new URL('../public/', import.meta.url).pathname });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const playlist = await fetch(`${base}/playlist.m3u?group=News`);
  assert.equal(playlist.status, 200);
  assert.equal((await playlist.text()).match(/#EXTINF:/g).length, 1);
  const etag = playlist.headers.get('etag');
  assert.ok(etag);
  assert.equal((await fetch(`${base}/playlist.m3u?group=News`, { headers: { 'If-None-Match': etag } })).status, 304);
  assert.equal((await fetch(`${base}/playlist.m3u`, { method: 'HEAD' })).status, 200);
  assert.equal((await fetch(`${base}/api/v1/refresh`, { method: 'POST' })).status, 401);
  assert.equal((await fetch(`${base}/api/v1/refresh`, { method: 'POST', headers: { Authorization: 'Bearer admin-test' } })).status, 200);
  assert.equal((await fetch(`${base}/api/v1/refresh`, { method: 'POST', headers: { Authorization: 'Bearer admin-test' } })).status, 429);
  const status = await (await fetch(`${base}/api/v1/status`)).json();
  assert.equal(status.channelCount, 2);
  assert.ok(!JSON.stringify(status).includes('fixture-secret'));
  assert.equal((await fetch(`${base}/.env`)).status, 404);
  assert.equal((await fetch(`${base}/api/v1/channels`)).status, 200);
});

test('API returns 503 rather than an empty playlist before the first sync', async t => {
  const { service } = await setup(t);
  const server = createApp({ service, adminToken: 'test', publicDir: '' });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetch(`${base}/playlist.m3u`)).status, 503);
  assert.equal((await fetch(`${base}/api/v1/channels`)).status, 503);
});
