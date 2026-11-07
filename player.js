// COSMIC TV Player — fetch /api/v1/status (tanpa auth), /api/v1/catalog dan
// /api/v1/channels (wajib Authorization: Bearer <READ_TOKEN>).
// PENTING: ?token= HANYA berlaku untuk /playlist.m3u, TIDAK untuk /api/v1/channels
// dan /api/v1/catalog (lihat src/http.mjs: authorizedRead(url, allowQuery) —
// allowQuery=true hanya untuk playlist). Jadi player ini selalu kirim header Bearer.
// Player harus disajikan dari origin yang sama (public/player.html): server tidak
// mengirim Access-Control-Allow-Origin dan CSP-nya connect-src 'self'.
'use strict';

const $ = id => document.getElementById(id);
const TOKEN_KEY = 'cosmic_read_token';
const ORIGIN_KEY = 'cosmic_origin';

let catalog = [];          // dari /api/v1/catalog: {id,name,group,health,passedSourceCount,sourceCount,drm,...}
let playable = new Map();  // id -> channel dari /api/v1/channels (hanya stream working, tanpa DRM)
let player = null;
let currentHeaders = {};
let currentChannel = null;

const healthNames = { working: 'Media terbaca', failed: 'Gagal', unchecked: 'Belum diperiksa', drm: 'Perlu DRM', unsupported: 'Belum didukung' };
const notice = msg => { $('notice').textContent = msg || ''; $('notice').hidden = !msg; };
const setStatus = msg => { $('player-status').textContent = 'Status: ' + msg; };
const setConnection = (text, cls) => { $('connection').textContent = text; $('connection').className = 'connection ' + (cls || ''); };

function origin() {
  const v = $('origin').value.trim();
  if (v) return v.replace(/\/+$/, '');
  if (location.protocol.startsWith('http')) return location.origin;
  return 'https://tv.cosmiclabs.web.id';
}
function token() { return $('token').value.trim(); }
function headers() {
  const h = {};
  const t = token();
  if (t) h.Authorization = 'Bearer ' + t;
  return h;
}
async function api(path, { auth = true } = {}) {
  const res = await fetch(origin() + path, { headers: auth ? headers() : {}, signal: AbortSignal.timeout(25000) });
  let data = null;
  try { data = await res.json(); } catch { /* 503/HTML dsb. */ }
  if (!res.ok) {
    const err = new Error((data && data.error) || ('HTTP ' + res.status));
    err.status = res.status;
    throw err;
  }
  return data;
}

