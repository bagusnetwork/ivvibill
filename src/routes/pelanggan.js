'use strict';
// ============================================================
// Pelanggan + Paket API
// Akses: superadmin (semua), teknisi (baca + update terbatas),
//         pelanggan (data dirinya saja), agen (pelanggan hotspot-nya)
// ============================================================
const express = require('express');
const db = require('../db');
const v = require('../util/validate');
const { requireAuth, requireRole } = require('../middleware/auth');
const wa = require('../services/wa');

const router = express.Router();
router.use(requireAuth);

// ---------------------------------------------------------- paket
router.get('/paket', async (req, res, next) => {
  try {
    const rows = await db.q(
      'SELECT * FROM paket WHERE id_data_server = 1 ORDER BY jenis, nama_paket'
    );
    res.json({ data: rows });
  } catch (e) { next(e); }
});

router.post('/paket', requireRole('superadmin'), async (req, res, next) => {
  try {
    const nama = v.str(req.body.nama_paket, { min: 2, max: 80 });
    const jenis = v.enumOf(req.body.jenis, ['pppoe', 'hotspot'], 'pppoe');
    const harga = v.num(req.body.harga, { min: 0, max: 1e9, def: 0 });
    const kecepatan = v.str(req.body.kecepatan, { max: 40, def: null });
    const masaAktif = v.num(req.body.masa_aktif, { min: 1, max: 3650, def: 30, int: true });
    const hargaAgen = v.num(req.body.harga_agen, { min: 0, max: 1e9, def: 0 });
    const id = await db.insert(
      `INSERT INTO paket (id_data_server, nama_paket, jenis, harga, kecepatan, masa_aktif, harga_agen)
       VALUES (1,?,?,?,?,?,?)`,
      [nama, jenis, harga, kecepatan, masaAktif, hargaAgen]
    );
    res.json({ id });
  } catch (e) { next(e); }
});

router.put('/paket/:id', requireRole('superadmin'), async (req, res, next) => {
  try {
    const id = v.num(req.params.id, { int: true, min: 1 });
    const p = await db.one('SELECT * FROM paket WHERE id = ?', [id]);
    if (!p) return res.status(404).json({ error: 'Paket tidak ada' });
    const nama = v.str(req.body.nama_paket, { min: 2, max: 80, def: p.nama_paket });
    const jenis = v.enumOf(req.body.jenis, ['pppoe', 'hotspot'], p.jenis);
    const harga = v.num(req.body.harga, { min: 0, max: 1e9, def: Number(p.harga) });
    const kecepatan = v.str(req.body.kecepatan, { max: 40, def: p.kecepatan });
    const masaAktif = v.num(req.body.masa_aktif, { min: 1, max: 3650, def: p.masa_aktif, int: true });
    const hargaAgen = v.num(req.body.harga_agen, { min: 0, max: 1e9, def: Number(p.harga_agen) });
    const status = v.enumOf(req.body.status, ['aktif', 'nonaktif'], p.status);
    await db.run(
      `UPDATE paket SET nama_paket=?, jenis=?, harga=?, kecepatan=?, masa_aktif=?, harga_agen=?, status=? WHERE id=?`,
      [nama, jenis, harga, kecepatan, masaAktif, hargaAgen, status, id]
    );
    res.json({ ok: true });
  } catch (e) { next(e); }
});

