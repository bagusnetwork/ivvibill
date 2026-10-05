# DEPLOY — pemasangan ivvibill universal (VPS / Hosting / Panel)

Panduan ini memasang ivvibill di **mesin baru mana pun**. Empat jalur
disediakan, pilih sesuai hosting Anda:

| Jalur | Cocok untuk | Bagian |
|---|---|---|
| **A. VPS + systemd + nginx** | VPS/bare server (direkomendasikan) | [A](#a-vps--systemd--nginx-direkomendasikan) |
| **B. aaPanel / panel web** | server dengan aaPanel/cPanel | [B](#b-aapanel--panel-web) |
| **C. PaaS (Railway/Render/Fly)** | tanpa akses shell/cron | [C](#c-paas-railway--render--fly) |
| **D. Shared hosting biasa** | PHP-only panel, Node via CGI | [D](#d-shared-hosting-biasa) |

Semua jalur memakai langkah dasar yang sama (bagian **0**).

---

## 0. Langkah dasar (wajib semua jalur)

### 0.1 Prasyarat

```bash
node -v      # >= 18 (diuji pada 22)
mysql -V     # >= 8 (juga jalan di MariaDB 10.6+)
```

### 0.2 Salin berkas

```bash
# dari Git
git clone <url-repo> /var/www/ivvibill && cd /var/www/ivvibill

# atau unggah manual, lalu
cd /var/www/ivvibill && npm ci        # atau npm install
```

### 0.3 Buat database

```bash
mysql -uroot -p <<'SQL'
CREATE DATABASE ivvibill CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER 'ivvibill_app'@'localhost' IDENTIFIED BY 'GANTI_PASSWORD_KUAT';
GRANT ALL PRIVILEGES ON ivvibill.* TO 'ivvibill_app'@'localhost';
FLUSH PRIVILEGES;
SQL
```

### 0.4 Buat `.env`

```bash
cat > .env <<'ENV'
NODE_ENV=production
PORT=3010
BIND=127.0.0.1

DB_HOST=127.0.0.1
DB_PORT=3306
DB_USER=ivvibill_app
DB_PASS=GANTI_PASSWORD_KUAT
DB_NAME=ivvibill

JWT_SECRET=GANTI_DENGAN_ACAK_PANJANG
TRUSTED_IPS=127.0.0.1,::1
BASE_URL=https://domain-anda.com
TRUST_PROXY=1
BCRYPT_ROUNDS=12
ENV
chmod 600 .env
```

Buat nilai acak:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
```

### 0.5 Kunci enkripsi, migrasi, akun admin

```bash
npm run init-secret     # membuat .secret (mode 600) — JANGAN di-commit
npm run migrate         # 27 tabel, idempoten (aman dijalankan berulang)
npm run seed-admin      # password superadmin dicetak SEKALI — simpan
```

> Kunci enkripsi dibaca dari, dengan urutan:
> `APP_SECRET_FILE` → `/etc/ivvibill/secret.key` → `<root>/.secret` → `APP_SECRET`.
> Di produksi sebaiknya pindahkan ke luar web root:
> `npm run init-secret -- /etc/ivvibill/secret.key` lalu set `APP_SECRET_FILE`.

### 0.6 Uji lokal

```bash
npm start &
sleep 3
curl -s localhost:3010/api/health
# {"ok":true,"app":"ivvibill","version":"1.0.0"}
```

---

## A. VPS + systemd + nginx (direkomendasikan)

### A.1 Jalankan server dengan systemd

```bash
cat > /etc/systemd/system/ivvibill.service <<'UNIT'
[Unit]
Description=ivvibill - Billing PPPoE & Hotspot (Node.js)
After=network-online.target mysql.service mysqld.service
Wants=network-online.target

[Service]
Type=simple
User=www-data
WorkingDirectory=/var/www/ivvibill
ExecStart=/usr/bin/node server.js
Restart=always
RestartSec=5
Environment=NODE_ENV=production
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full
ReadWritePaths=/var/www/ivvibill
StandardOutput=append:/var/log/ivvibill.log
StandardError=append:/var/log/ivvibill.log

[Install]
WantedBy=multi-user.target
UNIT

# bila memakai port <1024 atau path milik root, ganti User=root
chown -R www-data:www-data /var/www/ivvibill
systemctl daemon-reload
systemctl enable --now ivvibill
systemctl status ivvibill
```

> **Catatan aaPanel:** unit yang terpasang di server ini memakai
> `User=root` + `StandardOutput=append:/www/wwwlogs/ivvibill.log` karena
> direktori situs dimiliki root. Sesuaikan dengan pemilik berkas Anda.

Alternatif tanpa systemd:

```bash
npm install -g pm2
pm2 start server.js --name ivvibill
pm2 save && pm2 startup
```

### A.2 Reverse proxy nginx

Taruh di `conf.d` atau di dalam `server { }` situs Anda:

```nginx
server {
    listen 80;
    server_name domain-anda.com;
    root /var/www/ivvibill/public;

    # ACME challenge tetap dilayani dari disk
    location ^~ /.well-known/ { allow all; }

    # ^~ membatalkan regex location lain (mis. ~ .*\.(js|css)$
    # yang menyajikan file dari disk dan membuat 404 pada aset Node)
    location ^~ / {
        proxy_pass http://127.0.0.1:3010;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-Host $host;
        proxy_read_timeout 120s;
        client_max_body_size 10m;   # unggah bukti bayar maks 3 MB
        proxy_buffering off;
    }
}
```

```bash
nginx -t && systemctl reload nginx
curl -s -H "Host: domain-anda.com" http://127.0.0.1/api/health
```

**aaPanel:** taruh di
`/www/server/panel/vhost/nginx/extension/<domain>/proxy-ivvibill.conf`
agar tidak hilang saat vhost diedit lewat panel. File
`extension/<domain>/*.conf` di-include di bagian atas `server { }`.

**OpenLiteSpeed:** di vhost, pakai `context` External App FastCGI ke
`127.0.0.1:3010`, atau `rewrite` pasif:

```
rewrite {
  enable  ^/
  rules   .*   http://127.0.0.1:3010$uri [QSA,L]
}
```

### A.3 SSL (HTTPS)

```bash
# nginx + certbot
apt install -y certbot python3-certbot-nginx
certbot --nginx -d domain-anda.com -d www.domain-anda.com
```

aaPanel: **SSL → Let's Encrypt** di panel, lalu centang *Force HTTPS*.

Setelah HTTPS aktif, `BASE_URL` di `.env` harus `https://...` (cookie
`secure` mengikuti nilai ini), lalu `systemctl restart ivvibill`.

### A.4 Firewall

```bash
ufw allow 22/tcp && ufw allow 80/tcp && ufw allow 443/tcp && ufw enable
# port 3010 TIDAK dibuka — hanya di belakang nginx
```

### A.5 Cron

Scheduler in-process aktif secara default (lihat
[CRON.md](CRON.md)). Untuk shared hosting / proses panjang dilarang,
set `DISABLE_SCHEDULER=1` lalu pakai `scripts/cron.js`.

---

## B. aaPanel / panel web

1. **Situs** → tambah domain, root `/www/wwwroot/<domain>/ivvibill`
2. Jalankan langkah **0** di atas (database bisa dibuat lewat panel)
3. **Node.js / PM2** (bila tersedia): arahkan `app.js` = `server.js`,
   port `3010`
   - Bila panel tidak punya modul Node, pakai systemd/manual seperti
     jalur A — aaPanel tetap berperan sebagai nginx di depan
4. Pasang proxy lewat `extension/<domain>/` (lihat A.2)
5. SSL lewat panel → Let's Encrypt

---

## C. PaaS (Railway / Render / Fly)

1. Sumber proyek = repo ini; **build** `npm ci`;
   **start** `npm start`
2. Tambahkan managed MySQL 8, salin nilai ke env var:
   `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASS`, `DB_NAME`
3. Set env lain: `PORT` (sesuaikan dengan port yang diberikan platform),
   `BIND=0.0.0.0`, `TRUST_PROXY=1`, `BASE_URL=<url publik>`,
   `JWT_SECRET`, `TRUSTED_IPS=127.0.0.1,::1`
4. **Wajib** set `DISABLE_SCHEDULER=1` — PaaS mematikan proses lama, dan
   proses ganda akan menimpa tugas satu sama lain
5. Jalankan migrasi sekali (job/one-off):
   `npm run migrate && npm run seed-admin`
6. Kunci enkripsi: set `APP_SECRET` (min 32 karakter) sebagai env var,
   atau `APP_SECRET_FILE` bila platform punya secret file
7. Pasang **cron luar** platform (atau cron panel) — lihat
   [CRON.md](CRON.md) Mode B
8. Upload bukti bayar butuh persistent volume di `storage/uploads`;
   bila tidak ada, gunakan gateway pembayaran saja

---

## D. Shared hosting biasa

Node tidak jalan sebagai daemon; pakai **pemicu HTTP dari cron panel**.

1. Langkah **0** (via SSH hosting bila ada, atau PHPMyAdmin + unggah)
2. Di `.env`: `DISABLE_SCHEDULER=1`
3. Dokumentasikan sebagai aplikasi **Node** di panel (bila didukung), atau
   jalankan dengan `node` lewat cron panel
4. Cron panel (tiap menit) — tanpa perlu shell:

   ```
   * * * * * /usr/bin/node /home/user/ivvibill/scripts/cron.js semwa >> /home/user/ivvibill/storage/cron.log 2>&1
   ```

5. Bila `node` tidak tersedia sama sekali, panggil endpoint HTTP dari
   cron panel:

   ```
   * * * * * curl -s -X POST https://domain-anda/internal/cron/wa -H "x-internal-token: $CRON_TOKEN"
   ```

   Isi `CRON_TOKEN` di `.env` dengan nilai acak panjang. Guard menolak
   semua IP yang tidak ada di `TRUSTED_IPS`.

---

## Setelah deploy — checklist verifikasi

```bash
# 1. sehat
curl -s https://domain-anda.com/api/health

# 2. empat aplikasi
for u in / /panel/ /agen/ /teknisi/ /pelanggan/; do
  printf '%-14s ' "$u"; curl -s -o /dev/null -w '%{http_code}\n' https://domain-anda.com$u
done

# 3. APK
curl -s -o /dev/null -w 'APK %{http_code} %{size_download}\n' https://domain-anda.com/apk/IvviPanel.apk

# 4. login
curl -s -X POST https://domain-anda.com/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"username":"superadmin","password":"PASSWORD-ANDA"}'

# 5. keamanan dasar
curl -s -o /dev/null -w 'tanpa token: %{http_code}\n' https://domain-anda.com/api/pelanggan   # 401
curl -s -o /dev/null -w 'cron luar: %{http_code}\n' -X POST https://domain-anda.com/internal/cron/billing  # 403

# 6. log
journalctl -u ivvibill -n 50        # systemd
# atau tail -f /var/log/ivvibill.log
```

---

## Troubleshooting

| Gejala | Penyebab | Solusi |
|---|---|---|
| `DB gagal: ...` lalu exit | kredensial salah / DB mati | cek `DB_*` di `.env`, `systemctl status mysql` |
| `APP_SECRET belum diisi` | `.secret` tidak ada | `npm run init-secret` |
| 502 Bad Gateway | proses Node mati | `systemctl status ivvibill`, cek log |
| 404 pada `.js`/`.css` | regex location nginx menyaingi proxy | pakai `location ^~ /` (A.2) |
| `EADDRINUSE :3010` | dua proses berjalan | `ss -lntp \| grep 3010`, hentikan salah satu |
| Tugas cron jalan 2× | scheduler in-process **dan** cron eksternal | pilih satu mode, `DISABLE_SCHEDULER=1` |
| Cookie tidak tersimpan | `BASE_URL` masih `http://` di balik HTTPS | set `https://...`, restart |
| Upload ditolak | >3 MB atau bukan gambar | gambar png/jpg/webp, maks 3 MB |
| WA tidak terkirim | gateway belum diatur | Panel → Pengaturan → URL + API key WA |
| Tanda tangan webhook 403 | server key gateway berbeda | samakan key di Panel dan di dashboard gateway |

---

## Upgrade

```bash
cd /var/www/ivvibill
systemctl stop ivvibill
# simpan .env, .secret, storage/
npm ci && npm run migrate      # idempoten
systemctl start ivvibill
```

Riwayat perubahan: [PATCHES.md](PATCHES.md).
