'use strict';
// ============================================================
// Billing — pembuatan tagihan, pembayaran manual & gateway,
// pelunasan, isolir, plus deteksi issue pelanggan PPPoE.
// ============================================================
const db = require('../db');
const cfgData = require('./configData');
const cfgApp = require('./configApp');
const wa = require('./wa');
const mon = require('./monitoring');
const kwitansi = require('./kwitansi');
const { tglIndo, waktuSiklus, normJam, lewatJam } = require('../util/tanggal');

/** 'YYYY-MM-DD' + 'DD' dengan pengaman tanggal akhir bulan (29..31 -> 28). */
function tanggalPerPeriode(periode, hari) {
  const h = Math.max(1, Math.min(28, Number(hari) || 1));
  return `${periode}-${String(h).padStart(2, '0')}`;
}

/** Nomor WA + tagihan terakhir belum lunas milik satu pelanggan (untuk WA isolir manual). */
async function konteksTagihanPelanggan(idPelanggan) {
  const p = await db.one('SELECT * FROM pelanggan WHERE id = ?', [idPelanggan]);
  if (!p) return null;
  const t = await db.one(
    `SELECT * FROM tagihan WHERE id_pelanggan = ? AND status != 'batal'
     ORDER BY (status = 'lunas'), jatuh_tempo ASC, id DESC LIMIT 1`, [idPelanggan]);
  return { p, t };
}

/**
 * Kirim pesan isolir ke WhatsApp pelanggan — dipakai jalur otomatis (tagihan
 * lewat tempo) dan jalur manual (tombol Isolir di daftar pelanggan), supaya
 * "sudah saya matikan" selalu ada bukti yang sampai ke warga.
 */
async function kirimWaIsolir({ pelanggan, tagihan, idDataServer }) {
  if (!pelanggan || !pelanggan.nomor_whatsapp) return false;
  const tpl = await wa.ambilTemplate('isolir', idDataServer);
  const pesan = wa.render(tpl, {
    usr: pelanggan.nama,
    inv: tagihan ? tagihan.nomor_invoice : '-',
    tot: tagihan ? Number(tagihan.total).toLocaleString('id-ID') : '-',
    lmt: tagihan ? tglIndo(tagihan.jatuh_tempo) : '-',
    lyn: 'layanan'
  });
  await wa.enqueue({
    tujuan: pelanggan.nomor_whatsapp, jenis: 'isolir', pesan,
    idRef: tagihan ? tagihan.id : null, idDataServer
  });
  return true;
}

/**
 * Kebijakan penagihan satu pelanggan: profil_tagihan bila ditautkan (dan masih
 * aktif), kalau tidak jadwal data_server seperti sebelumnya. `isolir` = hari
 * jatuh tempo; ia jadi sumber kebenaran tagihan.jatuh_tempo sekaligus nilai
 * turunan pelanggan.hari_tagihan.
 */
function kebijakan(p, srv) {
  const hari = (v, def) => {
    const n = Number(v);
    if (Number.isInteger(n) && n >= 1 && n <= 28) return n;
    const d = Number(def);
    return Number.isInteger(d) && d >= 1 && d <= 28 ? d : 1;
  };
  return {
    profil: p.profil_nama || null,
    buat: hari(p.profil_tanggal_buat, srv.jadwal_buat_hari),
    kirim: hari(p.profil_tanggal_kirim, srv.jadwal_kirim_hari),
    isolir: hari(p.profil_tanggal_isolir, p.hari_tagihan || srv.jadwal_limit_hari),
    // Tanpa profil: persis perilaku lama — PPN tenant selalu ditambahkan di atas
    // harga paket. Profil memilih mode-nya secara eksplisit.
    ppnMode: p.profil_ppn_mode || (Number(srv.ppn_persen || 0) > 0 ? 'ditambah' : 'tanpa'),
    peringatan: (p.profil_peringatan === null || p.profil_peringatan === undefined)
      ? 1 : Number(p.profil_peringatan),
    kompensasi: Number(p.profil_kompensasi || 0)
  };
}

/**
 * PPN sesuai mode profil, memakai persen dari data_server:
 *  'tanpa'    harga paket belum kena PPN  -> ppn 0, total = harga + kode unik
 *  'ditambah' PPN ditambahkan di atasnya  -> perilaku lama (jumlah * persen)
 *  'termasuk' harga sudah termasuk PPN    -> ppn hanya tampilan, total tidak naik
 */
