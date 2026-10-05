# SECURITY — model ancaman & pengamanan ivvibill

Dokumen ini menjelaskan **apa yang sudah dijaga** dan **apa yang harus
Anda lakukan** saat memasang di produksi.

---

## 1. Peran & kontrol akses (RBAC)

| Peran | Akses | Dijaga oleh |
|---|---|---|
| `superadmin` | semua (panel, pengguna, gateway, pengaturan, audit) | `requireRole('superadmin')` |
| `teknisi` | pelanggan (baca/tulis terbatas), tiket, pekerjaan, interface, OLT, issue | `requireRole('superadmin','teknisi')` |
| `agen` | pelanggan binaan, voucher, mutasi sendiri | `requireRole('superadmin','agen')` + klausa `p.id_agen = ?` |
| `pelanggan` | tagihan & profilnya sendiri saja | klausa `t.id_pelanggan = ?` / `id_ref` |

Pembatasan cakupan (scope) dilakukan di **query** (`scopeTagihan`,
`scopeClause`), bukan hanya di UI — jadi menu disembunyikan pun API tetap
menolak.

Setiap rute diawali `router.use(requireAuth)`; rute sensitif menambahkan
`requireRole(...)`. Uji dasar: tanpa token → **401**, dengan token role
lain → **403**.

---

## 2. Autentikasi

- **JWT** (`HS256`, `issuer: ivvibill`, TTL 12 jam) — dikirim via
  `Authorization: Bearer` **dan** cookie `ivvi_token`
  (`HttpOnly`, `SameSite=Lax`, `Secure` bila `BASE_URL` = `https://`).
- **bcrypt** dengan `BCRYPT_ROUNDS` (default 10; 12 disarankan).
- Percobaan login dibatasi (`login_attempt`, `MAX_LOGIN_FAIL` default 5,
  kunci akun `LOCK_MINUTES` default 15) + rate-limit khusus rute login.
- Token JWT **bukan** kunci enkripsi; kunci enkripsi terpisah di `.secret`.

**Yang harus Anda lakukan:** ganti `JWT_SECRET` di setiap instalasi
(`node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"`),
dan jangan pakai nilai yang sama untuk `.secret`.

---

## 3. Kerahasiaan data (enkripsi at-rest)

Rahasia yang disimpan di DB (API key gateway, kunci perangkat/router/OLT,
API key WA) **dienskripsi AES** sebelum masuk kolom, dan didekripsi hanya
saat dipakai. Kunci dibaca dari, dengan urutan:

```
APP_SECRET_FILE → /etc/ivvibill/secret.key → <root>/.secret → APP_SECRET
```

`.secret` ditulis dengan mode `600`.

**Wajib di produksi:** pindahkan ke luar web root:

```bash
npm run init-secret -- /etc/ivvibill/secret.key
# di .env:
APP_SECRET_FILE=/etc/ivvibill/secret.key
```

> Kehilangan `.secret` = data terenkripsi di DB tidak bisa dibuka lagi
> (key gateway harus diisi ulang). Backup-kan terpisah dan aman.

Endpoint `GET /api/gateway` hanya mengembalikan `****` untuk nilai rahasia.

---

## 4. Endpoints tanpa login

| Endpoint | Pengaman |
|---|---|
| `GET /api/health` | hanya status DB + versi, tanpa data |
| `POST /api/webhook/midtrans` | verifikasi `signature_key` = SHA-512(order+status+gross+serverKey); IP harus di `TRUSTED_IPS`/`WEBHOOK_IPS` |
| `POST /api/webhook/flip` | verifikasi `signature` = SHA-256(id+secret); cek IP sama |
| `POST /internal/cron/:tugas` | `requireInternal`: IP whitelist **atau** `x-internal-token` = `CRON_TOKEN` (fallback `JWT_SECRET`) |

### Sudah diuji

| Skenario | Hasil |
|---|---|
| Loopback (127.0.0.1) → `/internal/cron/billing` | **200** (memang dipercaya) |
| IP LAN (192.168.1.96) → `/internal/cron/billing` | **403** |
| IP LAN + `X-Forwarded-For: 127.0.0.1` (palsu) | **403** |
| IP LAN + `X-Forwarded-For: 8.8.8.8` (palsu) | **403** |
| Webhook tanpa konfigurasi gateway | **400** `not configured` |
| Webhook dengan signature salah | **403** `signature invalid` |
| API tanpa token | **401** |

`TRUST_PROXY=1` membuat `req.ip` diambil dari rantai `X-Forwarded-For`
yang benar (nilai terakhir yang benar-benar dikirim proxy), sehingga
**pemalsuan `X-Forwarded-For` tidak menembus** guard.

**Catatan operasional:** karena nginx berada di loopback, semua permintaan
yang melewatinya terlihat berasal dari `127.0.0.1` **hanya bila klien juga
loopback**. Klien eksternal membawa IP aslinya dan ditolak. Untuk cron
eksternal lewat HTTP dari luar, **wajib** pakai `CRON_TOKEN` — jangan
mengandalkan IP.

