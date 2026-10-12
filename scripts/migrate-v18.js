'use strict';
// ============================================================
// Migrasi v18 — penanda & jam siklus otomatis
//  1) tagihan.ingatkan_terakhir (DATE): pengingat H-3 kini dicoba tiap menit
//     sejak jam peringatan (supaya satu menit yang terlewat tidak menghanguskan
//     seluruh hari kirim). Kolom ini membuat tiap tagihan tetap dapat maksimal
//     satu pengingat per hari. Indeks siklus (id_data_server, status, jatuh_tempo)
//     sudah ada dari skema awal, jadi tidak ditambahkan lagi.
//  2) data_server.jam_peringatan + jam_isolir: dulu 08:00 dan 09:00 dikeras di
//     scheduler. Sekarang bisa disetel per ISP di Pengaturan, dan itu sekaligus
//     membuat jalur otomatis bisa diuji pada jam berapa pun.
// Idempoten: cek information_schema sebelum ALTER.
// Pemakaian: node scripts/migrate-v18.js [--dry-run]
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

  const kolomBaru = [
    ['tagihan', 'ingatkan_terakhir',
      'ALTER TABLE tagihan ADD COLUMN ingatkan_terakhir DATE DEFAULT NULL AFTER status'],
    ['data_server', 'jam_peringatan',
      "ALTER TABLE data_server ADD COLUMN jam_peringatan VARCHAR(5) NOT NULL DEFAULT '08:00' AFTER jam_kirim"],
    ['data_server', 'jam_isolir',
      "ALTER TABLE data_server ADD COLUMN jam_isolir VARCHAR(5) NOT NULL DEFAULT '09:00' AFTER jam_peringatan"],
  ];
  for (const [t, k, sql] of kolomBaru) {
    if (!(await adaKolom(t, k))) catat(`ALTER ${t} +${k}`, sql);
  }

  if (!rencana.length) {
    console.log('Migrasi v18: tidak ada perubahan — skema sudah terbaru.');
  } else {
    for (const r of rencana) console.log((DRY ? '[DRY] ' : '') + r.aksi + ' → ' + r.sql);
    if (!DRY) {
      for (const r of rencana) await conn.query(r.sql);
      console.log(`Migrasi v18 OK — ${rencana.length} perubahan diterapkan.`);
    } else {
      console.log(`(dry-run) ${rencana.length} perubahan TIDAK diterapkan.`);
    }
  }
  await conn.end();
})().catch(e => { console.error('Migrasi v18 GAGAL:', e.message); process.exit(1); });
