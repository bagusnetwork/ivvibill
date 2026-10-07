# PATCHES — catatan perubahan ivvibill

Format: **[TANGGAL] v<versi> — <jenis>**. Tambahkan entri baru di atas.

---

## 2026-10-07 — v1.3.0 — Invoice penjualan barang terpisah + uraian internet diketik manual + bukti lunas bergambar ke WhatsApp, dipasang di atas v1.2.1

**Masalah**

Tabel `tagihan` hanya bisa menampung satu bentuk piutang: uraiannya diambil dari nama paket
langganan (`paket.nama_paket`) dan nominalnya dari `paket.harga`. Akibatnya penjualan barang —
patchcord, ONU, kotak ROS, biaya proyek, tambahan kabel — tidak bisa ditagihkan lewat aplikasi,
sedangkan operator nyata setiap hari menjual barang sekaligus menagihnya. Satu-satunya akal yang tersisa adalah
mengubah nama paket, yang merusak laporan pemakaian paket. Uraian layanan internet sendiri
sering bukan sekadar nama paket ("Langganan 20 Mbps + sewa ONU"), tetapi tidak ada tempat untuk
menulisnya.

Bukti lunas juga hanya teks WhatsApp. gratisinaja mengirim **gambar kwitansi** (dirender GD,
disimpan di kolom `img_invoice`, dikirim lewat `sendMediaFromUrl`) sehingga pelanggan punya
bukti yang bisa disimpan; di ivvibill pelanggan hanya menerima kalimat "pembayaran diterima",
dan tidak ada cara mengirim ulang bukti untuk tagihan yang sudah lunas.

**Diubah**

- `src/util/png.js` **baru** — encoder PNG ditulis tangan (`zlib.deflateSync` + CRC32) dengan
  kanvas `kotak / teks / teksTengah / garis / toBuffer` dan font bitmap 5x7 (95 glif ASCII).
  Versi ini **sengaja tidak menambah dependensi apa pun**: produksi tidak boleh `npm install`
  (lihat Cara dipasang), jadi tidak ada canvas/GD/sharp yang bisa dipakai.
- `src/util/tanggal.js` **baru** — `tglIndo()` dipakai bersama oleh billing, kwitansi, dan
  halaman cetak supaya tanggal tidak berbeda antar tempat.
- `src/services/kwitansi.js` **baru** — `gambar()` menyusun kwitansi 640x440 (kop tenant,
  judul, 9 baris label/nilai, blok tanda tangan + nama pemilik), `terbilang()` untuk baris
  "Terbilang", `ascii()` memetakan huruf beraksen ke font 5x7, dan `simpan()` menulis ke
  `storage/uploads/kwitansi/`. Nama berkas memakai **token acak**
  (`kwitansi-<id>-<8 heks>.png`) supaya bukti yang berisi nama, alamat, dan nominal pelanggan
  tidak bisa ditebak dari nomor invoice, dan berkas lama dihapus saat kwitansi dikirim ulang.
- `src/services/billing.js` — `buatTagihanSatuan()` (uraian **diketik manual**, `jumlah` bebas
  di luar harga paket, `diskon`, kode unik 100-999, PPN per tenant, penahan periode kembar
  mengembalikan `{ sudah_ada, id }`); `kirimKwitansi()` (render -> simpan -> `tagihan.img_invoice`
  -> caption dari template `lunas` -> antrean WA dengan `media`); `lunaskanTagihan()` memanggilnya
  di dalam `try/catch` dan mengembalikan `kwitansi_gagal`, karena **gateway WA yang mati tidak
  boleh membatalkan pelunasan** (sama seperti gratisinaja: kegagalan kirim jadi peringatan).
- `src/routes/tagihan.js` — `POST /tagihan/buat-satuan` (requireMenu `tambah`),
  `PUT /tagihan/:id/keterangan` (ditolak bila sudah lunas), `POST /tagihan/:id/kwitansi`
  (kirim ulang, requireMenu `kirim`). Ketiganya tercatat di `audit_log`.
