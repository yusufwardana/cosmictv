# COSMIC TV / DopamineTV — audit akses sumber dan kesiapan APK

Tanggal: 7 November 2026, Asia/Jakarta.
Status: PARTIAL — audit statis APK dan kode API, ditambah pemeriksaan HTTP lokal. Bukan audit server DopamineTV atau pemeriksaan malware lengkap.

## Kesimpulan

Pengambilan playlist dapat ditolak dan secara teknis dapat dikaitkan dengan identitas perangkat/IP. APK mengantisipasi respons blokir administrator. Tidak tersedia kode, konfigurasi atau log server pihak sumber untuk menentukan apakah mengambil playlist memicu ban otomatis, ambang batasnya, atau kapan blokir dilakukan. Tidak ada persentase risiko yang dapat dipertanggungjawabkan.

Log sinkronisasi terakhir yang dibaca menunjukkan sukses pada 7 November 2026 pukul 01:17 WIB, 196 channel / 281 sumber. GET lokal saat audit mengembalikan state ready. GET lokal membaca cache: hal ini bukan permintaan baru ke sumber dan tidak membuktikan sumber masih menerima akses pada setiap saat berikutnya. Audit ini tidak memaksa refresh upstream, tidak menjalankan APK, dan tidak melakukan pengujian yang mencoba memicu ban.

Mengubah branding web tidak mengubah identitas permintaan di upstream. COSMIC TV tetap bergantung pada endpoint, format signature, dan rahasia aplikasi DopamineTV versi yang dianalisis. Server sumber dapat mengubah autentikasi, menolak identitas yang dipakai, atau menghentikan endpoint. Cache tidak memperpanjang masa berlaku stream/session/license.

## Lingkup dan bukti

- APK: C:/Users/COSMIC/Downloads/DopamineTV v1.0.8 (LIVE Streaming BOLA) (SFILE.MOBI).apk
- SHA-256 yang dikonfirmasi ulang: 22e7f8a0a296577b70709cc673cfafea146ac85809750b5e44e696f5b5dc3450.
- Dekompilasi yang dipakai: C:/Users/COSMIC/AppData/Local/Temp/DopamineTV-jadx-analysis/sources/.
- JADX CLI dipakai setelah provider Android REA sebelumnya gagal karena konfigurasi engine. Dekompilasi memiliki peringatan/kegagalan; cakupannya tidak boleh dianggap sempurna.
- Backend yang diperiksa: D:/Tools/DopamineTV/web/src/{http,service,playlist}.mjs, server.mjs, public/app.js, serta ACL .env. Nilai kredensial tidak dicantumkan.
- Manifest Android lengkap, perilaku runtime, server ban policy, pemutaran semua stream, dan layanan lisensi tidak diverifikasi.

## Mekanisme yang terlihat di APK

| Observasi statis | Lokasi dekompilasi | Makna dan batas bukti |
|---|---|---|
| Header X-Device-Id, model, tipe, Android, versi aplikasi, timestamp dan signature | defpackage/at2.java:154; fv1.java:341 | Server menerima atribut yang dapat dipakai mengelompokkan permintaan; bukan bukti seluruh atribut dipakai untuk ban. |
| ID diambil dari Android ID atau fallback UUID dan disimpan | defpackage/uv2.java:89 | Aplikasi asli memakai ID yang tetap. Backend lokal memakai ID acak tetap dari konfigurasinya, bukan Android ID HP pengguna. |
| Respons 403 dengan kata diblokir diubah menjadi pesan perangkat diblokir administrator | defpackage/at2.java:160 | Bukti client mengantisipasi blokir. 403 umum juga dapat disebabkan autentikasi gagal; tidak otomatis berarti ban permanen. |
| Pemeriksaan sniffer, proxy, VPN, debugger, instrumentasi, emulator dan integritas paket/tanda tangan | defpackage/ga3.java; dipanggil dari at2.java:113 | APK dapat menghentikan alur lokal ketika kondisi terdeteksi. Ini bukan bukti otomatis mengirim laporan ban ke server. |
| Pengiriman status developer options / ADB dalam X-Device-Exposure | defpackage/ga3.java:35; at2.java:135,158 | Aplikasi asli mengirim sebagian sinyal lingkungan. Kebijakan penindakan server tidak diketahui. |
| Ping identitas perangkat | defpackage/bt2.java:46,71 | Ada jalur perangkat/ping. Backend COSMIC saat ini hanya memanggil channels, tidak meniru seluruh siklus aplikasi. |
| Certificate pinning dan Proxy.NO_PROXY | defpackage/rr2.java:30; jb.java:119; vs2.java:1309 | Proxy HTTPS biasa tidak dapat diasumsikan menangkap isi trafik APK. |
| Rahasia bersama dan kode pembentuk signature tersedia di APK | BuildConfig; defpackage/vs2.java:1321 | Rahasia aplikasi yang terdistribusi dapat diekstrak; format yang berhasil sekarang bukan kontrak API stabil. |

