# COSMIC TV / DopamineTV — audit kode backend dan konfigurasi

Tanggal: 7 November 2026, Asia/Jakarta (pukul 07:37–07:55 WIB).
Status: audit statis + pengujian HTTP lokal terhadap layanan yang **sedang berjalan** (PID 552, `0.0.0.0:8787`).
Bukan audit APK, bukan uji penetrasi jaringan, bukan uji beban skala besar.

Dokumen ini melengkapi `security-audit-2026-11-07.md` (fokus APK dan risiko ban sumber). Di sini fokusnya kode `server.mjs`, `src/*.mjs`, `public/*`, konfigurasi `.env`/Docker/PowerShell, dan data yang tersimpan.

## Ringkasan

Tidak ditemukan celah eksekusi kode, path traversal, atau bypass autentikasi. Batas autentikasi untuk seluruh endpoint mutasi diuji dan menolak permintaan tanpa token (401). Kontrol positif yang paling penting sudah ada: perbandingan token constant-time, allowlist berkas statis, guard SSRF dengan DNS yang diikat, penulisan atomik, dan nol dependensi npm.

Masalah yang tersisa bersifat **paparan**: layanan berjalan di `0.0.0.0` lewat HTTP polos, katalog serta playlist dapat dibaca tanpa token, dan `data/` menyimpan materi sesi/lisensi pihak ketiga dalam teks biasa. Temuan ACL `.env` pada audit sebelumnya **sudah diperbaiki** dan diverifikasi ulang di sini.

| ID | Tingkat | Temuan | Status |
|---|---|---|---|
| B1 | Tinggi (kondisional) | Token admin dikirim lewat HTTP polos di LAN | Terbuka (A3 lama) |
| B2 | Sedang–Tinggi | Katalog, `/api/v1/channels`, dan `/playlist.m3u` publik tanpa autentikasi | Terbuka (A4 lama, cakupan bertambah) |
| B3 | Sedang | Materi sesi & lisensi pihak ketiga tersimpan teks biasa di `data/` | Terbuka |
| B4 | Sedang | Pemeriksaan egress ke ±1.366 URL pihak ketiga tiap 15 menit | Terbuka |
| B5 | Sedang | Feed utama tanpa Retry-After/backoff; ban vs auth gagal tidak dibedakan | Sebagian (A5 lama) |
| B6 | Rendah–Sedang | 3 URL siaran HTTP polos ikut terekspor ke playlist | Sebagian (A6 lama) |
| B7 | Rendah | Tidak ada pembatasan laju pada endpoint baca dan pada 401 | Terbuka |
| B8 | Rendah | `Cache-Control: public` pada respons yang bergantung pada pilihan admin | Terbuka |
| B9 | Rendah | Guard SSRF tidak membatasi port tujuan | Terbuka |
| B10 | Rendah | Header permintaan provider diekspor ke setiap klien playlist | Desain, perlu dijaga |
| B11 | Rendah | Kegagalan tak terduga dipetakan ke HTTP 400 | Terbuka |
| A2 | — | ACL `.env` terlalu luas | **Diperbaiki, terverifikasi** |
| A1 | Tinggi (produk) | Ketergantungan pada autentikasi aplikasi pihak sumber | Terbuka, tidak berubah |
| C1 | Tinggi (bila APK dibagikan) | Tidak ada identitas pengguna/perangkat; satu `ADMIN_TOKEN` untuk semua | Terbuka — lihat bagian konteks APK |
| C2 | Tinggi (bila APK dipakai di luar LAN) | Tidak ada TLS dan tidak ada alamat publik; Android 9+ menolak cleartext | Terbuka |
| C3 | Sedang | Skala & pembatasan laju untuk banyak klien APK belum ada | Terbuka |
| C4 | Sedang | URL stream pihak ketiga dikirim mentah ke setiap perangkat | Terbuka (desain) |

## Konteks distribusi APK COSMIC TV

Layanan ini adalah dashboard **dan** backend yang akan dipakai APK COSMIC TV. Konsekuensinya, penilaian di atas bergeser: yang tadinya "paparan LAN" menjadi "paparan ke setiap perangkat pengguna".

### C1 — Tinggi bila APK dibagikan ke pengguna lain: tidak ada identitas per pengguna

- Bukti: `src/http.mjs` hanya mengenal satu `adminToken`; tidak ada tabel pengguna, token perangkat, sesi, kuota, atau pencabutan akses. Semua endpoint baca (`/playlist.m3u`, `/api/v1/channels`, `/api/v1/catalog`, `/api/v1/status`) tidak memerlukan kredensial apa pun.
- Kondisi dampak: APK yang dibagikan membawa URL backend; siapa pun yang mengekstrak URL itu (mudah — cukup buka APK atau sniff) memakai katalog dan bandwidth Anda tanpa batas, dan tidak ada cara mencabut akses satu perangkat. Bila APK hanya untuk pemakaian pribadi, ini dapat diterima; bila untuk pelanggan, ini blocker.
- Rekomendasi: tentukan model distribusi lebih dulu. Pribadi → cukup token statis per perangkat yang bisa dicabut. Pelanggan → akun, token akses berumur pendek (mis. 15–60 menit) + refresh, pencabutan per perangkat, dan pencatatan pemakaian.
- Verifikasi perbaikan: perangkat yang tokennya dicabut menerima 401 pada permintaan berikutnya tanpa mengubah perangkat lain.

