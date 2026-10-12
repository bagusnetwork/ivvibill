'use strict';
// ============================================================
// Webhook TANPA login: payment gateway (Midtrans & Flip), dan laporan sesi
// dari MikroTik dengan token perangkat. Dipasang sebelum rute ber-auth di
// server.js.
//
// Multitenant: tenant diketahui lebih dulu dari nomor referensi
// (PREFIX-<idTagihan>-<timestamp>), lalu signature diverifikasi
// memakai kunci milik tenant tsb. Kunci ISP lain tidak pernah dicoba.
//
// Soal gerbang IP (v2.3.0): sebelumnya SEMUA notifikasi gateway ditolak
// lebih dulu bila IP pengirim bukan 127.0.0.1. Di server ini nginx memasang
// X-Forwarded-For dan TRUST_PROXY=1, jadi req.ip = alamat aslinya Midtrans —
// selalu berbeda, selalu di luar whitelist, dan pelunasan otomatis mati
// diam-diam. Autentikasi yang sebenarnya adalah signature_key: untuk
// memalsukan 'settlement' pelaku wajib tahu server key tenant (AES di luar
// jangkauan browser). Karena itu gerbang IP kini jadi pengaman TAMBAHAN yang
// hanya aktif bila WEBHOOK_IPS memang diisi, dan setiap notifikasi dicatat
// ke log + audit_log supaya kedatangannya bisa dibuktikan.
// ============================================================
const express = require('express');
const cryptoLib = require('crypto');
const db = require('../db');
const cfgData = require('../services/configData');
const crypto = require('../util/crypto');
const billing = require('../services/billing');
const mon = require('../services/monitoring');
const config = require('../config');

const router = express.Router();
const raw = express.raw({ type: '*/*', limit: '1mb' });

// Pengaman TAMBAHAN (opsional): isi WEBHOOK_IPS=1.2.3.4,5.6.* bila suatu saat
// ingin membatasi sumber notifikasi. Selama env itu kosong, gerbangnya adalah
// signature, bukan IP — dan itu memang cara Midtrans/Flip mendesain notifikasi.
const ALLOWED_EXTRA = (process.env.WEBHOOK_IPS || '').split(',').map(s => s.trim()).filter(Boolean);
const SEKAT_IP = ALLOWED_EXTRA.length > 0;
function ipTrusted(req) {
  const ip = String(req.ip || '').replace('::ffff:', '');
  return ALLOWED_EXTRA.some(a => ip === a || (a.endsWith('*') && ip.startsWith(a.slice(0, -1))))
    || config.server.trustedIps.includes(ip);
}
function ipTanpaVest(req) { return String(req.ip || '').replace('::ffff:', ''); }

/** Jejak ke log server (/var/log/ivvibill.log) — order id bukan data pribadi. */
function jejak(gateway, tenant, order, status, extra) {
  console.log(`[webhook ${gateway}] tenant=${tenant} order=${order} status=${status || '-'} ip=${extra.ip}${extra.catatan ? ' → ' + extra.catatan : ''}`);
}

/** Jejak yang terlihat di panel: hanya untuk kejadian yang mengubah uang/status. */
async function catatAudit(idDataServer, gateway, order, aksi, detail, ip) {
  try {
    // 5 kolom: user_id (NULL — bukan aksi manusia), id_data_server, aksi, detail, ip
    await db.insert(
      'INSERT INTO audit_log (user_id, id_data_server, aksi, detail, ip) VALUES (NULL,?,?,?,?)',
      [idDataServer, `webhook_${gateway}`, `${aksi} · ${order} · ${detail}`, ip]);
  } catch (e) {
    // pencatatan tidak boleh menggagalkan notifikasi, tapi kegagalannya
    // jangan hilang tanpa jejak
    console.error(`[webhook ${gateway}] audit_log gagal: ${e.message}`);
  }
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
  return db.one(
    `SELECT id, id_data_server, nomor_invoice, total, status, ref_gateway, jatuh_tempo
       FROM tagihan WHERE id = ?`, [idTagihan]);
}

