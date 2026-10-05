'use strict';
// ============================================================
// Tagihan + Pembayaran (manual pay & payment gateway)
// ============================================================
const express = require('express');
const db = require('../db');
const v = require('../util/validate');
const { requireAuth, requireRole } = require('../middleware/auth');
const billing = require('../services/billing');
const cfgData = require('../services/configData');
const crypto = require('../util/crypto');
const http = require('../util/http');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const config = require('../config');

const router = express.Router();
router.use(requireAuth);

fs.mkdirSync(config.security.uploadDir, { recursive: true });
const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, config.security.uploadDir),
    filename: (req, file, cb) => {
      const safe = file.originalname.replace(/[^A-Za-z0-9._-]/g, '_').slice(-60);
      cb(null, `${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${safe}`);
    }
  }),
  limits: { fileSize: 3 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ok = /image\/(png|jpe?g|webp)/.test(file.mimetype);
    cb(ok ? null : new Error('File harus gambar (png/jpg/webp)'), ok);
  }
});

function scopeTagihan(user) {
  if (user.role === 'pelanggan') return { where: 't.id_pelanggan = ?', params: [user.id_ref] };
  if (user.role === 'teknisi') return { where: '1=1', params: [] }; // teknisi boleh lihat untuk bantu bayar
  if (user.role === 'agen') return { where: 'p.id_agen = ?', params: [user.id_ref] };
  return { where: '1=1', params: [] };
}

