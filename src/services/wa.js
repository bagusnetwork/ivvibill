'use strict';
// ============================================================
// WhatsApp gateway — antrean, pengiriman, dan pairing (WHAPI-style:
//   GET  {wa_gateway_url}/getState|getQR|serviceStart?apiKey=...
//   POST {wa_gateway_url}/sendMessage  apiKey, phone, message)
// Template memakai placeholder: #usr #ppp #add #lyn #tot #ket
// #lmt #jum #ppn #unk #hly #jly #lnk #inv #prd #srv #jam #judul
// ============================================================
const db = require('../db');
const cfgUtil = require('./configData');
const crypto = require('../util/crypto');
const http = require('../util/http');

function normalizePhone(p) {
  let s = String(p || '').replace(/[^0-9]/g, '');
  if (s.startsWith('0')) s = '62' + s.slice(1);
  else if (s.startsWith('8')) s = '62' + s;
  return s;
}

function render(template, vars) {
  return String(template || '').replace(/#[a-z]+/gi, (m) => {
    const k = m.slice(1).toLowerCase();
    return vars[k] !== undefined && vars[k] !== null ? String(vars[k]) : '';
  });
}

async function ambilTemplate(jenis, idDataServer = 1) {
  const t = await db.one(
    'SELECT konten FROM pesan_template WHERE id_data_server = ? AND jenis = ?',
    [idDataServer, jenis]
  );
  return t ? t.konten : '';
}

/** Enqueue pesan — dipanggil oleh billing/cron/modul lain.
 *  `media` = URL gambar/PDF yang sudah bisa dijangkau gateway; kalau diisi,
 *  `pesan` dipakai sebagai caption (WHAPI sendMediaFromUrl). */
async function enqueue({ tujuan, jenis, pesan, media = null, idRef = null, idDataServer = 1 }) {
  const no = normalizePhone(tujuan);
  if (!no) return null;
  return db.insert(
    'INSERT INTO wa_queue (id_data_server, tujuan, jenis, pesan, media, id_ref) VALUES (?,?,?,?,?,?)',
    [idDataServer, no, jenis, pesan, media, idRef]
  );
}

/** Basis URL gateway tanpa slash di ujung. */
function basisUrl(server) {
  const url = String(server.wa_gateway_url || '').replace(/\/+$/, '');
  if (!url) throw new Error('URL WhatsApp gateway belum diatur');
  return url;
}

/**
 * Panggil satu metode WHAPI: GET {url}/{metode}?apiKey=...
 * Wa_gateway_url HARUS menunjuk folder API-nya (contoh http://127.0.0.1:3000/api),
 * karena WHAPI melayani /api/getState, /api/getQR, /api/serviceStart, /api/sendMessage.
 * Kalau yang balik bukan JSON, hampir pasti URL-nya kurang "/api".
 */
async function metodeGateway(server, metode) {
  const key = crypto.decrypt(server.wa_gateway_key) || '';
  if (!key) throw new Error('API key WhatsApp gateway belum disimpan');
  const res = await http.get(`${basisUrl(server)}/${metode}?apiKey=${encodeURIComponent(key)}`, { timeout: 15000 });
  if (!res.body || typeof res.body !== 'object') {
    throw new Error(`Gateway membalas HTTP ${res.status} bukan JSON — URL harus sampai folder API, contoh http://127.0.0.1:3000/api`);
  }
  return res.body;
}

/** Status pairing tenant: state gateway + QR (data URL) saat gateway sedang scan. */
async function pairing(server) {
  const st = await metodeGateway(server, 'getState');
  const r = st.results || {};
  let qr = null;
  if (r.state === 'SERVICE_SCAN') {
    const q = await metodeGateway(server, 'getQR');
    qr = (q.results && q.results.qrString) || null;
  }
  return { state: r.state || null, qr, pesan: r.message || '' };
}

/** Jalankan service gateway supaya device masuk masa pairing. */
async function mulaiPairing(server) {
  const r = await metodeGateway(server, 'serviceStart');
  const d = r.results || {};
  // serviceStart sering balik tanpa state — baca ulang lewat getState supaya
  // panel dan audit log langsung menampilkan kondisi device yang sebenarnya.
  let l = {};
  try { l = await pairing(server); } catch (e) { /* jawab seadanya kalau gateway belum stabil */ }
  return { state: l.state || d.state || null, qr: l.qr || null, pesan: d.message || l.pesan || '' };
}

/** Kirim satu pesan langsung ke gateway. */
async function kirimSatu(item, server) {
  const url = basisUrl(server);
  // apiKey disimpan terenkripsi AES (lihat PUT /gateway di routes/tagihan.js)
  const key = crypto.decrypt(server.wa_gateway_key) || '';
  const media = item.media ? String(item.media) : '';
  const metode = media ? 'sendMediaFromUrl' : 'sendMessage';
  const body = media
    ? { apiKey: key, phone: item.tujuan, url: media, as_document: 0, caption: item.pesan }
    : { apiKey: key, phone: item.tujuan, message: item.pesan };
  const res = await http.post(`${url}/${metode}`, new URLSearchParams(body).toString(), {
    timeout: 20000,
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
  });
  const ok = res.status >= 200 && res.status < 300;
  return { ok, code: res.status, message: res.text.slice(0, 450) };
}

/**
 * Proses antrean: kirim semua pesan pending (maks `limit`).
 * Dipanggil cron tiap menit.
 */
async function prosesAntrean(limit = 30, idDataServer = null) {
  const filter = idDataServer ? ' AND id_data_server = ?' : '';
  const params = idDataServer ? ['pending', Number(idDataServer), Number(limit)] : ['pending', Number(limit)];
  const rows = await db.q(
    `SELECT * FROM wa_queue WHERE status = ?${filter} ORDER BY id ASC LIMIT ?`, params
  );
  if (!rows.length) return { sent: 0, failed: 0 };

  // tiap ISP punya URL + apiKey sendiri — kredensial tenant lain tidak boleh dipakai
  const serverTenant = new Map();
  let sent = 0, failed = 0;
  for (const item of rows) {
    let status = 'gagal', err = null;
    try {
      const ds = Number(item.id_data_server) || 1;
      if (!serverTenant.has(ds)) serverTenant.set(ds, await cfgUtil.getServer(ds));
      const r = await kirimSatu(item, serverTenant.get(ds));
      if (r.ok) { status = 'terkirim'; sent++; }
      else { failed++; err = `HTTP ${r.code}: ${r.message}`; }
    } catch (e) {
      failed++; err = e.message;
    }
    await db.run(
      'UPDATE wa_queue SET status = ?, percobaan = percobaan + 1, error = ?, sent_at = NOW() WHERE id = ?',
      [status, err ? String(err).slice(0, 250) : null, item.id]
    );
    await db.insert(
      'INSERT INTO wa_log (id_queue, tujuan, pesan, status, response) VALUES (?,?,?,?,?)',
      [item.id, item.tujuan, item.pesan, status, err ? String(err).slice(0, 450) : 'OK']
    );
  }
  return { sent, failed };
}

module.exports = { normalizePhone, render, ambilTemplate, enqueue, prosesAntrean, pairing, mulaiPairing };