### C2 — Tinggi bila APK dipakai di luar LAN: tidak ada TLS, tidak ada alamat publik

- Bukti: `HOST=0.0.0.0`, `src/http.mjs:1` memakai `node:http`, README mendokumentasikan `http://10.10.12.50:8787`. Tidak ada domain, sertifikat, atau reverse proxy yang berjalan (hanya contoh Caddy di README:69).
- Kondisi dampak: APK Android dengan `targetSdk ≥ 28` memblokir cleartext secara default, sehingga endpoint ini tidak dapat dipakai tanpa HTTPS. Alamat `10.10.12.50` adalah IP privat dan tidak dapat dijangkau dari jaringan seluler pengguna. Mengaktifkan `usesCleartextTraffic` sebagai jalan pintas akan mengirim `ADMIN_TOKEN` dan URL stream tanpa enkripsi.
- Rekomendasi: selesaikan TLS sebelum APK diuji di perangkat nyata: domain + reverse proxy (Caddy/Nginx) atau tunnel, `Strict-Transport-Security`, dan URL backend di APK memakai `https://`. Jangan pernah menambahkan pengecualian cleartext untuk produksi.
- Verifikasi perbaikan: `curl http://<domain>` menolak/redirect ke HTTPS; APK berjalan dengan konfigurasi network security default (tanpa pengecualian).

### C3 — Sedang: beban dari banyak klien dan tidak ada pembatasan laju

- Bukti: `public/app.js:171` melakukan polling status setiap 5 detik. Tidak ada limiter di `src/http.mjs`. Setiap permintaan `/playlist.m3u` membangun ulang seluruh M3U dan menghitung ETag (7 ms pada 45 stream, 17 ms untuk katalog 1.126 channel). Server satu proses, data di memori.
- Kondisi dampak: 50 perangkat dengan pola polling serupa menghasilkan ±10 permintaan/detik; masih sanggup untuk satu proses, tetapi tanpa batas atas satu klien dapat memonopoli CPU. ETag/304 sudah membantu bila APK memakainya.
- Rekomendasi: APK sebaiknya memakai interval lebih panjang (30–60 detik) atau `If-None-Match`; tambahkan limiter per token/IP dan `Retry-After`. Bila pengguna banyak, pindahkan `/playlist.m3u` ke cache yang dihitung sekali per revisi.

### C4 — Sedang: URL stream pihak ketiga dikirim mentah ke setiap perangkat

- Bukti: `src/playlist.m3u` dan `/api/v1/channels` mengirim URL sumber apa adanya, termasuk parameter sesi (`?id=…`, `wsSecret`, `usersessionid`, `AuthInfo` — 5 URL berparameter di playlist saat ini). `data/` menyimpan 943 `licenseKey` dan ratusan `licenseUrl`.
- Kondisi dampak: (a) setiap perangkat konek langsung ke CDN provider dengan IP-nya sendiri — ini menyebarkan risiko ban, tetapi juga berarti satu URL sesi dipakai banyak IP sekaligus, yang mudah terdeteksi dan dicabut provider; (b) bila kelak ada sumber ber-DRM yang lolos pemeriksaan, `license_key` akan tercetak di playlist yang dapat diunduh siapa pun, dan kunci ClearKey di APK dapat diekstrak. Saat ini DRM selalu difilter (`src/probe.mjs:14`), jadi belum terjadi.
- Rekomendasi: pertahankan filter DRM sebagai invariant yang diuji; jangan pernah mengekspor `license_key` ke playlist publik; bila APK butuh DRM, sediakan endpoint lisensi per sesi, bukan kunci statis di klien.
- Verifikasi perbaikan: uji regresi memastikan playlist publik tidak pernah memuat `license_key`/`Authorization`/`Cookie`.

### Batas lingkup: keluaran berupa playlist untuk project terpisah

Aplikasi ini adalah **produsen playlist**; pemutar/APK adalah project terpisah yang mengonsumsi berkas hasilnya. Dengan batas itu:

- C1 (identitas pengguna) dan C3 (pola polling dari banyak perangkat) bukan tanggung jawab kode ini, kecuali URL playlist memang akan dibagikan publik. Yang tetap menjadi tanggung jawab produsen: siapa yang boleh mengambil berkas, dan berapa banyak beban yang ditimbulkannya.
- Yang menjadi "API" sesungguhnya adalah **format dan kesegaran berkas**, bukan skema JSON. Perubahan format adalah breaking change.
- Berkas playlist adalah **dokumen pembawa akses** (bearer): siapa pun yang memilikinya dapat memutar isinya. Perlakukan seperti tautan rahasia.

