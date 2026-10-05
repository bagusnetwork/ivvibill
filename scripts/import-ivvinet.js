'use strict';
// ============================================================
// Import data IVVINET dari instalasi lama (MySQL gratisinaja)
// ke ivvibill: identitas server, paket PPPoE, perangkat
// (MikroTik + OLT), jadwal tagihan dan template WhatsApp.
//
// Pemakaian:
//   SRC_DB_USER=... SRC_DB_PASS=... node scripts/import-ivvinet.js
//   opsional: --src-server=4 --dst-server=1 --dry-run
//
// Password perangkat hanya dibaca untuk dienkripsi AES-256-GCM,
// tidak pernah dicetak.
// ============================================================
const mysql = require('mysql2/promise');
const config = require('../src/config');
const db = require('../src/db');
const crypto = require('../src/util/crypto');

function arg(nama, def) {
  const f = process.argv.find(a => a.startsWith(`--${nama}=`));
  return f ? f.split('=')[1] : def;
}
const DRY = process.argv.includes('--dry-run');
const SRC_SERVER = Number(arg('src-server', 4));
const DST_SERVER = Number(arg('dst-server', 1));

const TPL = [
  ['registrasi', 'pesan_registrasi'],
  ['aktivasi', 'pesan_aktivasi'],
  ['tagihan', 'pesan_kirim_tagihan'],
  ['peringatan', 'pesan_peringatan_tagihan'],
  ['lunas', 'pesan_melunasi_tagihan'],
  ['isolir', 'pesan_isolir_pelanggan'],
  ['koneksi_off', 'pesan_koneksi_off']
];

const log = (...a) => console.log(...a);
async function tulis(sql, params) {
  if (DRY) { log('  [dry-run]', sql.split('\n')[0].trim().slice(0, 90)); return 0; }
  return db.run(sql, params);
}

/** "http://203.0.113.11:90" -> { host, port, https } */
function pisahkanUrl(s) {
  const t = String(s || '').trim();
  const m = t.match(/^(https?):\/\/([^:/]+)(?::(\d+))?/i);
  if (!m) return { host: t.replace(/^\/+/, ''), port: null, https: 0 };
  return { host: m[2], port: m[3] ? Number(m[3]) : null, https: m[1].toLowerCase() === 'https' ? 1 : 0 };
}

async function src() {
  if (!process.env.SRC_DB_USER || !process.env.SRC_DB_PASS) {
    throw new Error('Set env SRC_DB_USER dan SRC_DB_PASS (akun MySQL yang boleh membaca DB gratisinaja)');
  }
  return mysql.createConnection({
    host: process.env.SRC_DB_HOST || config.db.host,
    port: Number(process.env.SRC_DB_PORT || config.db.port),
    user: process.env.SRC_DB_USER,
    password: process.env.SRC_DB_PASS,
    database: process.env.SRC_DB_NAME || 'gratisinaja',
    charset: 'utf8mb4_unicode_ci'
  });
}

async function ambil(conn, sql, params) {
  const [rows] = await conn.execute(sql, params);
  return rows;
}

// --- 1. identitas + jadwal tagihan -----------------------------------------
async function importServer(conn) {
  const [srv] = await ambil(conn,
    `SELECT id, nama_server, nama_pemilik, nomor_whatsapp, email, alamat, status
       FROM data_server WHERE id = ?`, [SRC_SERVER]);
  if (!srv) throw new Error(`data_server id ${SRC_SERVER} tidak ada di sumber`);
  const [tagihan] = await ambil(conn,
    `SELECT buat_tagihan, kirim_tagihan, limit_tagihan, ppn FROM profile_tagihan
      WHERE id_data_server = ? ORDER BY id LIMIT 1`, [SRC_SERVER]);
  const jadwal = {
    buat: Number(tagihan?.buat_tagihan || 3),
    kirim: Number(tagihan?.kirim_tagihan || 1),
    limit: Number(tagihan?.limit_tagihan || 11),
    ppn: Number(tagihan?.ppn || 0)
  };
  await tulis(
    `UPDATE data_server SET nama_server = ?, nama_pemilik = ?, nomor_whatsapp = ?,
       email = ?, alamat = ?, jadwal_buat_hari = ?, jadwal_kirim_hari = ?,
       jadwal_limit_hari = ?, ppn_persen = ? WHERE id = ?`,
    [srv.nama_server, srv.nama_pemilik, srv.nomor_whatsapp, srv.email, srv.alamat,
     jadwal.buat, jadwal.kirim, jadwal.limit, jadwal.ppn, DST_SERVER]
  );
  log(`Server      : ${srv.nama_server} (pemilik ${srv.nama_pemilik || '-'}) ` +
      `jadwal buat=${jadwal.buat} kirim=${jadwal.kirim} limit=${jadwal.limit} ppn=${jadwal.ppn}`);
}