- `src/routes/invoice.js` **baru** — modul invoice penjualan barang, **terpisah** dari tagihan:
  header (nama & alamat tujuan, nomor WA tujuan, catatan, jatuh tempo) + butir bebas
  (uraian, qty, harga), nomor `INV<yyMM><urut 4>` dengan 25 percobaan anti-tabrak. Rute:
  `GET /invoice`, `GET /invoice/jumlah`, `GET /invoice/invoice-data`, `GET /invoice/:id`,
  `POST/PUT /invoice[/:id]`, butir tambah/ubah/hapus, `POST /:id/kirim`, `/lunas` (kas + kwitansi),
  `/kwitansi`, `/batal`, `DELETE /:id`. Semua ubahan butir ditolak saat status lunas.
  `invoice-data` **harus** terdaftar sebelum `/invoice/:id`, tidak URL itu dibaca sebagai id
  dan membalas "Harus berupa angka". Kolom `total` tidak ada di tabel `invoice` — selalu
  `SUM(quantity*harga)`, jadi setiap jalur yang memakai `SELECT *` harus menghitung ulang.
- `src/services/wa.js` — `enqueue()` menerima `media`; pengirim memakai
  `sendMediaFromUrl` (`as_document: 0`, `pesan` jadi caption) bila `media` terisi, selain itu
  tetap `sendMessage`.
- `sql/schema.sql` + `scripts/migrate-v13.js` — tabel `invoice` dan `invoice_item`, kolom
  `tagihan.img_invoice`, kolom `wa_queue.media`. Migrasi idempoten (lapor "tidak ada perubahan"
  pada database baru karena `schema.sql` sudah membuatnya).
- `src/routes/tenant.js` — kunci menu `invoice` ditambahkan ke daftar grant grup akses.
- `server.js` — mount `src/routes/invoice` di `/api`.
- Panel — menu **Invoice Penjualan** (kartu jumlah/lunas/belum + pencarian + pemilih status +
  CRUD header & butir + Kirim WA + Tandai lunas + Kwitansi), tombol **+ Tagihan Satuan** dan
  **Kwitansi WA** di menu Tagihan, sunting **Keterangan** per baris, dan halaman cetak
  `public/cetak/invoice-barang.html` + `invoice-barang.js` (skrip eksternal, bukan inline, agar
  lolos `script-src 'self'`).
- Ikut diperbaiki saat uji: caption lunas invoice memuat "Rp NaN" (total tidak terbawa dari
  `SELECT *`), blok tanda tangan kwitansi terpotong di tepi kanan untuk nama kota panjang
  (kini rata kanan ke margin dan turun ke skala 1 bila tidak muat), baris "Nomor layanan"
  dihilangkan pada invoice barang (tidak ada username PPPoE-nya), `opsiPelanggan()` memakai
  cache daftar pelanggan dari tenant sebelumnya sehingga form tagihan satuan salah tenant, dan
  `reset_staging.sh` mencatat pid `setsid` (bukan pid node) sehingga server lama tetap memegang
  port 3011 dan seluruh suite menguji **kode lama**. Kini skrip menghentikan lewat pemilik port
  (dibatasi cwd staging) dan membuktikan rute v1.3.0 menjawab 401 sebelum melanjutkan.

**Cara dipasang ke produksi**

`sudo bash mt/install_fase2.sh` — versi ini **tidak menambah dependensi**, jadi jangan jalankan
`npm install`/`npm ci` di produksi. Installer menjalankan `migrate-multitenant.js` ->
`migrate-v12.js` -> `migrate-v13.js` (semuanya idempoten) lalu menaikkan angka versi dan
merestart `ivvibill.service`. Rantai versi naik **satu lompatan per jalankan**: kalau produksi
masih v1.1.2, jalankan dulu untuk v1.2.1 lalu jalankan lagi untuk v1.3.0. Sesuai aturan
pemasangan, diff tiap `TARGET` di `mt/daftar_target.sh` terhadap
`/www/wwwroot/ivvinet.my.id/ivvibill` lebih dulu — installer menimpa seluruh berkas itu.

**Verifikasi (staging: `mt/reset_staging.sh` -> `mt/uji_staging.sh` -> `mt/uji_lanjutan.sh` -> `mt/uji_scheduler.js`)**

- 35/35 dan **100/100** lulus tanpa SKIP; bagian 9 berisi 40 cek v1.3.0: tagihan satuan
  (keterangan manual tersimpan, `jumlah` 150000 -> dasar, kode unik 100-999, total = netto +
  kode + PPN, periode kembar -> `sudah_ada`, pelanggan tenant lain -> 400), sunting keterangan
  terbaca sampai `invoice-data`, kwitansi sebelum lunas -> 400, pelunasan -> berkas PNG benar-benar
  ada di `storage/uploads`, antrean WA `jenis=lunas` membawa `media`, kirim ulang -> 200 dengan
  **nama berkas bertoken acak** dan berkas lama hilang, caption lunas invoice memuat
  "Rp 50.000" (bukan NaN), siklus butir (tambah/ubah/hapus -> 450.000 / 400.000 / 50.000),
  halaman cetak barang 200 tanpa inline script, invoice tenant lain -> 404, butir invoice lunas
  -> 400, invoice lunas tidak bisa dihapus, dan `invoice` ada di grant grup.
