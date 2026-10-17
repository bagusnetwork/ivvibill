'use strict';
// ============================================================
// Keuangan — kas masuk/keluar & laporan (meniru gratisinaja:
// kas.php, pemasukan.php, pengeluaran.php). Pemasukan tagihan
// lunas tercatat otomatis oleh billing.lunaskanTagihan().
//
// v2.8.0:
//  - daftar kas menampilkan PELANGGAN dan NOMOR INVOICE untuk baris yang
//    lahir dari pelunasan tagihan. Sebelumnya cuma tertulis "Invoice xxx"
//    di kolom keterangan — tidak bisa dicari per orang, dan tidak ada
//    nomor urutnya;
//  - RETUR pembayaran TIDAK dihitung lagi sebagai PENGELUARAN. Retur itu
//    pembatalan catatan pembayaran (uangnya bisa saja memang belum pernah
//    masuk), bukan uang yang keluar dari kas. Kalau dihitung, laporan
//    bulanan ISP yang kebetulan mengoreksi salah catat terlihat merugi.
//    Baris lamanya tetap ditampilkan — hanya angka ringkasnya yang
//    memisahkan diri;
//  - export Excel / CSV / PDF dengan saringan yang sama dengan daftar.
// ============================================================
const express = require('express');
const db = require('../db');
const v = require('../util/validate');
const { requireAuth, requireRole, requirePJ } = require('../middleware/auth');
const { tenantSql, tenantAktif, requireMenu } = require('../util/scope');
const laporan = require('../services/laporan');

const router = express.Router();
router.use(requireAuth);

const KATEGORI = ['pembayaran', 'retur_pembayaran', 'topup', 'gaji', 'perbaikan', 'listrik', 'internet', 'sewa', 'lainnya'];

/**
 * Kategori 'keluar' yang tidak dihitung sebagai pengeluaran kas.
 * Nilainya konstanta kode (bukan input siapa pun) jadi boleh ditulis langsung
 * ke SQL — jauh lebih aman daripada parameter yang urutannya mudah tertukar
 * di query yang punya SELECT + WHERE sekaligus.
 */
const BUKAN_PENGELUARAN = ['retur_pembayaran'];
const DAFTAR_KATEGORI = BUKAN_PENGELUARAN.map(k => `'${k}'`).join(',');
const KELUAR_ASLI = `k.tipe = 'keluar' AND k.kategori NOT IN (${DAFTAR_KATEGORI})`;
const KAS_RETUR = `k.kategori IN (${DAFTAR_KATEGORI})`;

function filterRange(req, alias = 'k') {
  const dari = v.tgl(req.query.dari, null);
  const sampai = v.tgl(req.query.sampai, null);
  const where = [], params = [];
  if (dari) { where.push(`${alias}.created_at >= ?`); params.push(`${dari} 00:00:00`); }
  if (sampai) { where.push(`${alias}.created_at <= ?`); params.push(`${sampai} 23:59:59`); }
  return { where, params, dari, sampai };
}

/**
 * FROM + JOIN bersama. id_ref pada baris pembayaran/retur menunjuk ke tagihan;
 * kategori lain (dan entri buatan tangan) tidak punya induk, jadi JOIN-nya
 * disyaratkan pada kategori DAN tenant yang sama — nomor tagihan milik tenant
 * lain tidak boleh menempel ke kas tenant ini.
 *
 * Catatan: routes/invoice.js juga menulis kategori 'pembayaran' tapi id_refnya
 * adalah id tabel invoice, bukan tagihan. Tabel invoice produksi masih kosong
 * (0 baris, 2026-10-16) jadi tidak ada nama yang tertukar hari ini; syarat
 * kategori + tenant di bawah menjaga kalau suatu saat menu itu dipakai.
 */
const DARI_KAS = `
  FROM kas k
  LEFT JOIN app_user u ON u.id = k.dibuat_oleh
  LEFT JOIN tagihan t ON t.id = k.id_ref AND t.id_data_server = k.id_data_server
                     AND k.kategori IN ('pembayaran','retur_pembayaran')
  LEFT JOIN pelanggan p ON p.id = t.id_pelanggan`;

const ISI_KAS = `
  SELECT k.id, k.created_at, k.tipe, k.kategori, k.jumlah, k.keterangan, k.id_ref,
         k.dibuat_oleh, u.nama AS nama_user, t.nomor_invoice, p.nama AS nama_pelanggan`;