// --- 2. paket ---------------------------------------------------------------
async function importPaket(conn) {
  const rows = await ambil(conn,
    `SELECT nama_profile, nama, harga_paket, bandwidth_download, bandwidth_upload, durasi, status
       FROM profile_paket WHERE id_data_server = ? AND jenis_profile = 'PPPOE' ORDER BY harga_paket`,
    [SRC_SERVER]);
  let baru = 0, ubah = 0;
  for (const r of rows) {
    const nama = (r.nama || r.nama_profile || '').trim();
    if (!nama) continue;
    const kecepatan = [r.bandwidth_download || r.nama_profile, r.bandwidth_upload]
      .filter(Boolean).join('/');
    const harga = Number(r.harga_paket || 0);
    const masa = Number(r.durasi || 30);
    const status = String(r.status || 'aktif') === 'aktif' ? 'aktif' : 'nonaktif';
    const ada = await db.one(
      'SELECT id FROM paket WHERE id_data_server = ? AND nama_paket = ?', [DST_SERVER, nama]);
    if (ada) {
      await tulis('UPDATE paket SET harga = ?, kecepatan = ?, masa_aktif = ?, status = ? WHERE id = ?',
        [harga, kecepatan, masa, status, ada.id]);
      ubah++;
    } else {
      await tulis(`INSERT INTO paket (id_data_server, nama_paket, jenis, harga, kecepatan, masa_aktif, status)
                   VALUES (?,?,'pppoe',?,?,?,?)`,
        [DST_SERVER, nama, harga, kecepatan, masa, status]);
      baru++;
    }
    log(`Paket       : ${nama} Rp ${harga} (${kecepatan || '-'})`);
  }
  log(`Paket       : ${baru} baru, ${ubah} diperbarui dari ${rows.length} baris sumber`);
}

// --- 3. perangkat: MikroTik ------------------------------------------------
async function importMikrotik(conn) {
  const rows = await ambil(conn,
    `SELECT nama, ip_address, port_api, username, password, board_name, status
       FROM setting_mikrotik WHERE id_data_server = ?`, [SRC_SERVER]);
  for (const r of rows) {
    const port = Number(r.port_api || 8728);
    const aktif = String(r.status || 'active') === 'active';
    const status = aktif ? 'aktif' : 'nonaktif';        // master_perangkat
    const statusMt = aktif ? 'active' : 'down';         // setting_mikrotik
    const ada = await db.one(
      'SELECT id FROM master_perangkat WHERE id_data_server = ? AND nama = ? AND tipe = ?',
      [DST_SERVER, r.nama, 'router']);
    let idPerangkat = ada ? ada.id : null;
    if (idPerangkat) {
      await tulis(`UPDATE master_perangkat SET brand = 'mikrotik', alamat = ?, port = ?,
                     use_https = 0, username = ?, password_enc = ?, status = ? WHERE id = ?`,
        [r.ip_address, port, r.username, crypto.encrypt(r.password), status, idPerangkat]);
    } else {
      if (DRY) { log('  [dry-run] INSERT master_perangkat router ' + r.nama); }
      else {
        idPerangkat = await db.insert(
          `INSERT INTO master_perangkat
             (id_data_server, nama, brand, tipe, alamat, port, use_https, username, password_enc, status)
           VALUES (?,?,'mikrotik','router',?,?,?,?,?,?)`,
          [DST_SERVER, r.nama, r.ip_address, port, 0, r.username, crypto.encrypt(r.password), status]);
      }
    }
    if (idPerangkat) {
      const set = await db.one('SELECT id FROM setting_mikrotik WHERE id_perangkat = ?', [idPerangkat]);
      if (!set) {
        await tulis(`INSERT INTO setting_mikrotik (id_data_server, id_perangkat, nama, interval_menit, board_name, status)
                     VALUES (?,?,?,1,?,?)`,
          [DST_SERVER, idPerangkat, r.nama, r.board_name, statusMt]);
      } else {
        await tulis('UPDATE setting_mikrotik SET nama = ?, id_data_server = ?, status = ? WHERE id = ?',
          [r.nama, DST_SERVER, statusMt, set.id]);
      }
    }
    log(`Router      : ${r.nama} ${r.ip_address}:${port} (user ${r.username || '-'}, password terenkripsi)`);
  }
  log(`Router      : ${rows.length} MikroTik diimpor`);
}

