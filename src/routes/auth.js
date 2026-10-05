'use strict';
// ============================================================
// Auth API: login, logout, profil, ganti password
// Proteksi: rate-limit + lock akun setelah N gagal.
// ============================================================
const express = require('express');
const bcrypt = require('bcryptjs');
const rateLimit = require('express-rate-limit');
const db = require('../db');
const v = require('../util/validate');
const config = require('../config');
const { signToken, setAuthCookie, clearAuthCookie, requireAuth } = require('../middleware/auth');

const router = express.Router();

const loginLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Terlalu banyak percobaan, coba lagi nanti' }
});

router.post('/login', loginLimiter, async (req, res, next) => {
  try {
    const username = v.username(req.body.username);
    const pass = String(req.body.password || '');
    if (!pass) throw new Error('Password wajib diisi');
    const ip = (req.ip || '').replace('::ffff:', '');

    const user = await db.one('SELECT * FROM app_user WHERE username = ?', [username]);
    const ok = user && (await bcrypt.compare(pass, user.password_hash));

    await db.insert('INSERT INTO login_attempt (username, ip, success) VALUES (?,?,?)',
      [username, ip, ok ? 1 : 0]);

    if (!user) return res.status(401).json({ error: 'Username atau password salah' });

    if (user.status !== 'aktif') return res.status(403).json({ error: 'Akun diblokir' });

    if (!ok) {
      const gagal = (user.gagal_login || 0) + 1;
      const patch = gagal >= config.security.maxLoginFail
        ? { gagal: gagal, status: 'blokir' }
        : { gagal: gagal };
      await db.run('UPDATE app_user SET gagal_login = ? WHERE id = ?', [patch.gagal, user.id]);
      if (patch.status) await db.run(`UPDATE app_user SET status='blokir' WHERE id=?`, [user.id]);
      return res.status(401).json({ error: 'Username atau password salah' });
    }

    await db.run('UPDATE app_user SET gagal_login = 0, last_login = NOW() WHERE id = ?', [user.id]);
    await db.insert('INSERT INTO audit_log (user_id, aksi, detail, ip) VALUES (?,?,?,?)',
      [user.id, 'login', `Login ${user.role}`, ip]);

    const token = signToken(user);
    setAuthCookie(res, token);
    res.json({
      token,
      user: { id: user.id, username: user.username, nama: user.nama, role: user.role, id_ref: user.id_ref }
    });
  } catch (e) { next(e); }
});

router.post('/logout', (req, res) => {
  clearAuthCookie(res);
  res.json({ ok: true });
});

router.get('/me', requireAuth, async (req, res) => {
  res.json({ user: req.user });
});

router.post('/ganti-password', requireAuth, async (req, res, next) => {
  try {
    const lama = String(req.body.lama || '');
    const baru = v.password(req.body.baru);
    const user = await db.one('SELECT * FROM app_user WHERE id = ?', [req.user.id]);
    if (!(await bcrypt.compare(lama, user.password_hash))) {
      return res.status(400).json({ error: 'Password lama salah' });
    }
    const hash = await bcrypt.hash(baru, config.security.bcryptRounds);
    await db.run('UPDATE app_user SET password_hash = ? WHERE id = ?', [hash, req.user.id]);
    await db.insert('INSERT INTO audit_log (user_id, aksi, detail, ip) VALUES (?,?,?,?)',
      [req.user.id, 'ganti_password', '', (req.ip || '').replace('::ffff:', '')]);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

module.exports = router;
