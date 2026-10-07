'use strict';
// ============================================================
// Master data: Topologi ODP & Desa (meniru gratisinaja).
// Semua query terisolasi per tenant (data_server).
// ============================================================
const express = require('express');
const db = require('../db');
const v = require('../util/validate');
const { requireAuth, requireRole, requirePJ } = require('../middleware/auth');
const { tenantSql, tenantAktif, requireMenu } = require('../util/scope');

const router = express.Router();
router.use(requireAuth);

// ------------------------------------------------- topologi ODP
router.get('/master/topologi', requireRole('superadmin', 'master', 'teknisi', 'agen'),
  async (req, res, next) => {
  try {
    const ts = tenantSql(req, 'mt.id_data_server');
    const rows = await db.q(
      `SELECT mt.*,
         (SELECT COUNT(*) FROM pelanggan p WHERE p.id_master_topologi = mt.id) AS jumlah_terpakai
       FROM master_topologi mt
       WHERE 1=1${ts.sql}
       ORDER BY mt.nama`, ts.params);
    res.json({ data: rows.map(r => ({
      ...r,
      jumlah_port: Number(r.jumlah_port || 0),
      jumlah_terpakai: Number(r.jumlah_terpakai || 0),
      sisa_port: Math.max(0, Number(r.jumlah_port || 0) - Number(r.jumlah_terpakai || 0))
    })) });
  } catch (e) { next(e); }
});

router.post('/master/topologi', requirePJ(), requireMenu('topologi', 'tambah'),
  async (req, res, next) => {
  try {
    const ds = tenantAktif(req);
    const nama = v.str(req.body.nama, { min: 2, max: 100 });
    const titik = v.str(req.body.titik_koordinat, { max: 100, def: null });
    const port = v.num(req.body.jumlah_port, { min: 1, max: 1024, def: 16, int: true });
    const dup = await db.one('SELECT id FROM master_topologi WHERE id_data_server = ? AND nama = ?', [ds, nama]);
    if (dup) return res.status(400).json({ error: 'Nama topologi sudah ada' });
    const id = await db.insert(
      'INSERT INTO master_topologi (id_data_server, nama, titik_koordinat, jumlah_port) VALUES (?,?,?,?)',
      [ds, nama, titik, port]);
    res.json({ id });
  } catch (e) { next(e); }
});

router.put('/master/topologi/:id', requirePJ(), requireMenu('topologi', 'ubah'),
  async (req, res, next) => {
  try {
    const id = v.num(req.params.id, { int: true, min: 1 });
    const ts = tenantSql(req, 'id_data_server');
    const t = await db.one(`SELECT * FROM master_topologi WHERE id = ?${ts.sql}`, [id, ...ts.params]);
    if (!t) return res.status(404).json({ error: 'Topologi tidak ada' });
    const nama = v.str(req.body.nama, { min: 2, max: 100, def: t.nama });
    const titik = v.str(req.body.titik_koordinat, { max: 100, def: t.titik_koordinat });
    const port = v.num(req.body.jumlah_port, { min: 1, max: 1024, def: Number(t.jumlah_port), int: true });
    await db.run('UPDATE master_topologi SET nama=?, titik_koordinat=?, jumlah_port=? WHERE id=?',
      [nama, titik, port, id]);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

router.delete('/master/topologi/:id', requirePJ(), requireMenu('topologi', 'hapus'),
  async (req, res, next) => {
  try {
    const id = v.num(req.params.id, { int: true, min: 1 });
    const ts = tenantSql(req, 'id_data_server');
    const t = await db.one(`SELECT id FROM master_topologi WHERE id = ?${ts.sql}`, [id, ...ts.params]);
    if (!t) return res.status(404).json({ error: 'Topologi tidak ada' });
    const dipakai = await db.one('SELECT id FROM pelanggan WHERE id_master_topologi = ? LIMIT 1', [id]);
    if (dipakai) return res.status(400).json({ error: 'Topologi masih dipakai pelanggan' });
    await db.run('DELETE FROM master_topologi WHERE id = ?', [id]);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// ------------------------------------------------------- desa
router.get('/master/desa', requireRole('superadmin', 'master', 'teknisi', 'agen'),
  async (req, res, next) => {
  try {
    const ts = tenantSql(req, 'd.id_data_server');
    const rows = await db.q(
      `SELECT d.*,
         (SELECT COUNT(*) FROM pelanggan p WHERE p.id_master_desa = d.id) AS jumlah_pelanggan
       FROM master_desa d
       WHERE 1=1${ts.sql}
       ORDER BY d.nama`, ts.params);
    res.json({ data: rows });
  } catch (e) { next(e); }
});

router.post('/master/desa', requirePJ(), requireMenu('desa', 'tambah'), async (req, res, next) => {
  try {
    const ds = tenantAktif(req);
    const nama = v.str(req.body.nama, { min: 2, max: 100 });
    const dup = await db.one('SELECT id FROM master_desa WHERE id_data_server = ? AND nama = ?', [ds, nama]);
    if (dup) return res.status(400).json({ error: 'Nama desa sudah ada' });
    const id = await db.insert('INSERT INTO master_desa (id_data_server, nama) VALUES (?,?)', [ds, nama]);
    res.json({ id });
  } catch (e) { next(e); }
});

router.put('/master/desa/:id', requirePJ(), requireMenu('desa', 'ubah'), async (req, res, next) => {
  try {
    const id = v.num(req.params.id, { int: true, min: 1 });
    const ts = tenantSql(req, 'id_data_server');
    const d = await db.one(`SELECT * FROM master_desa WHERE id = ?${ts.sql}`, [id, ...ts.params]);
    if (!d) return res.status(404).json({ error: 'Desa tidak ada' });
    const nama = v.str(req.body.nama, { min: 2, max: 100, def: d.nama });
    await db.run('UPDATE master_desa SET nama=? WHERE id=?', [nama, id]);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

router.delete('/master/desa/:id', requirePJ(), requireMenu('desa', 'hapus'), async (req, res, next) => {
  try {
    const id = v.num(req.params.id, { int: true, min: 1 });
    const ts = tenantSql(req, 'id_data_server');
    const d = await db.one(`SELECT id FROM master_desa WHERE id = ?${ts.sql}`, [id, ...ts.params]);
    if (!d) return res.status(404).json({ error: 'Desa tidak ada' });
    const dipakai = await db.one('SELECT id FROM pelanggan WHERE id_master_desa = ? LIMIT 1', [id]);
    if (dipakai) return res.status(400).json({ error: 'Desa masih dipakai pelanggan' });
    await db.run('DELETE FROM master_desa WHERE id = ?', [id]);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

module.exports = router;