// ---------- Shaka ----------
function shakaReady() {
  if (!window.shaka) {
    setStatus('Shaka Player tidak ditemukan. Letakkan shaka-player.compiled.js di public/ (lihat README).');
    return false;
  }
  if (!shaka.Player.isBrowserSupported()) {
    setStatus('Browser ini tidak mendukung Shaka Player / EME.');
    return false;
  }
  return true;
}
function initPlayer() {
  if (player || !shakaReady()) return !!player;
  player = new shaka.Player($('video'));
  player.getNetworkingEngine().registerRequestFilter((type, request) => {
    for (const [k, v] of Object.entries(currentHeaders)) request.headers[k] = v;
  });
  player.addEventListener('error', e => {
    const err = e.detail || e;
    setStatus('Error pemutar: ' + (err.message || err.code || 'tidak diketahui') + (err.code ? ' (kode ' + err.code + ')' : ''));
    if (err.code === 6001 || err.code === 6007 || err.code === 6010) {
      $('lic-server').textContent = 'Gagal lisensi DRM — periksa license server / ClearKey di panel lisensi.';
    }
  });
  return true;
}
function b64urlToHex(s) {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64.padEnd(b64.length + (4 - b64.length % 4) % 4, '='));
  return [...bin].map(c => c.charCodeAt(0).toString(16).padStart(2, '0')).join('');
}
function drmConfigFor(source, channel) {
  const drm = source.drmConfig || channel.drmConfig || null;
  if (!drm || !drm.type) return null;
  const type = String(drm.type).toUpperCase();
  const license = drm.licenseUrl || drm.licenseKey || '';
  if (type === 'WIDEVINE') return { servers: { 'com.widevine.alpha': license }, label: 'Widevine — ' + (license || '(tanpa license URL)') };
  if (type === 'CLEARKEY') {
    // licenseKey bisa: "kid:key", JSON {"keys":[{"kty":"oct","k":"...","kid":"..."}]}, atau URL.
    if (/^https?:/.test(license)) return { servers: { 'org.w3.clearkey': license }, label: 'ClearKey — ' + license };
    try {
      const parsed = JSON.parse(license);
      const keys = parsed.keys || [];
      const clearKeys = {};
      for (const k of keys) if (k.kid && k.k) clearKeys[b64urlToHex(k.kid)] = b64urlToHex(k.k);
      return { clearKeys, label: 'ClearKey — ' + keys.length + ' key' };
    } catch {
      const [kid, key] = license.split(':');
      if (kid && key) {
        // kid:key biasanya sudah hex (format M3U/Kodi); kalau base64url, konversi.
        const isHex = /^[0-9a-fA-F]+$/.test(kid) && /^[0-9a-fA-F]+$/.test(key);
        return { clearKeys: { [isHex ? kid.toLowerCase() : b64urlToHex(kid)]: isHex ? key.toLowerCase() : b64urlToHex(key) }, label: 'ClearKey — kid:key' };
      }
      return { label: 'ClearKey — format license tidak dikenali: ' + license.slice(0, 80) };
    }
  }
  return { label: type + ' — tidak didukung player ini' };
}
function mimeFor(source, channel) {
  const m = String(source.manifestType || channel.manifestType || '').toLowerCase();
  if (['mpd', 'dash'].includes(m) || /\.mpd(\?|$)/i.test(source.url)) return 'application/dash+xml';
  if (['hls', 'm3u8'].includes(m) || /\.m3u8(\?|$)/i.test(source.url)) return 'application/x-mpegURL';
  return undefined;
}
async function playChannel(channel, sourceIndex = 0) {
  if (!initPlayer()) return;
  const sources = channel.sources || [];
  const source = sources[sourceIndex] || sources[0];
  if (!source) { setStatus('Channel ini tidak punya stream yang bisa diputar.'); return; }
  currentChannel = channel;
  currentHeaders = { ...(channel.headers || {}), ...(source.headers || {}) };
  const drm = drmConfigFor(source, channel);
  const mime = mimeFor(source, channel);
  $('now-playing').textContent = 'Memutar: ' + channel.name + (source.resolutionLabel ? ' [' + source.resolutionLabel + ']' : '') + (sources.length > 1 ? ' — sumber ' + (sourceIndex + 1) + '/' + sources.length : '');
  $('lic-type').textContent = (mime === 'application/dash+xml' ? 'DASH (.mpd)' : mime === 'application/x-mpegURL' ? 'HLS (.m3u8)' : 'Otomatis') + (drm ? ' + DRM' : '');
  $('lic-url').textContent = source.url;
  $('lic-server').textContent = drm ? (drm.label || '—') : 'Tidak ada DRM (stream terverifikasi).';
  $('lic-headers').textContent = Object.keys(currentHeaders).length ? Object.keys(currentHeaders).join(', ') : 'Tidak ada.';
  try {
    player.configure({ drm: { servers: (drm && drm.servers) || {}, clearKeys: (drm && drm.clearKeys) || {} } });
    setStatus('Memuat ' + channel.name + '…');
    await player.load(source.url, undefined, mime);
    $('video').play().catch(() => {});
    setStatus('Memutar: ' + channel.name);
  } catch (e) {
    setStatus('Gagal memutar: ' + (e && e.message ? e.message : e));
  }
  render();
}

