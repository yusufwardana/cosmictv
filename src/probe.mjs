import { safeRequest } from './network.mjs';

export function mediaKind(bytes) {
  if (bytes.length >= 188 * 3 && bytes[0] === 0x47 && bytes[188] === 0x47 && bytes[376] === 0x47) return 'ts';
  if (bytes.length > 12 && bytes.subarray(0, 256).includes(Buffer.from('ftyp'))) return 'init';
  if (bytes.includes(Buffer.from('moof')) && bytes.includes(Buffer.from('mdat'))) return 'fragment';
  if (bytes.length > 128 && bytes[0] === 0xff && (bytes[1] & 0xf6) === 0xf0) return 'aac';
  return null;
}

export async function probeStream(stream, request = safeRequest, options = {}) {
  const checkedAt = new Date().toISOString();
  const outcome = (state, reason) => ({ state, reason, checkedAt });
  if (stream.drmConfig?.type || stream.drmConfig?.licenseKey || stream.drmConfig?.licenseUrl) return outcome('drm', 'Memerlukan verifikasi DRM/lisensi pada pemutar.');
  try {
    const start = new URL(stream.url);
    const headersFor = url => { const headers = { ...stream.headers }; if (new URL(url).origin !== start.origin) { delete headers.authorization; delete headers.cookie; delete headers.Authorization; delete headers.Cookie; } return headers; };
    const read = async (url, media = false) => {
      const result = await request(url, { headers: headersFor(url), maxBytes: media ? 65536 : 524288, timeoutMs: 8000, truncate: true, allowedPorts: options.allowedPorts || [], ...(media ? { range: 'bytes=0-65535' } : {}) });
      if (![200, 206].includes(result.status)) throw new Error(`HTTP ${result.status}`);
      return result;
    };
    let response = await read(stream.url);
    for (let depth = 0; depth < 4; depth++) {
      const text = response.text.trimStart().replace(/^\uFEFF/, '');
      if (/^<\??(?:xml|MPD)|<MPD[\s>]/i.test(text)) return outcome('unsupported', 'DASH belum diverifikasi sampai segmen media.');
      if (!text.startsWith('#EXTM3U')) {
        const kind = mediaKind(response.body);
        if (['ts', 'aac', 'fragment'].includes(kind) || kind === 'init' && response.body.includes(Buffer.from('mdat'))) return outcome('working', 'Data media langsung terbaca.');
        return outcome('failed', 'Respons bukan manifest atau media yang dikenali.');
      }
      if (/#EXT-X-(?:SESSION-)?KEY:(?![^\r\n]*METHOD=NONE)[^\r\n]*METHOD=/i.test(text)) return outcome('drm', 'HLS terenkripsi; pemutaran belum diverifikasi.');
      const lines = text.split(/\r?\n/).map(line => line.trim());
      const variant = lines.findIndex(line => line.startsWith('#EXT-X-STREAM-INF:'));
      if (variant >= 0) {
        const uri = lines.slice(variant + 1).find(line => line && !line.startsWith('#'));
        if (!uri) return outcome('failed', 'Master playlist tidak memiliki varian.');
        response = await read(new URL(uri, response.url).href); continue;
      }
      if (!text.includes('#EXTINF:')) return outcome('failed', 'Playlist tidak memiliki segmen media.');
      if (text.includes('#EXT-X-BYTERANGE:')) return outcome('unsupported', 'HLS byte-range belum didukung pemeriksa.');
      const urls = lines.filter(line => line && !line.startsWith('#'));
      if (!urls.length) return outcome('failed', 'URL segmen media kosong.');
      const map = text.match(/#EXT-X-MAP:.*?URI="([^"]+)"/);
      if (map) {
        const init = await read(new URL(map[1], response.url).href, true);
        if (mediaKind(init.body) !== 'init') return outcome('failed', 'Init segmen MP4 tidak valid.');
      }
      const segment = await read(new URL(urls.at(-1), response.url).href, true);
      const kind = mediaKind(segment.body);
      if (['ts', 'aac'].includes(kind) || map && kind === 'fragment') return outcome('working', 'Manifest dan potongan media terbaca.');
      return outcome('failed', 'Segmen bukan data media yang dikenali.');
    }
    return outcome('failed', 'Rantai manifest terlalu panjang.');
  } catch (error) {
    const reason = /HTTP \d{3}/.exec(error.message)?.[0] || (/privat|lokal|reserved|IPv6/.test(error.message) ? 'Target jaringan tidak diizinkan.' : 'Timeout/koneksi gagal saat memeriksa media.');
    return outcome('failed', reason);
  }
}
