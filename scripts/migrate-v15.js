'use strict';
// ============================================================
// Migrasi v1.5 —
//  1) absensi teknisi berkoordinat (tabel absen_teknisi)
//  2) alasan penolakan login (login_attempt.alasan) supaya admin panel bisa
//     melihat MENGAPA akun role ditolak tanpa membocorkannya ke pemohon
// Idempoten: cek information_schema sebelum ALTER/CREATE.
// Pemakaian: node scripts/migrate-v15.js [--dry-run]
// ============================================================
const mysql = require('mysql2/promise');
require('../src/config');

const DRY = process.argv.includes('--dry-run');
const rencana = [];

function catat(aksi, sql) { rencana.push({ aksi, sql }); }

(async () => {
  const cfg = require('../src/config');
  const conn = await mysql.createConnection({
    host: cfg.db.host, port: cfg.db.port,
    user: cfg.db.user, password: cfg.db.password,
    database: cfg.db.database
  });

  const adaTabel = async (t) => {
    const [r] = await conn.query(
      'SELECT COUNT(*) AS n FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?',
      [cfg.db.database, t]);
    return Number(r[0].n) > 0;
  };
  const adaKolom = async (t, k) => {
    const [r] = await conn.query(
      'SELECT COUNT(*) AS n FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND COLUMN_NAME = ?',
      [cfg.db.database, t, k]);
    return Number(r[0].n) > 0;
  };

  // 1. satu baris per teknisi per hari: masuk dan pulang melengkapi baris yang
  //    sama, jadi rekap harian tidak perlu menjumlah banyak baris.
  if (!(await adaTabel('absen_teknisi'))) {
    catat('CREATE absen_teknisi', `CREATE TABLE absen_teknisi (
      id            INT NOT NULL AUTO_INCREMENT,
      id_data_server INT NOT NULL,
      id_teknisi    INT NOT NULL,
      nama_teknisi  VARCHAR(100) NOT NULL,
      tanggal       DATE NOT NULL,
      jam_masuk     DATETIME DEFAULT NULL,
      jam_pulang    DATETIME DEFAULT NULL,
      lat_masuk     DECIMAL(10,7) DEFAULT NULL,
      long_masuk    DECIMAL(10,7) DEFAULT NULL,
      lat_pulang    DECIMAL(10,7) DEFAULT NULL,
      long_pulang   DECIMAL(10,7) DEFAULT NULL,
      akurasi_masuk INT DEFAULT NULL,
      akurasi_pulang INT DEFAULT NULL,
      jarak_meter   INT DEFAULT NULL,
      catatan       VARCHAR(255) DEFAULT NULL,
      created_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY uq_absen_hari (id_teknisi, tanggal),
      KEY idx_absen_tanggal (id_data_server, tanggal)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
  }

  // 2. alasan penolakan login
  if (!(await adaKolom('login_attempt', 'alasan'))) {
    catat('ALTER login_attempt +alasan',
      'ALTER TABLE login_attempt ADD COLUMN alasan VARCHAR(30) DEFAULT NULL');
  }

  if (!rencana.length) {
    console.log('Migrasi v15: tidak ada perubahan — skema sudah terbaru.');
  } else {
    for (const r of rencana) console.log((DRY ? '[DRY] ' : '') + r.aksi + ' → ' + r.sql.replace(/\s+/g, ' ').slice(0, 120));
    if (!DRY) {
      for (const r of rencana) await conn.query(r.sql);
      console.log(`Migrasi v15 OK — ${rencana.length} perubahan diterapkan.`);
    } else {
      console.log(`(dry-run) ${rencana.length} perubahan TIDAK diterapkan.`);
    }
  }
  await conn.end();
})().catch(e => { console.error('Migrasi v15 GAGAL:', e.message); process.exitCode = 1; });