function hitungPpn(jumlah, persen, mode) {
  const pct = Number(persen || 0);
  if (!pct) return 0;
  if (mode === 'ditambah') return Number((jumlah * pct / 100).toFixed(2));
  if (mode === 'termasuk') return Number((jumlah - jumlah / (1 + pct / 100)).toFixed(2));
  return 0;
}

/** Kolom profil yang ikut dibaca bersama pelanggan (NULL = ikut jadwal tenant). */
const KOLOM_PROFIL = `pt.nama AS profil_nama, pt.tanggal_buat AS profil_tanggal_buat,
       pt.tanggal_kirim AS profil_tanggal_kirim, pt.tanggal_isolir AS profil_tanggal_isolir,
       pt.ppn_mode AS profil_ppn_mode, pt.kirim_peringatan AS profil_peringatan,
       pt.kompensasi_desimal AS profil_kompensasi`;
const GABUNG_PROFIL = `LEFT JOIN profil_tagihan pt ON pt.id = p.id_profil_tagihan
     AND pt.status = 'aktif' AND pt.id_data_server = p.id_data_server`;

/**
 * Buat tagihan bulanan untuk periode berjalan.
 * Dipanggil cron harian; sejak v2.0 harinya dibaca PER PELANGGAN dari
 * profil_tagihannya (fallback: jadwal_buat_hari data_server), jadi satu tenant
 * bisa menagih golongan A tanggal 1 dan golongan B tanggal 15.
 * Periode, tanggal buat, dan jatuh tempo dihitung pada jam dinding ISP
 * (bukan UTC): pemilik ISP menyetel "tgl 1" dan "limit tgl 10" di menu
 * Pengaturan sambil melihat kalender WIB.
 * Jatuh tempo mengikuti tanggal_isolir profil; kalau tidak ada profil,
 * tetap memakai pelanggan.hari_tagihan seperti sebelumnya.
 */
async function buatTagihanBulanan(idDataServer, force = false) {
  idDataServer = cfgData.idTenant(idDataServer);
  const srv = await cfgData.getServer(idDataServer, true);
  const w = waktuSiklus();
  const periode = w.periode;
  const hariIni = Number(w.tanggal);

  const pelanggan = await db.q(
    `SELECT p.*, pk.harga, pk.nama_paket, ${KOLOM_PROFIL}
     FROM pelanggan p
     LEFT JOIN paket pk ON pk.id = p.id_paket
     ${GABUNG_PROFIL}
     WHERE p.id_data_server = ? AND p.status IN ('aktif','isolir') AND p.tipe = 'pppoe'`,
    [idDataServer]
  );

  let dibuat = 0, dilewati = 0, bukanHari = 0;
  const perProfil = {};
  for (const p of pelanggan) {
    const k = kebijakan(p, srv);
    if (!force && hariIni !== k.buat) { bukanHari++; continue; }

    const dup = await db.one(
      'SELECT id FROM tagihan WHERE id_pelanggan = ? AND periode = ? AND status != ?',
      [p.id, periode, 'batal']
    );
    if (dup) { dilewati++; continue; }

    const jumlah = Number(p.harga || 0);
    const kodeUnik = force ? 0 : Math.floor(Math.random() * 900) + 100; // kode unik 3 digit
    const ppn = hitungPpn(jumlah, srv.ppn_persen, k.ppnMode);
    const total = k.ppnMode === 'ditambah' ? jumlah + kodeUnik + ppn : jumlah + kodeUnik;
    const tanggalBuat = force ? w.hari : tanggalPerPeriode(periode, k.buat);
    const jt = tanggalPerPeriode(periode, k.isolir);

    const invoice = await cfgData.nomorInvoice(idDataServer);
    await db.insert(
      `INSERT INTO tagihan
       (id_data_server, id_pelanggan, nomor_invoice, periode, keterangan, jumlah, kode_unik, ppn, total, tanggal_buat, jatuh_tempo, status)
       VALUES (?,?,?,?,?,?,?,?,?,?,?, 'buat')`,
      [idDataServer, p.id, invoice, periode, p.nama_paket || 'Langganan',
       jumlah, kodeUnik, ppn, total, tanggalBuat, jt]
    );
    dibuat++;
    const namaProfil = k.profil || '(jadwal server)';
    perProfil[namaProfil] = (perProfil[namaProfil] || 0) + 1;
  }
  return { dibuat, dilewati, bukan_hari: bukanHari, periode, per_profil: perProfil };
}

