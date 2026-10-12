'use strict';
// ============================================================
// Konfigurasi per data_server (tenant) — cache singkat per id
// + helper nomor invoice memakai prefix milik tenant itu sendiri.
// ============================================================
const db = require('../db');
const { waktuSiklus } = require('../util/tanggal');

const TTL = 30000;
const cache = new Map();   // id -> { row, at }

/**
 * Baca baris data_server. `id` WAJIB: tidak ada lagi default tenant 1,
 * supaya jalur yang lupa meneruskan tenant gagal keras, bukan diam-diam
 * memakai kredensial ISP lain.
 */
async function getServer(id, force = false) {
  const n = Number(id);
  if (!Number.isInteger(n) || n < 1) throw new Error('getServer: id data_server wajib diisi');
  const hit = cache.get(n);
  if (!force && hit && Date.now() - hit.at < TTL) return hit.row;
  const row = await db.one('SELECT * FROM data_server WHERE id = ?', [n]);
  if (!row) throw new Error(`Data server ${n} tidak ada`);
  cache.set(n, { row, at: Date.now() });
  return row;
}

/**
 * Buang cache — seluruh tenant bila id kosong, satu tenant bila id diisi.
 * configApp (setting_app) ikut dibuang supaya satu aksi invalidasi
 * selalu menyegarkan kedua sumber konfigurasi tenant.
 */
function invalidate(id) {
  if (id === undefined || id === null) cache.clear();
  else cache.delete(Number(id));
  require('./configApp').invalidate(id);
}

/**
 * Masa langganan habis? `expaired_date` adalah hari TERAKHIR yang masih
 * berlaku: ISP masih boleh masuk sepanjang hari itu, dan baru dianggap
 * berakhir pada hari berikutnya.
 *
 * Ditandingkan sebagai teks 'YYYY-MM-DD' pada tanggal dinding ISP
 * (util/tanggal.waktuSiklus, zona aplikasi) — sama seperti `CURDATE()` milik
 * MySQL yang dipakai FILTER_BERLANGGANAN di bawah. Versi lama memakai
 * `new Date(expired) < now - 24 jam`, dan karena kolom DATE dari driver
 * datang sebagai tengah malam UTC, batas "habis" versi node dan versi SQL
 * bisa berbeda sampai beberapa jam di pagi WIB.
 */
function habisMasa(srv, sekarang = new Date()) {
  if (!srv || !srv.expaired_date) return false;
  const akhir = srv.expaired_date instanceof Date
    ? waktuSiklus(srv.expaired_date).hari            // kolom DATE yang terbaca sebagai Date
    : String(srv.expaired_date).slice(0, 10);        // 'YYYY-MM-DD' (dateStrings: true)
  return akhir < waktuSiklus(new Date(sekarang)).hari;
}

/** Klausa WHERE tambahan: tenant aktif dan masa langganan belum habis.
 *  `expaired_date` = hari TERAKHIR yang masih berlaku, jadi `>= CURDATE()`
 *  — sama persis dengan habisMasa() di atas. Sebelumnya di sini dipakai
 *  kelonggaran satu hari sehingga scheduler masih menyiklus ISP yang
 *  habisMasa() sudah nyatakan berakhir. */
const FILTER_BERLANGGANAN =
  ` AND status = 'Aktif' AND (expaired_date IS NULL OR expaired_date >= CURDATE())`;

/** Daftar tenant yang masih berlangganan (aktif + expaired_date belum lewat).
 *  Klausa yang sama dipakai scheduler lewat FILTER_BERLANGGANAN. Pemilih tenant
 *  di panel punya fungsi sendiri (routes/auth.daftarServerUser) yang sengaja
 *  TETAP menampilkan ISP kedaluwarsa untuk pemilik platform, supaya ia bisa
 *  masuk ke sana dan memperpanjang masa aktifnya. */
async function daftarServer() {
  return db.q(`SELECT id, nama_server, prefix_invoice, expaired_date, status
               FROM data_server WHERE 1=1${FILTER_BERLANGGANAN} ORDER BY id`);
}

/**
 * Validasi id tenant untuk fungsi yang dulu memakai `idDataServer = 1`.
 * Tidak ada lagi default: pemanggil yang lupa meneruskan id harus gagal
 * keras, bukan diam-diam menagih/mengirim WhatsApp atas nama tenant 1.
 */
function idTenant(id) {
  const n = Number(id);
  if (!Number.isInteger(n) || n < 1) throw new Error('id data_server wajib diisi (default tenant 1 sudah dihapus)');
  return n;
}

/**
 * Label + logo tenant untuk UI dan dokumen cetak. `nama_tampilan` (setting_app)
 * dipakai bila ISP mengisinya; kalau belum, nama_server yang tampil — jadi
 * branding selalu ada walau tenant baru belum menata rumahnya.
 */
async function merek(id) {
  const n = idTenant(id);
  const srv = await getServer(n);
  const app = await require('./configApp').peta(n);
  const nama = String(app.nama_tampilan || '').trim() || srv.nama_server || 'ivvibill';
  return { nama, logo: srv.logo || null, prefix: srv.prefix_invoice || 'IVV' };
}

/** Nomor invoice unik per tenant: <PREFIX>-YYYYMM-XXXXX */
async function nomorInvoice(idServer) {
  const srv = await getServer(idServer);
  const prefix = (srv.prefix_invoice || 'IVV').replace(/-+$/, '');
  const ym = new Date().toISOString().slice(0, 7).replace('-', '');
  for (let i = 0; i < 20; i++) {
    const rand = Math.floor(10000 + Math.random() * 90000);
    const n = `${prefix}-${ym}-${rand}`;
    const dup = await db.one('SELECT id FROM tagihan WHERE nomor_invoice = ?', [n]);
    if (!dup) return n;
  }
  throw new Error('Gagal membuat nomor invoice');
}

module.exports = {
  getServer, invalidate, daftarServer, nomorInvoice,
  habisMasa, FILTER_BERLANGGANAN, idTenant, merek
};