/**
 * Transaksi gateway mati (deny/cancel/expire/failed): kembalikan tagihan ke
 * keadaan sebelumnya. Dibatasi pada baris yang MEMANG sedang 'menunggu' karena
 * order id ini (ref_gateway) dan yang tidak punya bukti transfer manual yang
 * menunggu verifikasi — kalau tidak, notifikasi 'expire' dari percobaan bayar
 * yang gagal bisa menghapus tagihan yang sebenarnya sudah dikirim buktinya.
 * Jatuh tempo yang sudah lewat kembali menjadi 'jatuh_tempo' supaya siklus
 * isolir tetap melihatnya sebagai tunggakan.
 */
async function lepasGerbang(idTagihan, order) {
  return db.run(
    `UPDATE tagihan t
        SET t.status = IF(t.jatuh_tempo < CURDATE(), 'jatuh_tempo', 'terkirim')
      WHERE t.id = ? AND t.status = 'menunggu' AND t.ref_gateway = ?
        AND NOT EXISTS (SELECT 1 FROM pembayaran b
                         WHERE b.id_tagihan = t.id AND b.status = 'menunggu')`,
    [idTagihan, order]);
}

// ------------------------------------------------ Midtrans
/** Status yang berarti uang benar-benar masuk. */
const LUNAS = new Set(['capture', 'settlement']);
/** Status yang berarti transaksi ini mati. */
const MATI = new Set(['deny', 'cancel', 'expire', 'failed']);

