# PATCHES — catatan perubahan ivvibill

Format: **[TANGGAL] v<versi> — <jenis>**. Tambahkan entri baru di atas.

---

## 2026-10-11 — v2.0.1 — tombol "Jalankan Siklus" berhenti menagih paksa: gerbang harinya kini dipinjam dari scheduler

**Masalah**

`POST /api/tagihan/siklus` masih meneruskan `force=true` ke `buatTagihanBulanan()` warisan
v1.9.0. Setelah v2.0.0, artinya sekali klik membuat tagihan untuk **seluruh** pelanggan aktif
tanpa memandang `tanggal_buat` profilnya, dengan `tanggal_buat` = tanggal hari ini dan
`jatuh_tempo` = tanggal_isolir profil. Ditekan tanggal 11 oleh tenant yang temponya tanggal 10,
hasilnya tagihan yang **sudah lewat tempo saat dilahirkan** — dan karena siklus berjalan tiap
menit, dua langkah berikutnya langsung ikut: kirim WA massal lalu isolir.

Itu bukan skenario hipotetis. Pada 2026-10-11 pukul **18:03 WIB** tombol ini ditekan di produksi
(sebelum perbaikan ini terpasang): 171 tagihan periode 2026-10 dibuat dengan jatuh tempo
2026-10-10, 100 WA `tagihan` terkirim pada 18:03, lalu `Isolir [2 IVVINET-CBD]` mencatat
50 + 50 + 21 pelanggan dengan **107 sesi PPPoE benar-benar diputus** (44+45+18) pada 18:03–18:05,
disusul 171 WA `isolir`. Pukul 19:02–19:04 seluruhnya ditandai `bayar_manual` (171 baris
`pembayaran`) dan 176 WA `lunas`/kwitansi terkirim. Efek yang masih tertinggal di pembukuan:
"pemasukan bulan ini" kini menghitung **Rp 26.215.000** (171 baris `pembayaran` `metode='manual'`) yang bukan
uang masuk.

**Diubah**

*`src/services/billing.js`* — fungsi baru `jalankanSiklusTenant(srv, w, limit)`: satu putaran
siklus untuk satu tenant dengan keempat gerbangnya (buat / kirim WA / pengingat H-3 / isolir),
mengembalikan `{tanggal, hari, jam, periode, langkah:{buat,kirim,peringatan,isolir}}` di mana tiap
langkah berisi hasil aslinya plus `jalan: true|false` dan `alasan` bila tidak jalan
("tidak ada profil tagihan dengan tanggal buat 11 (jadwal server: 1)", "belum jam kirim 07:00",
dst). `normJam`/`lewatJam` ikut diimpor supaya ambang jamnya identik dengan scheduler.

*`src/scheduler.js`* — `tugasBilling()` tinggal memanggil fungsi itu per tenant lalu menulis log
dari hasilnya (per_profil, jumlah sesi dibuang, `router_gagal`, `tanpa_nomor_wa` tetap dicetak).
Tidak ada lagi dua jalur berbeda: tombol panel dan cron internal tidak bisa saling menjauh.

*`src/routes/tagihan.js`* — `/tagihan/siklus` memakai `jalankanSiklusTenant()`; `force` hilang
dari jalur normal. `paksa: true` tetap diterima **hanya lewat API** (pergi ke perilaku lama) untuk
kebutuhan sah seperti menagih semua golongan setelah server mati berhari-hari — panel tidak pernah
mengirimkannya. `audit_log` kini mencatat `{paksa, dibuat, dikirim, diperingat, isolir}`.

*Panel* — `jalankanSiklus()` membaca bentuk `r.langkah` yang baru (bug lama: ia membaca
`r.kirim` yang tidak pernah ada sehingga angka "dikirim WA" selalu 0), konfirmasi tombol menjelaskan
bahwa yang jalan hanya golongan yang harinya jatuh hari ini, dan toast kedua menampilkan alasan tiap
langkah yang dilewati. Dua tombol berisiko di sebelahnya ikut diberi pagar: konfirmasi `Buat Tagihan`
sekarang menyebut tegas bahwa ia **mengabaikan tanggal profil**, dan `Kirim WA semua` yang sebelumnya
tanpa konfirmasi (sekali klik langsung mengantrekan WA ke semua tagihan `buat`) kini bertanya dulu.

**Verifikasi (2026-10-11, produksi, dipasang 23:03 WIB)**

- **regresi utama terbalikkan:** tombol ditekan pada tanggal 11 di tenant yang 171 pelanggannya
  memakai profil `IVV-10` (buat tgl 1) → `buat.jalan:false`, `alasan:"tidak ada profil tagihan
  dengan tanggal buat 11 (jadwal server: 1)"`, **0 tagihan baru**. Perilaku lama membuat 171.
- **bukan sekadar dimatikan:** profil uji `UJI-SIKLUS-11` (buat 11 / kirim 12 / isolir 12) +
  satu pelanggan uji → tombol yang sama membuat **tepat 1** tagihan
  (`IVV-202610-11149`, `tanggal_buat 2026-10-11`, `jatuh_tempo 2026-10-12` dari profil, status
  `buat`) dengan laporan `bukan_hari: 171` dan `per_profil: {"UJI-SIKLUS-11":1}`; langkah kirim
  menjawab `tidak ada profil tagihan dengan tanggal kirim 11`.
- **idempoten:** ditekan lagi → `dibuat: 0, dilewati: 1`.
- **jalur scheduler tetap hidup setelah refactor:** pelanggan uji kedua (`UJI-SIKLUS2-11`) dibuat
  tanpa menekan tombol sama sekali; tick berikutnya menulis
  `[siklus 2026-10-11 23:05 Asia/Jakarta] Tagihan dibuat [2 IVVINET-CBD]: 1 {"UJI-SIKLUS2-11":1}`.
  Tidak ada pesan WA keluar dari keduanya (nomor kosong, `kirim_peringatan: 0`, tempo besok).
- **pulih:** 2 tagihan uji dihapus, pelanggan uji #174/#175 dan profil #5/#6 dihapus lewat API →
  `pelanggan=171`, `sisa_uji=0`, `profil_tagihan = 1:IVV-10, 2:IVV-10`, `hari_tagihan=10`.
  Yang tersisa hanyalah 171 tagihan `lunas` hasil kejadian 18:03 (bukan dari pengujian ini).
- `node --check` lolos untuk keempat berkas, `systemctl restart ivvibill` → `active`, log bersih.

**Catatan**

