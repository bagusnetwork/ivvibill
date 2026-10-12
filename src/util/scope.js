'use strict';
// ============================================================
// Scoping tenant (data_server) + grant menu.
//
// Konvensi meniru gratisinaja:
//  - tabel yang punya kolom id_data_server difilter langsung;
//  - tabel anak (pembayaran, tiket, interface_log, dst.) dijangkau
//    lewat JOIN ke induknya, jadi cukup menyebut kolom induk dengan alias;
//  - tulisan baru selalu dipaksa ke tenant aktif, tidak pernah
//    memakai nilai dari body.
//
// Catatan: db.js memakai pool.execute() (prepared statement), jadi daftar
// tenant dibangun sebagai placeholder '?',?,? — bukan array tunggal.
// ============================================================

/** '1,5' / 1 / [1,5] → [1,5]; kosong atau 'all' → null (= semua tenant). */
function daftarTenant(nilai) {
  if (nilai === null || nilai === undefined || nilai === '') return null;
  if (Array.isArray(nilai)) nilai = nilai.join(',');
  const ids = String(nilai).split(',').map(s => Number(s.trim())).filter(n => Number.isInteger(n) && n > 0);
  return ids.length ? [...new Set(ids)] : null;
}

/**
 * Daftar tenant yang menjadi sekat BACA pada request ini — selalu data server
 * yang sedang dipilih (req.ds), untuk pemilik platform maupun staf.
 *
 *   [n]   = satu data server aktif;
 *   [...] = seluruh tenant milik akun bila tenant aktif tidak ada di daftarnya
 *           (hanya pertahanan — tidak pernah mengembalikan data orang lain);
 *   []    = tidak punya tenant sama sekali → tenantSql memberi 'AND 1 = 0'.
 *
 * Perubahan v2.1.1: dulu pemilik platform (tenantSemua) sengaja tanpa filter,
 * sehingga dasbor berlabel "IVVI Network" menampilkan 171 pelanggan dan
 * Rp 26.215.000 milik IVVINET-CBD — angka gabungan semua ISP dengan label satu
 * ISP. Rekap lintas ISP sekarang ada di menu Data Server (GET /api/data-server),
 * yang memang menghitung per tenant, bukan di halaman berlabel satu tenant.
 *
 * Kepitisan v2.1.1: pemilik platform boleh meminta cakupan lain SECARA EKSPLISIT
 * lewat query string — `?ds=all` (semua tenant, bernilai null) atau `?ds=N`.
 * Dipakai dropdown referensi di form (grup akses, paket) ketika adminmaster
 * menyetel akun/pelanggan milik tenant yang bukan tenant aktifnya. Tanpa `?ds=`
 * hasilnya tetap satu tenant aktif, jadi tidak ada halaman yang diam-diam
 * menampilkan gabungan.
 */
function sekatBaca(req) {
  if (!req.user) throw new Error('sekatBaca: req.user belum ada (butuh requireAuth)');
  const minta = (req.query || {}).ds;
  if (req.tenantSemua && minta) {
    if (String(minta).toLowerCase() === 'all') return null;
    const n = Number(minta);
    if (Number.isInteger(n) && n >= 1) return [n];
  }
  const ids = (req.user.ids || []).map(Number).filter((n) => Number.isInteger(n) && n > 0);
  const aktif = Number(req.ds);
  const sah = Number.isInteger(aktif) && aktif >= 1;
  if (sah && (!ids.length || ids.includes(aktif))) return [aktif];
  return ids;
}

/**
 * Klausa AND untuk kolom tenant.
 * return { sql, params } — sql kosong hanya di `?ds=all` milik pemilik
 * platform; ' AND 1 = 0' bila tenant-nya tidak ada (jangan pernah bocor data).
 */
function tenantSql(req, kolom = 'id_data_server') {
  const list = sekatBaca(req);
  if (list === null) return { sql: '', params: [] };
  if (!list.length) return { sql: ' AND 1 = 0', params: [] };
  return { sql: ` AND ${kolom} IN (${list.map(() => '?').join(',')})`, params: list };
}

/** Tenant aktif untuk INSERT/UPDATE — satu angka, bukan daftar. */
function tenantAktif(req) {
  const ds = Number(req.ds);
  if (!Number.isInteger(ds) || ds < 1) {
    const e = new Error('Tenant aktif tidak valid — pilih satu data server terlebih dahulu');
    e.status = 400;
    throw e;
  }
  return ds;
}

/**
 * app_user.id_data_server menyimpan CSV ('1,5'), jadi keanggotaan tenant
 * diperiksa dengan FIND_IN_SET, bukan IN.
 *
 * Akun platform (id_data_server kosong) ikut terlihat oleh pemilik platform
 * saja — kalau tidak, setelah sekat diperketat adminmaster tidak bisa lagi
 * melihat / mengelola sesamanya sendiri di menu Pengguna.
 */
function tenantUserSql(req, kolom = 'id_data_server') {
  const list = sekatBaca(req);
  if (list === null) return { sql: '', params: [] };
  if (!list.length && !req.tenantSemua) return { sql: ' AND 1 = 0', params: [] };
  const frg = list.map(() => `FIND_IN_SET(?, ${kolom})`).join(' OR ');
  const milikPlatform = req.tenantSemua ? ` OR ${kolom} IS NULL OR ${kolom} = ''` : '';
  if (!frg) return { sql: ` AND (${kolom} IS NULL OR ${kolom} = '')`, params: [] };
  return { sql: ` AND (${frg}${milikPlatform})`, params: list };
}

/**
 * Fragmen IN (n,n) dengan angka yang sudah divalidasi — dipakai pada query
 * agregat berisi banyak subquery (dashboard), di mana urutan parameter
 * lebih rawan salah daripada menyisipkan integer hasil sanitize.
 */
function tenantFrag(req, kolom = 'id_data_server') {
  const list = sekatBaca(req);
  if (list === null) return '';
  if (!list.length) return ' AND 1 = 0';
  return ` AND ${kolom} IN (${list.join(',')})`;
}

/** Parse JSON grant menu; bentuk {"menu":"all"} berarti semua menu. */
function aksesObjek(row) {
  if (!row || !row.akses) return null;
  try { return JSON.parse(row.akses); } catch (_) { return null; }
}

/**
 * Boleh/tidaknya satu aksi pada satu menu.
 * Tanpa grup = akses penuh ke tenant-nya (kompatibel dengan user lama);
 * grup yang punya entri menu membatasi halaman & sub-aksinya.
 */
function bolehMenu(req, menu, aksi = null) {
  const u = req.user || {};
  if (u.tipe === 'master' || u.role === 'superadmin') return true;
  const a = u.akses;
  if (!a || a.menu === 'all') return true;
  const grant = (a.menu || {})[menu];
  if (grant === undefined) return false;
  if (grant === true || grant === 'all') return true;
  if (!aksi) return true;
  const daftar = [].concat(grant.sub_menu || [], grant.halaman || []);
  return daftar.includes(aksi);
}

/** Middleware: tolak aksi di luar grant menu. */
function requireMenu(menu, aksi = null) {
  return (req, res, next) =>
    bolehMenu(req, menu, aksi) ? next() : res.status(403).json({ error: 'Akses ditolak untuk menu ini' });
}

module.exports = {
  daftarTenant, sekatBaca, tenantSql, tenantAktif, tenantUserSql, tenantFrag,
  aksesObjek, bolehMenu, requireMenu
};
