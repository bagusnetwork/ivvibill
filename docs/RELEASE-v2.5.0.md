# Catatan Rilis ivvibill v2.5.0

**Tab Pelanggan Unmanage: status/IP/MAC/redaman terbaca + tombol Remote ONU + Input Billing**

| | |
|---|---|
| Tanggal | 2026-10-15 |
| Commit | `8cc6358` (branch `main`, repo di webroot) |
| Tag | `v2.5.0` |
| Versi sebelumnya | `v2.4.3` (`2e61376` + docs `ec9f912`) |
| Status | TERPASANG + terverifikasi di produksi `https://bill.ivvinet.my.id` |
| Push GitHub | **BELUM** — atas keputusan user (`main` ahead 13) |
| Migrasi DB | **Tidak ada** (tidak ada perubahan skema pada rilis ini) |
| Perubahan | 7 berkas, **+626 / −67** baris (dibandingkan `v2.4.3`) |

---

## 1. Ringkasan untuk operator

Menu **Pelanggan → tab Sesi Unmanage** (akun PPPoE yang naik di router tetapi tidak ada di
daftar pelanggan) sebelumnya hanya menampilkan nama akun dengan kolom IP, MAC, dan status
kosong, tanpa redaman, dan kolom Aksinya kosong. Pada versi ini:

- kolom **Status** terisi dan menyebut dari mana data itu datang (🟢 online — sesi langsung
  dari router / 🟡 hanya laporan push router, akun sedang offline);
- kolom **IP** dan **MAC** terisi (bukan `-` lagi);
- kolom **ONU · Redaman** menampilkan SN + port PON + nama ONU + daya RX + nilai redaman
  dengan badge warna, berikut cara pencocokannya (`cocok via mac` / `cocok via akun`);
- kolom **Aksi** berisi dua tombol: **Remote ONU** (buka slot NAT port remote ke IP akun itu)
  dan **Input Billing**;
- **Input Billing** mendaftarkan akun sesi menjadi pelanggan berstatus `baru` dengan formulir
  LENGKAP (nama, paket, Profile Tagihan, WhatsApp, email, agen, password PPPoE, profil isolir,
  alamat, topologi + port ODP, desa, koordinat, bulan tagihan, jumlah, diskon, jatuh tempo,
  keterangan) lalu menerbitkan tagihan periode berjalan — sesuai keputusan user
  "daftarkan + tagihkan sekarang".

Akun/IP/MAC/ONU sudah terisi otomatis dari baris sesi, jadi operator umumnya hanya perlu
memilih paket dan menekan Simpan.

---

## 2. Akar masalah (tiga lapis, semuanya terbukti dari alat/produksi)

**Lapis 1 — satu properti asing memotong seluruh balasan router.**
`RouterOS.pppoeActive()` meminta

```
/ppp/active/print =.proplist=.id,name,service,user,address,uptime,caller-id
```

padahal entri `/ppp/active` **tidak punya properti `user`** — kuncinya `name`. API RouterOS
(diuji di 6.49.17 dan 7.19.2) menghentikan pengiriman baris tepat pada nama properti yang tidak
dikenal, sehingga `address`, `uptime`, dan `caller-id` **tidak pernah sampai ke aplikasi**.
Inilah sebabnya IP, MAC, dan uptime tampil kosong di semua menu yang membaca sesi PPPoE,
meskipun polling-nya sendiri sukses. Properti asli `/ppp/active`:
`.id, name, service, caller-id, address, uptime, session-id, comment`.

**Lapis 2 — tab hanya membaca sesi hidup.**
`sesiTakTerkenal()` hanya menelusuri `/ppp/active`, jadi akun yang baru putus hilang dari daftar
tepat pada saat akun itulah yang paling perlu ditagih. Tidak ada pula pencarian ONU/redaman untuk
baris unmanage, karena pencocokan ONU hanya dilakukan di jalur pelanggan terdaftar.

**Lapis 3 — Remote ONU dikirim dengan IP kosong.**
Rute `/remote-onu` menerima IP dari baris tabel. Karena lapis 1, IP itu kosong, dan rute langsung
menolak — gejalanya "tombolnya tidak ada/tidak jalan", padahal yang gagal adalah bahan bakunya.

