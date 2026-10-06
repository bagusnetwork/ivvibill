# PATCHES — catatan perubahan ivvibill

Format: **[TANGGAL] v<versi> — <jenis>**. Tambahkan entri baru di atas.

---

## 2026-10-06 — v1.1.2 — penampil QR pairing WhatsApp gateway di panel

**Masalah**

Pengaturan → *Gateway* hanya punya kolom URL + API key. Untuk menautkan nomor WhatsApp
pemilik ISP harus membuka dashboard WHAPI sendiri, yang berarti hafal URL dashboard,
login memakai kredensial gateway, dan tidak jelas device mana yang sedang dipasangkan.
Panel juga tidak pernah menampilkan *state* device, sehingga pesan "tagihan tidak terkirim"
selalu berujung tebak-tebakan.

**Diubah**

- `src/services/wa.js` — dua fungsi baru di atas helper `metodeGateway()` yang sudah
  memakai API publik WHAPI (`GET {wa_gateway_url}/getState|getQR|serviceStart?apiKey=…`):
  * `pairing(server)` → `{ state, qr, pesan }`; QR (data URL) hanya diambil saat
    `state === 'SERVICE_SCAN'`, karena di luar state itu `getQR` selalu kosong.
  * `mulaiPairing(server)` → memanggil `serviceStart` lalu **baca ulang lewat `pairing()`**,
    sebab respons `serviceStart` tidak selalu membawa `state`. Kalau pembacaan ulang gagal,
    jawaban `serviceStart` yang dipakai — tombol tidak gagal hanya karena gateway lambat.
- `src/routes/tagihan.js` — `GET /api/gateway/wa/pairing` (baca status) dan
  `POST /api/gateway/wa/start` (jalankan service, dijaga `requireMenu('setting','gateway')`
  dan dicatat ke `audit_log` sebagai `wa_pairing_start`). Keduanya proxy: **API key tidak
  pernah turun ke browser**, dan `wa_gateway_key` tetap tersimpan terenkripsi AES.
- Panel (`index.html` + `panel.js` pada view *setting*): baris `#waPair` menampilkan status
  gateway dengan label berbahasa Indonesia (`terhubung` / `menunggu pairing` /
  `QR siap dipindai` / `service mati`), `#waQr` menampilkan QR, dan ada tombol
  **Mulai pairing** saat `SERVICE_OFF`. Status di-poll tiap 5 detik dan timer berhenti
  begitu halaman *setting* ditinggalkan.
- QR dibuka lewat `<img src>` hanya bila datanya `data:`/`blob:`/`/` — format lain
  dirender sebagai tautan, karena CSP `img-src 'self' data: blob:` akan menolak host lain
  dan yang hilang adalah gambarnya, bukan pesannya.
- Placeholder kolom URL kini `http://127.0.0.1:3000/api`. Kurang `/api` adalah penyebab
  paling umum QR tidak muncul, dan `metodeGateway()` kini menjawab dengan kalimat itu
  alih-alih `JSON.parse` error.

**Verifikasi (staging, `mt/reset_staging.sh` → `mt/uji_staging.sh` → `mt/uji_lanjutan.sh`)**

- 35/35 dan 19/19 lulus; `mt/uji_lanjutan.sh` bagian 6 mengunci dua rute baru ini tetap
  401 tanpa sesi dan menolak dengan "API key WhatsApp gateway belum disimpan" di DB segar.
- curl terhadap WHAPI asli: `SERVICE_OFF` + pesan "you haven't started the WhatsApp service",
  setelah tekan *Mulai pairing* → `PAIRING`, dan URL tanpa `/api` → HTTP 404 bukan JSON.
- Browser: `#waPair` hidup di `http://127.0.0.1:3011/panel/#setting`, QR tetap tersembunyi
  selama state belum `SERVICE_SCAN`.

**Catatan**

QR hanya muncul bila `serviceStart` berhasil lolos pemeriksaan lisensi ke
`whapi-server.my.id`. Pada server ini rute ke host tersebut sering `EHOSTUNREACH`, sehingga
device berhenti di `PAIRING` lalu timeout — itu kendala jaringan gateway, bukan panel.

## 2026-10-06 — v1.1.1 — grant grup akses benar-benar menyembunyikan tab aplikasi role

**Diubah**

- Sidebar aplikasi **teknisi** (7 tab), **agen** (5 tab) dan **pelanggan** (4 tab) kini
  membawa atribut `data-menu` seperti panel, sehingga `terapkanAksesMenu()` punya sesuatu
  untuk disembunyikan: tab dipetaikan ke kunci grant yang sama dengan `requireMenu()` di
  server — teknisi: `dashboard`, `pelanggan`, `interface`, `olt`, `issue`; agen: `dashboard`,
  `beli`+`voucher` → `voucher`, `pelanggan`; pelanggan: `dashboard`, `tagihan`.
