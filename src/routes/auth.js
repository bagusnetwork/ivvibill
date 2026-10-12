'use strict';
// ============================================================
// Auth API: login (app_user ATAU master data_server), logout,
// profil, pindah tenant, ganti password.
// Proteksi: rate-limit + lock akun app_user setelah N gagal.
// ============================================================
const express = require('express');
const bcrypt = require('bcryptjs');
const rateLimit = require('express-rate-limit');
const db = require('../db');
const v = require('../util/validate');
const config = require('../config');
const cfgData = require('../services/configData');
const cfgApp = require('../services/configApp');
const { daftarTenant } = require('../util/scope');
const {
  signToken, setAuthCookie, clearAuthCookie, requireAuth,
  muatMaster, muatAppUser
} = require('../middleware/auth');

const router = express.Router();

const loginLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Terlalu banyak percobaan, coba lagi nanti' }
});

/** Tenant mana yang boleh dipakai identitas ini, + tenant aktif terpilih. */
function pilihTenant(ids, diminta) {
  if (!ids) return Number(diminta) || 1;            // pemilik platform: bebas
  const boleh = ids.includes(Number(diminta)) ? Number(diminta) : ids[0];
  return boleh;
}

/** Ringkasan tenant untuk dropdown pemilih di panel. */
async function daftarServerUser(user) {
  if (!user.ids) {
    return db.q(`SELECT id, nama_server FROM data_server WHERE status = 'Aktif' ORDER BY id`);
  }
  // db.q memakai pool.execute — daftar id harus jadi banyak placeholder '?',
  // bukan satu placeholder dengan nilai array.
  const ph = user.ids.map(() => '?').join(',');
  return db.q(
    `SELECT id, nama_server FROM data_server WHERE status = 'Aktif'
       AND id IN (${ph}) ORDER BY id`,
    user.ids
  );
}

/** Catat percobaan login + alasannya (untuk diagnosis admin, bukan untuk pemohon). */
function catatLogin(username, ip, alasan) {
  return db.insert(
    'INSERT INTO login_attempt (username, ip, success, alasan) VALUES (?,?,?,?)',
    [username, ip, alasan === 'sukses' ? 1 : 0, alasan]);
}