---

## 3. Perubahan per berkas

### `src/services/routeros.js` (+19/−…) — perbaikan akar

`proplist` menjadi `=.proplist=.id,name,service,address,uptime,caller-id,comment`; `name` juga
dipetakan ke properti `user` sehingga semua pemakai lama (`monitoring`, `noc`, `pelanggan`) tetap
berfungsi tanpa perubahan. Komentar di kode mencatat perilaku pemotongan balasan ini supaya tidak
terulang di rute lain.

### `src/services/monitoring.js` (+128) — tab Unmanage menjadi lengkap

- `sinkronMacPelanggan()` ikut dikoreksi: `=.proplist=name,service,caller-id,address,uptime` dan
  membaca `a.name` (fitur v2.2.3 selama ini hanya kebetulan bekerja karena proplist-nya tidak
  menyebut properti asing).
- `sesiTakTerkenal(ds)` ditulis ulang. Baris = **sesi hidup ∪ snapshot `sesi_router`**
  (laporan push router 15 menit terakhir) dengan dedup per `(router, akun)`:
  - IP/uptime sesi hidup yang tidak lengkap di-fallback ke snapshot;
  - MAC untuk sesi offline diambil dari `/ppp/secret` lewat helper baru `macDariSecret()`
    (`caller-id` → `last-caller-id`, `comment` ikut dibawa);
  - setiap baris dicocokkan ke ONU lewat helper baru `petaOnuTenant(ds)` +
    `cariOnuTenant(peta, mac, akun)` — urutan pencocokan **MAC → LOID/`nama_onu` = akun → nama**,
    memakai normalisasi `onu.normMac()` / `onu.normAkun()`;
  - bila API router tidak terjangkau, daftar tetap diisi dari snapshot (tidak lagi kosong) dan
    penyebabnya dilaporkan lewat `router_gagal`.
- Bentuk keluaran: `{ data, router_gagal, tercatat }`; setiap baris kini membawa
  `router, setting_id, id_perangkat, user, address, uptime, mac, comment, status, dari, seen_at,`
  `sn_onu, pon_onu, nama_onu, rx_dbm, redaman_db, status_redaman, onu_online, cocok_onu, perangkat_onu`.

### `src/routes/monitoring.js` (+51) — Remote ONU bisa dipakai dari tab Unmanage

`POST /remote-onu` sekarang menerima `akun` dan `router_id` **atau** `setting_id`. Nilai `akun`
disanitasi (`/[^\w.@:-]/` dibuang) karena masuk ke argumen API RouterOS. Bila `ip` tidak dikirim
atau bukan IP valid, server mencari sendiri lewat helper baru `ipDariAkun()`:

1. `/ppp/active/print =.proplist=name,address ?name=<akun>` → `via: 'live'`
2. gagal → baris `sesi_router` `tipe='pppoe'` 15 menit terakhir → `via: 'push'`
3. tetap tidak ada → `400` dengan pesan "IP \<akun\> tidak ditemukan — akun PPPoE-nya
   belum/terputus dari router".

Respons menyertakan `via` sehingga operator tahu IP-nya segar atau dari laporan terakhir.

### `src/routes/pelanggan.js` (+116) — rute baru Input Billing

`POST /api/pelanggan/dari-sesi` (diletakkan sebelum `PUT /pelanggan/:id` agar tidak tertangkap
parameter rute itu). Lihat kontrak lengkap di §4.

### `public/panel/index.html` (+62) — kepala tabel + modal baru

Header tabel Unmanage menjadi `Router · Akun PPPoE · Status · IP · MAC · ONU · Redaman · Uptime · Aksi`
(colspan 8) dengan petunjuk di atas tabel, plus modal baru `mInputBilling` (field berawalan `ib`).
Aset di-cache-bust: `panel.js?v=20261015b` — wajib, karena nginx aaPanel punya `proxy_cache` global.

### `public/panel/panel.js` (+217) — perenderan dan aksi

- `UN_ROWS` menyimpan baris hasil GET supaya tombol aksi bisa membaca balik data aslinya.
- `muatUnmanage()` merender kolom status/IP/MAC/ONU+redaman (badge menurut `status_redaman`)
  + hint jumlah sesi & pelanggan terdaftar; `remoteOnuUnmanage(i)` memanggil rute baru.
