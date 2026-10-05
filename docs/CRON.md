# Cronjob ivvibill — Tagihan, WhatsApp Gateway & Issue PPPoE

ivvibill punya **dua cara** menjalankan tugas terjadwal. Pilih **satu** saja.

| Mode | Cocok untuk | Cara kerja |
|---|---|---|
| **A. Scheduler in-process** (default) | VPS / dedicated / container | proses `server.js` menjalankan timer sendiri tiap menit |
| **B. Cron eksternal** | shared hosting, PaaS, panel yang mematikan proses lama | cron panel memanggil `scripts/cron.js` |

> Mode A aktif secara default. Mode B **hanya** dipakai bila `.env` berisi
> `DISABLE_SCHEDULER=1`.

---

## Tugas yang tersedia

| Kode tugas | Isi pekerjaan | Kapan (default) |
|---|---|---|
| `billing` | Buat tagihan bulanan, kirim tagihan WA, peringatan H-3, isolir menunggak | dicek **tiap menit**, dieksekusi sesuai `jadwal_buat_hari`, `jadwal_kirim_hari`+`jam_kirim`, 08:00 (peringatan), 09:00 (isolir) |
| `wa` | Kirim antrean WhatsApp (`wa_queue` status `pending`) | **tiap menit** |
| `router` | Polling interface router MikroTik — **kecuali interface PPPoE** | **tiap menit** |
| `olt` | Polling redaman OLT WebFig (per interval tiap perangkat) | **tiap menit**, filter interval |
| `issue` | Deteksi issue pelanggan PPPoE (offline / isolir) | tiap `ISSUE_INTERVAL_MIN` menit (default **10**) |

Jadwal tagihan disimpan di tabel `data_server` dan bisa diubah dari
**Panel → Pengaturan**: `jadwal_buat_hari`, `jadwal_kirim_hari`,
`jadwal_limit_hari`, `jam_kirim`, `ppn_persen`.

---

## Mode A — Scheduler in-process (default)

Tidak perlu setup apa pun. Pastikan `.env` **tidak** berisi
`DISABLE_SCHEDULER=1`, lalu jalankan aplikasi seperti biasa
(`systemctl start ivvibill` / `pm2 start server.js` / `npm start`).

Log scheduler terlihat di log proses:

```bash
# systemd
journalctl -u ivvibill -f
# atau bila memakai log file (lihat DEPLOY.md)
tail -f /www/wwwlogs/ivvibill.log
```

Contoh log yang sehat:

```
[ivvibill 2026-10-05T00:00:00.000Z] Scheduler aktif (wa, router, olt, billing, issue)
[ivvibill 2026-10-05T01:00:00.000Z] Tagihan dibuat: 12
[ivvibill 2026-10-05T01:00:00.000Z] Tagihan dikirim WA: 12
```

### Keamanan endpoint `/internal/cron/:tugas`

Server juga menyediakan endpoint HTTP untuk dipanggil cron **luar**:

```bash
curl -X POST https://domain-anda/internal/cron/billing \
  -H "x-internal-token: $CRON_TOKEN"
```

Guard `requireInternal` hanya menerima dua hal:

1. IP pemanggil ada di `TRUSTED_IPS` (default `127.0.0.1,::1`), **atau**
2. Header `x-internal-token` (atau `?token=`) sama dengan `CRON_TOKEN`
   — bila `CRON_TOKEN` kosong, fallback ke `JWT_SECRET`.

Sudah diuji: permintaan dari IP luar dengan `X-Forwarded-For` palsu
**tetap ditolak 403**, karena `TRUST_PROXY=1` membuat `req.ip` diambil
dari nilai yang benar-benar dikirim proxy, bukan header yang bisa dipalsukan.

---

## Mode B — Cron eksternal (shared hosting)

1. Matikan scheduler in-process di `.env`:

   ```
   DISABLE_SCHEDULER=1
   ```

