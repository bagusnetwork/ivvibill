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
 * Klausa AND untuk kolom tenant.
 * return { sql, params } — sql kosong bila user pemilik platform (semua tenant),
 * sql ' AND 1 = 0' bila tenant-nya tidak ada (jangan pernah bocor data).
 */
function tenantSql(req, kolom = 'id_data_server') {
  if (!req.user) throw new Error('tenantSql: req.user belum ada (butuh requireAuth)');
  if (req.tenantSemua) return { sql: '', params: [] };
  const ids = (req.user.ids || []).map(Number).filter(n => Number.isInteger(n) && n > 0);
  if (!ids.length) return { sql: ' AND 1 = 0', params: [] };
  return { sql: ` AND ${kolom} IN (${ids.map(() => '?').join(',')})`, params: ids };
}

/** Tenant aktif untuk INSERT/UPDATE — satu angka, bukan daftar. */
function tenantAktif(req) {
  const ds = Number(req.ds);
  if (!Number.isInteger(ds) || ds < 1) throw new Error('tenantAktif: tenant aktif tidak valid');
  return ds;
}

/**
 * app_user.id_data_server menyimpan CSV ('1,5'), jadi keanggotaan tenant
 * diperiksa dengan FIND_IN_SET, bukan IN.
 */
function tenantUserSql(req, kolom = 'id_data_server') {
  if (!req.user) throw new Error('tenantUserSql: req.user belum ada');
  if (req.tenantSemua) return { sql: '', params: [] };
  const ids = (req.user.ids || []).map(Number).filter(n => Number.isInteger(n) && n > 0);
  if (!ids.length) return { sql: ' AND 1 = 0', params: [] };
  return { sql: ` AND (${ids.map(() => `FIND_IN_SET(?, ${kolom})`).join(' OR ')})`, params: ids };
}

/**
 * Fragmen IN (n,n) dengan angka yang sudah divalidasi — dipakai pada query
 * agregat berisi banyak subquery (dashboard), di mana urutan parameter
 * lebih rawan salah daripada menyisipkan integer hasil sanitize.
 */
function tenantFrag(req, kolom = 'id_data_server') {
  if (req.tenantSemua) return '';
  const ids = (req.user.ids || []).map(Number).filter(n => Number.isInteger(n) && n > 0);
  if (!ids.length) return ' AND 1 = 0';
  return ` AND ${kolom} IN (${ids.join(',')})`;
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
  daftarTenant, tenantSql, tenantAktif, tenantUserSql, tenantFrag,
  aksesObjek, bolehMenu, requireMenu
};
