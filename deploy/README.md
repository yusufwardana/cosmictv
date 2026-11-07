# Deploy VPS + TLS

Urutan ini mengasumsikan VPS Ubuntu/Debian dengan Docker dan domain yang sudah diarahkan ke IP VPS.

## 1. Siapkan server

```sh
apt update && apt install -y docker.io docker-compose-plugin
systemctl enable --now docker
```

## 2. Salin aplikasi (tanpa rahasia di jalur publik)

Dari mesin lokal, kirim hanya berkas aplikasi. `.env` dan `data/` dikirim terpisah ke lokasi yang tidak dapat dibaca pengguna lain.

```sh
rsync -av --exclude .env --exclude data --exclude logs --exclude node_modules \
  ./ user@VPS:/srv/cosmic-tv/
scp .env user@VPS:/srv/cosmic-tv/.env
ssh user@VPS 'chmod 600 /srv/cosmic-tv/.env && mkdir -p /srv/cosmic-tv/data && chmod 700 /srv/cosmic-tv/data'
```

## 3. Konfigurasi `.env` untuk VPS

```ini
HOST=0.0.0.0
PORT=8787
ADMIN_HOST=127.0.0.1
ADMIN_PORT=8788
PUBLIC_ORIGIN=https://tv.domain-anda.id
READ_TOKENS=<token-baca-panjang>
ADMIN_TOKEN=<token-admin-panjang>
RATE_LIMIT=300
PROBE_SELECTED_ONLY=true
```

Buat token baru di server, jangan memakai token yang pernah tampil di terminal lokal:

```sh
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

## 4. Jalankan kontainer

```sh
cd /srv/cosmic-tv
docker compose up -d --build
docker compose ps
docker compose logs -f --tail=50
```

Kedua port hanya di-bind ke loopback host: `127.0.0.1:8787` (publik) dan `127.0.0.1:8788` (admin). Reverse proxy yang meneruskan dari internet.

## 5. TLS dengan Caddy

```sh
apt install -y caddy
cp deploy/Caddyfile /etc/caddy/Caddyfile   # ganti domain + remote_ip
caddy validate --config /etc/caddy/Caddyfile
systemctl reload caddy
```

## 6. Verifikasi (harus lulus sebelum APK/pemutar dipakai)

```sh
# TLS aktif dan HSTS
curl -sI https://tv.domain-anda.id/api/v1/status | grep -Ei 'strict-transport|HTTP/'

# Tanpa token -> 401 (bukan 200)
curl -s -o /dev/null -w '%{http_code}\n' https://tv.domain-anda.id/playlist.m3u

# Dengan token -> 200 + marker revisi
curl -s -H "Authorization: Bearer $READ_TOKEN" https://tv.domain-anda.id/playlist.m3u | head -2

# Admin tertutup dari internet
curl -s -o /dev/null -w '%{http_code}\n' https://tv.domain-anda.id/      # harap 403
curl -s -o /dev/null -w '%{http_code}\n' https://tv.domain-anda.id/api/v1/refresh -X POST   # harap 403

# Admin dari VPS sendiri (loopback)
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8788/
```

Akses dashboard dari komputer Anda tanpa membuka admin ke internet:

```sh
ssh -L 8788:127.0.0.1:8788 user@VPS
# lalu buka http://127.0.0.1:8788
```

## 7. Operasional

- **Backup:** `docker compose exec playlist ls /app/data` menyimpan materi sesi/lisensi pihak ketiga. Simpan terenkripsi, jangan di folder sinkronisasi publik.
- **Rotasi token:** ganti `READ_TOKENS` (boleh beberapa, pisahkan koma) lalu `docker compose up -d`. Perangkat lama berhenti dengan 401 tanpa mengganggu yang baru.
- **Pembaruan:** `git pull`/rsync lalu `docker compose up -d --build`. Snapshot ada di volume `playlist-data`, tidak hilang.
- **Log:** `docker compose logs` tidak mencatat token; Caddy mencatat URI termasuk `?token=` — matikan log akses atau pakai header.
