'use strict';
// ============================================================
// Migrasi v1.9/v2.0 — PROFILE TAGIHAN menggantikan "hari tagihan"
//
// Dulu satu angka per pelanggan (pelanggan.hari_tagihan) menentukan jatuh
// tempo, sementara hari pembuatan tagihan, hari pengiriman WA, batas isolir,
// mode PPN dan boleh/tidaknya pesan peringatan hanya ada di level data server.
// Akibatnya satu ISP yang punya beberapa golongan pelanggan (bayar tanggal 10,
// bayar tanggal 25, instansi tanpa peringatan) tidak bisa diwakili.
//
// Tabel baru profil_tagihan menyimpan satu paket kebijakan penagihan:
//   tanggal_buat, tanggal_kirim, tanggal_isolir, kompensasi_desimal,
//   ppn_mode, kirim_peringatan, status.
// pelanggan.id_profil_tagihan menunjuk ke sana. Kolom hari_tagihan TETAP ADA
// dan menjadi turunan: setiap kali pelanggan diberi profil, hari_tagihan
// disamakan dengan tanggal_isolir profil itu, sehingga invoice, export dan
// berkas import lama tidak berubah makna.
//
// Pelanggan tanpa profil (= NULL) mengikuti jadwal data_server seperti
// sebelumnya, jadi migrasi ini tidak mengubah perilaku siapa pun:
// profil default dibuat DARI jadwal tenant, lalu semua pelanggan ditautkan
// ke profil itu (nilainya identik dengan yang lama).
//
// Idempoten: cek information_schema + cek baris sebelum tulis.
// Pemakaian: node scripts/migrate-v19.js [--dry-run]
// ============================================================
const mysql = require('mysql2/promise');
require('../src/config');