// ---------- Katalog ----------
function render() {
  const q = $('search').value.trim().toLowerCase();
  const group = $('group').value;
  const health = $('health-filter').value;
  const onlyPlayable = $('playable-only').checked;
  const rows = catalog.filter(c =>
    (!q || c.name.toLowerCase().includes(q)) &&
    (!group || c.group === group) &&
    (!health || c.health === health) &&
    (!onlyPlayable || playable.has(c.id)));
  const list = $('channels');
  list.replaceChildren();
  for (const c of rows) {
    const li = document.createElement('li');
    li.className = 'channel-row';
    const canPlay = playable.has(c.id);
    const ch = playable.get(c.id);
    const name = document.createElement('strong'); name.textContent = c.name;
    const meta = document.createElement('span'); meta.className = 'muted small';
    meta.textContent = (c.group || 'General') + ' · ' + (c.passedSourceCount ?? 0) + '/' + (c.sourceCount ?? 0) + ' lolos' + (c.drm && c.drm.length ? ' · DRM: ' + c.drm.join(', ') : '');
    const badge = document.createElement('span'); badge.className = 'badge health-' + c.health; badge.textContent = healthNames[c.health] || c.health;
    const btn = document.createElement('button');
    btn.className = 'primary-btn small-btn'; btn.type = 'button';
    btn.textContent = canPlay ? 'Putar' : 'Perlu DRM';
    btn.disabled = !canPlay;
    btn.title = canPlay ? 'Putar ' + c.name : 'Channel ini Perlu DRM — URL/lisensinya tidak diekspos API, jadi tidak bisa diputar dari player ini.';
    if (canPlay) btn.onclick = () => playChannel(ch);
    const reason = document.createElement('small'); reason.className = 'muted';
    reason.textContent = c.reason || '';
    li.append(name, badge, meta, reason, btn);
    list.append(li);
  }
  if (!rows.length) {
    const li = document.createElement('li'); li.className = 'empty';
    li.textContent = catalog.length ? 'Tidak ada channel yang cocok dengan filter ini.' : 'Belum ada katalog. Muat katalog dulu.';
    list.append(li);
  }
  $('results').textContent = rows.length + ' dari ' + catalog.length + ' channel. ' + playable.size + ' bisa diputar (stream lolos pemeriksaan).';
  $('counts').textContent = playable.size + ' bisa diputar · ' + catalog.length + ' di katalog';
  // isi filter grup sekali jalan
  const sel = $('group');
  if (sel.options.length <= 1 && catalog.length) {
    const cur = sel.value;
    for (const g of [...new Set(catalog.map(c => c.group || 'General'))].sort()) sel.add(new Option(g, g));
    sel.value = [...sel.options].some(o => o.value === cur) ? cur : '';
  }
  updatePlaylistLink();
}
function updatePlaylistLink() {
  const url = new URL('/playlist.m3u', origin());
  const t = token();
  if (t) url.searchParams.set('token', t);
  $('playlist-url').value = url.href;
  $('download-m3u').href = url.href;
}

async function loadAll() {
  notice('');
  if (!token()) {
    notice('Isi token baca dulu. Tanpa token, /api/v1/channels dan /api/v1/catalog mengembalikan 401.');
    $('auth-state').textContent = 'Belum ada token di sesi ini.';
    return;
  }
  setConnection('Menghubungkan…', '');
  setStatus('Memuat status, katalog, dan channel…');
  try {
    const status = await api('/api/v1/status', { auth: false });
    $('status-line').textContent = 'Server: ' + (status.state || '?') + ' · ' + (status.channelCount ?? 0) + ' channel final · ' + (status.sourceCount ?? 0) + ' stream · diperbarui ' + (status.fetchedAt ? new Date(status.fetchedAt).toLocaleString('id-ID') : '—');
    setConnection('Terhubung — ' + (status.state || ''), status.state === 'ready' ? 'ready' : '');
  } catch (e) {
    setConnection('Status gagal: ' + e.message, 'unavailable');
    notice('Tidak bisa membaca /api/v1/status di ' + origin() + ': ' + e.message + '. Periksa origin dan koneksi.');
    return;
  }
  try {
    const [catData, chData] = await Promise.all([api('/api/v1/catalog'), api('/api/v1/channels')]);
    catalog = Array.isArray(catData.channels) ? catData.channels : [];
    playable = new Map((Array.isArray(chData.channels) ? chData.channels : []).map(c => [String(c.id), c]));
    sessionStorage.setItem(TOKEN_KEY, token());
    sessionStorage.setItem(ORIGIN_KEY, origin());
    $('auth-state').textContent = 'Token diterima sesi ini. ' + playable.size + ' channel bisa diputar, ' + catalog.length + ' di katalog.';
    setStatus('Katalog dimuat.');
    render();
  } catch (e) {
    if (e.status === 401) {
      notice('Token ditolak (401). Periksa token baca — token admin juga diterima untuk baca, tapi jangan pakai ADMIN_TOKEN di player publik.');
      $('auth-state').textContent = 'Token tidak valid.';
      setConnection('Perlu token valid', 'unavailable');
    } else if (e.status === 503) {
      notice('Playlist belum tersedia (503) — server masih sinkronisasi pertama. Coba lagi sebentar lagi.');
    } else {
      notice('Gagal memuat katalog/channel: ' + e.message);
    }
  }
}