- Uji scheduler: **SEMUA OK** (tagihan dua tenant, prefix IVV/ISP2 terpisah, 8 baris `wa_queue`
  terikat tenant).
- `mt/uji_produksi.sh` (hanya GET + probe tanpa sesi, dijalankan sebagai gladi resik terhadap
  staging): **LULUS=112 GAGAL=0**, termasuk bagian 2f untuk v1.3.0.
- Kwitansi diperiksa sebagai gambar, bukan hanya sebagai berkas: kwitansi tagihan menampilkan
  uraian hasil ketikan manual, `Jumlah Rp 140.523`, terbilang, dan blok tanda tangan; kwitansi
  invoice barang menampilkan `Rp 50.000` / "lima puluh ribu rupiah" dan **tanpa** baris
  "Nomor layanan" yang tidak berlaku untuk penjualan barang. Blok tanda tangan diuji dua arah:
  kota pendek ("Jakarta, 7 Oktober 2026") tetap skala 2 dan rata kanan, kota panjang
  ("Bandar Lampung, 7 Oktober 2026") turun ke skala 1 sehingga tidak ada satu huruf pun yang
  keluar kanvas.

**Catatan**

Kwitansi dirender dengan font bitmap 5x7, jadi nama orang/alamat beraksen dipetakan ke ASCII
dan teks panjang dipotong dengan `...`. Berkas kwitansi lama dihapus saat kirim ulang: tautan
yang sudah terkirim sebelumnya ikut mati — sengaja, karena isinya data pribadi pelanggan dan
tidak boleh ada dua salinan beredar. Nama berkas pra-token (mis. `kwitansi-1.png`) boleh
dihapus manual dari `storage/uploads/kwitansi/`. Mengirim gambar tetap butuh gateway WA yang
sudah terpasang; selama pairing WHAPI belum selesai, pesan kwitansi menumpuk sebagai `pending`
di antrean (bukan gagal), dan pelunasan tetap sukses dengan `kwitansi_gagal` kosong.

## 2026-10-07 — v1.2.1 — dasbor penuh + siklus hidup pelanggan (tab status, aksi, unmanage, Excel), dipasang di atas v1.2.0

**Masalah**

Dasbor hanya menampilkan empat kartu dan tanpa grafik, sedangkan gratisinaja memakai dasbor untuk
mengambil keputusan (berapa pasang baru, berapa order, uang masuk vs piutang). Menu Pelanggan lebih
parah: hanya ada satu tombol *Ubah*, daftar dipotong 100 baris tanpa halaman, tidak ada cara
menyalakan/mematikan pelanggan massal, tidak ada daftar akun PPPoE liar, dan template/ekspor/impor
Excel — yang dipakai operator untuk memindahkan data dari aplikasi lama — tidak ada. Yang paling
berbahaya: status `isolir`/`nonaktif` hanya mengubah kolom di database; router tidak disentuh, jadi
pelanggan menunggak tetap bisa internetan sambil panel mencatat mereka terputus.

Versi ini juga **menggantikan v1.1.3** (template/ekspor/impor berformat CSV). CSV tidak pernah
terpasang di produksi, jadi tidak ada yang perlu dimigrasikan: berkasnya digantikan SheetJS.

**Diubah**

- `src/services/monitoring.js` — `routerTenant(id)`, `setSecret(user, { disabled, idDataServer })`
  dan `sesiTakTerkenal(id)`. `setSecret` mencari `/ppp/secret` di **semua** router tenant (skema ini
  tidak punya kolom router di tabel pelanggan), men-set `disabled=yes|no`, dan saat mematikan ikut
  membuang sesi di `/ppp/active` — secret cacat tidak memutus koneksi yang sudah naik. Fungsi v1.2.0
  (`pollRouter`, `cekPppoePelanggan`, `sambungkan`, remote ONU) tetap ada; berkas ini hanya
  bertambah.
- `src/services/billing.js` — `isolirJatuhTempo()` kini benar-benar mematikan secret dan mengembalikan
  `router_gagal`; `lunaskanTagihan()` mengembalikannya (`disabled=no`). `src/scheduler.js` mencetak
  baris `Isolir TANPA router` bila sebagian router tidak tersentuh, supaya operator tahu tunggakan
  mana yang belum benar-benar terputus.
