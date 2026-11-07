import { readFile, writeFile, rename, mkdir, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

export function isLocalHost(hostname) {
  const host = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host === '::1' || host.endsWith('.local')) return true;
  const octets = host.split('.').map(Number);
  if (octets.length !== 4 || octets.some(part => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  const [a, b] = octets;
  return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
}

export function normalizeOrigin(value) {
  const text = String(value ?? '').trim();
  if (!text) return '';
  let url;
  try { url = new URL(text); } catch { throw new Error('URL harus berbentuk https://host atau http://host:port.'); }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('URL harus memakai http atau https.');
  if (url.username || url.password) throw new Error('URL tidak boleh memuat kredensial.');
  if ((url.pathname && url.pathname !== '/') || url.search || url.hash) throw new Error('Isi origin saja, tanpa path, query, atau fragmen.');
  if (url.protocol === 'http:' && !isLocalHost(url.hostname)) throw new Error('URL publik harus https. http hanya untuk localhost/LAN.');
  return url.origin;
}

function num(value, fallback, min, max, name) {
  const n = value === undefined || value === null || value === '' ? fallback : Number(value);
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${name} harus bilangan bulat ${min}–${max}.`);
  return n;
}
function bool(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const t = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(t)) return true;
  if (['0', 'false', 'no', 'off'].includes(t)) return false;
  throw new Error('Nilai boolean tidak valid.');
}
function ports(value, fallback) {
  const text = value === undefined || value === null || value === '' ? fallback : value;
  const list = String(text).split(',').map(x => Number(x.trim())).filter(n => Number.isInteger(n) && n > 0 && n <= 65535);
  return [...new Set(list)];
}

export class SettingsService {
  constructor({ file, defaults = {}, onChange } = {}) {
    this.file = file;
    this.defaults = {
      publicOrigin: '',
      refreshSeconds: 900,
      verificationSeconds: 1800,
      reuseSeconds: 300,
      upstreamTimeoutSeconds: 20,
      probeSelectedOnly: true,
      rateLimit: 300,
      authFailLimit: 20,
      allowedPorts: [],
      ...defaults,
    };
    this.data = { ...this.defaults };
    this.onChange = typeof onChange === 'function' ? onChange : null;
  }

  async load() {
    try {
      const saved = JSON.parse(await readFile(this.file, 'utf8'));
      if (saved && typeof saved === 'object' && !Array.isArray(saved)) {
        const next = { ...this.defaults };
        if (typeof saved.publicOrigin === 'string') next.publicOrigin = saved.publicOrigin;
        if (saved.refreshSeconds !== undefined) next.refreshSeconds = num(saved.refreshSeconds, this.defaults.refreshSeconds, 60, 86400, 'refreshSeconds');
        if (saved.verificationSeconds !== undefined) next.verificationSeconds = num(saved.verificationSeconds, this.defaults.verificationSeconds, 60, 7200, 'verificationSeconds');
        if (saved.reuseSeconds !== undefined) next.reuseSeconds = num(saved.reuseSeconds, this.defaults.reuseSeconds, 0, 86400, 'reuseSeconds');
        if (saved.upstreamTimeoutSeconds !== undefined) next.upstreamTimeoutSeconds = num(saved.upstreamTimeoutSeconds, this.defaults.upstreamTimeoutSeconds, 1, 120, 'upstreamTimeoutSeconds');
        if (saved.probeSelectedOnly !== undefined) next.probeSelectedOnly = bool(saved.probeSelectedOnly, this.defaults.probeSelectedOnly);
        if (saved.rateLimit !== undefined) next.rateLimit = num(saved.rateLimit, this.defaults.rateLimit, 0, 100000, 'rateLimit');
        if (saved.authFailLimit !== undefined) next.authFailLimit = num(saved.authFailLimit, this.defaults.authFailLimit, 0, 10000, 'authFailLimit');
        if (saved.allowedPorts !== undefined) next.allowedPorts = ports(saved.allowedPorts, this.defaults.allowedPorts);
        this.data = next;
      }
    } catch (error) {
      if (error.code !== 'ENOENT') this.data = { ...this.defaults };
    }
    return this.get();
  }

  get() { return { ...this.data, readOnly: false }; }

  origin() { return this.data.publicOrigin || ''; }

  async update(change) {
    const next = { ...this.data };
    if (Object.hasOwn(change ?? {}, 'publicOrigin')) next.publicOrigin = normalizeOrigin(change.publicOrigin);
    if (Object.hasOwn(change ?? {}, 'refreshSeconds')) next.refreshSeconds = num(change.refreshSeconds, this.data.refreshSeconds, 60, 86400, 'refreshSeconds');
    if (Object.hasOwn(change ?? {}, 'verificationSeconds')) next.verificationSeconds = num(change.verificationSeconds, this.data.verificationSeconds, 60, 7200, 'verificationSeconds');
    if (Object.hasOwn(change ?? {}, 'reuseSeconds')) next.reuseSeconds = num(change.reuseSeconds, this.data.reuseSeconds, 0, 86400, 'reuseSeconds');
    if (Object.hasOwn(change ?? {}, 'upstreamTimeoutSeconds')) next.upstreamTimeoutSeconds = num(change.upstreamTimeoutSeconds, this.data.upstreamTimeoutSeconds, 1, 120, 'upstreamTimeoutSeconds');
    if (Object.hasOwn(change ?? {}, 'probeSelectedOnly')) next.probeSelectedOnly = bool(change.probeSelectedOnly, this.data.probeSelectedOnly);
    if (Object.hasOwn(change ?? {}, 'rateLimit')) next.rateLimit = num(change.rateLimit, this.data.rateLimit, 0, 100000, 'rateLimit');
    if (Object.hasOwn(change ?? {}, 'authFailLimit')) next.authFailLimit = num(change.authFailLimit, this.data.authFailLimit, 0, 10000, 'authFailLimit');
    if (Object.hasOwn(change ?? {}, 'allowedPorts')) next.allowedPorts = ports(change.allowedPorts, this.data.allowedPorts);
    await mkdir(dirname(this.file), { recursive: true });
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    try { await writeFile(temporary, JSON.stringify(next), { mode: 0o600 }); await rename(temporary, this.file); }
    finally { await unlink(temporary).catch(() => {}); }
    this.data = next;
    if (this.onChange) try { this.onChange(next); } catch {}
    return this.get();
  }
}