// ------------------------------------------------------- tagihan
router.get('/tagihan', async (req, res, next) => {
  try {
    const s = scopeTagihan(req.user);
    const status = v.enumOf(req.query.status, ['buat', 'terkirim', 'menunggu', 'lunas', 'jatuh_tempo', 'batal'], null);
    const cari = v.str(req.query.q, { max: 100, def: '' });
    const limit = v.num(req.query.limit, { min: 1, max: 200, def: 50, int: true });
    const offset = v.num(req.query.offset, { min: 0, max: 1e6, def: 0, int: true });

    const where = [s.where];
    const params = [...s.params];
    if (status) { where.push('t.status = ?'); params.push(status); }
    if (cari) { where.push('(t.nomor_invoice LIKE ? OR p.nama LIKE ?)'); params.push(`%${cari}%`, `%${cari}%`); }

    const rows = await db.q(
      `SELECT t.*, p.nama AS nama_pelanggan, p.nomor_whatsapp
       FROM tagihan t JOIN pelanggan p ON p.id = t.id_pelanggan
       WHERE ${where.join(' AND ')}
       ORDER BY t.id DESC LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );
    const [cntRows, belumLunas] = await Promise.all([
      db.q(`SELECT COUNT(*) AS total FROM tagihan t JOIN pelanggan p ON p.id=t.id_pelanggan WHERE ${where.join(' AND ')}`, params),
      db.q(
        `SELECT IFNULL(SUM(t.total),0) AS nominal FROM tagihan t JOIN pelanggan p ON p.id=t.id_pelanggan
         WHERE ${where.join(' AND ')} AND t.status != 'lunas'`,
        params
      )
    ]);
    const total = cntRows[0] ? Number(cntRows[0].total) : 0;
    res.json({ data: rows, total, nominal_belum_lunas: Number(belumLunas[0].nominal) });
  } catch (e) { next(e); }
});

router.get('/tagihan/:id', async (req, res, next) => {
  try {
    const id = v.num(req.params.id, { int: true, min: 1 });
    const t = await db.one(
      `SELECT t.*, p.nama AS nama_pelanggan, p.nomor_whatsapp, p.alamat
       FROM tagihan t JOIN pelanggan p ON p.id = t.id_pelanggan WHERE t.id = ?`, [id]);
    if (!t) return res.status(404).json({ error: 'Tagihan tidak ada' });
    if (req.user.role === 'pelanggan' && Number(t.id_pelanggan) !== Number(req.user.id_ref)) {
      return res.status(403).json({ error: 'Akses ditolak' });
    }
    const bayar = await db.q('SELECT * FROM pembayaran WHERE id_tagihan = ? ORDER BY id DESC', [id]);
    res.json({ data: t, pembayaran: bayar });
  } catch (e) { next(e); }
});

router.post('/tagihan/buat', requireRole('superadmin'), async (req, res, next) => {
  try {
    const force = req.body.force === true || req.body.force === '1';
    const r = await billing.buatTagihanBulanan(1, force);
    res.json(r);
  } catch (e) { next(e); }
});

router.post('/tagihan/kirim-wa', requireRole('superadmin'), async (req, res, next) => {
  try { res.json(await billing.kirimTagihanWajib(1, 100)); }
  catch (e) { next(e); }
});

router.post('/tagihan/:id/batal', requireRole('superadmin'), async (req, res, next) => {
  try {
    const id = v.num(req.params.id, { int: true, min: 1 });
    await db.run(`UPDATE tagihan SET status='batal' WHERE id=? AND status!='lunas'`, [id]);
    await db.insert('INSERT INTO audit_log (user_id, aksi, detail, ip) VALUES (?,?,?,?)',
      [req.user.id, 'batal_tagihan', `#${id}`, (req.ip || '').replace('::ffff:', '')]);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// ----------------------------------------------- pembayaran manual
router.post('/tagihan/:id/bayar', upload.single('bukti'), async (req, res, next) => {
  try {
    const id = v.num(req.params.id, { int: true, min: 1 });
    const t = await db.one('SELECT * FROM tagihan WHERE id = ?', [id]);
    if (!t) return res.status(404).json({ error: 'Tagihan tidak ada' });
    if (t.status === 'lunas') return res.status(400).json({ error: 'Tagihan sudah lunas' });
    if (req.user.role === 'pelanggan' && Number(t.id_pelanggan) !== Number(req.user.id_ref)) {
      return res.status(403).json({ error: 'Akses ditolak' });
    }
    const keterangan = v.str(req.body.keterangan, { max: 255, def: null });
    const bukti = req.file ? `/uploads/${req.file.filename}` : null;
    // Pelanggan mengunggah bukti → status menunggu verifikasi admin.
    // Superadmin boleh langsung tandai lunas.
    const langsungLunas = req.user.role === 'superadmin';

    await db.insert(
      `INSERT INTO pembayaran (id_tagihan, jumlah, metode, status, bukti, keterangan, verified_by)
       VALUES (?,?, 'manual', ?, ?, ?, ?)`,
      [id, t.total, langsungLunas ? 'diterima' : 'menunggu', bukti, keterangan, langsungLunas ? req.user.id : null]
    );
    if (langsungLunas) {
      await billing.lunaskanTagihan(id, 'manual', { verifiedBy: req.user.id, jumlah: Number(t.total) });
    } else {
      await db.run(`UPDATE tagihan SET status='menunggu' WHERE id=?`, [id]);
    }
    await db.insert('INSERT INTO audit_log (user_id, aksi, detail, ip) VALUES (?,?,?,?)',
      [req.user.id, 'bayar_manual', `tagihan #${id}`, (req.ip || '').replace('::ffff:', '')]);
    res.json({ ok: true, status: langsungLunas ? 'lunas' : 'menunggu' });
  } catch (e) { next(e); }
});

router.get('/pembayaran/menunggu', requireRole('superadmin'), async (req, res, next) => {
  try {
    const rows = await db.q(
      `SELECT b.*, t.nomor_invoice, t.total, p.nama AS nama_pelanggan
       FROM pembayaran b
       JOIN tagihan t ON t.id = b.id_tagihan
       JOIN pelanggan p ON p.id = t.id_pelanggan
       WHERE b.status = 'menunggu' ORDER BY b.id DESC LIMIT 100`
    );
    res.json({ data: rows });
  } catch (e) { next(e); }
});

router.post('/pembayaran/:id/verifikasi', requireRole('superadmin'), async (req, res, next) => {
  try {
    const id = v.num(req.params.id, { int: true, min: 1 });
    const aksi = v.enumOf(req.body.aksi, ['terima', 'tolak']);
    const b = await db.one('SELECT * FROM pembayaran WHERE id = ?', [id]);
    if (!b) return res.status(404).json({ error: 'Pembayaran tidak ada' });
    if (b.status !== 'menunggu') return res.status(400).json({ error: 'Sudah diproses' });
    if (aksi === 'terima') {
      await db.run(`UPDATE pembayaran SET status='diterima', verified_by=? WHERE id=?`, [req.user.id, id]);
      await billing.lunaskanTagihan(b.id_tagihan, b.metode, { verifiedBy: req.user.id, jumlah: Number(b.jumlah) });
    } else {
      await db.run(`UPDATE pembayaran SET status='ditolak', verified_by=? WHERE id=?`, [req.user.id, id]);
      await db.run(`UPDATE tagihan SET status='terkirim' WHERE id=? AND status='menunggu'`, [b.id_tagihan]);
    }
    await db.insert('INSERT INTO audit_log (user_id, aksi, detail, ip) VALUES (?,?,?,?)',
      [req.user.id, `verifikasi_${aksi}`, `pembayaran #${id}`, (req.ip || '').replace('::ffff:', '')]);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// --------------------------------------------- payment gateway
router.get('/gateway', requireRole('superadmin'), async (req, res, next) => {
  try {
    const s = await cfgData.getServer(1, true);
    res.json({
      data: {
        pg_active: s.pg_active,
        midtrans_server_key: s.pg_midtrans_server_key ? '****' : '',
        midtrans_client_key: s.pg_midtrans_client_key || '',
        flip_secret: s.pg_flip_secret_key ? '****' : '',
        flip_public: s.pg_flip_public_key || '',
        wa_gateway_url: s.wa_gateway_url || '',
        wa_gateway_key: s.wa_gateway_key ? '****' : '',
        wa_status: s.wa_status
      }
    });
  } catch (e) { next(e); }
});

router.put('/gateway', requireRole('superadmin'), async (req, res, next) => {
  try {
    const aktif = v.enumOf(req.body.pg_active, ['manual', 'midtrans', 'flip'], 'manual');
    const msKey = v.str(req.body.midtrans_server_key, { max: 400, def: null });
    const mcKey = v.str(req.body.midtrans_client_key, { max: 200, def: null });
    const fSec = v.str(req.body.flip_secret, { max: 400, def: null });
    const fPub = v.str(req.body.flip_public, { max: 200, def: null });
    const waUrl = v.str(req.body.wa_gateway_url, { max: 255, def: null });
    const waKey = v.str(req.body.wa_gateway_key, { max: 400, def: null });

    const patch = ['pg_active = ?'];
    const vals = [aktif];
    if (msKey && msKey !== '****') { patch.push('pg_midtrans_server_key = ?'); vals.push(crypto.encrypt(msKey)); }
    if (mcKey) { patch.push('pg_midtrans_client_key = ?'); vals.push(mcKey); }
    if (fSec && fSec !== '****') { patch.push('pg_flip_secret_key = ?'); vals.push(crypto.encrypt(fSec)); }
    if (fPub) { patch.push('pg_flip_public_key = ?'); vals.push(fPub); }
    if (waUrl !== null) { patch.push('wa_gateway_url = ?'); vals.push(waUrl); }
    if (waKey && waKey !== '****') { patch.push('wa_gateway_key = ?', 'wa_status = ?'); vals.push(crypto.encrypt(waKey), 'Aktif'); }
    vals.push(1);
    await db.run(`UPDATE data_server SET ${patch.join(', ')} WHERE id = ?`, vals);
    cfgData.invalidate();
    await db.insert('INSERT INTO audit_log (user_id, aksi, detail, ip) VALUES (?,?,?,?)',
      [req.user.id, 'ubah_gateway', aktif, (req.ip || '').replace('::ffff:', '')]);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

/** Checkout Midtrans Snap — membuat transaksi, mengembalikan snap URL. */
router.post('/gateway/midtrans/snap', requireRole('superadmin', 'pelanggan'), async (req, res, next) => {
  try {
    const tagihanId = v.num(req.body.tagihan_id, { int: true, min: 1 });
    const t = await db.one('SELECT * FROM tagihan WHERE id = ?', [tagihanId]);
    if (!t || t.status === 'lunas') return res.status(400).json({ error: 'Tagihan tidak valid' });
    const s = await cfgData.getServer(1, true);
    if (s.pg_active !== 'midtrans' || !s.pg_midtrans_server_key) {
      return res.status(400).json({ error: 'Midtrans belum diaktifkan' });
    }
    const serverKey = crypto.decrypt(s.pg_midtrans_server_key);
    const snapBase = serverKey.startsWith('SB-')
      ? 'https://app.sandbox.midtrans.com/snap/v1'
      : 'https://app.midtrans.com/snap/v1';
    const payload = {
      transaction_details: { order_id: `IVV-${t.id}-${Date.now()}`, gross_amount: Number(t.total) },
      customer_details: { first_name: String(t.id_pelanggan), email: null }
    };
    const r = await http.post(`${snapBase}/transactions`, JSON.stringify(payload), {
      timeout: 20000,
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        Authorization: 'Basic ' + Buffer.from(serverKey + ':').toString('base64')
      }
    });
    if (r.status >= 400) return res.status(502).json({ error: `Midtrans: ${r.text.slice(0, 200)}` });
    const token = r.body?.token;
    await db.run(`UPDATE tagihan SET status='menunggu' WHERE id=? AND status IN ('buat','terkirim','jatuh_tempo')`, [tagihanId]);
    res.json({ token, redirect_url: r.body?.redirect_url || null });
  } catch (e) { next(e); }
});

router.get('/rekening', async (req, res, next) => {
  try {
    res.json({ data: await db.q(`SELECT * FROM rekening WHERE status='aktif'`) });
  } catch (e) { next(e); }
});

module.exports = router;
