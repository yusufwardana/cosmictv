import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseSource } from '../src/import.mjs';
import { publicIPv4, assertPublicUrl } from '../src/network.mjs';
import { probeStream } from '../src/probe.mjs';
import { AggregateService } from '../src/aggregate.mjs';
import { createApp } from '../src/http.mjs';
import { once } from 'node:events';

const response = (text, url = 'https://media.test/live.m3u8', status = 200) => ({ status, url, headers: {}, body: Buffer.isBuffer(text) ? text : Buffer.from(text), text: Buffer.isBuffer(text) ? '' : text });
const ts = Buffer.alloc(188 * 4); for (let i = 0; i < ts.length; i += 188) ts[i] = 0x47;
const source = (url = 'https://media.test/live.m3u8') => ({ url, headers: {} });
const payload = () => ({ channels: [{ id: 'news', tvgId: 'news.id', name: 'News', groupTitle: 'News', sources: [source()] }] });

test('M3U importer ignores HTML wrappers and empty entries, preserving headers and DRM', () => {
  const data = parseSource(`<html>ignored</html>\n#EXTM3U\n#EXTINF:-1 tvg-id="news.id" group-title="News",News\n#EXTVLCOPT:http-user-agent=Player\n#EXTVLCOPT:http-referrer=https://origin.test/\nhttps://media.test/live.m3u8\n#EXTINF:-1,Empty\n#EXTINF:-1,DRM\n#KODIPROP:inputstream.adaptive.license_type=com.widevine.alpha\n#KODIPROP:inputstream.adaptive.license_key=https://license.test/\nhttps://media.test/a.mpd`);
  assert.equal(data.channels.length, 2);
  assert.equal(data.channels[0].sources[0].headers['user-agent'], 'Player');
  assert.equal(data.channels[0].tvgId, 'news.id');
  assert.equal(data.channels[1].sources[0].drmConfig.type, 'WIDEVINE');
});

test('importer rejects a bare media manifest or invalid JSON as a channel list', () => {
  assert.throws(() => parseSource('#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:6,\nsegment.ts'));
  assert.throws(() => parseSource('{"channels":[]}'));
});

test('network policy rejects credentials, local names, private, reserved and mapped addresses', async () => {
  for (const ip of ['127.0.0.1', '10.10.12.50', '169.254.169.254', '172.16.1.1', '192.168.1.1', '100.64.1.1', '0.0.0.0', '224.0.0.1', '192.0.2.1', '198.18.0.1']) assert.equal(publicIPv4(ip), false, ip);
  assert.equal(publicIPv4('1.1.1.1'), true);
  for (const url of ['file:///a', 'http://127.0.0.1/', 'http://[::ffff:127.0.0.1]/', 'http://localhost/', 'https://user:secret@example.com/']) await assert.rejects(() => assertPublicUrl(url));
  await assert.rejects(() => assertPublicUrl('https://provider.test/', async () => [{ address: '10.0.0.1', family: 4 }]));
});

test('HLS is verified only after resolving master, child and recognizable segment bytes', async () => {
  const seen = [];
  const result = await probeStream(source(), async url => {
    seen.push(url);
    if (url.endsWith('/live.m3u8')) return response('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1000\nvariant/child.m3u8', url);
    if (url.endsWith('/child.m3u8')) return response('#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:6,\nseg.ts', url);
    return response(ts, url);
  });
  assert.equal(result.state, 'working');
  assert.equal(seen.at(-1), 'https://media.test/variant/seg.ts');
});

test('HTTP 200 HTML responses and HTML masquerading as segments never pass', async () => {
  assert.equal((await probeStream(source(), async url => response('<html>Login</html>', url))).state, 'failed');
  const result = await probeStream(source(), async url => url.endsWith('.ts') ? response('<html>Denied</html>', url) : response('#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:6,\nseg.ts', url));
  assert.equal(result.state, 'failed');
});