/** Baris WHERE + params untuk daftar, ringkas, dan export (pakai alias k). */
function syaratKas(req) {
  const ts = tenantSql(req, 'k.id_data_server');
  const r = filterRange(req);
  const where = [`1=1${ts.sql}`, ...r.where];
  const params = [...ts.params, ...r.params];
  const tipe = v.enumOf(req.query.tipe, ['masuk', 'keluar'], null);
  if (tipe) { where.push('k.tipe = ?'); params.push(tipe); }
  const cari = v.str(req.query.q, { max: 100, def: '' });
  if (cari) {
    where.push('(k.keterangan LIKE ? OR k.kategori LIKE ? OR p.nama LIKE ? OR t.nomor_invoice LIKE ?)');
    params.push(`%${cari}%`, `%${cari}%`, `%${cari}%`, `%${cari}%`);
  }
  return { where: where.join(' AND '), params, dari: r.dari, sampai: r.sampai };
}

/**
 * Ringkasan: masuk, keluar (tanpa retur), retur itu sendiri, dan saldo.
 * Saldo = masuk - keluar; retur TIDAK menguranginya (itu bukan uang keluar).
 */
async function ringkasKas(where, params) {
  const [r] = await db.q(
    `SELECT
       COALESCE(SUM(CASE WHEN k.tipe='masuk' THEN k.jumlah END),0)  AS total_masuk,
       COALESCE(SUM(CASE WHEN ${KELUAR_ASLI} THEN k.jumlah END),0)  AS total_keluar,
       COALESCE(SUM(CASE WHEN ${KAS_RETUR} THEN k.jumlah END),0)    AS total_retur,
       COUNT(CASE WHEN k.tipe='masuk' THEN 1 END)                   AS n_masuk,
       COUNT(CASE WHEN ${KELUAR_ASLI} THEN 1 END)                   AS n_keluar,
       COUNT(CASE WHEN ${KAS_RETUR} THEN 1 END)                     AS n_retur,
       COUNT(*) AS n
     ${DARI_KAS} WHERE ${where}`, params);
  return {
    total_masuk: Number(r.total_masuk),
    total_keluar: Number(r.total_keluar),
    total_retur: Number(r.total_retur),
    saldo: Number(r.total_masuk) - Number(r.total_keluar),
    n_masuk: Number(r.n_masuk), n_keluar: Number(r.n_keluar),
    n_retur: Number(r.n_retur), n: Number(r.n)
  };
}

// ------------------------------------------------------ daftar kas
router.get('/keuangan/kas', requireRole('superadmin', 'master', 'teknisi'), async (req, res, next) => {
  try {
    const s = syaratKas(req);
    const rows = await db.q(
      `${ISI_KAS} ${DARI_KAS} WHERE ${s.where}
       ORDER BY k.id DESC LIMIT 200`, s.params);
    res.json({ data: rows, ringkas: await ringkasKas(s.where, s.params) });
  } catch (e) { next(e); }
});

// ------------------------------------------------------ export kas
/**
 * Kolom laporan kas — satu definisi untuk Excel, CSV, dan PDF. Nomor urut
 * diambil dari posisi baris (kolom pertama), jadi penomoran di berkas sama
 * dengan yang di layar selama saringannya sama.
 */
const KOLOM_KAS = [
  { label: 'No.', nilai: (b, i) => i + 1, tipe: 'num', rp: false, w: 6 },
  { label: 'Waktu', k: 'created_at', tipe: 'waktu', w: 17 },
  { label: 'Tipe', k: 'tipe', w: 9 },
  { label: 'Kategori', k: 'kategori', w: 18 },
  { label: 'Jumlah', k: 'jumlah', tipe: 'num', tebal: true, w: 16 },
  { label: 'Pelanggan', k: 'nama_pelanggan', w: 28 },
  { label: 'Nomor Invoice', k: 'nomor_invoice', w: 20 },
  { label: 'Keterangan', k: 'keterangan', w: 42 },
  { label: 'Dicatat oleh', k: 'nama_user', w: 18 }
];

