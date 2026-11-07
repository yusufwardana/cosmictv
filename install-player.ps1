# Install CosmicTV Web Player di PC Windows (repo cosmictv).
# Jalankan dari folder root repo cosmictv, misal D:\Tools\cosmictv :
#   .\install-player.ps1
# Script ini: menyalin player.html/player.js/player.css ke public/,
# mengunduh Shaka Player 4.7.11 ke public/, dan mendaftarkan keempat file
# di staticFiles src/http.mjs (kalau belum ada). Tidak menyentuh .env,
# data/, atau token apa pun. Jalankan `npm run check` dan `npm test` di akhir.
param(
  [string]$PlayerDir = "$PSScriptRoot"
)
$ErrorActionPreference = 'Stop'
Set-Location (Split-Path -Parent $MyInvocation.MyCommand.Path)

if (-not (Test-Path 'server.mjs')) { throw 'Jalankan script ini dari folder root repo cosmictv (harus ada server.mjs).' }
if (-not (Test-Path 'public')) { throw 'Folder public/ tidak ditemukan.' }

foreach ($f in 'player.html','player.js','player.css') {
  $src = Join-Path $PlayerDir $f
  if (-not (Test-Path $src)) { throw "File $f tidak ditemukan di $PlayerDir. Letakkan install-player.ps1 satu folder dengan player.html/player.js/player.css." }
  Copy-Item $src "public\$f" -Force
  Write-Host "Disalin: $f -> public\$f"
}

$shaka = 'public\shaka-player.compiled.js'
if (-not (Test-Path $shaka)) {
  Write-Host 'Mengunduh Shaka Player 4.7.11...'
  curl.exe -L -o $shaka 'https://cdn.jsdelivr.net/npm/shaka-player@4.7.11/dist/shaka-player.compiled.js'
}
Write-Host "Shaka: $((Get-Item $shaka).Length) byte"

$http = Get-Content 'src\http.mjs' -Raw
$oldLine = "  const staticFiles = { '/': ['index.html', 'text/html; charset=utf-8'], '/style.css': ['style.css', 'text/css; charset=utf-8'], '/app.js': ['app.js', 'text/javascript; charset=utf-8'] };"
$newLine = "  const staticFiles = { '/': ['index.html', 'text/html; charset=utf-8'], '/style.css': ['style.css', 'text/css; charset=utf-8'], '/app.js': ['app.js', 'text/javascript; charset=utf-8'], '/player.html': ['player.html', 'text/html; charset=utf-8'], '/player.js': ['player.js', 'text/javascript; charset=utf-8'], '/player.css': ['player.css', 'text/css; charset=utf-8'], '/shaka-player.compiled.js': ['shaka-player.compiled.js', 'text/javascript; charset=utf-8'] };"
if ($http.Contains('/player.html')) {
  Write-Host 'staticFiles sudah berisi entri player (tidak diubah).'
} elseif ($http.Contains($oldLine)) {
  $http = $http.Replace($oldLine, $newLine)
  Set-Content 'src\http.mjs' $http -NoNewline
  Write-Host 'staticFiles di src\http.mjs diperbarui.'
} else {
  Write-Host 'PERINGATAN: baris staticFiles tidak cocok dengan yang diharapkan — periksa src\http.mjs manual (lihat README).'
}

npm run check
npm test
Write-Host ''
Write-Host 'Selesai. Jalankan server lalu buka /player.html (misal https://tv.cosmiclabs.web.id/player.html).'
