# PATCHES — catatan perubahan ivvibill

Format: **[TANGGAL] v<versi> — <jenis>**. Tambahkan entri baru di atas.

---

## 2026-10-05 — v1.0.6 — layar login berkedip (loop reload 401)

**Bug fixed**

- `API.req()` merespons HTTP 401 dengan `location.href = '/panel/?expired=1'`.
  Karena halaman aplikasi hanya ada satu (`/panel/`, `/agen/`, `/teknisi/`,
  `/pelanggan/`), URL tujuan sama dengan URL yang sedang dibuka, dan
  `location.href` ke URL yang **sama tetap me-reload** halaman. Setiap reload
  memanggil `/api/auth/me` → 401 lagi → reload lagi: layar login berkedip ~1×
  per detik dan menembak `/api/auth/me` terus-menerus.
- Kini navigasi hanya dilakukan bila berada di halaman lain
  (`location.replace(halaman + '?expired=1')`); di layar login cukup lempar
  error sehingga `requireLogin()` menampilkan kartu login. `showLogin()` juga
  diberi pesan "Sesi berakhir — masuk kembali." saat `?expired=1` ada di URL,
  dan tidak lagi menambah kartu login kedua bila sudah tampil.

**Verifikasi (2026-10-05)**

- Lewat browser (HTTP): `/panel/`, `/agen/`, `/teknisi/` tetap di URL yang sama
  selama 6–8 detik dengan kartu login tampil (`/api/auth/me` 401 hanya sekali per
  muat, sebelumnya 1× per detik di `access log`); `/panel/?expired=1` menampilkan
  pesan "Sesi berakhir — masuk kembali.".

## 2026-10-05 — v1.0.5 — router tidak lagi "down" karena satu siklus gagal

**Bug fixed**

- Link API ke CCR1009 (203.0.113.10:8429) sering membuang paket (`EHOSTUNREACH`),
  padahal router-nya hidup. Karena scheduler polling tiap 60 detik dan satu
  siklus gagal langsung menulis `status='down'`, panel bolak-balik menampilkan
  router mati — dan `cekPppoePelanggan()` yang ikut gagal akan menandai semua
  pelanggan offline.
- `pollRouter()` kini menghitung siklus gagal berturut-turut per `id_setting`
  (`gagalRouter`, di memori). `setting_mikrotik.status='down'` baru ditulis
  setelah `AMBANG_DOWN = 3` siklus gagal beruntun; satu polling sukses
  mereset penghitung. `master_perangkat.last_msg` tetap mencatat pesan error
  lengkap dengan nomor siklus (`gagal ke-2: …`) supaya penyebabnya terlihat.
- `cekPppoePelanggan()` juga dijaga: bila **tidak ada** satu router pun yang
  berhasil dibaca pada siklus itu, pemeriksaan offline dilewati
  (`semuaRouterGagal: true`). Sebelumnya sesi online yang gagal diambil
  dianggap "tidak ada pelanggan yang online", sehingga semua pelanggan
  berujung issue offline + WA palsu begitu link API router drop.

**Verifikasi (2026-10-05)**

- Uji logika dengan DB/RouterOS tiruan: 4 siklus gagal → `down` ditulis 2×
  (siklus ke-3 dan ke-4); sukses lalu 2× gagal → 0×; gagal ke-3 setelah reset →
  1×. `/tmp/ivvi_guard_test.js`.
- Di layanan nyata setelah `systemctl restart ivvibill`: siklus gagal tetap
  tercatat di log, `setting_mikrotik.status` bertahan `active` dengan
  `cpu_load`/`last_check` diperbarui tiap menit.


## 2026-10-05 — v1.0.4 — panel tidak bergaya di HTTP

**Bug fixed**

- Helmet menambahkan CSP `upgrade-insecure-requests`, sehingga browser memaksa
  `https://` untuk semua aset dan `fetch()`. Karena `ivvinet.my.id` belum punya
  sertifikat TLS, `style.css`/`panel.js` gagal dimuat: panel tampil polos dan
  kartu dashboard berhenti di "Memuat…". Direktif tersebut kini hanya dikirim
  bila `BASE_URL` memakai `https` (`config.app.https`).

