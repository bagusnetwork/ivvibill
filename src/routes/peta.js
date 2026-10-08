'use strict';
// ============================================================
// Peta sebaran pelanggan & ODP — padanan maps_marker_topologi.php
// + load/maps_marker.php + load/maps_export.php (gratisinaja).
//
// Semua bacaan di-scope tenant lewat klaim JWT (tenantSql), jadi peta
// milik ISP lain tidak pernah bocor. Ekspor KML/KMZ ditulis tanpa
// dependensi: ZIP memakai metode STORE + CRC32 buatan sendiri.
// ============================================================
const express = require('express');
const db = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

// ---------------------------------------------------------- koordinat
/** "−7.2575, 112.7521" → [lat, lng]; null bila tidak sah. */
function parseTitik(teks) {
  if (teks === null || teks === undefined || teks === '') return null;
  const bagian = String(teks).split(',').map(s => s.trim());
  if (bagian.length !== 2) return null;
  const lat = Number(bagian[0]);
  const lng = Number(bagian[1]);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  return { lat, lng };
}

/** Kolom latitude/longitude pelanggan VARCHAR — dipaksa angka & rentang sah. */
function parseAngka(a, b) {
  if (a === null || a === undefined || a === '' || b === null || b === undefined || b === '') return null;
  const lat = Number(a);
  const lng = Number(b);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  return { lat, lng };
}

// ---------------------------------------------------------- pembacaan
/**
 * Peta selalu mengikuti tenant AKTIF (picker di topbar), bukan "semua tenant"
 * untuk pemilik platform: marker lintas-ISP bercampur satu peta tidak
 * terbaca, dan lokasi pelanggan adalah data sensitif milik satu ISP.
 */
function tenantAktifSql(req, kolom) {
  const ds = Number(req.ds);
  if (!Number.isInteger(ds) || ds < 1) return { sql: ' AND 1 = 0', params: [] };
  return { sql: ` AND ${kolom} = ?`, params: [ds] };
}

async function muatPeta(req) {
  const tOdp = tenantAktifSql(req, 'mt.id_data_server');
  const tPlg = tenantAktifSql(req, 'p.id_data_server');

  const [odpRows, plgRows] = await Promise.all([
    db.q(
      `SELECT mt.id, mt.nama, mt.titik_koordinat, mt.jumlah_port,
              (SELECT COUNT(*) FROM pelanggan x WHERE x.id_master_topologi = mt.id) AS jumlah_terpakai
       FROM master_topologi mt
       WHERE 1=1${tOdp.sql}
       ORDER BY mt.nama`, tOdp.params),
    db.q(
      `SELECT p.id, p.nama, p.kode, p.alamat, p.status, p.latitude, p.longitude,
              p.nomor_whatsapp, p.username_pppoe, p.id_master_topologi,
              pk.nama_paket, mt.nama AS nama_topologi,
              ps.online, ps.last_seen
       FROM pelanggan p
       LEFT JOIN paket pk ON pk.id = p.id_paket
       LEFT JOIN master_topologi mt ON mt.id = p.id_master_topologi
       LEFT JOIN pppoe_status ps ON ps.id_pelanggan = p.id
       WHERE 1=1${tPlg.sql}
       ORDER BY p.nama`, tPlg.params)
  ]);

  const odp = [];
  for (const r of odpRows) {
    const k = parseTitik(r.titik_koordinat);
    odp.push({
      id: r.id, nama: r.nama, titik_koordinat: r.titik_koordinat,
      jumlah_port: Number(r.jumlah_port || 0),
      jumlah_terpakai: Number(r.jumlah_terpakai || 0),
      lat: k ? k.lat : null, lng: k ? k.lng : null
    });
  }

  const pelanggan = [];
  let tanpaKoordinat = 0;
  for (const r of plgRows) {
    const k = parseAngka(r.latitude, r.longitude);
    if (!k) tanpaKoordinat++;
    pelanggan.push({
      id: r.id, nama: r.nama, kode: r.kode, alamat: r.alamat, status: r.status,
      nama_paket: r.nama_paket || null, nama_topologi: r.nama_topologi || null,
      id_topologi: r.id_master_topologi || null,
      nomor_whatsapp: r.nomor_whatsapp || null,
      username_pppoe: r.username_pppoe || null,
      online: r.online === null || r.online === undefined ? null : Number(r.online) === 1,
      last_seen: r.last_seen || null,
      lat: k ? k.lat : null, lng: k ? k.lng : null
    });
  }

  // titik tengah peta: rata-rata titik yang valid (fallback: pusat Jawa Timur)
  const titik = [...odp.filter(o => o.lat !== null).map(o => ({ lat: o.lat, lng: o.lng })),
                 ...pelanggan.filter(p => p.lat !== null).map(p => ({ lat: p.lat, lng: p.lng }))];
  const pusat = titik.length
    ? {
        lat: titik.reduce((s, t) => s + t.lat, 0) / titik.length,
        lng: titik.reduce((s, t) => s + t.lng, 0) / titik.length
      }
    : { lat: -7.062083, lng: 106.79739 };

  return {
    odp, pelanggan, pusat,
    tanpa_koordinat: tanpaKoordinat,
    jumlah: {
      odp: odp.length,
      odp_berkoordinat: odp.filter(o => o.lat !== null).length,
      pelanggan: pelanggan.length,
      pelanggan_berkoordinat: pelanggan.length - tanpaKoordinat
    }
  };
}