/** Ada pelanggan yang profilnya jatuh pada hari `hari` untuk langkah tertentu? */
async function adaProfilPadaHari(idDataServer, kolom, hari, hariTenant) {
  const w = waktuSiklus();
  const hariIni = Number.isInteger(hari) ? hari : Number(w.tanggal);
  const fallback = Number(hariTenant) || 0;
  // Nama kolom profil -> kolom jadwal tenant lama, untuk pelanggan yang
  // belum ditautkan ke profil mana pun.
  const kolomTenant = { tanggal_buat: 'jadwal_buat_hari', tanggal_kirim: 'jadwal_kirim_hari',
    tanggal_isolir: 'jadwal_limit_hari' }[kolom];
  if (!kolomTenant) throw new Error('adaProfilPadaHari: kolom tidak dikenal: ' + kolom);
  let cadangan = fallback;
  if (!cadangan) {
    const srv = await cfgData.getServer(idDataServer, true);
    cadangan = Number(srv[kolomTenant] || 0);
  }
  const r = await db.one(
    `SELECT 1 AS ada FROM pelanggan p
     ${GABUNG_PROFIL}
     WHERE p.id_data_server = ? AND p.status IN ('aktif','isolir') AND p.tipe = 'pppoe'
       AND COALESCE(pt.${kolom}, ?) = ? LIMIT 1`,
    [idDataServer, cadangan, hariIni]
  );
  return !!r;
}

/**
 * Satu putaran siklus billing untuk SATU tenant, dengan gerbang yang sama
 * persis untuk scheduler maupun tombol "Jalankan Siklus" di panel: tiap langkah
 * hanya jalan bila ada pelanggan yang profil tagihannya jatuh hari ini
 * (tanggal_buat / tanggal_kirim) dan ambang jamnya sudah lewat. Dulu tombol
 * manual memakai force=true sehingga sekali klik langsung menagih SEMUA
 * pelanggan — termasuk golongan yang harinya masih jauh, dan jatuh temponya
 * bisa sudah lewat saat itu juga.
 *
 * Idempoten: memanggilnya berkali-kali pada hari yang sama tidak membuat
 * tagihan dobel (dicek periode) dan tidak mengirim WA dobel (status 'buat').
 * `srv` boleh baris hasil daftarTenant() scheduler atau getServer() rute —
 * yang dipakai hanya kolom jadwalnya.
 */
async function jalankanSiklusTenant(srv, w = waktuSiklus(), limit = 50) {
  const l = {};
  const belum = (teks) => ({ jalan: false, alasan: teks });

  // 1. buat tagihan periode berjalan — harinya dari profil per pelanggan
  if (await adaProfilPadaHari(srv.id, 'tanggal_buat', w.tanggal, srv.jadwal_buat_hari)) {
    l.buat = { jalan: true, ...(await buatTagihanBulanan(srv.id, false)) };
  } else {
    l.buat = { dibuat: 0, dilewati: 0, bukan_hari: 0, per_profil: {},
      ...belum(`tidak ada profil tagihan dengan tanggal buat ${w.tanggal} ` +
        `(jadwal server: ${Number(srv.jadwal_buat_hari) || '-'})`) };
  }

  // 2. kirim WA — pakai ambang "sudah lewat jam kirim", bukan "tepat di jamnya":
  //    satu menit yang terlewat (restart service) tidak boleh membuat bulan itu
  //    kehilangan kiriman. jam_kirim kosong berarti '00:00' = selalu boleh,
  //    persis perilaku scheduler lama.
  const jamKirim = normJam(srv.jam_kirim);
  if (!lewatJam(w.jam, jamKirim)) {
    l.kirim = { dikirim: 0, tanpa_nomor_wa: [], ...belum(`belum jam kirim ${jamKirim}`) };
  } else if (!(await adaProfilPadaHari(srv.id, 'tanggal_kirim', w.tanggal, srv.jadwal_kirim_hari))) {
    l.kirim = { dikirim: 0, tanpa_nomor_wa: [],
      ...belum(`tidak ada profil tagihan dengan tanggal kirim ${w.tanggal} ` +
        `(jadwal server: ${Number(srv.jadwal_kirim_hari) || '-'})`) };
  } else {
    l.kirim = { jalan: true, ...(await kirimTagihanWajib(srv.id, limit, w.tanggal)) };
  }

  // 3. pengingat H-3 — sekali per tagihan per hari (penanda ingatkan_terakhir)
  const jamPeringatan = normJam(srv.jam_peringatan || '08:00');
  l.peringatan = lewatJam(w.jam, jamPeringatan)
    ? { jalan: true, ...(await peringatanTagihan(srv.id, limit)) }
    : { diperingat: 0, ...belum(`belum jam peringatan ${jamPeringatan}`) };

  // 4. isolir tunggakan — hanya yang lewat jatuh temponya sendiri
  const jamIsolir = normJam(srv.jam_isolir || '09:00');
  l.isolir = lewatJam(w.jam, jamIsolir)
    ? { jalan: true, ...(await isolirJatuhTempo(srv.id)) }
    : { isolir: 0, daftar: [], router_gagal: [], ...belum(`belum jam isolir ${jamIsolir}`) };

  return { tanggal: w.hari, hari: w.tanggal, jam: w.jam, periode: w.periode, langkah: l };
}

