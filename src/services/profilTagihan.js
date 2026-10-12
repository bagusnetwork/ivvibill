'use strict';
// ============================================================
// Profil Tagihan (v2.0) — pengganti "Hari Tagihan" per pelanggan.
//
// Satu profil memuat seluruh kebijakan penagihan satu golongan warga:
// tanggal buat, tanggal kirim, tanggal isolir (= jatuh tempo), PPN,
// peringatan, dan kompensasi. Pelanggan menunjuk profil lewat
// pelanggan.id_profil_tagihan; kolom lama pelanggan.hari_tagihan tetap
// ditulis sebagai NILAI TURUNAN dari tanggal_isolir, supaya jalur lama
// (dan pelanggan yang belum ditautkan) tidak berubah perilakunya.
// ============================================================
const db = require('../db');
const v = require('../util/validate');

const PPN_MODE = ['tanpa', 'ditambah', 'termasuk'];
const STATUS = ['aktif', 'nonaktif'];

/** 1..28 — sama seperti jadwal lama; 29..31 dipaksa ke 28 agar bulan Februari tidak meleset. */
function hari(nilai, def) {
  return v.num(nilai, { min: 1, max: 28, int: true, def });
}

function yaTidak(nilai, def) {
  if (nilai === undefined || nilai === null || nilai === '') return def ? 1 : 0;
  const s = String(nilai).trim().toLowerCase();
  if (['1', 'true', 'ya', 'y', 'aktif'].includes(s)) return 1;
  if (['0', 'false', 'tidak', 'n', 'nonaktif'].includes(s)) return 0;
  throw new Error('Pilihan ya/tidak tidak valid');
}

/** Validasi isi form (create & update). `lama` dipakai PUT supaya field kosong tidak menghapus nilai. */
function isian(body, lama = {}) {
  return {
    nama: v.str(body.nama, { min: 2, max: 60, def: lama.nama }),
    tanggal_buat: hari(body.tanggal_buat, hari(lama.tanggal_buat, 1)),
    tanggal_kirim: hari(body.tanggal_kirim, hari(lama.tanggal_kirim, 2)),
    tanggal_isolir: hari(body.tanggal_isolir, hari(lama.tanggal_isolir, 10)),
    kompensasi: v.num(body.kompensasi_desimal !== undefined ? body.kompensasi_desimal : body.kompensasi,
      { min: 0, max: 99.999, def: Number(lama.kompensasi_desimal || 0) }),
    ppn_mode: v.enumOf(body.ppn_mode, PPN_MODE, lama.ppn_mode || 'tanpa'),
    kirim_peringatan: yaTidak(body.kirim_peringatan, lama.kirim_peringatan === undefined ? 1 : Number(lama.kirim_peringatan)),
    status: v.enumOf(body.status, STATUS, lama.status || 'aktif')
  };
}

/** Daftar profil + jumlah pelanggannya (angka nol tampil supaya editor tahu profilnya masih kosong). */
async function daftar(idDataServer) {
  return db.q(
    `SELECT pt.*,
            (SELECT COUNT(*) FROM pelanggan p
              WHERE p.id_profil_tagihan = pt.id AND p.id_data_server = pt.id_data_server) AS jumlah_pelanggan
     FROM profil_tagihan pt
     WHERE pt.id_data_server = ?
     ORDER BY pt.status = 'aktif' DESC, pt.tanggal_buat ASC, pt.nama ASC`,
    [Number(idDataServer)]
  );
}

async function satu(id, idDataServer, kolom = '*') {
  return db.one(
    `SELECT ${kolom === 'ringkas' ? 'id, nama, status, tanggal_isolir' : '*'}
     FROM profil_tagihan WHERE id = ? AND id_data_server = ?`,
    [Number(id), Number(idDataServer)]
  );
}

