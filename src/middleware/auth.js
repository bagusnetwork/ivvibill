'use strict';
// ============================================================
// Autentikasi (JWT) + RBAC + tenant aktif + guard cron/internal
//
// Dua jenis identitas (meniru gratisinaja):
//   tipe 'master' → baris data_server: pemilik satu ISP. id 1 adalah
//          pemilik platform, jadi boleh melihat semua tenant.
//   tipe 'user'  → baris app_user: bawahan (superadmin platform, agen,
//          teknisi, pelanggan) dengan daftar tenant di id_data_server.
// ============================================================
const jwt = require('jsonwebtoken');
const config = require('../config');
const db = require('../db');
const { daftarTenant, aksesObjek } = require('../util/scope');

const COOKIE = 'ivvi_token';

/** Token hanya menyimpan "siapa + tenant aktif"; hak akses dibaca ulang dari DB. */
function signToken(user, ds) {
  return jwt.sign(
    {
      sub: user.id,
      tipe: user.tipe || 'user',
      role: user.role,
      nama: user.nama,
      id_ref: user.id_ref || null,
      ds: Number(ds) || null
    },
    config.jwt.secret,
    { expiresIn: config.jwt.ttl, issuer: 'ivvibill' }
  );
}

function setAuthCookie(res, token) {
  res.cookie(COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: config.app.baseUrl.startsWith('https'),
    maxAge: 12 * 60 * 60 * 1000,
    path: '/'
  });
}

function clearAuthCookie(res) {
  res.clearCookie(COOKIE, { path: '/' });
}

function extractToken(req) {
  const h = req.headers.authorization || '';
  if (h.startsWith('Bearer ')) return h.slice(7);
  if (req.cookies && req.cookies[COOKIE]) return req.cookies[COOKIE];
  return null;
}

async function muatMaster(id) {
  const ds = await db.one(
    `SELECT id, nama_server, username, status, prefix_invoice FROM data_server WHERE id = ?`, [id]
  );
  if (!ds || ds.status !== 'Aktif') return null;
  return {
    id: ds.id, username: ds.username || `server-${ds.id}`, nama: ds.nama_server,
    role: 'master', tipe: 'master', id_ref: null, prefix: ds.prefix_invoice,
    // pemilik platform (tenant 1) bebas memilih tenant mana pun
    ids: ds.id === 1 ? null : [ds.id], akses: null
  };
}

async function muatAppUser(id) {
  const u = await db.one(
    `SELECT id, username, nama, role, id_ref, status, id_data_server, id_group_akses
     FROM app_user WHERE id = ?`, [id]
  );
  if (!u || u.status !== 'aktif') return null;
  let akses = null;
  if (u.id_group_akses) {
    const g = await db.one(
      `SELECT g.akses, g.status FROM group_akses g WHERE g.id = ?`, [u.id_group_akses]
    );
    if (g && g.status === 'aktif') akses = aksesObjek(g);
  }
  return { ...u, tipe: 'user', akses, ids: daftarTenant(u.id_data_server) };
}

/** Wajib login — lolos bila JWT valid dan identitasnya masih hidup. */
async function requireAuth(req, res, next) {
  try {
    const token = extractToken(req);
    if (!token) return res.status(401).json({ error: 'Belum login' });
    const payload = jwt.verify(token, config.jwt.secret, { issuer: 'ivvibill' });

    const user = payload.tipe === 'master'
      ? await muatMaster(payload.sub)
      : await muatAppUser(payload.sub);
    if (!user) return res.status(401).json({ error: 'Akun tidak aktif' });

    if (!user.ids && user.role !== 'superadmin' && user.tipe !== 'master') {
      return res.status(403).json({ error: 'Akun belum ditautkan ke data server' });
    }

    let ds = Number(payload.ds) || (user.ids ? user.ids[0] : 1);
    if (user.ids && !user.ids.includes(ds)) ds = user.ids[0];
    req.user = user;
    req.ds = ds;
    req.tenantSemua = !user.ids;      // true hanya untuk pemilik platform
    next();
  } catch (e) {
    return res.status(401).json({ error: 'Sesi berakhir, silakan login ulang' });
  }
}

/** Hanya role tertentu. Contoh: requireRole('superadmin', 'master') */
function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Belum login' });
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'Akses ditolak' });
    }
    next();
  };
}

/** Penanggung jawab tenant: pemilik ISP (master) atau superadmin platform. */
const requirePJ = (...tambahan) =>
  requireRole('superadmin', 'master', ...tambahan);

/** Guard endpoint internal (cron/webhook): IP harus dipercaya atau token cocok. */
function requireInternal(req, res, next) {
  const ip = (req.ip || req.socket?.remoteAddress || '').replace('::ffff:', '');
  const okIp = config.server.trustedIps.includes(ip);
  const tok = req.headers['x-internal-token'] || req.query.token;
  const okTok = tok && tok === (process.env.CRON_TOKEN || config.jwt.secret);
  if (okIp || okTok) return next();
  return res.status(403).json({ error: 'Forbidden' });
}

module.exports = {
  COOKIE, signToken, setAuthCookie, clearAuthCookie,
  muatMaster, muatAppUser, requireAuth, requireRole, requirePJ, requireInternal
};