router.post('/login', loginLimiter, async (req, res, next) => {
  try {
    const username = v.username(req.body.username);
    const pass = String(req.body.password || '');
    if (!pass) throw new Error('Password wajib diisi');
    const ip = (req.ip || '').replace('::ffff:', '');
    const dsDiminta = req.body.ds ? Number(req.body.ds) : null;

    const user = await db.one('SELECT * FROM app_user WHERE username = ?', [username]);
    if (user) {
      const ok = await bcrypt.compare(pass, user.password_hash);
      // `alasan` hanya dilihat admin (GET /api/pengguna/login-gagal); respons ke
      // pemohon tetap umum supaya tidak memandu penebak sandi/akun.
      await catatLogin(username, ip,
        !ok ? 'sandi_salah' : user.status !== 'aktif' ? 'akun_blokir' : 'sukses');
      if (user.status !== 'aktif') return res.status(403).json({ error: 'Akun diblokir' });
      if (!ok) {
        const gagal = (user.gagal_login || 0) + 1;
        await db.run('UPDATE app_user SET gagal_login = ? WHERE id = ?', [gagal, user.id]);
        // Ambang kunci dibaca dari setting_app milik tenant akun ini. Sebelumnya
        // angka global config/security dipakai untuk semua ISP, sehingga kunci
        // 'batas_gagal_login' yang diisi ISP tidak pernah benar-benar berlaku.
        const ambang = await cfgApp.angka(
          pilihTenant(daftarTenant(user.id_data_server), dsDiminta),
          'batas_gagal_login', config.security.maxLoginFail);
        if (gagal >= ambang) {
          await db.run(`UPDATE app_user SET status='blokir' WHERE id=?`, [user.id]);
        }
        return res.status(401).json({ error: 'Username atau password salah' });
      }
      await db.run('UPDATE app_user SET gagal_login = 0, last_login = NOW() WHERE id = ?', [user.id]);
      const identitas = await muatAppUser(user.id);
      if (!identitas) return res.status(403).json({ error: 'Akun tidak aktif' });
      if (!identitas.ids && identitas.role !== 'superadmin') {
        // akun role tanpa tenant = tidak punya rumah aplikasi mana pun; ini sering
        // terjadi karena kolom Data Server dulu boleh dibiarkan kosong di form.
        await catatLogin(username, ip, 'belum_tenant');
        return res.status(403).json({ error: 'Akun belum ditautkan ke data server, hubungi admin' });
      }
      if (!identitas.id_ref && (identitas.role === 'agen' || identitas.role === 'pelanggan')) {
        await catatLogin(username, ip, 'belum_ref');
        return res.status(403).json({
          error: `Akun ${identitas.role} belum ditautkan ke data ${identitas.role === 'agen' ? 'agen' : 'pelanggan'}, hubungi admin` });
      }
      const ds = pilihTenant(identitas.ids, dsDiminta);
      // Staff ISP yang berlangganannya habis tidak boleh masuk (403 yang jelas),
      // sama seperti jalur master di bawah. Pemilik platform tidak dicek.
      if (identitas.ids) {
        const srv = await cfgData.getServer(ds).catch(() => null);
        const alasanSrv = !srv ? 'server_tidak_ada'
          : srv.status !== 'Aktif' ? 'server_nonaktif'
          : cfgData.habisMasa(srv) ? 'langganan_habis' : 'sukses';
        if (alasanSrv !== 'sukses') {
          await catatLogin(username, ip, alasanSrv);
          return res.status(403).json({
            error: alasanSrv === 'langganan_habis'
              ? 'Masa langganan data server ini sudah berakhir, hubungi pemilik platform'
              : 'Data server tidak aktif'
          });
        }
      }
      await db.insert(
        'INSERT INTO audit_log (user_id, id_data_server, aksi, detail, ip) VALUES (?,?,?,?,?)',
        [identitas.id, ds, 'login', `Login ${identitas.role}`, ip]);
      const token = signToken(identitas, ds);
      setAuthCookie(res, token);
      return res.json({
        token,
        user: {
          id: identitas.id, username: identitas.username, nama: identitas.nama,
          role: identitas.role, tipe: identitas.tipe, id_ref: identitas.id_ref,
          ds, ids: identitas.ids, servers: await daftarServerUser(identitas)
        },
        merek: await cfgData.merek(ds)
      });
    }

    // bukan app_user → coba akun master ISP (kolom username/password_hash di data_server)
    const srv = await db.one('SELECT * FROM data_server WHERE username = ?', [username]);
    // sandi diperiksa sebelum status/expire: akun master yang hidup tapi
    // nonaktif tidak lagi membisikkan kondisinya ke penebak sandi.
    const habis = cfgData.habisMasa(srv);
    const alasan = !srv ? 'username_tidak_ada'
      : !srv.password_hash ? 'master_tanpa_sandi'
      : !(await bcrypt.compare(pass, srv.password_hash)) ? 'sandi_salah'
      : srv.status !== 'Aktif' ? 'server_nonaktif'
      : habis ? 'langganan_habis' : 'sukses';
    await catatLogin(username, ip, alasan);
    if (alasan === 'username_tidak_ada' || alasan === 'master_tanpa_sandi' || alasan === 'sandi_salah') {
      return res.status(401).json({ error: 'Username atau password salah' });
    }
    if (alasan === 'server_nonaktif') return res.status(403).json({ error: 'Data server tidak aktif' });
    if (alasan === 'langganan_habis') {
      return res.status(403).json({ error: 'Masa langganan data server ini sudah berakhir' });
    }
    const identitas = await muatMaster(srv.id);
    const ds = pilihTenant(identitas.ids, dsDiminta || srv.id);
    await db.insert(
      'INSERT INTO audit_log (user_id, id_data_server, aksi, detail, ip) VALUES (?,?,?,?,?)',
      [null, ds, 'login', `Login master ${srv.nama_server}`, ip]);
    const token = signToken(identitas, ds);
    setAuthCookie(res, token);
    res.json({
      token,
      user: {
        id: identitas.id, username: identitas.username, nama: identitas.nama,
        role: identitas.role, tipe: identitas.tipe, id_ref: null,
        ds, ids: identitas.ids, servers: await daftarServerUser(identitas)
      },
      merek: await cfgData.merek(ds)
    });
  } catch (e) { next(e); }
});