Kontrak yang sudah tersedia dan sebaiknya dipertahankan:

| Elemen | Perilaku sekarang | Nilai untuk konsumen |
|---|---|---|
| `GET /playlist.m3u` | 200 `audio/x-mpegurl` | sumber tunggal |
| `ETag` + `If-None-Match` | 304 bila tidak berubah | hemat kuota, deteksi perubahan |
| `X-Playlist-Updated-At`, `X-Playlist-State` | timestamp + `ready`/`stale`/`empty`/`checking` | tahu kapan harus curiga |
| 503 saat belum siap + `Retry-After: 30` | sudah ada | konsumen wajib mencoba ulang, bukan menganggap kosong |
| `#EXTHTTP` / `#EXTVLCOPT` / `#KODIPROP` | UA, Referer, Origin, tipe inputstream | konsumen wajib meneruskan header ini |
| Isi hanya stream berstatus `working` | DRM/DASH/failed tidak diekspor | konsumen tidak perlu memfilter sendiri |
| `state: stale` | sumber gagal sebagian, cache lama disajikan | konsumen tetap boleh memutar, dengan peringatan |

Risiko khusus produsen playlist:

1. **Kedaluwarsaan.** Pada snapshot saat audit, 2 URL memakai `wsSecret`+`wsABSTime` (token gaya Akamai) yang sudah lewat **111–164 hari**; keduanya gagal diperiksa sehingga tidak ikut ekspor. Artinya filter kesehatan bekerja, tetapi juga berarti URL impor memang cepat busuk. Jangan pernah menyimpan berkas playlist lebih lama dari satu siklus sinkronisasi.
2. **Format polos.** `http://` masih ikut terekspor (3 URL di playlist final, 10 di snapshot). Konsumen tidak punya cara membedakannya kecuali memeriksa skema URL.
3. **Tidak ada penanda revisi di dalam berkas.** Konsumen yang menyimpan berkas tanpa menyimpan header HTTP kehilangan cara mendeteksi perubahan. Tambahkan baris komentar, mis. `#EXTM3U x-cosmic-revision=<revision>`, agar deteksi perubahan tidak bergantung pada header.
4. **Tidak ada versi format.** Bila `#KODIPROP` berubah (mis. dukungan DASH), konsumen lama bisa salah tafsir. Sertakan `x-cosmic-format=1` pada baris yang sama.

Rekomendasi untuk konsumen (di luar repo ini): perlakukan berkas sebagai snapshot berumur pendek — ambil ulang tiap ≤15 menit atau saat `ETag`/revision berubah, simpan `X-Playlist-Updated-At` untuk diagnosis, dan jangan menyalin URL stream ke penyimpanan permanen.

## Temuan

### B1 — Tinggi bila LAN tidak dipercaya: token admin melewati HTTP polos

- Bukti: `.env` memuat `HOST=0.0.0.0`; `netstat` menunjukkan `0.0.0.0:8787 LISTENING` (PID 552); `logs/lan-setup.json` mencatat `TCP 8787 dibuka untuk LocalSubnet`; `public/app.js:9` mengirim header `Authorization`; README:35 mendokumentasikan `http://10.10.12.50:8787`.
- Kondisi dampak: siapa pun yang dapat memantau trafik LAN (ARP spoofing, Wi-Fi bersama, switch yang dimonitor) dapat memperoleh `ADMIN_TOKEN` saat admin membuka pengelolaan, lalu mengubah sumber dan pilihan playlist. Token tidak disimpan di browser, tetapi transitnya tidak terlindungi.
- Rekomendasi: layani dashboard admin lewat HTTPS (reverse proxy Caddy/Nginx yang sudah dicontohkan README) atau ikat administrasi ke loopback (`HOST=127.0.0.1` + akses lewat SSH/terowongan). Pertimbangkan port admin terpisah yang hanya listen di 127.0.0.1, sementara port playlist tetap di LAN.
- Verifikasi perbaikan: dari host lain di LAN, `curl http://<ip>:8787/api/v1/status` gagal untuk endpoint admin, dan token tidak pernah melintas di antarmuka yang tidak terenkripsi.

### B2 — Sedang–Tinggi: permukaan baca terbuka tanpa autentikasi

