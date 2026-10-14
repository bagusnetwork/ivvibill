'use strict';
// ============================================================
// Migrasi v2.4.2 — redaman terakhir ikut tersimpan di master_onu
//
// Tabel ONU di panel (menu OLT dan aplikasi teknisi) menampilkan kolom
// `redaman_db`, tetapi kolom itu TIDAK PERNAH ada di master_onu dan rute
// GET /api/olt/onu hanya melakukan `SELECT o.*`. Akibatnya bahkan setelah
// polling berhasil pun kolom Redaman tetap '-' — persis gejala "redaman
// belum terbaca".
//
// Kenapa tidak JOIN ke redaman_log saja? Karena lognya ditulis per polling
// (satu OLT 99 ONU / 5 menit ≈ 28 ribu baris/hari) dan tabel itu hanya punya
// index (id_perangkat, cek_at). Subquery "MAX(id) per (perangkat, sn)" akan
// memindai seluruh baris perangkat itu untuk SETIAP baris daftar. Nilai
// redaman terbaru memang sudah menjadi atribut ONU — sama seperti rx_dbm yang
// lebih dulu disimpan di sini — jadi kolom langsung adalah bentuk yang benar.
//
// Idempoten: kolom dicek ke information_schema dulu; backfill hanya untuk baris
// yang masih NULL supaya pembacaan terbaru tidak tertimpa data lama.
//
// Pemakaian: node scripts/migrate-v23.js [--dry-run]
// ============================================================
const mysql = require('mysql2/promise');
require('../src/config');

const DRY = process.argv.includes('--dry-run');

const KOLOM = [
  ['redaman_db', 'DECIMAL(6,2) DEFAULT NULL AFTER tx_dbm'],
  ['status_redaman', "VARCHAR(10) DEFAULT NULL AFTER redaman_db"]   // ok|warning|kritis
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
        WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'master_onu' AND COLUMN_NAME = ?`,
      [dbn, nama]);
    if (Number(ada[0].n) > 0) { console.log(`v23: kolom master_onu.${nama} sudah ada — lewati.`); continue; }
    const sql = `ALTER TABLE master_onu ADD COLUMN ${nama} ${def}`;
    if (DRY) { console.log('[DRY] ' + sql); continue; }
    await conn.query(sql);
    console.log(`OK — master_onu.${nama} ditambahkan.`);
  }

  if (DRY) { console.log('(dry-run) tidak ada yang ditulis ke database.'); await conn.end(); return; }

  // Backfill: pembacaan terakhir per (perangkat, sn) dari redaman_log.
  const [isi] = await conn.query(
    `UPDATE master_onu o
       JOIN redaman_log r ON r.id = (
         SELECT MAX(r2.id) FROM redaman_log r2
          WHERE r2.id_perangkat = o.id_perangkat AND r2.sn = o.sn)
        SET o.redaman_db = r.redaman_db, o.status_redaman = r.status
      WHERE o.redaman_db IS NULL`);
  console.log(`Backfill redaman: ${Number(isi.affectedRows || 0)} baris master_onu terisi dari redaman_log.`);

  const [sisa] = await conn.query(
    `SELECT COUNT(*) AS n FROM master_onu WHERE redaman_db IS NULL`);
  console.log(`Catatan: ${Number(sisa[0].n)} baris ONU masih tanpa redaman ` +
    `(belum pernah ada pembacaan RX — polling berikutnya akan mengisi).`);
  await conn.end();
})().catch(e => { console.error('Migrasi v23 GAGAL:', e.message); process.exit(1); });