router.delete('/paket/:id', requireRole('superadmin'), async (req, res, next) => {
  try {
    const id = v.num(req.params.id, { int: true, min: 1 });
    const dipakai = await db.one('SELECT id FROM pelanggan WHERE id_paket = ? LIMIT 1', [id]);
    if (dipakai) return res.status(400).json({ error: 'Paket masih dipakai pelanggan' });
    await db.run('DELETE FROM paket WHERE id = ?', [id]);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// ------------------------------------------------------- pelanggan
function scopeClause(user) {
  if (user.role === 'pelanggan') return { where: 'p.id = ?', params: [user.id_ref] };
  if (user.role === 'agen') return { where: 'p.id_agen = ?', params: [user.id_ref] };
  return { where: '1=1', params: [] };
}

router.get('/pelanggan', async (req, res, next) => {
  try {
    const s = scopeClause(req.user);
    const cari = v.str(req.query.q, { max: 100, def: '' });
    const tipe = v.enumOf(req.query.tipe, ['pppoe', 'hotspot'], null);
    const status = v.enumOf(req.query.status, ['baru', 'aktif', 'isolir', 'nonaktif'], null);
    const limit = v.num(req.query.limit, { min: 1, max: 200, def: 50, int: true });
    const offset = v.num(req.query.offset, { min: 0, max: 1e6, def: 0, int: true });

    const where = [s.where];
    const params = [...s.params];
    if (cari) { where.push('(p.nama LIKE ? OR p.kode LIKE ? OR p.username_pppoe LIKE ? OR p.nomor_whatsapp LIKE ?)'); params.push(`%${cari}%`, `%${cari}%`, `%${cari}%`, `%${cari}%`); }
    if (tipe) { where.push('p.tipe = ?'); params.push(tipe); }
    if (status) { where.push('p.status = ?'); params.push(status); }

    const rows = await db.q(
      `SELECT p.*, pk.nama_paket, pk.harga, ps.online AS pppoe_online, ps.last_seen
       FROM pelanggan p
       LEFT JOIN paket pk ON pk.id = p.id_paket
       LEFT JOIN pppoe_status ps ON ps.id_pelanggan = p.id
       WHERE ${where.join(' AND ')}
       ORDER BY p.id DESC LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );
    const [{ total }] = await db.q(
      `SELECT COUNT(*) AS total FROM pelanggan p WHERE ${where.join(' AND ')}`, params
    );
    res.json({ data: rows, total });
  } catch (e) { next(e); }
});

router.get('/pelanggan/:id', async (req, res, next) => {
  try {
    const id = v.num(req.params.id, { int: true, min: 1 });
    const p = await db.one(
      `SELECT p.*, pk.nama_paket, pk.harga, ps.online AS pppoe_online, ps.last_seen
       FROM pelanggan p
       LEFT JOIN paket pk ON pk.id = p.id_paket
       LEFT JOIN pppoe_status ps ON ps.id_pelanggan = p.id
       WHERE p.id = ?`, [id]);
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

router.post('/pelanggan', requireRole('superadmin', 'teknisi'), async (req, res, next) => {
  try {
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

    if (tipe === 'pppoe' && username) {
      const dup = await db.one('SELECT id FROM pelanggan WHERE username_pppoe = ?', [username]);
      if (dup) return res.status(400).json({ error: 'Username PPPoE sudah terpakai' });
    }

    const kode = `IVV${Date.now().toString(36).toUpperCase()}`;
    const id = await db.insert(
      `INSERT INTO pelanggan (id_data_server, kode, nama, alamat, nomor_whatsapp, email, tipe,
        id_paket, id_agen, username_pppoe, password_pppoe, ip_address, mac_address,
        tanggal_masuk, hari_tagihan, status)
       VALUES (1,?,?,?,?,?,?,?,?,?,?,?,?,?,?, 'baru')`,
      [kode, nama, alamat, nowa, email, tipe, idPaket, idAgen, username, passPppoe, ip, mac, tglMasuk, hariTagihan]
    );
    await db.insert('INSERT INTO audit_log (user_id, aksi, detail, ip) VALUES (?,?,?,?)',
      [req.user.id, 'tambah_pelanggan', `${nama} (#${id})`, (req.ip || '').replace('::ffff:', '')]);

    if (nowa) {
      const tpl = await wa.ambilTemplate('registrasi', 1);
      const pesan = wa.render(tpl, { usr: nama, lyn: (idPaket ? (await db.one('SELECT nama_paket FROM paket WHERE id=?',[idPaket]))?.nama_paket : 'layanan') || 'layanan' });
      await wa.enqueue({ tujuan: nowa, jenis: 'registrasi', pesan, idRef: id });
    }
    res.json({ id, kode });
  } catch (e) { next(e); }
});

router.put('/pelanggan/:id', requireRole('superadmin', 'teknisi', 'agen'), async (req, res, next) => {
  try {
    const id = v.num(req.params.id, { int: true, min: 1 });
    const p = await db.one('SELECT * FROM pelanggan WHERE id = ?', [id]);
    if (!p) return res.status(404).json({ error: 'Pelanggan tidak ada' });
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

    // teknisi tidak boleh ubah status ke nonaktif/hapus kredensial sembarangan
    if (req.user.role === 'teknisi' && status === 'nonaktif') {
      return res.status(403).json({ error: 'Hanya superadmin yang dapat menonaktifkan' });
    }

    const statusBaru = status !== p.status;
    await db.run(
      `UPDATE pelanggan SET nama=?, alamat=?, nomor_whatsapp=?, id_paket=?, username_pppoe=?,
        password_pppoe=?, ip_address=?, status=?, catatan=? WHERE id=?`,
      [nama, alamat, nowa, idPaket, username, passPppoe, ip, status, catatan, id]
    );

    if (statusBaru && status === 'aktif' && p.status === 'baru' && nowa) {
      const tpl = await wa.ambilTemplate('aktivasi', 1);
      const pesan = wa.render(tpl, { usr: nama, ppp: username || '-', lyn: 'layanan' });
      await wa.enqueue({ tujuan: nowa, jenis: 'aktivasi', pesan, idRef: id });
    }
    await db.insert('INSERT INTO audit_log (user_id, aksi, detail, ip) VALUES (?,?,?,?)',
      [req.user.id, 'ubah_pelanggan', `#${id} ${nama}`, (req.ip || '').replace('::ffff:', '')]);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

router.delete('/pelanggan/:id', requireRole('superadmin'), async (req, res, next) => {
  try {
    const id = v.num(req.params.id, { int: true, min: 1 });
    const ada = await db.one('SELECT nomor_invoice FROM tagihan WHERE id_pelanggan = ? LIMIT 1', [id]);
    if (ada) return res.status(400).json({ error: 'Pelanggan memiliki riwayat tagihan — gunakan status nonaktif' });
    await db.run('DELETE FROM pelanggan WHERE id = ?', [id]);
    await db.insert('INSERT INTO audit_log (user_id, aksi, detail, ip) VALUES (?,?,?,?)',
      [req.user.id, 'hapus_pelanggan', `#${id}`, (req.ip || '').replace('::ffff:', '')]);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

module.exports = router;