- Bukti (diuji langsung, tanpa token):

  | Permintaan | Hasil |
  |---|---|
  | `GET /api/v1/catalog` | 200, 348.016 byte, 1.126 channel (termasuk flag `selected` dan alasan pemeriksaan) |
  | `GET /api/v1/channels` | 200, 32.643 byte, 39 channel / 45 stream |
  | `GET /playlist.m3u` | 200, 46.771 byte, 39 channel, 45 URL |
  | `GET /api/v1/status` | 200, hitungan channel/stream/pilihan, `revision`, `lastError` |
  | `GET /api/v1/sources`, `/api/v1/selection` | 401 |
  | `POST /api/v1/refresh`, `POST /api/v1/sources`, `PUT /api/v1/selection`, `PATCH`/`DELETE /api/v1/sources/:id` | 401 |

- Pemeriksaan kebocoran isi: pada playlist final, header yang terekspor hanya `user-agent` (40), `referer` (28), `origin` (8). Tidak ada `license_key`, `Authorization`, `Cookie`, atau nilai `wsSecret` di respons HTTP mana pun. Jadi saat ini yang terbuka adalah **inventaris dan URL stream**, bukan kredensial.
- Kondisi dampak: siapa pun yang dapat menjangkau port 8787 memperoleh seluruh katalog 1.126 channel, termasuk channel yang tidak dipilih, plus daftar URL yang lolos pemeriksaan. Kebijakan ini memang disengaja untuk pemakaian LAN (README:56), tetapi menjadi masalah bila katalog dimaksudkan privat atau bila port suatu saat terpapar ke internet.
- Rekomendasi: tetapkan tegas katalog publik atau privat. Bila privat: token baca berumur pendek atau signed URL, pisahkan `/playlist.m3u` dari `/api/v1/catalog`, dan jangan kirim flag `selected` ke klien anonim.
- Verifikasi perbaikan: permintaan tanpa hak gagal untuk katalog privat; respons anonim tidak memuat `selected`/`reason`.

### B3 — Sedang: materi sesi dan lisensi tersimpan teks biasa

- Bukti (hitungan pola pada berkas, nilai tidak ditampilkan):

  | Berkas | Ukuran | `licenseKey` | `licenseUrl` | `wsSecret`/`wsABSTime` | `usersessionid`/`AuthInfo` | URL `http:` |
  |---|---|---|---|---|---|---|
  | `data/snapshot.json` | 264.866 B | 363 | 317 | 4 / 4 | 2 / 2 | 18 |
  | `data/aggregate.json` | 983.021 B | 580 | 379 | 7 / 7 | 2 / 2 | 106 |
  | `data/sources.json` | 198.999 B | 0 | 0 | 3 / 3 | 0 / 0 | 59 |

- Catatan penting: `writeFile(..., { mode: 0o600 })` di `src/service.mjs:81` dan `src/aggregate.mjs:35` **tidak berpengaruh di NTFS**. Perlindungan nyata hanya berasal dari ACL direktori. ACL `data/` saat audit: `SYSTEM`, `BUILTIN\Administrators`, `DESKTOP-6UHK9T6\COSMIC` (FullControl, tidak diwariskan) — sudah sempit.
- Kondisi dampak: salinan `data/` di backup, sinkronisasi cloud, atau berkas yang dikirim ke orang lain membawa materi sesi/lisensi pihak ketiga secara utuh. Ini juga berarti rotasi kredensial provider tidak cukup tanpa menghapus snapshot lama.
- Rekomendasi: perlakukan `data/` setara `.env`; keluarkan dari backup otomatis/sinkronisasi folder; pertimbangkan EFS/DPAPI untuk berkas ini; hapus snapshot saat mengganti sumber; jangan pernah mengirim `data/` untuk dukungan teknis.
- Verifikasi perbaikan: berkas baru tidak dapat dibaca akun lokal lain, dan tidak ada salinan `data/` di direktori backup/sinkronisasi.

### B4 — Sedang: beban egress dan pemindaian host pihak ketiga

- Bukti: `src/aggregate.mjs:229-254` menyusun `unique` dari **seluruh** kandidat (status melaporkan `totalSourceCount: 1366`, `progress.total: 1312`), bukan hanya 195 channel terpilih. Setiap pemeriksaan mengambil manifest (maks. 512 KB) lalu satu segmen media (`bytes=0-65535`, `src/probe.mjs:19`), konkurensi 4, satu permintaan per host pada satu waktu, anggaran `scanBudgetMs` 300 detik, dan siklus berulang setiap `REFRESH_SECONDS` (900 detik).
- Kondisi dampak: sekitar 1.300 permintaan keluar per siklus ke CDN pihak ketiga, termasuk ke host yang channel-nya tidak dipilih admin. Ini sumber utama jejak trafik layanan ini di mata penyedia, menambah kuota, dan memperbesar peluang diblokir. Tidak ada bukti jumlah ini melanggar batas provider; batas provider tidak diketahui.
- Rekomendasi: periksa channel terpilih lebih dulu (atau hanya yang terpilih), turunkan frekuensi pemeriksaan penuh (mis. 60 menit) dengan rotasi bertahap, tambahkan jitter, dan sediakan sakelar untuk mematikan pemeriksaan otomatis.
- Verifikasi perbaikan: `progress.total` mendekati jumlah stream terpilih; siklus tidak memeriksa host yang sama lebih dari sekali per jendela; log menunjukkan jumlah permintaan keluar per siklus.

