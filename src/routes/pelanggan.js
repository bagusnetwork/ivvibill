'use strict';
// ============================================================
// Pelanggan + Paket API — semua query terisolasi per tenant.
// Akses: superadmin (semua tenant), master (tenant miliknya),
//        teknisi (baca + update terbatas), pelanggan (dirinya),
//        agen (pelanggan hotspot-nya)
// ============================================================
const express = require('express');
const multer = require('multer');
const XLSX = require('xlsx');
const db = require('../db');
const v = require('../util/validate');
const { requireAuth, requireRole, requirePJ } = require('../middleware/auth');
const { tenantSql, tenantAktif, requireMenu } = require('../util/scope');
const wa = require('../services/wa');
const mon = require('../services/monitoring');
const csv = require('../util/csv');

const router = express.Router();
router.use(requireAuth);

// ---------------------------------------------------------- paket
router.get('/paket', async (req, res, next) => {
  try {
    const ts = tenantSql(req, 'id_data_server');
    const rows = await db.q(
      `SELECT * FROM paket WHERE 1=1${ts.sql} ORDER BY jenis, nama_paket`, ts.params
    );
    res.json({ data: rows });
  } catch (e) { next(e); }
});

router.post('/paket', requirePJ(), requireMenu('paket', 'tambah'), async (req, res, next) => {
  try {
    const ds = tenantAktif(req);
    const nama = v.str(req.body.nama_paket, { min: 2, max: 80 });
    const jenis = v.enumOf(req.body.jenis, ['pppoe', 'hotspot'], 'pppoe');
    const harga = v.num(req.body.harga, { min: 0, max: 1e9, def: 0 });
    const kecepatan = v.str(req.body.kecepatan, { max: 40, def: null });
    const masaAktif = v.num(req.body.masa_aktif, { min: 1, max: 3650, def: 30, int: true });
    const hargaAgen = v.num(req.body.harga_agen, { min: 0, max: 1e9, def: 0 });
    const id = await db.insert(
      `INSERT INTO paket (id_data_server, nama_paket, jenis, harga, kecepatan, masa_aktif, harga_agen)
       VALUES (?,?,?,?,?,?,?)`,
      [ds, nama, jenis, harga, kecepatan, masaAktif, hargaAgen]
    );
    res.json({ id });
  } catch (e) { next(e); }
});

router.put('/paket/:id', requirePJ(), requireMenu('paket', 'ubah'), async (req, res, next) => {
  try {
    const id = v.num(req.params.id, { int: true, min: 1 });
    const ts = tenantSql(req, 'id_data_server');
    const p = await db.one(`SELECT * FROM paket WHERE id = ?${ts.sql}`, [id, ...ts.params]);
    if (!p) return res.status(404).json({ error: 'Paket tidak ada' });
    const nama = v.str(req.body.nama_paket, { min: 2, max: 80, def: p.nama_paket });
    const jenis = v.enumOf(req.body.jenis, ['pppoe', 'hotspot'], p.jenis);
    const harga = v.num(req.body.harga, { min: 0, max: 1e9, def: Number(p.harga) });
    const kecepatan = v.str(req.body.kecepatan, { max: 40, def: p.kecepatan });
    const masaAktif = v.num(req.body.masa_aktif, { min: 1, max: 3650, def: p.masa_aktif, int: true });
    const hargaAgen = v.num(req.body.harga_agen, { min: 0, max: 1e9, def: Number(p.harga_agen) });
    const status = v.enumOf(req.body.status, ['aktif', 'nonaktif'], p.status);
    await db.run(
      `UPDATE paket SET nama_paket=?, jenis=?, harga=?, kecepatan=?, masa_aktif=?, harga_agen=?, status=?
       WHERE id=?`,
      [nama, jenis, harga, kecepatan, masaAktif, hargaAgen, status, id]
    );
    res.json({ ok: true });
  } catch (e) { next(e); }
});

