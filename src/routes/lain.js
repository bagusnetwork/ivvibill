'use strict';
// ============================================================
// Rute pendukung: dashboard, tiket, pekerjaan teknisi,
// issue pelanggan, pengguna, pengaturan, log WA.
// ============================================================
const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db');
const v = require('../util/validate');
const config = require('../config');
const { requireAuth, requireRole } = require('../middleware/auth');
const wa = require('../services/wa');
const cfgData = require('../services/configData');

const router = express.Router();
router.use(requireAuth);

// ------------------------------------------------------ dashboard
router.get('/dashboard', async (req, res, next) => {
  try {
    const role = req.user.role;
    const scope = role === 'pelanggan' ? [req.user.id_ref] : null;

    const dasbor = {};
    if (role === 'superadmin' || role === 'teknisi') {
      const [jml] = await db.q(
        `SELECT
          (SELECT COUNT(*) FROM pelanggan WHERE status='aktif') AS pelanggan_aktif,
          (SELECT COUNT(*) FROM pelanggan WHERE status='isolir') AS pelanggan_isolir,
          (SELECT COUNT(*) FROM tagihan WHERE status='lunas' AND paid_at >= DATE_FORMAT(NOW(), '%Y-%m-01')) AS lunas_bulan_ini,
          (SELECT IFNULL(SUM(total),0) FROM tagihan WHERE status='lunas' AND paid_at >= DATE_FORMAT(NOW(), '%Y-%m-01')) AS pemasukan,
          (SELECT IFNULL(SUM(total),0) FROM tagihan WHERE status!='lunas') AS belum_lunas,
          (SELECT COUNT(*) FROM tagihan WHERE status='jatuh_tempo') AS jatuh_tempo,
          (SELECT COUNT(*) FROM issue_pelanggan WHERE status='open') AS issue_open,
          (SELECT COUNT(*) FROM tiket WHERE status IN ('baru','diproses')) AS tiket_open,
          (SELECT COUNT(*) FROM voucher WHERE status='stok') AS voucher_stok,
          (SELECT COUNT(*) FROM pelanggan WHERE tipe='pppoe' AND status='aktif') AS pppoe_aktif,
          (SELECT COUNT(*) FROM pelanggan WHERE tipe='hotspot' AND status='aktif') AS hotspot_aktif`);
      dasbor.ringkas = jml;
      dasbor.olt = await db.q(
        `SELECT d.nama, d.brand, s.last_check_at, s.last_check_msg, s.status FROM setting_olt s
         JOIN master_perangkat d ON d.id=s.id_perangkat ORDER BY d.nama`);
      dasbor.router = await db.q(
        `SELECT s.nama, s.status, s.cpu_load, s.memory_usage, s.last_check FROM setting_mikrotik s`);
      dasbor.issue = await db.q(
        `SELECT i.*, p.nama AS nama_pelanggan FROM issue_pelanggan i
         JOIN pelanggan p ON p.id=i.id_pelanggan
         WHERE i.status='open' ORDER BY i.id DESC LIMIT 10`);
    } else if (role === 'pelanggan') {
      const p = await db.one('SELECT * FROM pelanggan WHERE id = ?', [req.user.id_ref]);
      dasbor.profil = p;
      dasbor.tagihan = await db.q(
        'SELECT * FROM tagihan WHERE id_pelanggan = ? ORDER BY id DESC LIMIT 6', [req.user.id_ref]);
      dasbor.status = await db.one('SELECT * FROM pppoe_status WHERE id_pelanggan = ?', [req.user.id_ref]);
    } else if (role === 'agen') {
      const a = await db.one('SELECT * FROM agen WHERE id = ?', [req.user.id_ref]);
      dasbor.saldo = a ? Number(a.saldo) : 0;
      dasbor.voucher = await db.q(
        `SELECT status, COUNT(*) AS jml FROM voucher WHERE id_agen = ? GROUP BY status`, [req.user.id_ref]);
      dasbor.pelanggan = await db.one(
        `SELECT COUNT(*) AS jml FROM pelanggan WHERE id_agen = ? AND status='aktif'`, [req.user.id_ref]);
    }
    res.json(dasbor);
  } catch (e) { next(e); }
});

