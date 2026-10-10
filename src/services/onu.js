'use strict';
// ============================================================
// Pencocok ONU hasil polling OLT dengan baris pelanggan.
//
// master_onu.id_pelanggan sudah ada di skema sejak v1.2 tapi tidak pernah
// ditulis, sehingga kolom redaman di daftar pelanggan selalu kosong. Tingkatan
// pencocokan meniru gratisinaja (AnalisaRedaman::cocokkanPelanggan):
//   1. MAC ONU  == pelanggan.mac_address
//   2. nama/LOID ONU == pelanggan.username_pppoe   (akun)
//   3. nama/LOID ONU == pelanggan.nama
// Baris yang sudah dicocokkan manual tidak pernah ditimpa.
// ============================================================
const db = require('../db');

/** 'aa:bb:cc:dd:ee:ff' / 'AABBCCDDEEFF' / 'AA-BB-CC-DD-EE-FF' -> 12 hex uppercase */
function normMac(v) {
  const h = String(v || '').toUpperCase().replace(/[^0-9A-F]/g, '');
  return h.length >= 12 ? h.slice(-12) : null;
}

/** Akun/nama yang lebih pendek dari 3 huruf terlalu mudah kena cocok kebetulan. */
function normAkun(v) {
  const s = String(v || '').trim().toLowerCase();
  return s.length >= 3 ? s : null;
}

/** Peta lookup pelanggan satu tenant; pelanggan tanpa pengenal tidak masuk peta. */
function indeksPelanggan(rows) {
  const idx = { mac: new Map(), akun: new Map(), nama: new Map() };
  for (const p of rows) {
    const m = normMac(p.mac_address);
    if (m && !idx.mac.has(m)) idx.mac.set(m, p);
    const a = normAkun(p.username_pppoe);
    if (a && !idx.akun.has(a)) idx.akun.set(a, p);
    const n = normAkun(p.nama);
    if (n && !idx.nama.has(n)) idx.nama.set(n, p);
  }
  return idx;
}

/** Tingkatan pertama yang menang; [pelanggan, cara] atau null. */
function cari(idx, o) {
  const m = normMac(o.mac);
  if (m && idx.mac.has(m)) return [idx.mac.get(m), 'mac'];
  const label = normAkun(o.nama_onu);
  if (label) {
    if (idx.akun.has(label)) return [idx.akun.get(label), 'akun'];
    if (idx.nama.has(label)) return [idx.nama.get(label), 'nama'];
  }
  return null;
}

/**
 * Simpan hasil polling satu OLT ke master_onu + redaman_log.
 * Dipakai scheduler DAN tombol Poll manual — dulu hanya scheduler yang menulis,
 * sehingga 'Poll sekarang' di panel menampilkan ONU tanpa pernah menyimpannya.
 * onus = keluaran olt.pollOlt()
 */
async function simpan(idPerangkat, onus) {
  let tersimpan = 0, kritis = 0, warning = 0;
  for (const o of onus || []) {
    if (o.error) continue;
    if (o.status_redaman === 'kritis') kritis++;
    else if (o.status_redaman === 'warning') warning++;
    if (!o.sn) continue;
    await db.run(
      `INSERT INTO master_onu (id_perangkat, pon, sn, mac, nama_onu, rx_dbm, tx_dbm, status_online)
       VALUES (?,?,?,?,?,?,?,?)
       ON DUPLICATE KEY UPDATE pon=VALUES(pon), mac=VALUES(mac), nama_onu=VALUES(nama_onu),
         rx_dbm=VALUES(rx_dbm), tx_dbm=VALUES(tx_dbm), status_online=VALUES(status_online)`,
      [Number(idPerangkat), o.pon, o.sn, o.mac || null, o.nama || null, o.rx, o.tx, o.online ? 1 : 0]
    );
    await db.insert(
      'INSERT INTO redaman_log (id_perangkat, sn, pon, rx_dbm, redaman_db, status) VALUES (?,?,?,?,?,?)',
      [Number(idPerangkat), o.sn, o.pon, o.rx, o.redaman, o.status_redaman]
    );
    tersimpan++;
  }
  return { tersimpan, kritis, warning };
}

/**
 * Cocokkan seluruh ONU (atau satu perangkat / satu tenant) ke pelanggan.
 * return { dicek, cocok, berubah, manual }
 */
async function cocokkan({ idPerangkat = null, idDataServer = null } = {}) {
  const hasil = { dicek: 0, cocok: 0, berubah: 0, manual: 0 };
  const syarat = [];
  const params = [];
  if (idPerangkat) { syarat.push('o.id_perangkat = ?'); params.push(Number(idPerangkat)); }
  if (idDataServer) { syarat.push('d.id_data_server = ?'); params.push(Number(idDataServer)); }
  const tambahan = syarat.length ? ` AND ${syarat.join(' AND ')}` : '';

  const onus = await db.q(
    `SELECT o.id, o.id_perangkat, o.sn, o.mac, o.nama_onu, o.id_pelanggan, o.match_by,
            d.id_data_server
     FROM master_onu o
     JOIN master_perangkat d ON d.id = o.id_perangkat
     WHERE o.sn IS NOT NULL AND o.sn <> ''${tambahan}
     ORDER BY o.id_perangkat`, params);

  // pelanggan dimuat sekali per tenant, bukan per ONU
  const perTenant = new Map();
  for (const o of onus) {
    const ds = Number(o.id_data_server);
    if (!perTenant.has(ds)) perTenant.set(ds, []);
    perTenant.get(ds).push(o);
  }

  for (const [ds, daftar] of perTenant) {
    const idx = indeksPelanggan(await db.q(
      `SELECT id, nama, username_pppoe, mac_address FROM pelanggan WHERE id_data_server = ?`, [ds]));
    for (const o of daftar) {
      hasil.dicek++;
      if (o.match_by === 'manual') { hasil.manual++; continue; }
      const temuan = cari(idx, o);
      const idTuju = temuan ? Number(temuan[0].id) : null;
      const cara = temuan ? temuan[1] : null;
      if (Number(o.id_pelanggan || 0) === Number(idTuju || 0) && (o.match_by || null) === cara) continue;
      await db.run('UPDATE master_onu SET id_pelanggan=?, match_by=?, matched_at=NOW() WHERE id=?',
        [idTuju, cara, o.id]);
      hasil.berubah++;
      if (temuan) hasil.cocok++;
    }
  }
  return hasil;
}

module.exports = { cocokkan, simpan, normMac, normAkun };