- `src/routes/pelanggan.js` — rute baru (didaftarkan **sebelum** `GET /pelanggan/:id`):
  `GET /pelanggan/jumlah` (angka per status untuk label tab), `GET /pelanggan/unmanage` (lihat saja),
  `GET /pelanggan/template`, `GET /pelanggan/export`, `POST /pelanggan/import`,
  `POST /pelanggan/status` (massal, maks 200 id) dan `POST /pelanggan/:id/status`.
  `PUT /pelanggan/:id` ikut menyinkron secret bila status berubah, dan tetap menjalankan
  `validasiLokasi()` warisan v1.2.0 (koordinat/topologi/desa/port ODP).
  Template & ekspor adalah workbook `.xlsx` dua lembar (`Pelanggan` + `Petunjuk`) dan bisa dipaksa
  `?format=csv`; impor menerima `.xlsx`, `.xls`, `.csv` (multer, maks 2 MB, 1000 baris). Ekspor
  **tidak** memuat `password_pppoe`; impor memvalidasi paket milik tenant sendiri, menolak username
  PPPoE kembar, dan membalas per baris (`{ total, sukses, gagal, detail:[{baris,nama,error}] }`).
- `src/routes/lain.js` — `GET /dashboard` menambah kartu (pasang baru bulan/tahun, register, tidak
  aktif, offline di router, order antrian/dikerjakan/selesai, pemasukan tahun ini & bulan lalu,
  voucher terjual) dan `tenant` untuk peringatan `expaired_date`; rute baru
  `GET /dashboard/keuangan?tahun=` → deret 12 bulan pemasukan vs piutang + daftar tahun.
- Panel — tab status dengan angka hidup, kolom centang + aksi massal, tombol Aktifkan/Isolir/
  Nonaktif/Hapus per baris, paginasi server-side (50/halaman), tombol Template/Ekspor/Import,
  panel "PPPoE aktif tanpa tagihan", dan grafik batang Chart.js 12 bulan dengan pemilih tahun.
  Kolom warisan v1.2.0 (koordinat, IP lokal, MAC, redaman, topologi/port/desa, Remote ONU) tetap ada.
- `public/assets/vendor/chart.umd.min.js` dipasang sebagai berkas **vendor** (bukan CDN) agar lolos
  `script-src 'self'`.
- `package.json` + `package-lock.json` ikut dipasang supaya `xlsx`/`chart.js`/`multer` tercatat
  sebagai dependensi. `install_fase2.sh` **membatalkan instalasi** sebelum menyentuh layanan bila
  `xlsx`/`multer` belum ada di `node_modules`.
- Perbaikan bug warisan v1.2.0: `public/cetak/invoice.html` tidak pernah bisa tampil.
  `server.js` tidak meng-mount folder `public/cetak` (hanya /panel /agen /teknisi /pelanggan /assets
  /apk) sehingga tombol Cetak di halaman Tagihan selalu 404, dan isi skripnya inline sehingga
  tetap diblokir CSP. Kini `app.use('/cetak', express.static(...))` ditambahkan, skrip 120 baris
  dipindah ke `public/cetak/invoice.js`, dan `GET /tagihan/invoice-data` (sudah ada di produksi)
  dipindah ke pohon staged agar tidak ikut tertimpa.
- `server.js` — penahan `unhandledRejection`: Express 4 tidak meneruskan error dari handler async,
  dan satu bug kecil di rute pelanggan sempat mematikan seluruh panel saat uji.
- `sql/schema.sql` — komentar `//` di dalam `CREATE TABLE setting_mikrotik` diganti `--` (MySQL
  menolak `//`), dan seluruh tabel diberi `COLLATE=utf8mb4_unicode_ci` eksplisit. Tanpa ini
  `GET /api/pelanggan` 500 `Illegal mix of collations` saat JOIN ke `redaman_log`/`master_onu`
  di host yang default collation-nya `utf8mb4_0900_ai_ci`.

**Cara dipasang ke produksi (penting)**

