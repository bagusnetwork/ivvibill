'use strict';
// ============================================================
// Absensi teknisi lapangan.
//   POST /api/absen        : catat masuk/pulang + koordinat HP
//   GET  /api/absen/saya   : baris hari ini + riwayat milik teknisi ini
//   GET  /api/absen        : rekap per rentang tanggal untuk dipantau di panel
//
// Sesuai keputusan pemilik fitur: koordinat HANYA dicatat, tidak ada penolakan
// "terlalu jauh dari kantor". Jarak masuk->pulang dihitung untuk ditampilkan.
// Yang ditolak hanyalah nilai yang bentuknya salah atau separuh (lat tanpa long).
// Satu teknisi satu baris per hari (uq_absen_hari), jadi absen ulang cukup
// memperbarui jam/koordinatnya.
// ============================================================
const express = require('express');
const db = require('../db');
const v = require('../util/validate');
const { requireAuth, requireRole } = require('../middleware/auth');
const { tenantSql, tenantAktif } = require('../util/scope');

const router = express.Router();
router.use(requireAuth);

const KOLOM = {
  masuk: { jam: 'jam_masuk', lat: 'lat_masuk', long: 'long_masuk', akurasi: 'akurasi_masuk' },
  pulang: { jam: 'jam_pulang', lat: 'lat_pulang', long: 'long_pulang', akurasi: 'akurasi_pulang' }
};

/** Jarak dua titik dalam meter (Haversine). */
function jarakMeter(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const rad = (x) => (x * Math.PI) / 180;
  const dLat = rad(lat2 - lat1);
  const dLon = rad(lon2 - lon1);
  const s = Math.sin(dLat / 2) ** 2
    + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLon / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.min(1, Math.sqrt(s))));
}

/** GPS boleh tidak tersedia (HP menolak locate) — yang tidak boleh hanya separuh. */
function bacaKoordinat(body) {
  const lat = v.num(body.lat, { min: -90, max: 90, def: null });
  const lon = v.num(body.long, { min: -180, max: 180, def: null });
  if (lat === null && lon === null) return { lat: null, lon: null };
  if (lat === null || lon === null) {
    throw new Error('Koordinat tidak lengkap, lat dan long harus sepasang');
  }
  return { lat, lon };
}

async function barisHariIni(req) {
  return db.one(
    `SELECT * FROM absen_teknisi WHERE id_teknisi = ? AND tanggal = CURDATE()`, [req.user.id]);
}

router.post('/absen', requireRole('teknisi'), async (req, res, next) => {
  try {
    const jenis = v.enumOf(req.body.jenis, ['masuk', 'pulang']);
    const { lat, lon } = bacaKoordinat(req.body);
    const akurasi = v.num(req.body.akurasi, { int: true, min: 0, max: 100000, def: null });
    const catatan = v.str(req.body.catatan, { max: 255, def: null });
    const k = KOLOM[jenis];

    // INSERT IGNORE mengandalkan uq_absen_hari: bila baris hari ini sudah ada,
    // statement ini tidak berbuat apa-apa dan UPDATE di bawah yang mengisi kolom.
    await db.run(
      `INSERT IGNORE INTO absen_teknisi (id_data_server, id_teknisi, nama_teknisi, tanggal)
       VALUES (?, ?, ?, CURDATE())`, [tenantAktif(req), req.user.id, req.user.nama]);
    await db.run(
      `UPDATE absen_teknisi SET ${k.jam} = NOW(), ${k.lat} = ?, ${k.long} = ?, ${k.akurasi} = ?,
              catatan = COALESCE(?, catatan)
       WHERE id_teknisi = ? AND tanggal = CURDATE()`, [lat, lon, akurasi, catatan, req.user.id]);

    const row = await barisHariIni(req);
    let jarak = null;
    if (row && row.lat_masuk != null && row.long_masuk != null
      && row.lat_pulang != null && row.long_pulang != null) {
      jarak = jarakMeter(Number(row.lat_masuk), Number(row.long_masuk),
        Number(row.lat_pulang), Number(row.long_pulang));
    }
    // selalu ditulis ulang: bila salah satu titik direkam tanpa GPS, jarak lama
    // tidak boleh tertinggal di baris yang koordinatnya sudah tidak lengkap.
    if (row) {
      await db.run('UPDATE absen_teknisi SET jarak_meter = ? WHERE id = ?', [jarak, row.id]);
    }
    await db.insert(
      'INSERT INTO audit_log (user_id, id_data_server, aksi, detail, ip) VALUES (?,?,?,?,?)',
      [req.user.id, tenantAktif(req), 'absen', `${jenis}${lat === null ? ' tanpa koordinat' : ''}`,
        (req.ip || '').replace('::ffff:', '')]);
    res.json({ ok: true, jenis, jarak_meter: jarak, hari_ini: row });
  } catch (e) { next(e); }
});

router.get('/absen/saya', requireRole('teknisi'), async (req, res, next) => {
  try {
    const [hariIni, data] = await Promise.all([
      barisHariIni(req),
      db.q(`SELECT * FROM absen_teknisi WHERE id_teknisi = ? ORDER BY tanggal DESC LIMIT 31`,
        [req.user.id])
    ]);
    res.json({ hari_ini: hariIni, data });
  } catch (e) { next(e); }
});

/**
 * Monitor panel. Teknisi hanya boleh barisnya sendiri; master/superadmin melihat
 * seluruh teknisi di tenant aktif (isolasi tetap dari tenantSql).
 */
router.get('/absen', requireRole('superadmin', 'master', 'teknisi'), async (req, res, next) => {
  try {
    const ts = tenantSql(req, 'a.id_data_server');
    const dari = v.tgl(req.query.dari, null);
    const sampai = v.tgl(req.query.sampai, null);
    const where = [`1=1${ts.sql}`];
    const params = [...ts.params];
    if (req.user.role === 'teknisi') { where.push('a.id_teknisi = ?'); params.push(req.user.id); }
    const idTeknisi = v.num(req.query.id_teknisi, { int: true, min: 1, def: null });
    if (idTeknisi) { where.push('a.id_teknisi = ?'); params.push(idTeknisi); }
    if (dari) { where.push('a.tanggal >= ?'); params.push(dari); }
    if (sampai) { where.push('a.tanggal <= ?'); params.push(sampai); }

    const data = await db.q(
      `SELECT a.*,
              TIMESTAMPDIFF(MINUTE, a.jam_masuk, a.jam_pulang) AS durasi_menit
       FROM absen_teknisi a
       WHERE ${where.join(' AND ')}
       ORDER BY a.tanggal DESC, a.jam_masuk ASC LIMIT 500`, params);

    // rekap per teknisi untuk baris ringkas di panel
    const perOrang = new Map();
    for (const r of data) {
      const p = perOrang.get(r.id_teknisi) || {
        id_teknisi: r.id_teknisi, nama: r.nama_teknisi, id_data_server: r.id_data_server,
        hari: 0, lengkap: 0, tanpa_koordinat: 0, jarak_meter: 0
      };
      p.hari += 1;
      if (r.jam_masuk && r.jam_pulang) p.lengkap += 1;
      if (r.lat_masuk == null && r.lat_pulang == null) p.tanpa_koordinat += 1;
      p.jarak_meter += Number(r.jarak_meter || 0);
      perOrang.set(r.id_teknisi, p);
    }
    res.json({ data, rekap: [...perOrang.values()].sort((a, b) => b.hari - a.hari) });
  } catch (e) { next(e); }
});

module.exports = router;