/**
 * Satu tagihan manual — padanan tagihan_buat_satuan.php.
 * `keterangan` boleh diketik operator (uraian layanan internet), boleh juga
 * `jumlah` disetel sendiri bila bukan harga paket (proyek/harga nego).
 */
async function buatTagihanSatuan({
  idDataServer, idPelanggan, periode, keterangan = null,
  jumlah = null, diskon = 0, jatuhTempo = null
}) {
  const srv = await cfgData.getServer(idDataServer, true);
  const p = await db.one(
    `SELECT p.*, pk.harga, pk.nama_paket, ${KOLOM_PROFIL} FROM pelanggan p
     LEFT JOIN paket pk ON pk.id = p.id_paket
     ${GABUNG_PROFIL}
     WHERE p.id = ? AND p.id_data_server = ?`, [idPelanggan, idDataServer]
  );
  if (!p) throw new Error('Pelanggan tidak ditemukan di tenant ini');
  const k = kebijakan(p, srv);

  const per = periode || waktuSiklus().periode;
  const dup = await db.one(
    'SELECT id FROM tagihan WHERE id_pelanggan = ? AND periode = ? AND status != ?',
    [p.id, per, 'batal']
  );
  if (dup) return { sudah_ada: true, id: dup.id };

  const dasar = jumlah !== null && jumlah !== '' ? Number(jumlah) : Number(p.harga || 0);
  const potongan = Number(diskon || 0);
  const netto = Math.max(0, dasar - potongan);
  const kodeUnik = Math.floor(Math.random() * 900) + 100;
  const ppn = hitungPpn(netto, srv.ppn_persen, k.ppnMode);
  const total = k.ppnMode === 'ditambah' ? netto + kodeUnik + ppn : netto + kodeUnik;
  const uraian = keterangan || `${p.nama_paket || 'Langganan'} periode ${per}`;
  const jt = jatuhTempo || tanggalPerPeriode(per, k.isolir || srv.jadwal_limit_hari || 20);

  const nomor = await cfgData.nomorInvoice(idDataServer);
  const id = await db.insert(
    `INSERT INTO tagihan
     (id_data_server, id_pelanggan, nomor_invoice, periode, keterangan, jumlah, kode_unik, ppn, total, tanggal_buat, jatuh_tempo, status)
     VALUES (?,?,?,?,?,?,?,?,?,?,?, 'buat')`,
    [idDataServer, p.id, nomor, per, uraian, dasar, kodeUnik, ppn, total,
     waktuSiklus().hari, jt]
  );
  return { id, nomor, total, sudah_ada: false };
}

/** Susun + antrekan pesan WA satu tagihan. Dipakai siklus kirim dan tombol manual. */
async function antrekanWaTagihan(t, srv, idDataServer, jenis = 'tagihan') {
  const tpl = await wa.ambilTemplate(jenis, idDataServer);
  // Tautan bayar diambil dari pengaturan milik tenant ini (kunci base_url),
  // bukan dari kolom data_server — kolom itu memang tidak pernah ada, jadi
  // placeholder #lnk di template selama ini selalu terisi kosong.
  const basis = String(await cfgApp.nilai(idDataServer, 'base_url', '') || '').replace(/\/+$/, '');
  const pesan = wa.render(tpl, {
    usr: t.nama, inv: t.nomor_invoice, prd: t.periode,
    tot: Number(t.total).toLocaleString('id-ID'),
    lmt: tglIndo(t.jatuh_tempo),
    lnk: basis ? `${basis}/pelanggan` : ''
  });
  await wa.enqueue({
    tujuan: t.nomor_whatsapp, jenis, pesan, idRef: t.id, idDataServer
  });
}

/** Ambil baris tagihan + nama & nomor WA pelanggannya. */
async function tagihanWa(idTagihan) {
  return db.one(
    `SELECT t.*, p.nama, p.nomor_whatsapp FROM tagihan t
     JOIN pelanggan p ON p.id = t.id_pelanggan WHERE t.id = ?`, [idTagihan]);
}