- Tab yang tidak punya padanan kunci grant dibiarkan selalu terlihat, karena memakainya
  akan membuat pekerjaan inti hilang tanpa bisa dikonfigurasi lewat grup akses:
  *Order Pekerjaan*, *Tiket Gangguan*, *Status Koneksi*, *Riwayat Mutasi*.
- `public/assets/app.js` dapat helper `halamanAwal()`: kalau hash/tab tujuan disembunyikan
  grant, aplikasi dibuka pada tab pertama yang boleh. Tanpa ini user bergroup sempit
  mendarat di `#dashboard` yang tabnya tidak tampil, dan datanya tetap termuat.

**Verifikasi (staging, `mt/reset_staging.sh` → `mt/uji_staging.sh` → `mt/uji_lanjutan.sh`)**

- 35/35 dan 16/16 lulus — tidak ada regresi API/scope.
- Browser: `bispel` (teknisi, grup hanya *Pelanggan*) melihat **3 dari 7** tab
  (`pekerjaan`, `tiket`, `pelanggan`) dan langsung mendarat di `#pekerjaan`;
  `adminisp2` (agen, grup hanya *Pelanggan*) melihat **2 dari 5** tab
  (`mutasi`, `pelanggan`) dan mendarat di `#mutasi`;
  `ujiwaing` (teknisi, grup `menu:"all"`) tetap melihat **7/7** dan mendarat di `#dashboard`.
- Panel tidak berubah perilakunya: hanya superadmin/master yang bisa masuk, dan bagi
  keduanya `bolehMenu()` memang selalu benar — kecuali *Data Server* yang untuk master
  sudah disembunyikan sejak v1.1.0 (teruji: master melihat 15 dari 16 anchor).
- `mt/uji_produksi.sh` menambahkan bagian 2b: jumlah anchor berkunci grant per aplikasi
  role + kehadiran `halamanAwal()`, supaya hook ini tidak hilang diam-diam saat upgrade.

**Catatan keamanan**

Sembunyi tab ini kosmetik. Penahan sesungguhnya tetap di server, dan sampai versi ini
`requireMenu()` hanya dipasang di rute tulis (26 titik, nol di GET): user terautentikasi di
sebuah tenant masih bisa membaca data tenant itu lewat API walau menunya tidak diberikan.
Itu disengaja supaya aplikasi teknisi/agen/pelanggan tidak kehilangan data induknya.

## 2026-10-06 — v1.1.0 — multi-ISP penuh (satu data_server = satu ISP)

**Ditambahkan**

- Akun master ISP ikut disimpan di `data_server` (username + `password_hash`
  bcrypt, `prefix_invoice`, `expaired_date`) — persis model gratisinaja, jadi
  tiap ISP punya login sendiri tanpa menaruh baris di `app_user`.
- Isolasi tenant di seluruh API (pelanggan, tagihan, pembayaran, paket,
  voucher, agen, monitoring, perangkat, pengguna, WhatsApp, pengaturan):
  klausa `id_data_server` diambil dari klaim tenant di JWT; tabel anak
  (pembayaran, agen_mutasi, redaman_log, issue_pelanggan, wa_log, dst.)
  di-scope lewat JOIN ke induknya.
- CRUD `data_server` (khusus pemilik platform) dan `group_akses` per tenant
  dengan grant menu/submenu; pengguna bawahan mengikat daftar data server
  (`app_user.id_data_server` CSV) + satu grup akses.
- Panel: picker tenant di topbar, menu **Data Server** dan **Group Akses**,
  kolom *Data server* + *Group akses* pada daftar Pengguna, menu sidebar
  otomatis sembunyi sesuai grant.
- Scheduler, antrean WhatsApp, dan webhook berjalan per tenant; kredensial
  gateway WA satu ISP tidak pernah dipakai untuk antrean ISP lain.

**Bug fixed**

- `tagihan.kode_unik` bertipe `TINYINT` sementara kodenya 100..999 →
  `Out of range value` dan pembuatan tagihan bulanan tidak pernah berhasil
  pada instalasi baru. Skema diubah ke `SMALLINT` + migrasi pelebaran kolom.
- `daftarServerUser()` memakai `IN (?)` dengan parameter array; karena
  `pool.execute` memakai prepared statement, array tidak pernah mengembang →
  placeholder dibuat satu per id.
- `tentukanTenantUser()` dan `tentukanGrupTenant()` membaca
  `req.user.tenantSemua`, padahal middleware auth mengisi `req.tenantSemua`.
  Akibatnya superadmin platform membuat grup/pengguna diam-diam di tenant 1
  dan tidak bisa membuatkannya untuk ISP lain.