**Verifikasi (2026-10-05)**

- Header CSP tidak lagi memuat `upgrade-insecure-requests`; lewat browser
  (http) landing, `/panel/`, `/agen/`, `/pelanggan/`, `/teknisi/` tampil ber-gaya
  dan layar login muncul; `/api/dashboard` menjawab 401 `Belum login` untuk
  sesi kedaluwarsa lalu dialihkan ke `?expired=1` (sesuai desain).
- `POST /api/auth/login` dengan user tak dikenal → 401, akun asli tidak tersentuh.

## 2026-10-05 — v1.0.3 — klien RouterOS + import data IVVINET

**Bug fixed**

- **Parser atribut RouterOS salah.** `run()` mencari kata `'='` terpisah di
  dalam array kalimat, padahal router mengirim atribut sebagai satu kata
  `"=kunci=nilai"`. Semua hasil parsing kosong: `listInterfaces()` mengembalikan
  baris tanpa `name`/`type`, `resource()` selalu `cpu_load: 0`, dan
  `pppoeActive()` tidak menemukan sesi — pelanggan PPPoE akan ditandai offline
  semua. Parser sekarang membaca `=kunci=nilai` (`_attr()`), dan reply
  dikumpulkan sampai `!done`/`!fatal` (`_recvUntilDone()`) karena router bisa
  memecah reply ke beberapa paket TCP.
- **Traffic interface.** `/interface/monitor-traffic` diganti perhitungan selisih
  counter `rx-byte`/`tx-byte` antar polling (`monitorRate()`), disimpan sebagai
  `rx_bps`/`tx_bps` di `interface_log`. Polling pertama masih 0 (belum ada
  pembanding).
- **Login.** Password polos tetap percobaan pertama (ROS >= 6.43); bila router
  membalas `=ret=` (ROS lama) ulangi dengan `md5("\0" + password + challenge)`.
- **`pppoeActive()`** memakai `user || name` — di beberapa router kolom `user`
  kosong dan username PPPoE ada di `name`.
- **Koneksi tidak stabil.** `sambungkan()` (monitoring) dan `testConnection()`
  mencoba 3x dengan jeda 1,2 s sebelum menyatakan router `down`; link ke API
  IVVINET-CBD sering mengembalikan `EHOSTUNREACH`.

**Fitur / data**

- `scripts/import-ivvinet.js` — import idempoten dari DB gratisinaja
  (`SRC_DB_USER`/`SRC_DB_PASS`, `--src-server=4 --dst-server=1`, `--dry-run`):
  identitas + jadwal tagihan `data_server`, 8 paket PPPoE, MikroTik
  `IVVINET-CBD` → `master_perangkat` + `setting_mikrotik`, OLT `OLT-HSAIRPRO`
  → `master_perangkat` + `setting_olt`, dan 7 template WhatsApp milik IVVINET
  (placeholder `#usr #tot #lmt` kompatibel). Password perangkat dienkripsi
  AES-256-GCM dan tidak pernah dicetak.
- Data demo `budi` / `10M Rumahan` / `Voucher 3 Jam` dinonaktifkan (bukan dihapus).

**Verifikasi (2026-10-05)**

- Mock server format nyata (`=kunci=nilai`): 4 interface non-PPPoE, CPU 17 %,
  memori 50 %, board/uptime, sesi PPPoE `customer01`, rate `rx≈4,47 Mbps` — PASS.
- Router nyata `203.0.113.10:8429` (`ivvi`): `pollRouter(1)` OK 18 interface,
  CPU 26 %, memori 65 %, board `CCR1009-7G-1C`, trafik per interface masuk
  (`vlan117 rx 59 Mbps / tx 328 Mbps`), `/ppp/active/print` 203 sesi.
  `alamat` perangkat disimpan sebagai IP publik karena `/etc/hosts`
  memetakan `ivvinet.my.id` ke `127.0.0.1`.
- API OLT `203.0.113.11:90` tidak terjangkau dari server (EHOSTUNREACH),
  `setting_olt.status` dipasang `inaktif` agar scheduler tidak mengulang gagal.

**Catatan cron**

