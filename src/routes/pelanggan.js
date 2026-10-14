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
const billing = require('../services/billing');
const profilCtl = require('../services/profilTagihan');
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
    const satuan = v.enumOf(req.body.satuan, ['hari', 'jam'], 'hari');
    const [ph, pp] = profilPaket(jenis, req.body);
    const hargaAgen = v.num(req.body.harga_agen, { min: 0, max: 1e9, def: 0 });
    const id = await db.insert(
      `INSERT INTO paket (id_data_server, nama_paket, jenis, harga, kecepatan, masa_aktif, satuan,
                          harga_agen, profile_hotspot, profile_pppoe)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [ds, nama, jenis, harga, kecepatan, masaAktif, satuan, hargaAgen, ph, pp]
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
    const satuan = v.enumOf(req.body.satuan, ['hari', 'jam'], p.satuan || 'hari');
    const [ph, pp] = profilPaket(jenis, req.body, p);
    const hargaAgen = v.num(req.body.harga_agen, { min: 0, max: 1e9, def: Number(p.harga_agen) });
    const status = v.enumOf(req.body.status, ['aktif', 'nonaktif'], p.status);
    await db.run(
      `UPDATE paket SET nama_paket=?, jenis=?, harga=?, kecepatan=?, masa_aktif=?, satuan=?,
                        harga_agen=?, profile_hotspot=?, profile_pppoe=?, status=?
       WHERE id=?`,
      [nama, jenis, harga, kecepatan, masaAktif, satuan, hargaAgen, ph, pp, status, id]
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

// ------------------------------------------------- sinkronisasi paket ↔ router
/**
 * Profil MikroTik sebuah paket, dipisahkan per jenis.
 * hotspot → /ip/hotspot/user/profile (dipakai saat voucher didorong ke router)
 * pppoe   → /ppp/profile (nama profile bandwidth secret)
 *
 * Dulu satu kolom profile_hotspot dipakai untuk dua jenis: paket PPPoE ikut
 * menampung nama profile hotspot dan labelnya di panel menyebut "hotspot",
 * sehingga operator mengira profil PPPoE-nya terisi padahal tidak pernah dibaca.
 * Karena itu kolom yang tidak cocok dengan jenis selalu dinolkan, dan nilai
 * lama (baris pppoe yang profil hotspot-nya terisi) tetap dipakai sebagai
 * pegangan supaya tidak ada data yang tiba-tiba hilang.
 */
function profilPaket(jenis, body, lama = null) {
  const baca = (k) => {
    if (Object.prototype.hasOwnProperty.call(body, k)) return v.str(body[k], { max: 64, def: null });
    return lama ? (lama[k] || null) : null;
  };
  const hotspot = jenis === 'hotspot' ? baca('profile_hotspot') : null;
  let pppoe = null;
  if (jenis === 'pppoe') {
    pppoe = baca('profile_pppoe');
    // paket lama menyimpan profil PPPoE di kolom profile_hotspot — dipindah,
    // bukan dibuang, supaya mengisi jenis tidak mengubah data
    if (!pppoe && lama) pppoe = lama.profile_hotspot || null;
  }
  return [hotspot, pppoe];
}

/**
 * Kunci pencocokan paket dengan profile bandwidth di router — nama profile
 * jenisnya, atau nama paket sebagai cadangan untuk paket lama yang profilnya
 * belum diisi.
 */
function kunciProfil(p) {
  return String((p.jenis === 'hotspot' ? (p.profile_hotspot || p.nama_paket)
    : (p.profile_pppoe || p.profile_hotspot || p.nama_paket)) || '')
    .toLowerCase().trim();
}

/**
 * Diff dua arah antara tabel paket dan profile di router. Membaca saja:
 * baru = ada di router belum jadi paket, hilang = paket aktif yang profile-nya
 * sudah tidak ada di router (vouchernya bakal ditolak RouterOS saat login).
 */
router.get('/paket/sinkron', async (req, res, next) => {
  try {
    const jenis = v.enumOf(req.query.jenis, ['hotspot', 'pppoe'], 'hotspot');
    const ts = tenantSql(req, 'id_data_server');
    const [daftar, r] = await Promise.all([
      db.q(`SELECT * FROM paket WHERE jenis = ?${ts.sql}`, [jenis, ...ts.params]),
      mon.profilRouter(tenantAktif(req), jenis)
    ]);
    const peta = new Map(daftar.map(p => [kunciProfil(p), p]));
    const byNama = new Map();
    for (const p of r.data) {
      const k = String(p.nama).toLowerCase().trim();
      if (!k) continue;
      if (!byNama.has(k)) byNama.set(k, { nama: p.nama, kecepatan: p.kecepatan,
        shared: p.shared, router: [], nonaktif: p.nonaktif });
      const e = byNama.get(k);
      if (!e.router.includes(p.router)) e.router.push(p.router);
      if (!e.kecepatan && p.kecepatan) e.kecepatan = p.kecepatan;
      if (p.nonaktif === false) e.nonaktif = false;
    }
    const baru = [], cocok = [];
    for (const [k, e] of byNama) {
      const p = peta.get(k);
      if (p) cocok.push({ nama: e.nama, kecepatan: e.kecepatan, id: p.id,
        nama_paket: p.nama_paket, status: p.status });
      else baru.push(e);
    }
    const hilang = daftar.filter(p => p.status === 'aktif' && !byNama.has(kunciProfil(p)))
      .map(p => ({ id: p.id, nama_paket: p.nama_paket, profile: kunciProfil(p), jenis: p.jenis }));
    res.json({ jenis, router: [...new Set(r.data.map(p => p.router))],
      baru, cocok, hilang, gagal: r.gagal });
  } catch (e) { next(e); }
});

/**
 * Buat paket dari profile yang dipilih admin. Kecepatan diambil dari rate-limit
 * router; harga 0 dan status nonaktif disengaja — tarif adalah keputusan pemilik
 * ISP, dan paket nonaktif tidak muncul di daftar penjualan sampai harganya diisi.
 */
router.post('/paket/sinkron', requirePJ(), requireMenu('paket', 'tambah'), async (req, res, next) => {
  try {
    const jenis = v.enumOf(req.body.jenis, ['hotspot', 'pppoe'], 'hotspot');
    const ds = tenantAktif(req);
    const daftar = Array.isArray(req.body.profil) ? req.body.profil : [];
    const namaList = [...new Set(daftar.map(x => v.str(x, { min: 1, max: 64 })).filter(Boolean))].slice(0, 100);
    if (!namaList.length) return res.status(400).json({ error: 'Tidak ada profile dipilih' });

    const r = await mon.profilRouter(ds, jenis);
    const diRouter = new Map(r.data.map(p => [String(p.nama).toLowerCase().trim(), p]));
    const dibuat = [], dilewati = [];
    for (const nama of namaList) {
      const p = diRouter.get(String(nama).toLowerCase().trim());
      if (!p) { dilewati.push({ nama, alasan: 'Sudah tidak ada di router' }); continue; }
      const ada = await db.one(
        `SELECT id FROM paket WHERE id_data_server = ? AND LOWER(nama_paket) = ? LIMIT 1`,
        [ds, String(nama).toLowerCase().trim()]);
      if (ada) { dilewati.push({ nama, alasan: `Sudah jadi paket #${ada.id}` }); continue; }
      const id = await db.insert(
        `INSERT INTO paket (id_data_server, nama_paket, jenis, harga, kecepatan, masa_aktif,
                            satuan, harga_agen, profile_hotspot, profile_pppoe, deskripsi, status)
         VALUES (?,?,?,?,?,?,?,?,?,?,?, 'nonaktif')`,
        [ds, nama, jenis, 0, p.kecepatan, 30, 'hari', 0,
          jenis === 'hotspot' ? nama : null,
          jenis === 'pppoe' ? nama : null,
          `diambil dari profile router ${p.router}`]
      );
      dibuat.push({ id, nama_paket: nama, kecepatan: p.kecepatan });
    }
    await db.insert('INSERT INTO audit_log (user_id, id_data_server, aksi, detail, ip) VALUES (?,?,?,?,?)',
      [req.user.id, ds, 'sinkron_paket',
        `${jenis}: dibuat ${dibuat.length}, dilewati ${dilewati.length}`,
        (req.ip || '').replace('::ffff:', '')]);
    res.json({ dibuat, dilewati });
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
 * Isolir/nonaktif di panel harus benar-benar mengubah layanan, bukan cuma ganti
 * kolom di database. Pelanggan PPPoE dengan 'profile_isolir' diisi tidak
 * dimatikan secret-nya — bandwidth-nya diturunkan ke profil isolir miliknya
 * (lihat monitoring.sinkronStatus).
 */
