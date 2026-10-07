'use strict';
// ============================================================
// Migrasi kolasi — seragamkan collation seluruh tabel ke
// utf8mb4_unicode_ci (kolom & indeks ikut lewat CONVERT TO).
//
// Latar: tabel yang dibuat sebelum schema.sql menetapkan
// COLLATE memakai collation bawaan MySQL 8 (utf8mb4_0900_ai_ci).
// Perbandingan kolom string lintas collation (mis. redaman_log.sn
// vs master_onu.sn, keduanya IMPLICIT) lalu gagal dengan
// ER_CANT_AGGREGATE_2COLLATIONS dan menjatuhkan menu Pelanggan.
//
// Idempoten: hanya menyentuh tabel yang collation-nya berbeda.
// Pemakaian: node scripts/migrate-collation.js [--dry-run]
// ============================================================
const mysql = require('mysql2/promise');
require('../src/config');

const DRY = process.argv.includes('--dry-run');
const TUJUAN = 'utf8mb4_unicode_ci';

(async () => {
  const cfg = require('../src/config');
  const conn = await mysql.createConnection({
    host: cfg.db.host, port: cfg.db.port,
    user: cfg.db.user, password: cfg.db.password,
    database: cfg.db.database,
    charset: 'utf8mb4_unicode_ci'
  });

  // 0) default database -> supaya CREATE TABLE mendatang tanpa COLLATE
  //    eksplisit ikut utf8mb4_unicode_ci, bukan bawaan MySQL 8
  const [sch] = await conn.query(
    `SELECT DEFAULT_CHARACTER_SET_NAME AS cs, DEFAULT_COLLATION_NAME AS c
       FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = ?`,
    [cfg.db.database]
  );
  if (sch.length && sch[0].c !== TUJUAN) {
    console.log(`${DRY ? '[DRY] ' : ''}database ${cfg.db.database}: ${sch[0].c} -> ${TUJUAN}`);
    if (!DRY) {
      await conn.query(
        `ALTER DATABASE \`${cfg.db.database}\` CHARACTER SET utf8mb4 COLLATE ${TUJUAN}`
      );
    }
  }

  const [tabel] = await conn.query(
    `SELECT TABLE_NAME AS t, TABLE_COLLATION AS c
       FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = 'BASE TABLE'
        AND TABLE_COLLATION <> ?
      ORDER BY TABLE_NAME`,
    [cfg.db.database, TUJUAN]
  );

  if (!tabel.length) {
    console.log(`Migrasi kolasi: tidak ada perubahan — seluruh tabel sudah ${TUJUAN}.`);
    await conn.end();
    return;
  }

  for (const r of tabel) {
    const sql = `ALTER TABLE \`${r.t}\` CONVERT TO CHARACTER SET utf8mb4 COLLATE ${TUJUAN}`;
    console.log(`${DRY ? '[DRY] ' : ''}${r.t}: ${r.c} -> ${TUJUAN}`);
    if (!DRY) await conn.query(sql);
  }

  if (DRY) {
    console.log(`(dry-run) ${tabel.length} tabel TIDAK diubah.`);
  } else {
    // pastikan benar-benar seragam, bukan hanya melaporkan sukses
    const [sisa] = await conn.query(
      `SELECT COUNT(*) AS n FROM information_schema.TABLES
        WHERE TABLE_SCHEMA = ? AND TABLE_COLLATION <> ?`,
      [cfg.db.database, TUJUAN]
    );
    const n = Number(sisa[0].n);
    if (n > 0) throw new Error(`${n} tabel masih berbeda collation setelah konversi`);
    console.log(`Migrasi kolasi OK — ${tabel.length} tabel diseragamkan ke ${TUJUAN}.`);
  }
  await conn.end();
})().catch(e => {
  console.error('Migrasi kolasi GAGAL:', e.message);
  process.exitCode = 1;
});
