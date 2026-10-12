'use strict';
// ============================================================
// Migrasi v2.3 — kolom tagihan.ref_gateway
//
// Checkout Midtrans (Snap) membuat nomor order sendiri setiap kali pelanggan
// menekan "Bayar": PREFIX-<idTagihan>-<timestamp>. Nomor itu dikirim ke
// Midtrans dan kembali lewat notifikasi webhook, tapi sebelumnya tidak pernah
// disimpan. Akibatnya:
//   1. notifikasi 'expire/deny/cancel' tidak bisa dibedakan — status
//      'menunggu' juga dipakai untuk bukti transfer manual yang belum
//      diverifikasi, jadi melepas status bisa menghapus antrian verifikasi;
//   2. operator tidak punya cara melihat order mana yang sedang menunggu di
//      gateway saat mencocokkan dengan dashboard Midtrans.
//
// Kolom ini menyimpan order id percobaan terakhir, dan HANYA dipakai untuk
// pencocokan notifikasi. Tidak ada perubahan perilaku untuk ISP yang
// gateway-nya masih 'manual'.
//
// Idempoten: cek information_schema sebelum ALTER.
// Pemakaian: node scripts/migrate-v20.js [--dry-run]
// ============================================================
const mysql = require('mysql2/promise');
require('../src/config');

const DRY = process.argv.includes('--dry-run');

(async () => {
  const cfg = require('../src/config');
  const conn = await mysql.createConnection({
    host: cfg.db.host, port: cfg.db.port,
    user: cfg.db.user, password: cfg.db.password,
    database: cfg.db.database
  });

  const [ada] = await conn.query(
    `SELECT COUNT(*) AS n FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'tagihan' AND COLUMN_NAME = 'ref_gateway'`,
    [cfg.db.database]);

  if (Number(ada[0].n) > 0) {
    console.log('Migrasi v20: kolom tagihan.ref_gateway sudah ada — tidak ada yang diubah.');
    await conn.end();
    return;
  }

  const sql = 'ALTER TABLE tagihan ADD COLUMN ref_gateway VARCHAR(80) DEFAULT NULL AFTER metode_bayar';
  if (DRY) {
    console.log('[DRY] ' + sql);
    console.log('(dry-run) tidak ada yang ditulis ke database.');
    await conn.end();
    return;
  }
  await conn.query(sql);
  console.log('OK — tagihan.ref_gateway (VARCHAR 80) ditambahkan.');

  // Isian lama tidak bisa ditebak order id-nya; yang jelas-jelas 'menunggu'
  // karena gateway (metode_bayar terisi midtrans/flip) tetap dibiarkan kosong,
  // artinya notifikasi lama tidak akan mengubah apa pun — sama seperti
  // sebelumnya, hanya sekarang ada kolom tempat mencocokkan.
  const [sisa] = await conn.query(
    `SELECT COUNT(*) AS n FROM tagihan WHERE status = 'menunggu'`);
  console.log(`Catatan: ${Number(sisa[0].n)} tagihan masih berstatus 'menunggu' (bukti manual / percobaan gateway lama).`);
  await conn.end();
})().catch(e => { console.error('Migrasi v20 GAGAL:', e.message); process.exit(1); });
