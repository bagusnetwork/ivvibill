'use strict';
// ============================================================
// Tagihan + Pembayaran (manual pay & payment gateway)
// Semua akses terisolasi per tenant (data_server); tabel anak
// (pembayaran, rekening) discope lewat JOIN ke induknya.
// ============================================================
const express = require('express');
const db = require('../db');
const v = require('../util/validate');
const { requireAuth, requireRole, requirePJ } = require('../middleware/auth');
const { tenantSql, tenantAktif, requireMenu } = require('../util/scope');
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

function scopeTagihan(req) {
  const ts = tenantSql(req, 't.id_data_server');
  const u = req.user;
  if (u.role === 'pelanggan') return { where: `t.id_pelanggan = ?${ts.sql}`, params: [u.id_ref, ...ts.params] };
  if (u.role === 'agen') return { where: `p.id_agen = ?${ts.sql}`, params: [u.id_ref, ...ts.params] };
  return { where: `1=1${ts.sql}`, params: [...ts.params] };
}

/** Tagihan satu baris dalam scope tenant pemohon (null bila lintas tenant). */
async function cariTagihan(req, id) {
  const ts = tenantSql(req, 't.id_data_server');
  return db.one(
    `SELECT t.* FROM tagihan t JOIN pelanggan p ON p.id = t.id_pelanggan WHERE t.id = ?${ts.sql}`,
    [id, ...ts.params]
  );
}

// ------------------------------------------------------- tagihan
router.get('/tagihan', async (req, res, next) => {
  try {
    const s = scopeTagihan(req);
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
    const ts = tenantSql(req, 't.id_data_server');
    const t = await db.one(
      `SELECT t.*, p.nama AS nama_pelanggan, p.nomor_whatsapp, p.alamat
       FROM tagihan t JOIN pelanggan p ON p.id = t.id_pelanggan WHERE t.id = ?${ts.sql}`,
      [id, ...ts.params]);
    if (!t) return res.status(404).json({ error: 'Tagihan tidak ada' });
    if (req.user.role === 'pelanggan' && Number(t.id_pelanggan) !== Number(req.user.id_ref)) {
      return res.status(403).json({ error: 'Akses ditolak' });
    }
    const bayar = await db.q('SELECT * FROM pembayaran WHERE id_tagihan = ? ORDER BY id DESC', [id]);
    res.json({ data: t, pembayaran: bayar });
  } catch (e) { next(e); }
});

router.post('/tagihan/buat', requirePJ(), requireMenu('tagihan', 'tambah'), async (req, res, next) => {
  try {
    const force = req.body.force === true || req.body.force === '1';
    const r = await billing.buatTagihanBulanan(tenantAktif(req), force);
    res.json(r);
  } catch (e) { next(e); }
});

router.post('/tagihan/kirim-wa', requirePJ(), requireMenu('tagihan', 'kirim'), async (req, res, next) => {
  try { res.json(await billing.kirimTagihanWajib(tenantAktif(req), 100)); }
  catch (e) { next(e); }
});

