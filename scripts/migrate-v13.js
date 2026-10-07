'use strict';
// ============================================================
// Migrasi v1.3 — modul invoice penjualan (header + butir bebas)
// dan kolom pendukung kwitansi gambar.
// Idempoten: cek information_schema sebelum ALTER/CREATE.
// Pemakaian: node scripts/migrate-v13.js [--dry-run]
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

  const adaTabel = async (t) => {
    const [r] = await conn.query(
      'SELECT COUNT(*) AS n FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?',
      [cfg.db.database, t]);
    return Number(r[0].n) > 0;
  };
  const adaKolom = async (t, k) => {
    const [r] = await conn.query(
      'SELECT COUNT(*) AS n FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND COLUMN_NAME = ?',
      [cfg.db.database, t, k]);
    return Number(r[0].n) > 0;
  };

  // 1. header invoice — sengaja terpisah dari tabel tagihan: itemnya
  //    diketik manual dan tidak terikat paket maupun siklus bulanan
  if (!(await adaTabel('invoice'))) {
    catat('CREATE invoice', `CREATE TABLE invoice (
      id INT NOT NULL AUTO_INCREMENT, id_data_server INT NOT NULL DEFAULT 1,
      nomor VARCHAR(25) NOT NULL, tanggal DATE NOT NULL, jatuh_tempo DATE DEFAULT NULL,
      id_pelanggan INT DEFAULT NULL, id_agen INT DEFAULT NULL,
      nama_tujuan VARCHAR(100) DEFAULT NULL, alamat_tujuan VARCHAR(200) DEFAULT NULL,
      whatsapp_tujuan VARCHAR(20) DEFAULT NULL, catatan VARCHAR(255) DEFAULT NULL,
      status ENUM('buat','terkirim','lunas','batal') NOT NULL DEFAULT 'buat',
      metode_bayar VARCHAR(30) DEFAULT NULL, paid_at DATETIME DEFAULT NULL,
      img_invoice VARCHAR(150) DEFAULT NULL, dibuat_oleh INT DEFAULT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id), UNIQUE KEY uq_invoice_nomor (nomor),
      KEY idx_invoice_server (id_data_server, status, tanggal),
      KEY idx_invoice_pelanggan (id_pelanggan)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
  }
  if (!(await adaTabel('invoice_item'))) {
    catat('CREATE invoice_item', `CREATE TABLE invoice_item (
      id INT NOT NULL AUTO_INCREMENT, id_invoice INT NOT NULL,
      tanggal DATE NOT NULL, uraian VARCHAR(150) NOT NULL,
      quantity DECIMAL(10,2) NOT NULL DEFAULT 1, harga DECIMAL(15,2) NOT NULL DEFAULT 0,
      PRIMARY KEY (id), KEY idx_invitem_invoice (id_invoice)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
  }

  // 2. kwitansi lunas sebagai gambar (dikirim lewat WA)
  if (!(await adaKolom('tagihan', 'img_invoice'))) {
    catat('ALTER tagihan +img_invoice',
      'ALTER TABLE tagihan ADD COLUMN img_invoice VARCHAR(150) DEFAULT NULL');
  }
  if (!(await adaKolom('wa_queue', 'media'))) {
    catat('ALTER wa_queue +media',
      'ALTER TABLE wa_queue ADD COLUMN media VARCHAR(255) DEFAULT NULL');
  }

  if (!rencana.length) {
    console.log('Migrasi v13: tidak ada perubahan — skema sudah terbaru.');
  } else {
    for (const r of rencana) console.log((DRY ? '[DRY] ' : '') + r.aksi + ' → ' + r.sql.replace(/\s+/g, ' ').slice(0, 120));
    if (!DRY) {
      for (const r of rencana) await conn.query(r.sql);
      console.log(`Migrasi v13 OK — ${rencana.length} perubahan diterapkan.`);
    } else {
      console.log(`(dry-run) ${rencana.length} perubahan TIDAK diterapkan.`);
    }
  }
  await conn.end();
})().catch(e => { console.error('Migrasi v13 GAGAL:', e.message); process.exitCode = 1; });
