'use strict';
// ============================================================
// NOC — ping test internet via RouterOS API router terpilih.
// Paket ICMP dikirim OLEH ROUTER (perintah /ping RouterOS),
// jadi hasil mencerminkan rute internet sebenarnya dari sisi
// jaringan pelanggan — bukan dari server hosting.
// Target di-whitelist; id router harus milik tenant pemohon.
// ============================================================
const express = require('express');
const db = require('../db');
const v = require('../util/validate');
const { requireAuth, requireRole } = require('../middleware/auth');
const { tenantSql } = require('../util/scope');
const crypto = require('../util/crypto');
const { RouterOS } = require('../services/routeros');

const router = express.Router();
router.use(requireAuth);

// whitelist target — host bebas dari query tidak pernah diterima
const TARGET = {
  facebook: 'facebook.com',
  youtube: 'youtube.com',
  'google-dns': '8.8.8.8',
  cloudflare: '1.1.1.1',
  tiktok: 'tiktok.com',
  mobilelegends: 'mobilelegends.com'
};

router.get('/noc/target', (req, res) => {
  res.json({ data: Object.entries(TARGET).map(([key, host]) => ({ key, host })) });
});

router.get('/noc/router', requireRole('superadmin', 'master', 'teknisi'), async (req, res, next) => {
  try {
    const ts = tenantSql(req, 's.id_data_server');
    const rows = await db.q(
      `SELECT s.id, s.nama, s.status, d.alamat, d.port, d.use_https
       FROM setting_mikrotik s
       JOIN master_perangkat d ON d.id = s.id_perangkat
       WHERE 1=1${ts.sql} ORDER BY s.nama`, ts.params);
    res.json({ data: rows });
  } catch (e) { next(e); }
});

router.get('/noc/ping', requireRole('superadmin', 'master', 'teknisi'), async (req, res, next) => {
  try {
    const key = v.str(req.query.target, { max: 30 });
    const host = TARGET[key];
    if (!host) return res.status(400).json({ ok: false, error: 'Target tidak dikenal' });
    const idRouter = v.num(req.query.router, { int: true, min: 1 });
    const ts = tenantSql(req, 's.id_data_server');
    const r = await db.one(
      `SELECT s.id, s.nama, d.alamat, d.port, d.username, d.password_enc
       FROM setting_mikrotik s
       JOIN master_perangkat d ON d.id = s.id_perangkat
       WHERE s.id = ?${ts.sql}`, [idRouter, ...ts.params]);
    if (!r) return res.status(404).json({ ok: false, error: 'Router tidak ditemukan' });

    let pass;
    try { pass = crypto.decrypt(r.password_enc); }
    catch (_) { return res.json({ ok: false, ms: null, ip: null, raw: 'Kredensial router tidak valid', router: r.nama }); }

    const api = new RouterOS({
      host: r.alamat, port: r.port || 8728,
      user: r.username, password: pass, timeout: 5000
    });
    const t0 = Date.now();
    try {
      const rows = await api.run(['/ping', `=address=${host}`, '=count=1', '=timeout=2s']);
      const row = rows.find(x => (x.status || '').toLowerCase() === 'reply') || rows[0] || {};
      const status = (row.status || '').toLowerCase();
      if (status === 'reply') {
        return res.json({
          ok: true,
          ms: row.time ? parseFloat(row.time) : (Date.now() - t0),
          ip: row['reply-from'] || host,
          raw: row.time ? `time=${row.time}` : '',
          router: r.nama
        });
      }
      return res.json({
        ok: false, ms: null, ip: null,
        raw: status ? `status=${status}` : 'Request timeout for icmp_seq',
        router: r.nama
      });
    } catch (e) {
      return res.json({ ok: false, ms: null, ip: null, raw: String(e.message).slice(0, 200), router: r.nama });
    } finally { api.close(); }
  } catch (e) { next(e); }
});

module.exports = router;
