'use strict';
// ============================================================
// Migrasi v1.2 — topologi/desa/kas + kolom pelanggan & mikrotik.
// Idempoten: cek information_schema sebelum ALTER/CREATE.
// Pemakaian: node scripts/migrate-v12.js [--dry-run]
// ============================================================
const mysql = require('mysql2/promise');
require('../src/config');

const DRY = process.argv.includes('--dry-run');
const rencana = [];   // { aksi, sql }

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
      'SELECT COUNT(*) AS n FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?', [cfg.db.database, t]);
    return Number(r[0].n) > 0;
  };
  const adaKolom = async (t, k) => {
    const [r] = await conn.query(
      'SELECT COUNT(*) AS n FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND COLUMN_NAME = ?',
      [cfg.db.database, t, k]);
    return Number(r[0].n) > 0;
  };

  // 1. Tabel baru
  if (!(await adaTabel('master_topologi'))) {
    catat('CREATE master_topologi', `CREATE TABLE master_topologi (
      id INT NOT NULL AUTO_INCREMENT, id_data_server INT NOT NULL DEFAULT 1,
      nama VARCHAR(100) NOT NULL, titik_koordinat VARCHAR(100) DEFAULT NULL,
      jumlah_port SMALLINT NOT NULL DEFAULT 16,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id), UNIQUE KEY uq_topologi_nama (id_data_server, nama)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
  }
  if (!(await adaTabel('master_desa'))) {
    catat('CREATE master_desa', `CREATE TABLE master_desa (
      id INT NOT NULL AUTO_INCREMENT, id_data_server INT NOT NULL DEFAULT 1,
      nama VARCHAR(100) NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id), UNIQUE KEY uq_desa_nama (id_data_server, nama)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
  }
  if (!(await adaTabel('kas'))) {
    catat('CREATE kas', `CREATE TABLE kas (
      id INT NOT NULL AUTO_INCREMENT, id_data_server INT NOT NULL DEFAULT 1,
      tipe ENUM('masuk','keluar') NOT NULL DEFAULT 'masuk',
      kategori VARCHAR(40) NOT NULL DEFAULT 'umum',
      jumlah DECIMAL(15,2) NOT NULL DEFAULT 0,
      keterangan VARCHAR(255) DEFAULT NULL,
      id_ref INT DEFAULT NULL, dibuat_oleh INT DEFAULT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id), KEY idx_kas_server (id_data_server, tipe, created_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
  }

  // 2. Kolom pelanggan
  const kolomPel = [
    ['id_master_topologi', 'INT DEFAULT NULL COMMENT \'ODP / topologi\''],
    ['id_master_desa', 'INT DEFAULT NULL COMMENT \'desa\''],
    ['port_odp', 'VARCHAR(20) DEFAULT NULL'],
    ['latitude', 'VARCHAR(30) DEFAULT NULL'],
    ['longitude', 'VARCHAR(30) DEFAULT NULL']
  ];
  for (const [nama, def] of kolomPel) {
    if (!(await adaKolom('pelanggan', nama))) catat(`ALTER pelanggan +${nama}`, `ALTER TABLE pelanggan ADD COLUMN ${nama} ${def}`);
  }
  if (!(await adaKolom('pelanggan', 'idx_pelanggan_topologi'))) {
    // index lewat nama kolom — skip bila sudah ada (information_schema.STATISTICS)
    const [r] = await conn.query(
      'SELECT COUNT(*) AS n FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND INDEX_NAME = ?',
      [cfg.db.database, 'pelanggan', 'idx_pelanggan_topologi']);
    if (!Number(r[0].n)) catat('ALTER pelanggan +idx_topologi', 'ALTER TABLE pelanggan ADD KEY idx_pelanggan_topologi (id_master_topologi)');
  }
  if (!(await adaKolom('pelanggan', 'idx_pelanggan_desa'))) {
    const [r] = await conn.query(
      'SELECT COUNT(*) AS n FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND INDEX_NAME = ?',
      [cfg.db.database, 'pelanggan', 'idx_pelanggan_desa']);
    if (!Number(r[0].n)) catat('ALTER pelanggan +idx_desa', 'ALTER TABLE pelanggan ADD KEY idx_pelanggan_desa (id_master_desa)');
  }

  // 3. Kolom setting_mikrotik (remote ONU)
  const kolomMt = [
    ['port_remote', 'SMALLINT DEFAULT NULL COMMENT \'dst-port NAT remote ONU\''],
    ['user_remote', 'VARCHAR(60) DEFAULT NULL'],
    ['last_remote', 'DATETIME DEFAULT NULL']
  ];
  for (const [nama, def] of kolomMt) {
    if (!(await adaKolom('setting_mikrotik', nama))) catat(`ALTER setting_mikrotik +${nama}`, `ALTER TABLE setting_mikrotik ADD COLUMN ${nama} ${def}`);
  }

  if (!rencana.length) {
    console.log('Migrasi v12: tidak ada perubahan — skema sudah terbaru.');
  } else {
    for (const r of rencana) console.log((DRY ? '[DRY] ' : '') + r.aksi + ' → ' + r.sql.replace(/\s+/g, ' ').slice(0, 120));
    if (!DRY) {
      for (const r of rencana) await conn.query(r.sql);
      console.log(`Migrasi v12 OK — ${rencana.length} perubahan diterapkan.`);
    } else {
      console.log(`(dry-run) ${rencana.length} perubahan TIDAK diterapkan.`);
    }
  }
  await conn.end();
})().catch(e => { console.error('Migrasi v12 GAGAL:', e.message); process.exitCode = 1; });
