# ivvibill

**Sistem billing ISP terpadu** — PPPoE & Hotspot, agen voucher, payment
gateway + bayar manual, monitoring interface router (non-PPPoE), dan
monitoring redaman OLT via WebFig.

Satu proses Node.js melayani **REST API**, **4 aplikasi web**, **webhook
gateway**, dan **scheduler cron internal**. Basis data terpusat di Panel
Data Server (superadmin).

```
ivvibill/
├── server.js              # entry: Express + static + cron endpoint
├── src/
│   ├── config.js          # konfigurasi env (aman, tanpa secret di kode)
│   ├── db.js              # pool mysql2 + helper q/one/insert/run/tx
│   ├── scheduler.js       # cron in-process (wa, router, olt, billing, issue)
│   ├── middleware/auth.js # JWT + RBAC + guard internal
│   ├── routes/            # auth, pelanggan, tagihan, agen, monitoring, lain, webhook
│   ├── services/
│   │   ├── billing.js     # tagihan, pelunasan, isolir, peringatan
│   │   ├── wa.js          # antrean WhatsApp gateway
│   │   ├── monitoring.js  # polling router + deteksi issue PPPoE
│   │   ├── routeros.js    # klien RouterOS API
│   │   ├── configData.js  # cache data_server + nomor invoice
│   │   └── olt/           # driver WebFig HSGQ/VSOL/Hisfocus/Hioso/CData/ZTE/Huawei
│   └── util/              # crypto (enkripsi rahasia), http, validate
├── scripts/
│   ├── migrate.js         # idempoten, baca sql/schema.sql
│   ├── seed-admin.js      # buat akun superadmin
│   ├── init-secret.js     # buat kunci enkripsi .secret
│   └── cron.js            # pemicu cron eksternal (shared hosting)
├── sql/schema.sql         # 27 tabel, idempoten
├── public/
│   ├── index.html         # landing + tautan unduhan APK
│   ├── panel/             # 1. Panel Data Server (superadmin)
│   ├── agen/              # 2. Agen Hotspot
│   ├── teknisi/           # 3. Karyawan & Teknisi
│   ├── pelanggan/         # 4. Dashboard Pelanggan PPPoE
│   ├── assets/            # CSS/JS/logo bersama
│   └── apk/               # 4 APK Android siap install
├── android/build-apk.sh   # build APK WebView wrapper (tanpa Gradle)
├── docs/                  # DEPLOY, CRON, SECURITY, PATCHES
└── storage/uploads/       # bukti pembayaran (di luar jalur web langsung)
```

## Empat aplikasi

| Akses | Aplikasi | Peran | Tugas utama |
|---|---|---|---|
| `/panel` | **Panel Data Server** | superadmin | pelanggan, tagihan, pembayaran, gateway, paket, voucher, agen, monitoring, pengguna, pengaturan |
| `/agen` | **Agen Hotspot** | agen | saldo, beli/jual voucher, mutasi, pelanggan binaan |
| `/teknisi` | **Karyawan & Teknisi** | teknisi | order pekerjaan, tiket, interface router, redaman OLT, issue PPPoE |
| `/pelanggan` | **Dashboard Pelanggan** | pelanggan | tagihan & bayar, status koneksi, tiket gangguan |

Masing-masing juga tersedia sebagai APK di `/apk/` (mis. `/apk/IvviPanel.apk`).

## Mulai cepat (VPS)

```bash
mysql -uroot -p -e "CREATE DATABASE ivvibill CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;"

cp .env.example .env        # lalu isi DB_*, JWT_SECRET, BASE_URL
npm install
npm run init-secret         # membuat .secret (kunci enkripsi)
npm run migrate             # membuat 27 tabel
npm run seed-admin          # akun superadmin (password dicetak sekali)
npm start
```

Buka `http://localhost:3010/panel` lalu login.

Panduan lengkap (nginx/OpenLiteSpeed, systemd/pm2, SSL, shared hosting):
**[docs/DEPLOY.md](docs/DEPLOY.md)**

## Perintah

| Perintah | Fungsi |
|---|---|
| `npm start` | jalankan server |
| `npm run dev` | jalankan dengan `--watch` |
| `npm run migrate` | migrasi skema (idempoten) |
| `npm run seed-admin` | buat/atur ulang superadmin |
| `npm run init-secret` | buat kunci enkripsi `.secret` |
| `npm run cron -- billing` | tugas cron eksternal (`billing`, `wa`, `router`, `olt`, `issue`, `semwa`) |

## Konfigurasi `.env`

| Variabel | Wajib | Keterangan |
|---|---|---|
| `PORT`, `BIND` | ✓ | default `3010`, `127.0.0.1` (jangan publik langsung) |
| `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASS`, `DB_NAME` | ✓ | koneksi MySQL |
| `JWT_SECRET` | ✓ | tanda tangan token (beda dari `.secret`) |
| `BASE_URL` | ✓ | URL publik, dipakai tautan tagihan/WA/APK |
| `TRUST_PROXY` | ✓ | `1` bila di belakang nginx/proxy |
| `TRUSTED_IPS` | | IP yang boleh memanggil `/internal/cron/*` |
| `BCRYPT_ROUNDS` | | default `10` |
| `CRON_TOKEN` | | token alternatif guard cron (fallback ke `JWT_SECRET`) |
| `APP_SECRET_FILE` | | lokasi kunci enkripsi di luar web root |
| `DISABLE_SCHEDULER` | | `1` untuk mematikan scheduler in-process |
| `WEBHOOK_IPS` | | IP tambahan yang boleh kirim webhook gateway |
| `ISSUE_INTERVAL_MIN` | | interval deteksi issue (default 10 menit) |

## Keamanan

- JWT + HttpOnly cookie, RBAC 4 peran (`superadmin`, `teknisi`, `agen`, `pelanggan`)
- bcrypt (rounds dari env), pembatasan percobaan login + penguncian akun
- Helmet CSP, rate-limit API, validasi input terpusat
- Rahasia gateway/perangkat dienkripsi (AES) — kunci di `.secret`, bukan di DB
- Webhook gateway diverifikasi **signature** (Midtrans SHA-512, Flip SHA-256)
- Endpoint cron dijaga IP whitelist + token
- Upload bukti bayar: gambar saja, maks 3 MB, nama acak, di luar jalur eksekusi

Rincian: **[docs/SECURITY.md](docs/SECURITY.md)**

## Monitoring

- **Interface router** — polling RouterOS API, interface PPPoE **tidak** ditampilkan/dipoll
- **Redaman OLT** — WebFig, dukungan HSGQ, VSOL, Hisfocus, Hioso, CData, ZTE, Huawei
  (`GET /api/olt/brands` untuk daftar brand)
- **Issue pelanggan PPPoE** — offline & isolir, masuk antrian WhatsApp

## License

Proprietary — untuk penggunaan ISP sendiri.