router.post('/logout', (req, res) => {
  clearAuthCookie(res);
  res.json({ ok: true });
});

/** Pindah tenant aktif — hanya ke tenant yang memang milik user. */
router.post('/server', requireAuth, async (req, res, next) => {
  try {
    const id = v.num(req.body.id, { int: true, min: 1 });
    if (req.user.ids && !req.user.ids.includes(id)) {
      return res.status(403).json({ error: 'Anda tidak punya akses ke data server itu' });
    }
    const ada = await db.one(
      `SELECT id, nama_server, status, expaired_date FROM data_server WHERE id = ? AND status = 'Aktif'`, [id]);
    if (!ada) return res.status(404).json({ error: 'Data server tidak ada / tidak aktif' });
    if (cfgData.habisMasa(ada) && !req.tenantSemua) {
      return res.status(403).json({ error: 'Masa langganan data server itu sudah berakhir' });
    }
    const token = signToken(req.user, id);
    setAuthCookie(res, token);
    res.json({ ok: true, ds: id, nama_server: ada.nama_server, merek: await cfgData.merek(id) });
  } catch (e) { next(e); }
});

router.get('/servers', requireAuth, async (req, res, next) => {
  try { res.json({ data: await daftarServerUser(req.user), ds: req.ds }); }
  catch (e) { next(e); }
});

router.get('/me', requireAuth, async (req, res, next) => {
  try {
    const { akses, ...ringan } = req.user;
    res.json({
      user: ringan, ds: req.ds, tenantSemua: req.tenantSemua,
      akses: akses || { menu: 'all' }, servers: await daftarServerUser(req.user),
      // branding tenant aktif — dipakai header/login card tiap aplikasi
      merek: await cfgData.merek(req.ds)
    });
  } catch (e) { next(e); }
});

router.post('/ganti-password', requireAuth, async (req, res, next) => {
  try {
    const lama = String(req.body.lama || '');
    const baru = v.password(req.body.baru);
    const hash = await bcrypt.hash(baru, config.security.bcryptRounds);

    if (req.user.tipe === 'master') {
      const srv = await db.one('SELECT password_hash FROM data_server WHERE id = ?', [req.user.id]);
      if (!srv || !srv.password_hash || !(await bcrypt.compare(lama, srv.password_hash))) {
        return res.status(400).json({ error: 'Password lama salah' });
      }
      await db.run('UPDATE data_server SET password_hash = ? WHERE id = ?', [hash, req.user.id]);
    } else {
      const user = await db.one('SELECT * FROM app_user WHERE id = ?', [req.user.id]);
      if (!(await bcrypt.compare(lama, user.password_hash))) {
        return res.status(400).json({ error: 'Password lama salah' });
      }
      await db.run('UPDATE app_user SET password_hash = ? WHERE id = ?', [hash, req.user.id]);
    }
    await db.insert(
      'INSERT INTO audit_log (user_id, id_data_server, aksi, detail, ip) VALUES (?,?,?,?,?)',
      [req.user.tipe === 'master' ? null : req.user.id, req.ds, 'ganti_password', '',
       (req.ip || '').replace('::ffff:', '')]);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

module.exports = router;
