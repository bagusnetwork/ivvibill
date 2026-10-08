'use strict';
// ============================================================
// Kelola tenant (data_server) + grup akses — model gratisinaja:
// satu baris data_server = satu ISP, lengkap dengan login master,
// prefix invoice, jadwal tagihan, dan grant menu per grup.
//
// CRUD data_server khusus pemilik platform (superadmin, tenant 1);
// grup akses dikelola penanggung jawab tenant untuk tenant-nya sendiri.
// ============================================================
const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db');
const v = require('../util/validate');
const config = require('../config');
const cfgData = require('../services/configData');
const { requireAuth, requireRole, requirePJ } = require('../middleware/auth');
const { tenantSql, tenantAktif } = require('../util/scope');

const router = express.Router();
router.use(requireAuth);

/** Menu panel yang bisa dibatasi per grup akses. */
// Menu v1.2.0+ (topologi, desa, noc, keuangan, tiket) dan Peta sebaran ikut
// terdaftar: tanpa entri di daftar ini grup akses tidak bisa memberi izinnya,
// sehingga menu baru selalu tersembunyi bagi pengguna bergroup.
const MENU = [
  'dashboard', 'pelanggan', 'tagihan', 'invoice', 'pembayaran', 'paket', 'voucher', 'agen',
  'interface', 'olt', 'issue', 'perangkat', 'pengguna', 'wa', 'setting',
  'topologi', 'desa', 'noc', 'keuangan', 'tiket', 'peta',
  // v1.5: absensi. Entri ini hanya gating tab "Absensi Teknisi" di panel; teknisi
  // mencatat kehadirannya sendiri lewat /teknisi/ tanpa bergantung grant grup,
  // sama seperti Order Pekerjaan.
  'absen',
  'data_server', 'group_akses'
];

// ------------------------------------------------------ data server
router.get('/data-server', requireRole('superadmin'), async (req, res, next) => {
  try {
    const rows = await db.q(
      `SELECT id, nama_server, nama_pemilik, nomor_whatsapp, email, alamat, prefix_invoice,
              username, expaired_date, status, jadwal_buat_hari, jadwal_kirim_hari,
              jadwal_limit_hari, jam_kirim, ppn_persen, wa_status, pg_active, created_at
       FROM data_server ORDER BY id`
    );
    res.json({ data: rows });
  } catch (e) { next(e); }
});