### B5 — Sedang: feed utama tidak menghormati Retry-After dan tidak membedakan penolakan akses

- Bukti: `src/service.mjs:66` membuang body respons error (`await response.body?.cancel()`) sehingga `Retry-After` hilang; `server.mjs:45-52` selalu menjadwalkan ulang dengan interval tetap, baik sukses maupun gagal. Sebaliknya `src/network.mjs:59-63` sudah menerapkan pendinginan per host untuk 429 pada feed lain — jadi ada dua perilaku berbeda dalam satu aplikasi.
- Kondisi dampak: pada 403/429 dari sumber, proses tetap memanggil endpoint setiap 15 menit tanpa alasan terstruktur; status hanya memuat kode HTTP. Ini memperbesar risiko eskalasi blokir dan menyulitkan diagnosis.
- Rekomendasi: satukan penanganan 429/403 (hormati `Retry-After`, backoff eksponensial berbatas), hentikan feed dan beri alert pada penolakan akses yang menetap, tampilkan alasan terstruktur di `/api/v1/status`.
- Verifikasi perbaikan: fixture 429 menunda sesuai `Retry-After`; 403 berulang tidak memicu siklus cepat; cache lama tetap disajikan dengan status `stale`.

### B6 — Rendah–Sedang: URL siaran HTTP polos ikut terekspor

- Bukti: playlist final memuat 3 URL `http://` dari 45 stream; `data/aggregate.json` memuat 106 URL `http:`. Audit sebelumnya mencatat 9 dari 281 pada snapshot DopamineTV; angka berubah karena komposisi sumber berubah, bukan karena perbaikan.
- Kondisi dampak: isi siaran dan header yang dikirim ke host tersebut tidak terenkripsi; `#EXTHTTP` pada baris yang sama juga terekspor ke klien.
- Rekomendasi: tandai sumber HTTP di katalog, dan beri opsi `?scheme=https` atau pengecualian default untuk siaran polos.
- Verifikasi perbaikan: playlist dengan filter tersebut tidak memuat URL `http:`.

### B7 — Rendah: tidak ada pembatasan laju

- Bukti: tidak ada limiter pada `src/http.mjs`; hanya `/api/v1/refresh` yang dijeda 30 detik (`src/http.mjs:72`). Pengujian: 30 permintaan paralel ke `/playlist.m3u` selesai dalam 107 ms dengan isi identik; latensi normal 5–22 ms.
- Kondisi dampak: brute force token tidak realistis karena `ADMIN_TOKEN` 64 karakter hex (256 bit) — diperiksa panjang dan kelas karakternya, nilainya tidak dibaca. Dampak praktis hanya kebisingan log dan pemakaian CPU kecil.
- Rekomendasi: opsional; tambahkan limiter sederhana per IP untuk endpoint mutasi dan 401 berulang.

### B8 — Rendah: `Cache-Control: public` pada respons yang bergantung pada pilihan admin

- Bukti: `src/http.mjs:18` mengirim `public, max-age=0, must-revalidate` untuk `/playlist.m3u`, `/api/v1/channels`, `/api/v1/catalog`, dan berkas statis.
- Kondisi dampak: bila kelak ada proxy/CDN bersama di depan layanan, respons yang mencerminkan pilihan channel dapat tersimpan di cache bersama. Saat ini hanya ada satu pengguna, jadi dampaknya teoretis.
- Rekomendasi: gunakan `private, no-cache` untuk respons yang dipengaruhi `selection.json`.

### B9 — Rendah: guard SSRF tidak membatasi port

- Bukti: `src/network.mjs:14-21` memvalidasi skema, kredensial, nama host, dan keluarga alamat, lalu mengikat DNS ke alamat hasil resolusi. Diuji 25 kasus: `127.0.0.1`, `localhost`, `169.254.169.254`, `10/8`, `192.168/16`, `172.16/12`, `[::1]`, `[::ffff:127.0.0.1]`, `0.0.0.0`, `2130706433`, `0x7f.1`, `127.1`, `100.64/10`, `198.18/15`, `192.0.2/24`, `198.51.100/24`, `224/4`, `file:`, `gopher:`, URL berkredensial, dan URL dengan CRLF — semuanya ditolak. Yang lolos: `http://example.com:22/` (port tidak dibatasi) dan nama host yang saya uji dengan resolver stub.
- Kondisi dampak: server dapat diminta menghubungi port non-HTTP pada host publik. Karena hanya alamat publik yang diizinkan dan DNS diikat, ini bukan jalur ke jaringan internal, tetapi tetap memperluas permukaan.
- Rekomendasi: batasi port ke 80/443 (plus daftar kecil bila perlu).