router.delete('/paket/:id', requirePJ(), requireMenu('paket', 'hapus'), async (req, res, next) => {
  try {
    const id = v.num(req.params.id, { int: true, min: 1 });
    const ts = tenantSql(req, 'id_data_server');
    const p = await db.one(`SELECT id FROM paket WHERE id = ?${ts.sql}`, [id, ...ts.params]);
    if (!p) return res.status(404).json({ error: 'Paket tidak ada' });
    const dipakai = await db.one(
      `SELECT id FROM pelanggan WHERE id_paket = ?${ts.sql} LIMIT 1`, [id, ...ts.params]
    );
    if (dipakai) return res.status(400).json({ error: 'Paket masih dipakai pelanggan' });
    await db.run('DELETE FROM paket WHERE id = ?', [id]);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// ------------------------------------------------------- pelanggan
function scopeClause(req) {
  const ts = tenantSql(req, 'p.id_data_server');
  const u = req.user;
  if (u.role === 'pelanggan') return { where: `p.id = ?${ts.sql}`, params: [u.id_ref, ...ts.params] };
  if (u.role === 'agen') return { where: `p.id_agen = ?${ts.sql}`, params: [u.id_ref, ...ts.params] };
  return { where: `1=1${ts.sql}`, params: [...ts.params] };
}

const STATUS = ['baru', 'aktif', 'isolir', 'nonaktif'];

/**
 * Sinkronkan status pelanggan ke secret PPPoE di router tenant.
 * Isolir/nonaktif di panel harus benar-benar memutus layanan, bukan cuma ganti
 * kolom di database.
 */
function sinkronRouter(p, status, idDataServer) {
  if (p.tipe !== 'pppoe' || !p.username_pppoe) return null;
  if (status === 'isolir' || status === 'nonaktif') {
    return mon.setSecret(p.username_pppoe, { disabled: true, idDataServer });
  }
  if (status === 'aktif') return mon.setSecret(p.username_pppoe, { disabled: false, idDataServer });
  return null;
}

/** Tulis satu lembar xlsx ke response download. */
function unduhXlsx(res, lembar, namaBerkas) {
  const wb = XLSX.utils.book_new();
  for (const [nama, isi] of lembar) {
    const ws = XLSX.utils.aoa_to_sheet(isi);
    ws['!cols'] = isi[0].map(() => ({ wch: 18 }));
    XLSX.utils.book_append_sheet(wb, ws, nama);
  }
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${namaBerkas}"`);
  res.send(buf);
}

/** Filter daftar: dipakai bersama oleh GET /pelanggan, /export dan /jumlah. */
function filterDaftar(req) {
  const s = scopeClause(req);
  const cari = v.str(req.query.q, { max: 100, def: '' });
  const tipe = v.enumOf(req.query.tipe, ['pppoe', 'hotspot'], null);
  const status = v.enumOf(req.query.status, STATUS, null);
  const where = [s.where];
  const params = [...s.params];
  if (cari) { where.push('(p.nama LIKE ? OR p.kode LIKE ? OR p.username_pppoe LIKE ? OR p.nomor_whatsapp LIKE ?)'); params.push(`%${cari}%`, `%${cari}%`, `%${cari}%`, `%${cari}%`); }
  if (tipe) { where.push('p.tipe = ?'); params.push(tipe); }
  if (status) { where.push('p.status = ?'); params.push(status); }
  return { where: where.join(' AND '), params };
}

/**
 * Validasi relasi lokasi pelanggan (topologi ODP, desa, port, koordinat).
 * `def` = baris lama (PUT) supaya kolom yang tidak dikirim tidak berubah.
 */
async function validasiLokasi(req, body, def) {
  const ds = tenantAktif(req);
  const idTopo = v.num(body.id_master_topologi,
    { int: true, min: 1, def: def ? def.id_master_topologi : null });
  const idDesa = v.num(body.id_master_desa,
    { int: true, min: 1, def: def ? def.id_master_desa : null });
  const portOdp = v.str(body.port_odp, { max: 20, def: def ? def.port_odp : null });
  const koord = (k, lama) => {
    if (!Object.prototype.hasOwnProperty.call(body, k)) return lama;
    const s = String(body[k] == null ? '' : body[k]).trim();
    if (s === '') return null;
    if (!/^-?\d{1,3}(\.\d+)?$/.test(s)) throw new Error('Koordinat harus angka (contoh: -7.2575)');
    return s;
  };
  if (idTopo) {
    const tp = await db.one('SELECT id FROM master_topologi WHERE id=? AND id_data_server=?', [idTopo, ds]);
    if (!tp) throw new Error('Topologi tidak ada di data server ini');
  }
  if (idDesa) {
    const dx = await db.one('SELECT id FROM master_desa WHERE id=? AND id_data_server=?', [idDesa, ds]);
    if (!dx) throw new Error('Desa tidak ada di data server ini');
  }
  return {
    idMasterTopologi: idTopo, idMasterDesa: idDesa, portOdp,
    latitude: koord('latitude', def ? def.latitude : null),
    longitude: koord('longitude', def ? def.longitude : null)
  };
}

router.get('/pelanggan', async (req, res, next) => {
  try {
    const f = filterDaftar(req);
    const limit = v.num(req.query.limit, { min: 1, max: 200, def: 50, int: true });
    const offset = v.num(req.query.offset, { min: 0, max: 1e6, def: 0, int: true });

    const rows = await db.q(
      `SELECT p.*, pk.nama_paket, pk.harga, ps.online AS pppoe_online, ps.last_seen,
         ps.ip_address AS ip_lokal,
         mt.nama AS nama_topologi, mt.titik_koordinat, md.nama AS nama_desa,
         o.mac AS mac_onu, o.sn AS sn_onu,
         rd.rx_dbm, rd.redaman_db, rd.status AS status_redaman
       FROM pelanggan p
       LEFT JOIN paket pk ON pk.id = p.id_paket
       LEFT JOIN pppoe_status ps ON ps.id_pelanggan = p.id
       LEFT JOIN master_topologi mt ON mt.id = p.id_master_topologi
       LEFT JOIN master_desa md ON md.id = p.id_master_desa
       LEFT JOIN master_onu o ON o.id = (SELECT MAX(o2.id) FROM master_onu o2 WHERE o2.id_pelanggan = p.id)
       LEFT JOIN redaman_log rd ON rd.id = (SELECT MAX(r2.id) FROM redaman_log r2
         WHERE r2.id_perangkat = o.id_perangkat AND (o.sn IS NULL OR r2.sn = o.sn))
       WHERE ${f.where}
       ORDER BY p.id DESC LIMIT ? OFFSET ?`,
      [...f.params, limit, offset]
    );
    const [{ total }] = await db.q(
      `SELECT COUNT(*) AS total FROM pelanggan p WHERE ${f.where}`, f.params
    );
    res.json({ data: rows, total });
  } catch (e) { next(e); }
});

router.get('/pelanggan/jumlah', async (req, res, next) => {
  try {
    const f = filterDaftar(req);
    const rows = await db.q(
      `SELECT p.status, COUNT(*) AS n FROM pelanggan p WHERE ${f.where} GROUP BY p.status`, f.params
    );
    const jumlah = { semua: 0, baru: 0, aktif: 0, isolir: 0, nonaktif: 0 };
    for (const r of rows) {
      jumlah[r.status] = Number(r.n);
      jumlah.semua += Number(r.n);
    }
    res.json(jumlah);
  } catch (e) { next(e); }
});

/** Sesi PPPoE di router yang usernya tidak ada di daftar pelanggan (lihat saja). */
router.get('/pelanggan/unmanage', requireRole('superadmin', 'master', 'teknisi'), async (req, res, next) => {
  try {
    res.json(await mon.sesiTakTerkenal(tenantAktif(req)));
  } catch (e) { next(e); }
});

// ------------------------------------------- export / template / import
const KOLOM_EXPORT = ['kode', 'nama', 'tipe', 'paket', 'agen', 'username_pppoe',
  'password_pppoe', 'nomor_whatsapp', 'email', 'alamat', 'ip_address', 'mac_address',
  'status', 'tanggal_masuk', 'hari_tagihan'];

/** Baris petunjuk — dipakai sebagai lembar kedua di xlsx dan baris '#' di CSV. */
const PETUNJUK = [
  'Template import data pelanggan — ivvibill',
  'Kolom wajib hanya nama; baris kosong diabaikan.',
  'paket & agen diisi nama persis seperti di aplikasi (kosongkan bila tidak ada).',
  'tipe: pppoe|hotspot · status: baru|aktif|isolir|nonaktif',
  'tanggal_masuk: YYYY-MM-DD · hari_tagihan: 1-28',
  'Data hanya ditambahkan — baris yang sudah ada tidak pernah diubah,',
  'dan pesan WhatsApp tidak dikirim saat import.',
  'Sheet "Pelanggan" yang dibaca; sheet ini hanya panduan.'
];

const CONTOH = [
  ['', 'Budi Santoso', 'pppoe', '10M Rumahan', '', 'budi01', 'rahasia123', '081234567890', '', 'Jl. Merdeka No. 1', '', '', 'baru', '2026-10-06', '1'],
  ['', 'Siti Aminah', 'hotspot', 'Tiket 3 Jam', '', '', '', '089876543210', '', 'Perum Griya Asri C2', '', '', 'aktif', '2026-10-06', '5']
];

/** Nilai sel → teks (Date jadi tanggal ISO, null jadi string kosong). */
function sel(val) {
  if (val === null || val === undefined) return '';
  if (val instanceof Date) return val.toISOString().slice(0, 10);
  return String(val);
}

/** Daftar pelanggan tersaring → array-of-arrays siap tulis (xlsx maupun csv). */
async function barisEkspor(req) {
  const f = filterDaftar(req);
  const rows = await db.q(
    `SELECT p.kode, p.nama, p.tipe, pk.nama_paket AS paket, ag.nama AS agen,
       p.username_pppoe, p.password_pppoe, p.nomor_whatsapp, p.email, p.alamat,
       p.ip_address, p.mac_address, p.status, p.tanggal_masuk, p.hari_tagihan
     FROM pelanggan p
     LEFT JOIN paket pk ON pk.id = p.id_paket
     LEFT JOIN agen ag ON ag.id = p.id_agen
     WHERE ${f.where}
     ORDER BY p.id DESC LIMIT 5000`, f.params
  );
  return [KOLOM_EXPORT, ...rows.map(r => KOLOM_EXPORT.map(k => sel(r[k])))];
}

/** ?format=csv untuk yang terbiasa CSV; selain itu xlsx. */
function kirimLembar(res, req, isi, nama) {
  if (req.query.format === 'csv') {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${nama}.csv"`);
    return res.send(csv.tulisCsv(isi, { bom: true }));
  }
  return unduhXlsx(res, [[nama, isi], ['Petunjuk', PETUNJUK.map(t => [t])]], `${nama}.xlsx`);
}

/** Unduh data pelanggan — kolomnya sama persis dengan template import (round-trip). */
router.get('/pelanggan/export', async (req, res, next) => {
  try {
    const isi = await barisEkspor(req);
    kirimLembar(res, req, isi, `pelanggan-${new Date().toISOString().slice(0, 10)}`);
  } catch (e) { next(e); }
});

/** Template import: header + dua baris contoh, plus lembar Petunjuk. */
router.get('/pelanggan/template', (req, res) => {
  const isi = [KOLOM_EXPORT, ...CONTOH];
  if (req.query.format === 'csv') {
    const teks = [...PETUNJUK.map(t => `# ${t}`), isi.map(r => r.map(csv.selCsv).join(',')).join('\r\n')];
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="template-pelanggan.csv"');
    return res.send('\uFEFF' + teks.join('\r\n') + '\r\n');
  }
  unduhXlsx(res, [['Pelanggan', isi], ['Petunjuk', PETUNJUK.map(t => [t])]], 'template-pelanggan.xlsx');
});

const uploadImpor = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 2 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ok = /\.(csv|txt|xlsx|xls)$/i.test(file.originalname || '')
      || /csv|text|spreadsheet|excel/.test(file.mimetype || '');
    cb(ok ? null : new Error('File harus Excel (.xlsx/.xls) atau CSV (.csv)'), ok);
  }
});