test('HLS fMP4 requires an initialization file and actual fragment media', async () => {
  const init = Buffer.concat([Buffer.from([0, 0, 0, 16]), Buffer.from('ftypisom0000')]);
  const fragment = Buffer.concat([Buffer.from([0, 0, 0, 16]), Buffer.from('moof00000000'), Buffer.from([0, 0, 0, 12]), Buffer.from('mdat0000')]);
  const result = await probeStream(source(), async url => url.endsWith('init.mp4') ? response(init, url) : url.endsWith('.m4s') ? response(fragment, url) : response('#EXTM3U\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:6,\nseg.m4s', url));
  assert.equal(result.state, 'working');
});

test('DRM, AES encrypted HLS and DASH are excluded without claiming playback verification', async () => {
  let calls = 0;
  const fetcher = async url => { calls++; return response('#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="key"\n#EXTINF:6,\nseg.ts', url); };
  assert.equal((await probeStream({ ...source(), drmConfig: { type: 'WIDEVINE' } }, fetcher)).state, 'drm');
  assert.equal(calls, 0);
  assert.equal((await probeStream(source(), fetcher)).state, 'drm');
  assert.equal((await probeStream(source(), async url => response('<MPD></MPD>', url))).state, 'unsupported');
});

test('HTTP 403/429 and segment errors do not become working', async () => {
  for (const code of [403, 429, 503]) {
    const result = await probeStream(source(), async url => response('Denied', url, code));
    assert.equal(result.state, 'failed');
    assert.match(result.reason, new RegExp(String(code)));
  }
});

async function setup(t) {
  const dir = await mkdtemp(join(tmpdir(), 'cosmic-multi-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  let data = payload();
  const primary = { data: null, async refresh() { this.data = data; return true; } };
  const service = new AggregateService({ primary, directory: dir, refreshSeconds: 900, verificationSeconds: 1800,
    request: async url => response('#EXTM3U\n#EXTINF:-1 tvg-id="news.id",News\nhttps://media.test/second.m3u8', url),
    probe: async stream => ({ state: 'working', reason: 'Media terbaca', checkedAt: new Date().toISOString() }),
  });
  await service.load();
  return { service, dir, setData: value => { data = value; } };
}

test('multiple feeds combine under one channel and verified API preserves alternatives', async t => {
  const { service } = await setup(t);
  await service.addSource({ name: 'Extra', url: 'https://feed.test/list.m3u' });
  await service.refresh();
  assert.equal(service.data.channels.length, 1);
  assert.equal(service.data.channels[0].sources.length, 2);
  assert.equal(service.status().feedCount, 2);
});

test('expired, failed and DRM checks are excluded from exported data', async t => {
  const { service } = await setup(t);
  service.options.probe = async () => ({ state: 'working', reason: 'ok', checkedAt: '2020-01-01T00:00:00.000Z' });
  await service.refresh();
  assert.equal(service.data.channels.length, 0);
  for (const state of ['failed', 'drm', 'unsupported']) {
    service.options.probe = async () => ({ state, reason: state, checkedAt: new Date().toISOString() });
    await service.refresh();
    assert.equal(service.data.channels.length, 0);
  }
});

test('source toggles persist and disabling removes streams immediately', async t => {
  const { service } = await setup(t);
  const added = await service.addSource({ name: 'Uploaded', content: '#EXTM3U\n#EXTINF:-1,Extra\nhttps://media.test/extra.m3u8' });
  await service.refresh();
  assert.equal(service.data.channels.length, 1);
  const extra = service.getCatalog().find(channel => channel.name === 'Extra');
  assert.equal(extra.selected, false);
  await service.setSelection([...service.getSelection().channelIds, extra.id]);
  assert.equal(service.data.channels.length, 2);
  await service.changeSource(added.id, { enabled: false });
  assert.equal(service.data.channels.length, 1);
  const restored = new AggregateService(service.options);
  await restored.load();
  assert.equal(restored.listSources().find(item => item.id === added.id).enabled, false);
});

test('deduplication preserves distinct headers for the same media URL', async t => {
  const { service, setData } = await setup(t);
  const data = payload();
  data.channels[0].sources.push({ ...source(), headers: { referer: 'https://one.test/' } }, source());
  setData(data);
  await service.refresh();
  assert.equal(service.data.channels[0].sources.length, 2);
});

test('adding a duplicate source reuses recent checks instead of contacting media again', async t => {
  const { service } = await setup(t);
  service.options.reuseSeconds = 300;
  let probes = 0;
  service.options.probe = async () => { probes++; return { state: 'working', reason: 'ok', checkedAt: new Date().toISOString() }; };
  await service.refresh();
  await service.addSource({ name: 'Duplicate import', content: '#EXTM3U\n#EXTINF:-1 tvg-id="news.id",News\nhttps://media.test/live.m3u8' });
  await service.refresh();
  assert.equal(probes, 1);
  assert.equal(service.data.channels[0].sources.length, 1);
  assert.equal(service.data.channels[0].sources[0].feedIds.length, 2);
});

test('source management requires admin and mutations persist before async scans', async t => {
  const { service } = await setup(t);
  await service.refresh();
  const server = createApp({ service, adminToken: 'admin-test', publicDir: '' });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetch(base + '/api/v1/sources')).status, 401);
  const headers = { Authorization: 'Bearer admin-test', 'Content-Type': 'application/json' };
  const added = await fetch(base + '/api/v1/sources', { method: 'POST', headers, body: JSON.stringify({ name: 'Extra', url: 'https://feed.test/list.m3u' }) });
  assert.equal(added.status, 201);
  const item = await added.json();
  await service.inflight;
  assert.equal((await fetch(base + '/api/v1/sources', { headers })).status, 200);
  const toggle = await fetch(base + '/api/v1/sources/' + item.id, { method: 'PATCH', headers, body: JSON.stringify({ enabled: false }) });
  assert.equal(toggle.status, 200);
  const data = await (await fetch(base + '/api/v1/channels')).json();
  assert.equal(data.channels[0].sources.length, 1);
  const refresh = await fetch(base + '/api/v1/refresh', { method: 'POST', headers });
  assert.equal(refresh.status, 202);
  await service.inflight;
  assert.equal((await fetch(base + '/api/v1/sources/' + item.id, { method: 'DELETE', headers })).status, 200);
  await service.inflight;
});