router.get('/peta', requireRole('superadmin', 'master', 'teknisi'),
  async (req, res, next) => {
    try {
      res.json(await muatPeta(req));
    } catch (e) { next(e); }
  });

// ---------------------------------------------------------- ekspor KML
function escXml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

/** Susun dokumen KML sebaran (sama gaya dengan load/maps_export.php). */
function buatKml(data, namaDokumen) {
  const baris = [];

  for (const o of data.odp) {
    if (o.lat === null) continue;
    baris.push(
      '<Placemark>\n' +
      `  <name>${escXml(o.nama)}</name>\n` +
      `  <description><![CDATA[<b>${escXml(o.nama)}</b><br>Jenis: ODP<br>Port: ${o.jumlah_terpakai}/${o.jumlah_port} terpakai]]></description>\n` +
      '  <styleUrl>#odp</styleUrl>\n' +
      `  <Point><coordinates>${o.lng},${o.lat},0</coordinates></Point>\n` +
      '</Placemark>');
  }

  for (const p of data.pelanggan) {
    if (p.lat === null) continue;
    const nyala = p.online === true;
    const status = nyala ? 'Connect' : (p.status === 'isolir' ? 'Isolir' : 'Disconnect');
    const desc =
      `Kode: <b>${escXml(p.kode || '')}</b><br>Pelanggan: <b>${escXml(p.nama)}</b>` +
      `<br>Alamat: ${escXml(p.alamat || '-')}` +
      `<br>Paket: ${escXml(p.nama_paket || '-')}` +
      `<br>Status: ${status}`;
    baris.push(
      '<Placemark>\n' +
      `  <name>${escXml(p.nama)}</name>\n` +
      `  <description><![CDATA[${desc}]]></description>\n` +
      `  <styleUrl>${nyala ? '#on' : '#off'}</styleUrl>\n` +
      `  <Point><coordinates>${p.lng},${p.lat},0</coordinates></Point>\n` +
      '</Placemark>');
  }

  return '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<kml xmlns="http://www.opengis.net/kml/2.2">\n' +
    '<Document>\n' +
    `<name>${escXml(namaDokumen)}</name>\n` +
    '<Style id="odp"><IconStyle><Icon><href>https://maps.google.com/mapfiles/kml/shapes/placemark_circle.png</href></Icon></IconStyle></Style>\n' +
    '<Style id="on"><IconStyle><Icon><href>https://maps.google.com/mapfiles/kml/shapes/info-i.png</href></Icon></IconStyle></Style>\n' +
    '<Style id="off"><IconStyle><Icon><href>https://maps.google.com/mapfiles/kml/shapes/caution.png</href></Icon></IconStyle></Style>\n' +
    baris.join('\n') + '\n' +
    '</Document>\n</kml>\n';
}