### B10 — Rendah, desain: header provider diekspor ke setiap klien playlist

- Bukti: `src/playlist.mjs:49-61` mengekspor `#EXTHTTP:` dan `#EXTVLCOPT:http-user-agent/referrer/origin`. Saat ini isinya hanya UA/Referer/Origin.
- Kondisi dampak: `cleanHeaders` (`src/network.mjs:27`) mengizinkan `authorization` dan `cookie`. Jika suatu sumber memerlukan header tersebut dan stream-nya tidak berstatus DRM, header itu akan ikut tercetak di playlist yang dapat diunduh siapa pun di LAN. Kombinasi ini belum terjadi pada data sekarang, tetapi mudah terjadi saat menambah sumber baru.
- Rekomendasi: saring `authorization`, `cookie`, `proxy-authorization`, dan header bernama rahasia sebelum mengekspor; atau dokumentasikan bahwa playlist setara berkas kredensial.

### B11 — Rendah: kegagalan tak terduga menjadi HTTP 400

- Bukti: `src/http.mjs:62-65` memetakan setiap error yang tidak cocok pola ke 400 dengan pesan umum, sehingga kegagalan penyimpanan/IO tampak seperti kesalahan input.
- Rekomendasi: bedakan galat validasi (400) dan galat internal (500), catat galat internal ke log tanpa detail sensitif.

### A2 — Diperbaiki dan terverifikasi

`Get-Acl .env` sekarang hanya memuat `NT AUTHORITY\SYSTEM`, `BUILTIN\Administrators`, dan `DESKTOP-6UHK9T6\COSMIC` (FullControl, tidak diwariskan); grup `Users`/`Authenticated Users` sudah tidak ada. `data/` memiliki ACL yang sama sempitnya. Layanan tetap berjalan setelah pembatasan ini (status 200, sinkronisasi terakhir sukses 07:34). Temuan A2 pada dokumen audit sebelumnya sudah tidak berlaku.

### A1 — Tidak berubah

`src/service.mjs:59-63` tetap mengirim `User-Agent: DopamineTV/1.0.8 … Kodi/21.0` beserta `X-App-Signature` yang dibentuk dari `UPSTREAM_SECRET` aplikasi pihak ketiga. Ini masalah ketahanan produk dan kepatuhan, bukan cacat kode: bila sumber menolak identitas tersebut, seluruh sinkronisasi katalog berhenti. Rekomendasi pada audit sebelumnya masih berlaku.

## Kontrol yang diverifikasi bekerja

| Kontrol | Bukti |
|---|---|
| Perbandingan token constant-time | `src/http.mjs:31,69-71` — `timingSafeEqual` atas digest SHA-256 (panjang selalu 32 byte, tidak ada kebocoran panjang) |
| Kekuatan token | `ADMIN_TOKEN` 64 karakter hex (256 bit), bukan placeholder |
| Tidak ada bypass autentikasi | 9 endpoint mutasi diuji tanpa token dan dengan token salah → 401 seluruhnya |
| Tidak ada path traversal | `/.env`, `/../.env`, `/%2e%2e%2f.env`, `/data/snapshot.json`, `/logs/server.log` → 404; berkas statis memakai allowlist `src/http.mjs:9` |
| Header keamanan | `nosniff`, `no-referrer`, `X-Frame-Options: DENY`, CSP ketat tanpa `unsafe-inline` |
| Injeksi baris M3U | Uji dengan nama/atribut/header berisi `\r\n#EXTINF`, `"`, dan `__proto__`: semua karakter kontrol diganti spasi (`src/playlist.mjs:1-2`), tidak ada direktif baru yang terbentuk |
| ReDoS parser | Baris `#EXTINF` 200.000 tanda kutip diparse 3,9 ms; 2 MB daftar normal 82,6 ms |
| Guard SSRF | 21 dari 25 kasus uji ditolak. Dua yang lolos (`169.254.169.254.nip.io`, `metadata.google.internal`) hanya lolos karena resolver stub saya mengembalikan alamat publik; dengan DNS nyata keduanya mengarah ke alamat privat dan akan ditolak. Dua sisanya sah (`https://example.com/ok`) dan `example.com:22` (port tidak dibatasi, lihat B9). DNS diikat ke alamat hasil pemeriksaan (`src/network.mjs:41`), redirect diperiksa ulang dan header sensitif dibuang saat beda origin (`:64-69`) |
| Rahasia di log | `logs/server.log` (203 B) dan `logs/error.log` (0 B) tidak memuat token, URL, atau isi stream |
| Rahasia di kode | Tidak ada literal kredensial di `src/`, `public/`, `server.mjs`; hanya fixture di `test/` |
| Supply chain | `package.json` tanpa dependensi runtime maupun dev — tidak ada paket pihak ketiga yang perlu diaudit |
| Penulisan atomik | `writeFile` ke `.tmp` + `rename` + `unlink` di `finally` (`src/service.mjs:79-82`, `src/aggregate.mjs:31-37`) |
| Cache/ETag | `HEAD /playlist.m3u` → 200 dengan `Content-Length` benar; `If-None-Match` → 304 |
| Uji otomatis | `npm test` → 33 lulus, 0 gagal (termasuk uji injeksi baris dan kebocoran kredensial di status) |
| Docker | `USER node`, `no-new-privileges`, port host terikat `127.0.0.1`, `.dockerignore` mengecualikan `.env`/`data`/`logs` |