router.post('/data-server', requireRole('superadmin'), async (req, res, next) => {
  try {
    const nama = v.str(req.body.nama_server, { min: 2, max: 100 });
    const username = v.str(req.body.username, { min: 3, max: 50, def: null });
    const pass = req.body.password ? v.password(req.body.password) : null;
    if (username && !pass) return res.status(400).json({ error: 'Password master wajib diisi' });
    if (username) {
      const dup = await db.one('SELECT id FROM data_server WHERE username = ?', [username]);
      if (dup) return res.status(400).json({ error: 'Username master sudah dipakai' });
    }
    const hash = pass ? await bcrypt.hash(pass, config.security.bcryptRounds) : null;
    const id = await db.insert(
      `INSERT INTO data_server (nama_server, nama_pemilik, nomor_whatsapp, email, alamat,
         prefix_invoice, username, password_hash, expaired_date, status,
         jadwal_buat_hari, jadwal_kirim_hari, jadwal_limit_hari, jam_kirim, ppn_persen)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [nama, v.str(req.body.nama_pemilik, { max: 100, def: null }), v.phone(req.body.nomor_whatsapp),
       v.email(req.body.email), v.str(req.body.alamat, { max: 255, def: null }),
       v.str(req.body.prefix_invoice, { min: 2, max: 10, def: 'IVV' }).toUpperCase(),
       username, hash, v.tgl(req.body.expaired_date, null),
       v.enumOf(req.body.status, ['Aktif', 'Tidak Aktif'], 'Aktif'),
       v.num(req.body.jadwal_buat_hari, { min: 1, max: 28, def: 1, int: true }),
       v.num(req.body.jadwal_kirim_hari, { min: 1, max: 28, def: 2, int: true }),
       v.num(req.body.jadwal_limit_hari, { min: 1, max: 28, def: 10, int: true }),
       v.str(req.body.jam_kirim, { min: 4, max: 5, def: '07:00' }),
       v.num(req.body.ppn_persen, { min: 0, max: 100, def: 0 })]
    );
    // ISP baru mulai dengan blank copy template WA milik tenant 1
    await db.run(
      `INSERT INTO pesan_template (id_data_server, jenis, konten) SELECT ?, jenis, konten
       FROM pesan_template WHERE id_data_server = 1`, [id]
    );
    await db.insert('INSERT INTO audit_log (user_id, id_data_server, aksi, detail, ip) VALUES (?,?,?,?,?)',
      [req.user.id, id, 'tambah_data_server', nama, (req.ip || '').replace('::ffff:', '')]);
    res.json({ id });
  } catch (e) { next(e); }
});

router.put('/data-server/:id', requireRole('superadmin'), async (req, res, next) => {
  try {
    const id = v.num(req.params.id, { int: true, min: 1 });
    const d = await db.one('SELECT * FROM data_server WHERE id = ?', [id]);
    if (!d) return res.status(404).json({ error: 'Data server tidak ada' });
    const nama = v.str(req.body.nama_server, { min: 2, max: 100, def: d.nama_server });
    const username = v.str(req.body.username, { max: 50, def: d.username });
    const pass = req.body.password ? v.password(req.body.password) : null;
    if (username) {
      const dup = await db.one('SELECT id FROM data_server WHERE username = ? AND id != ?', [username, id]);
      if (dup) return res.status(400).json({ error: 'Username master sudah dipakai' });
    }
    const status = v.enumOf(req.body.status, ['Aktif', 'Tidak Aktif'], d.status);
    if (id === 1 && status !== 'Aktif') {
      return res.status(400).json({ error: 'Tenant 1 (pemilik platform) tidak boleh dinonaktifkan' });
    }
    await db.run(
      `UPDATE data_server SET nama_server=?, nama_pemilik=?, nomor_whatsapp=?, email=?, alamat=?,
        prefix_invoice=?, username=?, expaired_date=?, status=?, jadwal_buat_hari=?, jadwal_kirim_hari=?,
        jadwal_limit_hari=?, jam_kirim=?, ppn_persen=? WHERE id=?`,
      [nama, v.str(req.body.nama_pemilik, { max: 100, def: d.nama_pemilik }),
       v.phone(req.body.nomor_whatsapp) ?? d.nomor_whatsapp, v.email(req.body.email) ?? d.email,
       v.str(req.body.alamat, { max: 255, def: d.alamat }),
       v.str(req.body.prefix_invoice, { min: 2, max: 10, def: d.prefix_invoice }).toUpperCase(),
       username || null, v.tgl(req.body.expaired_date, d.expaired_date), status,
       v.num(req.body.jadwal_buat_hari, { min: 1, max: 28, def: d.jadwal_buat_hari, int: true }),
       v.num(req.body.jadwal_kirim_hari, { min: 1, max: 28, def: d.jadwal_kirim_hari, int: true }),
       v.num(req.body.jadwal_limit_hari, { min: 1, max: 28, def: d.jadwal_limit_hari, int: true }),
       v.str(req.body.jam_kirim, { min: 4, max: 5, def: d.jam_kirim }),
       v.num(req.body.ppn_persen, { min: 0, max: 100, def: Number(d.ppn_persen) }), id]
    );
    if (pass) {
      const hash = await bcrypt.hash(pass, config.security.bcryptRounds);
      await db.run('UPDATE data_server SET password_hash=? WHERE id=?', [hash, id]);
    }
    cfgData.invalidate(id);
    await db.insert('INSERT INTO audit_log (user_id, id_data_server, aksi, detail, ip) VALUES (?,?,?,?,?)',
      [req.user.id, id, 'ubah_data_server', nama, (req.ip || '').replace('::ffff:', '')]);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

router.delete('/data-server/:id', requireRole('superadmin'), async (req, res, next) => {
  try {
    const id = v.num(req.params.id, { int: true, min: 1 });
    if (id === 1) return res.status(400).json({ error: 'Tenant 1 adalah pemilik platform' });
    const ada = await db.one('SELECT id FROM data_server WHERE id = ?', [id]);
    if (!ada) return res.status(404).json({ error: 'Data server tidak ada' });
    const [pakai] = await db.q(
      `SELECT
        (SELECT COUNT(*) FROM pelanggan WHERE id_data_server=?) AS pelanggan,
        (SELECT COUNT(*) FROM tagihan WHERE id_data_server=?) AS tagihan,
        (SELECT COUNT(*) FROM paket WHERE id_data_server=?) AS paket,
        (SELECT COUNT(*) FROM agen WHERE id_data_server=?) AS agen,
        (SELECT COUNT(*) FROM master_perangkat WHERE id_data_server=?) AS perangkat,
        (SELECT COUNT(*) FROM app_user WHERE FIND_IN_SET(?, id_data_server)) AS pengguna`,
      [id, id, id, id, id, String(id)]
    );
    const terisi = Object.entries(pakai).filter(([, n]) => Number(n) > 0);
    if (terisi.length) {
      return res.status(400).json({
        error: `Masih dipakai: ${terisi.map(([k, n]) => `${k} ${n}`).join(', ')}`
      });
    }
    await db.tx(async (t) => {
      await t.run('DELETE FROM group_akses WHERE id_data_server = ?', [id]);
      await t.run('DELETE FROM pesan_template WHERE id_data_server = ?', [id]);
      await t.run('DELETE FROM setting_app WHERE id_data_server = ?', [id]);
      await t.run('DELETE FROM rekening WHERE id_data_server = ?', [id]);
      await t.run('DELETE FROM wa_queue WHERE id_data_server = ?', [id]);
      await t.run('DELETE FROM data_server WHERE id = ?', [id]);
    });
    cfgData.invalidate(id);
    await db.insert('INSERT INTO audit_log (user_id, id_data_server, aksi, detail, ip) VALUES (?,?,?,?,?)',
      [req.user.id, 1, 'hapus_data_server', `#${id}`, (req.ip || '').replace('::ffff:', '')]);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// ---------------------------------------------------- grup akses
router.get('/group-akses', requirePJ(), async (req, res, next) => {
  try {
    const ts = tenantSql(req, 'id_data_server');
    const rows = await db.q(
      `SELECT id, id_data_server, nama, akses, status, created_at FROM group_akses
       WHERE 1=1${ts.sql} ORDER BY id_data_server, nama`, ts.params);
    res.json({ data: rows, menus: MENU });
  } catch (e) { next(e); }
});

/** Grant dari UI: {"menu":{"tagihan":true,"pelanggan":{"sub_menu":["tambah"]}}}; kosong = semua. */
function bersihkanAkses(isi) {
  if (typeof isi === 'string') { try { isi = JSON.parse(isi || '{}'); } catch (_) { isi = {}; } }
  if (!isi || !isi.menu || isi.menu === 'all') return '{"menu":"all"}';
  if (typeof isi.menu !== 'object') throw new Error('Format akses tidak dikenali');
  const bersih = {};
  for (const [nama, nilai] of Object.entries(isi.menu)) {
    if (!MENU.includes(nama)) continue;
    if (nilai === true || nilai === false) { bersih[nama] = nilai; continue; }
    const sub = Array.isArray((nilai || {}).sub_menu) ? nilai.sub_menu : [];
    bersih[nama] = { sub_menu: sub.map(s => v.str(s, { max: 40 })) };
  }
  const json = JSON.stringify({ menu: bersih });
  if (json.length > 6000) throw new Error('Daftar akses terlalu panjang');
  return json;
}

async function tentukanGrupTenant(req, diminta) {
  if (req.tenantSemua) {
    const id = v.num(diminta, { int: true, min: 1, def: tenantAktif(req) });
    const ada = await db.one('SELECT id FROM data_server WHERE id = ?', [id]);
    if (!ada) throw new Error('Data server tidak ada');
    return id;
  }
  return tenantAktif(req);
}

router.post('/group-akses', requirePJ(), async (req, res, next) => {
  try {
    const ds = await tentukanGrupTenant(req, req.body.id_data_server);
    const nama = v.str(req.body.nama, { min: 2, max: 100 });
    const akses = bersihkanAkses(req.body.akses);
    const status = v.enumOf(req.body.status, ['aktif', 'nonaktif'], 'aktif');
    const dup = await db.one('SELECT id FROM group_akses WHERE id_data_server = ? AND nama = ?', [ds, nama]);
    if (dup) return res.status(400).json({ error: 'Nama grup sudah ada di data server ini' });
    const id = await db.insert(
      'INSERT INTO group_akses (id_data_server, nama, akses, status) VALUES (?,?,?,?)',
      [ds, nama, akses, status]);
    res.json({ id });
  } catch (e) { next(e); }
});

router.put('/group-akses/:id', requirePJ(), async (req, res, next) => {
  try {
    const id = v.num(req.params.id, { int: true, min: 1 });
    const ts = tenantSql(req, 'id_data_server');
    const g = await db.one(`SELECT * FROM group_akses WHERE id = ?${ts.sql}`, [id, ...ts.params]);
    if (!g) return res.status(404).json({ error: 'Grup akses tidak ada' });
    const nama = v.str(req.body.nama, { min: 2, max: 100, def: g.nama });
    const akses = bersihkanAkses(req.body.akses);
    const status = v.enumOf(req.body.status, ['aktif', 'nonaktif'], g.status);
    await db.run('UPDATE group_akses SET nama=?, akses=?, status=? WHERE id=?', [nama, akses, status, id]);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

router.delete('/group-akses/:id', requirePJ(), async (req, res, next) => {
  try {
    const id = v.num(req.params.id, { int: true, min: 1 });
    const ts = tenantSql(req, 'id_data_server');
    const g = await db.one(`SELECT id FROM group_akses WHERE id = ?${ts.sql}`, [id, ...ts.params]);
    if (!g) return res.status(404).json({ error: 'Grup akses tidak ada' });
    const pemakai = await db.one('SELECT id FROM app_user WHERE id_group_akses = ? LIMIT 1', [id]);
    if (pemakai) return res.status(400).json({ error: 'Masih dipakai pengguna — pindahkan dulu' });
    await db.run('DELETE FROM group_akses WHERE id = ?', [id]);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

module.exports = router;
