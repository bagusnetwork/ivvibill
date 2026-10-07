'use strict';
// ============================================================
// ivvibill — server utama
// 1 proses Node.js melayani: REST API, 4 app web
// (panel / agen / teknisi / pelanggan), webhook gateway,
// dan scheduler cron internal.
// ============================================================
const path = require('path');
const fs = require('fs');
const express = require('express');
const helmet = require('helmet');
const cookieParser = require('cookie-parser');
const rateLimit = require('express-rate-limit');

const config = require('./src/config');
const db = require('./src/db');
const { requireInternal } = require('./src/middleware/auth');
const scheduler = require('./src/scheduler');

// cadangan bila public/404.html belum ada
const TEMPLATE_404 = `<!doctype html><html lang="id"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>404 — ivvibill</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0b1220;color:#e6edf7;
font:16px/1.6 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;text-align:center}
a{color:#4da3ff;text-decoration:none}h1{font-size:64px;margin:0;color:#4da3ff}
p{opacity:.8}</style></head><body><div><h1>404</h1><p>Halaman tidak ditemukan.</p>
<p><a href="/">← Kembali ke beranda</a></p></div></body></html>`;

const app = express();
app.set('trust proxy', config.server.proxy ? 1 : false);
app.disable('x-powered-by');

// ---------- keamanan dasar -------------------------------------
// `upgrade-insecure-requests` membuat browser memaksa https untuk SEMUA
// aset & fetch — di server yang belum punya sertifikat TLS panel jadi
// tanpa gaya dan datanya tidak termuat. Hanya aktifkan bila BASE_URL https.
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      // Panel & 3 app lain memanggil fungsinya lewat atribut onclick/onchange,
      // sedangkan helmet memakai script-src-attr 'none' secara default — tanpa
      // baris ini seluruh tombol di halaman admin tidak berjalan.
      scriptSrcAttr: ["'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", 'data:', 'blob:'],
      connectSrc: ["'self'"],
      fontSrc: ["'self'", 'data:'],
      objectSrc: ["'none'"],
      frameAncestors: ["'none'"],
      ...(config.app.https ? {} : { upgradeInsecureRequests: null })
    }
  },
  crossOriginEmbedderPolicy: false,
  crossOriginResourcePolicy: { policy: 'same-origin' }
}));
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: false, limit: '1mb' }));
app.use(cookieParser());

// rate-limit umum — /api/noc dikecualikan (polling ping tiap detik per target)
app.use('/api/', rateLimit({
  windowMs: 60 * 1000,
  max: 240,
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => req.path.startsWith('/noc/'),
  message: { error: 'Terlalu banyak permintaan' }
}));
// rate-limit khusus NOC (6 target × 1 ping/detik + jitter)
app.use('/api/noc', rateLimit({
  windowMs: 60 * 1000,
  max: 900,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Terlalu banyak permintaan NOC' }
}));

// ---------- API (tanpa auth: health + webhook gateway) ---------
app.get('/api/health', async (req, res) => {
  try { await db.ping(); res.json({ ok: true, app: 'ivvibill', version: config.app.version }); }
  catch (e) { res.status(503).json({ ok: false, error: e.message }); }
});
app.use('/api', require('./src/routes/webhook'));

// ---------- API (wajib login — router menerapkan requireAuth) --
app.use('/api/auth', require('./src/routes/auth'));
app.use('/api', require('./src/routes/tenant'));      // data_server + group_akses
app.use('/api', require('./src/routes/pelanggan'));
app.use('/api', require('./src/routes/tagihan'));
app.use('/api', require('./src/routes/invoice'));      // invoice penjualan barang/jasa
app.use('/api', require('./src/routes/agen'));
app.use('/api', require('./src/routes/monitoring'));
app.use('/api', require('./src/routes/master'));         // topologi ODP + desa
app.use('/api', require('./src/routes/noc'));            // NOC ping test
app.use('/api', require('./src/routes/keuangan'));       // kas & laporan keuangan
app.use('/api', require('./src/routes/lain'));

// ---------- upload (bukti pembayaran) ---------------------------
app.use('/uploads', express.static(config.security.uploadDir, {
  dotfiles: 'deny', index: false, maxAge: '1d'
}));

// ---------- endpoint internal (cron luar / webhook) -------------
app.post('/internal/cron/:tugas', requireInternal, async (req, res) => {
  const t = req.params.tugas;
  try {
    if (t === 'wa') return res.json(await scheduler.tugasWa());
    if (t === 'router') return res.json(await scheduler.tugasRouter());
    if (t === 'olt') return res.json(await scheduler.tugasOlt());
    if (t === 'billing') return res.json(await scheduler.tugasBilling());
    if (t === 'issue') return res.json(await scheduler.tugasIssue());
    res.status(404).json({ error: 'Tugas tidak dikenal' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---------- statis: 4 app + landing ----------------------------
const pub = path.join(config.root, 'public');
app.use('/panel', express.static(path.join(pub, 'panel')));
app.use('/agen', express.static(path.join(pub, 'agen')));
app.use('/teknisi', express.static(path.join(pub, 'teknisi')));
app.use('/pelanggan', express.static(path.join(pub, 'pelanggan')));
app.use('/assets', express.static(path.join(pub, 'assets')));
// halaman cetak invoice (dibuka panel via /cetak/invoice.html?no=…)
app.use('/cetak', express.static(path.join(pub, 'cetak')));
// unduhan APK — harus sebelum fallback 404
app.use('/apk', express.static(path.join(pub, 'apk'), {
  dotfiles: 'deny', index: false, maxAge: '7d'
}));
app.get('/', (req, res) => res.sendFile(path.join(pub, 'index.html')));

// SPA fallback per app
['/panel', '/agen', '/teknisi', '/pelanggan'].forEach(p => {
  app.get(`${p}/*`, (req, res) => res.sendFile(path.join(pub, p.slice(1), 'index.html')));
});

// ---------- error handler --------------------------------------
app.use((req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'Tidak ditemukan' });
  const halaman = path.join(pub, '404.html');
  if (fs.existsSync(halaman)) return res.status(404).sendFile(halaman);
  res.status(404).type('html').send(TEMPLATE_404);
});
app.use((err, req, res, next) => {   // eslint-disable-line no-unused-vars
  const msg = err.message || 'Kesalahan server';
  const code = /tidak valid|wajib|minimal|maksimal|Harus|sudah|tidak cukup|tidak ditemukan|ditolak|gagal/i.test(msg) ? 400 : 500;
  if (code === 500) console.error('[ivvibill error]', err);
  if (res.headersSent) return;
  res.status(code).json({ error: msg });
});

// ---------- jalankan --------------------------------------------
(async () => {
  try {
    await db.ping();
  } catch (e) {
    console.error('[ivvibill] DB gagal:', e.message);
    process.exit(1);
  }
  if (process.env.DISABLE_SCHEDULER !== '1') scheduler.mulai();
  app.listen(config.server.port, config.server.bind, () => {
    console.log(`[ivvibill] http://${config.server.bind}:${config.server.port} aktif (${config.app.env})`);
  });
})();

process.on('SIGTERM', () => { scheduler.berhenti(); process.exit(0); });
process.on('SIGINT', () => { scheduler.berhenti(); process.exit(0); });

// Express 4 tidak meneruskan error dari handler async ke middleware — tanpa
// penahan ini satu request yang jelek bisa mematikan seluruh panel.
process.on('unhandledRejection', (e) => {
  console.error('[ivvibill] janji ditolak:', (e && e.stack) || e);
});
