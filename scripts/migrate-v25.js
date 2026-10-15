'use strict';
// ============================================================
// Migrasi v2.7.0 — return pembayaran
//
// "tambah fitur return pembayaran jika ada kesalahan pembayaran". Operator bisa
// salah catat: uang di-markah masuk padahal belum (salah nominal, pelanggan yang
// salah, transfer belum masuk). Tanpa jalur balik satu-satunya cara adalah
// menghapus baris pembayaran — dan itu memusnahkan jejak uang.
//
// Karena itu status pembayaran diperluas dengan 'retur' (BUKAN 'ditolak':
// 'ditolak' milik antrean verifikasi bukti, artinya "bukti tidak sah"), dan tiap
// baris retur menyimpan siapa + kapan + alasannya. Barisnya tetap ada supaya
// laporan keuangan bisa menunjukkan pemasukan dan pengembaliannya berdampingan.
//
// Idempoten: COLUMN_TYPE dan information_schema.COLUMNS dicek lebih dulu, jadi
// skrip ini aman dijalankan ulang.
//
// Pemakaian: node scripts/migrate-v25.js [--dry-run]
// ============================================================
const mysql = require('mysql2/promise');
require('../src/config');

const DRY = process.argv.includes('--dry-run');

const STATUS_BARU = "ENUM('menunggu','diterima','ditolak','retur') NOT NULL DEFAULT 'menunggu'";

const KOLOM = [
  ['retur_oleh', "INT DEFAULT NULL"],
  ['retur_at', "DATETIME DEFAULT NULL"],
  ['alasan_retur', "VARCHAR(255) DEFAULT NULL"]
];

(async () => {
  const cfg = require('../src/config');
  const conn = await mysql.createConnection({
    host: cfg.db.host, port: cfg.db.port,
    user: cfg.db.user, password: cfg.db.password,
    database: cfg.db.database
  });
  const dbn = cfg.db.database;

  // 1) status 'retur'
  const [kol] = await conn.query(
    `SELECT COLUMN_TYPE AS t FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'pembayaran' AND COLUMN_NAME = 'status'`,
    [dbn]);
  if (!kol.length) throw new Error('tabel pembayaran tidak ditemukan');
  if (/retur/.test(kol[0].t)) {
    console.log('v25: pembayaran.status sudah mengenal „retur” — lewati.');
  } else {
    const sql = `ALTER TABLE pembayaran MODIFY status ${STATUS_BARU}`;
    if (DRY) console.log('[DRY] ' + sql);
    else { await conn.query(sql); console.log('OK — pembayaran.status diperluas dengan „retur”.'); }
  }

  // 2) jejak retur
  for (const [nama, def] of KOLOM) {
    const [ada] = await conn.query(
      `SELECT COUNT(*) AS n FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'pembayaran' AND COLUMN_NAME = ?`,
      [dbn, nama]);
    if (Number(ada[0].n) > 0) { console.log(`v25: kolom pembayaran.${nama} sudah ada — lewati.`); continue; }
    const sql = `ALTER TABLE pembayaran ADD COLUMN ${nama} ${def}`;
    if (DRY) { console.log('[DRY] ' + sql); continue; }
    await conn.query(sql);
    console.log(`OK — pembayaran.${nama} ditambahkan.`);
  }

  if (DRY) { console.log('(dry-run) tidak ada yang ditulis ke database.'); await conn.end(); return; }
  console.log('Migrasi v25 selesai.');
  await conn.end();
})().catch(e => { console.error('Migrasi v25 GAGAL:', e.message); process.exit(1); });
