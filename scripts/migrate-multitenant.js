'use strict';
// ============================================================
// Migrasi multitenant (idempoten) — jalankan: node scripts/migrate-multitenant.js
//
// Model meniru gratisinaja: satu baris data_server = satu ISP,
// lengkap dengan akun master-nya sendiri; user bawahan (app_user)
// terikat daftar data server + grup hak akses menu.
// ============================================================
const mysql = require('mysql2/promise');
const config = require('../src/config');

const punyaKolom = (c, t, k) =>
  c.query(
    `SELECT 1 FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`, [t, k]
  ).then(([r]) => r.length > 0);

const punyaIndex = (c, t, i) =>
  c.query(
    `SELECT 1 FROM information_schema.STATISTICS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND INDEX_NAME = ?`, [t, i]
  ).then(([r]) => r.length > 0);

async function tambahKolom(c, t, k, ddl) {
  if (await punyaKolom(c, t, k)) return console.log(`  = ${t}.${k} sudah ada`);
  await c.query(`ALTER TABLE ${t} ADD COLUMN ${ddl}`);
  console.log(`  + ${t}.${k}`);
}

(async () => {
  const conn = await mysql.createConnection({
    host: config.db.host, port: config.db.port, user: config.db.user,
    password: config.db.password, database: config.db.database,
    multipleStatements: false, charset: 'utf8mb4_unicode_ci'
  });
  const jalan = async (sql, label) => {
    try { await conn.query(sql); console.log(`  + ${label}`); }
    catch (e) { console.log(`  ! ${label}: ${e.message}`); }
  };

  console.log('data_server — akun master + identitas tagihan per ISP');
  await tambahKolom(conn, 'data_server', 'username',
    "username VARCHAR(50) DEFAULT NULL COMMENT 'login master ISP ini'");
  await tambahKolom(conn, 'data_server', 'password_hash',
    'password_hash VARCHAR(255) DEFAULT NULL');
  await tambahKolom(conn, 'data_server', 'prefix_invoice',
    "prefix_invoice VARCHAR(10) NOT NULL DEFAULT 'IVV'");
  await tambahKolom(conn, 'data_server', 'expaired_date', 'expaired_date DATE DEFAULT NULL');
  if (!(await punyaIndex(conn, 'data_server', 'uq_ds_username'))) {
    await jalan(`ALTER TABLE data_server ADD UNIQUE KEY uq_ds_username (username)`,
      'index unik data_server.username');
  } else console.log('  = index data_server.username sudah ada');

  console.log('app_user — ikatan tenant + grup akses');
  await tambahKolom(conn, 'app_user', 'id_data_server',
    "id_data_server VARCHAR(100) DEFAULT NULL COMMENT 'CSV id data_server; NULL = semua'");
  await tambahKolom(conn, 'app_user', 'id_group_akses', 'id_group_akses INT DEFAULT NULL');
  await jalan('ALTER TABLE app_user ADD KEY idx_user_server (id_data_server(20))',
    'index app_user.id_data_server');

  console.log('group_akses — grant menu per tenant');
  await jalan(`CREATE TABLE IF NOT EXISTS group_akses (
      id INT NOT NULL AUTO_INCREMENT,
      id_data_server INT NOT NULL DEFAULT 1,
      nama VARCHAR(100) NOT NULL,
      akses TEXT NOT NULL COMMENT 'JSON: {"menu":{"pelanggan":{"halaman":[...],"sub_menu":[...]}}}',
      status ENUM('aktif','nonaktif') NOT NULL DEFAULT 'aktif',
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY uq_group (id_data_server, nama),
      KEY idx_group_server (id_data_server)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
    'tabel group_akses');

  console.log('setting_app — key/value per tenant');
  if (await punyaKolom(conn, 'setting_app', 'id_data_server')) {
    console.log('  = setting_app.id_data_server sudah ada');
  } else {
    await jalan(`ALTER TABLE setting_app
        ADD COLUMN id_data_server INT NOT NULL DEFAULT 1 FIRST`,
      'kolom setting_app.id_data_server');
  }
  const [pk] = await conn.query(
    `SELECT GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX) kols
     FROM information_schema.STATISTICS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'setting_app' AND INDEX_NAME = 'PRIMARY'`
  );
  if (pk[0] && pk[0].kols !== 'id_data_server,kunci') {
    await jalan(`ALTER TABLE setting_app DROP PRIMARY KEY,
        ADD PRIMARY KEY (id_data_server, kunci)`, 'PK setting_app (id_data_server,kunci)');
  } else console.log('  = PK setting_app sudah per tenant');

  console.log('perbaikan tipe kolom (kode_unik tagihan 100..999 tidak muat TINYINT)');
  const [tipeKode] = await conn.query(
    `SELECT DATA_TYPE t FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'tagihan' AND COLUMN_NAME = 'kode_unik'`);
  if (tipeKode[0] && tipeKode[0].t === 'tinyint') {
    await jalan(`ALTER TABLE tagihan MODIFY COLUMN kode_unik SMALLINT NOT NULL DEFAULT 0`,
      'lebar kolom tagihan.kode_unik -> SMALLINT');
  } else console.log('  = tagihan.kode_unik sudah cukup lebar');

  console.log('entitas tanpa induk tersambung');
  await tambahKolom(conn, 'rekening', 'id_data_server',
    'id_data_server INT NOT NULL DEFAULT 1');
  await tambahKolom(conn, 'pekerjaan', 'id_data_server',
    'id_data_server INT NOT NULL DEFAULT 1');
  await tambahKolom(conn, 'audit_log', 'id_data_server',
    'id_data_server INT DEFAULT NULL');
  await jalan('ALTER TABLE rekening ADD KEY idx_rek_server (id_data_server)', 'index rekening');
  await jalan('ALTER TABLE pekerjaan ADD KEY idx_kerja_server (id_data_server)', 'index pekerjaan');
  await jalan('ALTER TABLE audit_log ADD KEY idx_audit_server (id_data_server)', 'index audit_log');

  console.log('backfill baris lama ke tenant 1 (IVVINET)');
  await jalan(`UPDATE app_user u
      JOIN data_server d ON d.id = 1
      SET u.id_data_server = '1'
      WHERE u.id_data_server IS NULL AND u.role <> 'superadmin'`,
      'app_user non-superadmin → id_data_server "1"');
  await jalan(`INSERT INTO group_akses (id_data_server, nama, akses)
      SELECT 1, 'Semua menu', '{"menu":"all"}'
      WHERE NOT EXISTS (SELECT 1 FROM group_akses WHERE id_data_server = 1)`,
      'group_akses default tenant 1');

  console.log('Selesai. Verifikasi:');
  const [n] = await conn.query(`SELECT
      (SELECT COUNT(*) FROM data_server) server,
      (SELECT COUNT(*) FROM group_akses) grup,
      (SELECT COUNT(*) FROM app_user WHERE id_data_server IS NULL) user_semua_tenant,
      (SELECT COUNT(*) FROM setting_app) setting_app`);
  console.log(' ', JSON.stringify(n[0]));
  await conn.end();
})().catch(e => { console.error('MIGRASI GAGAL:', e.message); process.exit(1); });
