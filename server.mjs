import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { PlaylistService } from './src/service.mjs';
import { createApp, parseTokenList } from './src/http.mjs';
import { AggregateService } from './src/aggregate.mjs';
import { SettingsService } from './src/settings.mjs';

const root = dirname(fileURLToPath(import.meta.url));
if (existsSync(join(root, '.env'))) process.loadEnvFile(join(root, '.env'));
const env = process.env;
const number = (name, fallback, min, max) => {
  const value = Number(env[name] || fallback);
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${name} harus antara ${min} dan ${max}.`);
  return value;
};
const flag = (name, fallback) => {
  const value = String(env[name] ?? '').trim().toLowerCase();
  if (!value) return fallback;
  if (['1', 'true', 'yes', 'on'].includes(value)) return true;
  if (['0', 'false', 'no', 'off'].includes(value)) return false;
  throw new Error(`${name} harus true/false.`);
};
for (const name of ['UPSTREAM_SECRET', 'DEVICE_ID', 'ADMIN_TOKEN']) {
  if (!env[name] || env[name].includes('CHANGE_ME')) throw new Error(`Isi ${name} di .env sebelum menjalankan server.`);
}
if (env.ADMIN_TOKEN.length < 24) throw new Error('ADMIN_TOKEN minimal 24 karakter.');
const upstream = env.UPSTREAM_URL || 'https://dopaminetv.mikrofast.my.id/api/v1/channels';
const upstreamUrl = new URL(upstream);
if (upstreamUrl.protocol !== 'https:' || upstreamUrl.username || upstreamUrl.password) throw new Error('UPSTREAM_URL harus HTTPS tanpa kredensial URL.');

const readTokens = parseTokenList(env.READ_TOKENS);
const envAllowedPorts = String(env.ALLOWED_PORTS || '').split(',').map(item => Number(item.trim())).filter(port => Number.isInteger(port) && port > 0);

const dataDir = resolve(root, 'data');
const settingsFile = resolve(dataDir, 'settings.json');

// Load persisted settings first so runtime config reflects admin changes.
const settings = new SettingsService({
  file: settingsFile,
  defaults: {
    publicOrigin: env.PUBLIC_ORIGIN || '',
    refreshSeconds: number('REFRESH_SECONDS', 900, 60, 86400),
    verificationSeconds: number('VERIFICATION_SECONDS', 1800, 60, 7200),
    reuseSeconds: number('REUSE_SECONDS', 300, 0, 86400),
    upstreamTimeoutSeconds: number('UPSTREAM_TIMEOUT_SECONDS', 20, 1, 120),
    probeSelectedOnly: flag('PROBE_SELECTED_ONLY', true),
    rateLimit: number('RATE_LIMIT', 300, 0, 100000),
    authFailLimit: number('AUTH_FAIL_LIMIT', 20, 0, 10000),
    allowedPorts: envAllowedPorts,
  },
});
await settings.load();

const runtimeConfig = {
  rateLimit: settings.data.rateLimit,
  authFailLimit: settings.data.authFailLimit,
  allowedPorts: settings.data.allowedPorts,
};

const port = number('PORT', 8787, 1, 65535);
const host = env.HOST || '127.0.0.1';
const adminPort = number('ADMIN_PORT', 8788, 1, 65535);
const adminHost = env.ADMIN_HOST || '127.0.0.1';
if (adminPort === port && adminHost === host) throw new Error('ADMIN_PORT/HOST harus berbeda dari PORT/HOST agar panel admin terpisah.');
const publicOrigin = settings.data.publicOrigin || env.PUBLIC_ORIGIN || `http://${host}:${port}`;

const primary = new PlaylistService({
  upstream, secret: env.UPSTREAM_SECRET, deviceId: env.DEVICE_ID,
  refreshSeconds: settings.data.refreshSeconds,
  timeoutMs: settings.data.upstreamTimeoutSeconds * 1000,
  cacheFile: resolve(root, env.CACHE_FILE || 'data/snapshot.json'),
});
await primary.load();

const service = new AggregateService({
  primary, directory: dataDir,
  reuseSeconds: settings.data.reuseSeconds,
  refreshSeconds: settings.data.refreshSeconds,
  verificationSeconds: settings.data.verificationSeconds,
  probeSelectedOnly: settings.data.probeSelectedOnly,
  allowedPorts: settings.data.allowedPorts,
});
await service.load();

settings.onChange = (next) => {
  // Push runtime changes into service + primary options.
  if (primary.options) {
    primary.options.refreshSeconds = next.refreshSeconds;
    primary.options.timeoutMs = next.upstreamTimeoutSeconds * 1000;
  }
  if (service.options) {
    service.options.refreshSeconds = next.refreshSeconds;
    service.options.verificationSeconds = next.verificationSeconds;
    service.options.reuseSeconds = next.reuseSeconds;
    service.options.probeSelectedOnly = next.probeSelectedOnly;
    service.options.allowedPorts = next.allowedPorts;
  }
  runtimeConfig.rateLimit = next.rateLimit;
  runtimeConfig.authFailLimit = next.authFailLimit;
  runtimeConfig.allowedPorts = next.allowedPorts;
  service.rebuild?.();
};

const publicApp = createApp({ service, settings, adminToken: env.ADMIN_TOKEN, publicDir: join(root, 'public'), allowAdmin: flag('ADMIN_WEB_PANEL', true), readTokens, publicOrigin, runtimeConfig, rateLimit: settings.data.rateLimit, authFailLimit: settings.data.authFailLimit });
const adminApp = createApp({ service, settings, adminToken: env.ADMIN_TOKEN, publicDir: join(root, 'public'), allowAdmin: true, readTokens: [], readTokenRequired: readTokens.length > 0, publicOrigin, runtimeConfig, rateLimit: settings.data.rateLimit, authFailLimit: settings.data.authFailLimit });

for (const [app, name] of [[publicApp, 'publik'], [adminApp, 'admin']]) {
  app.requestTimeout = 30000;
  app.headersTimeout = 10000;
  app.on('error', error => { console.error(`Server ${name} gagal: ${error.code || 'UNKNOWN'}`); process.exitCode = 1; });
  app.on('clientError', (_error, socket) => socket.destroy());
}
const listen = (app, listenHost, listenPort) => new Promise((accept, reject) => {
  const onError = error => { app.off('listening', onListening); reject(error); };
  const onListening = () => { app.off('error', onError); accept(); };
  app.once('error', onError);
  app.once('listening', onListening);
  app.listen(listenPort, listenHost);
});
await listen(publicApp, host, port);
await listen(adminApp, adminHost, adminPort);
console.log(`COSMIC TV API publik: http://${host}:${port}${readTokens.length ? ' (token baca wajib)' : ' (tanpa token baca)'}`);
console.log(`COSMIC TV admin: http://${adminHost}:${adminPort}`);
if (flag('ADMIN_WEB_PANEL', true)) console.log(`Panel admin (web): http://${host}:${port}/ — butuh ADMIN_TOKEN untuk aksi. Aktifkan HTTPS bila lewat internet.`);
else console.log('Panel admin hanya di listener admin (ADMIN_WEB_PANEL=false).');
if (adminHost === '0.0.0.0' || adminHost === '::') console.warn('PERINGATAN: panel admin terbuka di semua antarmuka lewat HTTP polos. Gunakan HTTPS atau ADMIN_HOST=127.0.0.1.');

let stopping = false;
let timer;
const refreshDelayMs = () => {
  const base = service.options.refreshSeconds * 1000;
  const backoff = primary.failures > 0 ? primary.nextDelayMs() : base;
  const jitter = 0.9 + Math.random() * 0.2;
  return Math.min(6 * 3600 * 1000, Math.max(base * 0.5, Math.round(Math.max(base, backoff) * jitter)));
};
async function scheduledRefresh() {
  await service.refresh();
  const status = service.status();
  console.log(`${new Date().toISOString()} sync=${status.lastError ? 'failed' : 'ok'} channels=${status.channelCount} sources=${status.sourceCount} state=${status.state}`);
  if (stopping) return;
  const delay = refreshDelayMs();
  service.nextRefreshAt = new Date(Date.now() + delay).toISOString();
  timer = setTimeout(scheduledRefresh, delay);
}
void scheduledRefresh();
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
  stopping = true;
  clearTimeout(timer);
  let pending = 2;
  const done = () => { if (--pending <= 0) process.exit(0); };
  publicApp.close(done);
  adminApp.close(done);
  setTimeout(() => process.exit(0), 5000).unref();
});