Pada HTTPS server tujuan tetap dapat melihat IP publik koneksi dan header yang dikirim kepadanya. IP LAN 10.10.12.50 biasanya bukan IP yang dilihat upstream di balik NAT. Server katalog, server stream, dan server DRM/lisensi adalah titik kontrol yang berbeda. Pemutaran langsung dari perangkat klien menghasilkan koneksi ke penyedia stream/lisensi sehingga backend katalog tidak menyembunyikan seluruh trafik pemutaran.

## Temuan prioritas

### A1 — Tinggi untuk ketahanan produk: ketergantungan pada autentikasi aplikasi pihak sumber

- Bukti: src/service.mjs:6,59–66 membuat signature dan memakai identitas aplikasi sumber. Endpoint dapat menolak permintaan; sebelumnya request tanpa autentikasi memang mendapat 403.
- Kondisi dampak: server menolak ID/IP, mengubah rahasia/format, mensyaratkan attestation atau mengganti API. Sinkronisasi seluruh katalog sumber itu dapat berhenti.
- Rekomendasi: pakai integrasi/akun provider yang disetujui untuk distribusi; pisahkan adaptor per sumber dengan provenance, jadwal dan status; jangan menempatkan rahasia upstream bersama di APK COSMIC.
- Verifikasi perbaikan: simulasi 401/403/429/timeout; kegagalan satu adaptor tidak mengganti katalog valid dari adaptor lain. Tidak menguji ban nyata dengan menaikkan trafik.

### A2 — Tinggi pada komputer dengan beberapa pengguna: ACL .env terlalu luas

- Bukti: Get-Acl menunjukkan BUILTIN/Users memiliki ReadAndExecute, dan Authenticated Users memiliki hak lebih luas yang diwariskan. Kredensial berada di .env. Pembatasan mode POSIX pada snapshot bukan pembatasan ACL Windows untuk .env.
- Kondisi dampak: akun lokal lain dengan izin tersebut dapat membaca rahasia upstream dan ADMIN_TOKEN; hak tulis lokal juga memungkinkan perubahan konfigurasi.
- Rekomendasi: batasi ACL aplikasi/kredensial ke akun service, SYSTEM dan administrator; lindungi backup serta snapshot yang berisi material sesi/lisensi. Rotasi token admin bila pernah dibagikan.
- Verifikasi perbaikan: cek ACL efektif; akun lokal lain tidak dapat membaca/menulis .env, sedangkan service tetap dapat startup.

### A3 — Tinggi pada LAN yang tidak dipercaya: token admin ditransmisikan lewat HTTP

- Bukti: src/http.mjs:10 menggunakan server HTTP; public/app.js mengirim Authorization Bearer untuk refresh. Alamat aktif adalah http://10.10.12.50:8787.
- Kondisi dampak: pihak yang dapat memantau/manipulasi trafik jaringan dapat memperoleh token jika admin menggunakan fungsi tersebut lewat LAN. Tidak ada bukti token telah dicuri.
- Rekomendasi: gunakan HTTPS untuk distribusi dan akses admin; atau batasi administrasi ke localhost selama pengujian LAN. Pisahkan akses admin dari endpoint playlist.
- Verifikasi perbaikan: API/admin hanya menerima HTTPS pada deployment; tidak mengirim token melalui HTTP. Android release menolak cleartext kecuali pengecualian debug yang terbatas.

### A4 — Sedang, menjadi tinggi bila katalog dimaksudkan privat: endpoint baca tanpa autentikasi

- Bukti: GET /playlist.m3u dan /api/v1/channels tanpa token mendapat 200. src/http.mjs:43–51 mengirim URL, header dan metadata DRM yang tersedia dari sumber. Kebijakan ini memang dipilih untuk layanan playlist LAN awal.
- Kondisi dampak: siapa pun yang dapat menjangkau server dapat menyalin seluruh katalog dan material yang terdapat dalam respons. Token admin hanya melindungi refresh, bukan pembacaan.
- Rekomendasi: tetapkan apakah katalog publik atau privat. Untuk APK dengan akun pelanggan, lakukan autentikasi/otorisasi server, token akses berumur pendek, pencabutan sesi dan pembatasan laju. Tidak mungkin menjamin URL yang diberikan kepada pemutar klien tidak dapat disalin.
- Verifikasi perbaikan: akses tanpa hak gagal untuk katalog privat; kredensial upstream dan admin tidak pernah dikirim ke APK. Hindari cache publik untuk respons personal.

### A5 — Sedang: pemulihan sumber belum membedakan ban, rate limit dan kesalahan autentikasi