---

## 5. HTTP layer (Helmet CSP)

```
default-src 'self'
script-src 'self'                 ← tanpa inline script, tanpa CDN
style-src 'self' 'unsafe-inline'  ← inline style diperlukan oleh UI
img-src 'self' data: blob:
connect-src 'self'
object-src 'none'
frame-ancestors 'none'            ← anti clickjacking
X-Content-Type-Options: nosniff, HSTS (otomatis Helmet)
```

`x-powered-by` dimatikan. Port Node hanya `127.0.0.1:3010` — **tidak
pernah** dibuka langsung ke internet; selalu lewat nginx.

---

## 6. Rate limiting & brute force

- Semua `/api/` : **240 request/menit/IP** (`express-rate-limit`,
  header `RateLimit` standar).
- Rute login: limiter khusus (lebih ketat) + hitungan `login_attempt`
  + penguncian akun.

---

## 7. Validasi input

`src/util/validate.js` menyediakan `str/num/enumOf/phone/email/tgl/
username/password` dengan batas panjang, enumerasi, dan nilai baku —
dipakai di seluruh rute (bukan `req.body` mentah).

Query DB selalu **parameterized** (`?`), tidak ada string SQL yang
disusun dari input pengguna selain `IN`/kolom yang sudah dilewatkan
`enumOf`.

---

## 8. Upload bukti pembayaran

| Kontrol | Nilai |
|---|---|
| Tipe | hanya `image/png`, `image/jpeg`, `image/webp` |
| Ukuran | maks **3 MB** |
| Nama berkas | timestamp + acak + sanitasi (`[^A-Za-z0-9._-]` → `_`) |
| Lokasi | `storage/uploads/` — **di luar** `public/`, disajikan hanya via `GET /uploads` (tanpa index, `dotfiles: deny`) |
| Akses | lewat nginx → Node, tanpa eksekusi |

`.env` dan `.secret` tidak termasuk jalur statis apa pun.

---

## 9. Webhook gateway

Pemeriksaan berurutan: **IP whitelist → konfigurasi ada → signature cocok**
→ baru proses. Pembayaran lunas hanya bila
`transaction_status ∈ {settlement, capture}` (Midtrans) atau
`status = completed` (Flip). Jumlah yang dicocokkan diambil dari payload
yang sudah ditandatangani, bukan dari `tagihan.total`.

Order ID berformat `IVV-<id_tagihan>-<timestamp>` sehingga payload palsu
yang lolos signature sekalipun tetap harus berasal dari gateway.

---

## 10. Audit & kelangsungan

- `audit_log` mencatat aksi penting: `batal_tagihan`, `bayar_manual`,
  `verifikasi_terima/tolak`, `ubah_gateway`, `tambah_pengguna` — lengkap
  dengan `user_id` dan IP.
- Lihat: `GET /api/audit` (superadmin).
- Scheduler punya penjaga anti-tumpang-tindih (`running` flag) sehingga
  tugas tidak dieksekusi dua kali bersamaan.

---

## 11. Checklist hardening produksi

- [ ] `JWT_SECRET` diganti, nilai acak panjang
- [ ] `.secret` dipindah ke `/etc/ivvibill/secret.key` + `APP_SECRET_FILE`
- [ ] `.env` mode `600`, tidak masuk Git (cek `.gitignore`)
- [ ] Password `superadmin` diganti dari hasil `seed-admin`
- [ ] MySQL user hanya `ALL ON ivvibill.*` (tanpa `WITH GRANT OPTION`)
- [ ] HTTPS aktif, `BASE_URL=https://...`, lalu restart service
- [ ] Firewall: hanya 22/80/443; port 3010 tertutup
- [ ] `TRUSTED_IPS` tidak berisi `0.0.0.0/0`
- [ ] `CRON_TOKEN` diisi (bila memakai cron HTTP luar) dan dirahasiakan
- [ ] Backup teratur: database + `.secret` + `storage/uploads/`
- [ ] `systemctl enable ivvibill` (restart otomatis bila crash)
- [ ] Log dipantau: `journalctl -u ivvibill -f`

---

## 12. Batasan yang diketahui

Dokumen ini jujur soal batasannya:

1. **Belum ada TLS di server ini** — lihat catatan di
   [PATCHES.md](PATCHES.md). Selama `BASE_URL` masih `http://`, cookie
   `secure` tidak aktif. Segera pasang Let's Encrypt.
2. **Tidak ada 2FA/MFA** — JWT 12 jam tanpa rotasi refresh token.
3. **Backup tidak otomatis** — belum ada skrip backup bawaan; gunakan
   `mysqldump` terjadwal.
4. **Tidak ada verifikasi email** — pemulihan akun lewat superadmin.
5. **Rate-limit memakai memori** — reset saat proses restart; untuk
   multi-instance gunakan store bersama (Redis).

Laporkan kerentanan bila menemukannya; jangan publikasikan sebelum
diperbaiki.