## Yang tidak diuji

- Firewall efektif: `Get-NetFirewallRule` ditolak (butuh Administrator), jadi cakupan `LocalSubnet` hanya dinilai dari `logs/lan-setup.json`, bukan dari kebijakan aktif.
- Pemindaian port dari host lain di LAN, ARP spoofing, dan uji intersepsi trafik nyata.
- Uji beban, uji DoS, dan brute force token.
- Refresh upstream nyata, perilaku server sumber saat menolak, dan uji ban.
- APK COSMIC (belum ada), Play Integrity, dan sisi klien pemutar (Kodi/VLC).
- Audit malware pada berkas `data/` dan APK sumber.
- Integritas backup: tidak diperiksa apakah `data/` atau `.env` sudah tersalin ke direktori backup/sinkronisasi.

## Rekomendasi dan urutan kerja

Asumsi default yang saya sarankan: APK **tidak** memuat dashboard di WebView, tetapi memanggil JSON API (`/api/v1/catalog`, `/api/v1/channels`, `/playlist.m3u`) dan memutar stream dengan player native. Dengan model itu permukaan admin tidak pernah ikut terdistribusi, dan aturan CSP/`frame-ancestors` di dashboard tidak perlu dilonggarkan untuk WebView. Bila kelak APK butuh tampilan seperti dashboard, bangun layar sendiri di APK; jangan memuat halaman admin.

### Fase 0 — wajib sebelum APK diuji di perangkat (1 hari)

1. **C2 — TLS.** Domain + Caddy/Nginx di depan `127.0.0.1:8787`, `HSTS`, dan URL backend di APK memakai `https://`. Tanpa ini APK Android modern tidak bisa konek, dan memaksa cleartext berarti mengirim token tanpa enkripsi.
2. **B1 — pisahkan admin dari publik.** Dashboard/pengelolaan cukup di `127.0.0.1` (atau di balik HTTPS + IP allowlist). Port playlist/API tetap terbuka. Ini sekaligus menutup jalur pencurian `ADMIN_TOKEN`.
3. **C1 — identitas minimal.** Buat `data/devices.json` + `POST /api/v1/session` (tukar device token dengan access token berumur pendek), middleware `requireClient` untuk endpoint baca, dan `DELETE /api/v1/devices/:id` untuk mencabut. Cukup token statis per perangkat untuk pemakaian pribadi; naik ke akun hanya bila pengguna bertambah.

### Fase 1 — risiko eksternal dan data (1–2 hari)

4. **B4 — perkecil egress.** Periksa hanya stream dari channel terpilih lebih dulu, sisanya rotasi bertahap; naikkan jeda pemeriksaan penuh ke 60 menit; tambah jitter. Ini menurunkan peluang diblokir provider.
5. **B3 — perlakukan `data/` sebagai materi rahasia.** Pengecualian dari backup/sinkronisasi folder, dan pertimbangkan EFS/DPAPI. `mode 0o600` tidak berlaku di NTFS, jadi ACL + kebijakan backup adalah satu-satunya kontrol.
6. **B5 — satukan penanganan 429/403.** Hormati `Retry-After` di `src/service.mjs`, backoff berbatas, dan hentikan feed pada penolakan menetap.
7. **C4 — jaga invariant ekspor.** Uji regresi: playlist publik tidak boleh pernah memuat `license_key`, `Authorization`, atau `Cookie`. Saring nama header sensitif di `src/playlist.mjs:49-61`.

### Fase 2 — ketahanan (saat pengguna bertambah)

8. **C3/B7 — limiter per token/IP** + `Retry-After`; APK memakai `If-None-Match` dan interval 30–60 detik.
9. **B2 — putuskan katalog publik atau privat**; bila privat, signed URL berumur pendek untuk `/playlist.m3u` dan jangan kirim flag `selected` ke klien anonim.
10. **B8–B11** — `Cache-Control: private`, batasi port di guard SSRF, bedakan 400/500.

### Jangan dilakukan

- `android:usesCleartextTraffic="true"` atau pengecualian network-security untuk produksi.
- Menanam `ADMIN_TOKEN` di APK, atau memakai token yang sama untuk admin dan klien.
- Memuat dashboard admin di WebView, apalagi lewat HTTP.
- Mengandalkan obfuscation sebagai penyimpanan rahasia.
- Menganggap URL stream/sesi hasil impor permanen; provider dapat mencabutnya kapan saja.