- `formInputBilling(i)` menunggu `muatOpsi()` + `muatProfilIsolir()`, mengisi akun/IP/MAC/ONU,
  mempre-isi nama dari `comment` router → LOID/nama ONU → akun, dan bulan berjalan.
- `simpanInputBilling()` menampilkan nomor invoice + total, atau pesan `sudah_ada` / error +
  `petunjuk`, lalu memuat ulang tab Unmanage dan jumlah menu.
- `muatOpsi()` kini juga mengisi dropdown modal ini (`ibPaket`, `ibAgen`, `ibTopo`, `ibDesa`,
  `ibProfilTagihan`); `fProfilTagihanInfo()` diparameterisasi dan `terapkanOpsiProfil()`
  menjaga pilihan profil di kedua modal.

---

## 4. Kontrak API

### `POST /api/pelanggan/dari-sesi`

Guard: `requireRole('superadmin','master','teknisi')` + `requireMenu('pelanggan','tambah')`
**dan** `requireMenu('tagihan','tambah')` (dua grant sekaligus, karena satu aksi menyentuh dua objek).

Body (semua kecuali `username_pppoe` dan `nama` boleh kosong):

| Field | Jenis / batasan | Catatan |
|---|---|---|
| `username_pppoe` | 2–50, wajib | kunci duplikat per tenant |
| `nama` | 2–100, wajib | |
| `tipe` | `pppoe`\|`hotspot` | default `pppoe` |
| `id_paket` | int ≥ 1 | diverifikasi milik tenant aktif |
| `id_profil_tagihan` / `hari_tagihan` | | lewat `kebijakanTagihanPelanggan()`; profil menang |
| `nomor_whatsapp`, `email` | | dinormalisasi `v.phone()` / `v.email()` |
| `password_pppoe`, `profile_isolir` | | `profile_isolir` hanya untuk `tipe='pppoe'` |
| `id_agen`, `alamat` | | |
| `id_master_topologi`, `id_master_desa`, `port_odp`, `latitude`, `longitude` | | lewat `validasiLokasi()` |
| `ip_address`, `mac_address` | ≤ 40 | diisikan dari sesi, bukan diketik |
| `tanggal_masuk` | tanggal | default **`billing.waktuSiklus().hari`** (tanggal WIB) |
| `catatan`, `sumber_sesi` | ≤ 5000 / ≤ 120 | `sumber_sesi` ditulis sebagai "Didata dari sesi router: …" |
| `buat_tagihan` | boolean | default **true**; `false`/`'0'`/`'false'`/`''` = daftar saja |
| `periode` | `YYYY-MM` | default periode berjalan; format salah → `400` |
| `jumlah`, `diskon`, `jatuh_tempo`, `keterangan` | | diteruskan ke `billing.buatTagihanSatuan()` |

Sukses `200`:

```json
{ "id": 301, "kode": "IVV…", "status": "baru", "username": "…",
  "tagihan": { "id": 283, "nomor": "IVV-202610-40562", "total": 1197, "sudah_ada": false },
  "petunjuk": "Pelanggan tercatat sebagai BARU — tekan ⚡ Aktivasi …" }
```

Duplikat `400`: `{ "error": "Akun <u> sudah menjadi pelanggan #<id> (<nama>, <status>)", "sudah_ada": true, "id_pelanggan": <id> }`
— **tidak ada baris kedua yang dibuat.**

Bila pelanggan sudah tersimpan tetapi tagihan gagal (misalnya harga paket 0), rute **tidak**
ikut gagal: `tagihan.error` diisi potongan pesan dan `petunjuk` tetap muncul, sehingga
operator tahu tagihannya bisa dibuat ulang dari menu Tagihan.

Yang **sengaja tidak dilakukan**: tidak ada satu pun penulisan ke router (tidak membuat/mengaktifkan
secret), dan tidak ada pesan WA yang diantrkan. Aktivasi layanan tetap keputusan PJ lewat
⚡ Aktivasi di daftar Pelanggan — searah dengan keputusan v2.2.0.

