'use strict';
// ============================================================
// NOC — ping test internet via RouterOS API router terpilih.
// Paket ICMP dikirim OLEH ROUTER (perintah /ping RouterOS),
// jadi hasil mencerminkan rute internet sebenarnya dari sisi
// jaringan pelanggan — bukan dari server hosting.
// Target di-whitelist; id router harus milik tenant pemohon.
//
// Format /ping RouterOS 7 (diverifikasi langsung ke RO-IVVI 7.19.2):
//   sukses  : !re =host=8.8.8.8 =ttl=117 =time=3ms90us =sent=1
//             =received=1 =packet-loss=0 =min-rtt= =avg-rtt= =max-rtt=
//   buntu   : !re =host=203.0.113.1 =status=timeout =received=0 =packet-loss=100
//   tak ada nama: !trap "while resolving ip-address: name does not exist"
// Tidak ada `status=reply`/`reply-from` seperti tampilan CLI, dan `timeout`
// BUKAN parameter sah /ping — mengirim '=timeout=2s' dijawab
// "!trap =message=unknown parameter timeout", artinya SEMUA ping gagal
// sebelum satu paket ICMP pun dikirim router.
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

const ANTRE_MAX = 6;     // request yang sedang menunggu satu koneksi router
const IDLE_MS = 60000;   // koneksi API ditutup bila tidak dipakai

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

/** '3ms90us' / '1s20ms' / '540us' -> milidetik (null bila tidak ada angkanya). */
function msRouterOS(nilai) {
  const teks = String(nilai || '');
  const re = /(\d+(?:\.\d+)?)(ns|us|ms|s)/g;
  const kali = { ns: 0.000001, us: 0.001, ms: 1, s: 1000 };
  let total = null, m;
  while ((m = re.exec(teks))) total = (total || 0) + Number(m[1]) * kali[m[2]];
  return total === null ? null : Math.round(total * 100) / 100;
}

/** Satu baris ringkasan /ping -> payload yang dipakai panel (ok, ms, ip, raw). */
function dariRouter(row, namaRouter) {
  const status = String(row.status || '').toLowerCase();
  const diterima = Number(row.received || 0);
  const seq = row.seq || '0';
  const ip = row.host || null;          // router sudah menyelesaikan nama target
  if (diterima === 0) {
    return { ok: false, ms: null, ip, router: namaRouter,
      raw: status ? `status=${status} (icmp_seq ${seq})` : `Request timeout for icmp_seq ${seq}` };
  }
  const waktu = row.time || row['avg-rtt'] || '';
  return {
    ok: true,
    ms: msRouterOS(waktu),
    ip,
    router: namaRouter,
    raw: `time=${waktu || '0'}${row.ttl ? ` ttl=${row.ttl}` : ''}${
      Number(row['packet-loss']) ? ` loss=${row['packet-loss']}%` : ''}`
  };
}

// Enam target berdetak serentak dari browser tiap ~2 detik. Tanpa daur ulang
// koneksi, tiap detak = TCP baru + login RouterOS (ratusan login/menit) dan
// itu memperlambat API router yang juga dipakai monitoring/isolir/tagihan.
// Jadi: satu koneksi per router, dipakai bergantian lewat antrean.
const koneksi = new Map();      // "host:port:user" -> { api, antre, menunggu, terakhirPakai }
const sedangJalan = new Map();  // "<routerId>|<target>" -> Promise payload (detak dobel ikut hasil yang sama)

async function panggilRouter(kunci, opts, kata) {
  let k = koneksi.get(kunci);
  if (!k) {
    k = { api: null, antre: Promise.resolve(), menunggu: 0, terakhirPakai: Date.now() };
    koneksi.set(kunci, k);
  }
  if (k.menunggu >= ANTRE_MAX) throw new Error('antrean ping router penuh — router sedang tidak menjawab');
  k.menunggu++;
  k.terakhirPakai = Date.now();
  const jalan = k.antre.then(async () => {
    if (!k.api) {
      const baru = new RouterOS(opts);
      await baru.connect();
      k.api = baru;
    }
    try {
      return await k.api.run(kata);
    } catch (e) {
      // socket mati/timeout baca: koneksi berikutnya dibuat ulang
      if (/ditutup|Timeout|ECONN|reset|EOF/i.test(String(e.message))) {
        try { k.api.close(); } catch (_) {}
        k.api = null;
      }
      throw e;
    } finally {
      k.terakhirPakai = Date.now();
    }
  });
  k.antre = jalan.catch(() => {});
  try { return await jalan; } finally { k.menunggu--; }
}

const perapian = setInterval(() => {
  for (const [kunci, k] of koneksi) {
    if (!k.menunggu && Date.now() - k.terakhirPakai > IDLE_MS) {
      if (k.api) { try { k.api.close(); } catch (_) {} }
      koneksi.delete(kunci);
    }
  }
}, 15000);
if (perapian.unref) perapian.unref();

/** Satu putaran /ping count=1. Tidak pernah melempar — selalu payload untuk panel. */
async function satuPing(r, host) {
  let pass;
  try { pass = crypto.decrypt(r.password_enc); }
  catch (_) {
    return { ok: false, ms: null, ip: null, router: r.nama, raw: 'Kredensial router tidak valid' };
  }
  const t0 = Date.now();
  const kunci = `${r.alamat}:${r.port || 8728}:${r.username}`;
  try {
    const rows = await panggilRouter(kunci,
      { host: r.alamat, port: r.port || 8728, user: r.username, password: pass, timeout: 6000 },
      ['/ping', `=address=${host}`, '=count=1']);
    if (!rows.length) {
      return { ok: false, ms: null, ip: null, router: r.nama, raw: 'router tidak mengirim balasan' };
    }
    const hasil = dariRouter(rows[rows.length - 1], r.nama);
    // row tanpa `time` (mis. sebagian balasan parsial) — pakai lama request sebagai cadangan
    if (hasil.ok && hasil.ms === null) hasil.ms = Date.now() - t0;
    return hasil;
  } catch (e) {
    const pesan = String(e.message || e).split('\r\n')[0].replace(/^RouterOS:\s*/, '');
    return { ok: false, ms: null, ip: null, router: r.nama,
      raw: (pesan.length > 90 ? pesan.slice(0, 90) + '…' : pesan) || 'router menolak perintah' };
  }
}

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

    const id = `${r.id}|${key}`;
    let jalan = sedangJalan.get(id);
    if (!jalan) {
      jalan = satuPing(r, host);
      jalan.finally(() => { if (sedangJalan.get(id) === jalan) sedangJalan.delete(id); });
      sedangJalan.set(id, jalan);
    }
    res.json(await jalan);
  } catch (e) { next(e); }
});

module.exports = router;