Produksi sudah berjalan di v1.2.0 **tanpa** naiknya angka versi (`src/config.js` masih 1.1.2), dan
sebagian besar berkas v1.2.0 tidak pernah masuk pohon staged. Semua itu sudah di-*rebase*: berkas
`pelanggan.js`, `panel.js`, `index_panel.html`, `server.js`, `schema.sql`, `monitoring.js`,
`tagihan.js` digabung tiga arah (HEAD v1.1.2 → fitur baru → berkas produksi v1.2.0), dan
`master.js`, `noc.js`, `keuangan.js`, `util/csv.js`, `migrate-v12.js` ikut dipetakan ke `mt/` supaya
instalasi tidak menghapus menu Topologi/Desa/NOC/Keuangan/Tiket. `install_fase2.sh` kini menjalankan
`migrate-multitenant.js` **lalu** `migrate-v12.js` (dua-duanya idempoten).

`npm ci`/`npm install` **tidak** boleh dijalankan di produksi untuk versi ini: `xlsx` diambil dari
CDN SheetJS dan `chart.js` tidak dipakai Node sama sekali (browser memakai berkas vendor UMD).
Modul runtime dipasang offline: `npm install --no-save <mt>/deps/xlsx-0.20.3.tgz`.

**Verifikasi (staging, `mt/reset_staging.sh` → `mt/uji_staging.sh` → `mt/uji_lanjutan.sh` → `mt/uji_scheduler.js`)**

- 35/35 dan 58/58 lulus; uji scheduler OK (tagihan dua tenant, prefix IVV/ISP2 terpisah, antrean WA
  per tenant). Bagian 7 mengunci: 401 tanpa sesi untuk `dashboard/keuangan`, `pelanggan/unmanage`,
  `pelanggan/:id/status`, `pelanggan/template`, `pelanggan/export`; `pelanggan/jumlah` tidak tertelan
  rute `/:id`; template & ekspor workbook zip (`PK` di 2 byte pertama) dan `?format=csv` membalas
  `text/csv`; impor 2 baris → 1 sukses, 1 gagal karena paket tidak dikenal; status tunggal & massal
  berubah dan tercatat di `audit_log`. Bagian 8 mengunci v1.2.0: topologi/desa/kas masih berfungsi,
  menu noc/topologi/desa/keuangan masih ada di panel, `remote-onu` butuh sesi, `cetak/invoice.html`
  dan `cetak/invoice.js` 200, `invoice-data` 401 tanpa sesi, dan invoice tenant lain → 404.
- Skrip `mt/uji_produksi.sh` (85 cek, hanya GET) sudah dijalankan sebagai gladi resik terhadap
  staging: LULUS=85 GAGAL=0.
- Browser (`http://127.0.0.1:3011/panel/`): 12 kartu + peringatan "6 pelanggan aktif sedang tidak
  terhubung"; grafik Chart.js terpasang dengan 2 dataset × 12 label (piutang Rp 603.641 muncul di
  Okt); tab pelanggan `Semua 6 · Aktif 6 · Register 0 · Isolir 0 · Tidak Aktif 0 · Unmanage ?`;
  `fetch('/api/pelanggan/template')` dari dalam halaman membalas 200
  `application/vnd.openxmlformats...sheet`, 20.114 byte, `attachment; filename="template-pelanggan.xlsx"`;
  tidak ada pesan konsol dan tidak ada atribut `onclick` yang merujuk fungsi tak terdefinisi.
  `/cetak/invoice.html?no=IVV-202610-92282` akhirnya terisi: kop tenant, uraian, total Rp 100.618,
  terbilang "seratus ribu enam ratus delapan belas rupiah", rekening tujuan.

**Catatan**

Unmanage sengaja **lihat saja**: menandai akun liar sebagai pelanggan butuh field router/ODP yang
belum ada di skema ini. Impor juga tidak membuat secret di router — ivvibill belum pernah punya
provisioning PPPoE, jadi akun hasil impor harus ada di router lebih dulu (atau dibuat manual)
sebelum tombol Aktifkan berarti.

## 2026-10-06 — v1.2.0 — topologi/desa, remote ONU, NOC ping, keuangan kas, invoice cetak (mirip gratisinaja)

**Referensi**: source code gratisinaja di `/www/wwwroot/gratisinaja` (PHP) — halaman
`master_topologi`, `master_desa`, `user_aktif`, `user_remote`, `ping_console`, `kas`,
`invoice`. Semua fitur di bawah meniru perilakunya, dipindah ke arsitektur ivvibill
(Express + tenant-scoped + grant menu).

**Ditambahkan — Master Topologi (ODP) & Desa**

- Tabel baru `master_topologi` (nama, titik_koordinat, jumlah_port) & `master_desa`;
  kolom baru di `pelanggan`: `id_master_topologi`, `id_master_desa`, `port_odp`,
  `latitude`, `longitude`.