router.get('/keuangan/kas/export', requireRole('superadmin', 'master', 'teknisi'), async (req, res, next) => {
  try {
    const format = v.enumOf(req.query.format, ['xlsx', 'csv', 'pdf'], 'xlsx');
    const s = syaratKas(req);
    const baris = await db.q(
      `${ISI_KAS} ${DARI_KAS} WHERE ${s.where}
       ORDER BY k.id DESC LIMIT 20000`, s.params);
    const r = await ringkasKas(s.where, s.params);
    const nama = `kas-${s.dari || 'dari-awal'}-sd-${s.sampai || 'sekarang'}`;
    let namaServer = null;
    const dsAktif = Number(req.ds);
    if (Number.isInteger(dsAktif) && dsAktif >= 1) {
      const srv = await db.one('SELECT nama_server FROM data_server WHERE id = ?', [dsAktif]);
      namaServer = (srv && srv.nama_server) || null;
    }
    const subjudul = `Rentang ${s.dari || 'awal'} s/d ${s.sampai || 'hari ini'}`
      + (v.enumOf(req.query.tipe, ['masuk', 'keluar'], null) ? ` · tipe ${req.query.tipe}` : '')
      + (v.str(req.query.q, { max: 100, def: '' }) ? ` · pencarian "${req.query.q}"` : '');
    const ringkas = [
      { label: 'Jumlah baris', nilai: String(baris.length) },
      { label: 'Kas masuk', nilai: laporan.RUR_UTUH(r.total_masuk) },
      { label: 'Pengeluaran', nilai: laporan.RUR_UTUH(r.total_keluar) },
      { label: 'Saldo', nilai: laporan.RUR_UTUH(r.saldo) }
    ];
    const catatan = [
      'Retur pembayaran tidak dihitung sebagai pengeluaran dan tidak mengurangi saldo:',
      'retur hanya membatalkan catatan pembayaran di menu Tagihan, bukan uang yang keluar dari kas.',
      `Baris retur pada periode ini ${r.total_retur ? laporan.RUR_UTUH(r.total_retur) : 'tidak ada'} — tetap ditampilkan sebagai jejak.`
    ];

    if (format === 'pdf') {
      return laporan.unduhPdf(res, {
        nama, kop: { server: namaServer || 'ivvibill', zona: 'waktu server' },
        judul: 'Laporan Kas', subjudul, kolom: KOLOM_KAS, baris, ringkas, catatan
      });
    }
    if (format === 'csv') return laporan.unduhCsv(res, { nama, kolom: KOLOM_KAS, baris });
    return laporan.unduhXlsx(res, { nama, lembar: [{ nama: 'Kas', kolom: KOLOM_KAS, baris }] });
  } catch (e) { next(e); }
});

// ------------------------------------------------------ laporan
router.get('/keuangan/laporan', requirePJ(), async (req, res, next) => {
  try {
    const s = syaratKas(req);
    const r = await ringkasKas(s.where, s.params);
    const perKategori = await db.q(
      `SELECT k.tipe, k.kategori, COUNT(*) AS n, SUM(k.jumlah) AS total
       ${DARI_KAS} WHERE ${s.where}
       GROUP BY k.tipe, k.kategori ORDER BY k.tipe, total DESC`, s.params);
    res.json({
      dari: s.dari, sampai: s.sampai,
      total_masuk: r.total_masuk, total_keluar: r.total_keluar,
      total_retur: r.total_retur, n_retur: r.n_retur,
      saldo: r.saldo,
      n_masuk: r.n_masuk, n_keluar: r.n_keluar,
      per_kategori: perKategori,
      // Dijelaskan di UI supaya operator tidak mengira angkanya keliru.
      catatan: 'Retur pembayaran tidak dihitung sebagai pengeluaran.'
    });
  } catch (e) { next(e); }
});

router.get('/keuangan/kategori', (req, res) => res.json({ data: KATEGORI }));

// ------------------------------------------------------ tulis kas
router.post('/keuangan/kas', requirePJ(), requireMenu('keuangan', 'tambah'), async (req, res, next) => {
  try {
    const ds = tenantAktif(req);
    const tipe = v.enumOf(req.body.tipe, ['masuk', 'keluar']);
    const kategori = v.str(req.body.kategori, { min: 2, max: 40, def: 'umum' });
    const jumlah = v.num(req.body.jumlah, { min: 0.01, max: 1e12 });
    const keterangan = v.str(req.body.keterangan, { max: 255, def: null });
    const id = await db.insert(
      `INSERT INTO kas (id_data_server, tipe, kategori, jumlah, keterangan, dibuat_oleh)
       VALUES (?,?,?,?,?,?)`, [ds, tipe, kategori, jumlah, keterangan, req.user.id]);
    await db.insert('INSERT INTO audit_log (user_id, id_data_server, aksi, detail, ip) VALUES (?,?,?,?,?)',
      [req.user.id, ds, `kas_${tipe}`, `${kategori} Rp ${jumlah}`, (req.ip || '').replace('::ffff:', '')]);
    res.json({ id });
  } catch (e) { next(e); }
});

router.delete('/keuangan/kas/:id', requirePJ(), requireMenu('keuangan', 'hapus'), async (req, res, next) => {
  try {
    const id = v.num(req.params.id, { int: true, min: 1 });
    const ts = tenantSql(req, 'id_data_server');
    const k = await db.one(`SELECT * FROM kas WHERE id = ?${ts.sql}`, [id, ...ts.params]);
    if (!k) return res.status(404).json({ error: 'Entri kas tidak ada' });
    // Entri yang lahir dari pelunasan/retur tagihan adalah cermin catatan
    // pembayaran — menghapusnya dari halaman kas membuat kas dan tagihan
    // tidak lagi cocok. Baliknya dilakukan lewat tombol Retur di menu Tagihan.
    if (['pembayaran', 'retur_pembayaran'].includes(k.kategori) && k.id_ref) {
      return res.status(400).json({ error: 'Entri dari pembayaran/retur tagihan tidak bisa dihapus manual' });
    }
    await db.run('DELETE FROM kas WHERE id = ?', [id]);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

module.exports = router;
