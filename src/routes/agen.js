'use strict';
// ============================================================
// Agen Hotspot + Voucher API — terisolasi per tenant.
// - superadmin: semua tenant (ikut picker tenant)
// - master: tenant miliknya
// - agen: saldo + voucher miliknya
// ============================================================
const express = require('express');
const db = require('../db');
const v = require('../util/validate');
const { requireAuth, requireRole, requirePJ } = require('../middleware/auth');
const { tenantSql, tenantAktif, requireMenu } = require('../util/scope');

const router = express.Router();
router.use(requireAuth);

function kodeVoucher(prefix = 'IVV') {
  const acak = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < 8; i++) s += acak[Math.floor(Math.random() * acak.length)];
  return String(prefix || 'IVV') + s;
}

// ----------------------------------------------------------- agen
router.get('/agen', requireRole('superadmin', 'master', 'agen'), async (req, res, next) => {
  try {
    const ts = tenantSql(req, 'id_data_server');
    if (req.user.role === 'agen') {
      const a = await db.one(`SELECT * FROM agen WHERE id = ?${ts.sql}`, [req.user.id_ref, ...ts.params]);
      return res.json({ data: a ? [a] : [] });
    }
    res.json({ data: await db.q(`SELECT * FROM agen WHERE 1=1${ts.sql} ORDER BY id DESC LIMIT 200`, ts.params) });
  } catch (e) { next(e); }
});

router.post('/agen', requirePJ(), requireMenu('agen', 'tambah'), async (req, res, next) => {
  try {
    const ds = tenantAktif(req);
    const nama = v.str(req.body.nama, { min: 2, max: 100 });
    const nohp = v.phone(req.body.no_hp);
    const alamat = v.str(req.body.alamat, { max: 255, def: null });
    const komisi = v.num(req.body.komisi_pct, { min: 0, max: 100, def: 0 });
    const id = await db.insert(
      'INSERT INTO agen (id_data_server, nama, no_hp, alamat, komisi_pct) VALUES (?,?,?,?,?)',
      [ds, nama, nohp, alamat, komisi]
    );
    await db.insert('INSERT INTO audit_log (user_id, id_data_server, aksi, detail, ip) VALUES (?,?,?,?,?)',
      [req.user.id, ds, 'tambah_agen', `${nama} (#${id})`, (req.ip || '').replace('::ffff:', '')]);
    res.json({ id });
  } catch (e) { next(e); }
});