- `requireLogin(roles)` melakukan `location.href = '/panel/'` saat role tidak
  cocok. teknisi/agen yang membuka /panel/ jadi reload tanpa henti (gejala
  "login berkedip" yang sama dengan v1.0.6). Sekarang diarahkan ke aplikasi
  rumahnya dan tidak dinavigasi bila sedang berada di halaman itu.
- helmet CSP mengirim `script-src-attr 'none'` sehingga seluruh atribut
  `onclick` panel mati; di-override `'unsafe-inline'`, dan 8 pemanggilan
  `onclick='fn(${JSON.stringify(row)})'` ditulis ulang memakai `esc()` supaya
  nilai berkutip (mis. `O'Brien`) tidak memec keluar atribut.
- Dropdown grup akses di form Pengguna kini disaring menurut kolom data
  server, bukan menampilkan grup dari semua tenant.

**Verifikasi (staging, 2026-10-06)**

- Stack staging terisolasi milik pengembang: mysqld 8.0.45 pada port 3307 +
  aplikasi pada port 3011 dengan `DISABLE_SCHEDULER=1` (tidak mengirim WA,
  tidak memanggil router/OLT). Data produksi tidak tersentuh.
- `mt/uji_staging.sh` — 35/35 lolos: login superadmin dan master ISP, CRUD
  data_server, tolak pindah tenant paksa (403), lintas tenant pada pelanggan
  → 404 (baca/ubah/hapus), daftar tenant hanya berisi baris miliknya, grup
  akses tanpa menu → 403 sedangkan grup bermenu → 200, grup/pengguna untuk
  tenant lain dibuat benar oleh platform owner, hapus tenant berisi → 400.
- `mt/uji_scheduler.js` — tugas billing scheduler membuat tagihan untuk kedua
  tenant sekaligus dengan prefix masing-masing (IVV dan ISP2), dan baris
  `wa_queue` terikat `id_data_server`.
- Uji browser (keempat aplikasi, sesi cookie asli): panel superadmin — picker
  berisi semua tenant, CRUD Data Server lewat tombol (tambah tenant "ISP Tiga
  UI" → langsung terisolasi penuh → hapus), opsi grup pada form Pengguna
  terfilter sesuai isi kolom tenant; master ISP2 — picker disembunyikan, menu
  Data Server tidak tampil, daftar pelanggan hanya 3 baris miliknya, baca
  tenant lain 404, daftar data_server 403; teknisi bergrup tagihan-saja —
  `pengguna`/`data-server` 403; agen — hanya 3 pelanggan yang benar-benar
  miliknya; aplikasi warga — hanya tagihan sendiri (prefix ISP2), akun warga
  lain 403, tenant lain 404, tidak bisa mengubah datanya sendiri. Tidak ada
  error console selain 4xx hasil probe.
- Perilaku yang disengaja (bukan bug): grant menu menahan **tulis**
  (POST/PUT/DELETE) tetapi baca tetap terbuka bagi user terautentikasi di
  tenant yang sama, supaya aplikasi teknisi/agen/warga tidak kehilangan data
  induknya; dan superadmin pemilik platform (`tenantSemua`) tidak difilter per
  tenant — picker tenant hanya menentukan tenant tujuan untuk data baru.

## 2026-10-05 — v1.0.7 — semua halaman panel berhenti di "Memuat…"

**Bug fixed**

- Keempat aplikasi menandai kontennya dengan atribut `data.onload="loadX"`
  (titik), sedangkan `go()` di `assets/app.js` membaca `v.dataset.onload` yang
  berasal dari atribut `data-onload` (strip). Karena `data.onload` bukan
  atribut `data-*`, `dataset.onload` selalu `undefined` sehingga fungsi loader
  **tidak pernah dipanggil** — tanpa error, tanpa toast. Efeknya semua halaman
  panel (dashboard, pelanggan, tagihan, monitoring, perangkat, WhatsApp,
  pengaturan, dst.) diam di placeholder "Memuat…".
- 30 atribut di `public/{panel,agen,pelanggan,teknisi}/index.html` diganti
  menjadi `data-onload=`.

**Verifikasi (2026-10-05)**

- Login `superadmin` lewat browser, lalu `go()` ke-14 halaman panel: semuanya
  mengisi data, tidak ada lagi teks "Memuat" (dashboard: 0 pelanggan aktif,
  pemasukan Rp 150.000, 10 voucher; paket/voucher/agen/perangkat/pengguna/wa/
  setting terisi hasil import IVVINET).
- Monitoring Interface menampilkan trafik nyata dari CCR1009 (vlan117
  34.858,6 Kbps RX / 32.023,8 Kbps TX) — bukti parser RouterOS + monitorRate
  bekerja sampai UI.
- Console browser bersih dari error JS; hanya peringatan COOP/OAC karena origin
  masih HTTP (hilang setelah sertifikat TLS terpasang).


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