/**
 * Kirim tagihan (status buat → terkirim) via antrean WA.
 *
 * Sejak v2.0 hari kirim dibaca dari profil_tagihan pelanggan (fallback
 * jadwal_kirim_hari data_server), jadi tagihan golongan A bisa keluar tanggal 2
 * sementara golongan B baru tanggal 16. `hariKirim` null berarti kirim semua
 * (dipakai tombol manual / force), sedangkan angka membatasi hanya profil yang
 * jatuh pada hari itu.
 */
async function kirimTagihanWajib(idDataServer, limit = 25, hariKirim = null) {
  idDataServer = cfgData.idTenant(idDataServer);
  const srv = await cfgData.getServer(idDataServer, true);
  const w = waktuSiklus();
  const hari = Number.isInteger(hariKirim) ? hariKirim : null;
  const tags = await db.q(
    `SELECT t.*, p.nama, p.nomor_whatsapp FROM tagihan t
     JOIN pelanggan p ON p.id = t.id_pelanggan
     ${GABUNG_PROFIL}
     WHERE t.id_data_server = ? AND t.status = 'buat'
       ${hari === null ? '' : `AND COALESCE(pt.tanggal_kirim, ?) = ?`}
     ORDER BY t.id ASC LIMIT ?`,
    hari === null ? [idDataServer, Number(limit)] : [idDataServer, srv.jadwal_kirim_hari, hari, Number(limit)]
  );
  let n = 0;
  const tanpaWa = [];
  for (const t of tags) {
    if (t.nomor_whatsapp) {
      await antrekanWaTagihan(t, srv, idDataServer);
    } else {
      // tanpa nomor, tagihan tidak boleh menggantung di 'buat' selamanya:
      // beri status terkirim + catatan supaya siklus berikutnya bersih
      tanpaWa.push(`${t.nomor_invoice} (${t.nama})`);
    }
    await db.run('UPDATE tagihan SET status = ? WHERE id = ?', ['terkirim', t.id]);
    n++;
  }
  return { dikirim: n, tanpa_nomor_wa: tanpaWa };
}

/**
 * Kirim / kirim ulang satu tagihan ke WhatsApp — tombol manual di daftar tagihan.
 * Boleh untuk status apa pun kecuali lunas (lunas punya jalur kwitansi sendiri).
 */
async function kirimTagihanSatuan(idTagihan, idDataServer = null) {
  const t = await tagihanWa(idTagihan);
  if (!t) throw new Error('Tagihan tidak ditemukan');
  if (t.status === 'lunas') return { ok: false, alasan: 'tagihan sudah lunas — pakai kirim kwitansi' };
  if (!t.nomor_whatsapp) return { ok: false, alasan: 'nomor WhatsApp pelanggan kosong' };
  const ds = Number(idDataServer || t.id_data_server);
  const srv = await cfgData.getServer(ds, true);
  await antrekanWaTagihan(t, srv, ds);
  if (t.status === 'buat') await db.run('UPDATE tagihan SET status = ? WHERE id = ?', ['terkirim', t.id]);
  return { ok: true, tujuan: t.nomor_whatsapp, invoice: t.nomor_invoice, status: t.status === 'buat' ? 'terkirim' : t.status };
}

/** Peringatan H-3 & penanda lewat jatuh tempo (satu kali per tagihan per hari).
 *  Profil bertanda `kirim_peringatan = 0` dilewati — dipakai untuk golongan
 *  pelanggan yang hanya boleh dihubungi pada hari H.
 */
async function peringatanTagihan(idDataServer, limit = 25) {
  idDataServer = cfgData.idTenant(idDataServer);
  const tags = await db.q(
    `SELECT t.*, p.nama, p.nomor_whatsapp FROM tagihan t
     JOIN pelanggan p ON p.id = t.id_pelanggan
     ${GABUNG_PROFIL}
     WHERE t.id_data_server = ? AND t.status IN ('terkirim','jatuh_tempo')
       AND t.jatuh_tempo BETWEEN CURDATE() AND DATE_ADD(CURDATE(), INTERVAL 3 DAY)
       AND (t.ingatkan_terakhir IS NULL OR t.ingatkan_terakhir < CURDATE())
       AND COALESCE(pt.kirim_peringatan, 1) = 1
     ORDER BY t.jatuh_tempo ASC LIMIT ?`,
    [idDataServer, Number(limit)]
  );
  let n = 0;
  const tanpaWa = [];
  for (const t of tags) {
    if (t.nomor_whatsapp) {
      const tpl = await wa.ambilTemplate('peringatan', idDataServer);
      const pesan = wa.render(tpl, {
        usr: t.nama, inv: t.nomor_invoice,
        tot: Number(t.total).toLocaleString('id-ID'),
        lmt: tglIndo(t.jatuh_tempo)
      });
      await wa.enqueue({ tujuan: t.nomor_whatsapp, jenis: 'peringatan', pesan, idRef: t.id, idDataServer });
    } else {
      tanpaWa.push(t.nomor_invoice);
    }
    // penanda per hari: siklus berjalan tiap menit sejak 08:00, tanpa ini
    // pelanggan dapat belasan pengingat dalam satu hari
    await db.run('UPDATE tagihan SET ingatkan_terakhir = CURDATE() WHERE id = ?', [t.id]);
    n++;
  }
  // tandai lewat jatuh tempo
  await db.run(
    `UPDATE tagihan SET status = 'jatuh_tempo'
     WHERE id_data_server = ? AND status IN ('terkirim','buat') AND jatuh_tempo < CURDATE()`,
    [idDataServer]
  );
  return { diperingat: n, tanpa_nomor_wa: tanpaWa };
}

