'use strict';
// ============================================================
// ivvibill — koneksi database pusat (mysql2 pool, parameterized)
// ============================================================
const mysql = require('mysql2/promise');
const config = require('./config');

const pool = mysql.createPool({
  host: config.db.host,
  port: config.db.port,
  user: config.db.user,
  password: config.db.password,
  database: config.db.database,
  waitForConnections: true,
  connectionLimit: config.db.connectionLimit,
  charset: config.db.charset,
  timezone: '+00:00',
  dateStrings: true,
  namedPlaceholders: false,
  supportBigNumbers: true
});

/** Query dengan placeholder `?` — selalu parameterized. */
async function q(sql, params = []) {
  const [rows] = await pool.execute(sql, params);
  return rows;
}

/** Ambil satu baris (atau null). */
async function one(sql, params = []) {
  const rows = await q(sql, params);
  return rows.length ? rows[0] : null;
}

/** Insert → return insertId. */
async function insert(sql, params = []) {
  const [res] = await pool.execute(sql, params);
  return res.insertId;
}

/** Update/Delete → return affectedRows. */
async function run(sql, params = []) {
  const [res] = await pool.execute(sql, params);
  return res.affectedRows;
}

/** Jalankan beberapa query dalam satu transaksi. */
async function tx(fn) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const r = await fn({
      q: async (sql, p = []) => (await conn.execute(sql, p))[0],
      one: async (sql, p = []) => {
        const rows = (await conn.execute(sql, p))[0];
        return rows.length ? rows[0] : null;
      },
      insert: async (sql, p = []) => (await conn.execute(sql, p))[0].insertId,
      run: async (sql, p = []) => (await conn.execute(sql, p))[0].affectedRows
    });
    await conn.commit();
    return r;
  } catch (e) {
    try { await conn.rollback(); } catch (_) {}
    throw e;
  } finally {
    conn.release();
  }
}

async function ping() {
  await pool.query('SELECT 1');
  return true;
}

module.exports = { pool, q, one, insert, run, tx, ping };