const DRY = process.argv.includes('--dry-run');
const rencana = [];
const catat = (aksi, sql) => rencana.push({ aksi, sql });

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

  // 1. tabel profil
  if (!(await adaTabel('profil_tagihan'))) {
    catat('CREATE TABLE profil_tagihan', `CREATE TABLE profil_tagihan (
      id INT NOT NULL AUTO_INCREMENT,
      id_data_server INT NOT NULL DEFAULT 1,
      nama VARCHAR(60) NOT NULL,
      tanggal_buat TINYINT NOT NULL DEFAULT 1,
      tanggal_kirim TINYINT NOT NULL DEFAULT 2,
      tanggal_isolir TINYINT NOT NULL DEFAULT 10,
      kompensasi_desimal DECIMAL(6,3) NOT NULL DEFAULT 0.000,
      ppn_mode ENUM('tanpa','ditambah','termasuk') NOT NULL DEFAULT 'tanpa',
      kirim_peringatan TINYINT(1) NOT NULL DEFAULT 1,
      status ENUM('aktif','nonaktif') NOT NULL DEFAULT 'aktif',
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY uq_profil_tagihan (id_data_server, nama),
      KEY idx_profil_ds (id_data_server)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
  }

  // 2. penautan di pelanggan
  if (!(await adaKolom('pelanggan', 'id_profil_tagihan'))) {
    catat('ALTER pelanggan +id_profil_tagihan',
      'ALTER TABLE pelanggan ADD COLUMN id_profil_tagihan INT DEFAULT NULL AFTER id_paket');
  }

  if (!rencana.length) {
    console.log('Migrasi v19: struktur sudah ada — lanjut ke pengisian profil default.');
  } else {
    for (const r of rencana) {
      console.log((DRY ? '[DRY] ' : '') + r.aksi + ' → ' + r.sql.replace(/\s+/g, ' ').slice(0, 110));
    }
    if (DRY) { console.log(`(dry-run) ${rencana.length} perubahan TIDAK diterapkan.`); await conn.end(); return; }
    for (const r of rencana) await conn.query(r.sql);
    console.log(`Struktur OK — ${rencana.length} perubahan diterapkan.`);
  }

  // 3. profil default per tenant, diambil dari jadwal lama data_server
  const [tenants] = await conn.query(
    `SELECT id, nama_server, prefix_invoice, jadwal_buat_hari, jadwal_kirim_hari,
            jadwal_limit_hari, ppn_persen
       FROM data_server ORDER BY id`);

  /** Buat (atau cari) satu profil; return id, -1 pada dry-run untuk baris baru. */
  async function pastikanProfil(t, hariIsolir, label) {
    const nama = `${(t.prefix_invoice || 'IVV').toUpperCase()}-${Number(hariIsolir) || 10}`;
    const [ada] = await conn.query(
      'SELECT id FROM profil_tagihan WHERE id_data_server = ? AND nama = ?', [t.id, nama]);
    if (ada.length) {
      console.log(`tenant ${t.id} ${t.nama_server}: profil "${nama}" sudah ada (id ${Number(ada[0].id)})`);
      return Number(ada[0].id);
    }
    // ppn_mode meniru perhitungan lama: ppn_persen > 0 berarti dulu selalu
    // ditambahkan di atas harga paket. Tanpa baris ini, tenant ber-PPN diam-diam
    // berhenti memungut PPN begitu pelanggannya punya profil.
    const ppnMode = Number(t.ppn_persen || 0) > 0 ? 'ditambah' : 'tanpa';
    if (DRY) {
      console.log(`[DRY] tenant ${t.id}: INSERT profil_tagihan "${nama}" — ${label} ` +
        `(buat ${t.jadwal_buat_hari}, kirim ${t.jadwal_kirim_hari}, isolir ${hariIsolir}, PPN ${ppnMode})`);
      return -1;
    }
    const [res] = await conn.query(
      `INSERT INTO profil_tagihan (id_data_server, nama, tanggal_buat, tanggal_kirim, tanggal_isolir,
                                  ppn_mode, kirim_peringatan, status)
       VALUES (?,?,?,?,?,?,1,'aktif')`,
      [t.id, nama, t.jadwal_buat_hari, t.jadwal_kirim_hari, hariIsolir, ppnMode]);
    console.log(`tenant ${t.id} ${t.nama_server}: profil ${label} "${nama}" dibuat (id ${Number(res.insertId)}, PPN ${ppnMode})`);
    return Number(res.insertId);
  }

  for (const t of tenants) {
    const idDefault = await pastikanProfil(t, Number(t.jadwal_limit_hari) || 10, 'default');

    // 4. tautkan pelanggan yang belum punya profil. Hari tagihan tiap pelanggan
    //    dihormati: kalau nilainya beda dari jadwal tenant, dibuatkan profil
    //    sendiri (nama PREFIX-<hari>) supaya tempoenya tidak berubah.
    const [belum] = await conn.query(
      `SELECT hari_tagihan, COUNT(*) AS n FROM pelanggan
        WHERE id_data_server = ? AND id_profil_tagihan IS NULL
        GROUP BY hari_tagihan ORDER BY hari_tagihan`, [t.id]);
    if (!belum.length) { console.log(`  semua pelanggan tenant ${t.id} sudah punya profil`); continue; }
    const ringkas = belum.map(x => `${x.hari_tagihan}:${x.n}`).join(', ');
    console.log(`  tenant ${t.id}: pelanggan belum berprofil per hari_tagihan → ${ringkas}`);

    for (const baris of belum) {
      const h = Number(baris.hari_tagihan) || Number(t.jadwal_limit_hari) || 10;
      const idProfil = h === Number(t.jadwal_limit_hari)
        ? idDefault : await pastikanProfil(t, h, 'turunan hari_tagihan pelanggan');
      if (DRY) {
        console.log(`    [DRY] ${baris.n} pelanggan hari_tagihan=${h} akan ditautkan ke profil "${namaProfil(t, h)}"`);
        continue;
      }
      if (idProfil < 0) continue;
      await conn.query(
        `UPDATE pelanggan SET id_profil_tagihan = ?, hari_tagihan = ?
          WHERE id_data_server = ? AND id_profil_tagihan IS NULL AND hari_tagihan = ?`,
        [idProfil, h, t.id, baris.hari_tagihan]);
      console.log(`    ${baris.n} pelanggan (hari_tagihan=${h}) ditautkan, nilai tetap`);
    }
  }

  if (DRY) console.log('\n(dry-run) tidak ada yang ditulis ke database.');
  else console.log('\nMigrasi v19 selesai.');
  await conn.end();
})().catch(e => { console.error('Migrasi v19 GAGAL:', e.message); process.exit(1); });

/** Nama profil untuk satu hari isolir — hanya dipakai log dry-run. */
function namaProfil(t, h) {
  return `${(t.prefix_invoice || 'IVV').toUpperCase()}-${Number(h) || 10}`;
}
