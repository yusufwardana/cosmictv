import { createServer } from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { catalog, toM3u } from './playlist.mjs';

const digest = value => createHash('sha256').update(String(value ?? '')).digest();
/** Constant-time compare; both sides are hashed so length never leaks. */
const sameSecret = (provided, expected) => timingSafeEqual(digest(provided), digest(expected));

/** Splits a comma separated token list, dropping empty/too-short entries. */
export function parseTokenList(value, minimum = 16) {
  return String(value ?? '').split(',').map(token => token.trim()).filter(token => token.length >= minimum);
}

/** Fixed-window counter. Returns 0 when allowed, else the number of seconds to wait. */
function windowLimiter({ windowMs, max, getMax }) {
  const hits = new Map();
  const limit = () => (typeof getMax === 'function' ? getMax() : max);
  return key => {
    const currentMax = limit();
    if (currentMax <= 0) return 0;
    const now = Date.now();
    const entry = hits.get(key);
    if (!entry || now - entry.start >= windowMs) {
      if (hits.size > 5000) for (const [name, item] of hits) if (now - item.start >= windowMs) hits.delete(name);
      hits.set(key, { start: now, count: 1 });
      return 0;
    }
    entry.count += 1;
    return entry.count > currentMax ? Math.max(1, Math.ceil((entry.start + windowMs - now) / 1000)) : 0;
  };
}

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

/**
 * @param {object} options
 * @param {object} options.service aggregate/playlist service
 * @param {string} options.adminToken token for management endpoints
 * @param {string} options.publicDir directory with the dashboard assets
 * @param {boolean} [options.allowAdmin=true] false = read-only listener (no dashboard, no mutations)
 * @param {string[]} [options.readTokens] when non-empty, read endpoints require one of these tokens
 * @param {boolean} [options.allowQueryToken=true] accept `?token=` on playlist endpoints (players that cannot set headers)
 * @param {string} [options.publicOrigin] origin published to the dashboard for copy/download links
 * @param {number} [options.rateLimit=300] requests per IP per minute, 0 disables
 * @param {number} [options.authFailLimit=20] failed-auth attempts per IP per minute
 */