// --- 4. perangkat: OLT -----------------------------------------------------
async function importOlt(conn) {
  const rows = await ambil(conn,
    `SELECT nama, jenis, alamat_perangkat, username, password
       FROM master_perangkat WHERE id_data_server = ? AND nama <> ''`, [SRC_SERVER]);
  let n = 0;
  for (const r of rows) {
    const u = pisahkanUrl(r.alamat_perangkat);
    const ada = await db.one(
      'SELECT id FROM master_perangkat WHERE id_data_server = ? AND nama = ? AND tipe = ?',
      [DST_SERVER, r.nama, 'olt']);
    let idPerangkat = ada ? ada.id : null;
    if (idPerangkat) {
      await tulis(`UPDATE master_perangkat SET brand = 'hsgq', alamat = ?, port = ?, use_https = ?,
                     username = ?, password_enc = ? WHERE id = ?`,
        [u.host, u.port, u.https, r.username, crypto.encrypt(r.password), idPerangkat]);
    } else {
      if (DRY) { log('  [dry-run] INSERT master_perangkat olt', r.nama); }
      else {
        idPerangkat = await db.insert(
          `INSERT INTO master_perangkat
             (id_data_server, nama, brand, tipe, alamat, port, use_https, username, password_enc)
           VALUES (?,?,'hsgq','olt',?,?,?,?,?)`,
          [DST_SERVER, r.nama, u.host, u.port, u.https, r.username, crypto.encrypt(r.password)]);
      }
    }
    if (idPerangkat) {
      const set = await db.one('SELECT id FROM setting_olt WHERE id_perangkat = ?', [idPerangkat]);
      if (!set) {
        await tulis(`INSERT INTO setting_olt (id_perangkat, status, olt_tx_dbm, rx_min_dbm, att_max_db, interval_menit)
                     VALUES (?,'aktif',4.00,-27.00,28.00,5)`, [idPerangkat]);
      }
    }
    log(`OLT         : ${r.nama} ${u.host}${u.port ? ':' + u.port : ''} (${r.jenis || 'web config'})`);
    n++;
  }
  log(`OLT         : ${n} perangkat diimpor`);
}

// --- 5. template WhatsApp ---------------------------------------------------
async function importTemplate(conn) {
  const [srv] = await ambil(conn,
    `SELECT ${TPL.map(([, k]) => k).join(', ')} FROM data_server WHERE id = ?`, [SRC_SERVER]);
  let n = 0;
  for (const [jenis, kolom] of TPL) {
    const konten = String(srv[kolom] || '').trim();
    if (!konten) continue;
    await tulis(
      `INSERT INTO pesan_template (id_data_server, jenis, konten) VALUES (?,?,?)
       ON DUPLICATE KEY UPDATE konten = VALUES(konten)`,
      [DST_SERVER, jenis, konten]);
    n++;
  }
  log(`Template WA : ${n} jenis disalin (placeholder #usr/#tot/#lmt dst kompatibel)`);
}

(async () => {
  const conn = await src();
  log(`Import ${process.env.SRC_DB_NAME || 'gratisinaja'} (server ${SRC_SERVER}) -> ${config.db.database} (server ${DST_SERVER})${DRY ? ' [DRY RUN]' : ''}`);
  try {
    await importServer(conn);
    await importPaket(conn);
    await importMikrotik(conn);
    await importOlt(conn);
    await importTemplate(conn);
    log('Selesai.');
  } catch (e) {
    console.error('GAGAL:', e.message);
    process.exitCode = 1;
  } finally {
    await conn.end();
    await db.pool.end();
  }
})();