- `src/routes/master.js` — CRUD keduanya (guard `requirePJ` + `requireMenu('topologi'|'desa', …)`),
  list topologi membawa `jumlah_terpakai`/`sisa_port` (port terpakai dihitung dari pelanggan),
  hapus ditolak bila masih dipakai pelanggan.
- Panel: menu baru **Topologi (ODP)** & **Desa**; form pelanggan memilih ODP + desa +
  port ODP + latitude/longitude; validasi koordinat angka & relasi dicek per tenant.

**Ditambahkan — tabel Pelanggan Aktif (mirip user_aktif.php)**

- Kolom baru di tabel pelanggan panel: **koordinat** (tautan Google Maps, fallback ke
  titik koordinat ODP), **IP lokal** (pppoe_status), **MAC** (master_onu), **level
  redaman** (redaman_log terakhir via ONU pelanggan — badge ok/warning/kritis + dB),
  **tombol WA** (wa.me), **Topologi · port · Desa**.
- Query list/detail pelanggan kini JOIN `master_topologi`, `master_desa`, `master_onu`
  (baris terbaru per pelanggan) dan `redaman_log` (baca terakhir per SN ONU).

**Ditambahkan — Remote ONU auto-generate NAT (mirip user_remote.php)**

- `POST /api/pelanggan/:id/remote-onu` (requireRole superadmin/master/teknisi +
  `requireMenu('pelanggan','ubah')`): resolve IP pelanggan dari `pppoe_status`, fallback
  live tanya router via `/ppp/active/print ?name=…`; kunci remote 180 detik antar teknisi
  (`setting_mikrotik.user_remote` + `last_remote` — kolom baru); lalu **auto
  dst-nat** MikroTik: bila rule dengan `dst-port = port_remote` sudah ada → update
  `to-addresses` ke IP pelanggan, bila belum → tambah rule `dstnat/tcp, dst-address=router,
  dst-port=port_remote, to-addresses=IP pelanggan, to-ports=80, comment 'Remote ONU - ivvibill'`.
  Respons membawa `link` http://router:port_remote untuk membuka web ONU.
  Dicatat ke `audit_log` sebagai `remote_onu`. Kolom baru `setting_mikrotik`:
  `port_remote`, `user_remote`, `last_remote`.
- Panel: tombol **Remote ONU** di tabel pelanggan + modal hasil (IP, port, status NAT, link).

**Ditambahkan — NOC ping test (mirip ping_console.php)**

- `src/routes/noc.js`: `GET /api/noc/router` (daftar MikroTik tenant),
  `GET /api/noc/ping?target=…&router=…` — target di-whitelist: youtube.com,
  facebook.com, 8.8.8.8, 1.1.1.1, tiktok.com, mobilelegends.com. Paket ICMP dikirim
  **oleh router** lewat perintah `/ping` RouterOS (bukan server hosting), timeout 2s.
- Panel: halaman **NOC Ping Test** — konsol per target (dot hijau/merah, log gaya
  terminal, statistik kirim/terima/loss/min/avg/max), dropdown router, tombol
  Jalankan/Jeda Semua + Bersihkan; polling ~2 detik per target dan otomatis berhenti
  bila halaman NOC ditinggalkan.
- Rate-limit: `/api/noc` dikecualikan dari limiter global 240/menit dan diberi limiter
  khusus 900/menit (`server.js`) supaya polling tidak terputus.

**Ditambahkan — Keuangan / Kas (mirip kas.php + pemasukan/pengeluaran.php)**

- Tabel baru `kas` (tipe masuk/keluar, kategori, jumlah, keterangan, id_ref,
  dibuat_oleh). `src/routes/keuangan.js`: daftar + filter tanggal/cari + ringkasan,
  `GET /api/keuangan/laporan` (total masuk/keluar/saldo + per kategori), CRUD
  (guard `requirePJ` + `requireMenu('keuangan', …)`); entri kategori `pembayaran`
  tidak bisa dihapus manual.
- **Auto-kas**: `billing.lunaskanTagihan()` menyimpan pemasukan ke `kas` setiap kali
  tagihan dilunaskan (manual, verifikasi, maupun payment gateway) — idempoten karena
  fungsi kembali lebih dulu bila sudah lunas; kegagalan kas tidak membatalkan pelunasan.
- Panel: halaman **Keuangan (Kas)** — kartu masuk/keluar/saldo, filter tanggal, tabel
  transaksi, form tambah pemasukan/pengeluaran.

