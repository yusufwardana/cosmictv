const clean = value => String(value ?? '').replace(/[\r\n\u0000-\u001f]/g, ' ');
const attr = value => clean(value).replaceAll('"', "'");

/** Format identifier written into the playlist marker line. Bump on breaking changes. */
export const PLAYLIST_FORMAT = 1;

/** Header names that must never be exported into a playlist a client can read. */
export function sensitiveHeader(name) {
  const key = String(name).toLowerCase();
  return /^(authorization|proxy-authorization|cookie|set-cookie|x-api-key|api-key|x-auth-token|x-access-token|x-xsrf-token|x-csrf-token)$/.test(key) ||
    /(^|-)(auth|authorization|token|secret|cookie|session|password|apikey|signature|credential)(-|$)/.test(key);
}

export function validUrl(value) {
  if (typeof value !== 'string' || /[\r\n\u0000-\u0020]/.test(value)) return false;
  try { return ['http:', 'https:'].includes(new URL(value).protocol); } catch { return false; }
}

export function sourcesFor(channel) {
  const sources = Array.isArray(channel?.sources) && channel.sources.length ? channel.sources : [channel];
  return sources.filter(source => source && validUrl(source.url));
}

export const drmFor = (channel, source) => Object.hasOwn(source, 'drmConfig') ? source.drmConfig : channel.drmConfig;

export function validatePayload(data) {
  if (!data || data.success === false || !Array.isArray(data.channels) || !data.channels.length || data.channels.length > 10000) {
    throw new Error('Respons sumber tidak berisi daftar channel yang valid.');
  }
  if (!data.channels.every(channel => channel && typeof channel === 'object') || !data.channels.some(channel => sourcesFor(channel).length)) {
    throw new Error('Tidak ada URL siaran HTTP(S) yang valid.');
  }
  return data;
}

const keepSource = (channel, source, { drm = '', scheme = '' } = {}) =>
  (!scheme || new URL(source.url).protocol === `${scheme}:`) && (drm !== 'exclude' || !drmFor(channel, source)?.type);

export function filteredChannels(data, filters = {}) {
  const { q = '', group = '', drm = '', scheme = '' } = filters;
  return data.channels.filter(channel => (!group || channel.groupTitle === group) && (!q || String(channel.name ?? '').toLocaleLowerCase().includes(q.toLocaleLowerCase())))
    .map(channel => ({ ...channel, sources: sourcesFor(channel).filter(source => keepSource(channel, source, { drm, scheme })) }))
    .filter(channel => channel.sources.length);
}

export function catalog(data) {
  return filteredChannels(data).map(channel => ({
    id: String(channel.id ?? ''), name: clean(channel.name), group: clean(channel.groupTitle || 'General'),
    sourceCount: channel.sources.length,
    drmSourceCount: channel.sources.filter(source => drmFor(channel, source)?.type).length,
    cleartextSourceCount: channel.sources.filter(source => new URL(source.url).protocol === 'http:').length,
    formats: [...new Set(channel.sources.map(source => clean(source.manifestType || channel.manifestType || 'auto')))],
    clearFormats: [...new Set(channel.sources.filter(source => !drmFor(channel, source)?.type).map(source => clean(source.manifestType || channel.manifestType || 'auto')))],
    drm: [...new Set(channel.sources.map(source => clean(drmFor(channel, source)?.type)).filter(Boolean))],
  }));
}

/** Builds the header map that may be exported to a client. Credential-bearing names are dropped. */
export function safeHeaders(...inputs) {
  const headers = {};
  for (const input of inputs) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) continue;
    for (const [key, value] of Object.entries(input)) {
      if (!/^[a-zA-Z0-9-]+$/.test(key) || typeof value !== 'string' || sensitiveHeader(key)) continue;
      headers[key.toLowerCase()] = clean(value);
    }
  }
  return headers;
}

function headerComment(meta) {
  const parts = [`format=${PLAYLIST_FORMAT}`];
  for (const [key, value] of [['revision', meta.revision], ['updated-at', meta.updatedAt], ['state', meta.state], ['channels', meta.channels], ['streams', meta.streams]]) {
    if (value !== undefined && value !== null && value !== '') parts.push(`${key}=${clean(value)}`);
  }
  return `#COSMIC:${parts.join(' ')}`;
}

/**
 * Serialises channels as M3U.
 * @param {object} data validated payload
 * @param {{q?:string, group?:string, drm?:string, scheme?:string}} filters `scheme: 'https'` drops cleartext sources
 * @param {{revision?:string, updatedAt?:string, state?:string}|null} meta adds a `#COSMIC:` marker so consumers can detect revisions without HTTP headers
 */
export function toM3u(data, filters = {}, meta = null) {
  const lines = ['#EXTM3U'];
  if (meta) lines.push('');
  let channels = 0, streams = 0;
  for (const channel of filteredChannels(data, filters)) {
    channels++;
    for (const source of channel.sources) {
      const suffix = channel.sources.length > 1 && source.resolutionLabel ? ` [${clean(source.resolutionLabel)}]` : '';
      const cleartext = new URL(source.url).protocol === 'http:' ? ' x-cosmic-cleartext="1"' : '';
      lines.push(`#EXTINF:-1 tvg-id="${attr(channel.tvgId || channel.id)}" tvg-logo="${attr(validUrl(channel.logoUrl) ? channel.logoUrl : '')}" group-title="${attr(channel.groupTitle || 'General')}"${cleartext},${clean(channel.name)}${suffix}`);
      const headers = safeHeaders(channel.headers, source.headers);
      if (Object.keys(headers).length) {
        lines.push(`#EXTHTTP:${JSON.stringify(headers)}`);
        for (const [key, option] of [['user-agent', 'user-agent'], ['referer', 'referrer'], ['origin', 'origin']]) {
          if (headers[key]) lines.push(`#EXTVLCOPT:http-${option}=${headers[key]}`);
        }
      }
      const drm = drmFor(channel, source);
      const manifest = String(source.manifestType || channel.manifestType || '').toLowerCase();
      if (drm?.type || ['mpd', 'dash', 'hls', 'm3u8'].includes(manifest) || /\.(m3u8|mpd)(?:\?|$)/i.test(source.url)) {
        lines.push('#KODIPROP:inputstream=inputstream.adaptive');
        if (['mpd', 'dash'].includes(manifest)) lines.push('#KODIPROP:mimetype=application/dash+xml');
        const encoded = Object.entries(headers).map(([key, value]) => `${encodeURIComponent(key === 'referer' ? 'Referer' : key)}=${encodeURIComponent(value)}`).join('&');
        if (encoded) lines.push(`#KODIPROP:inputstream.adaptive.manifest_headers=${encoded}`, `#KODIPROP:inputstream.adaptive.stream_headers=${encoded}`);
        const type = { WIDEVINE: 'com.widevine.alpha', CLEARKEY: 'org.w3.clearkey', PLAYREADY: 'com.microsoft.playready' }[String(drm?.type).toUpperCase()];
        if (type) {
          lines.push(`#KODIPROP:inputstream.adaptive.license_type=${type}`);
          const license = drm.licenseUrl || drm.licenseKey || (drm.keyId && drm.key ? `${drm.keyId}:${drm.key}` : '');
          if (license) lines.push(`#KODIPROP:inputstream.adaptive.license_key=${clean(typeof license === 'object' ? JSON.stringify(license) : license)}`);
        }
      }
      lines.push(source.url);
      streams++;
    }
  }
  if (meta) lines[1] = headerComment({ ...meta, channels, streams });
  return lines.join('\n') + '\n';
}
