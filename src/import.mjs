import { validatePayload, validUrl } from './playlist.mjs';
import { cleanHeaders } from './network.mjs';

function attributes(text) {
  return Object.fromEntries([...text.matchAll(/([\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)].map(match => [match[1].toLowerCase(), match[2] ?? match[3]]));
}

export function parseSource(text, base = '') {
  if (text.length > 4 * 1024 * 1024) throw new Error('Daftar sumber terlalu besar (maksimum 4 MiB).');
  if (text.trimStart().startsWith('{')) return validatePayload(JSON.parse(text));
  if (!text.includes('#EXTM3U') || /#EXT-X-(TARGETDURATION|STREAM-INF|MEDIA-SEQUENCE)/.test(text)) throw new Error('Masukkan daftar channel M3U/JSON, bukan manifest satu video.');
  const channels = []; let entry;
  for (let line of text.slice(text.indexOf('#EXTM3U')).split(/\r?\n/)) {
    line = line.trim();
    if (line.startsWith('#EXTINF:')) {
      const metadata = attributes(line);
      const comma = line.match(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/);
      entry = { id: metadata['tvg-id'] || '', tvgId: metadata['tvg-id'] || '', name: comma ? line.slice(comma.index + 1).trim() : 'Channel', groupTitle: metadata['group-title'] || 'General', logoUrl: metadata['tvg-logo'] || '', headers: {}, drmConfig: null, manifestType: '' };
    } else if (entry && line.startsWith('#EXTGRP:')) entry.groupTitle = line.slice(8);
    else if (entry && line.startsWith('#EXTHTTP:')) { try { Object.assign(entry.headers, cleanHeaders(JSON.parse(line.slice(9)))); } catch {} }
    else if (entry && line.startsWith('#EXTVLCOPT:')) {
      const [key, ...value] = line.slice(11).split('=');
      const name = { 'http-user-agent': 'user-agent', 'http-referrer': 'referer', 'http-referer': 'referer', 'http-origin': 'origin' }[key.toLowerCase()];
      if (name) entry.headers[name] = value.join('=');
    } else if (entry && line.startsWith('#KODIPROP:')) {
      const [key, ...parts] = line.slice(10).split('='); const value = parts.join('=');
      if (key.endsWith('license_type')) entry.drmConfig = { ...entry.drmConfig, type: /widevine/i.test(value) ? 'WIDEVINE' : /clearkey/i.test(value) ? 'CLEARKEY' : 'OTHER' };
      if (key.endsWith('license_key')) entry.drmConfig = { ...entry.drmConfig, licenseKey: value, ...( /^https?:/.test(value) ? { licenseUrl: value } : {} ) };
      if (key.endsWith('manifest_type')) entry.manifestType = value;
      if (/(manifest_headers|stream_headers|common_headers)$/.test(key)) for (const [name, val] of new URLSearchParams(value)) entry.headers[name.toLowerCase()] = val;
    } else if (entry && line && !line.startsWith('#') && !/[<>]/.test(line)) {
      const [rawUrl, extra] = line.split('|', 2);
      let url; try { url = new URL(rawUrl, base || undefined).href; } catch { continue; }
      if (!validUrl(url)) continue;
      if (extra) for (const [name, value] of new URLSearchParams(extra)) entry.headers[name.toLowerCase()] = value;
      const { headers, drmConfig, manifestType, ...channel } = entry;
      channels.push({ ...channel, sources: [{ url, headers: cleanHeaders(headers), drmConfig, manifestType: manifestType || (/\.mpd(?:\?|$)/i.test(url) ? 'mpd' : /\.m3u8(?:\?|$)/i.test(url) ? 'hls' : 'auto') }] });
      entry = null;
    }
  }
  return validatePayload({ success: true, channels });
}