**Ditambahkan — Invoice cetak (mirip invoice.php)**

- `GET /api/tagihan/invoice-data?nomor=…` — data invoice scoped (pelanggan hanya
  punya sendiri, agen pelanggannya, lainnya per tenant). **Urutan route penting**:
  rute ini didaftarkan sebelum `GET /tagihan/:id` (uji menangkap bug awal: `v.num('invoice-data')`
  melempar 'Harus berupa angka').
- `public/cetak/invoice.html` — halaman cetak A4 (logo ISP, nomor invoice, badge status,
  data pelanggan/paket, rincian jumlah + kode unik + PPN + **terbilang**, rekening
  tujuan, riwayat pembayaran diterima, tanda tangan) + tombol Cetak/PDF + tombol WA
  pelanggan berisi ringkasan tagihan. Dipanggil dari panel via tombol **Cetak** di
  tabel tagihan (`/cetak/invoice.html?no=INV…`, autentikasi lewat cookie sesi).

**Ditambahkan — WebFig remote perangkat + Tiket Gangguan di panel**

- Tombol **WebFig** di tabel Perangkat — membuka GUI perangkat
  (`http(s)://alamat`, OLT memakai port tersimpan; MikroTik port 80/443 bawaan).
- Panel kini punya halaman **Tiket Gangguan** (API-nya sudah ada dari awal): daftar
  + filter status, buat tiket baru (dropdown pelanggan), proses (status baru → diproses
  → selesai → ditutup + jawaban). Notifikasi WA pelanggan otomatis saat tiket dibuat.

**Skema & migrasi**

- `sql/schema.sql` diperbarui (tabel baru + kolom pelanggan + kolom setting_mikrotik)
  untuk instalasi baru; `scripts/migrate-v12.js` (`npm run migrate-v12`) idempoten untuk
  DB yang sudah ada — cek `information_schema` dulu, mendukung `--dry-run`.

**Verifikasi (2026-10-06)**

- `node --check` lolos untuk seluruh berkas backend + panel.js.
- Uji integrasi baru (`/tmp/uji_v12.js`, express + JWT asli, db/routeros/wa dipalsukan): **30/30 PASS** —
  CRUD topologi (terpakai/sisa port, tolak dup & dipakai), CRUD desa, simpan pelanggan
  + lokasi (koordinat tervalidasi, relasi dicek per tenant, PUT koordinat → null),
  JOIN list pelanggan (topologi/desa/redaman/MAC/IP), remote ONU (NAT add lengkap dengan
  dst-address/to-ports, lock 180s → 409, update NAT setelah kadaluarsa, fallback IP live),
  NOC (perintah `/ping` benar, target tak dikenal → 400, router lain tenant → 404),
  kas (CRUD, laporan, saldo), auto-kas pelunasan (Rp 100.123 tercatat, tagihan lunas,
  entri pembayaran tak bisa dihapus), invoice-data (master/pelanggan sendiri/404).
- Regresi fitur v1.1.3: 20/20 (export/import/template pelanggan) + 9/9 (parser CSV) PASS
  setelah perubahan query pelanggan.
- Migrasi dry-run terhadap DB produksi (read-only): 13 perubahan terdeteksi dengan
  benar, tidak ada yang diterapkan.

**Catatan**

- Redaman pelanggan memakai `master_onu.id_pelanggan` + `redaman_log` terakhir per SN;
  bila ONU belum terpetakan, kolom redaman tampil '-'.
- Remote ONU butuh `port_remote` diisi di Pengaturan MikroTik (default bila kosong: 8080)
  dan fitur remote web harus aktif di ONU/router pelanggan.
- Fitur yang disengaja tidak diubah: tiket WA template & alur pembayaran manual/gateway
  tetap seperti sebelumnya.

## 2026-10-06 — v1.1.3 — export, import & template CSV data pelanggan

**Ditambahkan**

Menu *Pelanggan* di panel kini punya tiga tombol baru: **Template**, **Export**, dan
**Import** (sebelah kiri *+ Tambah Pelanggan*).

- `src/util/csv.js` — parser/serializer CSV baru tanpa dependensi eksternal:
  delimiter terdeteksi dari baris header (`,`, `;`, atau tab — Excel berbahasa
  Indonesia menyimpan CSV dengan `;`), mendukung kutip `"..."` dengan kutip ganda
  `""`, BOM UTF-8, CRLF; baris komentar `#` dan baris kosong diabaikan tetapi nomor
  baris asli dipertahankan supaya pesan error import menunjuk baris yang terlihat
  di Excel.
