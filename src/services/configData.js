'use strict';
// ============================================================
// Konfigurasi per data_server (tenant) — cache singkat per id
// + helper nomor invoice memakai prefix milik tenant itu sendiri.
// ============================================================
const db = require('../db');

const TTL = 30000;
const cache = new Map();   // id -> { row, at }

/**
 * Baca baris data_server. `id` WAJIB: tidak ada lagi default tenant 1,
 * supaya jalur yang lupa meneruskan tenant gagal keras, bukan diam-diam
 * memakai kredensial ISP lain.
 */
async function getServer(id, force = false) {
  const n = Number(id);
  if (!Number.isInteger(n) || n < 1) throw new Error('getServer: id data_server wajib diisi');
  const hit = cache.get(n);
  if (!force && hit && Date.now() - hit.at < TTL) return hit.row;
  const row = await db.one('SELECT * FROM data_server WHERE id = ?', [n]);
  if (!row) throw new Error(`Data server ${n} tidak ada`);
  cache.set(n, { row, at: Date.now() });
  return row;
}

/** Buang cache — seluruh tenant bila id kosong, satu tenant bila id diisi. */
function invalidate(id) {
  if (id === undefined || id === null) cache.clear();
  else cache.delete(Number(id));
}

/** Daftar tenant aktif — dipakai scheduler & pemilih tenant di panel. */
async function daftarServer() {
  return db.q(`SELECT id, nama_server, prefix_invoice, expaired_date, status
               FROM data_server WHERE status = 'Aktif' ORDER BY id`);
}

/** Nomor invoice unik per tenant: <PREFIX>-YYYYMM-XXXXX */
async function nomorInvoice(idServer) {
  const srv = await getServer(idServer);
  const prefix = (srv.prefix_invoice || 'IVV').replace(/-+$/, '');
  const ym = new Date().toISOString().slice(0, 7).replace('-', '');
  for (let i = 0; i < 20; i++) {
    const rand = Math.floor(10000 + Math.random() * 90000);
    const n = `${prefix}-${ym}-${rand}`;
    const dup = await db.one('SELECT id FROM tagihan WHERE nomor_invoice = ?', [n]);
    if (!dup) return n;
  }
  throw new Error('Gagal membuat nomor invoice');
}

module.exports = { getServer, invalidate, daftarServer, nomorInvoice };