### `POST /api/monitoring/remote-onu` (berubah)

Sekarang `{ akun, ip?, router_id? | setting_id? }`; IP boleh tidak dikirim. Guard tetap
`requireMenu('pelanggan','ubah')`. Lock 180 detik antar-teknisi dan aturan NAT `dst-port`
tidak berubah.

### `GET /api/pelanggan/unmanage` (berubah, hanya menambah)

Field lama (`user`, `address`, `uptime`, `router`) tetap; tambahan tercantum di §3.
Kompatibel untuk konsumen lain karena tidak ada field yang dihapus.

---

## 5. Skema, scheduler, dan efek samping

- **Tidak ada migrasi.** Tidak ada tabel/kolom/enum baru; `pelanggan`, `tagihan`, `sesi_router`,
  `master_onu` dipakai apa adanya.
- **Tidak ada perubahan scheduler.** Input Billing adalah aksi manual; siklus v2.0.1 (buat →
  kirim WA → pengingat → isolir) tidak tersentuh, dan pelanggan `baru` tidak ikut ditagih paksa.
- Beban API router bertambah satu koneksi per tab Unmanage yang dimuat (`/ppp/secret` untuk MAC
  offline) — dilakukan pada koneksi yang sudah ada, tanpa login tambahan.

---

## 6. Keamanan & pembatasan akses

- Semua rute baru/berubah berada di belakang `requireRole(...)` + `requireMenu(...)` dan
  `tenantAktif(req)`/`tenantSql(req, ...)` — tidak ada jalur lintas tenant.
- Nama akun disanitasi sebelum masuk argumen API (`=` dan baris baru adalah pemisah argumen
  RouterOS), dan `ip` divalidasi bentuk IP sebelum ditulis ke rule NAT.
- Tidak ada PII yang dikirim ke perangkat: `comment`/MAC hanya dibaca ke dalam panel.
- Audit: setiap Input Billing menulis `audit_log` `aksi='input_billing_sesi'`
  (`<nama> (#<id>) <username> → tagihan #<id>`).

---

## 7. Verifikasi jalur asli (bukan uji sintetis)

Metode: HTTPS lewat nginx ke `https://bill.ivvinet.my.id` dengan login `adminmaster` +
`POST /api/auth/server {id}` untuk memindah tenant aktif (cookie dari respons wajib dipakai),
plus render tab di browser nyata. Tenant 5 (PASNET) **hanya dibaca** atas perintah user.

| Aspek | Sebelum | Sesudah |
|---|---|---|
| Tenant 2 — baris Unmanage ber-IP **dan** MAC | 0 / 46 | **46 / 46** |
| Tenant 5 — baris Unmanage | 15 tampil, kolom kosong | 15 sesi · **13 MAC** · 2 baris dari snapshot · **6** terpasang ONU · **5** bernilai redaman |
| Tombol Aksi di tab Unmanage | tidak ada | **Remote ONU** + **Input Billing**, terverifikasi terrender di browser |
| Remote ONU, akun yang sedang naik | ditolak (IP kosong) | sukses, `via: 'live'` |
| Remote ONU, akun tanpa sesi | — | `400` dengan pesan yang menyebut akunnya |
| Input Billing | fitur belum ada | pelanggan **#301** + tagihan **#283** `IVV-202610-40562` total **Rp 1.197**, `tanggal_masuk 2026-10-15` (WIB) |
| Input Billing ganda (akun sama) | — | `400 sudah_ada`, **tidak** membuat pelanggan kedua |

