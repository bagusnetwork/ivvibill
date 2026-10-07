'use strict';
// ============================================================
// Keuangan — kas masuk/keluar & laporan (meniru gratisinaja:
// kas.php, pemasukan.php, pengeluaran.php). Pemasukan tagihan
// lunas tercatat otomatis oleh billing.lunaskanTagihan().
// ============================================================
const express = require('express');
const db = require('../db');
const v = require('../util/validate');
const { requireAuth, requireRole, requirePJ } = require('../middleware/auth');
const { tenantSql, tenantAktif, requireMenu } = require('../util/scope');

const router = express.Router();
router.use(requireAuth);

const KATEGORI = ['pembayaran', 'topup', 'gaji', 'perbaikan', 'listrik', 'internet', 'sewa', 'lainnya'];

function filterRange(req, alias = 'k') {
  const dari = v.tgl(req.query.dari, null);
  const sampai = v.tgl(req.query.sampai, null);
  const where = [], params = [];
  if (dari) { where.push(`${alias}.created_at >= ?`); params.push(`${dari} 00:00:00`); }
  if (sampai) { where.push(`${alias}.created_at <= ?`); params.push(`${sampai} 23:59:59`); }
  return { where, params, dari, sampai };
}

// ------------------------------------------------------ daftar kas
router.get('/keuangan/kas', requireRole('superadmin', 'master', 'teknisi'), async (req, res, next) => {
  try {
    const ts = tenantSql(req, 'k.id_data_server');
    const tipe = v.enumOf(req.query.tipe, ['masuk', 'keluar'], null);
    const cari = v.str(req.query.q, { max: 100, def: '' });
    const r = filterRange(req);
    const where = [`1=1${ts.sql}`, ...r.where];
    const params = [...ts.params, ...r.params];
    if (tipe) { where.push('k.tipe = ?'); params.push(tipe); }
    if (cari) { where.push('(k.keterangan LIKE ? OR k.kategori LIKE ?)'); params.push(`%${cari}%`, `%${cari}%`); }

    const rows = await db.q(
      `SELECT k.*, u.nama AS nama_user
       FROM kas k
       LEFT JOIN app_user u ON u.id = k.dibuat_oleh
       WHERE ${where.join(' AND ')}
       ORDER BY k.id DESC LIMIT 200`, params);
    const [ringkas] = await db.q(
      `SELECT
         COALESCE(SUM(CASE WHEN k.tipe='masuk'  THEN k.jumlah END),0) AS total_masuk,
         COALESCE(SUM(CASE WHEN k.tipe='keluar' THEN k.jumlah END),0) AS total_keluar,
         COUNT(*) AS n
       FROM kas k WHERE ${where.join(' AND ')}`, params);
    res.json({ data: rows, ringkas });
  } catch (e) { next(e); }
});

// ------------------------------------------------------ laporan
router.get('/keuangan/laporan', requirePJ(), async (req, res, next) => {
  try {
    const ts = tenantSql(req, 'k.id_data_server');
    const r = filterRange(req);
    const where = [`1=1${ts.sql}`, ...r.where];
    const params = [...ts.params, ...r.params];
    const [tot] = await db.q(
      `SELECT
         COALESCE(SUM(CASE WHEN k.tipe='masuk'  THEN k.jumlah END),0) AS total_masuk,
         COALESCE(SUM(CASE WHEN k.tipe='keluar' THEN k.jumlah END),0) AS total_keluar,
         COUNT(CASE WHEN k.tipe='masuk'  THEN 1 END) AS n_masuk,
         COUNT(CASE WHEN k.tipe='keluar' THEN 1 END) AS n_keluar
       FROM kas k WHERE ${where.join(' AND ')}`, params);
    const perKategori = await db.q(
      `SELECT k.tipe, k.kategori, COUNT(*) AS n, SUM(k.jumlah) AS total
       FROM kas k WHERE ${where.join(' AND ')}
       GROUP BY k.tipe, k.kategori ORDER BY k.tipe, total DESC`, params);
    res.json({
      dari: r.dari, sampai: r.sampai,
      total_masuk: Number(tot.total_masuk), total_keluar: Number(tot.total_keluar),
      saldo: Number(tot.total_masuk) - Number(tot.total_keluar),
      n_masuk: Number(tot.n_masuk), n_keluar: Number(tot.n_keluar),
      per_kategori: perKategori
    });
  } catch (e) { next(e); }
});

router.get('/keuangan/kategori', (req, res) => res.json({ data: KATEGORI }));

// ------------------------------------------------------ tulis kas
router.post('/keuangan/kas', requirePJ(), requireMenu('keuangan', 'tambah'), async (req, res, next) => {
  try {
    const ds = tenantAktif(req);
    const tipe = v.enumOf(req.body.tipe, ['masuk', 'keluar']);
    const kategori = v.str(req.body.kategori, { min: 2, max: 40, def: 'umum' });
    const jumlah = v.num(req.body.jumlah, { min: 0.01, max: 1e12 });
    const keterangan = v.str(req.body.keterangan, { max: 255, def: null });
    const id = await db.insert(
      `INSERT INTO kas (id_data_server, tipe, kategori, jumlah, keterangan, dibuat_oleh)
       VALUES (?,?,?,?,?,?)`, [ds, tipe, kategori, jumlah, keterangan, req.user.id]);
    await db.insert('INSERT INTO audit_log (user_id, id_data_server, aksi, detail, ip) VALUES (?,?,?,?,?)',
      [req.user.id, ds, `kas_${tipe}`, `${kategori} Rp ${jumlah}`, (req.ip || '').replace('::ffff:', '')]);
    res.json({ id });
  } catch (e) { next(e); }
});

router.delete('/keuangan/kas/:id', requirePJ(), requireMenu('keuangan', 'hapus'), async (req, res, next) => {
  try {
    const id = v.num(req.params.id, { int: true, min: 1 });
    const ts = tenantSql(req, 'id_data_server');
    const k = await db.one(`SELECT * FROM kas WHERE id = ?${ts.sql}`, [id, ...ts.params]);
    if (!k) return res.status(404).json({ error: 'Entri kas tidak ada' });
    if (k.kategori === 'pembayaran' && k.id_ref) {
      return res.status(400).json({ error: 'Entri dari pembayaran tagihan tidak bisa dihapus manual' });
    }
    await db.run('DELETE FROM kas WHERE id = ?', [id]);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

module.exports = router;