/**
 * Buat kwitansi gambar untuk tagihan yang sudah lunas dan antrekan ke WA
 * pelanggan (padanan Pembayaran::kirimKwitansi di gratisinaja).
 * Dipakai saat pelunasan DAN saat tombol "kirim ulang" di panel.
 */
async function kirimKwitansi(idTagihan) {
  const t = await db.one('SELECT * FROM tagihan WHERE id = ?', [idTagihan]);
  if (!t) throw new Error('Tagihan tidak ditemukan');
  if (t.status !== 'lunas') return { ok: false, alasan: 'tagihan belum lunas' };
  const p = await db.one('SELECT * FROM pelanggan WHERE id = ?', [t.id_pelanggan]);
  if (!p || !p.nomor_whatsapp) return { ok: false, alasan: 'nomor WhatsApp pelanggan kosong' };

  const srv = await cfgData.getServer(t.id_data_server);
  const bayar = await db.one(
    `SELECT jumlah, metode, created_at FROM pembayaran
     WHERE id_tagihan = ? AND status = 'diterima' ORDER BY id DESC LIMIT 1`, [t.id]
  );
  const kw = kwitansi.buat({
    tagihan: t, pelanggan: p, server: srv,
    bayar: { tanggal: bayar && bayar.created_at, metode: bayar && bayar.metode }
  }, null, t.img_invoice);
  await db.run('UPDATE tagihan SET img_invoice = ? WHERE id = ?', [kw.file, t.id]);

  const tpl = await wa.ambilTemplate('lunas', t.id_data_server);
  const caption = wa.render(tpl, {
    usr: p.nama, tot: Number(t.total).toLocaleString('id-ID'),
    inv: t.nomor_invoice, srv: (srv && srv.nama_server) || '',
    ket: t.keterangan || '', prd: t.periode || '',
    tgl: tglIndo(bayar && bayar.created_at)
  }) || `Kwitansi pembayaran ${t.nomor_invoice}`;
  await wa.enqueue({
    tujuan: p.nomor_whatsapp, jenis: 'lunas', pesan: caption,
    media: kw.url, idRef: t.id, idDataServer: t.id_data_server
  });
  return { ok: true, url: kw.url, tujuan: p.nomor_whatsapp };
}

/** Pelunasan → status lunas + pesan WA + aktifkan kembali pelanggan.
 *  `sudahDicatat: true` dipakai jalur panel (bayar manual / verifikasi bukti):
 *  baris `pembayaran`-nya sudah dibuat pemanggil, jadi di sini hanya perlu
 *  nominal untuk kas. Tanpa flag ini satu pembayaran tercatat dua kali dan
 *  laporan pemasukan menghitungnya dobel.
 */
