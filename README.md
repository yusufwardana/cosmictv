# COSMIC TV Playlist API

Web dan API mandiri untuk menggabungkan beberapa daftar channel. Node.js 22+; tidak memerlukan npm install atau database.

## Mengelola beberapa sumber

1. Buka dashboard, pilih **Kelola sumber +**, masukkan `ADMIN_TOKEN` dari `.env`, lalu **Buka pengelolaan**. Token berada di memori tab saja; tombol **Kunci pengelolaan** menghapusnya.
2. Isi nama dan satu URL daftar channel M3U/JSON, atau unggah berkas M3U/JSON (maksimum 2 MiB). Header opsional diisi sebagai objek JSON, misalnya `{"User-Agent":"Player"}`. URL manifest satu video tidak dianggap daftar channel.
3. Pilih **Tambah & periksa**. Impor dan pemeriksaan berlangsung di belakang layar; dashboard menampilkan progres. Sumber dapat diaktifkan, dinonaktifkan dan dihapus. Sumber bawaan dapat dinonaktifkan.
4. Gunakan satu URL `/playlist.m3u` untuk output gabungan. Channel digabung berdasarkan tvg-id bila tersedia, atau nama + kategori; duplikat URL dengan header/DRM yang berbeda tetap diperlakukan sebagai alternatif terpisah.

Hanya stream **Media terbaca** dengan hasil yang belum kedaluwarsa masuk output M3U maupun JSON. Katalog dashboard tetap menampilkan kandidat gagal/belum diperiksa/DRM agar dapat ditinjau. Filter status dashboard hanya memfilter tampilan; output selalu berisi hasil lolos. Pencarian dan kategori juga diterapkan pada URL output.