export function createApp({ service, settings, adminToken, publicDir, allowAdmin = true, allowLoopbackAdmin = false, readTokens = [], readTokenRequired, allowQueryToken = true, publicOrigin = '', rateLimit = 300, authFailLimit = 20, runtimeConfig }) {
  let lastManualRefresh = 0;
  const staticFiles = { '/': ['index.html', 'text/html; charset=utf-8'], '/style.css': ['style.css', 'text/css; charset=utf-8'], '/app.js': ['app.js', 'text/javascript; charset=utf-8'], '/player.html': ['player.html', 'text/html; charset=utf-8'], '/player.js': ['player.js', 'text/javascript; charset=utf-8'], '/player.css': ['player.css', 'text/css; charset=utf-8'], '/shaka-player.compiled.js': ['shaka-player.compiled.js', 'text/javascript; charset=utf-8'] };
  const cfg = runtimeConfig || { rateLimit, authFailLimit };
  if (cfg.rateLimit === undefined) cfg.rateLimit = rateLimit;
  if (cfg.authFailLimit === undefined) cfg.authFailLimit = authFailLimit;
  const readLimit = windowLimiter({ windowMs: 60000, getMax: () => cfg.rateLimit });
  const authLimit = windowLimiter({ windowMs: 60000, getMax: () => cfg.authFailLimit });
  const tokens = Array.isArray(readTokens) ? readTokens : [];
  // The admin listener is exempt from read tokens but must still report the public policy to the dashboard.
  const tokenRequired = readTokenRequired ?? tokens.length > 0;
  const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

  return createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    // The dashboard only talks to its own origin, but the player (player.html) must reach
    // third-party stream/CDN hosts. Media segments arrive as blob:/data: through Shaka (MSE).
    const isPlayer = String(req.url || '').startsWith('/player');
    const policy = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'" +
      (isPlayer ? ' https: blob: data:' : '') +
      "; media-src 'self' blob: data: https:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";
    res.setHeader('Content-Security-Policy', policy);
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('X-Permitted-Cross-Domain-Policies', 'none');

    /** @param {{type?:string, cache?:boolean, scope?:'private'|'public'}} [options] */
    const send = (code, body, options = {}) => {
      const { type = 'application/json; charset=utf-8', cache = false, scope = 'private' } = options;
      if (res.writableEnded) return;
      const payload = Buffer.from(typeof body === 'object' ? JSON.stringify(body) : body);
      res.setHeader('Content-Type', type);
      res.setHeader('Cache-Control', cache ? `${scope}, max-age=0, must-revalidate` : 'no-store');
      if (cache) {
        const tag = '"' + createHash('sha256').update(payload).digest('hex').slice(0, 32) + '"';
        res.setHeader('ETag', tag);
        if (req.headers['if-none-match'] === tag) { res.writeHead(304); res.end(); return; }
      }
      res.setHeader('Content-Length', payload.length);
      res.writeHead(code);
      res.end(req.method === 'HEAD' ? undefined : payload);
    };

    const clientIp = req.socket.remoteAddress || 'unknown';
    const localAdmin = allowLoopbackAdmin && LOOPBACK.has(clientIp);
    const adminAccess = allowAdmin || localAdmin;
    const tooMany = readLimit(clientIp);
    if (tooMany) { res.setHeader('Retry-After', String(tooMany)); return send(429, { error: 'Terlalu banyak permintaan. Coba lagi nanti.' }); }

    const bearer = () => {
      const header = req.headers.authorization;
      return typeof header === 'string' && /^Bearer ./i.test(header) ? header.slice(7).trim() : '';
    };
    const authorizedAdmin = () => !!adminToken && sameSecret(req.headers.authorization ?? '', `Bearer ${adminToken}`);
    const authorizedRead = (url, allowQuery) => {
      if (!tokens.length || localAdmin) return true;
      const provided = bearer();
      // The admin token also authorises reads: the dashboard polls with it after login.
      if (provided && adminToken && sameSecret(provided, adminToken)) return true;
      if (provided && tokens.some(token => sameSecret(provided, token))) return true;
      if (allowQuery && allowQueryToken) {
        const query = url.searchParams.get('token') || '';
        if (query && tokens.some(token => sameSecret(query, token))) return true;
      }
      return false;
    };
    const rejectRead = () => {
      const wait = authLimit(clientIp);
      if (wait) res.setHeader('Retry-After', String(wait));
      res.setHeader('WWW-Authenticate', 'Bearer realm="cosmic-tv"');
      return send(401, { error: 'Token akses tidak valid.' });
    };
    const rejectAdmin = () => {
      const wait = authLimit(clientIp);
      if (wait) res.setHeader('Retry-After', String(wait));
      return send(401, { error: 'Token admin tidak valid.' });
    };

    const bodyJson = async () => {
      if (!(req.headers['content-type'] || '').startsWith('application/json')) throw new HttpError(400, 'Gunakan Content-Type application/json.');
      const chunks = []; let bytes = 0;
      for await (const chunk of req) {
        bytes += chunk.length;
        if (bytes > 3 * 1024 * 1024) throw new HttpError(413, 'Permintaan maksimum 3 MiB.');
        chunks.push(chunk);
      }
      let value;
      try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
      catch { throw new HttpError(400, 'Body bukan JSON yang valid.'); }
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new HttpError(400, 'Body harus objek JSON.');
      return value;
    };

    try {
      const url = new URL(req.url, 'http://localhost');
      const path = url.pathname;
      const adminOnly = path === '/api/v1/selection' || path === '/api/v1/sources' || path.startsWith('/api/v1/sources/') || path === '/api/v1/refresh' || path === '/api/v1/settings' || path === '/api/v1/test';
      // A read-only listener never advertises or serves management routes.
      if (!adminAccess && (adminOnly || Object.hasOwn(staticFiles, path))) return send(404, { error: 'Endpoint tidak ditemukan.' });

      if (path === '/runtime.js') {
        const origin = settings?.origin() || publicOrigin || `http://${req.headers.host || 'localhost'}`;
        const runtime = `window.COSMIC_PUBLIC_ORIGIN = ${JSON.stringify(origin)};\nwindow.COSMIC_READ_TOKEN_REQUIRED = ${tokenRequired};\n`;
        return send(200, runtime, { type: 'text/javascript; charset=utf-8', cache: true, scope: 'public' });
      }

      if (path === '/api/v1/settings' && settings) {
        if (!authorizedAdmin()) return rejectAdmin();
        if (req.method === 'GET') return send(200, settings.get());
        if (req.method === 'PUT') return send(200, await settings.update(await bodyJson()));
        res.setHeader('Allow', 'GET, PUT');
        return send(405, { error: 'Metode tidak didukung.' });
      }

      if (path === '/api/v1/selection' && service.getSelection && service.setSelection) {
        if (!authorizedAdmin()) return rejectAdmin();
        if (req.method === 'GET') return send(200, service.getSelection());
        if (req.method === 'PUT') return send(200, await service.setSelection((await bodyJson()).channelIds));
        res.setHeader('Allow', 'GET, PUT');
        return send(405, { error: 'Metode tidak didukung.' });
      }
      if ((path === '/api/v1/sources' || /^\/api\/v1\/sources\/[^/]+$/.test(path)) && service.listSources) {
        if (!authorizedAdmin()) return rejectAdmin();
        if (path === '/api/v1/sources' && req.method === 'GET') return send(200, { sources: service.listSources() });
        if (path === '/api/v1/sources' && req.method === 'POST') {
          const item = await service.addSource(await bodyJson());
          void (service.requestRefresh?.() || service.refresh());
          return send(201, item);
        }
        const id = path.split('/')[4];
        if (id && req.method === 'PATCH') {
          const change = await bodyJson();
          await service.changeSource(id, change);
          if (change.enabled) void (service.requestRefresh?.() || service.refresh());
          return send(200, { success: true });
        }
        if (id && req.method === 'DELETE') { await service.deleteSource(id); return send(200, { success: true }); }
        res.setHeader('Allow', path === '/api/v1/sources' ? 'GET, POST' : 'PATCH, DELETE');
        return send(405, { error: 'Metode tidak didukung.' });
      }
      if (path === '/api/v1/refresh') {
        if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return send(405, { error: 'Gunakan POST.' }); }
        if (!authorizedAdmin()) return rejectAdmin();
        if (Date.now() - lastManualRefresh < 30000) { res.setHeader('Retry-After', '30'); return send(429, { error: 'Tunggu 30 detik sebelum memperbarui lagi.' }); }
        lastManualRefresh = Date.now();
        if (service.listSources) { void service.refresh(); return send(202, { success: true, queued: true, ...service.status() }); }
        const ok = await service.refresh();
        return send(ok ? 200 : 502, { success: ok, ...service.status() });
      }
      if (path === '/api/v1/test') {
        if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return send(405, { error: 'Gunakan POST.' }); }
        if (!authorizedAdmin()) return rejectAdmin();
        const body = await bodyJson();
        const channelId = String(body.channelId || '').trim();
        if (!channelId) return send(400, { error: 'channelId wajib.' });
        if (service.verifyChannels) await service.verifyChannels([channelId]);
        const cat = service.getCatalog ? service.getCatalog() : [];
        const channel = cat.find(item => item.id === channelId) || null;
        return send(200, { success: true, channel });
      }
      if (!['GET', 'HEAD'].includes(req.method)) { res.setHeader('Allow', 'GET, HEAD'); return send(405, { error: 'Metode tidak didukung.' }); }
      if (path === '/api/v1/status') return send(200, service.status());

      const read = ['/playlist.m3u', '/api/v1/playlist.m3u', '/api/v1/channels', '/api/v1/catalog'];
      if (read.includes(path)) {
        if (!authorizedRead(url, path === '/playlist.m3u' || path === '/api/v1/playlist.m3u')) return rejectRead();
        if (!service.data) { res.setHeader('Retry-After', '30'); return send(503, { error: 'Playlist belum tersedia. Menunggu sinkronisasi pertama.' }); }
        const status = service.status();
        res.setHeader('X-Playlist-Updated-At', service.fetchedAt || service.lastAttemptAt || 'pending');
        res.setHeader('X-Playlist-State', status.state);
        res.setHeader('Vary', 'Authorization');
        if (path === '/api/v1/channels') return send(200, service.data, { cache: true });
        if (path === '/api/v1/catalog') return send(200, { channels: service.getCatalog ? service.getCatalog() : catalog(service.data) }, { cache: true });
        res.setHeader('Content-Disposition', 'inline; filename="COSMIC-TV.m3u"');
        const filters = {
          q: (url.searchParams.get('q') || '').slice(0, 200),
          group: (url.searchParams.get('group') || '').slice(0, 200),
          drm: url.searchParams.get('drm') || '',
          scheme: url.searchParams.get('scheme') === 'https' ? 'https' : '',
        };
        const body = toM3u(service.data, filters, { revision: status.revision, updatedAt: service.fetchedAt, state: status.state });
        return send(200, body, { type: 'audio/x-mpegurl; charset=utf-8', cache: true });
      }
      if (adminAccess && Object.hasOwn(staticFiles, path)) {
        const [file, type] = staticFiles[path];
        return send(200, await readFile(join(publicDir, file), 'utf8'), { type, cache: true, scope: 'public' });
      }
      return send(404, { error: 'Endpoint tidak ditemukan.' });
    } catch (error) {
      const known = /^(Pilih maksimal|Maksimum|Isi nama|Berkas maksimum|URL sumber|URL harus|URL publik|URL tidak|Isi origin|Sumber |Status sumber|Daftar sumber|Masukkan daftar|Gunakan Content|Body |Permintaan maksimum)/.test(error.message);
      const status = error instanceof HttpError ? error.status : known ? 400 : 500;
      if (status >= 500) console.error(`Permintaan ${req.method} ${String(req.url).slice(0, 200)} gagal: ${error.code || error.name || 'ERROR'}`);
      const message = status >= 500 ? 'Permintaan gagal diproses.' : known ? error.message : 'Permintaan tidak valid.';
      if (res.headersSent) { res.end(); return; }
      send(status, { error: message });
    }
  });
}
