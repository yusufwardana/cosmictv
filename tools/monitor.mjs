#!/usr/bin/env node
// Terminal monitor + fetch UI for COSMIC TV.
// Usage: node monitor.mjs [baseUrl] [--token TOKEN]
// Keys: r=refresh  h=health check  s=show raw status  q=quit  (auto-refresh 5s)

const args = process.argv.slice(2);
const once = args.includes('--once');
let baseUrl = args.find(a => !a.startsWith('--')) || process.env.COSMIC_BASE_URL || 'https://tv.cosmiclabs.web.id';
baseUrl = baseUrl.replace(/\/+$/, '');
const tokenArg = args.indexOf('--token');
const token = tokenArg >= 0 ? args[tokenArg + 1] : (process.env.COSMIC_ADMIN_TOKEN || '');

const RESET = '\x1b[0m', BOLD = '\x1b[1m', DIM = '\x1b[2m';
const GREEN = '\x1b[32m', YELLOW = '\x1b[33m', RED = '\x1b[31m', CYAN = '\x1b[36m';

let lastStatus = null;
let lastError = null;
let lastRefreshResult = null;
let lastHealth = null;
let busy = false;

function clear() { process.stdout.write('\x1b[2J\x1b[H'); }
function colorState(s) {
  if (s === 'ready') return GREEN + s + RESET;
  if (s === 'stale') return YELLOW + s + RESET;
  if (s === 'checking') return CYAN + s + RESET;
  return RED + s + RESET;
}

async function fetchStatus() {
  try {
    const r = await fetch(baseUrl + '/api/v1/status', { signal: AbortSignal.timeout(10000) });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    lastStatus = await r.json();
    lastError = null;
  } catch (e) { lastError = e.message; }
}

async function doRefresh() {
  if (!token) { lastRefreshResult = 'no token (set COSMIC_ADMIN_TOKEN or --token)'; return; }
  busy = true; render();
  try {
    const r = await fetch(baseUrl + '/api/v1/refresh', { method: 'POST', headers: { Authorization: 'Bearer ' + token }, signal: AbortSignal.timeout(15000) });
    const j = await r.json();
    lastRefreshResult = r.ok ? `queued (state=${j.state}, channels=${j.channelCount})` : `HTTP ${r.status}: ${j.error || ''}`;
  } catch (e) { lastRefreshResult = 'ERR: ' + e.message; }
  busy = false;
  await fetchStatus();
}

async function doHealth() {
  busy = true; render();
  const problems = [];
  try {
    const r = await fetch(baseUrl + '/api/v1/status', { signal: AbortSignal.timeout(10000) });
    if (!r.ok) problems.push('status HTTP ' + r.status);
    else { const j = await r.json(); if (j.state !== 'ready') problems.push('state=' + j.state); if (!j.channelCount) problems.push('channelCount=0'); if (j.lastError) problems.push('lastError=' + j.lastError); }
  } catch (e) { problems.push('fetch failed: ' + e.message); }
  try {
    const r = await fetch(baseUrl + '/api/v1/status', { signal: AbortSignal.timeout(15000) });
    // also probe https origin if baseUrl is https
  } catch {}
  lastHealth = problems.length ? 'ALERT: ' + problems.join('; ') : 'OK';
  busy = false;
  render();
}

function render() {
  clear();
  const s = lastStatus;
  console.log(BOLD + 'COSMIC TV Monitor' + RESET + DIM + '  ' + baseUrl + RESET);
  console.log(DIM + 'auto-refresh 5s · keys: r=refresh h=health s=raw q=quit' + (busy ? '  ' + YELLOW + '(busy...)' + RESET : '') + RESET);
  console.log('');
  if (lastError) { console.log(RED + 'Status fetch error: ' + lastError + RESET); }
  else if (s) {
    console.log(BOLD + 'Service' + RESET);
    console.log('  state:        ' + colorState(s.state) + (s.refreshing ? '  ' + CYAN + '(refreshing)' + RESET : ''));
    console.log('  channels:     ' + (s.channelCount ?? 0) + '  streams: ' + (s.sourceCount ?? 0));
    console.log('  selected:     ' + (s.selectedChannelCount ?? 0) + ' / total ' + (s.totalChannelCount ?? 0));
    console.log('  checks:       working=' + (s.checks?.working ?? 0) + ' failed=' + (s.checks?.failed ?? 0) + ' drm=' + (s.checks?.drm ?? 0) + ' unchecked=' + (s.checks?.unchecked ?? 0));
    console.log('  lastAttempt:  ' + (s.lastAttemptAt || '-'));
    console.log('  fetchedAt:    ' + (s.fetchedAt || '-'));
    console.log('  nextRefresh:  ' + (s.nextRefreshAt || '-'));
    if (s.lastError) console.log('  lastError:    ' + RED + s.lastError + RESET);
  } else {
    console.log(DIM + 'loading...' + RESET);
  }
  console.log('');
  if (lastRefreshResult) console.log(CYAN + 'last refresh: ' + RESET + lastRefreshResult);
  if (lastHealth) console.log((lastHealth.startsWith('OK') ? GREEN : RED) + 'health: ' + lastHealth + RESET);
  if (lastHealth && lastHealth.startsWith('ALERT')) console.log(DIM + '  (see ~/logs/cosmictv-health.log on VPS)' + RESET);
}

async function main() {
  if (once) {
    await fetchStatus();
    render();
    process.exit(lastError ? 1 : 0);
  }
  if (!process.stdin.isTTY) { console.error('TTY required (use --once for non-interactive)'); process.exit(1); }
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', async (key) => {
    if (key === 'q' || key === '\u0003') { clear(); process.exit(0); }
    if (busy) return;
    if (key === 'r') await doRefresh();
    else if (key === 'h') await doHealth();
    else if (key === 's') { clear(); console.log(JSON.stringify(lastStatus, null, 2)); await new Promise(r => setTimeout(r, 4000)); }
  });
  await fetchStatus();
  render();
  setInterval(async () => { if (!busy) { await fetchStatus(); render(); } }, 5000);
}

main();