- `src/routes/pelanggan.js`:
  * `GET /api/pelanggan/export` — unduh CSV seluruh pelanggan sesuai scope tenant
    (kolom: kode, nama, tipe, paket, agen, username_pppoe, password_pppoe,
    nomor_whatsapp, email, alamat, ip_address, mac_address, status, tanggal_masuk,
    hari_tagihan). Paket & agen ikut di-JOIN sebagai nama, jadi hasil export bisa
    langsung diimpor ulang (round-trip). BOM + `Content-Disposition: attachment`
    supaya Excel langsung membaca UTF-8.
  * `GET /api/pelanggan/template` — template CSV berisi baris penjelas `#` + header
    + 2 baris contoh. Kedua rute ini didaftarkan **sebelum** `GET /pelanggan/:id`
    supaya `/export` tidak tertangkap parameter `:id`.
  * `POST /api/pelanggan/import` — unggah CSV (multer memoryStorage, maks 2 MB,
    field `file`). Guard sama dengan POST pelanggan: `requireRole('superadmin',
    'master', 'teknisi')` + `requireMenu('pelanggan','tambah')`. Perilaku:
      - **hanya menambah** baris baru — data lama tidak pernah diubah;
      - header dipetakan longgar (`username`/`username_pppoe`, `wa`/`nomor_whatsapp`,
        `tgl`/`tanggal_masuk`, dst.), kolom `kode` dari export diabaikan (kode dibuat
        ulang: `prefix_invoice + base36 + nomor baris`, dipotong maks 20 karakter
        sesuai kolom `kode VARCHAR(20) UNIQUE`);
      - `paket`/`agen` dicocokkan **berdasarkan nama** di tenant yang sama;
        username PPPoE dicek duplikatnya per tenant (termasuk antar-baris dalam
        satu file);
      - kegagalan per baris dikumpulkan (maks 100 detail) — satu baris rusak tidak
        menggagalkan seluruh file; respons `{ total, sukses, gagal, detail:[{baris,
        nama, error}] }`;
      - **pesan WhatsApp tidak dikirim** saat import (mencegah spam massal), dan
        seluruh proses dicatat ke `audit_log` sebagai `import_pelanggan`.
- Panel (`public/panel/index.html` + `panel.js`): tombol Template/Export mengunduh
  langsung lewat cookie sesi (httpOnly, same-origin); tombol Import membuka modal
  berisi tautan template, pilih file, lalu laporan hasil per baris + toast ringkas.

**Verifikasi (2026-10-06, uji otomatis tanpa menyentuh DB produksi)**

- `node --check` lolos untuk ketiga berkas yang diubah + `src/util/csv.js`.
- Unit test parser CSV — 9/9: kutip/kutip ganda, delimiter `;`, BOM+CRLF+komentar,
  komentar terkutip, escaping serializer, round-trip tulis→parse, template asli.
- Uji integrasi rute asli (express + JWT asli, `db`/`wa` dipalsukan lewat
  `require.cache`) — 20/20: export tanpa sesi → 401; export 200 dengan header 15
  kolom + baris data; template terparse benar (komentar dibuang, 2 contoh utuh);
  import batch 7 baris → 2 sukses / 5 gagal dengan nomor baris & pesan error benar
  (tipe salah, paket tak dikenal, dup username, nama kosong, agen tak dikenal);
  baris valid tersimpan dengan `id_paket`/`id_agen` ter-resolve + nomor WA
  ternormalisasi ke `628…`; kode baru ber-prefix `IVV` ≤ 20 karakter; `audit_log`
  tercatat; **nol pesan WA** masuk antrean; role agen → 403; teknisi tanpa grant →
  403; teknisi bergrant `pelanggan.tambah` → 200; dup username vs data lama →
  gagal per baris; file `.xlsx` ditolak fileFilter; header tanpa `nama` → 400;
  round-trip export setelah import memuat baris baru.

**Catatan**

- Header CSV apa pun yang tidak dikenal diabaikan diam-diam (termasuk kolom
  ekstensi panel lain), sehingga file lama tetap bisa diimpor tanpa disunting.
- Limitasi yang diketahui: parser mengasumsikan UTF-8; CSV yang disimpan sebagai
  ANSI/Windows-1252 dari Excel lama perlu disimpan ulang sebagai *CSV UTF-8*.

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