test('manual channel selection is saved on the server and controls the final playlist', async t => {
  const { service } = await setup(t);
  await service.refresh();
  const [channel] = service.getCatalog();
  assert.equal(channel.selected, true);
  assert.equal(service.data.channels.length, 1);

  await service.setSelection([]);
  assert.equal(service.data.channels.length, 0);
  assert.equal(service.getCatalog()[0].selected, false);

  await service.setSelection([channel.id]);
  assert.equal(service.data.channels.length, 1);
  const restored = new AggregateService(service.options);
  await restored.load();
  assert.equal(restored.getCatalog()[0].selected, true);
  assert.equal(restored.data.channels.length, 1);
});

test('manual playlist selection API requires admin and changes the final M3U', async t => {
  const { service } = await setup(t);
  await service.refresh();
  const [channel] = service.getCatalog();
  const server = createApp({ service, adminToken: 'admin-test', publicDir: '' });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetch(base + '/api/v1/selection')).status, 401);
  const headers = { Authorization: 'Bearer admin-test', 'Content-Type': 'application/json' };
  const deselect = await fetch(base + '/api/v1/selection', { method: 'PUT', headers, body: JSON.stringify({ channelIds: [] }) });
  assert.equal(deselect.status, 200);
  assert.equal((await (await fetch(base + '/playlist.m3u')).text()).match(/^#EXTINF:/gm), null);
  const select = await fetch(base + '/api/v1/selection', { method: 'PUT', headers, body: JSON.stringify({ channelIds: [channel.id] }) });
  assert.equal(select.status, 200);
  assert.equal((await (await fetch(base + '/playlist.m3u')).text()).match(/^#EXTINF:/gm).length, 1);
});
