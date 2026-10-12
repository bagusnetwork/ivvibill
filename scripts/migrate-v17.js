'use strict';
// ============================================================
// Migrasi v1.7 — profil PPPoE dan isolir per pelanggan
//  1) paket.profile_pppoe: nama profile di /ppp/profile. Sebelumnya satu kolom
//     profile_hotspot dipakai untuk dua jenis, sehingga paket PPPoE berlabel
//     "profile hotspot" padahal nilainya tidak pernah dibaca router PPPoE.
//     Nilai lama paket pppoe dipindah (bukan dihapus) ke kolom baru.
//  2) pelanggan.profile_isolir: tiap pelanggan punya batas isolir berbeda
//     (1M, 512k, ...). Bila terisi, isolir = turunkan bandwidth ke profile itu
//     dan koneksi tetap naik; bila kosong, perilaku lama (secret dimatikan).
//  3) pelanggan.profil_sebelum_isolir: profile asal secret, dicatat otomatis
//     saat isolir lewat profil supaya pelunasan bisa mengembalikannya persis.
// Idempoten: cek information_schema sebelum ALTER/UPDATE.
// Pemakaian: node scripts/migrate-v17.js [--dry-run]
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
  const jumlah = async (sql, args = []) => {
    const [r] = await conn.query(sql, args);
    return Number(r[0].n);
  };

  // 1. profil PPPoE milik paket
  if (!(await adaKolom('paket', 'profile_pppoe'))) {
    catat('ALTER paket +profile_pppoe',
      'ALTER TABLE paket ADD COLUMN profile_pppoe VARCHAR(64) DEFAULT NULL AFTER profile_hotspot');
  }

  // 2. profil isolir milik pelanggan
  if (!(await adaKolom('pelanggan', 'profile_isolir'))) {
    catat('ALTER pelanggan +profile_isolir',
      'ALTER TABLE pelanggan ADD COLUMN profile_isolir VARCHAR(64) DEFAULT NULL AFTER status');
  }

  // 3. penanda profile asal selama diisolir lewat profil
  if (!(await adaKolom('pelanggan', 'profil_sebelum_isolir'))) {
    catat('ALTER pelanggan +profil_sebelum_isolir',
      'ALTER TABLE pelanggan ADD COLUMN profil_sebelum_isolir VARCHAR(64) DEFAULT NULL AFTER profile_isolir');
  }

  // 4. pindahkan nilai profil paket PPPoE yang dulu tersangkut di kolom hotspot
  const adaPppoe = await adaKolom('paket', 'profile_pppoe');
  const tersangkut = await jumlah(
    `SELECT COUNT(*) AS n FROM paket
      WHERE jenis = 'pppoe' AND profile_hotspot IS NOT NULL AND profile_hotspot <> ''
        ${adaPppoe ? "AND (profile_pppoe IS NULL OR profile_pppoe = '')" : ''}`);
  if (tersangkut) {
    console.log(`paket: ${tersangkut} baris pppoe punya profile_hotspot — disalin ke profile_pppoe`);
    catat('UPDATE paket profile_pppoe dari profile_hotspot',
      `UPDATE paket SET profile_pppoe = profile_hotspot
        WHERE jenis = 'pppoe' AND profile_hotspot IS NOT NULL AND profile_hotspot <> ''
          AND (profile_pppoe IS NULL OR profile_pppoe = '')`);
  }

  if (!rencana.length) {
    console.log('Migrasi v17: tidak ada perubahan — skema sudah terbaru.');
  } else {
    for (const r of rencana) {
      console.log((DRY ? '[DRY] ' : '') + r.aksi + ' → ' + r.sql.replace(/\s+/g, ' ').slice(0, 120));
    }
    if (!DRY) {
      for (const r of rencana) await conn.query(r.sql);
      console.log(`Migrasi v17 OK — ${rencana.length} perubahan diterapkan.`);
    } else {
      console.log(`(dry-run) ${rencana.length} perubahan TIDAK diterapkan.`);
    }
  }
  await conn.end();
})().catch(e => { console.error('Migrasi v17 GAGAL:', e.message); process.exit(1); });