- Snapshot kelima berkas versi ini ada di `/root/bak-v201/` (dibuat **setelah** pasang — backup
  pra-deploy versi ini terlewat karena direktori subfolder belum dibuat; sumber acuan tetap
  mirror lokal `C:\Users\new\ivvi\`).
- Butuh keputusan user: 171 tagihan + baris `pembayaran` hasil insiden 18:03 membuat laporan
  pemasukan bulan ini tidak mencerminkan uang sungguhan. Pilihan: hapus baris itu (kembali ke
  kondisi sebelum 18:03) atau biarkan sebagai jejak dan koreksi manual. Tidak ada yang diubah
  sepihak.


## 2026-10-11 — v2.0.0 — "Hari Tagihan" per pelanggan diganti Profile Tagihan (7 kebijakan, tempo jadi nilai turunan)

**Masalah**

Penjadwalan tagihan dipegang oleh dua hal yang berbeda tempat: satu angka per pelanggan
(`pelanggan.hari_tagihan` = tanggal isolir/jatuh tempo) dan empat angka per data server
(`jadwal_buat_hari`, `jadwal_kirim_hari`, `jam_kirim`, `jadwal_limit_hari`). Akibatnya satu ISP
tidak bisa punya beberapa golongan: warga yang digaji tanggal 10 dan yang digaji tanggal 25
dipaksa memakai tanggal buat, tanggal kirim WA, mode PPN dan boleh/tidaknya pengingat H-3 yang
sama. Menggeser satu pelanggan berarti menggeser seluruh tenant.

**Diubah**

*Skema* — `sql/schema.sql` + `scripts/migrate-v19.js` (idempoten, sudah dijalankan di produksi):
tabel baru `profil_tagihan (id, id_data_server, nama, tanggal_buat, tanggal_kirim,
tanggal_isolir, kompensasi_desimal, ppn_mode ENUM('tanpa','ditambah','termasuk'),
kirim_peringatan, status)` dengan `UNIQUE (id_data_server, nama)`, dan kolom
`pelanggan.id_profil_tagihan`. `hari_tagihan` TETAP ADA tetapi menjadi **turunan**: setiap kali
pelanggan ditautkan/dipindah/diubah profilnya, `hari_tagihan` ditulis ulang sama dengan
`tanggal_isolir` profil itu — sehingga invoice, ekspor dan berkas impor lama tidak berubah makna.
Migrasi membuat profil default `PREFIX-<hari>` **dari jadwal tenant yang ada**, lalu menautkan
pelanggan per kelompok `hari_tagihan` yang sudah mereka pegang, jadi tidak ada satu pun tempo
pelanggan yang bergeser saat naik versi.

*`src/services/billing.js`* — kebijakan satu pelanggan dibaca dari satu tempat:
`kebijakan(p, srv)` → `{profil, buat, kirim, isolir, ppnMode, peringatan, kompensasi}`,
`hitungPpn(jumlah, persen, mode)`, `KOLOM_PROFIL` + `GABUNG_PROFIL`
(`LEFT JOIN profil_tagihan pt … AND pt.status='aktif' AND pt.id_data_server = p.id_data_server`,
lalu `COALESCE(pt.<kolom>, jadwal tenant)` di tiap pemakaian). `buatTagihanBulanan()` tidak lagi
berhenti kalau "hari tenant" bukan hari ini — cek harinya pindah ke per pelanggan
(`if (!force && hariIni !== k.buat) bukanHari++`), dan hasilnya melaporkan `per_profil`.
`adaProfilPadaHari(ds, kolom, hari, hariTenant)` menjawab "adakah pelanggan yang profilnya jatuh
hari ini" untuk gerbang scheduler; `kirimTagihanWajib`, `peringatanTagihan` dan `buatTagihanSatuan`
mengikuti profil yang sama.

*`src/scheduler.js`* — tiga gerbang hari (`tanggal_buat`, `tanggal_kirim`, isolir) memakai
`adaProfilPadaHari()` dengan fallback jadwal tenant, sehingga tenant tanpa profil berperilaku
persis seperti sebelumnya.

*`src/services/profilTagihan.js` (baru)* — CRUD + `tautkan()`. Hapus profil **ditolak** selama
masih dipakai ("Profil masih dipakai N pelanggan — pindahkan mereka ke profil lain dulu",
`e.status = 400` supaya tidak dicatat sebagai crash server). `ubah()` merambat ke `hari_tagihan`
seluruh pelanggan di profil itu.

*`src/routes/tagihan.js`* — `GET/POST/PUT/DELETE /api/profil-tagihan` +
`POST /api/profil-tagihan/terapkan` (tautkan massal ≤1000 id), masing-masing `requirePJ()` +
`requireMenu('profil_tagihan', …)` dan tercatat di `audit_log`. `GET /api/tagihan/jadwal`
menambah blok `profil: {data:[…jumlah_aktif, berikutnya_buat/kirim/isolir], tanpa_profil}`.

*`src/routes/pelanggan.js`* — `kebijakanTagihanPelanggan()` dipakai POST dan PUT; daftar dan
detail pelanggan mengirim `profil_tagihan` + `profil_tanggal_isolir`; ekspor menambah kolom
**Profile Tagihan** sebelum Hari Tagihan; template impor dan `HEADER_IMPOR` mengenal nama kolom
yang sama — nilai di file hanya dipakai bila kolom profil kosong, dan nama profil yang tidak ada
menjadi error per baris (`Profile Tagihan "x" tidak ditemukan (atau nonaktif) di data server ini`)
tanpa menggagalkan seluruh file.

*`src/routes/tenant.js`* — `profil_tagihan` didaftarkan sebagai menu sendiri (grant terpisah dari
Tagihan), jadi grup akses lama otomatis tidak melihatnya.

*Panel* — menu **🗓️ Profile Tagihan** (tabel 10 kolom + baris "Zona Asia/Jakarta, sekarang …"
yang merangkum jadwal berikutnya tiap profil), form 7 field sesuai contoh aplikasi lain dengan
ringkasan langsung di bawahnya, dropdown profil di form Pelanggan (berikut keterangan
"Hari Tagihan otomatis menjadi N"), kolom profil di daftar pelanggan, dan aksi massal
"Terapkan profil".

**Verifikasi (2026-10-11, produksi `bill.ivvinet.my.id`, tenant IVVINET-CBD)**

- migrasi nyata: `migrate-v19.js --dry-run` lalu asli → "Struktur OK — 2 perubahan diterapkan …
  tenant 2 IVVINET-CBD: profil default \"IVV-10\" dibuat (id 2, PPN tanpa) … 171 pelanggan
  (hari_tagihan=10) ditautkan, nilai tetap"; sebelum ALTER: `mysqldump` penuh ke
  `/root/pre-v20.sql` (1.078.617 byte) + cadangan berkas ke `/root/bak-v20/`
- **siklus otomatis lewat tick scheduler sungguhan** (bukan fungsi dipanggil manual): pelanggan
  uji `UJI PROFIL V20` ditautkan ke profil `UJI-V20-11` (buat 11 / kirim 11 / isolir 13) →
  log `[ivvibill …] [siklus 2026-10-11 11:23 Asia/Jakarta] Tagihan dibuat [2 IVVINET-CBD]: 1
  {"UJI-V20-11":1}` dan pada tick yang sama `Tagihan dikirim WA [2 IVVINET-CBD]: 1`. Barisnya:
  `IVV-202610-94623`, periode `2026-10`, jumlah 150000 + kode unik 761, `ppn 0.00` (mode tanpa),
  `tanggal_buat 2026-10-11` (= tanggal_buat profil, bukan tanggal server), `jatuh_tempo 2026-10-12`
  (= tanggal_isolir profil saat itu), status `terkirim`. **171 pelanggan nyata tetap 0 tagihan** —
  gerbang harinya per profil, bukan per tenant lagi
- nomor WhatsApp pelanggan uji kosong → tidak ada pesan baru di `wa_queue` (tetap 20 baris
  `koneksi_off` lama), tagihan tidak menggantung di status `buat`
- validasi API: `tanggal_buat: 30` → `{"error":"Maksimal 28"} 400`; nama duplikat →
  `Profil "IVV-10" sudah ada di data server ini 400`; hapus profil terpakai →
  `Profil masih dipakai 1 pelanggan … 400` (sebelum perbaikan `e.status` dulu 500)
- nilai turunan: `PUT /api/profil-tagihan/3` mengubah `tanggal_isolir 12 → 13` langsung membuat
  `pelanggan.hari_tagihan = 13`; `POST /terapkan` bolak-balik profil 2↔3 menulis
  `hari_tagihan` 10↔13 sesuai profil tujuan
- ekspor xlsx nyata (20.667 byte, dibaca ulang dengan SheetJS): judul
  `…|Status|Tanggal Masuk|Profile Tagihan|Hari Tagihan`, isi baris `UJI-V20-11` / `13`
- impor xlsx nyata 2 baris: `{"total":2,"sukses":1,"gagal":1,"detail":[{"baris":3,
  "error":"Profile Tagihan \"TIDAK-ADA\" tidak ditemukan (atau nonaktif) di data server ini"}]}`;
  baris yang lolos mendapat `id_profil_tagihan=3` dan `hari_tagihan=13` **mengalahkan** angka 99
  yang ditulis di file
- `GET /api/tagihan/jadwal` → `profil.data` per profil (`IVV-10` jumlah_aktif 171,
  `UJI-V20-11` jumlah_aktif 1, tanggal berikutnya 2026-11-01/02/10 dan 2026-11-11/11/10-13) +
  `tanpa_profil: 0`. Perbaikan `jumlah_aktif` diperlukan: subquery-nya dulu membandingkan
  `p.id_data_server = pt.id` (kebetulan benar untuk profil id 1 dan 2, salah untuk id ≥ 3)
- panel lewat browser: menu Profile Tagihan tampil, tabel + baris ringkasan jadwal benar, form
  "Ubah Profile Tagihan" terisi 7 field + keterangan turunan, dropdown profil di form Pelanggan
  terpilih benar (`UJI-V20-11 · tempo tgl 13`) dengan hint "buat tgl 11 · kirim WA tgl 11 · jatuh
  tempo & isolir tgl 13 · PPN termasuk · TANPA pengingat H-3 — Hari Tagihan otomatis menjadi 13",
  baris daftar pelanggan menampilkan `🗓️ UJI-V20-11 · tempo tgl 13`, dan kotak "Terapkan profil"
  ada di bilah aksi massal
- **pulih total:** tagihan uji dihapus, pelanggan uji #172 dan #173 dihapus lewat API, profil
  `UJI-V20-11` dihapus lewat API → `pelanggan(id_data_server=2)=171`, `tagihan=0`,
  `profil_tagihan = 1:ds1:IVV-10, 2:ds2:IVV-10`, seluruh 171 bertaut profil 2 dengan
  `hari_tagihan=10`, `wa_queue=20` (tidak berubah); dashboard panel kembali 171 aktif / belum
  lunas Rp 0

**Catatan**

- `kompensasi_desimal` disimpan, divalidasi, dan ditampilkan (mis. `2.500%/hari`) tetapi **belum
  memotong total tagihan** — sesuai keputusan "disimpan dulu". Pemotongan perlu keputusan terpisah
  (dasar hitung: per hari atau per bulan, dan apakah memotong PPN).
- Tombol **⟳ Jalankan Siklus** memakai `force=true`: ia membuat tagihan untuk SEMUA pelanggan
  tanpa memandang tanggal_buat profil. Setelah v2.0 ini makin terasa — kalau ditekan tanggal 11,
  seluruh tenant langsung punya tagihan yang jatuh temponya bisa sudah lewat. Sebaiknya hanya
  dipakai saat menagih manual.
- `POST /pelanggan` memang selalu menyimpan status `baru` (dropdown Status di form tambah tidak
  dipakai saat membuat — perilaku lama, tidak diubah di versi ini), sehingga pelanggan baru baru
  ikut siklus setelah tombol "Aktifkan".
- Di luar versi ini, jam 10:43–10:44 WIB hari yang sama, detektor issue mengirim 20 pesan
  `koneksi_off` ke pelanggan nyata (perilaku v1.9.1 yang sudah berjalan sebelumnya, bukan efek
  v2.0) — dicatat agar tidak dikira tagihan uji.
- Berkas cadangan: `/root/bak-v20/` (termasuk `tagihan.js.pre-jadwalfix`,
  `profilTagihan.js.pre-400fix`) dan dump `/root/pre-v20.sql`.


## 2026-10-11 — v1.9.1 — pembuangan sesi PPPoE memakai `?name=`, bukan `?user=` (isolir profile langsung terasa)

**Masalah**

`setProfilSecret()` (jalur isolir v1.8.0) dan `setDisabledSecret()` mencari sesi aktif pelanggan dengan
`['/ppp/active/print', '?user=' + nama]`. Di RO-IVVI (RouterOS 7.19.2) entri `/ppp/active` **tidak punya
atribut `user`** — print lengkap menghasilkan kunci `.id, name, service, caller-id, address, uptime,
encoding, session-id, limit-bytes-in, limit-bytes-out, radius`. Where-query pada atribut yang tidak ada
mengembalikan 0 baris, jadi `sesi_dibuang` selalu 0: profile isolir memang tertulis di secret, tetapi baru
berlaku saat pelanggan reconnect sendiri. Dengan uptime PPPoe 3 minggu lebih, "isolir" praktis tidak terasa.
(`pppoeActive()` di `src/services/routeros.js` sudah tahu quirk ini — ia membaca `r.user || r.name` — jadi
hanya dua where-query itu yang tertinggal.)

**Diubah**

*`src/services/monitoring.js`* — dua tempat, `?user=` → `?name=`:
di `setDisabledSecret()` (setelah `secret set disabled=yes`) dan di `setProfilSecret()`
(setelah `secret set profile=... disabled=no`), plus komentar alasan supaya tidak kembali.

**Verifikasi (2026-10-11, probe read-only ke RO-IVVI `ivvinet.my.id:8429`, tanpa `remove`)**

- `/ppp/active/print =.proplist=.id,name` → 198 sesi; nama sesi pertama `mamawacbln`
- query **lama** `?user=mamawacbln` → `0` baris; query **baru** `?name=mamawacbln` → `1` baris, `.id=*8028D6E5`
  → bentuk filter yang benar terbukti menemukan sesi yang sama sekali tidak ditemukan sebelumnya
- `node --check` lolos, `systemctl restart ivvibill` → `active`, log bersih; detektor app menulis
  `PPPoE offline: 20 / 171` → 151 pelanggan hasil import terhitung online, cocok dengan hitung probe
- **Belum diuji:** `remove` pada sesi pelanggan nyata (butuh memutus internet pelanggan aktif) —
  cabang ini baru terbukti sampai "sesinya ketemu dan `.id`-nya dapat".

**Catatan**

- Berkas cadangan sebelum perubahan: `/root/monitoring.js.bak-v191`.
- Efek lanjutan yang sekarang jadi mungkin: isolir otomatis tanggal 1 bukan lagi sekadar tulis profile,
  tapi benar-benar memutus dan menyambung ulang sesi dengan rate-limit baru.

---

## 2026-10-11 — v1.9.0 — siklus tagihan otomatis berjalan sungguhan (WIB) + aksi manual setaranya + fix kwitansi WA & pembayaran dobel

**Masalah**

1. **"Buat tagihan / kirim WA / isolir otomatis" tidak pernah jalan.** `tugasBilling()`
   membandingkan tanggal-jam hasil `new Date().getUTC*()` dengan `jadwal_buat_hari`,
   `jadwal_kirim_hari` dan `jam_kirim` yang diisi admin dalam jam dinding ISP (server ini
   WIB = UTC+7). Akibatnya `jam_kirim 07:00` baru tertembak pukul 14:00 WIB dan isolir
   pukul 16:00 WIB. Lebih parah lagi syaratnya `jam === jam_kirim` (cocok tepat menit):
   satu menit yang terlewat karena restart/reload membuat seluruh tenant kehilangan
   kiriman WA bulan itu, dan tidak ada cara untuk mengetahui kapan siklus berikutnya
   berjalan.
2. **Tidak ada jalur manual untuk dua hal yang paling sering dibutuhkan.** Operator tidak
   bisa mengirim tagihan tertentu ke WhatsApp pelanggan, dan tombol Isolir di panel hanya
   mengganti status DB tanpa efek yang sama dengan siklus otomatis (tanpa WA isolir, tanpa
   jejak di issue). Kalau cron gagal jalan, tidak ada "jalankan sekarang juga".
3. **Kwitansi (gambar) tidak pernah sampai.** Antrean WA jenis `lunas` selalu `gagal` dengan
   `HTTP 400 ... Invalid value: url_file` — `kirimSatu()` mengirim body `url`, sedangkan
   gateway WHAPI membaca `url_file`. Pesan gagal juga tidak terlihat di mana pun:
   `prosesAntrean()` hanya mengambil status `pending`, jadi percobaan kedua tidak pernah ada.
4. **Satu pelunasan tercatat dua kali di `pembayaran`.** Rute `POST /tagihan/:id/bayar` dan
   `POST /pembayaran/:id/verifikasi` sudah INSERT baris pembayaran sendiri, lalu
   `billing.lunaskanTagihan(..., {jumlah})` INSERT lagi. `kas` benar (satu entri), tapi
   laporan yang menjumlah `pembayaran` menghitung pemasukan dobel.

**Diubah**

*Skema — `scripts/migrate-v18.js` **baru** (idempoten, cek `information_schema`)*

- `tagihan.ingatkan_terakhir DATE` — penanda "pengingat hari ini sudah dikirim".
- `data_server.jam_peringatan VARCHAR(5) DEFAULT '08:00'` dan
  `data_server.jam_isolir VARCHAR(5) DEFAULT '09:00'` — jam mulai tiap langkah, per ISP.
- Kolom yang sama ada di `sql/schema.sql` untuk pemasangan baru. Indeks
  `idx_tagihan_server_status (id_data_server, status, jatuh_tempo)` sudah tersedia, jadi
  migrasi tidak menambah indeks.

*Waktu siklus — `src/util/tanggal.js`*

- `waktuSiklus()` mengembalikan `{zona, tanggal, periode, hari, jam}` berdasarkan jam dinding
  ISP (`TZ_TAGIHAN` → `TZ` → `Asia/Jakarta`, dihitung lewat `Intl` en-CA), bukan UTC.
- `normJam('7:5') → '07:05'`, nilai tak sah jadi `'00:00'`; `lewatJam(sekarang, target)`
  membandingkan menit.

*Siklus — `src/scheduler.js`*

- Semua langkah memakai `waktuSiklus()` dan ambang `lewatJam()` (bukan cocok tepat menit),
  sehingga siklus yang terlewat tersusul pada tick berikutnya tanpa kirim dobel (duplikat
  dicegah status/penanda, bukan jam).
- Langkah: buat tagihan (tgl `jadwal_buat_hari`) → kirim WA (tgl `jadwal_kirim_hari` sejak
  `jam_kirim`) → pengingat H-3 (tiap hari sejak `jam_peringatan`) → isolir (tiap hari sejak
  `jam_isolir`).
- Log berlabel zona asli: `[siklus 2026-10-11 01:54 Asia/Jakarta] Isolir [2 IVVINET-CBD]: 1
  (tidak ada sesi aktif)` / `(sesi aktif dibuang: n)` — operator bisa membuktikan layanan
  benar-benar diputus, bukan cuma status DB.
- `tugasWa()` kini memproses ulang pesan `gagal` (maks 4 percobaan) setelah antrean `pending`.

*Billing — `src/services/billing.js`*

- `buatTagihanBulanan()` memakai `waktuSiklus()`; jatuh tempo menghormati
  `pelanggan.hari_tagihan` bila terisi (`tanggalPerPeriode()` mengamankan tgl 29–31 → 28).
  Periode yang sama tidak dibuat dua kali.
- `kirimTagihanWajib()` memisahkan pelanggan tanpa nomor WA → `tanpa_nomor_wa`, siklus tetap
  jalan.
- `kirimTagihanSatuan(id)` **baru** — kirim/kirim ulang satu tagihan (semua status kecuali
  lunas; `lunas` punya jalur kwitansi sendiri).
- `peringatanTagihan()` hanya mengirim satu kali per tagihan per hari
  (`ingatkan_terakhir`) dan tetap menandai `buat/terkirim` yang lewat jatuh tempo.
- `isolirJatuhTempo()` membuka dengan self-heal `UPDATE ... status='jatuh_tempo'` untuk tagihan
  `buat/terkirim` yang tanggalnya sudah lewat, lalu isolir + `sinkronStatus` + WA isolir;
  mengembalikan `{isolir, router_gagal, tanpa_nomor_wa, daftar[].sesi_dibuang}`.
- `isolirManual()` / `aktifkanManual()` / `kirimWaIsolirPelanggan()` **baru** — tombol manual
  memakai efek yang sama dengan cron (router + WA + issue).

*Rute & UI*

- `GET /api/tagihan/jadwal` — zona, sekarang, jadwal buat/kirim/isolir + kapan berikutnya,
  `belum_terkirim`, `lewat_tempo`, `akan_isolir` (dftar ini didaftarkan sebelum `/tagihan/:id`).
- `POST /api/tagihan/:id/kirim`, `POST /api/tagihan/siklus` (superadmin/master; buat paksa →
  kirim → pengingat → isolir, dicatat ke `audit_log`).
- `POST /api/pelanggan/:id/status` dan aksi massal: isolir ⇒ WA isolir diantrekan +
  `issue_pelanggan`; aktifkan ⇒ issue menunggak/isolir dibersihkan. Respons membawa
  `router.cara`, `router.sesi_dibuang`, `wa_terkirim`.
- Panel Tagihan: baris `📤 WA` dan `🔒 Isolir`, tombol `⟳ Jalankan Siklus`, paragraf jadwal
  otomatis (`#tJadwal`). Panel Pengaturan: field jam pengingat & jam isolir.
  Pelanggan: badge profil isolir + toast yang membedakan "diturunkan" dan "dikembalikan".
- Menu WhatsApp: panel **Pesan gagal** + `POST /api/wa/ulangi`; `GET /api/wa/log` ikut
  mengembalikan `gagal`.

*Perbaikan*

- `kirimSatu()` mengirim `url_file` (sekaligus `url` untuk build WHAPI lain) sehingga kwitansi
  gambar terkirim; komentar pemakaian format gateway di kepala `src/services/wa.js` dilengkapi.
- `prosesAntrean(limit, idDataServer, status)` — status `gagal` dibatasi `MAX_PERCOBAAN = 4`.
- `lunaskanTagihan(..., {sudahDicatat})` — jalur panel tidak lagi menambah baris `pembayaran`
  kedua; webhook Midtrans/Flip tetap mencatat sendiri (tidak ada INSERT lain di sana).
- `simpanSetting()` ternyata tidak mengirim `jam_peringatan`/`jam_isolir` (field terlihat bisa
  diisi tapi tidak pernah tersimpan) — ikut dikirim sekarang.

**Verifikasi** — dijalankan langsung di VPS produksi dengan pelanggan uji "UJI SIKLUS
IVVIBILL" (tenant 2 IVVINET-CBD, secret PPPoE `ivviuji1`, WA tujuan nomor pemilik sendiri);
jadwal tenant 2 dipindah sebentar ke hari/jam berjalan supaya tick sungguhan yang bekerja,
lalu semuanya dihapus lagi.

- 01:52 tick otomatis `tugasBilling` membuat tagihan periode 2026-10 (`Tagihan dibuat
  [2 IVVINET-CBD]: 1`, total Rp 100.108, jatuh tempo 2026-10-01 mengikuti `hari_tagihan=1`).
- 01:54 otomatis: `Tagihan dikirim WA: 1` + `Isolir: 1`; `wa_queue` #1/#2 `terkirim`
  (`wa_log` response OK), `tagihan.status` jatuh_tempo, `pelanggan.status` isolir,
  `profil_sebelum_isolir=10-Mbps`, secret di RO-IVVI berubah ke profile `isolir-1M`.
- 02:04 otomatis: `Peringatan [2 IVVINET-CBD]: 1` untuk tagihan jatuh tempo besok
  (`wa_queue` `peringatan` terkirim, `ingatkan_terakhir=2026-10-11`) dan siklus manual
  berikutnya mengembalikan `0 pengingat` — dedup per hari terbukti.
- Panel (login `adminmaster`, tenant IVVINET-CBD): `📤 WA` → antrean terkirim; `Bayar` →
  lunas + kwitansi + `pelanggan.aktif` + secret kembali `10-Mbps`; `Isolir`/`Aktifkan` di
  daftar pelanggan bolak-balik menerapkan `isolir-1M` ↔ `10-Mbps`; `⟳ Jalankan Siklus`
  membuktikan idempoten (`0/0/0/0`, audit_log #51) lalu isolir (`isolir:1`, #54);
  `GET /api/tagihan/jadwal` tampil di form sesuai jam dinding ISP.
- Kwitansi WA: sebelum fix `gagal HTTP 400 url_file`; sesudah deploy, `WA ulang: {sent:1}`
  dan `wa_queue` #4 menjadi `terkirim` pada percobaan ke-2 — bukti retry + nama field benar.
- Pembayaran dobel: dua pelunasan pertama (kode lama) meninggalkan 4 baris; pelunasan setelah
  fix menambah tepat 1 baris (4 → 5) sementara `kas` tetap satu entri per pelunasan.
- Pengaturan: jam pengingat/isolir kini benar-benar tersimpan; kedua tenant dipulihkan ke
  1/2/10 + 07:00/08:00/09:00 dan dicek ulang dari `data_server`.
- Pemulihan: pelanggan/paket/tagihan/pembayaran/kas/issue/`wa_queue`/`wa_log` uji dihapus
  (semua tabel kembali 0), file kwitansi uji dihapus, secret `ivviuji1` dibuang dari router,
  dan `scripts/tmp-uji-siklus.js` dihapus dari webroot.
- **Belum terbukti:** cabang pembuangan sesi aktif (`/ppp/active/remove`) saat isolir, karena
  secret uji tidak pernah punya sesi PPPoE nyata (tidak ada perangkat yang dial-in). Jalur
  ganti profile dan `disabled=yes` memakai kode pembuangan sesi yang sama dan telah dibaca
  ulang; log siklus terbaru kini mencetak `(sesi aktif dibuang: n)` sehingga pelanggan online
  pertama yang diisolir akan membuktikannya di `/var/log/ivvibill.log`.

**Catatan**

- Perubahan belum di-commit ke GitHub; redeploy dari repo akan menimpanya (lihat daftar
  berkas di entri ini).
- `profile_isolir` per pelanggan opsional: kosong ⇒ perilaku lama (secret `disabled=yes`).
  Profile `isolir-1M` ditinggalkan di RO-IVVI; variant lain (isolir-512k, isolir-2M) belum
  dibuat.
- Tenant 2 punya paket hasil impor yang semuanya `nonaktif` dan `harga = 0` — tagihan
  bulanan untuk ISP itu baru akan terbentuk setelah paket diaktifkan/diisi harga.

---

## 2026-10-11 — v1.8.0 — isolir per pelanggan lewat profile PPPoE + profil Paket dipecah PPPoE/hotspot

**Masalah**

1. **Isolir memukul semua pelanggan dengan cara yang sama.** `sinkronStatus()` lama hanya
   bisa `disabled=yes/no` di `/ppp/secret`. Padahal operasional ISP membedakan tingkat
   isolir: pelanggan A boleh tetap online dengan 1M, pelanggan B dibatasi 512k, pelanggan C
   memang harus putus total. Tidak ada kolom di `pelanggan` untuk menyimpan pilihan per
   pelanggan, jadi admin harus mengubah profile manual di winbox dan panel kehilangan
   gambaran atas kondisi router yang sebenarnya.
2. **Menu Paket mencampur profil hotspot dan PPPoE.** Hanya ada satu kolom
   `paket.profile_hotspot`, label form-nya "Profile hotspot", dan opsi dropdown-nya diambil
   dari `/ip/hotspot/user/profile` — termasuk ketika `jenis='pppoe'`. Nilai di kolom itu
   tidak pernah dibaca router PPPoE (yang membaca `/ppp/profile`), sehingga kolom profil pada
   paket PPPoE selama ini hanya hiasan; `paket/sinkron` juga menulis nama profile router ke
   kolom hotspot apa pun jenis barisnya.

**Diubah**

*Skema — `scripts/migrate-v17.js` **baru** (idempoten, ada `--dry-run`; nama mengikuti urutan
skrip v12/v13/v15/v16, bukan versi patch dokumen ini)*

- `paket.profile_pppoe VARCHAR(64)` — nama profile di `/ppp/profile` untuk paket jenis pppoe.
- `pelanggan.profile_isolir VARCHAR(64)` — profile yang dipakai saat pelanggan diisolir.
- `pelanggan.profil_sebelum_isolir VARCHAR(64)` — profile asal secret, diisi otomatis.
- Backfill dijaga: nilai lama `profile_hotspot` pada baris `jenis='pppoe'` **disalin** ke
  `profile_pppoe` (kolom lama tidak dihapus supaya jalur sinkron lama tetap jalan), dan
  jumlah baris yang disalin hanya dihitung bila kolom barunya memang belum ada.
- `sql/schema.sql` memuat ketiga kolom yang sama untuk pemasangan baru.

*Service — `src/services/monitoring.js`*

- `setProfilSecret(user, {profil, idDataServer})` **baru**: cari secret berdasar `name`,
  **validasi dulu profile-nya ada di `/ppp/profile`** (RouterOS 7.19.2 menolak nilai asing
  dengan `input does not match any value of profile`), lalu `set profile=... disabled=no`,
  catat `profil_lama`, dan buang sesi aktif di `/ppp/active` karena pergantian profile hanya
  berlaku pada sesi baru. Mengembalikan `{router, profil, profil_lama, sesi_dibuang,
  tidak_ada, gagal}`.
- `sinkronStatus(p, status, idDataServer)` jadi jalur bersama rute status, tagihan jatuh
  tempo, dan pelunasan:
  - `isolir` + `profile_isolir` terisi dan profile ada di router → ganti profile
    (cara `profil`), `profil_sebelum_isolir` disimpan persis seperti aslinya, koneksi tetap
    naik dengan bandwidth terbatas.
  - `isolir` + profile tidak ada di router → fallback `disabled=yes` (cara `matikan`) dengan
    pesan kegagalan profile tetap ikut dikirim, jadi admin tahu kenapa.
  - `isolir` + `profile_isolir` kosong → persis perilaku lama (`disabled=yes`).
  - `aktif` + ada `profil_sebelum_isolir` → kembalikan profile asal lalu kolomnya dinolkan;
    kalau profile asal sudah dihapus admin router, secret tetap dihidupkan dengan catatan
    `profile '<x>' tidak ada di router — secret dihidupkan tanpa ganti profile`.
  - `nonaktif` → `disabled=yes` seperti sebelumnya.
- Ekspor modul: `setSecret, setProfilSecret, sinkronStatus, sesiTakTerkenal, routerTenant`.

*Rute*

- `src/routes/pelanggan.js`: `profilPaket(jenis, body, lama)` memisahkan kolom yang dibaca
  per jenis (hotspot → `profile_hotspot`, pppoe → `profile_pppoe`, dengan fallback ke kolom
  lama untuk data lama) dan `kunciProfil(p)` memilih kunci pencocokan router yang benar.
  `POST`/`PUT /api/paket` ikut menulis `profile_pppoe`; `POST /api/paket/sinkron` sekarang
  menyimpan nama profile router ke kolom yang cocok dengan `jenis` baris. `POST`/`PUT
  /api/pelanggan` membaca dan mengosongkan `profile_isolir` lewat `hasOwnProperty` (kosong
  berarti memang dikosongkan, bukan "tidak dikirim") dan men-sinkron ulang ke router ketika
  status isolir atau profil isolir-nya yang berubah.
- `src/routes/monitoring.js`: `GET /api/profil-mikrotik?jenis=hotspot|pppoe` **baru** —
  mengembalikan daftar profile dari jalur router yang benar (`/ip/hotspot/user/profile` atau
  `/ppp/profile`) beserta field `jalur` di respons; `/api/hotspot/profil` lama tetap utuh.
- `src/services/billing.js`: `isolirJatuhTempo()` ikut menyeleksi `profile_isolir,
  profil_sebelum_isolir` dan memanggil `mon.sinkronStatus(..., 'isolir', ...)`;
  `lunaskanTagihan()` memanggil `mon.sinkronStatus(p, 'aktif', t.id_data_server)` sehingga
  pelunasan mengembalikan profile asal, bukan sekadar mengaktifkan secret.

*Panel — `public/panel/index.html` + `public/panel/panel.js` (`?v=20261011c`)*

- Modal Paket: header kolom daftar berubah menjadi "Durasi · Profil router", label form ikut
  `kJenis` ("Profile PPPoE (MikroTik)" vs "Profile hotspot"), teks penjelasan menyebut jalur
  router yang dipakai, opsi dropdown diisi ulang dari `/api/profil-mikrotik` sesuai jenis,
  paket tanpa profil menampilkan `ikut nama paket`, dan baris paket nonaktif diberi penanda.
- Modal Pelanggan: baris baru **"Profile isolir (khusus PPPoE)"** (`#fIsolir` + datalist
  `#dlIsolir` yang terisi dari `/ppp/profile`) dengan hint "tiap pelanggan bisa beda,
  koneksi tetap naik hanya dibatasi. Kosong = secret dimatikan". Baris daftar pelanggan
  menampilkan `🔒 <profile>` saat statusnya isolir.
- `plgStatus()` memberi toast berbeda untuk jalur profil ("... diterapkan · koneksi tetap
  naik, hanya dibatasi") dan jalur matikan secret.

**Verifikasi (dijalankan di produksi lewat panel, semua data uji dikembalikan persis)**

- Profile isolir dibuat di RO-IVVI: `/ppp/profile add name=isolir-1M rate-limit=1M/1M`.
  **Profile ini sengaja ditinggal** sebagai starter isolir.
- Pelanggan uji `ivvitest1` (paket 10-Mbps) diisolir dari tombol panel →
  DB `{status: isolir, profile_isolir: isolir-1M, profil_sebelum_isolir: 10-Mbps}` dan
  router `{".id": "*190", name: ivvitest1, profile: isolir-1M, disabled: false}` — secret
  tidak dimatikan, hanya dibatasi.
- Klik Aktifkan → DB `{status: aktif, profil_sebelum_isolir: null}` dan router kembali
  `profile: 10-Mbps`.
- Jalur lama: `profile_isolir = NULL` lalu isolir → router `disabled: true` (perilaku lama
  utuh).
- Profile tidak dikenal (`tidak-ada-xyz`) → secret tetap `10-Mbps`/`disabled: true` dan
  panel melaporkan `profile 'tidak-ada-xyz' tidak ada di /ppp/profile`, bukan 500.
- Menu Paket: form PPPoE menampilkan label "Profile PPPoE (MikroTik)" + keterangan
  `/ppp/profile — secret PPPoE pelanggan memakai profil ini; kosong berarti ikut nama
  paket`; saat jenis dipindah ke hotspot, daftar options berganti ke
  `/ip/hotspot/user/profile`. Simpan menghasilkan `profile_pppoe=10-Mbps,
  profile_hotspot=NULL`; setelah tombol sinkron dan pengembalian manual, kedelapan baris
  `paket` kembali `profile_hotspot=NULL, profile_pppoe=NULL` seperti semula.
- Pembilasan: tabel `pelanggan` kosong lagi, secret `ivvitest1` dihapus dari router, paket
  `Lumpia` utuh, dan tidak ada baris error baru di `/var/log/ivvibill.log`.

**Catatan**

- Semua perubahan masih **belum di-commit** (12 berkas + `scripts/migrate-v17.js` berstatus
  untracked di working tree produksi). Deploy ulang yang menimpa webroot dari repo akan
  **menghapus** fitur ini; migrasinya sendiri idempoten jadi aman dijalankan lagi setelah
  source diperbaiki.
- Isolir lewat profile tetap membuang sesi aktif pelanggan. Itu disengaja: RouterOS tidak
  menerapkan rate-limit profile baru pada sesi yang sudah jalan.
- Fitur yang sengaja tidak diubah: `paket.profile_hotspot` tetap ada sebagai fallback,
  `/api/hotspot/profil` lama tetap berfungsi, dan pelanggan non-PPPoE tidak dapat profil
  isolir (field-nya dinolkan saat `tipe='hotspot'`).

## 2026-10-09 — v1.7.0 — voucher dibersihkan serentak (cabut/hapus massal) + tabel Paket disinkronkan dengan profile bandwidth yang benar-benar ada di MikroTik

**Masalah**

1. **Menu Voucher tidak punya aksi serentak.** Satu voucher hanya bisa dicabut lewat
   tombol per baris. agen ISP mencetak 500 stok untuk promo yang dibatalkan, lalu
   harus mengklik 500 kali — dan baris `stok`/`batal` yang sudah tidak dipakai tidak
   bisa dibuang sama sekali, jadi daftar voucher terus membengkak.
2. **Paket hotspot harus diketik manual dan tidak pernah dibandingkan dengan router.**
   Nama profile di `/ip/hotspot/user/profile` ditulis tangan ke `paket.profile_hotspot`;
   salah satu huruf saja berarti generate voucher menolak (atau lebih buruk: user
   hotspot dibuat dengan profile yang salah). Tidak ada cara tahu profil apa yang ada
   di router, profil mana yang belum punya paket, dan paket mana yang profile-nya
   sudah dihapus admin router kemarin.

Tidak ada preseden di aplikasi pembanding (gratisinaja) untuk dua hal ini — keduanya
dirancang mengikuti konvensi ivvibill sendiri: parser body dan bentuk hasil meniru
`ubahStatusBulk` di rute pelanggan (`ids` array/CSV, maksimal 200, sukses dan gagal
dikirim terpisah), UI meniru kolom pilih + bar aksi massal yang sudah ada di Pelanggan.

**Diubah**

*Aksi massal voucher — `src/routes/agen.js`*

- `POST /api/voucher/bulk` **baru** (`requirePJ()` — superadmin/master saja; teknisi
  dan agen tidak ikut), guard menu per aksi: `cabut` ikut grant **voucher · generate**,
  `hapus` butuh grant **voucher · hapus** sendiri, sehingga grup akses yang hanya boleh
  mencetak stok tidak bisa menghapus baris.
- `voucherBulk()` memproses per baris dengan `tenantSql(req,'id_data_server')`, jadi
  id milik tenant lain masuk ke `gagal` (`Tidak ada di data server ini`) dan tidak
  mengubah apa pun. Maksimal 200 id per permintaan.
  - `cabut` = perilaku tombol Cabut yang sudah ada: user hotspot + `/system schedule`
    jatuh temponya dibuang di router, barisnya tetap ada dengan `status='batal'`,
    `router_status='belum'`. Masalah router dilaporkan di kolom `hasil`, tidak
    membatalkan pembatalan (sama seperti satu baris).
  - `hapus` = baris dibuang permanen, **hanya** untuk `stok`/`batal`. Voucher
    `terjual`/`terpakai`/`kedaluwarsa` ditolak dengan alasan
    `Status X — hanya stok/batal yang bisa dihapus`, karena baris itu riwayat penjualan
    agen: menghapusnya membuat saldo agen tidak bisa dicocokkan lagi.
    Penjaga kedua: kalau `router_status='ok'` tetapi router sedang tidak bisa
    dikonfirmasi, barisnya **tidak** dihapus — itu akan meninggalkan user hotspot aktif
    tanpa jejak di panel (internet gratis yang tidak bisa dicabut).
- Setiap baris yang berhasil dicatat ke `audit_log` sebagai `voucher_bulk_cabut` /
  `voucher_bulk_hapus` dengan kode voucher dan hasilnya.
- `hapusHotspotUser()` dipakai apa adanya dari v1.6 — satu sesi API per router untuk
  seluruh batch (400 voucher tidak berarti 400 koneksi).

*Baca profile router — `src/services/monitoring.js`*

- `profilRouter(idDataServer, jenis)` **baru** — `/ip/hotspot/user/profile/print` untuk
  hotspot, `/ppp/profile/print` untuk pppoe, `=.proplist=name,rate-limit,shared-users,
  disabled`, dan `name` tidak pernah dipakai mentah (`amanTeks`, membatasi panjang).
  Dua jenis punya nama kolom yang sama, jadi satu fungsi cukup. Router yang mati masuk
  ke `gagal` per perangkat, bukan menghanguskan seluruh permintaan.
- `profilHotspot()` tetap ada sebagai pembungkus tipis dengan bentuk respons lama
  (`{data:[{router,nama}],gagal}`) — `GET /api/hotspot/profil` dan form Paket v1.6 tidak
  berubah sedikit pun.

*Diff + impor paket — `src/routes/pelanggan.js`*

- `GET /api/paket/sinkron?jenis=hotspot|pppoe` **baru** (baca saja). Isinya:
  `baru` (profile di router yang belum jadi paket, lengkap dengan kecepatan dan daftar
  router yang memilikinya — profile dengan nama sama di dua router digabung sekali),
  `cocok` (sudah jadi paket: id + nama paket + statusnya), `hilang` (paket **aktif**
  yang profile-nya tidak ada lagi di router), `gagal`, `router`.
  Kunci pencocokan: hotspot → `profile_hotspot` (fallback `nama_paket`), pppoe →
  `nama_paket`; dibandingkan lower-case + trim, jadi `HS-10M` = `hs-10m`.
  Untuk pppoe ini masuk akal: ivvibill tidak pernah membuat secret PPPoE, jadi
  `nama_paket` memang nama profile-nya.
- `POST /api/paket/sinkron` (`requirePJ()` + grant **paket · tambah**) membuat paket dari
  profile terpilih, maksimal 100 nama, dan **selalu** `status='nonaktif'` dengan
  `harga 0` / `masa_aktif 30 hari` — paket hasil sinkron tidak mungkin langsung bisa
  dijual sebelum admin meng isi harga. `kecepatan` diambil dari `rate-limit` router,
  `profile_hotspot` hanya diisi untuk jenis hotspot, `deskripsi` mencatat router
  asalnya. Sebelum insert nama divalidasi ulang terhadap router: profile yang sudah
  hilang sejak halaman dibuka masuk `dilewati` (`Sudah tidak ada di router`), begitu
  juga nama yang sudah jadi paket (`Sudah jadi paket #N`) — jadi menekan tombol dua kali
  tidak membuat paket kembar. Dicatat ke `audit_log` sebagai `sinkron_paket`.
- Rute baru ini aman terhadap `GET /paket/:id` yang sudah ada — rute itu memang tidak
  pernah ada, jadi tidak ada bayangan `/paket/sinkron`.

*Panel — `public/panel/index.html` + `public/panel/panel.js`*

- Tabel Voucher dapat kolom **pilih** (`#vAll` pilih-sekalian) dan bar aksi massal
  (`#vBulkAksi`: Cabut dari router / Hapus permanen) yang hanya muncul saat ada baris
  terpilih; hasilnya di-toast terpisah (`N diubah`, `M gagal: alasan…`) supaya penolakan
  status terlihat, bukan didiamkan.
- Menu Paket dapat tombol **⟳ Sinkron dari Router** (`sinkronPaket()`) membuka modal
  `#mSinkron`: pemilih jenis hotspot/pppoe, muat ulang, daftar profile baru berbentuk
  tabel + checkbox, badge paket aktif yang profile-nya hilang, dan pesan kalau ada router
  yang tidak membalas. Fungsi panel tetap di berkas eksternal karena CSP
  `script-src 'self'`.

**Cara dipasang ke produksi**

```
sudo bash /home/bagus-nuralam/Documents/Qoder/2026-10-01/10533054/mt/install_fase2.sh
```

**Tidak ada perubahan skema dan tidak ada dependensi npm baru** — tidak ada migrasi v17,
`package.json` identik dengan produksi (jangan `npm install`/`npm ci`), kolom
`paket.profile_hotspot` yang dipakai fitur ini sudah dibuat migrasi v16. Yang dilakukan
installer: menimpa berkas target, `node scripts/migrate-v16.js` (idempoten, kali ini
"tidak ada perubahan"), naikkan versi `1.6.0 → 1.7.0`, sisipkan entri ini ke
`docs/PATCHES.md`, restart `ivvibill.service`.

Lalu periksa (baca-saja) dan komit:

```
bash /home/bagus-nuralam/Documents/Qoder/2026-10-01/10533054/mt/uji_produksi.sh
sudo /usr/bin/bash /home/bagus-nuralam/Documents/Qoder/2026-10-01/10533054/mt/commit_produksi.sh
```

`mt/uji_produksi.sh` dapat bagian **2h** (20 pemeriksaan: rute `voucher/bulk` +
`paket/sinkron`, pagar `hanya stok/batal`, `profilRouter()` + jalur `/ppp/profile/print`,
`profilHotspot()` pemanggil lama tidak rusak, audit `sinkron_paket`, empat fungsi panel,
`#vAll` `#vBulkAksi` `#mSinkron` `#skJenis`, tombol sinkron, dan ketiga endpoint menolak
401 tanpa cookie).

**Catatan**

- **Sinkronisasi hanya membaca router.** Yang dikirim ke MikroTik adalah `.../print` —
  tidak ada `add`/`set`/`remove` di jalur ini, jadi ia aman dilakukan saat router produksi
  sedang membawa trafik. `PUSH_HOTSPOT=0` (staging) tidak menahannya dan memang tidak
  seharusnya; yang menahan hanya penulisan user hotspot/schedule.
- Paket hasil sinkron masuk **nonaktif** dan **harga 0**. Setelah diimpor: isi harga,
  harga agen, dan masa aktif di menu Paket, baru aktifkan. Tidak ada satu pun paket yang
  diubah atau dihapus oleh fitur ini — `hilang` hanya laporan, keputusan di tangan admin.
- `hapus` permanen sengaja menolak voucher yang sudah terjual/terpakai. Untuk membereskan
  stok rusak, pilih `cabut` dulu (batal + user router terbuang), lalu `hapus`.
- Verifikasi staging: `reset_staging → uji_staging (87/87) → uji_lanjutan (218/218;
  bagian 13 baru, 45 pemeriksaan) → node .uji-scheduler.js (SEMUA OK)`. Dry-run
  `uji_produksi.sh` ke staging (`ROOT=$PWD/stage/app B=http://127.0.0.1:3011`) 170 LULUS,
  2 GAGAL — keduanya hanya label versi (`src/config.js` staging tetap 1.4.2 dan
  `docs/PATCHES.md` staging tidak disisipi, karena keduanya dikelola installer di
  produksi), bukan fitur.
  Bagian 13 memakai **mock RouterOS** di `127.0.0.1:18728` yang encode/decode-nya
  mengimpor `RouterOS._encodeSentence`/`_decodeSentences` dari klien aplikasi, jadi
  protokolnya diuji sungguhan tanpa menyentuh perangkat siapa pun — satu-satunya router
  yang bisa dihubungi di staging adalah CCR1009 produksi, dan mock inilah yang membuat
  jalur baca profile bisa diuji. Mock + perangkat uji dihapus di akhir bagian.
- Bug yang ditemukan dan diperbaiki saat menguji: `p.router.join` di `POST /paket/sinkron`
  (kolom `router` di baris `profilRouter()` adalah nama perangkat, array hanya ada di
  diff GET) — 500 pada setiap impor paket. Tertangkap karena suite membandingkan isi
  `dibuat[]`, bukan hanya kode HTTP.

## 2026-10-09 — v1.6.0 — voucher benar-benar jadi user hotspot + jadwal jatuh tempo di router, remote ONU dari daftar Unmanage, ONU tersinkron ke pelanggan, router melapor sendiri ke panel

**Masalah**

Lima keluhan pemilik ISP, semuanya di jalur hotspot/MikroTik.

1. **Generate voucher tidak membuat apa pun di MikroTik.** Voucher hanya jadi baris
   di database. Tidak ada `/ip/hotspot/user`, tidak ada kolom status pengiriman,
   sehingga kalau router mati atau profile salah, admin tidak tahu dan voucher
   tetap terlihat " normal" di panel.
2. **Tidak ada jadwal jatuh tempo di sisi router.** Gratisinaja menaruh hitung
   mundurnya di router (skrip On Login membuat `/system schedule` per voucher yang
   membuang sesi + user + dirinya sendiri). ivvibill hanya mengandalkan `expired_at`
   di MySQL, jadi sesi hotspot tetap hidup setelah masa aktif habis sampai scheduler
   sempat lewat.
   Ternyata jatuh temponya sendiri **salah sejak dibuat**: `expired_at` dihitung di
   JavaScript dengan `toISOString()` (UTC) lalu ditulis ke kolom DATETIME, sementara
   seluruh jam di mesin ini WIB (+07). Voucher 3 jam sudah "kedaluwarsa" begitu
   tercetak, dan voucher harian mati jam 17.00.
3. **Tab Unmanage tidak punya Remote ONU.** Sesi PPPoE yang belum tercatat sebagai
   pelanggan bisa dilihat, tetapi teknisi tidak bisa membuka halaman router pelanggan
   itu seperti di menu Pelanggan.
4. **Data OLT tidak pernah sinkron ke pelanggan.** Kolom `master_onu.id_pelanggan`
   ada sejak skema v1.2 tetapi tidak pernah ditulis, sehingga kolom redaman di daftar
   pelanggan selalu kosong. Polling OLT juga membuat baris ONU baru setiap menit
   (tidak ada unique key) — satu ONU jadi puluhan baris.
5. **Unmanage dan status online ikut buta saat link RouterOS drop.** ivvibill selalu
   *menanyakan* sesi ke router lewat API; satu dari tiga percobaan connection ke
   CCR1009 biasa gagal, dan begitu itu terjadi daftar Unmanage kosong serta
   pelanggan sedang dipakai tetap terlihat offline. Aplikasi pembanding (gratisinaja)
   tidak mengalami ini karena routernya yang **melapor** sendiri: ada `/system script`
   + `/system schedule` yang tiap 40 detik meng-POST daftar sesi ke panel. Tombol
   **Test** di menu Perangkat ivvibill belum memasang apa pun di router.

**Diubah**

*Skema*

- `scripts/migrate-v16.js` **baru** — idempoten, ada `--dry-run`:
  `paket.satuan` ENUM('hari','jam'), `paket.profile_hotspot`, `voucher.router_status`
  /`router_nama`/`router_error`/`pushed_at` + `idx_voucher_push`, `master_perangkat.token_push`
  + `idx_perangkat_token`, tabel `sesi_router` (+`tanda_push`), dan di `master_onu`:
  unique `uq_onu_sn (id_perangkat, sn)` (baris duplikat dibuang lebih dulu, yang
  terakhir dipertahankan; `sn=''` dinormalkan jadi NULL supaya tidak saling tabrak),
  `matched_at`, `idx_onu_mac`.
- `sql/schema.sql` mengikuti, `match_by` kini `mac|loid|akun|nama|manual`.

*Jatuh tempo voucher*

- `src/routes/agen.js` — `expired_at` dihitung MySQL dengan
  `DATE_ADD(NOW(), INTERVAL ? HOUR|DAY)` (`masaAktif()`), bukan lagi `toISOString()`
  UTC. Durasi paket mengikuti `paket.satuan`, jadi "3 jam" benar-benar 3 jam.
- `src/scheduler.js` — `tugasVoucher()` **baru** (menit ke-1, otomatis jalan begitu
  layanan restart karena scheduler in-process; `POST /internal/cron/voucher` juga
  tersedia). Mengerjakan dua hal: (a) voucher lewat `expired_at` dibuang user hotspot
  + sesinya di router lalu statusnya jadi `kedaluwarsa`; (b) push yang `belum`/`gagal`
  dan masih berlaku dikirim ulang, ditunda setelah 7 hari. Antrean retry digabung per
  tenant + profile + satuan durasi, dan jadwal router hanya dibuat untuk voucher
  berstatus `terpakai` — stok yang belum dipakai tidak boleh menaruh schedule.

*User hotspot + schedule di router*

- `src/services/monitoring.js` — `pushVoucher()` sekarang satu-satunya penulis status
  push. `tambahHotspotUser()` mencetak daftar user sekali untuk satu batch, membuat
  `/ip/hotspot/user/add` (atau `set` bila sudah ada) dengan profile dari paket,
  memvalidasi profile benar-benar terdaftar di router (`profil_tidak_ada`), dan
  membersihkan karakter yang merusak argumen RouterOS. Setelah user jadi,
  `buatJadwalVoucher()` membuat `/system schedule`: `name=<kode>`,
  `start-date/start-time` dari jam router (`/system/clock/print`), `interval` sesuai
  masa aktif paket (3 jam → `3h`, 30 hari → `30d`), `recurring=no`, dan `on-event`
  yang membuang sesi aktif + user + schedule itu sendiri (nama schedule = kode
  voucher, jadi tidak bentrok dengan skrip On Login gratisinaja yang sudah ada).
  Kegagalan schedule **tidak** membatalkan voucher — dicatat di `router_error`
  sebagai `jadwal router gagal: …` dan disapu scheduler aplikasi.
  `hapusHotspotUser()` ikut menghapus entri `/system schedule` bernama sama.
- `src/routes/agen.js` — `POST /voucher/generate` menolak paket hotspot tanpa
  `profile_hotspot` (400 "isi di menu Paket") dan menolak profile yang tidak
  terdaftar di router sebelum voucher tercetak; responsnya kini
  `{ dibuat, terkirim, gagal, jadwal_gagal, router, profil_tidak_ada }`.
  `POST /voucher/:id/pakai` menjawab `expired_at` hasil `DATE_ADD` (login script
  hotspot perlu angka itu) dan me-retry push dengan jadwal yang benar.
  `POST /voucher/:id/push-ulang` **baru** (kirim ulang manual), dan
  `POST /voucher/:id/cabut` membatalkan stok + membuang user/schedule di router;
  voucher `terpakai` ditolak 400 supaya tidak bisa dipakai untuk menghapus diam-diam.
- `PUSH_HOTSPOT` (variabel lingkungan) — kalau `0`, semua push ditahan dan setiap baris
  ditandai `gagal: push hotspot dimatikan`. `mt/reset_staging.sh` memasangnya, jadi
  staging **tidak mungkin** menyentuh CCR1009 produksi. Perlu ditegaskan:
  `DISABLE_SCHEDULER` tidak melindungi router, karena push terjadi di dalam request HTTP.

*Remote ONU dari Unmanage*

- `src/routes/monitoring.js` — `POST /api/remote-onu` menerima `ip` langsung (selain
  `id_pelanggan`), `POST /api/pelanggan/:id/remote-onu` tetap, `GET /api/hotspot/profil`
  **baru** (daftar `/ip/hotspot/user/profile` router milik tenant untuk isian paket),
  `POST /api/olt/cocok` **baru** (jalankan pencocokan ONU kapan saja). Kunci remote
  180 detik + NAT dst-port tetap seperti v1.4; scoped clause diperbaiki ke
  `s.id_data_server` karena `setting_mikrotik JOIN master_perangkat` sama-sama punya
  kolom itu (dulu 500 "Column id_data_server is ambiguous").
- Panel — tab Unmanage dapat tombol **Remote ONU** per sesi, tabel Voucher dapat kolom
  **Router** (badge status + pesan galat, termasuk `jadwal router gagal`) dengan tombol
  **Push ulang** dan **Cabut**, form Paket dapat **Satuan masa aktif** + **Profile
  hotspot** (datalist terisi dari router), dan menu Perangkat dapat tombol
  **Cocokkan ONU ↔ Pelanggan**. Skrip panel ada di berkas terpisah (`panel.js`) karena
  CSP `script-src 'self'`.

*Router melapor sendiri — tombol Test memasang script + schedule*

- `src/services/monitoring.js` — `pasangPush(idPerangkat)` dipanggil **setelah**
  tombol **Test** di menu Perangkat berhasil menyentuh router. Ia menulis
  `/system script` bernama `IvvibillAPI` dan `/system schedule` bernama
  `SchIvvibill` (`interval=40s`, `on-event=/system script run IvvibillAPI`) —
  persis pola gratisinaja (`GratisinAjaAPI`/`SchGratisinAja`), dengan nama milik
  ivvibill sendiri supaya dua aplikasi di satu CCR1009 tidak saling menimpa;
  `pasangScriptPush` hanya membuat/memperbarui nama milik ivvibill dan tidak pernah
  menghapus milik aplikasi lain. Skripnya satu baris (aman lewat API RouterOS),
  mengumpulkan `/ppp active` + `/ip hotspot active` masing-masing dalam
  `:do { } on-error={ }` sehingga router tanpa hotspot tetap jalan, lalu `/tool fetch`
  POST ke `BASE_URL/api/router/push?token=<token perangkat>`. Token 40 karakter hex
  dibuat sekali dan disimpan di `master_perangkat.token_push` — menekan Test berulang
  tidak mengganti kunci yang sudah terlanjur ada di router.
- `src/routes/webhook.js` — `POST /api/router/push` **tanpa login**, dibuka dengan
  token perangkat (`401` kalau hex tidak sah, `404` kalau token tidak dikenal, `400`
  kalau perangkatnya OLT). `server.js` memasang `express.raw` khusus untuk rute ini
  karena `/tool fetch` mengirim JSON dengan content-type form; tanpa itu
  `express.urlencoded` global mengubah payload jadi key-value acak.
- `src/services/monitoring.js` — `simpanPush()` menyimpan snapshot sesi ke
  `sesi_router`, membuang sesi yang tidak ikut dilaporkan pada push berikutnya
  (penanda per laporan, bukan per detik — `DATETIME` hanya berpresisi 1 detik sehingga
  `seen_at < NOW()` kehilangan sesi yang putus di detik yang sama), menyegarkan
  `pppoe_status` pelanggan yang dikenali, menutup issue `offline`, dan mengisi
  `setting_mikrotik.uptime`/`board_name`. `sesiSnapshot()` dipakai daftar Unmanage saat
  API router mati, jadi baris hasil laporan berlabel `(laporan router)`
  (`dari='snapshot'`). Push **tidak pernah** menandai pelanggan offline: satu router
  hanya tahu sesinya sendiri.
- `src/routes/monitoring.js` — `GET /api/perangkat` mengembalikan `push_terpasang`,
  `push_lihat` (kapan router terakhir melapor) dan `push_sesi`; token tidak pernah
  dibaca keluar. Panel menampilkan `push N sesi · <waktu>` atau `push belum dipasang`
  di kolom status, dan hasil Test berisi `push dibuat tiap 40s`.
- `PUSH_HOTSPOT=0` juga menahan `pasangPush()` — staging memakai kredensial router
  produksi, dan tanpa penjaga ini menekan Test di staging akan memasang schedule yang
  menembak `127.0.0.1:3011`.

*Sinkron ONU ↔ pelanggan*

- `src/services/onu.js` **baru** — `simpan()` dipakai scheduler **dan** tombol Poll
  manual (dulu hanya scheduler yang menulis, jadi "Poll sekarang" menampilkan ONU tanpa
  pernah menyimpannya), plus `cocokkan()` bertingkat meniru gratisinaja:
  MAC ONU → `pelanggan.mac_address`, lalu nama/LOID ONU → `username_pppoe`, lalu →
  `nama`. Baris `match_by='manual'` tidak pernah ditimpa, pelanggan tanpa pengenal
  tidak masuk peta, dan akun/nama di bawah 3 karakter diabaikan (terlalu mudah kena
  cocok kebetulan). Pelanggan dimuat sekali per tenant, bukan per ONU.

**Cara dipasang ke produksi**

`sudo bash /home/bagus-nuralam/Documents/Qoder/2026-10-01/10533054/mt/install_fase2.sh`

Tidak ada dependensi npm baru (`package.json` identik dengan produksi), jadi **jangan**
`npm install`/`npm ci`. Migrasi v16 hanya `ADD COLUMN`/`ADD INDEX`/`ADD UNIQUE`/`CREATE TABLE`,
`DELETE` baris duplikat `master_onu`, dan `ALTER ... +tanda_push`; aman diulang. Setelah
restart, `tugasVoucher()` langsung ikut scheduler in-process — tidak ada crontab yang perlu
ditambah.

Supaya router mulai melapor: buka menu **Perangkat**, tekan **Test** pada setiap perangkat
MikroTik. Hasil Test sekarang berisi `push dibuat tiap 40s` (atau alasan mengapa tidak).
Itu satu-satunya cara schedule `SchIvvibill` dipasang — tidak ada jalur otomatis yang
menulis ke router saat install.

Lalu periksa (baca-saja, tidak menyentuh data pelanggan) dan komit:

```
bash /home/bagus-nuralam/Documents/Qoder/2026-10-01/10533054/mt/uji_produksi.sh
sudo /usr/bin/bash /home/bagus-nuralam/Documents/Qoder/2026-10-01/10533054/mt/commit_produksi.sh
```

`mt/uji_produksi.sh` sekarang punya bagian **2g** (41 pemeriksaan v1.5 + v1.6: berkas,
rute, `DATE_ADD`, `tugasVoucher`, kolom/skema `token_push` + `sesi_router`, nama schedule
`SchIvvibill`, fungsi panel di berkas eksternal, endpoint menolak 401, dan penjaga bahwa
`.env` produksi tidak ikut memasang `PUSH_HOTSPOT=0`).

**Catatan**

- **Isi `paket.profile_hotspot` lebih dulu** untuk setiap paket hotspot (menu Paket).
  Tanpa itu generate menolak 400. Kalau nama profile tidak ada di router, generate juga
  menolak dan menampilkan daftar profile yang tersedia.
- Sintaks `/system schedule/add` **belum terbukti di CCR1009 produksi** — staging tidak
  punya perangkat MikroTik dan push-nya dimatikan. Sengaja dibuat tidak membatalkan
  voucher: kalau router menolak, `router_error` berisi `jadwal router gagal: …` di kolom
  Router dan jatuh tempo tetap dijalankan scheduler aplikasi. Cek generate pertama.
- Voucher yang sudah tercetak sebelum versi ini punya `expired_at` hasil bug UTC (terlalu
  cepat mati). Tidak diubah otomatis — kalau masih stok, pakai **Cabut** lalu generate
  ulang, atau perbaiki `expired_at`-nya lewat menu.
- Unique `uq_onu_sn` membuang baris ONU duplikat. Log redaman (`redaman_log`) tidak ikut
  terhapus, jadi riwayat grafiknya utuh.
- **Schedule push hanya dibuat saat menekan Test** pada perangkat MikroTik — tidak ada
  yang berubah di router sampai tombol itu ditekan, dan `token_push` baru terisi saat
  itu. Router harus bisa mencapai `BASE_URL`; kalau panel hanya bisa lewat nama host
  ber-TLS yang tidak dipercaya `/tool fetch`, isi `PUSH_URL` di `.env` dengan alamat
  yang dijangkau router (mis. `http://10.x.x.x:3010`) — `urlPush()` memprioritaskannya.
  Kalau keduanya kosong, Test mengembalikan `push gagal: BASE_URL/PUSH_URL belum diisi` dan
  tetap menjawab hasil uji koneksi seperti sebelumnya.
- Schedule `SchIvvibill` interval 40 detik berarti satu POST per router per 40 detik.
  Rate limiter global `/api` (240/menit) masih longgar untuk beberapa router, tetapi
  bila jumlah router bertambah, `BATAS_SESI` (2000 sesi per laporan) dan penanda
  `tanda_push` yang menjaga tabel `sesi_router` tetap kecil.
- Verifikasi staging: `install_staging -> reset_staging -> uji_staging (87/87) ->
  uji_lanjutan (173/173, termasuk 24 pemeriksaan bagian 12 tentang push sesi) ->
  uji_scheduler (SEMUA OK, `{"hangus":2,"dicabut":0,"terkirim_ulang":0,"ditunda":0}`)`.
  Dry-run `uji_produksi.sh` ke staging: 152/152. Empat pemeriksaan membuktikan guard
  `PUSH_HOTSPOT=0` menahan baik push voucher maupun pemasangan schedule router, sehingga
  staging tidak mungkin menulis ke CCR1009 produksi.

## 2026-10-08 — v1.5.0 — login akun role dibetulkan, absensi teknisi berkoordinat, template impor/ekspor berbahasa Indonesia

**Masalah**

Tiga keluhan pemilik ISP sekaligus.

1. **Aplikasi Agen / Karyawan-Teknisi / Akun Saya menolak login.** Penyebabnya bukan
   sandi, melainkan akun yang dibuat dari panel dalam keadaan tidak lengkap:
   - `id_data_server` kosong → `tenantSql()` menghasilkan `AND 1 = 0`, jadi login
     "berhasil" tetapi setiap daftar kosong dan setiap tulis ditolak;
   - role `agen`/`pelanggan` tanpa `id_ref` (atau `id_ref` milik data server lain) →
     aplikasi tidak tahu agen/pelanggan mana yang sedang masuk;
   - password dibiarkan kosong saat membuat akun, dan username berisi spasi
     menghasilkan 500 alih-alih pesan yang bisa dikerjakan.
   Karena respons `/api/auth/login` sengaja umum ("Username atau password salah"),
   admin tidak punya cara melihat alasan penolakan yang sebenarnya.
2. **Tidak ada catatan kehadiran teknisi lapangan.** Pemilik hanya bisa menanyakan
   "tadi ke lokasi jam berapa" lewat WA.
3. **Template impor pelanggan membingungkan.** Judul kolom memakai nama teknis
   (`username_pppoe`, `hari_tagihan`, ...) dan ada kolom `kode` yang sebenarnya
   digenerate sistem, sehingga pengguna mengisi kolom itu lalu bingung mengapa
   isinya diabaikan.

**Diubah**

*Login & akun role*

- `src/routes/lain.js` — validasi saat membuat/mengubah akun: role non-superadmin
  wajib punya data server (`tenantUntukRole`), `agen`/`pelanggan` wajib menunjuk
  baris agen/warga yang benar-benar ada **dan** berada di data server akun itu
  (`validasiRef`), password wajib saat pembuatan, username dibersihkan dari spasi.
  `PUT /pengguna/:id` kini memperbaiki `id_ref` yang salah (dulu kolom itu tidak
  pernah diperbarui, jadi akun rusak tidak bisa disembuhkan dari panel).
- `src/routes/auth.js` — setiap percobaan login dicatat beserta alasannya di kolom
  baru `login_attempt.alasan`: `sukses, sandi_salah, akun_blokir, belum_tenant,
  belum_ref, username_tidak_ada, master_tanpa_sandi, server_nonaktif, langganan_habis`.
  Alasan hanya dibaca admin; respons ke pemohon tetap umum.
- `GET /api/pengguna/login-gagal` **baru** — 25 penolakan terakhir, sudah dipotong
  per tenant. `GET /api/pengguna` ikut mengeluarkan `gagal_login`.
- Blokir otomatis (5× salah sandi) bisa dibuka dari panel: `PUT /pengguna/:id`
  dengan `status: aktif` sekaligus menolkan `gagal_login`.
- Panel (`public/panel/index.html`, `public/panel/panel.js`) — kolom **Ref** dan
  **Gagal** di daftar pengguna, tombol **Buka blokir**, panel "Percobaan login gagal"
  dengan alasan berbahasa Indonesia, dan form Tambah/Ubah Pengguna memakai
  **pemilih Ref** (cari nama, bukan mengetik angka) yang ikut daftar data server
  yang diketik di form — jadi Ref milik ISP lain tidak bisa lagi terpilih.
  Password ditandai wajib dan data server terisi otomatis.

*Absensi teknisi*

- Tabel `absen_teknisi` + `src/routes/absen.js` **baru**:
  `POST /api/absen` (masuk/pulang), `GET /api/absen/saya`, `GET /api/absen` (monitor).
  Satu teknisi satu baris per hari (`uq_absen_hari` + `INSERT IGNORE`), jadi absen
  ulang cukup memperbarui jam/titik. Koordinat **hanya dicatat, tidak pernah
  menolak** — tidak ada aturan "terlalu jauh dari kantor". Yang ditolak hanyalah
  bentuk nilai yang salah atau separuh (`lat` tanpa `long`). Jarak masuk→pulang
  dihitung Haversine dan ditulis ulang setiap kali: bila salah satu titik direkam
  tanpa GPS, jarak lama dikosongkan supaya panel tidak menampilkan angka di baris
  bertanda "tanpa GPS".
- Aplikasi teknisi — tab **Absensi**: tombol Absen Masuk / Absen Pulang, lokasi dari
  `navigator.geolocation`, dan riwayat 31 hari. Bila HP menolak izin GPS atau sinyal
  hilang, pesan ditampilkan dan absen **tetap tersimpan** tanpa koordinat.
- Panel — menu **Absensi Teknisi**: rekap per teknisi (hari absen, masuk+pulang
  lengkap, tanpa koordinat, total jarak) + catatan harian per tanggal, filter rentang
  tanggal dan per teknisi, tiap titik ada tautan ke OpenStreetMap. Untuk sesi
  platform, setiap baris diberi label data servernya (`tenantSql` memang tidak
  memfilter untuk superadmin platform); master ISP hanya melihat teknisi miliknya.
- `src/routes/tenant.js` — entri menu `absen`; tab Absensi di aplikasi teknisi sengaja
  **tidak** digrant grup (sama seperti Order Pekerjaan) supaya kehadiran teknisi tidak
  bisa disembunyikan dari dirinya sendiri.

*Template impor/ekspor pelanggan*

- `src/routes/pelanggan.js` — judul kolom ekspor & template memakai Bahasa Indonesia
  (`Nama, Tipe, Paket, Agen, Username PPPoE, ..., Hari Tagihan`), kolom **Kode dibuang**
  dari template dan ekspor (saat impor nama kolom lama tetap dikenali, jadi berkas
  lama masih jalan), lembar kedua "Petunjuk" (13 baris) di xlsx dan baris `#` di CSV,
  pesan galat "kolom tidak dikenali" menyebutkan kolom yang hilang, dan teks modal
  Import ditulis ulang.

*Perkakas*

- `scripts/migrate-v15.js` **baru** — idempoten, `--dry-run` tersedia.
- `sql/schema.sql` — `absen_teknisi` + `login_attempt.alasan`.
- `server.js` — pasang rute absen; pola pesan galat validasi ditambah
  (`bukan data server`, `dikenali`, ...) supaya 400 bukan 500.
- `mt/daftar_target.sh`, `mt/install_fase2.sh` — peta pemasangan + rantai migrasi
  (`multitenant -> v12 -> v13 -> collation -> v15`) dan lompatan versi `1.4.2 -> 1.5.0`.
- `mt/uji_staging.sh` 57 pemeriksaan (bagian 9 tautan akun role, bagian 10 absensi),
  `mt/uji_lanjutan.sh` 125 pemeriksaan (bagian 10 blokir otomatis + template Indonesia
  + jarak absen + DOM panel/teknisi).

**Cara dipasang ke produksi**

`sudo bash /home/bagus-nuralam/Documents/Qoder/2026-10-01/10533054/mt/install_fase2.sh`
— tidak ada dependensi npm baru, jadi jangan `npm install`/`npm ci`. Migrasi v15 hanya
`CREATE TABLE` dan satu `ADD COLUMN`, aman diulang.

**Catatan**

- Akun role yang sudah ada dan rusak (tanpa data server / tanpa Ref) **tidak** diubah
  otomatis — migrasi tidak menebak pemiliknya. Buka menu Pengguna, ubah akun itu,
  isi data server dan pilih Ref dari daftar, simpan; kalau sandinya hilang, isi
  password baru di form yang sama.
- GPS memerlukan konteks aman. Di `http://ivvinet.my.id` (belum HTTPS) browser
  desktop menolak `geolocation`; di HP Android/Chrome lokasi tetap jalan lewat HTTP
  untuk host `localhost`/jaringan lokal, tetapi perilaku "tanpa koordinat" adalah
  jalur resmi, bukan kegagalan.
- Verifikasi staging: `reset_staging -> uji_staging (57/57) -> uji_lanjutan (125/125)
  -> uji_scheduler (SEMUA OK)`, plus pengecekan manual lewat browser untuk panel
  (Pengguna, Absensi) dan aplikasi teknisi/agen/pelanggan.

## 2026-10-08 — v1.4.2 — uji export/import + unggahan >2MB tak lagi HTTP 500

**Masalah**

Export/template/import pelanggan (fitur sejak v1.1.3 yang belum pernah diuji
sesi audit ini) diuji penuh untuk pertama kali. Satu bug ditemukan: unggahan
file >2MB (batas multer) jatuh ke **HTTP 500 "File too large"** — pesan itu
tidak dikenali pemeta 400 di error handler, sehingga penolakan unggahan oleh
pengguna dilaporkan sebagai kesalahan server.

**Diubah**

- `server.js` — error handler menerjemahkan kode batas multer lebih dulu:
  `LIMIT_FILE_SIZE` → **413** "Ukuran file melebihi batas yang diizinkan",
  kode `LIMIT_*` lain (ekstensi/lapangan tak terduga) → **400**, sebelum pola
  pesan validasi yang memetakan sisanya ke 400/500.
- `src/config.js` + `package.json` — versi **1.4.2**.

**Cara dipasang ke produksi**

Tanpa perubahan aset: `sudo systemctl restart ivvibill` — perubahan hanya di
kode server yang dimuat saat proses start.

**Verifikasi (staging: DB clone `ivvibill_staging`, port 3011)**

- **Uji API export/import 71/71 lulus (exit 0)**: tanpa sesi semua endpoint
  401; template xlsx (lembar Pelanggan+Petunjuk, header 15 kolom, 2 baris
  contoh) dan template CSV (BOM `efbbbf`, baris `#`); export xlsx/csv header
  identik template, jumlah baris = total, filter `?q=` ikut mengendalikan;
  import menolak 400: tanpa file, `.exe`, header `nama` hilang, >1000 baris,
  file hanya komentar — dan **>2MB kini 413**; round-trip xlsx 3 baris
  (1 sukses, 2 gagal per baris dengan nomor & pesan jelas), duplikat username
  ditolak, CSV ber-komentar masuk, re-import file export tidak crash.
- **Isolasi tenant**: baris import mengikuti tenant aktif di DB
  (ds=2 → `id_data_server=2`), teknisi ber-tenant satu hanya melihat &
  mengimpor tenantnya sendiri, pindah tenant ditolak 403; superadmin tetap
  pemilik platform yang melihat semua tenant (desain `scope.js`).
- **Uji UI panel 13/13 lulus (exit 0)**: login form → link Template & Export
  benar (terbawa filter `q`/`status`/`tipe`) → dialog Import unggah CSV 2 baris
  → hasil "1 dari 2 … 1 gagal: Baris 3 — X: Minimal 2 karakter" → baris muncul
  di daftar.
- Audit API regresi **0 temuan / 180 OK**; tiap unggahan tercatat di
  `audit_log` sebagai `import_pelanggan`.

## 2026-10-08 — v1.4.1 — pemilih koordinat klik-di-peta pada form Pelanggan & Topologi

**Masalah**

Koordinat pelanggan (`latitude`/`longitude`) dan titik ODP (`titik_koordinat`)
hanya bisa diisi dengan **mengetik angka**. Padahal sejak v1.4.0 peta sebaran
hanya menampilkan pelanggan yang koordinatnya terisi — artinya operator harus
mencari titik di Google Maps, menyalin angka, lalu menempelkannya ke form.
Pekerjaan itu rawan salah ketik (urutan lat/long terbalik, koma jadi titik), dan
bila meleset pelanggan tampil di kota lain. Form berisi kolom koordinat memang
terasa "kaku" — persis keluhan yang memicu audit.

**Diubah**

- `public/panel/index.html` — dua wadah peta baru: `#fPeta` di modal Pelanggan
  (setelah kolom Latitude/Longitude) dan `#tpPeta` di modal Topologi ODP
  (setelah kolom Titik Koordinat), plus kelas `.peta-pick` (tinggi 240px).
- `public/panel/panel.js` — blok **PEMILIH KOORDINAT**:
  * `petaPilih(id, cfg)` membangun Leaflet (layer Satelit/Peta) sekali per modal
    dan menyimpannya di `PETA_PILIH` — Leaflet menolak container yang sudah
    terpakai, jadi modal yang dibuka berulang tidak membuat peta dobel;
    `invalidateSize()` dijadwalkan 80 ms setelah modal dibuka.
  * `petaPilihSinkron(id)` — sumber kebenaran tetap isi form: bila ada nilai →
    taruh pin (bisa diseret, `dragend` menulis balik ke kolom), bila kosong →
    pusatkan ke titik ODP terpilih (fallback: ODP pertama, lalu pusat bawaan).
    Peta hanya berpindah bila titik keluar dari tampilan, jadi tidak "melompat"
    saat pengguna menggeser peta.
  * `cfgPetaPelanggan()` (kolom terpisah `fLat`/`fLong`) dan `cfgPetaTopologi()`
    (satu kolom `tpKoor` berformat "lat, long"); keduanya memvalidasi rentang
    ±90/±180 lewat `koordinatDari()`.
  * Perubahan kolom lewat ketikan (`event change` pada `fLat`, `fLong`,
    `fTopo`, `tpKoor`) ikut memindahkan pin — dua arah saling sinkron.
- `formPelanggan()`/`formTopologi()` memanggil pemilih **setelah** `modalOpen()`
  (wadah harus sudah terlihat agar Leaflet menghitung ukurannya benar).
- `src/config.js` + `package.json` — versi **1.4.1**.

**Cara dipasang ke produksi**

Berkas statis panel: Express menyajikan `public/` dari disk tiap permintaan,
jadi perubahan langsung terbaca tanpa restart. Restart hanya perlu bila versi di
`src/config.js` ikut dinaikkan: `sudo systemctl restart ivvibill`.

**Verifikasi (staging: DB clone, port 3011, Firefox headless + geckodriver)**

- **Uji pemilih koordinat 25/25 lulus (exit 0)**: modal Pelanggan terbuka dengan
  peta (ubin termuat, 0 pelanggaran CSP, tinggi 240px) → klik tengah peta →
  `fLat`/`fLong` terisi otomatis (−7.061950 / 106.797409) + 1 pin → simpan →
  pelanggan ada di daftar dan **koordinat tersimpan persis seperti titik klik**
  (bukan nilai default) → buka lagi form Ubah → kolom & pin terbawa → ketik
  `fLat = -7.100000` + event `change` → **pin ikut berpindah** (posisi elemen
  berbeda sebelum/sesudah) → form Topologi: peta termuat, klik → `tpKoor`
  berformat "lat, long" → simpan → baris ODP baru muncul → konsol tanpa error
  JavaScript dan tanpa pelanggaran CSP.
- Audit UI semua 23 menu panel dijalankan ulang setelah perubahan:
  **24/24 lulus, exit 0** — tidak ada view yang rusak atau macet.

**Catatan**

Peta form memakai layer yang sama dengan halaman Peta Sebaran, jadi tetap
butuh akses internet ke ubin OSM/Esri (diizinkan CSP). `PETA_PILIH` memakai
`const` tingkat-skrip sehingga tidak terlihat dari skrip luar (WebDriver) —
uji memverifikasi lewat DOM (posisi elemen pin), bukan membaca variabel internal.

## 2026-10-08 — v1.4.0 — Peta sebaran (Leaflet) + audit 132 rute: field wajib tak lagi 500

**Masalah**

1. **Peta tidak ada.** Aplikasi lama gratisinaja punya halaman *Maps Topologi*
   (`pages/maps_marker_topologi.php` + `load/maps_marker.php|maps_export.php`):
   Leaflet dengan marker ODP & pelanggan, layer satelit/OSM, refresh 30 detik,
   ekspor KML/KMZ. Di ivvibill kolom koordinat hanya menghasilkan tautan
   `📍 koordinat` ke Google Maps — tidak ada satu pun halaman peta, padahal
   latitude/longitude pelanggan dan titik ODP sudah tersimpan di database.
2. **Field wajib yang tidak dikirim berujung HTTP 500.** `v.str`/`v.num`/`v.enumOf`
   berdefault `def = null`, jadi nilai yang hilang **diam-diam menjadi NULL** dan
   jatuh ke constraint database. Audit terhadap 132 rute menemukan 11 titik yang
   membalas `500 Column 'nama' cannot be null` (POST pelanggan, paket, agen,
   topologi, desa, perangkat, rekening, kas, data-server, group-akses) dan
   `500 Agen tidak ada` — semestinya 400/404.
3. **Grant grup akses tidak lengkap.** `MENU` di `tenant.js` tidak memuat
   `topologi`, `desa`, `noc`, `keuangan`, `tiket` (menu v1.2.0) — kunci itu
   dibuang `bersihkanAkses()`, sehingga grup yang memilih menu tersebut tidak
   pernah menerima izinnya dan pengguna bergroup tidak pernah melihat menu baru.
4. **PUT pelanggan lintas tenant ditolak salah.** `validasiLokasi()` memeriksa
   relasi ODP/desa dengan *tenant aktif* (picker), bukan tenant milik baris,
   sehingga superadmin/user multi-tenant mengubah pelanggan tenant lain selalu
   kena `400 "Topologi tidak ada di data server ini"`.
5. `DELETE /api/data-server/:id` untuk id yang tidak ada membalas `200 {ok:true}`.

**Diubah**

- `src/routes/peta.js` **baru** — `GET /api/peta` mengembalikan `odp` (termasuk
  hasil parsing `titik_koordinat` "lat, long" + jumlah port terpakai),
  `pelanggan` (koordinat, status koneksi `pppoe_status`, paket, ODP), `pusat`,
  `tanpa_koordinat`, dan `jumlah`. `GET /api/peta/export?fmt=kml|kmz` menyusun
  dokumen KML (gaya sama dengan gratisinaja: style `#odp`/`#on`/`#off`) dan KMZ
  = ZIP metode STORE + CRC32 buatan sendiri — **tanpa dependensi baru**.
  Keduanya dijaga `requireAuth` + `requireRole(superadmin|master|teknisi)`.
- **Scoping peta mengikuti tenant AKTIF** (`req.ds`), bukan "semua tenant" untuk
  pemilik platform: marker lintas-ISP bercampur tidak terbaca dan lokasi
  pelanggan adalah data sensitif satu ISP.
- `server.js` — mount `/api/peta`; CSP `imgSrc` menambah
  `https://tile.openstreetmap.org` + `https://*.arcgisonline.com` (tanpa ini ubin
  peta diblokir dan halaman tampil kosong); handler error kini menghormati
  `err.status` dan pola ke-400 diperluas (`tidak ada`, `belum diatur`,
  `tidak aktif`, `terlalu panjang`, `kosong`, `dikenali`, `bukan milik`).
- `public/assets/vendor/leaflet/` **baru** — leaflet.js + leaflet.css + gambar
  marker/layer versi 1.9.4 sebagai **vendor lokal** (lolos `script-src 'self'`,
  mengikuti cara chart.umd.min.js dipasang).
- Panel — menu **Peta Sebaran** (grup *Master & Keuangan*), view Leaflet dengan
  layer Satelit/Peta, marker ODP (kotak biru) + pin pelanggan berwarna status
  (hijau online, merah offline/isolir, abu register/nonaktif), popup berisi
  paket/alamat/tautan Google Maps, ringkasan hitungan, legenda, tombol
  **Muat ulang / Unduh KML / Unduh KMZ**; refresh otomatis 30 detik yang
  **berhenti sendiri** begitu halaman ditinggalkan; `JUDUL` + `LABEL_MENU` ikut
  ditambah.
- `src/util/validate.js` — konvensi **wajib isi**: opsi `def` yang tidak dikirim
  berarti kolom wajib (`400 "Nilai wajib diisi"`); kolom opsional tetap menulis
  `def: null`/`def: <nilai>` secara eksplisit. `str`/`num`/`enumOf`.
- `src/routes/tenant.js` — `MENU` bertambah `topologi, desa, noc, keuangan,
  tiket, peta`; `DELETE /data-server/:id` memeriksa keberadaan baris dulu (404).
- `src/routes/pelanggan.js` — `validasiLokasi(req, body, def, dsBaris)` memakai
  tenant baris saat PUT.
- `src/config.js` + `package.json` — versi **1.4.0**.

**Cara dipasang ke produksi**

Tidak ada dependensi baru — **jangan** `npm install`/`npm ci`. Cukup salin
berkas berubah lalu `sudo systemctl restart ivvibill` (atau
`sudo bash mt/install_fase2.sh` bila memakai rantai installer).

**Verifikasi (staging: DB clone `ivvibill_staging`, port 3011, scheduler mati)**

- **Audit API otomatis 132 rute** (sebelum perbaikan: 12 temuan — 11 POST 500 +
  DELETE 200; **sesudah: 0 temuan, 180 pemeriksaan OK**): semua rute GET wajib
  401 tanpa sesi (0 bocor), tidak ada 500, tidak ada rute literal tertangkap
  rute `:id`, DELETE id palsu → 404.
- **Uji peta 23/23** — termasuk isolasi tenant: tenant 1 melihat ODP/pelanggan
  miliknya saja, pindah ke tenant 2 hanya melihat miliknya, kembali ke tenant 1
  tidak bocor, KML ikut terfilter, tanpa sesi → 401, KMZ tervalidasi CRC oleh
  `zipfile` Python.
- **Uji browser (Firefox headless + geckodriver) 23/23**: layar login → masuk →
  reload → menu Peta → Leaflet terpasang, **ubin peta termuat tanpa satu pun
  pelanggaran CSP**, marker tampil, klik membuka popup, tombol unduh ada, dan
  **tidak ada polling `/api/peta` setelah halaman ditinggalkan**; konsol tanpa
  error JavaScript.
- **Audit UI semua 23 menu panel** — LULUS 24/24: tidak ada view yang macet di
  "Memuat…", tidak ada error JS/toast gagal/CSP di menu mana pun.
- Regresi: uji peta dijalankan ulang **setelah** perubahan `validate.js` (23/23)
  sehingga validasi baru tidak memutus jalur tulis yang valid (buat ODP, ubah
  koordinat pelanggan, buat tenant, pindah tenant).
- Database produksi dicek ulang: 33 tabel, **collation seragam
  `utf8mb4_unicode_ci` (0 selisih)**, kolom `tagihan.img_invoice`, `wa_queue.media`,
  `pelanggan.latitude/longitude`, `setting_mikrotik.port_remote`, tabel
  `invoice/invoice_item/kas/master_topologi/master_desa` semuanya ada, dan
  `tagihan.kode_unik` bertipe `smallint`.

**Catatan**

- Ubin peta diambil langsung dari OpenStreetMap/Esri, jadi browser pemakai
  harus bisa mengakses internet; marker hanya muncul bila kolom koordinat
  terisi (pelanggan tanpa koordinat dihitung dan ditampilkan di baris hint).
- Peta selalu mengikuti picker data server; untuk pengguna biasa picker sudah
  dibatasi tenant-nya oleh JWT.
- `validate.js` kini menolak field wajib yang hilang sebelum menyentuh database.
  Klien lupa mengirim kolom wajib akan menerima `400 "Nilai wajib diisi"`
  alih-alih `500` — pesan itu muncul di toast panel.

---

## 2026-10-07 — v1.3.1 — seragamkan collation database (perbaikan menu Pelanggan gagal)

**Masalah**

Menu Pelanggan di produksi melempar 500 dan mencatat error ini berulang di log:

```
ER_CANT_AGGREGATE_2COLLATIONS: Illegal mix of collations
(utf8mb4_0900_ai_ci,IMPLICIT) and (utf8mb4_unicode_ci,IMPLICIT) for operation '='
  at src/routes/pelanggan.js:180 (GET /api/pelanggan)
```

14 tabel (`pppoe_status`, `redaman_log`, `wa_queue`, `wa_log`, `setting_app`,
`setting_olt`, `login_attempt`, `audit_log`, `agen_mutasi`, `interface_log`,
`router_resource_log`, `issue_pelanggan`, `pesan_template`, `rekening`)
memakai collation bawaan MySQL 8 (`utf8mb4_0900_ai_ci`), sedangkan sisanya
`utf8mb4_unicode_ci` sesuai `sql/schema.sql`. Tabel-tabel itu dibuat sebelum
`schema.sql` menetapkan `COLLATE`, dan `CREATE TABLE IF NOT EXISTS` tidak
pernah menyentuhnya lagi.

Kegagalan muncul tepat pada perbandingan kolom string dua-tabel dengan
`IMPLICIT` collation — `redaman_log.sn = master_onu.sn` pada subquery
redaman di `GET /api/pelanggan` — sehingga daftar pelanggan (inti panel)
tidak bisa dibuka sama sekali. Kolom angka tidak terpengaruh, jadi tagihan
dan pembayaran tetap jalan; errornya mudah terlewat kalau hanya cek
`/api/health`.

**Diubah**

- `scripts/migrate-collation.js` **baru** — idempoten, baca
  `information_schema.TABLES` dan hanya menyentuh tabel yang collation-nya
  berbeda dari `utf8mb4_unicode_ci`. `ALTER TABLE ... CONVERT TO CHARACTER
  SET utf8mb4 COLLATE utf8mb4_unicode_ci` mengubah kolom + indeks sekaligus.
  Default database ikut diseragamkan lewat `ALTER DATABASE` supaya
  `CREATE TABLE` mendatang tanpa `COLLATE` eksplisit tidak kembali memakai
  bawaan MySQL 8. Mendukung `--dry-run`, dan setelah konversi memverifikasi
  ulang ke `information_schema` — bila masih ada sisa, skrip **gagal**
  (exit 1) alih-alih diam-diam melapor sukses.
- `mt/install_fase2.sh` — `node scripts/migrate-collation.js` ditambahkan
  ke rantai migrasi setelah `migrate-v13.js`, plus lompatan versi
  `1.3.0 -> 1.3.1`.
- `mt/daftar_target.sh` — `migrate-collation.js` masuk peta pemasangan.

**Cara dipasang ke produksi**

`sudo bash mt/install_fase2.sh` — jalankan seperti biasa; tidak ada
dependensi baru, jadi jangan `npm install`/`npm ci`. Rantai migrasi kini
menjalankan empat skrip (multitenant -> v12 -> v13 -> collation),
semuanya idempoten.

**Catatan**

Konversi menyalin ulang isi tabel (paling besar `interface_log`, ~3,5 MB
dari ~50 ribu baris) dan berlangsung di bawah kunci `ALTER`;
jalankan di lalu lintas sepi. Backup database wajib ada sebelum
dijalankan — `install_fase2.sh` sudah membuat `mysqldump` sendiri di
langkah 2.

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