function sinkronRouter(p, status, idDataServer) {
  return mon.sinkronStatus(p, status, idDataServer);
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
 * `dsBaris` = tenant milik baris yang sedang diubah (PUT): pemeriksaan relasi
 * harus memakai tenant baris, bukan picker aktif — kalau tidak, superadmin /
 * user multi-tenant yang mengedit pelanggan tenant lain selalu ditolak
 * "Topologi tidak ada di data server ini" meski relasinya valid.
 */
async function validasiLokasi(req, body, def, dsBaris) {
  const ds = dsBaris || tenantAktif(req);
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

/**
 * Kebijakan penagihan dari form/API pelanggan (v2.0).
 * Profile Tagihan adalah sumber jadwal; hari_tagihan hanyalah NILAI TURUNAN
 * dari tanggal_isolir profil, jadi keduanya tidak pernah bertentangan.
 * Tanpa profil, perilaku lama berlaku (hari_tagihan diketik manual, default 1).
 */
async function kebijakanTagihanPelanggan(ds, body, lama = null) {
  const hariLama = Number((lama && lama.hari_tagihan) || 1);
  let pt;
  if (Object.prototype.hasOwnProperty.call(body, 'id_profil_tagihan')) {
    pt = await profilCtl.profilTenant(ds, body.id_profil_tagihan);
  } else if (lama && lama.id_profil_tagihan) {
    pt = await profilCtl.satu(lama.id_profil_tagihan, ds, 'ringkas');
  }
  const eksplisit = v.num(body.hari_tagihan, { min: 1, max: 28, int: true, def: null });
  return {
    idProfilTagihan: pt ? Number(pt.id) : null,
    hariTagihan: pt ? Number(pt.tanggal_isolir) : (eksplisit !== null ? eksplisit : hariLama)
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
         pt.nama AS profil_tagihan, pt.tanggal_isolir AS profil_tanggal_isolir,
         mt.nama AS nama_topologi, mt.titik_koordinat, md.nama AS nama_desa,
         o.mac AS mac_onu, o.sn AS sn_onu,
         o.rx_dbm, o.redaman_db, o.status_redaman
       FROM pelanggan p
       LEFT JOIN paket pk ON pk.id = p.id_paket
       LEFT JOIN profil_tagihan pt ON pt.id = p.id_profil_tagihan
         AND pt.id_data_server = p.id_data_server
       LEFT JOIN pppoe_status ps ON ps.id_pelanggan = p.id
       LEFT JOIN master_topologi mt ON mt.id = p.id_master_topologi
       LEFT JOIN master_desa md ON md.id = p.id_master_desa
       LEFT JOIN master_onu o ON o.id = (SELECT MAX(o2.id) FROM master_onu o2 WHERE o2.id_pelanggan = p.id)
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
// 'kode' SENGAJA tidak ada di daftar ini. Kolom itu digenerate import
// (prefix + waktu + urutan) dan tidak pernah dibaca dari berkas, jadi
// menampilkannya di template hanya membingungkan pengguna.
// v2.2.3 — "IP Address" dan "Hari Tagihan" sengaja dibuang dari daftar kolom:
// IP pelanggan PPPoE adalah leases router (bukan data yang perlu diketik), dan
// tanggal penagihan sudah menjadi milik Profile Tagihan. Keduanya TETAP dikenali
// lewat HEADER_IMPOR, jadi berkas keluaran versi lama masih bisa diimport utuh.
const KOLOM_EXPORT = ['nama', 'tipe', 'paket', 'agen', 'username_pppoe',
  'password_pppoe', 'nomor_whatsapp', 'email', 'alamat', 'latitude', 'longitude',
  'mac_address', 'status', 'tanggal_masuk', 'profil_tagihan'];

/** Judul kolom memakai Bahasa Indonesia; import tetap mengenali nama lama. */
const LABEL_ID = {
  nama: 'Nama', tipe: 'Tipe', paket: 'Paket', agen: 'Agen',
  username_pppoe: 'Username PPPoE', password_pppoe: 'Password PPPoE',
  nomor_whatsapp: 'Nomor WhatsApp', email: 'Email', alamat: 'Alamat',
  latitude: 'Latitude', longitude: 'Longitude',
  ip_address: 'IP Address', mac_address: 'MAC Address', status: 'Status',
  tanggal_masuk: 'Tanggal Masuk', profil_tagihan: 'Profile Tagihan',
  hari_tagihan: 'Hari Tagihan', kode: 'Kode'
};
const judul = (k) => LABEL_ID[k] || k;

/** Nilai sel → teks biasa untuk perbandingan maupun penyimpanan. */
const teksSel = (v) => String(v == null ? '' : v).trim();

/**
 * v2.2.3 — koordinat dari berkas Excel/CSV. Longitudenya bisa 3 digit dan
 * koma desimal adalah kebiasaan Excel locale Indonesia, jadi keduanya diterima.
 * Nilai di luar rentang bumi (contoh -654.53 yang muncul di berkas nyata)
 * ditolak per baris dengan pesan yang jelas — menyimpan koordinat palsu berarti
 * titik di peta jadi salah selamanya.
 */
function koordDariSel(nilai, { nama, min, max }) {
  const mentah = teksSel(nilai).replace(/\s+/g, '').replace(/,/g, '.');
  if (mentah === '') return null;
  if (!/^-?\d{1,3}(\.\d{1,12})?$/.test(mentah)) {
    throw new Error(`${nama} "${teksSel(nilai)}" bukan angka koordinat (contoh ${nama === 'Longitude' ? '110.0438' : '-7.2575'})`);
  }
  const n = Number(mentah);
  if (!(n >= min && n <= max)) {
    throw new Error(`${nama} ${teksSel(nilai)} di luar rentang ${min} sampai ${max} — periksa kolom Latitude/Longitude tidak tertukar`);
  }
  return String(n);
}

/** Baris petunjuk — dipakai sebagai lembar kedua di xlsx dan baris '#' di CSV. */
const PETUNJUK = [
  'Template import data pelanggan — ivvibill',
  'Yang dibaca hanya sheet "Pelanggan" (atau berkas CSV ini). Sheet "Petunjuk" tidak dibaca.',
  'Kolom wajib hanya NAMA. Kolom lain boleh dikosongkan dan akan diisi otomatis.',
  'Tipe: pppoe atau hotspot (kosong = pppoe)',
  'Status: baru, aktif, isolir, nonaktif (kosong = baru). "tidak aktif"/"mati"/"off"/"sudah tidak berlangganan" ikut diterima sebagai nonaktif.',
  'Paket dan Agen diisi NAMANYA persis seperti di aplikasi, bukan nomor ID. Kosongkan bila tidak ada.',
  'Username dan Password PPPoE boleh dikosongkan; bila diisi username dan sudah dipakai pelanggan lain, baris itu ditolak.',
  'Nomor WhatsApp tanpa tanda +, contoh 081234567890',
  'Tanggal Masuk: YYYY-MM-DD, contoh 2026-10-08 (kosong = hari ini)',
  'Latitude dan Longitude: koordinat lokasi dalam angka desimal, contoh -7.2575 dan 110.0438. Koma sebagai pemisah desimal juga diterima. Latitude antara -90 dan 90, Longitude antara -180 dan 180. Kosongkan bila belum tahu — titik hanya muncul di peta bila keduanya terisi.',
  'MAC Address boleh dikosongkan. Tombol "Sinkron MAC dari router" di menu Pelanggan mengisinya dari /ppp/active (sesi berjalan) lalu /ppp/secret (last-caller-id) milik pelanggan PPPoE.',
  'Profile Tagihan: NAMAnya persis seperti di menu Profile Tagihan (mis. IVV-10). Berisi tanggal buat/kirim/isolir, PPN dan peringatan satu golongan warga.',
  'Hari Tagihan TIDAK ada di template ini — tanggal jatuh tempo mengikuti Profile Tagihan. Berkas lama yang masih punya kolom Hari Tagihan (angka 1-28) atau IP Address tetap dibaca; Hari Tagihan hanya dipakai bila Profile Tagihan kosong.',
  'Kode pelanggan dibuat otomatis oleh sistem, jadi tidak perlu dan tidak bisa diisi dari berkas.',
  'Import hanya MENAMBAH pelanggan baru. Baris yang sudah ada tidak diubah dan WhatsApp tidak dikirim saat import.',
  'Baris kosong dan baris yang diawali # diabaikan. Maksimal 1000 baris sekali import.'
];

const CONTOH = [
  ['Budi Santoso', 'pppoe', '10M Rumahan', '', 'budi01', 'rahasia123', '081234567890',
    '', 'Jl. Merdeka No. 1', '-7.2575', '110.0438', '', 'baru', '2026-10-08', 'IVV-10'],
  ['Siti Aminah', 'hotspot', 'Tiket 3 Jam', '', '', '', '089876543210',
    '', 'Perum Griya Asri C2', '-7.2601', '110.0388', '', 'aktif', '2026-10-08', ''],
  ['Andi Wijaya', 'pppoe', '10M Rumahan', '', 'andi01', 'rahasia456', '08111222333',
    '', 'Jl. Kenanga No. 7', '-7.2490', '110.0512', 'AA:BB:CC:DD:EE:FF', 'tidak aktif', '2026-10-08', '']
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
    `SELECT p.nama, p.tipe, pk.nama_paket AS paket, ag.nama AS agen,
       p.username_pppoe, p.password_pppoe, p.nomor_whatsapp, p.email, p.alamat,
       p.latitude, p.longitude, p.mac_address, p.status, p.tanggal_masuk,
       pt.nama AS profil_tagihan
     FROM pelanggan p
     LEFT JOIN paket pk ON pk.id = p.id_paket
     LEFT JOIN agen ag ON ag.id = p.id_agen
     LEFT JOIN profil_tagihan pt ON pt.id = p.id_profil_tagihan
       AND pt.id_data_server = p.id_data_server
     WHERE ${f.where}
     ORDER BY p.id DESC LIMIT 5000`, f.params
  );
  return [KOLOM_EXPORT.map(judul), ...rows.map(r => KOLOM_EXPORT.map(k => sel(r[k])))];
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
  const isi = [KOLOM_EXPORT.map(judul), ...CONTOH];
  if (req.query.format === 'csv') {
    const teks = [...PETUNJUK.map(t => `# ${t}`), isi.map(r => r.map(csv.selCsv).join(',')).join('\r\n')];
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="template-pelanggan.csv"');
    return res.send('\uFEFF' + teks.join('\r\n') + '\r\n');
  }
  unduhXlsx(res, [['Pelanggan', isi], ['Petunjuk', PETUNJUK.map(t => [t])]], 'template-pelanggan.xlsx');
});

/**
 * v2.2.3 — isi MAC Address pelanggan dari router (/ppp/active lalu /ppp/secret).
 * Hanya menulis kolom mac_address; tidak menyentuh status, secret, maupun sesi,
 * dan tidak ikut jalan di scheduler supaya beban router jadi pilihan operator.
 */
router.post('/pelanggan/sinkron-mac', requirePJ(), requireMenu('pelanggan', 'ubah'),
  async (req, res, next) => {
  try {
    const ds = tenantAktif(req);
    const r = await mon.sinkronMacPelanggan(ds);
    await db.insert(
      'INSERT INTO audit_log (user_id, id_data_server, aksi, detail, ip) VALUES (?,?,?,?,?)',
      [req.user.id, ds, 'sinkron_mac',
        `${r.diisi + r.diganti}/${r.dicek} pelanggan PPPoE, ${r.router_terbaca}/${r.router_total} router terbaca`,
        (req.ip || '').replace('::ffff:', '')]
    );
    res.json({ ok: true, ...r });
  } catch (e) { next(e); }
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
  // v2.2.3 — koordinat. Varian bahasa Indonesia + singkatan spreadsheet ikut dikenali.
  latitude: 'latitude', lat: 'latitude', lintang: 'latitude', latitudedesimal: 'latitude',
  longitude: 'longitude', long: 'longitude', lng: 'longitude', bujur: 'longitude',
  status: 'status',
  tanggalmasuk: 'tanggal_masuk', tglmasuk: 'tanggal_masuk', tgl: 'tanggal_masuk',
  haritagihan: 'hari_tagihan',
  // v2.0 — "Profile Tagihan" / "Profil Tagihan" (dan varian tanpa spasi)
  profiletagihan: 'profil_tagihan', profiltagihan: 'profil_tagihan',
  kode: 'kode'                            // berkas lama masih punya kolom ini; sengaja diabaikan
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
// v2.2.0 — impor massal bukan tugas teknisi lapangan: satu file bisa
// menggeser ratusan baris + jadwal tagihan, jadi hanya penanggung jawab tenant.
router.post('/pelanggan/import', requirePJ(),
  requireMenu('pelanggan', 'tambah'), uploadImpor.single('file'), async (req, res, next) => {
  try {
    if (!req.file || !req.file.buffer) {
      return res.status(400).json({ error: 'File Excel/CSV belum dipilih (field: file)' });
    }
    const ds = tenantAktif(req);

    const [paketRows, agenRows, pref, profilRows] = await Promise.all([
      db.q('SELECT id, nama_paket FROM paket WHERE id_data_server = ?', [ds]),
      db.q('SELECT id, nama FROM agen WHERE id_data_server = ?', [ds]),
      db.q('SELECT prefix_invoice FROM data_server WHERE id = ?', [ds]),
      db.q(`SELECT id, nama, tanggal_isolir FROM profil_tagihan
            WHERE id_data_server = ? AND status = 'aktif'`, [ds])
    ]);
    const petaPaket = new Map(paketRows.map(p => [String(p.nama_paket).toLowerCase(), Number(p.id)]));
    const petaAgen = new Map(agenRows.map(a => [String(a.nama).toLowerCase(), Number(a.id)]));
    const petaProfil = new Map(profilRows.map(x => [String(x.nama).toLowerCase(), x]));
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
      return res.status(400).json({
        error: 'Baris judul "Nama" tidak ditemukan — unduh template lalu isi sheet "Pelanggan" tanpa mengubah judulnya' });
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
        // v2.2.3 — koordinat ikut diisi dari berkas. Simpan sebagai teks bersih
        // (kolomnya VARCHAR(30)) supaya tidak ada selisih pembulatan float.
        const lat = koordDariSel(amb(r, 'latitude'),
          { nama: 'Latitude', min: -90, max: 90 });
        const long = koordDariSel(amb(r, 'longitude'),
          { nama: 'Longitude', min: -180, max: 180 });
        const status = v.enumOf(v.normalStatus(amb(r, 'status')), STATUS, 'baru');
        const tglMasuk = v.tgl(amb(r, 'tanggal_masuk') || null, hariIni);
        // v2.0: Profile Tagihan adalah sumber jadwal. Kalau terisi, hari_tagihan
        // mengikuti tanggal_isolir profil; kalau kosong, kolom Hari Tagihan lama
        // tetap berlaku persis seperti sebelum v2.0. Sejak v2.2.3 kolom itu tidak
        // lagi ada di template, tapi berkas yang masih memilikinya dibaca normal.
        const namaProfil = amb(r, 'profil_tagihan');
        let pt = null;
        if (namaProfil) {
          pt = petaProfil.get(namaProfil.toLowerCase()) || null;
          if (!pt) throw new Error(`Profile Tagihan "${namaProfil}" tidak ditemukan (atau nonaktif) di data server ini`);
        }
        const hariTagihan = pt ? Number(pt.tanggal_isolir)
          : v.num(amb(r, 'hari_tagihan') || null, { min: 1, max: 28, def: 1, int: true });

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
            latitude, longitude, tanggal_masuk, hari_tagihan, id_profil_tagihan, status)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          [ds, kode, nama, alamat, nowa, email, tipe, idPaket, idAgen,
            username, pass, ip, mac, lat, long, tglMasuk, hariTagihan,
            pt ? Number(pt.id) : null, status]
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
    // v2.2.0 — status adalah keputusan bisnis pemilik ISP (aktivasi, isolir,
    // nonaktif). Teknisi tidak lagi boleh mengubahnya, bahkan lewat API, karena
    // aplikasinya juga tidak menawarkan tombolnya.
    if (req.user.role === 'teknisi') {
      return res.status(403).json({ error:
        'Perubahan status pelanggan (aktif/isolir/nonaktif) dilakukan admin data server' });
    }
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
      const sebelumnya = p.status;
      await db.run('UPDATE pelanggan SET status = ? WHERE id = ?', [status, id]);
      let router = null;
      try {
        router = await sinkronRouter(p, status, ds);
      } catch (e) {
        router = { router: null, gagal: [String(e.message).slice(0, 120)] };
      }
      // Aksi manual harus memberi efek yang sama dengan siklus otomatis:
      // pelanggan diisolir = layanan benar-benar dibatasi/putus DI ROUTER
      // (sudah ditangani sinkronRouter) + warga dikabari lewat WA.
      let waTerkirim = false;
      try {
        if (status === 'isolir' && sebelumnya !== 'isolir') {
          waTerkirim = await billing.kirimWaIsolirPelanggan(id, ds);
          const t = await db.one(
            `SELECT nomor_invoice, total FROM tagihan WHERE id_pelanggan = ? AND status != 'batal'
             ORDER BY (status = 'lunas'), jatuh_tempo ASC, id DESC LIMIT 1`, [id]);
          await db.insert(
            'INSERT INTO issue_pelanggan (id_pelanggan, tipe, pesan) VALUES (?,?,?)',
            [id, 'isolir', t ? `Isolir manual — tagihan ${t.nomor_invoice} (Rp ${Number(t.total).toLocaleString('id-ID')})`
              : 'Isolir manual dari panel']);
        }
        if (status === 'aktif' && sebelumnya === 'isolir') {
          await db.run('DELETE FROM issue_pelanggan WHERE id_pelanggan = ? AND tipe IN (?,?)',
            [id, 'menunggak', 'isolir']);
        }
      } catch (e) {
        router = { ...(router || {}), gagal: [...((router && router.gagal) || []), `WA: ${String(e.message).slice(0, 120)}`] };
      }
      await db.insert('INSERT INTO audit_log (user_id, id_data_server, aksi, detail, ip) VALUES (?,?,?,?,?)',
        [req.user.id, ds, 'ubah_status_pelanggan', `#${id} ${p.nama} -> ${status}`, (req.ip || '').replace('::ffff:', '')]);
      diubah.push({ id, status, router, wa_terkirim: waTerkirim });
    }
    res.json({ diubah, gagal });
  } catch (e) { next(e); }
}

router.post('/pelanggan/status', requireRole('superadmin', 'master'),
  requireMenu('pelanggan', 'ubah'), ubahStatusBulk);

router.post('/pelanggan/:id/status', requireRole('superadmin', 'master'),
  requireMenu('pelanggan', 'ubah'), (req, res, next) => {
    req.body = { ...req.body, ids: [req.params.id] };
    return ubahStatusBulk(req, res, next);
  });

/** Isi WA aktivasi bila tenant belum punya template 'aktivasi' sama sekali. */
const TPL_AKTIVASI_BAWAAN =
  'Halo #usr, layanan #lyn atas nama #ppp sudah AKTIF dan bisa dipakai. Terima kasih.';

/**
 * Aktivasi pelanggan baru — khusus penanggung jawab data server (superadmin
 * pemilik platform / master ISP). Teknisi boleh mendaftarkan pelanggan dan
 * membuka Remote ONU, tetapi "menyalakan layanan" adalah keputusan bisnis
 * pemilik ISP: di sini secret PPPoE dicetak (bila router belum punya) atau
 * diyakinkan hidup, status naik ke 'aktif', issue isolir dibersihkan, lalu
 * warga dikabari lewat WA template 'aktivasi'.
 *
 * Semua router gagal → status TIDAK diubah dan kode 502 dikembalikan, supaya
 * tombol bisa ditekan ulang dan 'aktif' tidak pernah berarti diam-diam.
 */
router.post('/pelanggan/:id/aktivasi', requirePJ(), requireMenu('pelanggan', 'ubah'),
  async (req, res, next) => {
  try {
    const id = v.num(req.params.id, { int: true, min: 1 });
    const ts = tenantSql(req, 'id_data_server');
    const p = await db.one(`SELECT * FROM pelanggan WHERE id = ?${ts.sql}`, [id, ...ts.params]);
    if (!p) return res.status(404).json({ error: 'Pelanggan tidak ada di data server ini' });
    const ds = Number(p.id_data_server) || tenantAktif(req);
    if (p.status === 'aktif') {
      return res.status(400).json({ error: 'Pelanggan sudah aktif — pakai tombol Aktifkan/Isolir untuk sinkron ulang' });
    }

    const pk = p.id_paket
      ? await db.one('SELECT nama_paket, profile_pppoe FROM paket WHERE id = ? AND id_data_server = ?',
        [p.id_paket, ds])
      : null;
    const srv = await db.one('SELECT nama_server FROM data_server WHERE id = ?', [ds]);

    let hasilRouter = null;
    if (p.tipe === 'pppoe') {
      if (!p.username_pppoe) {
        return res.status(400).json({ error: 'Username PPPoE kosong — lengkapi datanya dulu sebelum diaktivasi' });
      }
      hasilRouter = await mon.pastikanSecret(p.username_pppoe, {
        password: p.password_pppoe, profil: pk && pk.profile_pppoe, idDataServer: ds
      });
      if (!hasilRouter.router.length) {
        const alasan = hasilRouter.tanpa_router
          ? 'belum ada router MikroTik aktif di data server ini'
          : (hasilRouter.gagal[0] || 'secret tidak berhasil dibuat di router');
        await db.insert('INSERT INTO audit_log (user_id, id_data_server, aksi, detail, ip) VALUES (?,?,?,?,?)',
          [req.user.id, ds, 'aktivasi_pelanggan_gagal',
            `#${id} ${p.nama}: ${alasan}`, (req.ip || '').replace('::ffff:', '')]);
        return res.status(502).json({
          error: `Aktivasi dibatalkan — ${alasan}. Status pelanggan tidak diubah, coba lagi setelah router terjangkau.`,
          router: hasilRouter
        });
      }
    }

    await db.run("UPDATE pelanggan SET status = 'aktif', profil_sebelum_isolir = NULL WHERE id = ?", [id]);
    await db.run("DELETE FROM issue_pelanggan WHERE id_pelanggan = ? AND tipe IN ('menunggak','isolir')", [id]);

    // Kabar pelanggan: jalur ini satu-satunya yang mengirim template 'aktivasi',
    // jadi isinya ikut dilaporkan ke tombol (terkirim / tanpa nomor / gagal).
    let waTerkirim = false, waGagal = null;
    if (p.nomor_whatsapp) {
      try {
        const tpl = await wa.ambilTemplate('aktivasi', ds) || TPL_AKTIVASI_BAWAAN;
        const pesan = wa.render(tpl, {
          usr: p.nama, ppp: p.username_pppoe || '-', srv: (srv && srv.nama_server) || 'layanan',
          lyn: (pk && pk.nama_paket) || 'layanan'
        });
        if (pesan.trim()) {
          await wa.enqueue({ tujuan: p.nomor_whatsapp, jenis: 'aktivasi', pesan, idRef: id, idDataServer: ds });
          waTerkirim = true;
        }
      } catch (e) { waGagal = String(e.message).slice(0, 140); }
    }

    await db.insert('INSERT INTO audit_log (user_id, id_data_server, aksi, detail, ip) VALUES (?,?,?,?,?)',
      [req.user.id, ds, 'aktivasi_pelanggan',
        `#${id} ${p.nama} → aktif (secret: ${hasilRouter ? hasilRouter.dibuat.length : 0} baru, `
        + `${hasilRouter ? hasilRouter.diaktifkan.length : 0} dihidupkan); WA: ${waTerkirim ? 'antre' : (p.nomor_whatsapp ? 'gagal' : 'tanpa nomor')}`,
        (req.ip || '').replace('::ffff:', '')]);

    res.json({
      ok: true, id, nama: p.nama, status: 'aktif',
      router: hasilRouter, wa_terkirim: waTerkirim, wa_gagal: waGagal,
      tanpa_nomor_wa: !p.nomor_whatsapp
    });
  } catch (e) { next(e); }
});


router.get('/pelanggan/:id', async (req, res, next) => {
  try {
    const id = v.num(req.params.id, { int: true, min: 1 });
    const ts = tenantSql(req, 'p.id_data_server');
    const p = await db.one(
      `SELECT p.*, pk.nama_paket, pk.harga, ps.online AS pppoe_online, ps.last_seen,
         ps.ip_address AS ip_lokal,
         pt.nama AS profil_tagihan, pt.tanggal_isolir AS profil_tanggal_isolir,
         mt.nama AS nama_topologi, md.nama AS nama_desa,
         o.mac AS mac_onu, o.sn AS sn_onu,
         o.rx_dbm, o.redaman_db, o.status_redaman
       FROM pelanggan p
       LEFT JOIN paket pk ON pk.id = p.id_paket
       LEFT JOIN profil_tagihan pt ON pt.id = p.id_profil_tagihan
         AND pt.id_data_server = p.id_data_server
       LEFT JOIN pppoe_status ps ON ps.id_pelanggan = p.id
       LEFT JOIN master_topologi mt ON mt.id = p.id_master_topologi
       LEFT JOIN master_desa md ON md.id = p.id_master_desa
       LEFT JOIN master_onu o ON o.id = (SELECT MAX(o2.id) FROM master_onu o2 WHERE o2.id_pelanggan = p.id)
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
    const idAgen = v.num(req.body.id_agen, { int: true, min: 1, def: null });
    // profil isolir hanya berlaku untuk PPPoE (profil di /ppp/profile);
    // pelanggan hotspot diisolir lewat akun user/vouchernya sendiri
    const profilIsolir = v.str(req.body.profile_isolir, { max: 64, def: null });
    let jadwal;
    try { jadwal = await kebijakanTagihanPelanggan(ds, req.body, null); }
    catch (e) { return res.status(400).json({ error: e.message }); }
    const hariTagihan = jadwal.hariTagihan;
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
        tanggal_masuk, hari_tagihan, id_profil_tagihan, status, profile_isolir,
        id_master_topologi, id_master_desa, port_odp, latitude, longitude)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?, ?, 'baru', ?,?,?,?,?,?)`,
      [ds, kode, nama, alamat, nowa, email, tipe, idPaket, idAgen, username, passPppoe, ip, mac, tglMasuk, hariTagihan,
        jadwal.idProfilTagihan,
        tipe === 'pppoe' ? profilIsolir : null,
        lok.idMasterTopologi, lok.idMasterDesa, lok.portOdp, lok.latitude, lok.longitude]
    );
    await db.insert('INSERT INTO audit_log (user_id, id_data_server, aksi, detail, ip) VALUES (?,?,?,?,?)',
      [req.user.id, ds, 'tambah_pelanggan', `${nama} (#${id})`, (req.ip || '').replace('::ffff:', '')]);

    if (nowa) {
      const tpl = await wa.ambilTemplate('registrasi', ds);
      // Template bawaan memakai #usr #lyn #srv #ppp — dulu hanya usr dan lyn
      // yang dikirim, sehingga pesan pelanggan berbunyi "Selamat datang di !"
      // dengan nama ISP kosong.
      const pk = idPaket
        ? await db.one('SELECT nama_paket FROM paket WHERE id=? AND id_data_server=?', [idPaket, ds])
        : null;
      const srv = await db.one('SELECT nama_server FROM data_server WHERE id=?', [ds]);
      const pesan = wa.render(tpl, {
        usr: nama, lyn: (pk && pk.nama_paket) || 'layanan',
        srv: (srv && srv.nama_server) || '', ppp: username || '', add: alamat || ''
      });
      await wa.enqueue({ tujuan: nowa, jenis: 'registrasi', pesan, idRef: id, idDataServer: ds });
    }
    res.json({ id, kode });
  } catch (e) { next(e); }
});

/**
 * Input Billing dari tab Unmanage (v2.5.0) — satu kali klik mengubah sesi PPPoE
 * "liar" menjadi pelanggan terdaftar PLUS tagihan periode berjalan.
 *
 * Isian datang dari form lengkap yang sudah terisi otomatis oleh sesi: akun,
 * IP, MAC, ONU/redaman. Sengaja TIDAK menulis apa pun ke router: akun ini sudah
 * hidup di sana (secret dibuat manual/di luar aplikasi), jadi pembatasan
 * bandwidth tetap lewat tombol ⚡ Aktivasi seperti pendaftaran biasa — supaya
 * "menyalakan layanan" tetap keputusan penanggung jawab ISP.
 * Tagihan memakai jalur yang sama dengan menu Tagihan (buatTagihanSatuan),
 * sehingga dedupe per periode, PPN, kode unik, dan jatuh temponya identik.
 */
router.post('/pelanggan/dari-sesi',
  requireRole('superadmin', 'master', 'teknisi'),
  requireMenu('pelanggan', 'tambah'), requireMenu('tagihan', 'tambah'),
  async (req, res, next) => {
  try {
    const ds = tenantAktif(req);
    const body = req.body || {};

    const username = v.str(body.username_pppoe, { min: 2, max: 50 });
    const nama = v.str(body.nama, { min: 2, max: 100 });
    const tipe = v.enumOf(body.tipe, ['pppoe', 'hotspot'], 'pppoe');
    const alamat = v.str(body.alamat, { max: 255, def: null });
    const nowa = v.phone(body.nomor_whatsapp);
    const email = v.email(body.email);
    const idPaket = v.num(body.id_paket, { int: true, min: 1, def: null });
    const passPppoe = v.str(body.password_pppoe, { max: 50, def: null });
    const ip = v.str(body.ip_address, { max: 40, def: null });
    const mac = v.str(body.mac_address, { max: 40, def: null });
    const tglMasuk = v.tgl(body.tanggal_masuk, billing.waktuSiklus().hari);
    const idAgen = v.num(body.id_agen, { int: true, min: 1, def: null });
    const profilIsolir = v.str(body.profile_isolir, { max: 64, def: null });
    const catatan = v.str(body.catatan, { max: 5000, def: null });

    const tagih = !(body.buat_tagihan === false || body.buat_tagihan === '0'
      || body.buat_tagihan === 'false' || body.buat_tagihan === '');
    const periode = v.str(body.periode, { max: 7, def: '' });
    if (tagih && periode && !/^\d{4}-\d{2}$/.test(periode)) {
      return res.status(400).json({ error: 'Periode harus YYYY-MM' });
    }
    const jumlah = body.jumlah === '' || body.jumlah == null
      ? null : v.num(body.jumlah, { min: 0, max: 1e9 });
    const diskon = v.num(body.diskon, { min: 0, max: 1e9, def: 0 });
    const ketTagihan = v.str(body.keterangan, { max: 255, def: null });
    const jatuhTempo = v.tgl(body.jatuh_tempo, null);

    let jadwal;
    try { jadwal = await kebijakanTagihanPelanggan(ds, body, null); }
    catch (e) { return res.status(400).json({ error: e.message }); }
    let lok;
    try { lok = await validasiLokasi(req, body, null); }
    catch (e) { return res.status(400).json({ error: e.message }); }

    const dup = await db.one(
      'SELECT id, nama, status FROM pelanggan WHERE username_pppoe = ? AND id_data_server = ?',
      [username, ds]);
    if (dup) {
      return res.status(400).json({
        error: `Akun ${username} sudah menjadi pelanggan #${dup.id} (${dup.nama}, ${dup.status})`,
        sudah_ada: true, id_pelanggan: Number(dup.id)
      });
    }
    if (idPaket) {
      const pk = await db.one('SELECT id FROM paket WHERE id = ? AND id_data_server = ?', [idPaket, ds]);
      if (!pk) return res.status(400).json({ error: 'Paket tidak ada di data server ini' });
    }

    const [{ prefix_invoice }] = await db.q(
      'SELECT prefix_invoice FROM data_server WHERE id = ?', [ds]);
    const kode = `${prefix_invoice || 'IVV'}${Date.now().toString(36).toUpperCase()}`;
    const asalSesi = v.str(body.sumber_sesi, { max: 120, def: null });
    const id = await db.insert(
      `INSERT INTO pelanggan (id_data_server, kode, nama, alamat, nomor_whatsapp, email, tipe,
        id_paket, id_agen, username_pppoe, password_pppoe, ip_address, mac_address,
        tanggal_masuk, hari_tagihan, id_profil_tagihan, status, profile_isolir,
        id_master_topologi, id_master_desa, port_odp, latitude, longitude, catatan)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?, 'baru', ?,?,?,?,?,?,?)`,
      [ds, kode, nama, alamat, nowa, email, tipe, idPaket, idAgen, username, passPppoe, ip, mac,
        tglMasuk, jadwal.hariTagihan, jadwal.idProfilTagihan,
        tipe === 'pppoe' ? profilIsolir : null,
        lok.idMasterTopologi, lok.idMasterDesa, lok.portOdp, lok.latitude, lok.longitude,
        [catatan, asalSesi ? `Didata dari sesi router: ${asalSesi}` : null]
          .filter(Boolean).join(' | ') || null]
    );

    let hasilTagihan = null;
    if (tagih) {
      try {
        hasilTagihan = await billing.buatTagihanSatuan({
          idDataServer: ds, idPelanggan: id,
          periode: periode || billing.waktuSiklus().periode,
          keterangan: ketTagihan, jumlah, diskon, jatuhTempo
        });
      } catch (e) {
        // pelanggan sudah terdaftar — jangan gagal total: tagihannya bisa dibuat
        // ulang dari menu Tagihan, dan ini yang mau dibaca operator di layar.
        hasilTagihan = { error: String(e.message).slice(0, 200) };
      }
    }

    await db.insert('INSERT INTO audit_log (user_id, id_data_server, aksi, detail, ip) VALUES (?,?,?,?,?)',
      [req.user.id, ds, 'input_billing_sesi',
        `${nama} (#${id}) ${username}${hasilTagihan && hasilTagihan.id
          ? ` → tagihan #${hasilTagihan.id}` : ''}`,
        (req.ip || '').replace('::ffff:', '')]);

    res.json({
      id, kode, status: 'baru', username,
      tagihan: hasilTagihan,
      petunjuk: 'Pelanggan tercatat sebagai BARU — tekan ⚡ Aktivasi di daftar Pelanggan'
        + ' supaya secret PPPoE-nya memakai profil paket dan layanannya resmi aktif.'
    });
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
    const status = v.enumOf(v.normalStatus(req.body.status), ['baru', 'aktif', 'isolir', 'nonaktif'], p.status);
    const catatan = v.str(req.body.catatan, { max: 5000, def: p.catatan });
    // dikirim kosong = sengaja dihapus (isolir kembali ke perilaku matikan secret)
    const profilIsolir = Object.prototype.hasOwnProperty.call(req.body, 'profile_isolir')
      ? v.str(req.body.profile_isolir, { max: 64, def: null }) : p.profile_isolir;
    let jadwal;
    try { jadwal = await kebijakanTagihanPelanggan(ds, req.body, p); }
    catch (e) { return res.status(400).json({ error: e.message }); }
    let lok;
    try { lok = await validasiLokasi(req, req.body, p, ds); }
    catch (e) { return res.status(400).json({ error: e.message }); }

    // v2.2.0 — teknisi tidak mengubah status sama sekali: menyalakan layanan
    // (aktivasi) dan memutus/menonaktifkannya adalah wewenang admin tenant.
    if (req.user.role === 'teknisi' && status !== p.status) {
      return res.status(403).json({ error:
        'Teknisi tidak dapat mengubah status pelanggan — aktivasi/nonaktif dilakukan admin data server' });
    }

    const statusBaru = status !== p.status;
    const profilBerubah = (profilIsolir || null) !== (p.profile_isolir || null);
    await db.run(
      `UPDATE pelanggan SET nama=?, alamat=?, nomor_whatsapp=?, id_paket=?, username_pppoe=?,
        password_pppoe=?, ip_address=?, status=?, profile_isolir=?, catatan=?,
        id_profil_tagihan=?, hari_tagihan=?,
        id_master_topologi=?, id_master_desa=?, port_odp=?, latitude=?, longitude=? WHERE id=?`,
      [nama, alamat, nowa, idPaket, username, passPppoe, ip, status, profilIsolir, catatan,
        jadwal.idProfilTagihan, jadwal.hariTagihan,
        lok.idMasterTopologi, lok.idMasterDesa, lok.portOdp, lok.latitude, lok.longitude, id]
    );

    if (statusBaru && status === 'aktif' && p.status === 'baru' && nowa) {
      const tpl = await wa.ambilTemplate('aktivasi', ds);
      const pesan = wa.render(tpl, { usr: nama, ppp: username || '-', lyn: 'layanan' });
      await wa.enqueue({ tujuan: nowa, jenis: 'aktivasi', pesan, idRef: id, idDataServer: ds });
    }

    // status adalah cara operator memutus/membatasi koneksi, jadi secret PPPoE
    // ikut diset — termasuk saat profil isolir pelanggan diubah ketika status
    // sudah isolir (profil baru langsung dipakai)
    let router = null;
    // v2.2.0 — baru → aktif lewat form berarti mengaktivasi pelanggan: secretnya
    // dicetak dulu. sinkronStatus() hanya menyalakan secret yang sudah ada, jadi
    // jalur lama membuat pelanggan 'aktif' di DB tapi tak pernah bisa konek.
    if (statusBaru && status === 'aktif' && p.status === 'baru'
        && p.tipe === 'pppoe' && username) {
      const pk = idPaket ? await db.one(
        'SELECT profile_pppoe FROM paket WHERE id = ? AND id_data_server = ?', [idPaket, ds]) : null;
      router = { cara: 'aktivasi',
        ...(await mon.pastikanSecret(username, {
          password: passPppoe, profil: pk && pk.profile_pppoe, idDataServer: ds
        })) };
    } else if (statusBaru || (status === 'isolir' && profilBerubah)) {
      try {
        router = await sinkronRouter({ ...p, id, tipe: p.tipe, username_pppoe: username,
          profile_isolir: profilIsolir }, status, ds);
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