Pemulihan dan pemeriksaan akhir (2026-10-15): `sisa_uji 0`; **ds2 198 pelanggan / 172 tagihan**;
**ds5 79 pelanggan** dan tidak ada satu pun tulisan ke tenant 5; rule NAT `*16 → 192.168.6.16`,
`*19 → 192.168.21.247`; `setting_mikrotik.user_remote='ivvinet'`,
`last_remote='2026-10-12 13:48:40'`; service `active`; 6 berkas + `docs/PATCHES.md` md5 mirror
`C:\Users\new\ivvi\` identik dengan webroot. Dua baris `audit_log` bertuliskan uji **dibiarkan**
sebagai jejak jujur, tidak disapu.

---

## 8. Pemasangan & rollback

Pemasangan rilis ini: kirim 7 berkas → `systemctl restart ivvibill` (perubahan `src/` selalu
butuh restart; tidak ada `server.js` yang berubah sehingga urutan parser webhook tidak terpengaruh)
→ pastikan `?v=20261015b` termuat, bila tidak buang entri `proxy_cache` yang memuat URI
`/panel/panel.js` lalu `nginx -s reload`.

Rollback aman: `git checkout v2.4.3` (atau kembalikan 7 berkas dari `/root/backup-v250-20261015-012517/`)
→ `systemctl restart ivvibill`. Tidak ada langkah DB karena tidak ada migrasi.

---

## 9. Batasan yang diketahui & pekerjaan lanjutan

1. **Baris `offline` memakai IP dari laporan push** (maks 15 menit) — bisa basi; panel menampilkannya
   dengan status "hanya laporan push router" supaya tidak disalahartikan sebagai koneksi hidup.
2. **Pencocokan ONU bergantung pada kesegaran `master_onu`.** ONU yang belum pernah terpoll tenant itu
   (atau yang serial aslinya kosong sehingga SN sintetis `P<port>O<id>`-nya berubah karena ONU
   dipindah) tidak akan berpemasangan.
3. **Remote ONU tetap satu slot per router.** `bukaRemote()` menulis rule `dst-port` pertama; router
   dengan dua rule pada port yang sama (RO-IVVI punya `*16` dan `*19`) hanya menggeser yang pertama.
   Perilaku lama, tidak diubah di rilis ini.
4. **Input Billing tidak mengaktifkan layanan.** Perlu ⚡ Aktivasi (sengaja).
5. **Menu Unmanage tetap hanya menjangkau router yang API-nya hidup.** Router mati → tab diisi
   snapshot dan `router_gagal` menyebut sebabnya.
6. Lanjutan yang menunggu keputusan user: pengambilan data ONU lewat **SNMP/CLI** selain WebFig
   (lihat §10), ambang redaman PASNET (4 / −27 / 28 dB membuat 52 ONU "kritis"), retensi
   `redaman_log`, dan **push GitHub** (`main` ahead 13 + tag `v2.1.2`…`v2.5.0`).

---

## 10. Lampiran — alternatif sumber data ONU selain WebFig

User bertanya apakah data ONU bisa diambil tanpa WebFig (SSH / SNMP). Jawaban singkat,
tanpa menyentuh perangkat:

- **SNMP (paling layak untuk kasus ini).** OLT semacam ini umumnya mengekspos MIB privat berisi
  tabel ONU per port PON (status online, LOID/nama, daya optik RX). Tidak ada "login" sehingga
  tidak memicu penguncian akun WebFig (`code 4032`), polling bisa secepat yang diinginkan, dan
  kalau firmware mendukung trap (ONU offline / RX melewati ambang) pengawasannya bisa pasif sama
  sekali. Biayanya: OID tidak standar dan berbeda antar firmware, jadi perlu pemetaan OID sekali;
  pada sebagian firmware daya optik ada di tabel diagnostik terpisah atau kosong.
- **SSH/Telnet CLI.** Perintah semacam `show onu info` / `display ont info` per port PON biasanya
  lebih lengkap daripada WebFig, tetapi driver-nya paling rapuh (prompt, pagination `--More--`,
  format berubah antar firmware) dan banyak firmware lama hanya punya Telnet — kredensial berjalan
  jelas di jaringan, jadi hanya boleh di jaringan privat.
- **TR-069/ACS tidak membantu.** Pada GPON ONU dikelola OLT lewat OMCI di serat, jadi OLT tetap
  sumber data ONU; ACS hanya berlaku untuk ONU yang berfungsi sebagai CPE.

Rekomendasi bila fitur ini dibangun: read-only community SNMP yang dibatasi ke IP VPS (atau v3
`authPriv` bila didukung), kolektor baru di sisi aplikasi dengan pemetaan OID per merek, dan WebFig
tetap sebagai cadangan. Perangkat produksi **tidak akan di-probe** tanpa persetujuan user.
