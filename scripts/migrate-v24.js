'use strict';
// ============================================================
// Migrasi v2.6.0 — rekening tujuan di pembayaran + tempat buang tagihan
//
// Dua hal yang diminta panel Tagihan versi ini:
//
//  1. "ketika klik bayar ada pilihan transfer ke rekening". pembayaran
//     sebelumnya hanya menyimpan `bukti` (gambar) dan `keterangan` (teks bebas),
//     jadi tidak ada kolom yang bisa dikelompokkan per rekening tujuan pada
//     laporan. Ditambahkan `id_rekening` (acruan ke tabel rekening) DAN
//     `rekening_tujuan` (snapshot "BANK / 12345 / a/n X"). Snapshot sengaja
//     dipakai bersama id: rekening bisa dinonaktifkan/diubah formasinya nanti,
//     laporan tagihan lama harus tetap menunjukkan rekening yang benar-benar
//     dipakai saat uang masuk, bukan bentuk rekening hari ini.
//
//  2. "tombol delete data tagihan". Baris tagihan yang dihapus keras tidak bisa
//     ditebak isinya kembali, dan tabel ini adalah catatan keuangan ISP yang
//     berlangganan aplikasi. Karena itu DELETE di rute hapus-semua selalu
//     mendahului salinan barisnya ke tabel backup berformat JSON (satu batch per
//     aksi, lengkap dengan siapa & kapan). Backup disimpan sebagai JSON supaya
//     tetap terbaca walaupun struktur tagihan berubah di versi berikutnya.
//     Pemulihan dilakukan manual dari tabel ini (SELECT baris JSON-nya), bukan
//     tombol — yang penting datanya tidak hilang diam-diam.
//
// Idempoten: kolom & tabel dicek ke information_schema lebih dulu.
//
// Pemakaian: node scripts/migrate-v24.js [--dry-run]
// ============================================================
const mysql = require('mysql2/promise');
require('../src/config');

const DRY = process.argv.includes('--dry-run');

const KOLOM_PEMBAYARAN = [
  ['id_rekening', "INT DEFAULT NULL AFTER verified_by"],
  ['rekening_tujuan', "VARCHAR(150) DEFAULT NULL AFTER id_rekening"]
];

const TABEL_BACKUP = [
  ['tagihan_hapus_backup', `CREATE TABLE tagihan_hapus_backup (
      id INT AUTO_INCREMENT PRIMARY KEY,
      id_data_server INT NOT NULL,
      batch VARCHAR(40) NOT NULL,
      deleted_by INT DEFAULT NULL,
      deleted_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      baris JSON NOT NULL,
      KEY idx_ds (id_data_server),
      KEY idx_batch (batch)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`],
  ['pembayaran_hapus_backup', `CREATE TABLE pembayaran_hapus_backup (
      id INT AUTO_INCREMENT PRIMARY KEY,
      id_data_server INT NOT NULL,
      batch VARCHAR(40) NOT NULL,
      deleted_by INT DEFAULT NULL,
      deleted_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      baris JSON NOT NULL,
      KEY idx_ds (id_data_server),
      KEY idx_batch (batch)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`]
];

(async () => {
  const cfg = require('../src/config');
  const conn = await mysql.createConnection({
    host: cfg.db.host, port: cfg.db.port,
    user: cfg.db.user, password: cfg.db.password,
    database: cfg.db.database
  });
  const dbn = cfg.db.database;

  for (const [nama, def] of KOLOM_PEMBAYARAN) {
    const [ada] = await conn.query(
      `SELECT COUNT(*) AS n FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'pembayaran' AND COLUMN_NAME = ?`,
      [dbn, nama]);
    if (Number(ada[0].n) > 0) { console.log(`v24: kolom pembayaran.${nama} sudah ada — lewati.`); continue; }
    const sql = `ALTER TABLE pembayaran ADD COLUMN ${nama} ${def}`;
    if (DRY) { console.log('[DRY] ' + sql); continue; }
    await conn.query(sql);
    console.log(`OK — pembayaran.${nama} ditambahkan.`);
  }

  for (const [nama, ddl] of TABEL_BACKUP) {
    const [ada] = await conn.query(
      `SELECT COUNT(*) AS n FROM information_schema.TABLES
        WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?`, [dbn, nama]);
    if (Number(ada[0].n) > 0) { console.log(`v24: tabel ${nama} sudah ada — lewati.`); continue; }
    if (DRY) { console.log(`[DRY] CREATE TABLE ${nama} ...`); continue; }
    await conn.query(ddl);
    console.log(`OK — tabel ${nama} dibuat.`);
  }

  if (DRY) { console.log('(dry-run) tidak ada yang ditulis ke database.'); await conn.end(); return; }
  console.log('Migrasi v24 selesai.');
  await conn.end();
})().catch(e => { console.error('Migrasi v24 GAGAL:', e.message); process.exit(1); });