// ----------------------------------------------------------- tiket
router.get('/tiket', async (req, res, next) => {
  try {
    const where = ['1=1'];
    const params = [];
    if (req.user.role === 'pelanggan') { where.push('t.id_pelanggan = ?'); params.push(req.user.id_ref); }
    if (req.user.role === 'teknisi') { where.push(`t.status IN ('baru','diproses','selesai')`); }
    const status = v.enumOf(req.query.status, ['baru', 'diproses', 'selesai', 'ditutup'], null);
    if (status) { where.push('t.status = ?'); params.push(status); }
    const rows = await db.q(
      `SELECT t.*, p.nama AS nama_pelanggan FROM tiket t
       JOIN pelanggan p ON p.id = t.id_pelanggan
       WHERE ${where.join(' AND ')} ORDER BY t.id DESC LIMIT 100`, params);
    res.json({ data: rows });
  } catch (e) { next(e); }
});

router.post('/tiket', requireAuth, async (req, res, next) => {
  try {
    const judul = v.str(req.body.judul, { min: 3, max: 150 });
    const pesan = v.str(req.body.pesan, { max: 5000, def: '' });
    const prioritas = v.enumOf(req.body.prioritas, ['rendah', 'sedang', 'tinggi'], 'sedang');
    let idPelanggan = null;

    if (req.user.role === 'pelanggan') {
      idPelanggan = req.user.id_ref;
    } else if (req.user.role === 'agen') {
      idPelanggan = v.num(req.body.id_pelanggan, { int: true, min: 1 });
      const p = await db.one('SELECT id_agen FROM pelanggan WHERE id = ?', [idPelanggan]);
      if (!p || Number(p.id_agen) !== Number(req.user.id_ref)) {
        return res.status(403).json({ error: 'Bukan pelanggan Anda' });
      }
    } else {
      idPelanggan = v.num(req.body.id_pelanggan, { int: true, min: 1 });
    }

    const id = await db.insert(
      'INSERT INTO tiket (id_pelanggan, judul, pesan, prioritas) VALUES (?,?,?,?)',
      [idPelanggan, judul, pesan, prioritas]);

    const p = await db.one('SELECT nama, nomor_whatsapp FROM pelanggan WHERE id = ?', [idPelanggan]);
    if (p && p.nomor_whatsapp) {
      const tpl = await wa.ambilTemplate('tiket', 1);
      const pesanWa = wa.render(tpl, { usr: p.nama, judul, inv: `TCK-${id}` });
      await wa.enqueue({ tujuan: p.nomor_whatsapp, jenis: 'tiket', pesan: pesanWa, idRef: id });
    }
    res.json({ id });
  } catch (e) { next(e); }
});