2. Daftarkan cron lewat panel hosting (atau `crontab -e` di VPS):

   ```cron
   # tiap menit — antrean WhatsApp
   * * * * * /usr/bin/node /path/ke/ivvibill/scripts/cron.js wa     >> /path/ke/ivvibill/storage/cron.log 2>&1

   # tiap 5 menit — billing (buat/kirim/peringatan/isolir)
   */5 * * * * /usr/bin/node /path/ke/ivvibill/scripts/cron.js billing >> /path/ke/ivvibill/storage/cron.log 2>&1

   # tiap menit — interface router (kecuali PPPoE)
   * * * * * /usr/bin/node /path/ke/ivvibill/scripts/cron.js router  >> /path/ke/ivvibill/storage/cron.log 2>&1

   # tiap 5 menit — redaman OLT
   */5 * * * * /usr/bin/node /path/ke/ivvibill/scripts/cron.js olt   >> /path/ke/ivvibill/storage/cron.log 2>&1

   # tiap 10 menit — issue pelanggan PPPoE
   */10 * * * * /usr/bin/node /path/ke/ivvibill/scripts/cron.js issue >> /path/ke/ivvibill/storage/cron.log 2>&1
   ```

   Ganti `/path/ke/ivvibill` dan `/usr/bin/node` dengan lokasi asli
   (`which node`). Di beberapa hosting, jalankan lewat `php` panel atau
   pelihara `cron.js` dipanggil sekali untuk semua tugas:

   ```cron
   * * * * * /usr/bin/node /path/ke/ivvibill/scripts/cron.js semwa >> /path/ke/ivvibill/storage/cron.log 2>&1
   ```

   > `semwa` menjalankan kelima tugas berurutan. Karena tiap tugas punya
   > penjaga anti-tumpang-tindih (`running` flag), aman dipanggil tiap menit.

3. Verifikasi:

   ```bash
   node scripts/cron.js billing
   # contoh keluaran: billing: {"dibuat":0}
   tail -20 storage/cron.log
   ```

### Bila host tidak punya akses shell

Pakai endpoint HTTP dari Mode A (butuh `CRON_TOKEN`):

```cron
* * * * * curl -s -X POST https://domain-anda/internal/cron/wa     -H "x-internal-token: ISIKRISTAGANDA" >/dev/null
*/5 * * * * curl -s -X POST https://domain-anda/internal/cron/billing -H "x-internal-token: ISIKRISTAGANDA" >/dev/null
*/10 * * * * curl -s -X POST https://domain-anda/internal/cron/issue -H "x-internal-token: ISIKRISTAGANDA" >/dev/null
```

**Jangan pernah** menerbitkan `CRON_TOKEN` di repositori publik atau URL
yang dibagikan — endpoint ini menjalankan tugas berbayar (isolir/pelunasan).

---

## Template pesan WhatsApp

Isi template di **Panel → WhatsApp**, tersimpan di tabel `pesan_template`
(jenis: `tagihan`, `peringatan`, `isolir`, `lunas`, `aktivasi`,
`koneksi_off`, `registrasi`, `tiket`).

Placeholder yang tersedia:

| Kunci | Arti |
|---|---|
| `#usr` | nama pelanggan |
| `#inv` | nomor invoice |
| `#prd` | periode tagihan |
| `#tot` | total tagihan (format Indonesia) |
| `#lmt` | jatuh tempo |
| `#lnk` | tautan dashboard pelanggan |
| `#srv` | nama server/ISP |
| `#ppp` | username PPPoE |
| `#lyn` | nama layanan |
| `#jam` | waktu deteksi |
| `#judul` | judul tiket |

Pengiriman memakai gateway WA di **Panel → Pengaturan**
(`wa_gateway_url` + `wa_gateway_key`), kompatibel gaya
`POST {url}sendMessage` dengan `apiKey`, `phone`, `message`.
Antrean ada di `wa_queue`, log di `wa_log`.

---

## Troubleshooting

| Gejala | Penyebab umum | Solusi |
|---|---|---|
| Tagihan tidak dibuat | tanggal hari ini ≠ `jadwal_buat_hari` | cek Pengaturan → jadwal, atau tekan **Buat tagihan** (force) di Panel |
| WA tidak terkirim | `wa_gateway_url` kosong / key salah | Panel → Pengaturan → gateway WA, lalu cek `wa_log.error` |
| `isolir` tidak jalan | belum lewat `jadwal_limit_hari` | wajar — isolir hanya untuk status `jatuh_tempo` |
| Tugas jalan 2× | scheduler in-process **dan** cron eksternal aktif bersamaan | pilih satu mode; set `DISABLE_SCHEDULER=1` untuk Mode B |
| `cron.js` exit 1 | `Tugas tidak dikenal` | pakai nama dari daftar: `billing, wa, router, olt, issue, semwa` |