async function buat(idDataServer, body) {
  const i = isian(body);
  try {
    const id = await db.insert(
      `INSERT INTO profil_tagihan (id_data_server, nama, tanggal_buat, tanggal_kirim, tanggal_isolir,
                                   kompensasi_desimal, ppn_mode, kirim_peringatan, status)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      [Number(idDataServer), i.nama, i.tanggal_buat, i.tanggal_kirim, i.tanggal_isolir,
       i.kompensasi, i.ppn_mode, i.kirim_peringatan, i.status]
    );
    return { id, ...i };
  } catch (e) {
    if (/uq_profil_tagihan|Duplicate/i.test(String(e.message))) {
      throw new Error(`Profil "${i.nama}" sudah ada di data server ini`);
    }
    throw e;
  }
}

async function ubah(id, idDataServer, body) {
  const lama = await satu(id, idDataServer);
  if (!lama) throw new Error('Profil tagihan tidak ada di data server ini');
  const i = isian(body, lama);
  try {
    await db.run(
      `UPDATE profil_tagihan SET nama=?, tanggal_buat=?, tanggal_kirim=?, tanggal_isolir=?,
              kompensasi_desimal=?, ppn_mode=?, kirim_peringatan=?, status=? WHERE id = ?`,
      [i.nama, i.tanggal_buat, i.tanggal_kirim, i.tanggal_isolir,
       i.kompensasi, i.ppn_mode, i.kirim_peringatan, i.status, Number(id)]
    );
    // hari_tagihan pelanggan adalah turunan: ganti tanggal_isolir = geser tempo semua
    // pelanggan di profil ini, persis seperti dulu mengubah "Hari Tagihan".
    await db.run(
      'UPDATE pelanggan SET hari_tagihan = ? WHERE id_profil_tagihan = ? AND id_data_server = ?',
      [i.tanggal_isolir, Number(id), Number(idDataServer)]
    );
    return { ok: true, ...i };
  } catch (e) {
    if (/uq_profil_tagihan|Duplicate/i.test(String(e.message))) {
      throw new Error(`Profil "${i.nama}" sudah ada di data server ini`);
    }
    throw e;
  }
}

/** Hapus hanya bila tidak ada pelanggan yang menunjuk profil ini. */
async function hapus(id, idDataServer) {
  const pt = await satu(id, idDataServer);
  if (!pt) throw new Error('Profil tagihan tidak ada di data server ini');
  const [{ n }] = await db.q(
    'SELECT COUNT(*) AS n FROM pelanggan WHERE id_profil_tagihan = ? AND id_data_server = ?',
    [Number(id), Number(idDataServer)]
  );
  if (Number(n) > 0) {
    // penolakan karena profil masih dipakai adalah salah langkah pengguna,
    // bukan kegagalan server — ditandai 400 supaya tidak tercatat sebagai 500
    const e = new Error(
      `Profil masih dipakai ${n} pelanggan — pindahkan mereka ke profil lain dulu`);
    e.status = 400;
    throw e;
  }
  await db.run('DELETE FROM profil_tagihan WHERE id = ? AND id_data_server = ?',
    [Number(id), Number(idDataServer)]);
  return { ok: true, nama: pt.nama };
}

/**
 * Tautkan satu profil ke banyak pelanggan (form pelanggan, aksi massal, import).
 * Sekaligus menulis hari_tagihan = tanggal_isolir supaya nilai turunan tidak
 * pernah tertinggal. Nilai null = lepas tautan, hari_tagihan tidak disentuh.
 */
async function tautkan(idDataServer, idProfil, idPelanggan) {
  const ids = (Array.isArray(idPelanggan) ? idPelanggan : [idPelanggan])
    .map(x => Number(x)).filter(x => Number.isInteger(x) && x > 0);
  if (!ids.length) return { ditautkan: 0 };
  const pt = idProfil === null || idProfil === undefined || idProfil === ''
    ? null : await satu(idProfil, idDataServer, 'ringkas');
  if (idProfil && !pt) throw new Error('Profile Tagihan tidak ada di data server ini');
  const placeholders = ids.map(() => '?').join(',');
  await db.run(
    `UPDATE pelanggan SET id_profil_tagihan = ?,
            hari_tagihan = COALESCE(?, hari_tagihan)
     WHERE id IN (${placeholders}) AND id_data_server = ?`,
    [pt ? Number(pt.id) : null, pt ? Number(pt.tanggal_isolir) : null,
     ...ids, Number(idDataServer)]
  );
  return { ditautkan: ids.length, profil: pt ? pt.nama : null };
}

/** Profil milik tenant ini (null bila tidak ditautkan) — dipakai rute/API pelanggan. */
async function profilTenant(idDataServer, idProfil) {
  if (idProfil === null || idProfil === undefined || idProfil === '') return null;
  const pt = await satu(idProfil, idDataServer, 'ringkas');
  if (!pt) throw new Error('Profile Tagihan tidak ada di data server ini');
  return pt;
}

module.exports = { daftar, satu, buat, ubah, hapus, tautkan, profilTenant, isian, PPN_MODE };