/** Peta header (huruf kecil, tanpa spasi/tanda) → kolom tujuan. */
const HEADER_IMPOR = {
  nama: 'nama', namapelanggan: 'nama', pelanggan: 'nama',
  tipe: 'tipe', paket: 'paket', namapaket: 'paket', agen: 'agen',
  username: 'username_pppoe', usernamepppoe: 'username_pppoe', pppoe: 'username_pppoe',
  password: 'password_pppoe', passwordpppoe: 'password_pppoe',
  nomorwhatsapp: 'nomor_whatsapp', nowa: 'nomor_whatsapp', wa: 'nomor_whatsapp', whatsapp: 'nomor_whatsapp',
  email: 'email', alamat: 'alamat',
  ipaddress: 'ip_address', ip: 'ip_address',
  macaddress: 'mac_address', mac: 'mac_address',
  status: 'status',
  tanggalmasuk: 'tanggal_masuk', tglmasuk: 'tanggal_masuk', tgl: 'tanggal_masuk',
  haritagihan: 'hari_tagihan',
  kode: 'kode'                            // ditulis export, sengaja tidak diimpor
};

/**
 * Berkas → array-of-arrays string. Excel dibaca lewat SheetJS (sheet pertama
 * yang bukan "Petunjuk"), CSV lewat parser bawaan; baris '#' dan baris kosong
 * dibuang supaya template CSV hasil v1.1.3 tetap bisa dipakai.
 */
