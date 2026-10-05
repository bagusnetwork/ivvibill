'use strict';
// ============================================================
// Konfigurasi data_server ter-cache singkat + helper tagihan.
// ============================================================
const db = require('../db');

let cache = null;
let cacheAt = 0;

async function getServer(id = 1, force = false) {
  if (!force && cache && Date.now() - cacheAt < 30000) return cache;
  const row = await db.one('SELECT * FROM data_server WHERE id = ?', [id]);
  cache = row;
  cacheAt = Date.now();
  return row;
}

function invalidate() { cache = null; cacheAt = 0; }

/** Nomor invoice unik: IVV-YYYYMM-XXXXX */
async function nomorInvoice() {
  const ym = new Date().toISOString().slice(0, 7).replace('-', '');
  for (let i = 0; i < 20; i++) {
    const rand = Math.floor(10000 + Math.random() * 90000);
    const n = `IVV-${ym}-${rand}`;
    const dup = await db.one('SELECT id FROM tagihan WHERE nomor_invoice = ?', [n]);
    if (!dup) return n;
  }
  throw new Error('Gagal membuat nomor invoice');
}

module.exports = { getServer, invalidate, nomorInvoice };