function loadSample() {
  catalog = [
    { id: 'sample-bbb', name: 'Big Buck Bunny (contoh HLS)', group: 'Contoh', health: 'working', passedSourceCount: 1, sourceCount: 1, drm: [], reason: 'Stream test publik.' },
    { id: 'sample-sintel', name: 'Sintel (contoh DASH)', group: 'Contoh', health: 'working', passedSourceCount: 1, sourceCount: 1, drm: [], reason: 'Stream test publik.' },
    { id: 'sample-widevine', name: 'Angel One (contoh Widevine)', group: 'Contoh', health: 'working', passedSourceCount: 1, sourceCount: 1, drm: ['WIDEVINE'], reason: 'Stream test publik Shaka.' },
  ];
  playable = new Map([
    ['sample-bbb', { id: 'sample-bbb', name: 'Big Buck Bunny (contoh HLS)', groupTitle: 'Contoh', manifestType: 'hls', sources: [{ url: 'https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8', manifestType: 'hls', headers: {} }] }],
    ['sample-sintel', { id: 'sample-sintel', name: 'Sintel (contoh DASH)', groupTitle: 'Contoh', manifestType: 'mpd', sources: [{ url: 'https://storage.googleapis.com/shaka-demo-assets/sintel/dash.mpd', manifestType: 'mpd', headers: {} }] }],
    ['sample-widevine', { id: 'sample-widevine', name: 'Angel One (contoh Widevine)', groupTitle: 'Contoh', manifestType: 'mpd', drmConfig: { type: 'WIDEVINE', licenseUrl: 'https://cwip-shaka-proxy.appspot.com/no_auth' }, sources: [{ url: 'https://storage.googleapis.com/shaka-demo-assets/angel-one-widevine/dash.mpd', manifestType: 'mpd', headers: {}, drmConfig: { type: 'WIDEVINE', licenseUrl: 'https://cwip-shaka-proxy.appspot.com/no_auth' } }] }],
  ]);
  notice('Mode contoh: 3 stream test publik, tanpa token dan tanpa server. Ganti ke katalog asli dengan tombol “Muat katalog”.');
  setStatus('Contoh dimuat.');
  render();
}

$('load').onclick = loadAll;
$('load-sample').onclick = loadSample;
$('forget-token').onclick = () => {
  $('token').value = '';
  sessionStorage.removeItem(TOKEN_KEY);
  $('auth-state').textContent = 'Token dilupakan dari sesi ini.';
  notice('');
  updatePlaylistLink();
};
$('copy-playlist').onclick = async () => {
  try { await navigator.clipboard.writeText($('playlist-url').value); $('copy-playlist').textContent = 'Tersalin ✓'; setTimeout(() => { $('copy-playlist').textContent = 'Salin'; }, 1800); }
  catch { $('playlist-url').select(); notice('Pilih dan salin URL playlist dari kolom di atas.'); }
};
for (const id of ['search', 'group', 'health-filter', 'playable-only']) $(id).addEventListener('input', render);
$('origin').addEventListener('input', updatePlaylistLink);
$('token').addEventListener('input', updatePlaylistLink);

// Pulihkan sesi (bukan token dari URL — sengaja tidak membaca ?token= halaman ini).
$('origin').value = sessionStorage.getItem(ORIGIN_KEY) || '';
$('token').value = sessionStorage.getItem(TOKEN_KEY) || '';
if ($('token').value) $('auth-state').textContent = 'Token tersimpan di sesi ini. Klik “Muat katalog”.';
updatePlaylistLink();
if (!window.shaka) {
  setStatus('Shaka Player belum dimuat — letakkan shaka-player.compiled.js di public/ (lihat README).');
}
