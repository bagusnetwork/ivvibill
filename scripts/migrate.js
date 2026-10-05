'use strict';
// ============================================================
// Migrasi skema ivvibill — idempoten.
// Pemakaian: node scripts/migrate.js
// ============================================================
const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');
require('../src/config'); // pastikan .secret terbaca / error jelas

(async () => {
  const cfg = require('../src/config');
  const conn = await mysql.createConnection({
    host: cfg.db.host, port: cfg.db.port,
    user: cfg.db.user, password: cfg.db.password,
    database: cfg.db.database, multipleStatements: true,
    charset: 'utf8mb4_unicode_ci'
  });
  const sql = fs.readFileSync(path.join(__dirname, '..', 'sql', 'schema.sql'), 'utf8');
  try {
    await conn.query(sql);
    console.log('Migrasi OK — skema ivvibill siap.');
  } catch (e) {
    console.error('Migrasi GAGAL:', e.message);
    process.exitCode = 1;
  } finally {
    await conn.end();
  }
})();
