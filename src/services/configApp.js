'use strict';
// ============================================================
// setting_app per data_server (tenant).
//
// Tabel ini ber-PK (id_data_server, kunci) — satu kunci boleh punya
// nilai berbeda di tiap ISP. Sejak lama pembacaan dilakukan tanpa
// menyebut tenant (`WHERE kunci = 'batas_offline_menit'`), dan selama
// hanya tenant 1 yang punya baris hasilnya "kebetulan benar". Begitu
// ISP kedua berlangganan, query itu mengembalikan baris milik pemilik
// platform: ambang offline, zona waktu dan batas percobaan login
// tetangga ikut ditentukan oleh angka Anda.
//
// Aturan baru: id tenant WAJIB disebut. Kunci yang belum diisi untuk
// tenant itu memakai nilai BAWAAN APLIKASI, bukan baris tenant 1,
// supaya ISP baru tidak diam-diam mewarisi pengaturan Anda.
// ============================================================
const db = require('../db');

/** Nilai awal untuk tenant baru — juga dipakai bila kuncinya belum pernah diisi. */
const DEFAULT_APLIKASI = {
  app_name: 'ivvibill',
  timezone: 'Asia/Jakarta',
  batas_offline_menit: '15',
  interval_issue_menit: '10',
  batas_gagal_login: '5',
  izin_registrasi: '1',
  // label yang tercetak di dokumen & header panel ISP; kosong = pakai nama_server
  nama_tampilan: '',
  // alamat tempat pelanggan ISP ini membuka portal (tautan bayar di WA);
  // kosong = tidak ada tautan, sama seperti sebelumnya
  base_url: ''
};

/** Kunci yang boleh ditulis sendiri oleh penanggung jawab tenant. */
const KUNCI_BISA_DISIMPAN = Object.keys(DEFAULT_APLIKASI);

const TTL = 15000;
const cache = new Map();   // id -> { map, at }

function idWajib(id) {
  const n = Number(id);
  if (!Number.isInteger(n) || n < 1) throw new Error('setting_app: id data_server wajib diisi');
  return n;
}

/** Peta kunci→nilai milik satu tenant, digabung dengan bawaan. */
async function peta(idDataServer, force = false) {
  const n = idWajib(idDataServer);
  const hit = cache.get(n);
  if (!force && hit && Date.now() - hit.at < TTL) return hit.map;
  const rows = await db.q('SELECT kunci, nilai FROM setting_app WHERE id_data_server = ?', [n]);
  const map = { ...DEFAULT_APLIKASI };
  for (const r of rows) map[r.kunci] = r.nilai === null || r.nilai === undefined ? '' : String(r.nilai);
  cache.set(n, { map, at: Date.now() });
  return map;
}

/** Nilai teks satu kunci; `def` dipakai bila kuncinya belum ada sama sekali. */
async function nilai(idDataServer, kunci, def) {
  const m = await peta(idDataServer);
  const v = m[kunci];
  if (v === undefined || v === '') return def !== undefined ? def : DEFAULT_APLIKASI[kunci];
  return v;
}

/** Angka, dengan penjagaan kalau isinya bukan angka. */
async function angka(idDataServer, kunci, def) {
  const mentah = await nilai(idDataServer, kunci, DEFAULT_APLIKASI[kunci]);
  const n = Number(mentah);
  return Number.isFinite(n) ? n : Number(def);
}

/** Tulis satu kunci (upsert) — hanya kunci yang dikenal. */
async function simpan(idDataServer, kunci, nilaiBaru) {
  const n = idWajib(idDataServer);
  const k = String(kunci);
  if (!KUNCI_BISA_DISIMPAN.includes(k)) throw new Error(`Kunci pengaturan ${k} tidak dikenali`);
  const teks = nilaiBaru === null || nilaiBaru === undefined ? '' : String(nilaiBaru).slice(0, 2000);
  await db.run(
    `INSERT INTO setting_app (id_data_server, kunci, nilai) VALUES (?,?,?)
     ON DUPLICATE KEY UPDATE nilai=VALUES(nilai)`,
    [n, k, teks]
  );
  invalidate(n);
  return teks;
}

/** Isi sekalian; nilai yang bukan kunci dikenal dilewati diam-diam (form mengirim utuh). */
async function simpanBanyak(idDataServer, isi) {
  const hasil = [];
  for (const [k, val] of Object.entries(isi || {})) {
    if (!KUNCI_BISA_DISIMPAN.includes(k)) continue;
    await simpan(idDataServer, k, val);
    hasil.push(k);
  }
  return hasil;
}

/**
 * Baris awal tenant baru supaya halaman Pengaturan tidak kosong dan
 * monitoring tidak jatuh ke nilai ISP lain.
 * `isi` boleh menimpa sebagian kunci (mis. app_name = nama ISP).
 */
async function seed(idDataServer, isi = {}) {
  const n = idWajib(idDataServer);
  const gabungan = { ...DEFAULT_APLIKASI, ...isi };
  for (const [k, val] of Object.entries(gabungan)) {
    if (!KUNCI_BISA_DISIMPAN.includes(k)) continue;
    await db.run(
      `INSERT INTO setting_app (id_data_server, kunci, nilai) VALUES (?,?,?)
       ON DUPLICATE KEY UPDATE kunci=kunci`,
      [n, k, val === null ? '' : String(val)]
    );
  }
  invalidate(n);
  return Object.keys(gabungan).filter(k => KUNCI_BISA_DISIMPAN.includes(k));
}

function invalidate(id) {
  if (id === undefined || id === null) cache.clear();
  else cache.delete(Number(id));
}

module.exports = {
  DEFAULT_APLIKASI, KUNCI_BISA_DISIMPAN,
  peta, nilai, angka, simpan, simpanBanyak, seed, invalidate,
  idWajib
};
