# Multi-source COSMIC playlist

User approved implementation of multiple dashboard sources, combined into one API with checked URLs. Scope: D:/Tools/DopamineTV/web only. Preserve current signed upstream adapter, add generic M3U/JSON URLs and uploaded M3U, persistent source settings and check results. Do not automatically add extracted third-party lists without the operator choosing them in the dashboard.

Files: src/network.mjs (public-address-only bounded requests, pinned DNS, per-redirect validation); src/import.mjs (M3U normalization and source/header/DRM preservation); src/probe.mjs (manifest + bounded media check); src/aggregate.mjs (sources, persistence, deduplication, scan queue and strict output); src/http.mjs and server.mjs (integration); public/* (source management and check status); test/aggregate.test.mjs; README.md, package.json and .env.example.

- [x] Add and run failing tests for M3U metadata, SSRF rejection, HLS child/segment checks, HTML rejection, encryption, HTTP failures, merging, freshness and source persistence.
- [x] Implement import/network/probe and test against deterministic synthetic transport. Check public targets on every redirect and pin resolved IPs. Do not fetch DRM licenses or decrypt streams.
- [x] Implement multi-source service with single-flight refresh, concurrency 4, one check per host at a time, per-host 429 cooldown, timeouts and bounded response size. Persist source configuration separately from snapshots; update atomically. Deduplicate by channel identity and exact stream/header/DRM identity.
- [x] Protect all source mutations/reads with admin bearer token; accept bounded JSON bodies. Reject arbitrary local files/private network sources. Admin source URL input is data, never code. Trigger scans asynchronously and report progress.
- [x] Keep /playlist.m3u and /api/v1/channels as the combined verified output. Catalog shows failed, DRM and unchecked sources separately. Recompute export freshness at request time; checks expire after 30 minutes by default. No permanent guarantee of future playback or device-specific availability.
- [x] Add dashboard source forms (URL/file), enable/disable/remove controls, counts and health filters, status timestamps and errors. Credentials remain in memory for the management tab, not localStorage or URLs.
- [x] Run complete tests and syntax checks, inspect real import/refresh/check state, restart service, and verify dashboard interactions and LAN endpoints. Document operational limitations and measured results.

Verification definition: unencrypted HLS requires valid playlist followed by recognizable TS/fMP4/AAC bytes from a referenced media segment (and init segment when needed); direct media needs recognizable bytes. DASH/DRM and unsupported protocols remain unverified and are excluded. HTTP 200, a successful HEAD request or a manifest alone is insufficient. Media validation is a bounded transport/container check, not a full decoder or guarantee of continued playback. Source refresh failure retains candidates; previously verified output ages out unless rechecked. No endpoint exports unchecked cached data.

## Hasil verifikasi — 7 November 2026 (Asia/Jakarta)

VERIFIED untuk fungsi multi-source dan ekspor tersaring dalam lingkup yang dijelaskan. `npm test`: 31 lulus, 0 gagal. `npm run check`: exit 0. Pemeriksaan langsung sumber awal: 281 kandidat stream / 195 channel setelah penggabungan; 40 lolos, 12 gagal, 215 memerlukan DRM, 14 belum didukung. Playlist dan JSON mengekspor 40 stream dengan verification.state=working; tidak ada properti lisensi DRM dalam M3U keluaran.

Browser: login admin (token tidak dicetak), unggah satu channel yang memakai URL existing, sumber kedua tampil, nonaktifkan berhasil, hapus sumber uji berhasil, dan filter Media terbaca menampilkan 40 dari 195 channel. Fixture uji dihapus setelah selesai. Pengaturan kembali berisi satu sumber bawaan; operator dapat menambahkan sumber lain melalui dashboard. Screenshot: docs/multi-source-dashboard.png.

Hak baca/tulis .env dan folder data dipersempit ke akun service saat ini, SYSTEM dan Administrators. ACL sumber.json dikonfirmasi tidak lagi memuat Users/Authenticated Users. Kredensial tidak dicantumkan dalam laporan. Startup/cache dimuat kembali setelah restart launcher. Server tetap aktif pada port 8787, dengan timer pembaruan otomatis.

Batas: pemeriksaan container/transport terbatas, bukan decode penuh. Tidak menjamin codec, geo/session atau pemutaran setiap perangkat. Belum mendukung pembuktian playback DRM/DASH/byte-range; kategori itu dikeluarkan. HTTP LAN untuk administrasi masih memerlukan jaringan tepercaya atau penggunaan localhost; TLS belum dipasang. Sumber tambahan tidak dipilih otomatis. Public API output/katalog tetap dapat dibaca oleh perangkat yang menjangkau port. Tidak melakukan load test atau deployment Docker/public domain.