async function lunaskanTagihan(idTagihan, metode, { verifiedBy = null, ref = null,
  jumlah = null, sudahDicatat = false } = {}) {
  const t = await db.one('SELECT * FROM tagihan WHERE id = ?', [idTagihan]);
  if (!t) throw new Error('Tagihan tidak ditemukan');
  if (t.status === 'lunas') return { already: true };

  await db.run(
    'UPDATE tagihan SET status = ?, metode_bayar = ?, paid_at = NOW() WHERE id = ?',
    ['lunas', metode, idTagihan]
  );
  if (jumlah !== null && !sudahDicatat) {
    await db.insert(
      'INSERT INTO pembayaran (id_tagihan, jumlah, metode, status, ref, verified_by) VALUES (?,?,?,?,?,?)',
      [idTagihan, jumlah, metode === 'manual' ? 'manual' : metode, 'diterima', ref, verifiedBy]
    );
  }

  // catat pemasukan ke kas (laporan keuangan) — idempoten karena fungsi ini
  // sudah kembali lebih dulu bila tagihan sebelumnya lunas
  const nominal = Number(jumlah !== null ? jumlah : t.total);
  if (nominal > 0) {
    try {
      await db.insert(
        `INSERT INTO kas (id_data_server, tipe, kategori, jumlah, keterangan, id_ref, dibuat_oleh)
         VALUES (?, 'masuk', 'pembayaran', ?, ?, ?, ?)`,
        [t.id_data_server, nominal, `Invoice ${t.nomor_invoice} (${metode})`, idTagihan, verifiedBy]
      );
    } catch (_) { /* kas tidak boleh menggagalkan pelunasan tagihan */ }
  }

  const p = await db.one('SELECT * FROM pelanggan WHERE id = ?', [t.id_pelanggan]);
  let router = null;
  if (p) {
    await db.run('UPDATE pelanggan SET status = ? WHERE id = ? AND status = ?', ['aktif', p.id, 'isolir']);
    await db.run('DELETE FROM issue_pelanggan WHERE id_pelanggan = ? AND tipe IN (?,?)', [p.id, 'menunggak', 'isolir']);
    // Pelanggan yang diisolir ikut diputus/dibatasi di router, jadi pelunasan
    // harus mengembalikannya — kalau tidak, status bilang aktif tapi warga tetap
    // tidak bisa connect (atau connect dengan kecepatan isolir).
    if (p.tipe === 'pppoe' && p.username_pppoe) {
      try {
        router = await mon.sinkronStatus(p, 'aktif', t.id_data_server);
      } catch (e) { router = { router: null, gagal: [String(e.message).slice(0, 120)] }; }
    }
  }
  // Kwitansi gambar menyusul: gateway WA yang mati tidak boleh membatalkan
  // pelunasan (sama seperti gratisinaja — kegagalan kirim jadi peringatan).
  let kw = null, kwGagal = null;
  try { kw = await kirimKwitansi(idTagihan); }
  catch (e) { kwGagal = String(e.message).slice(0, 160); }
  return { ok: true, router, kwitansi: kw, kwitansi_gagal: kwGagal };
}

/**
 * Isolir pelanggan yang lewat jatuh tempo + pesan WA isolir.
 *
 * Siklusnya dibuat memulihkan diri: tagihan 'buat'/'terkirim' yang tanggalnya
 * sudah lewat ikut ditandai jatuh_tempo lebih dulu, jadi isolir tetap jalan
 * walaupun langkah peringatan/H-3 tidak pernah dijalankan (misalnya gateway WA
 * mati, atau cron sempat mati di jam 08:00).
 */
