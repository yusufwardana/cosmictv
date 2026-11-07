import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile, rename, mkdir, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { validatePayload, sourcesFor, drmFor } from './playlist.mjs';

export const signRequest = (deviceId, timestamp, secret) => createHash('sha256').update(`${deviceId}:${timestamp}:${secret}`).digest('hex');

/** Retry-After is either delta-seconds or an HTTP date; returns milliseconds (capped at 24h). */
export function retryAfterMs(value, now = Date.now()) {
  if (value === undefined || value === null || value === '') return null;
  const text = String(value).trim();
  if (/^\d+$/.test(text)) return Math.min(86400, Number(text)) * 1000;
  const at = Date.parse(text);
  return Number.isFinite(at) ? Math.min(86400000, Math.max(0, at - now)) : null;
}

const ERROR_KINDS = { 401: 'auth', 403: 'denied', 429: 'rate-limited' };

export class PlaylistService {
  constructor(options) {
    this.options = options;
    this.cacheFile = options.cacheFile;
    this.data = null;
    this.fetchedAt = null;
    this.lastAttemptAt = null;
    this.lastError = null;
    this.lastErrorKind = null;
    this.lastStatus = null;
    this.failures = 0;
    this.retryAt = null;
    this.inflight = null;
    this.nextRefreshAt = null;
  }

  async load() {
    try {
      const snapshot = JSON.parse(await readFile(this.cacheFile, 'utf8'));
      validatePayload(snapshot.data);
      if (!Number.isFinite(Date.parse(snapshot.fetchedAt))) throw new Error('Invalid timestamp');
      this.data = snapshot.data;
      this.fetchedAt = snapshot.fetchedAt;
    } catch (error) {
      if (error.code !== 'ENOENT') this.lastError = 'Cache lokal tidak valid; menunggu pembaruan.';
    }
  }

  status() {
    const age = this.fetchedAt ? Math.max(0, Date.now() - Date.parse(this.fetchedAt)) : null;
    return {
      state: !this.data ? 'unavailable' : this.lastError || age > this.options.refreshSeconds * 2000 ? 'stale' : 'ready',
      refreshing: !!this.inflight, fetchedAt: this.fetchedAt, lastAttemptAt: this.lastAttemptAt,
      nextRefreshAt: this.nextRefreshAt, lastError: this.lastError, lastErrorKind: this.lastErrorKind, lastStatus: this.lastStatus,
      retryAt: this.retryAt, failures: this.failures, nextDelaySeconds: Math.round(this.nextDelayMs() / 1000),
      refreshSeconds: this.options.refreshSeconds,
      channelCount: this.data?.channels.length ?? 0,
      sourceCount: this.data?.channels.reduce((sum, channel) => sum + sourcesFor(channel).length, 0) ?? 0,
      drmSourceCount: this.data?.channels.reduce((sum, channel) => sum + sourcesFor(channel).filter(source => drmFor(channel, source)?.type).length, 0) ?? 0,
      upstream: this.options.upstream,
    };
  }

  /** Delay before the next scheduled attempt: honours Retry-After, then exponential backoff (capped at 6h). */
  nextDelayMs(now = Date.now()) {
    const base = (this.options.refreshSeconds || 900) * 1000;
    const cap = 6 * 3600 * 1000;
    if (this.retryAt) {
      const wait = Date.parse(this.retryAt) - now;
      if (Number.isFinite(wait) && wait > 0) return Math.min(cap, Math.max(wait, 1000));
    }
    if (this.failures > 0) return Math.min(cap, base * 2 ** Math.min(this.failures, 5));
    return base;
  }

  refresh() {
    if (this.inflight) return this.inflight;
    this.inflight = this.update().finally(() => { this.inflight = null; });
    return this.inflight;
  }

  async update() {
    this.lastAttemptAt = new Date().toISOString();
    this.retryAt = null; // the hint has been consumed by attempting again
    let temporary;
    try {
      const timestamp = Date.now();
      const response = await (this.options.fetcher ?? fetch)(this.options.upstream, {
        method: 'GET', redirect: 'error', signal: AbortSignal.timeout(this.options.timeoutMs ?? 20000),
        headers: {
          'User-Agent': 'DopamineTV/1.0.8 (Android; ARM) Kodi/21.0',
          Accept: '*/*', 'X-Device-Id': this.options.deviceId,
          'X-Device-Model': 'Android', 'X-Device-Type': 'Smartphone',
          'X-Device-Android': 'Android 13 (API 33)', 'X-App-Version': '1.0.8',
          'X-App-Timestamp': String(timestamp), 'X-App-Signature': signRequest(this.options.deviceId, timestamp, this.options.secret),
        },
      });
      if (!response.ok) {
        await response.body?.cancel();
        const error = new Error(`Sumber mengembalikan HTTP ${response.status}.`);
        error.status = response.status;
        error.kind = ERROR_KINDS[response.status] || 'http';
        error.retryAfterMs = retryAfterMs(response.headers?.get?.('retry-after'));
        throw error;
      }
      const limit = this.options.maxBytes ?? 8 * 1024 * 1024;
      const chunks = [];
      let size = 0;
      for await (const chunk of response.body) {
        size += chunk.length;
        if (size > limit) throw new Error('Respons sumber melewati batas ukuran.');
        chunks.push(chunk);
      }
      let data;
      try { data = validatePayload(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { throw new Error('Respons sumber bukan daftar channel yang valid.'); }
      const fetchedAt = new Date().toISOString();
      await mkdir(dirname(this.cacheFile), { recursive: true });
      temporary = `${this.cacheFile}.${randomUUID()}.tmp`;
      await writeFile(temporary, JSON.stringify({ fetchedAt, data }), { mode: 0o600 });
      await rename(temporary, this.cacheFile);
      this.data = data;
      this.fetchedAt = fetchedAt;
      this.lastError = null;
      this.lastErrorKind = null;
      this.lastStatus = 200;
      this.failures = 0;
      this.retryAt = null;
      return true;
    } catch (error) {
      this.failures += 1;
      this.lastStatus = Number.isInteger(error.status) ? error.status : null;
      this.lastErrorKind = error.kind || (error.name === 'TimeoutError' ? 'timeout' : /^Respons sumber/.test(error.message) ? 'invalid-payload' : 'network');
      if (error.retryAfterMs) this.retryAt = new Date(Date.now() + error.retryAfterMs).toISOString();
      this.lastError = error.name === 'TimeoutError' ? 'Sumber melewati batas waktu permintaan.' :
        /^(Sumber |Respons sumber )/.test(error.message) ? error.message : 'Pembaruan gagal; cache terakhir tetap disajikan.';
      return false;
    } finally {
      if (temporary) await unlink(temporary).catch(() => {});
    }
  }
}
