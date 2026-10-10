'use strict';
// ============================================================
// Migrasi v1.6 —
//  1) paket: satuan durasi (jam/hari) + nama profile hotspot di router,
//     supaya voucher 3 jam bisa diekspresikan dan user hotspot tahu
//     profile mana yang dipakai
//  2) voucher: status push ke MikroTik (belum/ok/gagal + pesan error)
//     supaya kegagalan pembuatan user hotspot terlihat dan bisa diulang
//  3) master_onu: unique (id_perangkat, sn) — tanpanya upsert polling
//     selalu INSERT, satu ONU jadi puluhan baris; + matched_at sebagai jejak
//     kapan baris itu terikat ke pelanggan
//  4) push sesi router: master_perangkat.token_push + tabel sesi_router,
//     dipakai script/schedule yang dipasang tombol Test perangkat
// Idempoten: cek information_schema sebelum ALTER/CREATE.
// Pemakaian: node scripts/migrate-v16.js [--dry-run]
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

  const adaKolom = async (t, k) => {
    const [r] = await conn.query(
      'SELECT COUNT(*) AS n FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND COLUMN_NAME = ?',
      [cfg.db.database, t, k]);
    return Number(r[0].n) > 0;
  };
  const adaIndex = async (t, i, unik = false) => {
    const [r] = await conn.query(
      'SELECT COUNT(*) AS n FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND INDEX_NAME = ?',
      [cfg.db.database, t, i]);
    if (!Number(r[0].n)) return false;
    if (!unik) return true;
    const [u] = await conn.query(
      'SELECT NON_UNIQUE FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND INDEX_NAME = ? LIMIT 1',
      [cfg.db.database, t, i]);
    return Number(u[0].NON_UNIQUE) === 0;
  };
  const jumlah = async (sql, args = []) => {
    const [r] = await conn.query(sql, args);
    return Number(r[0].n);
  };

  // 1. paket hotspot
  if (!(await adaKolom('paket', 'satuan'))) {
    catat('ALTER paket +satuan',
      "ALTER TABLE paket ADD COLUMN satuan ENUM('hari','jam') NOT NULL DEFAULT 'hari' AFTER masa_aktif");
  }
  if (!(await adaKolom('paket', 'profile_hotspot'))) {
    catat('ALTER paket +profile_hotspot',
      'ALTER TABLE paket ADD COLUMN profile_hotspot VARCHAR(64) DEFAULT NULL AFTER harga_agen');
  }

  // 2. status push voucher
  const kolomVoucher = {
    router_status: "ADD COLUMN router_status ENUM('belum','ok','gagal') NOT NULL DEFAULT 'belum' AFTER status",
    router_nama: 'ADD COLUMN router_nama VARCHAR(100) DEFAULT NULL AFTER router_status',
    router_error: 'ADD COLUMN router_error VARCHAR(255) DEFAULT NULL AFTER router_nama',
    pushed_at: 'ADD COLUMN pushed_at DATETIME DEFAULT NULL AFTER created_at'
  };
  for (const [k, d] of Object.entries(kolomVoucher)) {
    if (!(await adaKolom('voucher', k))) catat(`ALTER voucher +${k}`, `ALTER TABLE voucher ${d}`);
  }
  if (!(await adaIndex('voucher', 'idx_voucher_push'))) {
    catat('INDEX voucher +idx_voucher_push',
      'ALTER TABLE voucher ADD INDEX idx_voucher_push (router_status, expired_at)');
  }

  // 3. master_onu: satu baris per ONU per perangkat
  const dup = await jumlah(
    `SELECT COUNT(*) AS n FROM (
       SELECT id_perangkat, sn FROM master_onu
        WHERE sn IS NOT NULL AND sn <> ''
        GROUP BY id_perangkat, sn HAVING COUNT(*) > 1) d`);
  const totalDup = await jumlah(
    `SELECT COALESCE(SUM(c), 0) AS n FROM (
       SELECT COUNT(*) - 1 AS c FROM master_onu
        WHERE sn IS NOT NULL AND sn <> ''
        GROUP BY id_perangkat, sn HAVING COUNT(*) > 1) x`);
  if (dup) {
    console.log(`master_onu: ${totalDup} baris duplikat di ${dup} kelompok ONU akan dibuang, ` +
      `1 baris terbaru dipertahankan per ONU`);
    catat('DELETE duplikat master_onu',
      `DELETE o FROM master_onu o
        JOIN (SELECT id_perangkat AS p, sn AS s, MAX(id) AS keep_id FROM master_onu
               WHERE sn IS NOT NULL AND sn <> ''
               GROUP BY id_perangkat, sn HAVING COUNT(*) > 1) d
          ON d.p = o.id_perangkat AND d.s = o.sn AND o.id <> d.keep_id`);
  }
  if (!(await adaKolom('master_onu', 'matched_at'))) {
    catat('ALTER master_onu +matched_at',
      'ALTER TABLE master_onu ADD COLUMN matched_at DATETIME DEFAULT NULL AFTER match_by');
  }
  // sn string kosong akan bertabrakan satu sama lain di unique key
  if (await jumlah("SELECT COUNT(*) AS n FROM master_onu WHERE sn = ''")) {
    catat("UPDATE master_onu sn='' -> NULL", 'UPDATE master_onu SET sn = NULL WHERE sn = \'\'');
  }
  if (!(await adaIndex('master_onu', 'uq_onu_sn', true))) {
    const lama = await adaIndex('master_onu', 'idx_onu_sn');
    if (lama) catat('DROP idx_onu_sn', 'ALTER TABLE master_onu DROP INDEX idx_onu_sn');
    catat('UNIQUE master_onu +uq_onu_sn',
      'ALTER TABLE master_onu ADD UNIQUE KEY uq_onu_sn (id_perangkat, sn)');
  }
  if (!(await adaIndex('master_onu', 'idx_onu_mac'))) {
    catat('INDEX master_onu +idx_onu_mac', 'ALTER TABLE master_onu ADD INDEX idx_onu_mac (mac)');
  }

  // 4. push sesi dari router ke aplikasi (script + schedule ala gratisinaja)
  if (!(await adaKolom('master_perangkat', 'token_push'))) {
    catat('ALTER master_perangkat +token_push',
      'ALTER TABLE master_perangkat ADD COLUMN token_push VARCHAR(64) DEFAULT NULL AFTER password_enc');
  }
  if (!(await adaIndex('master_perangkat', 'idx_perangkat_token'))) {
    catat('INDEX master_perangkat +idx_perangkat_token',
      'ALTER TABLE master_perangkat ADD INDEX idx_perangkat_token (token_push)');
  }
  const [adaTabel] = await conn.query(
    'SELECT COUNT(*) AS n FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?',
    [cfg.db.database, 'sesi_router']);
  if (!Number(adaTabel[0].n)) {
    catat('TABLE sesi_router',
      `CREATE TABLE sesi_router (
         id INT NOT NULL AUTO_INCREMENT,
         id_perangkat INT NOT NULL,
         tipe ENUM('pppoe','hotspot') NOT NULL DEFAULT 'pppoe',
         akun VARCHAR(120) NOT NULL,
         ip VARCHAR(45) DEFAULT NULL,
         uptime VARCHAR(60) DEFAULT NULL,
         seen_at DATETIME NOT NULL,
         tanda_push CHAR(16) DEFAULT NULL,
         PRIMARY KEY (id),
         UNIQUE KEY uq_sesi (id_perangkat, tipe, akun),
         KEY idx_sesi_seen (seen_at)
       ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
  } else if (!(await adaKolom('sesi_router', 'tanda_push'))) {
    catat('ALTER sesi_router +tanda_push',
      'ALTER TABLE sesi_router ADD COLUMN tanda_push CHAR(16) DEFAULT NULL AFTER seen_at');
  }

  if (!rencana.length) {
    console.log('Migrasi v16: tidak ada perubahan — skema sudah terbaru.');
  } else {
    for (const r of rencana) {
      console.log((DRY ? '[DRY] ' : '') + r.aksi + ' → ' + r.sql.replace(/\s+/g, ' ').slice(0, 120));
    }
    if (!DRY) {
      for (const r of rencana) await conn.query(r.sql);
      console.log(`Migrasi v16 OK — ${rencana.length} perubahan diterapkan.`);
    } else {
      console.log(`(dry-run) ${rencana.length} perubahan TIDAK diterapkan.`);
    }
  }
  await conn.end();
})().catch(e => { console.error('Migrasi v16 GAGAL:', e.message); process.exitCode = 1; });
