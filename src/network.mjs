import http from 'node:http';
import https from 'node:https';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

export function publicIPv4(ip) {
  if (isIP(ip) !== 4) return false;
  const [a, b, c] = ip.split('.').map(Number);
  return !(a === 0 || a === 10 || a === 127 || a >= 224 || a === 169 && b === 254 || a === 172 && b >= 16 && b <= 31 ||
    a === 192 && (b === 168 || b === 0 && [0, 2].includes(c) || b === 88 && c === 99) ||
    a === 100 && b >= 64 && b <= 127 || a === 198 && ([18, 19].includes(b) || b === 51 && c === 100) || a === 203 && b === 0 && c === 113);
}

/** Ports that speak something other than media/HTTP; probing them is never legitimate here. */
const DENY_PORTS = new Set([22, 23, 25, 53, 110, 111, 135, 139, 143, 445, 465, 587, 993, 995, 1433, 1521, 2049, 2375, 2376, 3306, 3389, 5432, 5672, 5900, 5984, 6379, 7001, 8086, 9090, 9200, 9300, 11211, 15672, 27017]);

/**
 * Only 80/443, non-privileged ports, and an explicit allowlist are reachable.
 * Media providers do serve streams on high ports, so a fixed allowlist would break real sources.
 */
export function allowedPort(value, allowlist = []) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return false;
  if (port === 80 || port === 443) return true;
  if (allowlist.includes(port)) return true;
  if (port < 1024) return false;
  return !DENY_PORTS.has(port);
}

export async function assertPublicUrl(input, resolver = lookup, allowlist = []) {
  const url = new URL(input);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || /[\r\n]/.test(input)) throw new Error('URL harus HTTP(S) tanpa kredensial URL.');
  if (url.hostname === 'localhost' || !url.hostname.includes('.') || url.hostname.endsWith('.local')) throw new Error('Alamat lokal tidak diizinkan.');
  const port = url.port ? Number(url.port) : url.protocol === 'https:' ? 443 : 80;
  if (!allowedPort(port, allowlist)) throw new Error('Port tujuan tidak diizinkan.');
  const records = isIP(url.hostname) ? [{ address: url.hostname, family: isIP(url.hostname) }] : await resolver(url.hostname, { all: true, family: 4 });
  if (!records.length || records.some(record => !publicIPv4(record.address))) throw new Error('Alamat privat/reserved atau IPv6 tidak diizinkan.');
  return { url, address: records[0].address };
}

const cooling = new Map();
export function cleanHeaders(input = {}) {
  const result = {};
  for (const [name, value] of Object.entries(input)) {
    if (/^[a-z0-9-]+$/i.test(name) && typeof value === 'string' && !/[\r\n\0]/.test(value) && !['host', 'connection', 'content-length', 'transfer-encoding', 'expect', 'proxy-authorization', 'range'].includes(name.toLowerCase())) result[name.toLowerCase()] = value.slice(0, 4096);
  }
  return result;
}

export async function safeRequest(input, options = {}, hop = 0) {
  const { url, address } = await assertPublicUrl(input, lookup, options.allowedPorts || []);
  if ((cooling.get(url.hostname) || 0) > Date.now()) throw new Error('HTTP 429: host sedang dalam masa tunggu.');
  const maxBytes = options.maxBytes ?? 4 * 1024 * 1024;
  const headers = { 'user-agent': 'COSMIC-TV/1.0', accept: '*/*', ...cleanHeaders(options.headers), ...(options.range ? { range: options.range } : {}) };
  const result = await new Promise((resolve, reject) => {
    let settled = false;
    const request = (url.protocol === 'https:' ? https : http).request(url, {
      method: 'GET', headers, family: 4, autoSelectFamily: false,
      lookup: (_hostname, _options, done) => done(null, address, 4),
      signal: AbortSignal.timeout(options.timeoutMs ?? 10000),
    }, response => {
      const chunks = []; let size = 0;
      const finish = () => { if (!settled) { settled = true; const body = Buffer.concat(chunks); resolve({ status: response.statusCode, headers: response.headers, body, text: body.toString('utf8'), url: url.href }); } };
      response.on('data', chunk => {
        const remaining = maxBytes - size;
        if (chunk.length > remaining && !options.truncate) { settled = true; reject(new Error('Respons melewati batas ukuran.')); response.destroy(); return; }
        chunks.push(chunk.subarray(0, remaining)); size += Math.min(remaining, chunk.length);
        if (size >= maxBytes && options.truncate) { finish(); response.destroy(); }
      });
      response.on('end', finish);
      response.on('error', error => { if (!settled) reject(error); });
      if (response.statusCode >= 300 && response.statusCode < 400) { finish(); response.destroy(); }
    });
    request.on('error', error => { if (!settled) reject(error); });
    request.end();
  });
  if (result.status === 429) {
    const retry = result.headers['retry-after'];
    const seconds = /^\d+$/.test(retry || '') ? Number(retry) : Math.max(0, (Date.parse(retry) - Date.now()) / 1000) || 900;
    cooling.set(url.hostname, Date.now() + Math.min(86400, Math.max(60, seconds)) * 1000);
  }
  if ([301, 302, 303, 307, 308].includes(result.status) && result.headers.location) {
    if (hop >= 4) throw new Error('Terlalu banyak redirect.');
    const target = new URL(result.headers.location, url);
    const nextHeaders = { ...headers };
    if (target.origin !== url.origin) { delete nextHeaders.authorization; delete nextHeaders.cookie; }
    return safeRequest(target.href, { ...options, headers: nextHeaders }, hop + 1);
  }
  return result;
}