router.post('/webhook/midtrans', raw, async (req, res) => {
  try {
    const ip = ipTanpaVest(req);
    if (SEKAT_IP && !ipTrusted(req)) return res.status(403).json({ error: 'ip not allowed' });
    const body = parseBody(req);
    const order = String(body.order_id || '');
    const status = String(body.transaction_status || '');
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
      jejak('midtrans', t.id_data_server, order, status, { ip, catatan: 'SIGNATURE TIDAK COCOK — ditolak' });
      await catatAudit(t.id_data_server, 'midtrans', order, 'ditolak',
        `signature tidak cocok (status ${status || '-'})`, ip);
      return res.status(403).json({ error: 'signature invalid' });
    }

    if (LUNAS.has(status) && ['deny', 'cancel'].includes(String(body.fraud_status || ''))) {
      jejak('midtrans', t.id_data_server, order, status, { ip, catatan: 'fraud_status ' + body.fraud_status + ' — tidak dilunasi' });
      return res.json({ ok: true, diabaikan: 'fraud_' + body.fraud_status });
    }

    if (LUNAS.has(status)) {
      // Jumlah harus sama persis dengan total tagihan. Midtrans mengirim nilai
      // yang kita minta saat checkout, jadi selisih = ada yang tidak beres
      // (order id dipakai ulang / nominal diubah manual) → jangan auto-lunas.
      const masuk = Math.round(Number(gross));
      const harus = Math.round(Number(t.total));
      if (!(masuk > 0) || masuk !== harus) {
        jejak('midtrans', t.id_data_server, order, status,
          { ip, catatan: `JUMLAH TIDAK COCOK ${masuk} ≠ ${harus} — TIDAK dilunasi, periksa manual` });
        await catatAudit(t.id_data_server, 'midtrans', order, 'jumlah beda',
          `tagihan ${t.nomor_invoice}: masuk ${masuk}, harusnya ${harus}`, ip);
        return res.json({ ok: true, diabaikan: 'amount_mismatch' });
      }
      const r = await billing.lunaskanTagihan(t.id, 'midtrans', { ref: order, jumlah: Number(gross) });
      jejak('midtrans', t.id_data_server, order, status,
        { ip, catatan: r.already ? 'sudah lunas — notifikasi ulang diabaikan' : 'tagihan ' + t.nomor_invoice + ' LUNAS' });
      if (!r.already) {
        await catatAudit(t.id_data_server, 'midtrans', order, 'lunas',
          `tagihan ${t.nomor_invoice} Rp ${masuk} (metode midtrans)`, ip);
      }
      return res.json({ ok: true, lunas: !r.already });
    }

    if (MATI.has(status)) {
      const dilepas = await lepasGerbang(t.id, order);
      jejak('midtrans', t.id_data_server, order, status,
        { ip, catatan: dilepas ? 'tagihan dilepas dari status menunggu' : 'tidak ada yang dilepas (bukan menunggu karena gateway ini)' });
      if (dilepas) {
        await catatAudit(t.id_data_server, 'midtrans', order, 'batal',
          `tagihan ${t.nomor_invoice} kembali ke ${status === 'expire' ? 'jatuh_tempo/terkirim' : 'terkirim'} (${status})`, ip);
      }
      return res.json({ ok: true });
    }

    jejak('midtrans', t.id_data_server, order, status, { ip, catatan: 'status antara — tidak mengubah apa pun' });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ------------------------------------------------ Flip
router.post('/webhook/flip', raw, async (req, res) => {
  try {
    const ip = ipTanpaVest(req);
    if (SEKAT_IP && !ipTrusted(req)) return res.status(403).json({ error: 'ip not allowed' });
    const body = parseBody(req);
    const meta = String(body.reference_id || body.remarks || '');
    const status = String(body.status || '');
    const t = await tenantTagihan(meta);
    if (!t) return res.status(404).json({ error: 'tagihan tidak dikenali' });

    const s = await cfgData.getServer(t.id_data_server, true);
    if (!s.pg_flip_secret_key) return res.status(400).json({ error: 'not configured' });
    const secret = crypto.decrypt(s.pg_flip_secret_key);
    const id = String(body.id || body.transfer_id || '');
    const expected = cryptoLib.createHash('sha256').update(id + secret).digest('hex');
    if (expected !== String(body.signature || '')) {
      jejak('flip', t.id_data_server, meta, status, { ip, catatan: 'SIGNATURE TIDAK COCOK — ditolak' });
      return res.status(403).json({ error: 'signature invalid' });
    }

    if (status.toLowerCase() === 'completed') {
      const masuk = Math.round(Number(body.amount || 0));
      const harus = Math.round(Number(t.total));
      if (masuk !== harus) {
        jejak('flip', t.id_data_server, meta, status,
          { ip, catatan: `JUMLAH TIDAK COCOK ${masuk} ≠ ${harus} — TIDAK dilunasi` });
        await catatAudit(t.id_data_server, 'flip', meta, 'jumlah beda',
          `tagihan ${t.nomor_invoice}: masuk ${masuk}, harusnya ${harus}`, ip);
        return res.json({ ok: true, diabaikan: 'amount_mismatch' });
      }
      const r = await billing.lunaskanTagihan(t.id, 'flip', { ref: id, jumlah: masuk });
      jejak('flip', t.id_data_server, meta, status,
        { ip, catatan: r.already ? 'sudah lunas — notifikasi ulang diabaikan' : 'tagihan ' + t.nomor_invoice + ' LUNAS' });
      if (!r.already) {
        await catatAudit(t.id_data_server, 'flip', meta, 'lunas', `tagihan ${t.nomor_invoice} Rp ${masuk}`, ip);
      }
    } else if (['failed', 'cancelled', 'canceled', 'expired'].includes(status.toLowerCase())) {
      const dilepas = await lepasGerbang(t.id, meta);
      jejak('flip', t.id_data_server, meta, status, { ip, catatan: dilepas ? 'menunggu dilepas' : 'tidak ada yang dilepas' });
    } else {
      jejak('flip', t.id_data_server, meta, status, { ip, catatan: 'status antara' });
    }
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ------------------------------------------------ laporan sesi dari MikroTik
/**
 * Dikirim /system script 'IvvibillAPI' yang dipasang tombol Test perangkat,
 * tiap 40 detik. Tanpa login: yang membuktikan siapa pengirim adalah token acak
 * per perangkat (master_perangkat.token_push), dan token itu hanya bisa
 * membaca/menulis baris milik perangkatnya sendiri.
 */
router.post('/router/push', async (req, res) => {
  try {
    const b = parseBody(req);
    const token = String(req.query.token || b.token || '');
    if (!/^[0-9a-f]{20,64}$/.test(token)) return res.status(401).json({ error: 'token tidak valid' });
    const dev = await db.one(
      'SELECT id, id_data_server, nama, brand FROM master_perangkat WHERE token_push = ?', [token]);
    if (!dev) return res.status(404).json({ error: 'perangkat tidak dikenali' });
    if (dev.brand !== 'mikrotik') return res.status(400).json({ error: 'perangkat bukan MikroTik' });
    res.json({ ok: true, ...(await mon.simpanPush(dev, b)) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;