router.post('/tagihan/:id/batal', requirePJ(), requireMenu('tagihan', 'batal'), async (req, res, next) => {
  try {
    const id = v.num(req.params.id, { int: true, min: 1 });
    const t = await cariTagihan(req, id);
    if (!t) return res.status(404).json({ error: 'Tagihan tidak ada' });
    await db.run(`UPDATE tagihan SET status='batal' WHERE id=? AND status!='lunas'`, [id]);
    await db.insert('INSERT INTO audit_log (user_id, id_data_server, aksi, detail, ip) VALUES (?,?,?,?,?)',
      [req.user.id, t.id_data_server, 'batal_tagihan', `#${id}`, (req.ip || '').replace('::ffff:', '')]);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// ----------------------------------------------- pembayaran manual
router.post('/tagihan/:id/bayar', upload.single('bukti'), async (req, res, next) => {
  try {
    const id = v.num(req.params.id, { int: true, min: 1 });
    const t = await cariTagihan(req, id);
    if (!t) return res.status(404).json({ error: 'Tagihan tidak ada' });
    if (t.status === 'lunas') return res.status(400).json({ error: 'Tagihan sudah lunas' });
    if (req.user.role === 'pelanggan' && Number(t.id_pelanggan) !== Number(req.user.id_ref)) {
      return res.status(403).json({ error: 'Akses ditolak' });
    }
    const keterangan = v.str(req.body.keterangan, { max: 255, def: null });
    const bukti = req.file ? `/uploads/${req.file.filename}` : null;
    // Pelanggan mengunggah bukti → status menunggu verifikasi penanggung jawab.
    // Pemilik ISP / superadmin boleh langsung tandai lunas.
    const langsungLunas = req.user.role === 'superadmin' || req.user.role === 'master';

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
    await db.insert('INSERT INTO audit_log (user_id, id_data_server, aksi, detail, ip) VALUES (?,?,?,?,?)',
      [req.user.id, t.id_data_server, 'bayar_manual', `tagihan #${id}`, (req.ip || '').replace('::ffff:', '')]);
    res.json({ ok: true, status: langsungLunas ? 'lunas' : 'menunggu' });
  } catch (e) { next(e); }
});

router.get('/pembayaran/menunggu', requirePJ(), async (req, res, next) => {
  try {
    const ts = tenantSql(req, 't.id_data_server');
    const rows = await db.q(
      `SELECT b.*, t.nomor_invoice, t.total, t.id_data_server, p.nama AS nama_pelanggan
       FROM pembayaran b
       JOIN tagihan t ON t.id = b.id_tagihan
       JOIN pelanggan p ON p.id = t.id_pelanggan
       WHERE b.status = 'menunggu'${ts.sql} ORDER BY b.id DESC LIMIT 100`,
      ts.params
    );
    res.json({ data: rows });
  } catch (e) { next(e); }
});

router.post('/pembayaran/:id/verifikasi', requirePJ(), requireMenu('pembayaran', 'verifikasi'), async (req, res, next) => {
  try {
    const id = v.num(req.params.id, { int: true, min: 1 });
    const aksi = v.enumOf(req.body.aksi, ['terima', 'tolak']);
    const ts = tenantSql(req, 't.id_data_server');
    const b = await db.one(
      `SELECT b.*, t.id_data_server FROM pembayaran b
       JOIN tagihan t ON t.id = b.id_tagihan WHERE b.id = ?${ts.sql}`,
      [id, ...ts.params]
    );
    if (!b) return res.status(404).json({ error: 'Pembayaran tidak ada' });
    if (b.status !== 'menunggu') return res.status(400).json({ error: 'Sudah diproses' });
    if (aksi === 'terima') {
      await db.run(`UPDATE pembayaran SET status='diterima', verified_by=? WHERE id=?`, [req.user.id, id]);
      await billing.lunaskanTagihan(b.id_tagihan, b.metode, { verifiedBy: req.user.id, jumlah: Number(b.jumlah) });
    } else {
      await db.run(`UPDATE pembayaran SET status='ditolak', verified_by=? WHERE id=?`, [req.user.id, id]);
      await db.run(`UPDATE tagihan SET status='terkirim' WHERE id=? AND status='menunggu'`, [b.id_tagihan]);
    }
    await db.insert('INSERT INTO audit_log (user_id, id_data_server, aksi, detail, ip) VALUES (?,?,?,?,?)',
      [req.user.id, b.id_data_server, `verifikasi_${aksi}`, `pembayaran #${id}`, (req.ip || '').replace('::ffff:', '')]);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// --------------------------------------------- payment gateway
router.get('/gateway', requirePJ(), async (req, res, next) => {
  try {
    const s = await cfgData.getServer(tenantAktif(req), true);
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

router.put('/gateway', requirePJ(), requireMenu('setting', 'gateway'), async (req, res, next) => {
  try {
    const ds = tenantAktif(req);
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
    vals.push(ds);
    await db.run(`UPDATE data_server SET ${patch.join(', ')} WHERE id = ?`, vals);
    cfgData.invalidate(ds);
    await db.insert('INSERT INTO audit_log (user_id, id_data_server, aksi, detail, ip) VALUES (?,?,?,?,?)',
      [req.user.id, ds, 'ubah_gateway', aktif, (req.ip || '').replace('::ffff:', '')]);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

/** Checkout Midtrans Snap — membuat transaksi, mengembalikan snap URL. */
router.post('/gateway/midtrans/snap', requireRole('superadmin', 'master', 'pelanggan'), async (req, res, next) => {
  try {
    const tagihanId = v.num(req.body.tagihan_id, { int: true, min: 1 });
    const t = await cariTagihan(req, tagihanId);
    if (!t || t.status === 'lunas') return res.status(400).json({ error: 'Tagihan tidak valid' });
    if (req.user.role === 'pelanggan' && Number(t.id_pelanggan) !== Number(req.user.id_ref)) {
      return res.status(403).json({ error: 'Akses ditolak' });
    }
    const ds = Number(t.id_data_server);
    const s = await cfgData.getServer(ds, true);
    if (s.pg_active !== 'midtrans' || !s.pg_midtrans_server_key) {
      return res.status(400).json({ error: 'Midtrans belum diaktifkan' });
    }
    const serverKey = crypto.decrypt(s.pg_midtrans_server_key);
    const snapBase = serverKey.startsWith('SB-')
      ? 'https://app.sandbox.midtrans.com/snap/v1'
      : 'https://app.midtrans.com/snap/v1';
    const payload = {
      transaction_details: { order_id: `${s.prefix_invoice || 'IVV'}-${t.id}-${Date.now()}`, gross_amount: Number(t.total) },
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
    const ts = tenantSql(req, 'id_data_server');
    res.json({ data: await db.q(`SELECT * FROM rekening WHERE status='aktif'${ts.sql}`, ts.params) });
  } catch (e) { next(e); }
});

module.exports = router;
