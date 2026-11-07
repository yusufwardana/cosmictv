import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile, mkdir, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { cleanHeaders, safeRequest } from './network.mjs';
import { parseSource } from './import.mjs';
import { probeStream } from './probe.mjs';
import { sourcesFor, drmFor, catalog } from './playlist.mjs';

const stable = value => JSON.stringify(value, (_key, item) => item && !Array.isArray(item) && typeof item === 'object' ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
const hash = value => createHash('sha256').update(stable(value)).digest('hex');
const fingerprint = stream => hash({ url: stream.url, headers: stream.headers, drmConfig: stream.drmConfig });

export class AggregateService {
  constructor(options) {
    this.options = options;
    this.options.upstream = 'Multi-source COSMIC';
    this.config = [{ id: 'dopamine', name: 'DopamineTV (JSON)', type: 'signed', enabled: true }];
    this.feeds = {};
    this.candidates = [];
    this.checks = {};
    this.selectedChannelIds = new Set();
    this.selectionInitialized = false;
    this.inflight = null;
    this.fetchedAt = null;
    this.lastAttemptAt = null;
    this.lastError = null;
    this.nextRefreshAt = null;
    this.progress = { phase: 'idle', done: 0, total: 0 };
  }

  async atomic(name, data) {
    await mkdir(this.options.directory, { recursive: true });
    const destination = join(this.options.directory, name);
    const temporary = `${destination}.${randomUUID()}.tmp`;
    try { await writeFile(temporary, JSON.stringify(data), { mode: 0o600 }); await rename(temporary, destination); }
    finally { await unlink(temporary).catch(() => {}); }
  }

  async load() {
    try {
      const saved = JSON.parse(await readFile(join(this.options.directory, 'sources.json'), 'utf8'));
      if (!Array.isArray(saved) || saved.length > 20 || !saved.some(item => item.id === 'dopamine')) throw new Error('Invalid source config');
      this.config = saved;
    } catch (error) { if (error.code !== 'ENOENT') throw new Error('Konfigurasi sumber rusak; pulihkan data/sources.json.'); }
    try {
      const snapshot = JSON.parse(await readFile(join(this.options.directory, 'aggregate.json'), 'utf8'));
      if (snapshot.version !== 1 || !snapshot.feeds || !snapshot.checks) throw new Error('Invalid snapshot');
      this.feeds = snapshot.feeds; this.checks = snapshot.checks; this.fetchedAt = snapshot.fetchedAt;
      this.rebuild();
    } catch (error) { if (error.code !== 'ENOENT') this.lastError = 'Cache gabungan tidak valid; menunggu pemrosesan ulang.'; }
    try {
      const saved = JSON.parse(await readFile(join(this.options.directory, 'selection.json'), 'utf8'));
      if (!Array.isArray(saved) || saved.length > 3000 || !saved.every(id => typeof id === 'string' && /^[a-f0-9]{20}$/.test(id))) throw new Error('Invalid selection');
      this.selectedChannelIds = new Set(saved);
      this.selectionInitialized = true;
    } catch (error) { if (error.code !== 'ENOENT') throw new Error('Pilihan playlist rusak; pulihkan data/selection.json.'); }
    await this.initializeSelection();
  }

  async initializeSelection() {
    if (this.selectionInitialized || !this.candidates.length) return;
    this.selectedChannelIds = new Set(this.candidates.filter(channel => channel.sources.some(stream => stream.feedIds.includes('dopamine'))).map(channel => channel.id));
    this.selectionInitialized = true;
    await this.atomic('selection.json', [...this.selectedChannelIds]);
  }

  getSelection() {
    return { channelIds: [...this.selectedChannelIds], selectedCount: this.selectedChannelIds.size,
      availableCount: this.candidates.length, includedCount: this.data?.channels.length || 0 };
  }

  async setSelection(channelIds) {
    if (!Array.isArray(channelIds) || channelIds.length > 3000 || !channelIds.every(id => typeof id === 'string' && /^[a-f0-9]{20}$/.test(id))) {
      throw new Error('Pilih maksimal 3.000 ID channel yang valid.');
    }
    const next = [...new Set(channelIds)];
    const added = next.filter(id => !this.selectedChannelIds.has(id));
    await this.atomic('selection.json', next);
    this.selectedChannelIds = new Set(next);
    this.selectionInitialized = true;
    // Newly selected channels have no verdict yet; verify them now instead of exporting nothing.
    if (added.length) await this.verifyChannels(added);
    return this.getSelection();
  }

  /** Probes streams of the given channels that have no fresh verdict (bounded concurrency). */
  async verifyChannels(ids) {
    const streams = [...new Map(this.candidates.filter(channel => ids.includes(channel.id)).flatMap(channel => channel.sources).map(stream => [stream._key, stream])).values()]
      .filter(stream => this.checkFor(stream).state === 'unchecked');
    if (!streams.length) return 0;
    let index = 0;
    const worker = async () => {
      while (index < streams.length) {
        const stream = streams[index++];
        try { this.checks[stream._key] = await (this.options.probe || probeStream)(stream, undefined, { allowedPorts: this.options.allowedPorts || [] }); }
        catch { this.checks[stream._key] = { state: 'failed', reason: 'Pemeriksaan gagal.', checkedAt: new Date().toISOString() }; }
      }
    };
    await Promise.all(Array.from({ length: Math.min(4, streams.length) }, worker));
    if (this.fetchedAt) {
      await this.atomic('aggregate.json', { version: 1, feeds: this.feeds, checks: this.checks, fetchedAt: this.fetchedAt }).catch(() => {});
    }
    return streams.length;
  }

  listSources() {
    return this.config.map(({ content, headers, ...item }) => ({ ...item, headerNames: Object.keys(headers || {}), importedAt: this.feeds[item.id]?.fetchedAt || null, error: this.feeds[item.id]?.error || null,
      channelCount: this.feeds[item.id]?.data?.channels?.length || 0,
    }));
  }

  async addSource(input) {
    if (this.config.length >= 20) throw new Error('Maksimum 20 sumber.');
    const name = String(input.name || '').trim().slice(0, 100);
    if (!name || (!!input.url === !!input.content)) throw new Error('Isi nama dan pilih satu URL atau berkas M3U.');
    const item = { id: randomUUID(), name, enabled: true, type: input.content ? 'upload' : 'url', headers: cleanHeaders(input.headers || {}) };
    if (input.content) { if (typeof input.content !== 'string' || input.content.length > 2 * 1024 * 1024) throw new Error('Berkas maksimum 2 MiB.'); parseSource(input.content); item.content = input.content; }
    else {
      const url = new URL(input.url);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || input.url.length > 4096) throw new Error('URL sumber tidak valid.');
      item.url = url.href;
    }
    if (this.config.some(source => item.url && item.url === source.url)) throw new Error('URL sumber sudah ditambahkan.');
    await this.atomic('sources.json', [...this.config, item]);
    this.config.push(item);
    return { id: item.id, name: item.name };
  }

  async changeSource(id, change) {
    const source = this.config.find(item => item.id === id);
    if (!source) throw new Error('Sumber tidak ditemukan.');
    if (typeof change.enabled !== 'boolean') throw new Error('Status sumber harus true/false.');
    const next = this.config.map(item => item.id === id ? { ...item, enabled: change.enabled } : item);
    await this.atomic('sources.json', next); this.config = next; this.rebuild();
  }

  async deleteSource(id) {
    if (id === 'dopamine') throw new Error('Sumber bawaan dapat dinonaktifkan, tidak dihapus.');
    if (!this.config.some(item => item.id === id)) throw new Error('Sumber tidak ditemukan.');
    const next = this.config.filter(item => item.id !== id);
    await this.atomic('sources.json', next); this.config = next; delete this.feeds[id]; this.rebuild();
  }

  rebuild() {
    const merged = new Map(); let streams = 0;
    for (const feed of this.config.filter(item => item.enabled)) {
      for (const channel of this.feeds[feed.id]?.data?.channels || []) {
        if (streams >= 3000) break;
        const identity = channel.tvgId ? `id:${String(channel.tvgId).trim().toLowerCase()}` : `name:${String(channel.name).trim().toLowerCase()}|${channel.groupTitle || 'General'}`;
        if (!merged.has(identity)) merged.set(identity, { ...channel, id: hash(identity).slice(0, 20), headers: {}, drmConfig: null, sources: [] });
        const target = merged.get(identity);
        for (const input of sourcesFor(channel)) {
          if (streams >= 3000) break;
          const stream = { ...input, headers: cleanHeaders({ ...channel.headers, ...input.headers }), drmConfig: drmFor(channel, input) ?? null };
          const key = fingerprint(stream);
          const existing = target.sources.find(item => item._key === key);
          if (existing) { if (!existing.feedIds.includes(feed.id)) existing.feedIds.push(feed.id); continue; }
          target.sources.push({ ...stream, _key: key, feedIds: [feed.id] }); streams++;
        }
      }
    }
    this.candidates = [...merged.values()].filter(channel => channel.sources.length);
  }

  checkFor(stream) {
    const check = this.checks[stream._key];
    if (!check) return { state: 'unchecked', reason: 'Belum diperiksa.', checkedAt: null };
    if (!Number.isFinite(Date.parse(check.checkedAt)) || Date.now() - Date.parse(check.checkedAt) > (this.options.verificationSeconds || 1800) * 1000) return { ...check, state: 'unchecked', reason: 'Hasil pemeriksaan kedaluwarsa.' };
    return check;
  }

  get data() {
    if (!this.candidates.length) return null;
    return { success: true, channels: this.candidates.filter(channel => this.selectedChannelIds.has(channel.id))
      .map(channel => ({ ...channel, sources: channel.sources.filter(stream => this.checkFor(stream).state === 'working').map(({ _key, ...stream }) => ({ ...stream, verification: this.checkFor({ _key }) })) })).filter(channel => channel.sources.length) };
  }

  getCatalog() {
    return this.candidates.map(channel => {
      const item = catalog({ channels: [channel] })[0];
      const checks = channel.sources.map(stream => this.checkFor(stream));
      return { ...item, passedSourceCount: checks.filter(check => check.state === 'working').length,
        selected: this.selectedChannelIds.has(channel.id),
        health: checks.some(check => check.state === 'working') ? 'working' : checks.some(check => check.state === 'unchecked') ? 'unchecked' : checks.some(check => check.state === 'drm') ? 'drm' : checks.some(check => check.state === 'unsupported') ? 'unsupported' : 'failed',
        checkedAt: checks.map(check => check.checkedAt).filter(Boolean).sort().at(-1) || null,
        reason: [...new Set(checks.map(check => check.reason))].join(' · ').slice(0, 250),
      };
    });
  }

  status() {
    const all = this.candidates.flatMap(channel => channel.sources);
    const counts = { working: 0, failed: 0, drm: 0, unsupported: 0, unchecked: 0 };
    for (const stream of all) counts[this.checkFor(stream).state]++;
    const output = this.data;
    return { state: output?.channels.length ? (this.lastError ? 'stale' : 'ready') : this.inflight ? 'checking' : 'empty', refreshing: !!this.inflight,
      fetchedAt: this.fetchedAt, lastAttemptAt: this.lastAttemptAt, nextRefreshAt: this.nextRefreshAt, lastError: this.lastError,
      refreshSeconds: this.options.refreshSeconds, verificationSeconds: this.options.verificationSeconds || 1800,
      probeSelectedOnly: this.options.probeSelectedOnly !== false,
      channelCount: output?.channels.length || 0, sourceCount: output?.channels.reduce((sum, channel) => sum + channel.sources.length, 0) || 0,
      selectedChannelCount: [...this.selectedChannelIds].filter(id => this.candidates.some(channel => channel.id === id)).length,
      totalChannelCount: this.candidates.length, totalSourceCount: all.length,
      drmSourceCount: counts.drm, checks: counts, progress: { ...this.progress }, feedCount: this.config.length, enabledFeedCount: this.config.filter(item => item.enabled).length,
      upstream: 'Multi-source COSMIC', revision: hash([this.fetchedAt, this.progress.done, this.config.map(item => [item.id, item.enabled]), [...this.selectedChannelIds].sort()]).slice(0, 20),
    };
  }

  refresh() {
    if (this.inflight) return this.inflight;
    this.inflight = this.update().finally(() => { this.inflight = null; this.progress.phase = 'idle'; });
    return this.inflight;
  }

  requestRefresh() {
    if (!this.inflight) return this.refresh();
    if (!this.refreshQueued) {
      this.refreshQueued = true;
      void this.inflight.finally(() => { this.refreshQueued = false; void this.refresh(); });
    }
    return this.inflight;
  }

  async update() {
    this.lastAttemptAt = new Date().toISOString(); this.lastError = null;
    this.progress = { phase: 'import', done: 0, total: 0 };
    let imported = 0;
    try {
      for (const source of this.config.filter(item => item.enabled)) {
        try {
          let data;
          const cached = this.feeds[source.id];
          if (this.options.reuseSeconds && cached?.data && !cached.error && Date.now() - Date.parse(cached.fetchedAt) < this.options.reuseSeconds * 1000) {
            imported++; continue;
          } else if (source.type === 'signed') {
            const ok = await this.options.primary.refresh();
            if (!ok) throw new Error('Sumber JSON menolak pembaruan; cache kandidat dipertahankan.');
            data = this.options.primary.data;
          } else if (source.type === 'upload') data = parseSource(source.content);
          else {
            const response = await (this.options.request || safeRequest)(source.url, { headers: source.headers, timeoutMs: 20000, maxBytes: 4 * 1024 * 1024, allowedPorts: this.options.allowedPorts || [] });
            if (response.status !== 200) throw new Error(`HTTP ${response.status}`);
            data = parseSource(response.text, response.url);
          }
          this.feeds[source.id] = { data, fetchedAt: new Date().toISOString(), error: null }; imported++;
        } catch (error) {
          const message = /HTTP \d{3}/.exec(error.message)?.[0] || (source.type === 'signed' ? error.message : 'Gagal mengambil/membaca daftar sumber.');
          this.feeds[source.id] = { ...this.feeds[source.id], error: message };
          this.lastError = 'Sebagian sumber gagal diperbarui. Hanya hasil pemeriksaan yang masih berlaku diekspor.';
        }
      }
      this.rebuild();
      await this.initializeSelection();
      // Only channels in the final playlist are verified by default: probing the whole
      // catalogue every cycle multiplies outbound traffic to third-party CDNs for nothing.
      const selectedOnly = this.options.probeSelectedOnly !== false;
      const scope = selectedOnly ? this.candidates.filter(channel => this.selectedChannelIds.has(channel.id)) : this.candidates;
      const unique = [...new Map(scope.flatMap(channel => channel.sources).map(stream => [stream._key, stream])).values()]
        .sort((a, b) => (Date.parse(this.checks[a._key]?.checkedAt) || 0) - (Date.parse(this.checks[b._key]?.checkedAt) || 0));
      this.progress = { phase: 'check', done: 0, total: unique.length };
      const busy = new Set(); const pending = unique.filter(stream => {
        const check = this.checks[stream._key];
        return !this.options.reuseSeconds || !check || this.checkFor(stream).state === 'unchecked' || Date.now() - Date.parse(check.checkedAt) >= this.options.reuseSeconds * 1000;
      });
      this.progress.done = unique.length - pending.length;
      const deadline = Date.now() + (this.options.scanBudgetMs || 300000);
      await new Promise(resolve => {
        let active = 0;
        const dispatch = () => {
          if (Date.now() > deadline) pending.length = 0;
          while (active < 4) {
            const index = pending.findIndex(stream => !busy.has(new URL(stream.url).hostname));
            if (index < 0) break;
            const [stream] = pending.splice(index, 1); const host = new URL(stream.url).hostname;
            busy.add(host); active++;
            Promise.resolve().then(() => (this.options.probe || probeStream)(stream, undefined, { allowedPorts: this.options.allowedPorts || [] })).then(check => { this.checks[stream._key] = check; })
              .catch(() => { this.checks[stream._key] = { state: 'failed', reason: 'Pemeriksaan gagal.', checkedAt: new Date().toISOString() }; })
              .finally(() => { active--; busy.delete(host); this.progress.done++; dispatch(); });
          }
          if (!active && !pending.length) resolve();
        };
        dispatch();
      });
      this.fetchedAt = new Date().toISOString();
      // Keep history for every known stream, including channels not currently selected.
      const keys = new Set(this.candidates.flatMap(channel => channel.sources).map(stream => stream._key));
      this.checks = Object.fromEntries(Object.entries(this.checks).filter(([key]) => keys.has(key)));
      await this.atomic('aggregate.json', { version: 1, feeds: this.feeds, checks: this.checks, fetchedAt: this.fetchedAt });
      return imported > 0;
    } catch {
      this.lastError = 'Pemrosesan atau penyimpanan hasil gagal. Hanya pemeriksaan yang masih berlaku diekspor.';
      return false;
    }
  }
}
