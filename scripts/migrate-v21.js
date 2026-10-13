'use strict';
// ============================================================
// Migrasi v2.3.1 — kolom data_server.pg_midtrans_env
//
// Akar masalah: aplikasi memilih endpoint Midtrans HANYA dari awalan kunci
// ('SB-' = sandbox, selain itu = production). Dashboard Midtrans model baru
// (dashboard.sandbox.midtrans.com → Settings → Access Keys) menampilkan kunci
// sandbox TANPA awalan 'SB-' (contoh: 'Mid-server-…', bukan 'SB-Mid-server-…').
// Kunci sandbox seperti itu lolos sebagai "production" di pembersih awalan,
// dikirim ke https://app.midtrans.com, dan selalu dibalas
// '401 Access denied due to unauthorized transaction' — padahal kunci yang sama
// ke endpoint sandbox menjawab 201.
//
// Karena itu environment dijadikan konfigurasi EKSPLISIT per tenant. Nilai
// 'production' sebagai bawaan supaya ISP yang sudah live tidak berubah
// perilakunya. Deteksi awalan 'SB-' tetap dihormati (lihat basisMidtrans)
// sebagai kompatibilitas mundur.
//
// Idempoten: cek information_schema sebelum ALTER.
// Pemakaian: node scripts/migrate-v21.js [--dry-run]
// ============================================================
const mysql = require('mysql2/promise');
require('../src/config');

const DRY = process.argv.includes('--dry-run');

(async () => {
  const cfg = require('../src/config');
  const conn = await mysql.createConnection({
    host: cfg.db.host, port: cfg.db.port,
    user: cfg.db.user, password: cfg.db.password,
    database: cfg.db.database
  });

  const [ada] = await conn.query(
    `SELECT COUNT(*) AS n FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'data_server' AND COLUMN_NAME = 'pg_midtrans_env'`,
    [cfg.db.database]);

  if (Number(ada[0].n) > 0) {
    console.log('Migrasi v21: kolom data_server.pg_midtrans_env sudah ada — tidak ada yang diubah.');
    await conn.end();
    return;
  }

  const sql = "ALTER TABLE data_server ADD COLUMN pg_midtrans_env VARCHAR(12) NOT NULL DEFAULT 'production' COMMENT 'endpoint Midtrans: production|sandbox' AFTER pg_midtrans_client_key";
  if (DRY) {
    console.log('[DRY] ' + sql);
    console.log('(dry-run) tidak ada yang ditulis ke database.');
    await conn.end();
    return;
  }
  await conn.query(sql);
  console.log("OK — data_server.pg_midtrans_env (VARCHAR 12, default 'production') ditambahkan.");

  // Tidak ada backfill berbasis awalan kunci di sini: pg_midtrans_server_key
  // disimpan TERENKRIPSI, jadi 'SB-%' tidak akan pernah cocok dengan ciphertext.
  // Kompatibilitas mundur untuk kunci berawalan 'SB-' ditangani saat runtime oleh
  // basisMidtrans() (setelah decrypt). Tenant sandbox dipilih eksplisit lewat
  // dropdown environment di panel.
  const [n] = await conn.query(
    `SELECT COUNT(*) AS n FROM data_server WHERE pg_active = 'midtrans'`);
  console.log(`Catatan: ${Number(n[0].n)} tenant memakai Midtrans; semuanya default 'production' sampai dipilih ulang.`);
  await conn.end();
})().catch(e => { console.error('Migrasi v21 GAGAL:', e.message); process.exit(1); });