router.put('/tiket/:id', requireRole('superadmin', 'teknisi'), async (req, res, next) => {
  try {
    const id = v.num(req.params.id, { int: true, min: 1 });
    const t = await db.one('SELECT * FROM tiket WHERE id = ?', [id]);
    if (!t) return res.status(404).json({ error: 'Tiket tidak ada' });
    const status = v.enumOf(req.body.status, ['baru', 'diproses', 'selesai', 'ditutup'], t.status);
    const jawaban = v.str(req.body.jawaban, { max: 5000, def: t.jawaban });
    const idTeknisi = req.user.role === 'teknisi' ? req.user.id : (v.num(req.body.id_teknisi, { int: true, min: 1, def: t.id_teknisi }));
    await db.run('UPDATE tiket SET status=?, jawaban=?, id_teknisi=? WHERE id=?',
      [status, jawaban, idTeknisi, id]);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// ------------------------------------------------------ pekerjaan
router.get('/pekerjaan', requireRole('superadmin', 'teknisi'), async (req, res, next) => {
  try {
    const where = ['1=1'];
    const params = [];
    if (req.user.role === 'teknisi') { where.push('(k.id_teknisi = ? OR k.id_teknisi IS NULL)'); params.push(req.user.id); }
    const status = v.enumOf(req.query.status, ['antrian', 'dikerjakan', 'selesai', 'batal'], null);
    if (status) { where.push('k.status = ?'); params.push(status); }
    const rows = await db.q(
      `SELECT k.*, p.nama AS nama_teknisi FROM pekerjaan k
       LEFT JOIN app_user p ON p.id = k.id_teknisi
       WHERE ${where.join(' AND ')} ORDER BY k.id DESC LIMIT 100`, params);
    res.json({ data: rows });
  } catch (e) { next(e); }
});

router.post('/pekerjaan', requireRole('superadmin'), async (req, res, next) => {
  try {
    const jenis = v.enumOf(req.body.jenis, ['pasang', 'pindah', 'bongkar', 'perbaikan', 'survey'], 'pasang');
    const nama = v.str(req.body.nama, { min: 2, max: 100 });
    const alamat = v.str(req.body.alamat, { max: 255, def: null });
    const idPelanggan = v.num(req.body.id_pelanggan, { int: true, min: 1, def: null });
    const idTeknisi = v.num(req.body.id_teknisi, { int: true, min: 1, def: null });
    const tanggal = v.tgl(req.body.tanggal, new Date().toISOString().slice(0, 10));
    const id = await db.insert(
      `INSERT INTO pekerjaan (jenis, id_pelanggan, nama, alamat, id_teknisi, tanggal) VALUES (?,?,?,?,?,?)`,
      [jenis, idPelanggan, nama, alamat, idTeknisi, tanggal]);
    res.json({ id });
  } catch (e) { next(e); }
});

router.put('/pekerjaan/:id', requireRole('superadmin', 'teknisi'), async (req, res, next) => {
  try {
    const id = v.num(req.params.id, { int: true, min: 1 });
    const k = await db.one('SELECT * FROM pekerjaan WHERE id = ?', [id]);
    if (!k) return res.status(404).json({ error: 'Pekerjaan tidak ada' });
    const status = v.enumOf(req.body.status, ['antrian', 'dikerjakan', 'selesai', 'batal'], k.status);
    const catatan = v.str(req.body.catatan, { max: 5000, def: k.catatan });
    let idTeknisi = k.id_teknisi;
    if (req.user.role === 'teknisi') idTeknisi = req.user.id;
    await db.run('UPDATE pekerjaan SET status=?, catatan=?, id_teknisi=? WHERE id=?',
      [status, catatan, idTeknisi, id]);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// --------------------------------------------------------- issue
router.get('/issue', requireRole('superadmin', 'teknisi'), async (req, res, next) => {
  try {
    const rows = await db.q(
      `SELECT i.*, p.nama AS nama_pelanggan, p.username_pppoe FROM issue_pelanggan i
       JOIN pelanggan p ON p.id = i.id_pelanggan
       WHERE i.status = 'open' ORDER BY i.id DESC LIMIT 100`);
    res.json({ data: rows });
  } catch (e) { next(e); }
});

router.put('/issue/:id/selesai', requireRole('superadmin', 'teknisi'), async (req, res, next) => {
  try {
    const id = v.num(req.params.id, { int: true, min: 1 });
    await db.run(`UPDATE issue_pelanggan SET status='resolved', resolved_at=NOW() WHERE id=?`, [id]);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// ---------------------------------------------------- pengguna
router.get('/pengguna', requireRole('superadmin'), async (req, res, next) => {
  try {
    const rows = await db.q(
      `SELECT id, username, nama, role, id_ref, no_hp, status, gagal_login, last_login, created_at
       FROM app_user ORDER BY role, nama`);
    res.json({ data: rows });
  } catch (e) { next(e); }
});

router.post('/pengguna', requireRole('superadmin'), async (req, res, next) => {
  try {
    const username = v.username(req.body.username);
    const pass = v.password(req.body.password);
    const nama = v.str(req.body.nama, { min: 2, max: 100 });
    const role = v.enumOf(req.body.role, ['superadmin', 'agen', 'teknisi', 'pelanggan']);
    const idRef = v.num(req.body.id_ref, { int: true, min: 1, def: null });
    const nohp = v.phone(req.body.no_hp);

    const dup = await db.one('SELECT id FROM app_user WHERE username = ?', [username]);
    if (dup) return res.status(400).json({ error: 'Username sudah dipakai' });

    const hash = await bcrypt.hash(pass, config.security.bcryptRounds);
    const id = await db.insert(
      `INSERT INTO app_user (username, password_hash, nama, role, id_ref, no_hp) VALUES (?,?,?,?,?,?)`,
      [username, hash, nama, role, idRef, nohp]);
    await db.insert('INSERT INTO audit_log (user_id, aksi, detail, ip) VALUES (?,?,?,?)',
      [req.user.id, 'tambah_pengguna', `${username} [${role}]`, (req.ip || '').replace('::ffff:', '')]);
    res.json({ id });
  } catch (e) { next(e); }
});

router.put('/pengguna/:id', requireRole('superadmin'), async (req, res, next) => {
  try {
    const id = v.num(req.params.id, { int: true, min: 1 });
    const u = await db.one('SELECT * FROM app_user WHERE id = ?', [id]);
    if (!u) return res.status(404).json({ error: 'Pengguna tidak ada' });
    const nama = v.str(req.body.nama, { min: 2, max: 100, def: u.nama });
    const status = v.enumOf(req.body.status, ['aktif', 'blokir'], u.status);
    await db.run('UPDATE app_user SET nama=?, status=? WHERE id=?', [nama, status, id]);
    if (req.body.password) {
      const hash = await bcrypt.hash(v.password(req.body.password), config.security.bcryptRounds);
      await db.run('UPDATE app_user SET password_hash=? WHERE id=?', [hash, id]);
    }
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// -------------------------------------------------- pengaturan
router.get('/setting', requireRole('superadmin'), async (req, res, next) => {
  try {
    const srv = await cfgData.getServer(1, true);
    const rows = await db.q('SELECT * FROM setting_app');
    const tpl = await db.q('SELECT * FROM pesan_template WHERE id_data_server = 1');
    res.json({
      data_server: {
        nama_server: srv.nama_server, nama_pemilik: srv.nama_pemilik,
        nomor_whatsapp: srv.nomor_whatsapp, email: srv.email, alamat: srv.alamat,
        jadwal_buat_hari: srv.jadwal_buat_hari, jadwal_kirim_hari: srv.jadwal_kirim_hari,
        jadwal_limit_hari: srv.jadwal_limit_hari, jam_kirim: srv.jam_kirim, ppn_persen: srv.ppn_persen
      },
      setting: rows, template: tpl
    });
  } catch (e) { next(e); }
});

router.put('/setting', requireRole('superadmin'), async (req, res, next) => {
  try {
    const b = req.body || {};
    const patch = [];
    const vals = [];
    const set = (col, val) => { patch.push(`${col}=?`); vals.push(val); };
    if (b.nama_server !== undefined) set('nama_server', v.str(b.nama_server, { min: 2, max: 100 }));
    if (b.nama_pemilik !== undefined) set('nama_pemilik', v.str(b.nama_pemilik, { max: 100, def: null }));
    if (b.nomor_whatsapp !== undefined) set('nomor_whatsapp', v.phone(b.nomor_whatsapp));
    if (b.alamat !== undefined) set('alamat', v.str(b.alamat, { max: 255, def: null }));
    if (b.jadwal_buat_hari !== undefined) set('jadwal_buat_hari', v.num(b.jadwal_buat_hari, { min: 1, max: 28, int: true }));
    if (b.jadwal_kirim_hari !== undefined) set('jadwal_kirim_hari', v.num(b.jadwal_kirim_hari, { min: 1, max: 28, int: true }));
    if (b.jadwal_limit_hari !== undefined) set('jadwal_limit_hari', v.num(b.jadwal_limit_hari, { min: 1, max: 28, int: true }));
    if (b.jam_kirim !== undefined) set('jam_kirim', v.str(b.jam_kirim, { min: 4, max: 5 }));
    if (b.ppn_persen !== undefined) set('ppn_persen', v.num(b.ppn_persen, { min: 0, max: 100 }));
    if (patch.length) {
      vals.push(1);
      await db.run(`UPDATE data_server SET ${patch.join(',')} WHERE id=?`, vals);
      cfgData.invalidate();
    }
    if (b.template && Array.isArray(b.template)) {
      for (const t of b.template) {
        if (!t.jenis || !t.konten) continue;
        await db.run(
          `INSERT INTO pesan_template (id_data_server, jenis, konten) VALUES (1,?,?)
           ON DUPLICATE KEY UPDATE konten=VALUES(konten)`,
          [v.str(t.jenis, { max: 40 }), v.str(t.konten, { max: 2000 })]);
      }
    }
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// ------------------------------------------------------ log WA
router.get('/wa/log', requireRole('superadmin'), async (req, res, next) => {
  try {
    const rows = await db.q('SELECT * FROM wa_log ORDER BY id DESC LIMIT 100');
    const antre = await db.q(`SELECT * FROM wa_queue WHERE status='pending' ORDER BY id LIMIT 50`);
    res.json({ data: rows, antrean: antre });
  } catch (e) { next(e); }
});

router.post('/wa/kirim', requireRole('superadmin'), async (req, res, next) => {
  try {
    const tujuan = v.phone(req.body.tujuan);
    const pesan = v.str(req.body.pesan, { min: 1, max: 2000 });
    await wa.enqueue({ tujuan, jenis: 'manual', pesan });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

router.post('/wa/proses', requireRole('superadmin'), async (req, res, next) => {
  try { res.json(await wa.prosesAntrean(30)); }
  catch (e) { next(e); }
});

// ------------------------------------------------- rekening CRUD
router.post('/rekening', requireRole('superadmin'), async (req, res, next) => {
  try {
    const bank = v.str(req.body.bank, { min: 2, max: 40 });
    const noRek = v.str(req.body.no_rek, { min: 3, max: 40 });
    const atas = v.str(req.body.atas_nama, { min: 2, max: 100 });
    const id = await db.insert('INSERT INTO rekening (bank, no_rek, atas_nama) VALUES (?,?,?)',
      [bank, noRek, atas]);
    res.json({ id });
  } catch (e) { next(e); }
});

router.delete('/rekening/:id', requireRole('superadmin'), async (req, res, next) => {
  try {
    const id = v.num(req.params.id, { int: true, min: 1 });
    await db.run(`UPDATE rekening SET status='nonaktif' WHERE id=?`, [id]);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// ------------------------------------------------------ audit log
router.get('/audit', requireRole('superadmin'), async (req, res, next) => {
  try {
    const rows = await db.q(
      `SELECT a.*, u.username FROM audit_log a LEFT JOIN app_user u ON u.id=a.user_id
       ORDER BY a.id DESC LIMIT 100`);
    res.json({ data: rows });
  } catch (e) { next(e); }
});

// ---------------------------------------------- status sistem
router.get('/sistem', requireRole('superadmin'), async (req, res, next) => {
  try {
    const [h] = await db.q(
      `SELECT (SELECT COUNT(*) FROM wa_queue WHERE status='pending') AS wa_pending,
              (SELECT COUNT(*) FROM tagihan WHERE status='buat') AS tagihan_belum_kirim,
              (SELECT MAX(created_at) FROM wa_log) AS wa_terakhir,
              (SELECT MAX(last_check) FROM setting_mikrotik) AS router_terakhir`);
    res.json({ data: h, node: process.version, uptime: process.uptime() });
  } catch (e) { next(e); }
});

module.exports = router;
