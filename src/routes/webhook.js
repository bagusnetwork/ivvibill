'use strict';
// ============================================================
// Webhook payment gateway (Midtrans & Flip) — TANPA login,
// diamankan dengan verifikasi signature + IP whitelist internal.
// Dipasang sebelum rute ber-auth di server.js.
//
// Multitenant: tenant diketahui lebih dulu dari nomor referensi
// (PREFIX-<idTagihan>-<timestamp>), lalu signature diverifikasi
// memakai kunci milik tenant tsb. Kunci ISP lain tidak pernah dicoba.
// ============================================================
const express = require('express');
const cryptoLib = require('crypto');
const db = require('../db');
const cfgData = require('../services/configData');
const crypto = require('../util/crypto');
const billing = require('../services/billing');
const config = require('../config');

const router = express.Router();
const raw = express.raw({ type: '*/*', limit: '1mb' });

// IP gateway dibolehkan selain trustedIps (opsional, by env)
const ALLOWED_EXTRA = (process.env.WEBHOOK_IPS || '').split(',').map(s => s.trim()).filter(Boolean);
function ipOk(req) {
  const ip = String(req.ip || '').replace('::ffff:', '');
  return ALLOWED_EXTRA.some(a => ip === a || (a.endsWith('*') && ip.startsWith(a.slice(0, -1))))
    || config.server.trustedIps.includes(ip);
}

function parseBody(req) {
  if (Buffer.isBuffer(req.body)) return JSON.parse(req.body.toString() || '{}');
  if (typeof req.body === 'string') return JSON.parse(req.body || '{}');
  return req.body || {};
}

/** Nomor referensi = PREFIX-<idTagihan>-<timestamp>; prefix bisa berubah per ISP. */
function tagihanDariRef(ref) {
  const bagian = String(ref || '').split('-');
  const id = Number(bagian[bagian.length - 2]);
  return Number.isInteger(id) && id > 0 ? id : null;
}

/** Tagihan + baris data_server-nya (404 ditulis oleh pemanggil bila null). */
async function tenantTagihan(ref) {
  const idTagihan = tagihanDariRef(ref);
  if (!idTagihan) return null;
  const t = await db.one('SELECT id, id_data_server, total, status FROM tagihan WHERE id = ?', [idTagihan]);
  if (!t) return null;
  return t;
}

// ------------------------------------------------ Midtrans
router.post('/webhook/midtrans', raw, async (req, res) => {
  try {
    if (!ipOk(req)) return res.status(403).json({ error: 'ip not allowed' });
    const body = parseBody(req);
    const order = String(body.order_id || '');
    const t = await tenantTagihan(order);
    if (!t) return res.status(404).json({ error: 'tagihan tidak dikenali' });

    const s = await cfgData.getServer(t.id_data_server, true);
    if (!s.pg_midtrans_server_key) return res.status(400).json({ error: 'not configured' });
    const serverKey = crypto.decrypt(s.pg_midtrans_server_key);
    const statusKey = String(body.status_code || '');
    const gross = String(body.gross_amount || '');
    const expected = cryptoLib.createHash('sha512')
      .update(order + statusKey + gross + serverKey).digest('hex');
    if (expected !== String(body.signature_key || '')) {
      return res.status(403).json({ error: 'signature invalid' });
    }

    if (body.transaction_status === 'capture' || body.transaction_status === 'settlement') {
      await billing.lunaskanTagihan(t.id, 'midtrans', { ref: order, jumlah: Number(gross) });
    } else if (body.transaction_status === 'deny') {
      await db.run(`UPDATE tagihan SET status='terkirim' WHERE id=? AND status='menunggu'`, [t.id]);
    }
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ------------------------------------------------ Flip
router.post('/webhook/flip', raw, async (req, res) => {
  try {
    if (!ipOk(req)) return res.status(403).json({ error: 'ip not allowed' });
    const body = parseBody(req);
    const meta = String(body.reference_id || body.remarks || '');
    const t = await tenantTagihan(meta);
    if (!t) return res.status(404).json({ error: 'tagihan tidak dikenali' });

    const s = await cfgData.getServer(t.id_data_server, true);
    if (!s.pg_flip_secret_key) return res.status(400).json({ error: 'not configured' });
    const secret = crypto.decrypt(s.pg_flip_secret_key);
    const id = String(body.id || body.transfer_id || '');
    const expected = cryptoLib.createHash('sha256').update(id + secret).digest('hex');
    if (expected !== String(body.signature || '')) return res.status(403).json({ error: 'signature invalid' });
    if (String(body.status || '').toLowerCase() === 'completed') {
      await billing.lunaskanTagihan(t.id, 'flip', { ref: id, jumlah: Number(body.amount || 0) });
    }
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