router.put('/agen/:id', requirePJ(), requireMenu('agen', 'ubah'), async (req, res, next) => {
  try {
    const id = v.num(req.params.id, { int: true, min: 1 });
    const ts = tenantSql(req, 'id_data_server');
    const a = await db.one(`SELECT * FROM agen WHERE id = ?${ts.sql}`, [id, ...ts.params]);
    if (!a) return res.status(404).json({ error: 'Agen tidak ada' });
    const nama = v.str(req.body.nama, { min: 2, max: 100, def: a.nama });
    const nohp = Object.prototype.hasOwnProperty.call(req.body, 'no_hp') ? v.phone(req.body.no_hp) : a.no_hp;
    const alamat = v.str(req.body.alamat, { max: 255, def: a.alamat });
    const komisi = v.num(req.body.komisi_pct, { min: 0, max: 100, def: Number(a.komisi_pct) });
    const status = v.enumOf(req.body.status, ['aktif', 'nonaktif'], a.status);
    await db.run('UPDATE agen SET nama=?, no_hp=?, alamat=?, komisi_pct=?, status=? WHERE id=?',
      [nama, nohp, alamat, komisi, status, id]);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

/** Mutasi saldo agen (topup/penarikan) — penanggung jawab tenant. */
router.post('/agen/:id/saldo', requirePJ(), requireMenu('agen', 'saldo'), async (req, res, next) => {
  try {
    const id = v.num(req.params.id, { int: true, min: 1 });
    const tipe = v.enumOf(req.body.tipe, ['topup', 'penarikan', 'koreksi']);
    const jumlah = v.num(req.body.jumlah, { min: 1, max: 1e9 });
    const ket = v.str(req.body.keterangan, { max: 255, def: '' });
    const ts = tenantSql(req, 'id_data_server');

    const hasil = await db.tx(async (t) => {
      const a = await t.one(`SELECT * FROM agen WHERE id = ?${ts.sql} FOR UPDATE`, [id, ...ts.params]);
      if (!a) throw new Error('Agen tidak ada');
      let saldo = Number(a.saldo);
      if (tipe === 'topup' || tipe === 'koreksi') saldo += (tipe === 'koreksi' ? jumlah - saldo : jumlah);
      else saldo -= jumlah;
      if (saldo < 0) throw new Error('Saldo tidak cukup');
      await t.run('UPDATE agen SET saldo = ? WHERE id = ?', [saldo, id]);
      await t.insert(
        'INSERT INTO agen_mutasi (id_agen, tipe, jumlah, saldo_sisa, keterangan, created_by) VALUES (?,?,?,?,?,?)',
        [id, tipe, jumlah, saldo, ket, req.user.id]
      );
      return { saldo, ds: Number(a.id_data_server) };
    });
    await db.insert('INSERT INTO audit_log (user_id, id_data_server, aksi, detail, ip) VALUES (?,?,?,?,?)',
      [req.user.id, hasil.ds, `saldo_agen_${tipe}`, `agen #${id} ${jumlah}`, (req.ip || '').replace('::ffff:', '')]);
    res.json({ ok: true, saldo: hasil.saldo });
  } catch (e) { next(e); }
});

router.get('/agen/:id/mutasi', requireRole('superadmin', 'master', 'agen'), async (req, res, next) => {
  try {
    let id = v.num(req.params.id, { int: true, min: 1 });
    if (req.user.role === 'agen') id = Number(req.user.id_ref);
    const ts = tenantSql(req, 'a.id_data_server');
    const rows = await db.q(
      `SELECT m.* FROM agen_mutasi m JOIN agen a ON a.id = m.id_agen
       WHERE m.id_agen = ?${ts.sql} ORDER BY m.id DESC LIMIT 100`, [id, ...ts.params]);
    res.json({ data: rows });
  } catch (e) { next(e); }
});

// -------------------------------------------------------- voucher
router.get('/voucher', async (req, res, next) => {
  try {
    const ts = tenantSql(req, 'vc.id_data_server');
    const status = v.enumOf(req.query.status, ['stok', 'terjual', 'terpakai', 'kedaluwarsa', 'batal'], null);
    const cari = v.str(req.query.q, { max: 40, def: '' });
    const limit = v.num(req.query.limit, { min: 1, max: 200, def: 50, int: true });
    const where = ['1=1'];
    const params = [];
    if (req.user.role === 'agen') { where.push('vc.id_agen = ?'); params.push(req.user.id_ref); }
    where.push(`1=1${ts.sql}`);
    if (ts.params.length) params.push(...ts.params);
    if (status) { where.push('vc.status = ?'); params.push(status); }
    if (cari) { where.push('vc.kode LIKE ?'); params.push(`%${cari}%`); }
    const rows = await db.q(
      `SELECT vc.*, pk.nama_paket, pk.masa_aktif FROM voucher vc
       LEFT JOIN paket pk ON pk.id = vc.id_paket
       WHERE ${where.join(' AND ')} ORDER BY vc.id DESC LIMIT ?`,
      [...params, limit]
    );
    res.json({ data: rows });
  } catch (e) { next(e); }
});

/** Generate batch voucher (penanggung jawab tenant) — langsung ke stok pusat. */
router.post('/voucher/generate', requirePJ(), requireMenu('voucher', 'generate'), async (req, res, next) => {
  try {
    const ds = tenantAktif(req);
    const idPaket = v.num(req.body.id_paket, { int: true, min: 1 });
    const jumlah = v.num(req.body.jumlah, { min: 1, max: 500, int: true });
    const paket = await db.one(
      `SELECT * FROM paket WHERE id = ? AND jenis = 'hotspot' AND id_data_server = ?`, [idPaket, ds]);
    if (!paket) return res.status(400).json({ error: 'Paket hotspot tidak ada' });
    const [{ prefix_invoice }] = await db.q('SELECT prefix_invoice FROM data_server WHERE id = ?', [ds]);

    const dibuat = await db.tx(async (t) => {
      let n = 0;
      for (let i = 0; i < jumlah; i++) {
        const kode = kodeVoucher(prefix_invoice);
        const exp = new Date(Date.now() + Number(paket.masa_aktif || 30) * 86400000);
        await t.insert(
          `INSERT INTO voucher (id_data_server, kode, id_paket, harga_beli, harga_jual, expired_at)
           VALUES (?,?,?,?,?,?)`,
          [ds, kode, idPaket, Number(paket.harga), Number(paket.harga_agen || paket.harga), exp.toISOString().slice(0, 19).replace('T', ' ')]
        );
        n++;
      }
      return n;
    });
    await db.insert('INSERT INTO audit_log (user_id, id_data_server, aksi, detail, ip) VALUES (?,?,?,?,?)',
      [req.user.id, ds, 'generate_voucher', `paket#${idPaket} x${dibuat}`, (req.ip || '').replace('::ffff:', '')]);
    res.json({ dibuat });
  } catch (e) { next(e); }
});

/** Agen beli voucher dari stok pusat (potong saldo). */
router.post('/voucher/beli', requireRole('agen'), async (req, res, next) => {
  try {
    const idPaket = v.num(req.body.id_paket, { int: true, min: 1 });
    const jumlah = v.num(req.body.jumlah, { min: 1, max: 100, int: true });
    const hasil = await db.tx(async (t) => {
      const a = await t.one('SELECT * FROM agen WHERE id = ? FOR UPDATE', [req.user.id_ref]);
      if (!a || a.status !== 'aktif') throw new Error('Agen tidak aktif');
      const ds = Number(a.id_data_server);
      const stok = await t.q(
        `SELECT * FROM voucher WHERE id_paket = ? AND status = 'stok' AND id_agen IS NULL
           AND id_data_server = ? ORDER BY id LIMIT ? FOR UPDATE`,
        [idPaket, ds, jumlah]);
      if (stok.length < jumlah) throw new Error('Stok voucher tidak cukup');
      const total = stok.reduce((s, x) => s + Number(x.harga_beli), 0);
      if (Number(a.saldo) < total) throw new Error(`Saldo tidak cukup (butuh Rp ${total.toLocaleString('id-ID')})`);
      const ids = stok.map(x => x.id);
      await t.run(
        `UPDATE voucher SET id_agen = ?, status = 'stok' WHERE id IN (${ids.map(() => '?').join(',')})`,
        [req.user.id_ref, ...ids]
      );
      const sisa = Number(a.saldo) - total;
      await t.run('UPDATE agen SET saldo = ? WHERE id = ?', [sisa, req.user.id_ref]);
      await t.insert(
        'INSERT INTO agen_mutasi (id_agen, tipe, jumlah, saldo_sisa, keterangan) VALUES (?,?,?,?,?)',
        [req.user.id_ref, 'penjualan', total, sisa, `Beli ${jumlah} voucher`]
      );
      return { jumlah: stok.length, total, saldo: sisa };
    });
    res.json({ ok: true, ...hasil });
  } catch (e) { next(e); }
});

/** Agen menjual voucher ke pelanggan → status terjual. */
router.post('/voucher/:id/jual', requireRole('agen'), async (req, res, next) => {
  try {
    const id = v.num(req.params.id, { int: true, min: 1 });
    const ts = tenantSql(req, 'id_data_server');
    const vcr = await db.one(`SELECT * FROM voucher WHERE id = ?${ts.sql}`, [id, ...ts.params]);
    if (!vcr || Number(vcr.id_agen) !== Number(req.user.id_ref)) {
      return res.status(404).json({ error: 'Voucher tidak ada di milik Anda' });
    }
    if (vcr.status !== 'stok') return res.status(400).json({ error: `Status voucher: ${vcr.status}` });
    await db.run(`UPDATE voucher SET status='terjual', sold_at=NOW() WHERE id=?`, [id]);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

/** Voucher dipakai (dipanggil hotspot login script / teknisi). */
router.post('/voucher/:id/pakai', requireRole('superadmin', 'master', 'teknisi'), async (req, res, next) => {
  try {
    const id = v.num(req.params.id, { int: true, min: 1 });
    const ts = tenantSql(req, 'id_data_server');
    const vcr = await db.one(`SELECT id FROM voucher WHERE id = ?${ts.sql}`, [id, ...ts.params]);
    if (!vcr) return res.status(404).json({ error: 'Voucher tidak ada' });
    await db.run(
      `UPDATE voucher SET status='terpakai', used_at=NOW() WHERE id=? AND status IN ('stok','terjual')`, [id]);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

router.get('/voucher/stok-ringkas', requireRole('superadmin', 'master', 'agen'), async (req, res, next) => {
  try {
    const ts = tenantSql(req, 'id_data_server');
    const where = ['1=1'];
    const params = [];
    if (req.user.role === 'agen') { where.push('id_agen = ?'); params.push(req.user.id_ref); }
    where.push(`1=1${ts.sql}`);
    params.push(...ts.params);
    const rows = await db.q(
      `SELECT id_paket, status, COUNT(*) AS jml FROM voucher WHERE ${where.join(' AND ')} GROUP BY id_paket, status`,
      params);
    res.json({ data: rows });
  } catch (e) { next(e); }
});

module.exports = router;