- Bukti: src/service.mjs:66 membuang body respons error; server.mjs:43–44 menjadwalkan ulang interval yang sama setelah sukses maupun gagal. Dengan interval 900 detik, sekitar 96 request terjadwal/hari, ditambah startup dan refresh manual. Permintaan playlist pengguna tidak memicu refresh upstream.
- Kondisi dampak: proses terus mencoba meskipun sumber menolak akses; status hanya memuat HTTP code tanpa alasan terstruktur. Tidak ada bukti jumlah tersebut melanggar batas provider; batas provider tidak diketahui.
- Rekomendasi: hormati Retry-After saat tersedia, backoff terbatas, hentikan sumber/beri alert pada penolakan akses yang menetap, dan sediakan tombol menonaktifkan sumber. Redaksi detail error sebelum ditampilkan atau dicatat.
- Verifikasi perbaikan: fixture 429 menunda sesuai Retry-After; 403 tidak menyebabkan loop cepat; cache lama tetap tersedia dengan status stale dan usia yang jelas.

### A6 — Sedang: sejumlah sumber memakai HTTP dan atribut sesi/perangkat

- Bukti snapshot: 281 URL sumber; 9 memakai HTTP dan 272 HTTPS. Nama parameter mencakup AuthInfo, usersessionid, userid, deviceMac, wsSecret dan wsABSTime. Nilainya tidak ditampilkan dalam audit.
- Kondisi dampak: parameter tersebut mengindikasikan kemungkinan keterikatan pada sesi/identitas/waktu, tetapi nama parameter saja tidak membuktikan pemilik akun, masa berlaku atau kebijakan server. Berbagi URL dapat mengekspos material sesi dari sumber; 9 sumber HTTP juga tidak mendapat enkripsi transport.
- Rekomendasi: klasifikasikan sumber dan masa berlaku berdasarkan dokumentasi provider; jangan menganggap URL hasil sniff permanen atau boleh dipakai bersama banyak pengguna. Gunakan URL HTTPS resmi bila tersedia; perlakukan parameter sesi sebagai rahasia dalam log/telemetri.
- Verifikasi perbaikan: pembaruan URL kedaluwarsa dan penanganan 401/403 diuji pada integrasi yang sesuai; pemeriksaan skema URL dan redaksi parameter sensitif berjalan tanpa mengunduh video.

## Pemeriksaan yang dijalankan

| Pemeriksaan | Hasil |
|---|---|
| GET /api/v1/status lokal | 200, ready; cache dari sinkronisasi sukses terakhir |
| GET /playlist.m3u lokal tanpa token | 200, sesuai desain baca publik LAN |
| GET /api/v1/channels lokal tanpa token | 200, sesuai desain baca publik LAN |
| GET /.env melalui HTTP | 404; bukan jalur unduhan web |
| POST /api/v1/refresh tanpa token | 401 |
| ACL .env lokal | Hak baca diwariskan kepada grup pengguna umum |
| Snapshot metadata | 9 HTTP / 272 HTTPS, Widevine dan ClearKey |
| Mutasi produksi, brute force, ban probe, sniff runtime | Tidak dilakukan |

Pengujian fungsional sebelumnya yang lulus tidak membuktikan keamanan untuk distribusi APK atau internet. Temuan ini dicatat tanpa mengubah layanan yang sedang berjalan. Scheduler 15 menit masih aktif.

## Rancangan untuk APK COSMIC

APK COSMIC mengakses API COSMIC melalui HTTPS. Backend COSMIC mengelola adaptor provider, kredensial, normalisasi katalog, deduplikasi, last-known-good, pemantauan kesehatan dan status ketersediaan. Setiap item menyimpan sumber serta waktu pembaruan; katalog lengkap dan sumber yang benar-benar dapat diputar adalah dua ukuran berbeda.

Gunakan proses analisis APK/traffic untuk memahami endpoint, format payload, autentikasi, DRM dan perilaku kedaluwarsa pada aplikasi/perangkat yang disediakan untuk pengujian. Lalu buat adaptor yang teruji menggunakan akses integrasi yang sesuai. Sniffing rutin bukan jaminan katalog selalu lengkap: certificate pinning, token pendek, batas sesi dan perubahan upstream tetap berlaku. Tidak ada mekanisme anti-ban yang dapat menjamin akses ke server yang dikelola pihak lain.

Untuk aplikasi sendiri: package ID dan signing key sendiri; token sesi pengguna berumur pendek; keputusan izin di backend; rahasia upstream dan admin tidak berada di APK. Pertimbangkan Play Integrity sebagai sinyal tambahan jika distribusinya sesuai, disertai kebijakan backend dan pemulihan kesalahan. Jangan menganggap obfuscation sebagai penyimpanan rahasia.

Referensi primer:

- Android: https://developer.android.com/privacy-and-security/risks/hardcoded-cryptographic-secrets
- Android: https://developer.android.com/privacy-and-security/risks/cleartext-communications
- Android: https://developer.android.com/google/play/integrity/overview