Pemeriksaan HLS menelusuri master/varian sampai media playlist, kemudian membaca maksimum 64 KiB dari satu segmen dan init segment bila dibutuhkan. Data harus memiliki tanda container TS/fMP4/AAC yang dikenali. HTML 200, HEAD sukses atau manifest saja tidak cukup. Stream DRM/enkripsi, DASH yang belum didukung, serta HLS byte-range belum bisa dipastikan dan dikeluarkan. Ini bukan decoder penuh dan tidak menjamin codec, audio, gambar, geo/session, akses dari HP pengguna, atau ketersediaan di masa mendatang. Referensi format: [RFC 8216](https://www.rfc-editor.org/rfc/rfc8216).

Default `VERIFICATION_SECONDS=1800` (30 menit). Hasil kedaluwarsa tidak diekspor meskipun snapshot masih ada. Pembaruan tiap 15 menit setelah proses selesai; proses maksimal sekitar 5 menit ditambah penyelesaian request aktif. Kandidat yang belum sempat dicek diprioritaskan pada putaran selanjutnya. Maksimum 4 stream sekaligus dan 1 stream per host; respons 429 menghormati Retry-After dalam batas 1 menit–24 jam (default 15 menit). Impor/hasil terbaru dapat dipakai ulang selama 5 menit untuk menghindari request berulang saat mengelola sumber.

Maksimum 20 feed dan 3.000 kandidat stream. Sumber URL, redirect dan URL segmen harus memakai HTTP(S) ke alamat IPv4 publik. DNS diikat ke alamat yang sudah diperiksa; alamat LAN/loopback/link-local/reserved dan IPv6 diblokir. Gunakan unggahan untuk daftar lokal, bukan memasukkan path filesystem. Header autentikasi/cookie tidak diteruskan saat berganti origin. Kredensial dan konfigurasi sumber ada di `data/sources.json`; snapshot kandidat dan hasil pemeriksaan ada di `data/aggregate.json`. Lindungi kedua berkas beserta `.env`.

## Jalankan di Windows

Konfigurasi lokal `.env` sudah diisi dari format aplikasi yang dikonfirmasi pada APK v1.0.8. Untuk instalasi lain, salin `.env.example` menjadi `.env` dan isikan `UPSTREAM_SECRET`, `DEVICE_ID` (ID acak yang stabil) dan `ADMIN_TOKEN` (minimal 24 karakter). Pertahankan tanda kutip pada `UPSTREAM_SECRET` karena `#` tanpa kutip dianggap komentar oleh parser `.env`. Rahasia sumber tidak dikirim ke browser. Jangan membagikan `.env`.

```powershell
cd D:\Tools\
.\start.ps1
# Hentikan:
.\stop.ps1
# Jalankan di terminal:
npm start
```

Dashboard: **http://127.0.0.1:8787/** (juga bisa dibuka dari LAN lewat IP komputer, default `ADMIN_WEB_PANEL=true`). Aksi pengelolaan (simpan sumber, ubah pilihan, simpan endpoint, perbarui) memerlukan `ADMIN_TOKEN`; tanpa token panel hanya menampilkan data publik. Listener admin terpisah tetap ada di http://127.0.0.1:8788 untuk akses lewat tunnel.

Konfigurasi mesin ini memakai `HOST=0.0.0.0`. IP LAN saat pemasangan: `10.10.12.50`. Panel dan playlist: http://10.10.12.50:8787/ dan http://10.10.12.50:8787/playlist.m3u (playlist butuh token karena `READ_TOKENS` diisi). IP dapat berubah mengikuti DHCP. Bila firewall memblokir, jalankan `enable-lan.ps1` melalui PowerShell sebagai Administrator; skrip hanya membuka TCP 8787 untuk `LocalSubnet`.

Alamat yang dipakai APK/pemutar diatur dari panel: **Kelola sumber → Endpoint server**, disimpan di `data/settings.json` dan langsung dipakai tautan playlist. Nilai ini harus https untuk host publik; http hanya diterima untuk localhost/LAN.

M3U: http://127.0.0.1:8787/playlist.m3u

JSON: http://127.0.0.1:8787/api/v1/channels

Pembaruan saat startup dan 15 menit setelah pembaruan sebelumnya selesai, selama proses server hidup. Ubah `REFRESH_SECONDS` (minimal 60), lalu restart. Cache adaptor awal berada di `data/snapshot.json`; cache gabungan dan pengaturan feed berada di berkas terpisah di atas. Jika belum ada kandidat, endpoint playlist merespons 503. Jika ada kandidat tetapi tidak ada yang lolos, playlist valid berisi nol entri. Pemeriksa membaca potongan media secara terbatas, bukan mengunduh keseluruhan video.

## Endpoint

| Metode | Path | Listener | Hasil |
|---|---|---|---|
| GET / HEAD | `/playlist.m3u` | publik | Gabungan stream yang lolos pemeriksaan; header `#COSMIC:` + `ETag` + `If-None-Match` |
| GET / HEAD | `/api/v1/playlist.m3u` | publik | Alias M3U |
| GET / HEAD | `/api/v1/channels` | publik | JSON gabungan stream yang lolos, termasuk waktu pemeriksaan |
| GET / HEAD | `/api/v1/catalog` | publik | Semua kandidat, jumlah lolos, status dan alasan |
| GET / HEAD | `/api/v1/status` | publik | Jumlah channel, waktu, error terakhir, backoff dan kondisi cache |
| POST | `/api/v1/refresh` | admin | Antrekan pembaruan/pemeriksaan, HTTP 202; token admin, jeda 30 detik |
| GET / POST | `/api/v1/sources` | admin | Daftar/tambah sumber; token admin wajib |
| PATCH / DELETE | `/api/v1/sources/:id` | admin | Aktif/nonaktif (`{"enabled":false}`) atau hapus; token admin wajib |
| GET / PUT | `/api/v1/selection` | admin | Baca/simpan pilihan channel; token admin wajib |
| GET / PUT | `/api/v1/settings` | admin | Baca/simpan `publicOrigin` (endpoint server untuk APK/pemutar) |
| GET | `/runtime.js` | keduanya | Origin publik + status token untuk dashboard |

Filter M3U: `?group=Sports`, `?q=news`, `?drm=exclude`, `?scheme=https` (buang URL `http://`); bisa digabung. Nilai kategori mengikuti katalog dan harus di-URL-encode.

**Token baca.** Bila `READ_TOKENS` diisi (satu atau beberapa, pisahkan koma), semua endpoint baca pada listener publik wajib token: `Authorization: Bearer <token>`, atau `?token=<token>` khusus `playlist.m3u` untuk pemutar yang tidak bisa mengatur header. Tanpa token → `401` + `WWW-Authenticate`. Endpoint status tetap terbuka agar pemantauan sederhana tidak butuh rahasia. Token admin juga diterima untuk membaca (dipakai panel setelah login), sebaliknya token baca tidak pernah berlaku untuk mutasi.

**Listener terpisah.** `PORT` (default 8787) melayani panel, playlist, katalog, channel, status, `runtime.js`, dan endpoint mutasi — semua mutasi tetap butuh `ADMIN_TOKEN`. `ADMIN_PORT` (default 8788, `ADMIN_HOST=127.0.0.1`) menyediakan jalur khusus lewat tunnel/HTTPS tanpa membuka panel di LAN. Set `ADMIN_WEB_PANEL=false` bila panel tidak boleh ada di listener publik.

Perubahan data mendukung ETag / If-None-Match dan memakai `Cache-Control: private, max-age=0, must-revalidate`. Status gabungan memakai `ready`, `stale`, `checking` dan `empty`. `AUTH_FAIL_LIMIT` dan `RATE_LIMIT` membatasi percobaan token salah dan permintaan per IP per menit (429 + `Retry-After`).

**Kontrak playlist untuk project pemutar.** Baris kedua berkas berisi `#COSMIC:format=1 revision=<hash> updated-at=<iso> state=<state> channels=<n> streams=<n>` sehingga klien dapat mendeteksi revisi tanpa header HTTP. Entri berskema `http://` ditandai `x-cosmic-cleartext="1"`. Header berisi kredensial (`authorization`, `cookie`, token, secret) **tidak pernah** diekspor. Perlakukan berkas playlist sebagai tautan rahasia dan ambil ulang setiap ≤15 menit.

Playlist dapat menyertakan lebih dari satu sumber lolos per channel. Import mempertahankan konfigurasi header/DRM, tetapi hasil DRM tidak dimasukkan ke output ketat karena lisensinya belum diverifikasi. Header manifest/stream mengikuti [panduan integrasi InputStream Adaptive](https://github.com/xbmc/inputstream.adaptive/wiki/Integration). Dukungan tetap berbeda per pemutar.

## VPS / domain sendiri

Panduan lengkap ada di [`deploy/README.md`](deploy/README.md); contoh reverse proxy dengan TLS dan pemisahan admin di [`deploy/Caddyfile`](deploy/Caddyfile).

Ringkas:

```sh
# di VPS, setelah Docker + Caddy terpasang dan DNS diarahkan
rsync -av --exclude .env --exclude data --exclude logs ./ user@VPS:/srv/cosmic-tv/
scp .env user@VPS:/srv/cosmic-tv/.env     # lalu chmod 600
cd /srv/cosmic-tv && docker compose up -d --build
cp deploy/Caddyfile /etc/caddy/Caddyfile  # ganti domain + remote_ip, lalu reload
```

Kontainer mem-bind `127.0.0.1:8787` (publik) dan `127.0.0.1:8788` (admin). Caddy meneruskan domain HTTPS ke 8787 dan hanya mengizinkan jalur admin dari jaringan tepercaya. Volume `playlist-data` menyimpan snapshot; kontainer restart otomatis setelah reboot jika Docker aktif.

Dashboard dibuka lewat tunnel, bukan dibuka ke internet:

```sh
ssh -L 8788:127.0.0.1:8788 user@VPS   # lalu buka http://127.0.0.1:8788
```

Sebelum dipakai APK/pemutar, verifikasi: `https://domain/api/v1/status` 200, `/playlist.m3u` tanpa token 401, dengan token 200, dan `/` dari internet 403. Endpoint sumber atau autentikasinya dapat berubah dan menghasilkan cache berstatus stale.

## Pemeriksaan

```sh
npm test
npm run check
```

Tes menggunakan URL dan rahasia sintetis: konversi, filter, injeksi baris, signature, cache saat restart/gagal, single-flight, validasi, pembaruan berizin, HTTP ETag, token baca, pemisahan listener, redaksi header sensitif, marker revisi, filter skema, Retry-After/backoff, kebijakan port, rate limit, dan cakupan pemeriksaan. Log server ada di `logs/` bila memakai launcher Windows; tidak mencatat token atau isi stream.

## Keamanan

Kontrol yang berlaku:

- **Dua listener.** Publik (`PORT`) tanpa rute admin; admin (`ADMIN_PORT`, loopback) dengan dashboard dan mutasi. Permintaan admin ke listener publik dijawab 404.
- **Token baca opsional** (`READ_TOKENS`) dengan pencabutan per token tanpa mengubah token admin. Perbandingan constant-time.
- **Rate limit** per IP (`RATE_LIMIT`, `AUTH_FAIL_LIMIT`), 429 + `Retry-After`.
- **Header sensitif tidak diekspor** ke playlist (`authorization`, `cookie`, token, secret, signature).
- **Egress terkendali.** Pemeriksaan hanya untuk channel terpilih (`PROBE_SELECTED_ONLY`, default `true`), port non-HTTP diblokir, alamat privat/reserved ditolak, DNS diikat ke alamat hasil pemeriksaan, redirect lintas origin membuang header kredensial.
- **Backoff.** 429/403 dihormati lewat `Retry-After`, kegagalan berulang memperpanjang jeda hingga 6 jam; status menampilkan `lastStatus`, `lastErrorKind`, `failures`, `retryAt`.
- **Rahasia di disk.** `start.ps1` membatasi ACL `.env`, `data/`, dan `logs/` ke akun Anda + SYSTEM + Administrators. `mode 0o600` tidak berlaku di NTFS, jadi ACL adalah kontrol nyata.
- **Docker.** Non-root, `read_only`, `cap_drop: ALL`, `no-new-privileges`, `pids_limit`, `mem_limit`, port hanya loopback.

Batas yang masih ada: TLS tidak ditangani aplikasi ini (wajib reverse proxy); `data/` menyimpan materi sesi dan lisensi pihak ketiga dalam teks biasa, sehingga backup harus diperlakukan sebagai rahasia; URL `http://` masih dapat diekspor (ditandai `x-cosmic-cleartext="1"`) sampai sumbernya diganti.

## Playlist final manual

- Flow: fetch all enabled sources, persist imported channel/URL data in `data/aggregate.json`, curate channels, then publish the selected working URLs at `/playlist.m3u`.
- Selection is persisted in `data/selection.json` and managed through admin-only `GET` / `PUT /api/v1/selection` with `{ "channelIds": ["<catalog-id>"] }`.
- One-time migration preserves the previous default feed's channel selection; channels coming only from newly added sources stay unselected until the operator chooses them. Selecting a channel includes every currently working alternative URL for that channel.
- The public catalog marks `selected`; the output JSON and M3U contain selected channels only, and still exclude failed, stale, unsupported, and DRM streams.