function bacaBerkas(file) {
  const xlsx = file.buffer.length > 4 && file.buffer[0] === 0x50 && file.buffer[1] === 0x4b;
  if (xlsx || /\.(xlsx|xls)$/i.test(file.originalname || '')) {
    const wb = XLSX.read(file.buffer, { type: 'buffer', cellDates: true });
    const nama = wb.SheetNames.find(n => n.toLowerCase() !== 'petunjuk') || wb.SheetNames[0];
    const ws = wb.Sheets[nama];
    if (!ws) throw new Error('Lembar kerja kosong');
    const aoa = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '', blankrows: false });
    return aoa.map(r => r.map(sel));
  }
  return csv.parseCsv(file.buffer.toString('utf8'))
    .filter(r => r.sel.some(c => String(c).trim() !== '' && !String(c).trim().startsWith('#')))
    .map(r => r.sel);
}

/**
 * Import Excel/CSV — hanya MENAMBAH baris baru (tidak mengubah yang sudah ada),
 * tanpa enqueue pesan WhatsApp supaya import besar tidak mengejar spam.
 * Kegagalan per baris dikumpulkan, bukan menggagalkan seluruh file.
 */
router.post('/pelanggan/import', requireRole('superadmin', 'master', 'teknisi'),
  requireMenu('pelanggan', 'tambah'), uploadImpor.single('file'), async (req, res, next) => {
  try {
    if (!req.file || !req.file.buffer) {
      return res.status(400).json({ error: 'File Excel/CSV belum dipilih (field: file)' });
    }
    const ds = tenantAktif(req);

    const [paketRows, agenRows, pref] = await Promise.all([
      db.q('SELECT id, nama_paket FROM paket WHERE id_data_server = ?', [ds]),
      db.q('SELECT id, nama FROM agen WHERE id_data_server = ?', [ds]),
      db.q('SELECT prefix_invoice FROM data_server WHERE id = ?', [ds])
    ]);
    const petaPaket = new Map(paketRows.map(p => [String(p.nama_paket).toLowerCase(), Number(p.id)]));
    const petaAgen = new Map(agenRows.map(a => [String(a.nama).toLowerCase(), Number(a.id)]));
    const prefix = (pref[0] && pref[0].prefix_invoice) || 'IVV';

    const dipakai = new Set(
      (await db.q(
        'SELECT username_pppoe FROM pelanggan WHERE id_data_server = ? AND username_pppoe IS NOT NULL', [ds]))
        .map(r => String(r.username_pppoe).toLowerCase())
    );

    const isi = bacaBerkas(req.file);
    if (!isi.length) return res.status(400).json({ error: 'File kosong atau tidak berisi baris data' });

    const kolom = {};
    isi[0].forEach((h, i) => {
      const k = String(h).toLowerCase().replace(/[^a-z0-9]/g, '');
      const tujuan = HEADER_IMPOR[k];
      if (tujuan && kolom[tujuan] === undefined) kolom[tujuan] = i;
    });
    if (kolom.nama === undefined) {
      return res.status(400).json({ error: 'Header "nama" tidak ditemukan — gunakan template yang disediakan' });
    }
    const amb = (selBaris, k) =>
      kolom[k] === undefined || selBaris[kolom[k]] === undefined ? '' : String(selBaris[kolom[k]]).trim();

    const dataRows = isi.slice(1).filter(r => r.some(c => String(c).trim() !== ''));
    if (dataRows.length > 1000) return res.status(400).json({ error: 'Maksimal 1000 baris data per impor' });
    const detail = [];
    let sukses = 0;
    const hariIni = new Date().toISOString().slice(0, 10);
    let n = 0;
    for (const r of dataRows) {
      n += 1;
      const namaBaris = amb(r, 'nama');
      try {
        const nama = v.str(namaBaris, { min: 2, max: 100 });
        const tipe = v.enumOf(amb(r, 'tipe') || null, ['pppoe', 'hotspot'], 'pppoe');
        const alamat = v.str(amb(r, 'alamat') || null, { max: 255, def: null });
        const nowa = v.phone(amb(r, 'nomor_whatsapp') || null);
        const email = v.email(amb(r, 'email') || null);
        const username = v.str(amb(r, 'username_pppoe') || null, { max: 50, def: null });
        const pass = v.str(amb(r, 'password_pppoe') || null, { max: 50, def: null });
        const ip = v.str(amb(r, 'ip_address') || null, { max: 40, def: null });
        const mac = v.str(amb(r, 'mac_address') || null, { max: 40, def: null });
        const status = v.enumOf(amb(r, 'status') || null, STATUS, 'baru');
        const tglMasuk = v.tgl(amb(r, 'tanggal_masuk') || null, hariIni);
        const hariTagihan = v.num(amb(r, 'hari_tagihan') || null,
          { min: 1, max: 28, def: 1, int: true });

        let idPaket = null;
        const namaPaket = amb(r, 'paket');
        if (namaPaket) {
          idPaket = petaPaket.get(namaPaket.toLowerCase()) || null;
          if (!idPaket) throw new Error(`Paket "${namaPaket}" tidak ditemukan di data server ini`);
        }
        let idAgen = null;
        const namaAgen = amb(r, 'agen');
        if (namaAgen) {
          idAgen = petaAgen.get(namaAgen.toLowerCase()) || null;
          if (!idAgen) throw new Error(`Agen "${namaAgen}" tidak ditemukan di data server ini`);
        }
        if (tipe === 'pppoe' && username && dipakai.has(username.toLowerCase())) {
          throw new Error(`Username PPPoE "${username}" sudah terpakai`);
        }

        const kode = `${prefix}${Date.now().toString(36).toUpperCase()}${n.toString(36).toUpperCase()}`
          .slice(0, 20);   // kolom kode VARCHAR(20), UNIQUE
        await db.insert(
          `INSERT INTO pelanggan (id_data_server, kode, nama, alamat, nomor_whatsapp, email, tipe,
            id_paket, id_agen, username_pppoe, password_pppoe, ip_address, mac_address,
            tanggal_masuk, hari_tagihan, status)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          [ds, kode, nama, alamat, nowa, email, tipe, idPaket, idAgen,
            username, pass, ip, mac, tglMasuk, hariTagihan, status]
        );
        if (username) dipakai.add(username.toLowerCase());
        sukses += 1;
      } catch (e) {
        if (detail.length < 100) {
          detail.push({ baris: n + 1, nama: namaBaris, error: e.message });
        }
      }
    }

    await db.insert(
      'INSERT INTO audit_log (user_id, id_data_server, aksi, detail, ip) VALUES (?,?,?,?,?)',
      [req.user.id, ds, 'import_pelanggan', `${sukses}/${dataRows.length} baris OK`,
        (req.ip || '').replace('::ffff:', '')]
    );
    res.json({ total: dataRows.length, sukses, gagal: dataRows.length - sukses, detail });
  } catch (e) { next(e); }
});

/** Ganti status massal + sinkron secret PPPoE. Dipakai tombol per-baris dan bulk. */
async function ubahStatusBulk(req, res, next) {
  try {
    const status = v.enumOf(req.body.status, STATUS, null);
    if (!status) return res.status(400).json({ error: 'Status tidak valid' });
    const ids = Array.isArray(req.body.ids) ? req.body.ids : String(req.body.ids || '').split(',');
    const lim = ids.map(x => v.num(x, { int: true, min: 1, def: null })).filter(x => x !== null).slice(0, 200);
    if (!lim.length) return res.status(400).json({ error: 'Daftar pelanggan kosong' });

    const diubah = [], gagal = [];
    for (const id of lim) {
      const ts = tenantSql(req, 'id_data_server');
      const p = await db.one(`SELECT * FROM pelanggan WHERE id = ?${ts.sql}`, [id, ...ts.params]);
      if (!p) { gagal.push({ id, alasan: 'Tidak ada di data server ini' }); continue; }
      if (req.user.role === 'agen' && Number(p.id_agen) !== Number(req.user.id_ref)) {
        gagal.push({ id, alasan: 'Akses ditolak' }); continue;
      }
      if (req.user.role === 'teknisi' && status === 'nonaktif') {
        gagal.push({ id, alasan: 'Hanya penanggung jawab yang dapat menonaktifkan' }); continue;
      }
      const ds = Number(p.id_data_server) || tenantAktif(req);
      await db.run('UPDATE pelanggan SET status = ? WHERE id = ?', [status, id]);
      let router = null;
      try {
        router = await sinkronRouter(p, status, ds);
      } catch (e) {
        router = { router: null, gagal: [String(e.message).slice(0, 120)] };
      }
      await db.insert('INSERT INTO audit_log (user_id, id_data_server, aksi, detail, ip) VALUES (?,?,?,?,?)',
        [req.user.id, ds, 'ubah_status_pelanggan', `#${id} ${p.nama} -> ${status}`, (req.ip || '').replace('::ffff:', '')]);
      diubah.push({ id, status, router });
    }
    res.json({ diubah, gagal });
  } catch (e) { next(e); }
}

router.post('/pelanggan/status', requireRole('superadmin', 'master', 'teknisi'),
  requireMenu('pelanggan', 'ubah'), ubahStatusBulk);

router.post('/pelanggan/:id/status', requireRole('superadmin', 'master', 'teknisi'),
  requireMenu('pelanggan', 'ubah'), (req, res, next) => {
    req.body = { ...req.body, ids: [req.params.id] };
    return ubahStatusBulk(req, res, next);
  });


router.get('/pelanggan/:id', async (req, res, next) => {
  try {
    const id = v.num(req.params.id, { int: true, min: 1 });
    const ts = tenantSql(req, 'p.id_data_server');
    const p = await db.one(
      `SELECT p.*, pk.nama_paket, pk.harga, ps.online AS pppoe_online, ps.last_seen,
         ps.ip_address AS ip_lokal,
         mt.nama AS nama_topologi, md.nama AS nama_desa,
         o.mac AS mac_onu, o.sn AS sn_onu,
         rd.rx_dbm, rd.redaman_db, rd.status AS status_redaman
       FROM pelanggan p
       LEFT JOIN paket pk ON pk.id = p.id_paket
       LEFT JOIN pppoe_status ps ON ps.id_pelanggan = p.id
       LEFT JOIN master_topologi mt ON mt.id = p.id_master_topologi
       LEFT JOIN master_desa md ON md.id = p.id_master_desa
       LEFT JOIN master_onu o ON o.id = (SELECT MAX(o2.id) FROM master_onu o2 WHERE o2.id_pelanggan = p.id)
       LEFT JOIN redaman_log rd ON rd.id = (SELECT MAX(r2.id) FROM redaman_log r2
         WHERE r2.id_perangkat = o.id_perangkat AND (o.sn IS NULL OR r2.sn = o.sn))
       WHERE p.id = ?${ts.sql}`, [id, ...ts.params]);
    if (!p) return res.status(404).json({ error: 'Pelanggan tidak ada' });
    if (req.user.role === 'pelanggan' && Number(p.id) !== Number(req.user.id_ref)) {
      return res.status(403).json({ error: 'Akses ditolak' });
    }
    if (req.user.role === 'agen' && Number(p.id_agen) !== Number(req.user.id_ref)) {
      return res.status(403).json({ error: 'Akses ditolak' });
    }
    const tagihan = await db.q(
      'SELECT * FROM tagihan WHERE id_pelanggan = ? ORDER BY id DESC LIMIT 24', [id]);
    res.json({ data: p, tagihan });
  } catch (e) { next(e); }
});

router.post('/pelanggan', requireRole('superadmin', 'master', 'teknisi'),
  requireMenu('pelanggan', 'tambah'), async (req, res, next) => {
  try {
    const ds = tenantAktif(req);
    const nama = v.str(req.body.nama, { min: 2, max: 100 });
    const tipe = v.enumOf(req.body.tipe, ['pppoe', 'hotspot'], 'pppoe');
    const alamat = v.str(req.body.alamat, { max: 255, def: null });
    const nowa = v.phone(req.body.nomor_whatsapp);
    const email = v.email(req.body.email);
    const idPaket = v.num(req.body.id_paket, { int: true, min: 1, def: null });
    const username = v.str(req.body.username_pppoe, { max: 50, def: null });
    const passPppoe = v.str(req.body.password_pppoe, { max: 50, def: null });
    const ip = v.str(req.body.ip_address, { max: 40, def: null });
    const mac = v.str(req.body.mac_address, { max: 40, def: null });
    const tglMasuk = v.tgl(req.body.tanggal_masuk, new Date().toISOString().slice(0, 10));
    const hariTagihan = v.num(req.body.hari_tagihan, { min: 1, max: 28, def: 1, int: true });
    const idAgen = v.num(req.body.id_agen, { int: true, min: 1, def: null });
    let lok;
    try { lok = await validasiLokasi(req, req.body, null); }
    catch (e) { return res.status(400).json({ error: e.message }); }

    if (tipe === 'pppoe' && username) {
      const dup = await db.one(
        'SELECT id FROM pelanggan WHERE username_pppoe = ? AND id_data_server = ?', [username, ds]
      );
      if (dup) return res.status(400).json({ error: 'Username PPPoE sudah terpakai' });
    }
    if (idPaket) {
      const pk = await db.one('SELECT id FROM paket WHERE id = ? AND id_data_server = ?', [idPaket, ds]);
      if (!pk) return res.status(400).json({ error: 'Paket tidak ada di data server ini' });
    }

    const [{ prefix_invoice }] = await db.q(
      'SELECT prefix_invoice FROM data_server WHERE id = ?', [ds]);
    const kode = `${prefix_invoice || 'IVV'}${Date.now().toString(36).toUpperCase()}`;
    const id = await db.insert(
      `INSERT INTO pelanggan (id_data_server, kode, nama, alamat, nomor_whatsapp, email, tipe,
        id_paket, id_agen, username_pppoe, password_pppoe, ip_address, mac_address,
        tanggal_masuk, hari_tagihan, status,
        id_master_topologi, id_master_desa, port_odp, latitude, longitude)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?, 'baru',?,?,?,?,?)`,
      [ds, kode, nama, alamat, nowa, email, tipe, idPaket, idAgen, username, passPppoe, ip, mac, tglMasuk, hariTagihan,
        lok.idMasterTopologi, lok.idMasterDesa, lok.portOdp, lok.latitude, lok.longitude]
    );
    await db.insert('INSERT INTO audit_log (user_id, id_data_server, aksi, detail, ip) VALUES (?,?,?,?,?)',
      [req.user.id, ds, 'tambah_pelanggan', `${nama} (#${id})`, (req.ip || '').replace('::ffff:', '')]);

    if (nowa) {
      const tpl = await wa.ambilTemplate('registrasi', ds);
      const pesan = wa.render(tpl, { usr: nama, lyn: (idPaket ? (await db.one('SELECT nama_paket FROM paket WHERE id=? AND id_data_server=?',[idPaket, ds]))?.nama_paket : 'layanan') || 'layanan' });
      await wa.enqueue({ tujuan: nowa, jenis: 'registrasi', pesan, idRef: id, idDataServer: ds });
    }
    res.json({ id, kode });
  } catch (e) { next(e); }
});

router.put('/pelanggan/:id', requireRole('superadmin', 'master', 'teknisi', 'agen'),
  requireMenu('pelanggan', 'ubah'), async (req, res, next) => {
  try {
    const id = v.num(req.params.id, { int: true, min: 1 });
    const ts = tenantSql(req, 'id_data_server');
    const p = await db.one(`SELECT * FROM pelanggan WHERE id = ?${ts.sql}`, [id, ...ts.params]);
    if (!p) return res.status(404).json({ error: 'Pelanggan tidak ada' });
    // tenant diambil dari barisnya, bukan dari picker, agar audit & template WA tepat
    const ds = Number(p.id_data_server) || tenantAktif(req);
    if (req.user.role === 'agen' && Number(p.id_agen) !== Number(req.user.id_ref)) {
      return res.status(403).json({ error: 'Akses ditolak' });
    }
    const nama = v.str(req.body.nama, { min: 2, max: 100, def: p.nama });
    const alamat = v.str(req.body.alamat, { max: 255, def: p.alamat });
    const nowa = Object.prototype.hasOwnProperty.call(req.body, 'nomor_whatsapp') ? v.phone(req.body.nomor_whatsapp) : p.nomor_whatsapp;
    const idPaket = v.num(req.body.id_paket, { int: true, min: 1, def: p.id_paket ? Number(p.id_paket) : null });
    const username = v.str(req.body.username_pppoe, { max: 50, def: p.username_pppoe });
    const passPppoe = v.str(req.body.password_pppoe, { max: 50, def: p.password_pppoe });
    const ip = v.str(req.body.ip_address, { max: 40, def: p.ip_address });
    const status = v.enumOf(req.body.status, ['baru', 'aktif', 'isolir', 'nonaktif'], p.status);
    const catatan = v.str(req.body.catatan, { max: 5000, def: p.catatan });
    let lok;
    try { lok = await validasiLokasi(req, req.body, p); }
    catch (e) { return res.status(400).json({ error: e.message }); }

    // teknisi tidak boleh ubah status ke nonaktif/hapus kredensial sembarangan
    if (req.user.role === 'teknisi' && status === 'nonaktif') {
      return res.status(403).json({ error: 'Hanya penanggung jawab yang dapat menonaktifkan' });
    }

    const statusBaru = status !== p.status;
    await db.run(
      `UPDATE pelanggan SET nama=?, alamat=?, nomor_whatsapp=?, id_paket=?, username_pppoe=?,
        password_pppoe=?, ip_address=?, status=?, catatan=?,
        id_master_topologi=?, id_master_desa=?, port_odp=?, latitude=?, longitude=? WHERE id=?`,
      [nama, alamat, nowa, idPaket, username, passPppoe, ip, status, catatan,
        lok.idMasterTopologi, lok.idMasterDesa, lok.portOdp, lok.latitude, lok.longitude, id]
    );

    if (statusBaru && status === 'aktif' && p.status === 'baru' && nowa) {
      const tpl = await wa.ambilTemplate('aktivasi', ds);
      const pesan = wa.render(tpl, { usr: nama, ppp: username || '-', lyn: 'layanan' });
      await wa.enqueue({ tujuan: nowa, jenis: 'aktivasi', pesan, idRef: id, idDataServer: ds });
    }

    // status adalah cara operator memutus koneksi, jadi secret PPPoE ikut diset
    let router = null;
    if (statusBaru) {
      try {
        router = await sinkronRouter({ ...p, username_pppoe: username }, status, ds);
      } catch (e) {
        router = { router: null, gagal: [String(e.message).slice(0, 120)] };
      }
    }

    await db.insert('INSERT INTO audit_log (user_id, id_data_server, aksi, detail, ip) VALUES (?,?,?,?,?)',
      [req.user.id, ds, 'ubah_pelanggan', `#${id} ${nama}`, (req.ip || '').replace('::ffff:', '')]);
    res.json({ ok: true, router });
  } catch (e) { next(e); }
});

router.delete('/pelanggan/:id', requirePJ(), requireMenu('pelanggan', 'hapus'), async (req, res, next) => {
  try {
    const id = v.num(req.params.id, { int: true, min: 1 });
    const ts = tenantSql(req, 'id_data_server');
    const p = await db.one(`SELECT id, id_data_server FROM pelanggan WHERE id = ?${ts.sql}`, [id, ...ts.params]);
    if (!p) return res.status(404).json({ error: 'Pelanggan tidak ada' });
    const ds = Number(p.id_data_server) || tenantAktif(req);
    const ada = await db.one('SELECT nomor_invoice FROM tagihan WHERE id_pelanggan = ? LIMIT 1', [id]);
    if (ada) return res.status(400).json({ error: 'Pelanggan memiliki riwayat tagihan — gunakan status nonaktif' });
    await db.run('DELETE FROM pelanggan WHERE id = ?', [id]);
    await db.insert('INSERT INTO audit_log (user_id, id_data_server, aksi, detail, ip) VALUES (?,?,?,?,?)',
      [req.user.id, ds, 'hapus_pelanggan', `#${id}`, (req.ip || '').replace('::ffff:', '')]);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

module.exports = router;
