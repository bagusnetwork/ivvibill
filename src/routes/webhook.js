'use strict';
// ============================================================
// Webhook payment gateway (Midtrans & Flip) — TANPA login,
// diamankan dengan verifikasi signature + IP whitelist internal.
// Dipasang sebelum rute ber-auth di server.js.
// ============================================================
const express = require('express');
const cryptoLib = require('crypto');
const db = require('../db');
const cfgData = require('../services/configData');
const crypto = require('../util/crypto');
const billing = require('../services/billing');

const router = express.Router();
const raw = express.raw({ type: '*/*', limit: '1mb' });

// IP gateway dibolehkan selain trustedIps (opsional, by env)
const ALLOWED_EXTRA = (process.env.WEBHOOK_IPS || '').split(',').map(s => s.trim()).filter(Boolean);
function ipOk(req) {
  const ip = String(req.ip || '').replace('::ffff:', '');
  return ALLOWED_EXTRA.some(a => ip === a || (a.endsWith('*') && ip.startsWith(a.slice(0, -1))));
}

function parseBody(req) {
  if (Buffer.isBuffer(req.body)) return JSON.parse(req.body.toString() || '{}');
  if (typeof req.body === 'string') return JSON.parse(req.body || '{}');
  return req.body || {};
}

// ------------------------------------------------ Midtrans
router.post('/webhook/midtrans', raw, async (req, res) => {
  try {
    if (!ipOk(req)) {
      const ip = String(req.ip || '').replace('::ffff:', '');
      if (!require('../config').server.trustedIps.includes(ip)) {
        return res.status(403).json({ error: 'ip not allowed' });
      }
    }
    const body = parseBody(req);
    const s = await cfgData.getServer(1, true);
    if (!s.pg_midtrans_server_key) return res.status(400).json({ error: 'not configured' });
    const serverKey = crypto.decrypt(s.pg_midtrans_server_key);
    const order = String(body.order_id || '');
    const statusKey = String(body.status_code || '');
    const gross = String(body.gross_amount || '');
    const expected = cryptoLib.createHash('sha512')
      .update(order + statusKey + gross + serverKey).digest('hex');
    if (expected !== String(body.signature_key || '')) {
      return res.status(403).json({ error: 'signature invalid' });
    }
    const m = order.match(/^IVV-(\d+)-/);
    if (m && (body.transaction_status === 'capture' || body.transaction_status === 'settlement')) {
      await billing.lunaskanTagihan(Number(m[1]), 'midtrans', { ref: order, jumlah: Number(gross) });
    } else if (m && body.transaction_status === 'deny') {
      await db.run(`UPDATE tagihan SET status='terkirim' WHERE id=? AND status='menunggu'`, [Number(m[1])]);
    }
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ------------------------------------------------ Flip
router.post('/webhook/flip', raw, async (req, res) => {
  try {
    if (!ipOk(req)) {
      const ip = String(req.ip || '').replace('::ffff:', '');
      if (!require('../config').server.trustedIps.includes(ip)) {
        return res.status(403).json({ error: 'ip not allowed' });
      }
    }
    const body = parseBody(req);
    const s = await cfgData.getServer(1, true);
    if (!s.pg_flip_secret_key) return res.status(400).json({ error: 'not configured' });
    const secret = crypto.decrypt(s.pg_flip_secret_key);
    const id = String(body.id || body.transfer_id || '');
    const expected = cryptoLib.createHash('sha256').update(id + secret).digest('hex');
    if (expected !== String(body.signature || '')) return res.status(403).json({ error: 'signature invalid' });
    const meta = String(body.reference_id || body.remarks || '');
    const m = meta.match(/IVV-(\d+)/);
    if (m && String(body.status || '').toLowerCase() === 'completed') {
      await billing.lunaskanTagihan(Number(m[1]), 'flip', { ref: id, jumlah: Number(body.amount || 0) });
    }
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