async function isolirJatuhTempo(idDataServer) {
  idDataServer = cfgData.idTenant(idDataServer);
  await db.run(
    `UPDATE tagihan SET status = 'jatuh_tempo'
     WHERE id_data_server = ? AND status IN ('buat','terkirim') AND jatuh_tempo < CURDATE()`,
    [idDataServer]
  );
  const tagihan = await db.q(
    `SELECT t.*, p.nama, p.nomor_whatsapp, p.tipe, p.username_pppoe, p.profile_isolir,
            p.profil_sebelum_isolir, p.id AS pid
     FROM tagihan t JOIN pelanggan p ON p.id = t.id_pelanggan
     WHERE t.id_data_server = ? AND t.status = 'jatuh_tempo' AND p.status = 'aktif'
     ORDER BY t.jatuh_tempo ASC LIMIT 50`,
    [idDataServer]
  );
  let n = 0;
  const routerGagal = [], tanpaWa = [], daftar = [];
  for (const t of tagihan) {
    await db.run('UPDATE pelanggan SET status = ? WHERE id = ?', ['isolir', t.pid]);
    // Status DB saja tidak membatasi layanan: secret PPPoE ikut diturunkan ke
    // profil isolir pelanggan (atau dimatikan kalau profilnya belum diisi),
    // dan sesi yang sedang naik dibuang supaya benar-benar terasa putusnya.
    let router = null;
    if (t.tipe === 'pppoe' && t.username_pppoe) {
      try {
        router = await mon.sinkronStatus(
          { id: t.pid, tipe: t.tipe, username_pppoe: t.username_pppoe,
            profile_isolir: t.profile_isolir, profil_sebelum_isolir: t.profil_sebelum_isolir },
          'isolir', idDataServer);
        if (!router || !router.router) {
          routerGagal.push(`${t.username_pppoe}: ${(router && router.gagal || []).join(' / ') ||
            'secret tidak ada di router tenant'}`);
        }
      } catch (e) {
        routerGagal.push(`${t.username_pppoe}: ${String(e.message).slice(0, 120)}`);
      }
    }
    await db.insert(
      'INSERT INTO issue_pelanggan (id_pelanggan, tipe, pesan) VALUES (?,?,?)',
      [t.pid, 'isolir', `Menunggak tagihan ${t.nomor_invoice} (Rp ${Number(t.total).toLocaleString('id-ID')})`]
    );
    const terkirim = await kirimWaIsolir({ pelanggan: t, tagihan: t, idDataServer });
    if (!terkirim) tanpaWa.push(`${t.nama || `#${t.pid}`} (${t.nomor_invoice})`);
    daftar.push({
      id: t.pid, nama: t.nama, invoice: t.nomor_invoice,
      cara: router && router.cara || (t.tipe !== 'pppoe' ? 'tanpa-router' : 'tidak-ada-secret'),
      sesi_dibuang: router ? Number(router.sesi_dibuang || 0) : 0,
      wa: terkirim
    });
    n++;
  }
  return { isolir: n, router_gagal: routerGagal, tanpa_nomor_wa: tanpaWa, daftar };
}

/**
 * Isolir manual sekarang juga (tombol Isolir di daftar pelanggan / aksi massal). * Sama seperti siklus otomatis: secret/profil di router dibereskan dan WA
 * isolir diantrekan — bedanya, di sini tagihan tidak perlu menunggu jatuh tempo.
 */
async function isolirManual(idPelanggan, idDataServer) {
  const p = await db.one('SELECT * FROM pelanggan WHERE id = ?', [idPelanggan]);
  if (!p) throw new Error('Pelanggan tidak ditemukan');
  const { t } = await konteksTagihanPelanggan(idPelanggan);
  let router = null;
  if (p.tipe === 'pppoe' && p.username_pppoe) {
    router = await mon.sinkronStatus(p, 'isolir', Number(p.id_data_server) || idDataServer);
  }
  await db.insert(
    'INSERT INTO issue_pelanggan (id_pelanggan, tipe, pesan) VALUES (?,?,?)',
    [idPelanggan, 'isolir', t ? `Isolir manual — tagihan ${t.nomor_invoice} (Rp ${Number(t.total).toLocaleString('id-ID')})`
      : 'Isolir manual dari panel']
  );
  const waTerkirim = await kirimWaIsolir({ pelanggan: p, tagihan: t, idDataServer });
  return { ok: true, router, invoice: t ? t.nomor_invoice : null, wa: waTerkirim };
}

/** Batalkan isolir manual: kembalikan profil/secret + hapus catatan issue. */
async function aktifkanManual(idPelanggan, idDataServer) {
  const p = await db.one('SELECT * FROM pelanggan WHERE id = ?', [idPelanggan]);
  if (!p) throw new Error('Pelanggan tidak ditemukan');
  let router = null;
  if (p.tipe === 'pppoe' && p.username_pppoe) {
    router = await mon.sinkronStatus(p, 'aktif', Number(p.id_data_server) || idDataServer);
  }
  await db.run('DELETE FROM issue_pelanggan WHERE id_pelanggan = ? AND tipe IN (?,?)',
    [idPelanggan, 'menunggak', 'isolir']);
  return { ok: true, router };
}

/**
 * Kirim WA isolir untuk satu pelanggan — dipakai jalur manual (rute status),
 * karena tombol Isolir di panel harus mengirim pesan yang sama dengan yang
 * dikirim siklus otomatis.
 */
async function kirimWaIsolirPelanggan(idPelanggan, idDataServer) {
  const ctx = await konteksTagihanPelanggan(idPelanggan);
  if (!ctx) return false;
  return kirimWaIsolir({
    pelanggan: ctx.p, tagihan: ctx.t,
    idDataServer: Number(ctx.p.id_data_server) || Number(idDataServer) || 1
  });
}

module.exports = {
  tglIndo, waktuSiklus, kebijakan, hitungPpn, adaProfilPadaHari,
  KOLOM_PROFIL, GABUNG_PROFIL, tanggalPerPeriode,
  buatTagihanBulanan, buatTagihanSatuan, kirimTagihanWajib,
  kirimTagihanSatuan, peringatanTagihan, lunaskanTagihan, isolirJatuhTempo,
  jalankanSiklusTenant,
  isolirManual, aktifkanManual, kirimWaIsolir, kirimWaIsolirPelanggan, kirimKwitansi
};
