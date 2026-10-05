'use strict';
// ============================================================
// Autentikasi (JWT) + RBAC + guard cron/internal
// ============================================================
const jwt = require('jsonwebtoken');
const config = require('../config');
const db = require('../db');

const COOKIE = 'ivvi_token';

function signToken(user) {
  return jwt.sign(
    { sub: user.id, role: user.role, nama: user.nama, id_ref: user.id_ref || null },
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

/** Wajib login — lolos bila JWT valid. */
async function requireAuth(req, res, next) {
  try {
    const token = extractToken(req);
    if (!token) return res.status(401).json({ error: 'Belum login' });
    const payload = jwt.verify(token, config.jwt.secret, { issuer: 'ivvibill' });
    const user = await db.one(
      'SELECT id, username, nama, role, id_ref, status FROM app_user WHERE id = ?',
      [payload.sub]
    );
    if (!user || user.status !== 'aktif') {
      return res.status(401).json({ error: 'Akun tidak aktif' });
    }
    req.user = user;
    next();
  } catch (e) {
    return res.status(401).json({ error: 'Sesi berakhir, silakan login ulang' });
  }
}

/** Hanya role tertentu. Contoh: requireRole('superadmin') */
function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Belum login' });
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'Akses ditolak' });
    }
    next();
  };
}

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
  requireAuth, requireRole, requireInternal
};