- Cron panel yang ada: `poll_mikrotik_local.php` (menit), `cronjob_tagihan.php`
  (jam :10) milik gratisinaja, dan renewal SSL. ivvibill tetap mode scheduler
  in-process (Mode A) — tidak ditambah cron eksternal, jadi tidak ada tugas
  ivvibill yang berjalan dobel.

## 2026-10-05 — v1.0.2 — perbaikan antrean WhatsApp

**Bug fixed**

- `src/services/wa.js` mengirim `wa_gateway_key` **apa adanya dari database**,
  padahal `PUT /api/gateway` menyimpannya terenkripsi AES-256-GCM. Akibatnya
  semua pesan WA ditolak gateway (`apiKey` salah) dan antrean menumpuk status
  `gagal`. Sekarang kunci didekripsi lewat `util/crypto.js` sebelum dikirim,
  sama seperti perangkat (`monitoring.js`) dan Midtrans/Flip (`webhook.js`).

**Verifikasi (2026-10-05)**

- Gateway dummy lokal `http://127.0.0.1:3999/sendMessage`: payload yang diterima
  `apiKey=KUNCI-UJI-123` (plaintext, bukan ciphertext `v1.`), `phone=6281234567890`
  (dinormalisasi dari `0812...`), `status=terkirim`, `wa_log` tercatat OK.
  Konfigurasi gateway dan baris uji dibersihkan kembali setelah tes.

## 2026-10-05 — v1.0.1 — perbaikan rilis awal

**Bug fixed**

- `GET /api/sistem` error 500 `Unknown column 'sent_at'` — tabel `wa_log`
  memakai `created_at`, bukan `sent_at`. Query diperbaiki di
  `src/routes/lain.js`.
- Unduhan APK (`/apk/*.apk`) tidak disajikan sehingga jatuh ke handler 404
  → 500. Ditambahkan `express.static` untuk `/apk` di `server.js`.
- `public/404.html` tidak ada → setiap URL tak dikenal memicu
  `ENOENT ... 404.html` (500). Dibuat `public/404.html` **dan** handler 404
  kini punya fallback inline HTML bila berkas hilang.
- `scripts/cron.js` dirujuk komentar `scheduler.js` tetapi belum pernah
  dibuat. Sekarang tersedia, plus `npm run cron`.

**Ditambahkan**

- `scripts/init-secret.js` + `npm run init-secret` — `config.js` sudah
  menyarankan perintah ini, tetapi script-nya belum ada.
- `docs/DEPLOY.md` — 4 jalur pemasangan (VPS+systemd+nginx, aaPanel, PaaS,
  shared hosting) + checklist verifikasi + troubleshooting + upgrade.
- `docs/CRON.md` — 2 mode penjadwalan (in-process vs cron eksternal),
  tabel tugas, template pesan WA, troubleshooting.
- `docs/SECURITY.md` — model ancaman, RBAC, hasil uji guard endpoint,
  checklist hardening, dan batasan yang diketahui.
- Reverse proxy nginx `extension/<domain>/proxy-ivvibill.conf`
  (`location ^~ /` → `127.0.0.1:3010`) sehingga aset `.js`/`.css` tidak
  tertangkap regex location vhost dan jatuh 404.

**Hasil verifikasi (2026-10-05)**

- 21/21 tes API end-to-end lolos lewat nginx (login, dashboard, tagihan,
  pembayaran, gateway, monitoring, OLT, agen, tiket, pengaturan, sistem).
- 4 aplikasi + landing + 4 APK tersaji 200.
- Guard diuji: tanpa token 401, IP luar ke `/internal/cron` 403,
  `X-Forwarded-For` palsu 403, webhook tanpa konfigurasi 400.

---

## 2026-10-05 — v1.0.0 — rilis awal

Pembuatan awal: backend Express (auth/RBAC, pelanggan PPPoE, paket,
tagihan, pembayaran manual + Midtrans/Flip, hotspot/voucher, agen,
monitoring router non-PPPoE, driver OLT WebFig 7 brand), 4 frontend web
(panel/agen/teknisi/pelanggan) + landing, 4 APK WebView wrapper,
scheduler in-process (billing, WA, router, OLT, issue), skema 27 tabel,
deploy systemd + nginx.