// ---------------------------------------------------------- KMZ (ZIP)
const TABEL_CRC = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = TABEL_CRC[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

/** ZIP satu berkas tanpa kompresi (STORE) — cukup untuk KMZ berisi satu KML. */
function zipStore(nama, isi) {
  const data = Buffer.isBuffer(isi) ? isi : Buffer.from(isi, 'utf8');
  const namaBuf = Buffer.from(nama, 'utf8');
  const crc = crc32(data);
  const d = new Date();
  const waktu = ((d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1)) & 0xFFFF;
  const tanggal = (((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()) & 0xFFFF;

  const lokal = Buffer.alloc(30);
  lokal.writeUInt32LE(0x04034B50, 0);
  lokal.writeUInt16LE(20, 4);            // versi
  lokal.writeUInt16LE(0x0800, 6);        // flag: nama UTF-8
  lokal.writeUInt16LE(0, 8);             // metode: STORE
  lokal.writeUInt16LE(waktu, 10);
  lokal.writeUInt16LE(tanggal, 12);
  lokal.writeUInt32LE(crc, 14);
  lokal.writeUInt32LE(data.length, 18);  // terkompresi
  lokal.writeUInt32LE(data.length, 22);  // asli
  lokal.writeUInt16LE(namaBuf.length, 26);
  lokal.writeUInt16LE(0, 28);

  const tengah = Buffer.alloc(46);
  tengah.writeUInt32LE(0x02014B50, 0);
  tengah.writeUInt16LE(20, 4);
  tengah.writeUInt16LE(20, 6);
  tengah.writeUInt16LE(0x0800, 8);
  tengah.writeUInt16LE(0, 10);
  tengah.writeUInt16LE(waktu, 12);
  tengah.writeUInt16LE(tanggal, 14);
  tengah.writeUInt32LE(crc, 16);
  tengah.writeUInt32LE(data.length, 20);
  tengah.writeUInt32LE(data.length, 24);
  tengah.writeUInt16LE(namaBuf.length, 28);
  tengah.writeUInt32LE(0, 42);           // offset berkas lokal
  // 30..38 & 40..44 sengaja 0 (comment/extra/disk/attr internal)

  const ekor = Buffer.alloc(22);
  ekor.writeUInt32LE(0x06054B50, 0);
  ekor.writeUInt16LE(0, 8);              // jumlah berkas di disk ini
  ekor.writeUInt16LE(1, 10);
  ekor.writeUInt32LE(tengah.length + namaBuf.length, 12);
  ekor.writeUInt32LE(lokal.length + namaBuf.length + data.length, 16);

  return Buffer.concat([lokal, namaBuf, data, tengah, namaBuf, ekor]);
}

// ---------------------------------------------------------- rute ekspor
router.get('/peta/export', requireRole('superadmin', 'master', 'teknisi'),
  async (req, res, next) => {
    try {
      const fmt = String(req.query.fmt || 'kml').toLowerCase() === 'kmz' ? 'kmz' : 'kml';
      const data = await muatPeta(req);
      const namaDokumen = 'Peta Sebaran Topologi';
      const kml = buatKml(data, namaDokumen);
      const stempel = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '');
      const namaBerkas = `peta_sebaran_${stempel}.${fmt}`;

      if (fmt === 'kml') {
        res.type('application/vnd.google-earth.kml+xml')
           .set('Content-Disposition', `attachment; filename="${namaBerkas}"`)
           .send(kml);
        return;
      }
      res.type('application/vnd.google-earth.kmz')
         .set('Content-Disposition', `attachment; filename="${namaBerkas}"`)
         .send(zipStore('peta_sebaran.kml', kml));
    } catch (e) { next(e); }
  });

module.exports = router;
