'use strict';
// ============================================================
// Rute pendukung: dashboard, tiket, pekerjaan teknisi,
// issue pelanggan, pengguna, pengaturan, log WA.
// Semua baca/tulis dikunci ke tenant (data_server) pemohon.
// ============================================================
const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db');
const v = require('../util/validate');
const config = require('../config');
const { requireAuth, requireRole, requirePJ } = require('../middleware/auth');
const { tenantSql, tenantUserSql, tenantAktif, tenantFrag, daftarTenant, requireMenu } = require('../util/scope');
const wa = require('../services/wa');
const cfgData = require('../services/configData');

const router = express.Router();
router.use(requireAuth);

// ------------------------------------------------------ dashboard
router.get('/dashboard', async (req, res, next) => {
  try {
    const role = req.user.role;
    const dasbor = {};
    if (role === 'superadmin' || role === 'master' || role === 'teknisi') {
      const T = tenantFrag(req);                 // kolom id_data_server milik tabel itu sendiri
      const TP = tenantFrag(req, 'p.id_data_server');   // lewat JOIN pelanggan
      const TD = tenantFrag(req, 'd.id_data_server');   // lewat JOIN master_perangkat
      const [jml] = await db.q(
        `SELECT
          (SELECT COUNT(*) FROM pelanggan WHERE status='aktif'${T}) AS pelanggan_aktif,
          (SELECT COUNT(*) FROM pelanggan WHERE status='isolir'${T}) AS pelanggan_isolir,
          (SELECT COUNT(*) FROM pelanggan WHERE status='baru'${T}) AS pelanggan_baru,
          (SELECT COUNT(*) FROM pelanggan WHERE status='nonaktif'${T}) AS pelanggan_nonaktif,
          (SELECT COUNT(*) FROM pelanggan WHERE tanggal_masuk >= DATE_FORMAT(NOW(), '%Y-%m-01')${T}) AS pasang_baru_bulan,
          (SELECT COUNT(*) FROM pelanggan WHERE tanggal_masuk >= DATE_FORMAT(NOW(), '%Y-01-01')${T}) AS pasang_baru_tahun,
          (SELECT COUNT(*) FROM tagihan WHERE status='lunas' AND paid_at >= DATE_FORMAT(NOW(), '%Y-%m-01')${T}) AS lunas_bulan_ini,
          (SELECT IFNULL(SUM(total),0) FROM tagihan WHERE status='lunas' AND paid_at >= DATE_FORMAT(NOW(), '%Y-%m-01')${T}) AS pemasukan,
          (SELECT IFNULL(SUM(total),0) FROM tagihan WHERE status='lunas' AND paid_at >= DATE_FORMAT(NOW(), '%Y-01-01')${T}) AS pemasukan_tahun,
          (SELECT IFNULL(SUM(total),0) FROM tagihan WHERE status='lunas'
             AND paid_at >= DATE_SUB(DATE_FORMAT(NOW(), '%Y-%m-01'), INTERVAL 1 MONTH)
             AND paid_at < DATE_FORMAT(NOW(), '%Y-%m-01')${T}) AS pemasukan_bulan_lalu,
          (SELECT IFNULL(SUM(total),0) FROM tagihan WHERE status!='lunas'${T}) AS belum_lunas,
          (SELECT COUNT(*) FROM tagihan WHERE status='jatuh_tempo'${T}) AS jatuh_tempo,
          (SELECT COUNT(*) FROM issue_pelanggan i JOIN pelanggan p ON p.id=i.id_pelanggan WHERE i.status='open'${TP}) AS issue_open,
          (SELECT COUNT(*) FROM tiket tk JOIN pelanggan p ON p.id=tk.id_pelanggan WHERE tk.status IN ('baru','diproses')${TP}) AS tiket_open,
          (SELECT COUNT(*) FROM pekerjaan WHERE status='antrian'${T}) AS order_antrian,
          (SELECT COUNT(*) FROM pekerjaan WHERE status='dikerjakan'${T}) AS order_dikerjakan,
          (SELECT COUNT(*) FROM pekerjaan WHERE status='selesai' AND tanggal >= DATE_FORMAT(NOW(), '%Y-%m-01')${T}) AS order_selesai_bulan,
          (SELECT COUNT(*) FROM voucher WHERE status='stok'${T}) AS voucher_stok,
          (SELECT COUNT(*) FROM voucher WHERE status IN ('terjual','terpakai') AND sold_at >= DATE_FORMAT(NOW(), '%Y-%m-01')${T}) AS voucher_terjual_bulan,
          (SELECT COUNT(*) FROM pelanggan WHERE tipe='pppoe' AND status='aktif'${T}) AS pppoe_aktif,
          (SELECT COUNT(*) FROM pelanggan WHERE tipe='hotspot' AND status='aktif'${T}) AS hotspot_aktif`);
      // pelanggan berbayar yang tidak terlihat di router: perlu JOIN, jadi dipisah
      const [off] = await db.q(
        `SELECT COUNT(*) AS pppoe_offline FROM pelanggan p
         LEFT JOIN pppoe_status ps ON ps.id_pelanggan = p.id
         WHERE p.tipe = 'pppoe' AND p.status = 'aktif' AND IFNULL(ps.online, 0) = 0${TP}`);
      jml.pppoe_offline = Number(off.pppoe_offline);
      dasbor.ringkas = jml;
      dasbor.tenant = await db.one(
        'SELECT id, nama_server, nama_pemilik, expaired_date, status FROM data_server WHERE id = ?',
        [tenantAktif(req)]);
      dasbor.olt = await db.q(
        `SELECT d.nama, d.brand, s.last_check_at, s.last_check_msg, s.status FROM setting_olt s
         JOIN master_perangkat d ON d.id=s.id_perangkat WHERE 1=1${TD} ORDER BY d.nama`);
      dasbor.router = await db.q(
        `SELECT nama, status, cpu_load, memory_usage, last_check FROM setting_mikrotik WHERE 1=1${T}`);
      dasbor.issue = await db.q(
        `SELECT i.*, p.nama AS nama_pelanggan FROM issue_pelanggan i
         JOIN pelanggan p ON p.id=i.id_pelanggan
         WHERE i.status='open'${TP} ORDER BY i.id DESC LIMIT 10`);
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

/**
 * Deret 12 bulan untuk grafik dasbor: pemasukan (lunas per paid_at), piutang
 * (belum lunas per periode) dan pasang baru per bulan. Tahun bisa dipilih.
 */
router.get('/dashboard/keuangan', async (req, res, next) => {
  try {
    const T = tenantFrag(req);
    const tahun = v.num(req.query.tahun, { min: 2000, max: 2999, def: new Date().getFullYear(), int: true });
    const [lunas, piutang, pasang, daftar] = await Promise.all([
      db.q(`SELECT DATE_FORMAT(paid_at, '%m') AS bln, IFNULL(SUM(total),0) AS jumlah, COUNT(*) AS n
            FROM tagihan WHERE status = 'lunas' AND YEAR(paid_at) = ?${T} GROUP BY bln`, [tahun]),
      db.q(`SELECT SUBSTRING(periode, 6, 2) AS bln, IFNULL(SUM(total),0) AS jumlah, COUNT(*) AS n
            FROM tagihan WHERE status NOT IN ('lunas','batal') AND periode LIKE ?${T} GROUP BY bln`,
        [`${tahun}-%`]),
      db.q(`SELECT DATE_FORMAT(tanggal_masuk, '%m') AS bln, COUNT(*) AS n
            FROM pelanggan WHERE YEAR(tanggal_masuk) = ?${T} GROUP BY bln`, [tahun]),
      db.q(`SELECT DISTINCT YEAR(paid_at) AS y FROM tagihan WHERE status = 'lunas' AND paid_at IS NOT NULL${T}
            ORDER BY y DESC`, []),
    ]);
    const bulan = Array.from({ length: 12 }, (_, i) => String(i + 1).padStart(2, '0'));
    const ambil = (rows, b, key) => {
      const r = rows.find(x => String(x.bln).padStart(2, '0') === b);
      return Number(r ? r[key] : 0);
    };
    res.json({
      tahun,
      pemasukan: bulan.map(b => ambil(lunas, b, 'jumlah')),
      tagihan_lunas: bulan.map(b => ambil(lunas, b, 'n')),
      piutang: bulan.map(b => ambil(piutang, b, 'jumlah')),
      tagihan_macet: bulan.map(b => ambil(piutang, b, 'n')),
      pasang_baru: bulan.map(b => ambil(pasang, b, 'n')),
      tahun_tersedia: [tahun, ...daftar.map(d => Number(d.y)).filter(y => y !== tahun)],
    });
  } catch (e) { next(e); }
});

// ----------------------------------------------------------- tiket
router.get('/tiket', async (req, res, next) => {
  try {
    const ts = tenantSql(req, 'p.id_data_server');
    const where = ['1=1'];
    const params = [];
    if (req.user.role === 'pelanggan') { where.push('t.id_pelanggan = ?'); params.push(req.user.id_ref); }
    if (req.user.role === 'teknisi') { where.push(`t.status IN ('baru','diproses','selesai')`); }
    const status = v.enumOf(req.query.status, ['baru', 'diproses', 'selesai', 'ditutup'], null);
    if (status) { where.push('t.status = ?'); params.push(status); }
    const rows = await db.q(
      `SELECT t.*, p.nama AS nama_pelanggan FROM tiket t
       JOIN pelanggan p ON p.id = t.id_pelanggan
       WHERE ${where.join(' AND ')}${ts.sql} ORDER BY t.id DESC LIMIT 100`, [...params, ...ts.params]);
    res.json({ data: rows });
  } catch (e) { next(e); }
});

router.post('/tiket', async (req, res, next) => {
  try {
    const judul = v.str(req.body.judul, { min: 3, max: 150 });
    const pesan = v.str(req.body.pesan, { max: 5000, def: '' });
    const prioritas = v.enumOf(req.body.prioritas, ['rendah', 'sedang', 'tinggi'], 'sedang');
    let idPelanggan = null;

    if (req.user.role === 'pelanggan') {
      idPelanggan = req.user.id_ref;
    } else {
      idPelanggan = v.num(req.body.id_pelanggan, { int: true, min: 1 });
    }
    // pelanggan harus ada di tenant pemohon (agen: harus miliknya sendiri)
    const ts = tenantSql(req, 'id_data_server');
    const p = await db.one(
      `SELECT id, nama, nomor_whatsapp, id_agen, id_data_server FROM pelanggan WHERE id = ?${ts.sql}`,
      [idPelanggan, ...ts.params]);
    if (!p) return res.status(404).json({ error: 'Pelanggan tidak ada' });
    if (req.user.role === 'agen' && Number(p.id_agen) !== Number(req.user.id_ref)) {
      return res.status(403).json({ error: 'Bukan pelanggan Anda' });
    }

    const id = await db.insert(
      'INSERT INTO tiket (id_pelanggan, judul, pesan, prioritas) VALUES (?,?,?,?)',
      [idPelanggan, judul, pesan, prioritas]);

    if (p.nomor_whatsapp) {
      const tpl = await wa.ambilTemplate('tiket', p.id_data_server);
      const pesanWa = wa.render(tpl, { usr: p.nama, judul, inv: `TCK-${id}` });
      await wa.enqueue({
        tujuan: p.nomor_whatsapp, jenis: 'tiket', pesan: pesanWa, idRef: id, idDataServer: p.id_data_server
      });
    }
    res.json({ id });
  } catch (e) { next(e); }
});

router.put('/tiket/:id', requireRole('superadmin', 'master', 'teknisi'), async (req, res, next) => {
  try {
    const id = v.num(req.params.id, { int: true, min: 1 });
    const ts = tenantSql(req, 'p.id_data_server');
    const t = await db.one(
      `SELECT t.* FROM tiket t JOIN pelanggan p ON p.id = t.id_pelanggan WHERE t.id = ?${ts.sql}`,
      [id, ...ts.params]);
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
router.get('/pekerjaan', requireRole('superadmin', 'master', 'teknisi'), async (req, res, next) => {
  try {
    const ts = tenantSql(req, 'k.id_data_server');
    const where = ['1=1'];
    const params = [];
    if (req.user.role === 'teknisi') { where.push('(k.id_teknisi = ? OR k.id_teknisi IS NULL)'); params.push(req.user.id); }
    const status = v.enumOf(req.query.status, ['antrian', 'dikerjakan', 'selesai', 'batal'], null);
    if (status) { where.push('k.status = ?'); params.push(status); }
    const rows = await db.q(
      `SELECT k.*, p.nama AS nama_teknisi FROM pekerjaan k
       LEFT JOIN app_user p ON p.id = k.id_teknisi
       WHERE ${where.join(' AND ')}${ts.sql} ORDER BY k.id DESC LIMIT 100`, [...params, ...ts.params]);
    res.json({ data: rows });
  } catch (e) { next(e); }
});

router.post('/pekerjaan', requirePJ(), async (req, res, next) => {
  try {
    const ds = tenantAktif(req);
    const jenis = v.enumOf(req.body.jenis, ['pasang', 'pindah', 'bongkar', 'perbaikan', 'survey'], 'pasang');
    const nama = v.str(req.body.nama, { min: 2, max: 100 });
    const alamat = v.str(req.body.alamat, { max: 255, def: null });
    const idPelanggan = v.num(req.body.id_pelanggan, { int: true, min: 1, def: null });
    const idTeknisi = v.num(req.body.id_teknisi, { int: true, min: 1, def: null });
    const tanggal = v.tgl(req.body.tanggal, new Date().toISOString().slice(0, 10));
    const id = await db.insert(
      `INSERT INTO pekerjaan (id_data_server, jenis, id_pelanggan, nama, alamat, id_teknisi, tanggal)
       VALUES (?,?,?,?,?,?,?)`,
      [ds, jenis, idPelanggan, nama, alamat, idTeknisi, tanggal]);
    res.json({ id });
  } catch (e) { next(e); }
});

router.put('/pekerjaan/:id', requireRole('superadmin', 'master', 'teknisi'), async (req, res, next) => {
  try {
    const id = v.num(req.params.id, { int: true, min: 1 });
    const ts = tenantSql(req, 'id_data_server');
    const k = await db.one(`SELECT * FROM pekerjaan WHERE id = ?${ts.sql}`, [id, ...ts.params]);
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
router.get('/issue', requireRole('superadmin', 'master', 'teknisi'), async (req, res, next) => {
  try {
    const ts = tenantSql(req, 'p.id_data_server');
    const rows = await db.q(
      `SELECT i.*, p.nama AS nama_pelanggan, p.username_pppoe FROM issue_pelanggan i
       JOIN pelanggan p ON p.id = i.id_pelanggan
       WHERE i.status = 'open'${ts.sql} ORDER BY i.id DESC LIMIT 100`, ts.params);
    res.json({ data: rows });
  } catch (e) { next(e); }
});

router.put('/issue/:id/selesai', requireRole('superadmin', 'master', 'teknisi'), async (req, res, next) => {
  try {
    const id = v.num(req.params.id, { int: true, min: 1 });
    const ts = tenantSql(req, 'p.id_data_server');
    const diubah = await db.run(
      `UPDATE issue_pelanggan i JOIN pelanggan p ON p.id = i.id_pelanggan
       SET i.status='resolved', i.resolved_at=NOW() WHERE i.id=?${ts.sql}`, [id, ...ts.params]);
    if (!diubah) return res.status(404).json({ error: 'Issue tidak ada' });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// ---------------------------------------------------- pengguna
router.get('/pengguna', requirePJ(), async (req, res, next) => {
  try {
    const ts = tenantUserSql(req, 'u.id_data_server');
    const rows = await db.q(
      `SELECT u.id, u.username, u.nama, u.role, u.id_ref, u.no_hp, u.status, u.gagal_login,
              u.last_login, u.created_at, u.id_data_server, u.id_group_akses, g.nama AS nama_grup
       FROM app_user u LEFT JOIN group_akses g ON g.id = u.id_group_akses
       WHERE 1=1${ts.sql} ORDER BY u.role, u.nama`, ts.params);
    res.json({ data: rows });
  } catch (e) { next(e); }
});

/** Tenant tempat user baru ditaruh — superadmin boleh memilih, master hanya tenantnya. */
async function tentukanTenantUser(req) {
  if (!req.tenantSemua) return { ids: [tenantAktif(req)] };
  const diminta = req.body.id_data_server;
  if (diminta === undefined || diminta === null || diminta === '' || diminta === 'all') return { ids: null };
  const ids = daftarTenant(diminta);
  if (!ids) throw new Error('id_data_server tidak valid');
  return { ids };
}

async function validasiGrup(req, idGrup, ids) {
  if (!idGrup) return null;
  const g = await db.one('SELECT id, id_data_server FROM group_akses WHERE id = ?', [idGrup]);
  if (!g) throw new Error('Grup akses tidak ada');
  if (ids && !ids.includes(Number(g.id_data_server))) throw new Error('Grup akses bukan milik tenant ini');
  return Number(g.id);
}

router.post('/pengguna', requirePJ(), requireMenu('pengguna', 'tambah'), async (req, res, next) => {
  try {
    const username = v.username(req.body.username);
    const pass = v.password(req.body.password);
    const nama = v.str(req.body.nama, { min: 2, max: 100 });
    const role = v.enumOf(req.body.role, ['superadmin', 'agen', 'teknisi', 'pelanggan']);
    if (role === 'superadmin' && req.user.role !== 'superadmin') {
      return res.status(403).json({ error: 'Hanya superadmin platform yang dapat membuat superadmin' });
    }
    const idRef = v.num(req.body.id_ref, { int: true, min: 1, def: null });
    const nohp = v.phone(req.body.no_hp);

    const dup = await db.one('SELECT id FROM app_user WHERE username = ?', [username]);
    if (dup) return res.status(400).json({ error: 'Username sudah dipakai' });

    const { ids } = await tentukanTenantUser(req);
    const idGrup = await validasiGrup(req, v.num(req.body.id_group_akses, { int: true, min: 1, def: null }), ids);

    const hash = await bcrypt.hash(pass, config.security.bcryptRounds);
    const id = await db.insert(
      `INSERT INTO app_user (username, password_hash, nama, role, id_ref, no_hp, id_data_server, id_group_akses)
       VALUES (?,?,?,?,?,?,?,?)`,
      [username, hash, nama, role, idRef, nohp, ids ? ids.join(',') : null, idGrup]);
    await db.insert('INSERT INTO audit_log (user_id, id_data_server, aksi, detail, ip) VALUES (?,?,?,?,?)',
      [req.user.id, req.ds, 'tambah_pengguna', `${username} [${role}]`, (req.ip || '').replace('::ffff:', '')]);
    res.json({ id });
  } catch (e) { next(e); }
});

router.put('/pengguna/:id', requirePJ(), requireMenu('pengguna', 'ubah'), async (req, res, next) => {
  try {
    const id = v.num(req.params.id, { int: true, min: 1 });
    const ts = tenantUserSql(req, 'id_data_server');
    const u = await db.one(`SELECT * FROM app_user WHERE id = ?${ts.sql}`, [id, ...ts.params]);
    if (!u) return res.status(404).json({ error: 'Pengguna tidak ada' });
    const nama = v.str(req.body.nama, { min: 2, max: 100, def: u.nama });
    const status = v.enumOf(req.body.status, ['aktif', 'blokir'], u.status);
    await db.run('UPDATE app_user SET nama=?, status=? WHERE id=?', [nama, status, id]);
    if (req.body.password) {
      const hash = await bcrypt.hash(v.password(req.body.password), config.security.bcryptRounds);
      await db.run('UPDATE app_user SET password_hash=? WHERE id=?', [hash, id]);
    }
    // pemindahan tenant/grup hanya milik superadmin platform
    if (req.tenantSemua && (req.body.id_data_server !== undefined || req.body.id_group_akses !== undefined)) {
      const { ids } = await tentukanTenantUser(req);
      const idGrup = await validasiGrup(req,
        v.num(req.body.id_group_akses, { int: true, min: 1, def: u.id_group_akses ? Number(u.id_group_akses) : null }), ids);
      await db.run('UPDATE app_user SET id_data_server=?, id_group_akses=? WHERE id=?',
        [ids ? ids.join(',') : null, idGrup, id]);
    }
    await db.insert('INSERT INTO audit_log (user_id, id_data_server, aksi, detail, ip) VALUES (?,?,?,?,?)',
      [req.user.id, req.ds, 'ubah_pengguna', `#${id} ${u.username}`, (req.ip || '').replace('::ffff:', '')]);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// -------------------------------------------------- pengaturan
router.get('/setting', requirePJ(), async (req, res, next) => {
  try {
    const ds = tenantAktif(req);
    const srv = await cfgData.getServer(ds, true);
    const ts = tenantSql(req, 'id_data_server');
    const rows = await db.q(`SELECT * FROM setting_app WHERE 1=1${ts.sql}`, ts.params);
    const tpl = await db.q('SELECT * FROM pesan_template WHERE id_data_server = ?', [ds]);
    res.json({
      data_server: {
        id: srv.id, nama_server: srv.nama_server, nama_pemilik: srv.nama_pemilik,
        nomor_whatsapp: srv.nomor_whatsapp, email: srv.email, alamat: srv.alamat,
        prefix_invoice: srv.prefix_invoice,
        jadwal_buat_hari: srv.jadwal_buat_hari, jadwal_kirim_hari: srv.jadwal_kirim_hari,
        jadwal_limit_hari: srv.jadwal_limit_hari, jam_kirim: srv.jam_kirim, ppn_persen: srv.ppn_persen
      },
      setting: rows, template: tpl
    });
  } catch (e) { next(e); }
});

router.put('/setting', requirePJ(), requireMenu('setting', 'ubah'), async (req, res, next) => {
  try {
    const ds = tenantAktif(req);
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
      vals.push(ds);
      await db.run(`UPDATE data_server SET ${patch.join(',')} WHERE id=?`, vals);
      cfgData.invalidate(ds);
    }
    if (b.template && Array.isArray(b.template)) {
      for (const t of b.template) {
        if (!t.jenis || !t.konten) continue;
        await db.run(
          `INSERT INTO pesan_template (id_data_server, jenis, konten) VALUES (?,?,?)
           ON DUPLICATE KEY UPDATE konten=VALUES(konten)`,
          [ds, v.str(t.jenis, { max: 40 }), v.str(t.konten, { max: 2000 })]);
      }
    }
    await db.insert('INSERT INTO audit_log (user_id, id_data_server, aksi, detail, ip) VALUES (?,?,?,?,?)',
      [req.user.id, ds, 'ubah_setting', `${patch.length} kolom, ${((b.template || []).length)} template`, (req.ip || '').replace('::ffff:', '')]);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// ------------------------------------------------------ log WA
router.get('/wa/log', requirePJ(), async (req, res, next) => {
  try {
    const ts = tenantSql(req, 'q.id_data_server');
    const rows = await db.q(
      `SELECT w.* FROM wa_log w JOIN wa_queue q ON q.id = w.id_queue
       WHERE 1=1${ts.sql} ORDER BY w.id DESC LIMIT 100`, ts.params);
    const antreTs = tenantSql(req, 'id_data_server');
    const antre = await db.q(
      `SELECT * FROM wa_queue WHERE status='pending'${antreTs.sql} ORDER BY id LIMIT 50`, antreTs.params);
    res.json({ data: rows, antrean: antre });
  } catch (e) { next(e); }
});

router.post('/wa/kirim', requirePJ(), requireMenu('wa', 'kirim'), async (req, res, next) => {
  try {
    const tujuan = v.phone(req.body.tujuan);
    const pesan = v.str(req.body.pesan, { min: 1, max: 2000 });
    await wa.enqueue({ tujuan, jenis: 'manual', pesan, idDataServer: tenantAktif(req) });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

router.post('/wa/proses', requirePJ(), requireMenu('wa', 'proses'), async (req, res, next) => {
  try { res.json(await wa.prosesAntrean(30, tenantAktif(req))); }
  catch (e) { next(e); }
});

// ------------------------------------------------- rekening CRUD
router.post('/rekening', requirePJ(), requireMenu('setting', 'rekening'), async (req, res, next) => {
  try {
    const ds = tenantAktif(req);
    const bank = v.str(req.body.bank, { min: 2, max: 40 });
    const noRek = v.str(req.body.no_rek, { min: 3, max: 40 });
    const atas = v.str(req.body.atas_nama, { min: 2, max: 100 });
    const id = await db.insert('INSERT INTO rekening (id_data_server, bank, no_rek, atas_nama) VALUES (?,?,?,?)',
      [ds, bank, noRek, atas]);
    res.json({ id });
  } catch (e) { next(e); }
});

router.delete('/rekening/:id', requirePJ(), requireMenu('setting', 'rekening'), async (req, res, next) => {
  try {
    const id = v.num(req.params.id, { int: true, min: 1 });
    const ts = tenantSql(req, 'id_data_server');
    const diubah = await db.run(`UPDATE rekening SET status='nonaktif' WHERE id=?${ts.sql}`, [id, ...ts.params]);
    if (!diubah) return res.status(404).json({ error: 'Rekening tidak ada' });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// ------------------------------------------------------ audit log
router.get('/audit', requirePJ(), async (req, res, next) => {
  try {
    const ts = tenantSql(req, 'id_data_server');
    const rows = await db.q(
      `SELECT a.*, u.username FROM audit_log a LEFT JOIN app_user u ON u.id=a.user_id
       WHERE 1=1${ts.sql} ORDER BY a.id DESC LIMIT 100`, ts.params);
    res.json({ data: rows });
  } catch (e) { next(e); }
});

// ---------------------------------------------- status sistem
router.get('/sistem', requirePJ(), async (req, res, next) => {
  try {
    const ds = tenantAktif(req);
    const [h] = await db.q(
      `SELECT (SELECT COUNT(*) FROM wa_queue WHERE status='pending' AND id_data_server=?) AS wa_pending,
              (SELECT COUNT(*) FROM tagihan WHERE status='buat' AND id_data_server=?) AS tagihan_belum_kirim,
              (SELECT MAX(w.created_at) FROM wa_log w JOIN wa_queue q ON q.id=w.id_queue
                 WHERE q.id_data_server=?) AS wa_terakhir,
              (SELECT MAX(s.last_check) FROM setting_mikrotik s WHERE s.id_data_server=?) AS router_terakhir`,
      [ds, ds, ds, ds]);
    res.json({ data: h, node: process.version, uptime: process.uptime() });
  } catch (e) { next(e); }
});

module.exports = router;