Estimasi di atas kasar dan mengasumsikan satu orang yang sudah paham kode ini.

## Status perbaikan — diterapkan 7 November 2026

| Temuan | Perbaikan | Bukti verifikasi |
|---|---|---|
| B1 admin lewat HTTP | Dua listener: publik `PORT` tanpa rute admin; admin `ADMIN_PORT`/`ADMIN_HOST` (default `127.0.0.1:8788`) | `GET /` di 8787 → 404; `/api/v1/refresh` di 8787 → 404; admin 8788 dari loopback → 200 |
| B2 katalog publik | `READ_TOKENS` (daftar token, constant-time); token admin tidak berlaku sebagai token baca; `?token=` hanya untuk playlist | tanpa token → 401 + `WWW-Authenticate`; dengan token → 200 |
| B3 data teks biasa | `start.ps1` memverifikasi/membatasi ACL `.env`, `data`, `logs`; README + `deploy/README.md` menandai `data/` sebagai materi rahasia | ACL: hanya user, SYSTEM, Administrators (tidak diwariskan) |
| B4 egress 1.366 URL | `PROBE_SELECTED_ONLY=true` — hanya channel terpilih yang diperiksa; `setSelection` memverifikasi channel baru | uji "only selected channels are probed": probe turun dari 2 ke 1 |
| B5 tanpa Retry-After | `retryAfterMs()` + backoff eksponensial (cap 6 jam), `lastStatus`, `lastErrorKind`, `failures`, `retryAt`, `nextDelaySeconds`; jitter di penjadwal | uji backoff: 429 → 90 s, 403 berulang → ≥120 s, sukses → reset |
| B6 URL `http://` | Filter `?scheme=https` + penanda `x-cosmic-cleartext="1"`; `cleartextSourceCount` di katalog | uji filter skema |
| B7 tanpa rate limit | `RATE_LIMIT`, `AUTH_FAIL_LIMIT` per IP → 429 + `Retry-After` | uji rate limit |
| B8 `Cache-Control: public` | `private, max-age=0, must-revalidate` + `Vary: Authorization` | header diperiksa pada respons playlist/katalog |
| B9 port bebas | `allowedPort()`: 80/443, port ≥1024 di luar daftar terlarang, `ALLOWED_PORTS` untuk eksepsi | 22/6379 ditolak; 8443/1935 tetap boleh (sumber nyata memakai 1935, 1936, 5443, 6610, 19360) |
| B10 header kredensial | `safeHeaders()` menyaring `authorization`, `cookie`, token, secret, signature dari `#EXTHTTP` | uji redaksi header |
| B11 400 untuk galat internal | `HttpError` + pemetaan 400/413/500; galat tak dikenal → 500 + log | uji JSON rusak → 400, kegagalan IO → 500 |
| C2 TLS | `deploy/Caddyfile` (HSTS, admin hanya `remote_ip` tepercaya) + `deploy/README.md` | belum dijalankan: butuh VPS + domain |
| Panel web + endpoint server | Panel dilayani di port publik (`ADMIN_WEB_PANEL`, default true); mutasi butuh `ADMIN_TOKEN`; `GET/PUT /api/v1/settings` menyimpan `publicOrigin` di `data/settings.json` (https wajib untuk host publik) | panel 200 di 127.0.0.1 dan IP LAN; settings tanpa token 401; PUT `http://host-publik` ditolak 400; nilai LAN http diterima |
| C4 kunci DRM | Uji regresi: playlist publik tidak memuat `license_key`/`Authorization`/`Cookie`; DRM tetap difilter | 44 entri playlist: 0 `license_key`, 0 header kredensial |
| Kontrak pemain | Baris `#COSMIC:format=1 revision=… updated-at=… state=… channels=… streams=…` + `runtime.js` | playlist live: marker ada, 44 entri, 3 ditandai cleartext |

Uji otomatis: **49 lulus, 0 gagal** (`npm test`), termasuk 16 uji baru di `test/hardening.test.mjs`. Layanan berjalan dengan konfigurasi baru: publik `0.0.0.0:8787` (token baca wajib), admin `127.0.0.1:8788`.

Belum dikerjakan: TLS belum aktif (butuh VPS + domain), `data/` belum dienkripsi (baru ACL + panduan backup), dan refresh upstream nyata belum diuji ulang setelah perubahan.

Referensi primer:

- OWASP ASVS v4 — V2 (autentikasi), V12 (berkas), V14 (konfigurasi).
- Node.js: `crypto.timingSafeEqual`, `http.request` `lookup` untuk pengikatan DNS.
- Android/ToS: lihat referensi pada `security-audit-2026-11-07.md`.
