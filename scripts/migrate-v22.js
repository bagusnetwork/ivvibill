'use strict';
// ============================================================
// Migrasi v2.4.0 — gateway TriPay (QRIS)
//
// Menambah dukungan payment gateway TriPay di samping manual/midtrans/flip.
// TriPay memakai kunci publik (API key, dikirim sebagai Bearer) untuk autenti-
// kasi, private key untuk menandatangani transaksi DAN memverifikasi callback
// (X-Callback-Signature = HMAC-SHA256(raw body, private key)). Karena itu:
//   * pg_tripay_public   : API key (bukan rahasia besar — dipakai di header)
//   * pg_tripay_secret   : private key — dirahasiakan, disimpan TERENKRIPSI
//   * pg_tripay_merchant : merchant code (dipakai dalam string signature)
//   * pg_tripay_env      : production (/api) vs sandbox (/api-sandbox).
//     pelajaran dari bug Midtrans kemarin: environment adalah konfigurasi
//     EKSPLISIT, bukan ditebak dari bentuk kunci. Default 'production'.
//
// Selain itu kolom pembayaran.metode adalah ENUM; nilai 'treepay' harus
// ditambahkan ke daftar enum supaya baris pelunasan QRIS bisa disimpan
// (append nilai ENUM aman — tidak mengubah urutan/nilai yang ada).
//
// Idempoten: tiap langkah dicek ke information_schema sebelum ALTER.
// Pemakaian: node scripts/migrate-v22.js [--dry-run]
// ============================================================
const mysql = require('mysql2/promise');
require('../src/config');

const DRY = process.argv.includes('--dry-run');

const KOLOM = [
  ['pg_tripay_public', 'VARCHAR(255) DEFAULT NULL AFTER pg_flip_public_key'],
  ['pg_tripay_secret', 'TEXT AFTER pg_tripay_public'],
  ['pg_tripay_merchant', 'VARCHAR(60) DEFAULT NULL AFTER pg_tripay_secret'],
  ['pg_tripay_env', "VARCHAR(12) NOT NULL DEFAULT 'production' AFTER pg_tripay_merchant"]
];

(async () => {
  const cfg = require('../src/config');
  const conn = await mysql.createConnection({
    host: cfg.db.host, port: cfg.db.port,
    user: cfg.db.user, password: cfg.db.password,
    database: cfg.db.database
  });
  const dbn = cfg.db.database;

  for (const [nama, def] of KOLOM) {
    const [ada] = await conn.query(
      `SELECT COUNT(*) AS n FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'data_server' AND COLUMN_NAME = ?`,
      [dbn, nama]);
    if (Number(ada[0].n) > 0) { console.log(`v22: kolom data_server.${nama} sudah ada — lewati.`); continue; }
    const sql = `ALTER TABLE data_server ADD COLUMN ${nama} ${def}`;
    if (DRY) { console.log('[DRY] ' + sql); continue; }
    await conn.query(sql);
    console.log(`OK — data_server.${nama} ditambahkan.`);
  }

  // Perluas ENUM pembayaran.metode bila 'treepay' belum ada.
  const [col] = await conn.query(
    `SELECT COLUMN_TYPE AS ct FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'pembayaran' AND COLUMN_NAME = 'metode'`, [dbn]);
  const ct = String((col[0] && col[0].ct) || '');
  if (!/treepay/i.test(ct)) {
    const sql = "ALTER TABLE pembayaran MODIFY metode ENUM('manual','midtrans','flip','saldo_agen','treepay') NOT NULL DEFAULT 'manual'";
    if (DRY) { console.log('[DRY] ' + sql); }
    else { await conn.query(sql); console.log("OK — pembayaran.metode diperluas dengan 'treepay'."); }
  } else {
    console.log("v22: pembayaran.metode sudah mengenal 'treepay' — lewati.");
  }

  if (DRY) { console.log('(dry-run) tidak ada yang ditulis ke database.'); await conn.end(); return; }

  const [n] = await conn.query(
    `SELECT COUNT(*) AS n FROM data_server WHERE pg_active = 'treepay'`);
  console.log(`Catatan: ${Number(n[0].n)} tenant memakai TriPay; semuanya default 'production' sampai dipilih ulang.`);
  await conn.end();
})().catch(e => { console.error('Migrasi v22 GAGAL:', e.message); process.exit(1); });
