'use strict';
// ============================================================
// Monitoring API — interface router (KECUALI pppoe), resource,
// perangkat (MikroTik + OLT semua brand), analisa redaman.
// Perangkat adalah induk tenant: tabel anak (setting_olt, master_onu,
// redaman_log, interface_log, router_resource_log) discope lewat JOIN.
// ============================================================
const express = require('express');
const db = require('../db');
const v = require('../util/validate');
const { requireAuth, requireRole, requirePJ } = require('../middleware/auth');
const { tenantSql, tenantAktif, requireMenu } = require('../util/scope');
const monitor = require('../services/monitoring');
const olt = require('../services/olt');
const onu = require('../services/onu');
const crypto = require('../util/crypto');
const { RouterOS, testConnection } = require('../services/routeros');

const router = express.Router();
router.use(requireAuth);

// ---------------------------------------------- perangkat (CRUD)
router.get('/perangkat', async (req, res, next) => {
  try {
    const ts = tenantSql(req, 'id_data_server');
    // token_push sengaja TIDAK ikut dibaca — itu kunci tulis endpoint /api/router/push
    const rows = await db.q(
      `SELECT id, id_data_server, nama, brand, tipe, alamat, port, use_https, username, lokasi,
              status, last_check, last_msg, (token_push IS NOT NULL) AS push_terpasang
       FROM master_perangkat WHERE 1=1${ts.sql} ORDER BY tipe, nama`,
      ts.params
    );
    const laporan = rows.length ? await db.q(
      `SELECT id_perangkat, MAX(seen_at) AS lihat, COUNT(*) AS sesi FROM sesi_router
       WHERE tipe = 'pppoe' AND id_perangkat IN (${rows.map(() => '?').join(',')})
       GROUP BY id_perangkat`, rows.map(r => r.id)) : [];
    const peta = new Map(laporan.map(r => [Number(r.id_perangkat), r]));
    res.json({
      data: rows.map(r => ({
        ...r, password: undefined,
        push_lihat: (peta.get(Number(r.id)) || {}).lihat || null,
        push_sesi: Number((peta.get(Number(r.id)) || {}).sesi || 0)
      }))
    });
  } catch (e) { next(e); }
});

router.post('/perangkat', requirePJ(), requireMenu('perangkat', 'tambah'), async (req, res, next) => {
  try {
    const ds = tenantAktif(req);
    const nama = v.str(req.body.nama, { min: 2, max: 100 });
    const brand = v.enumOf(req.body.brand,
      ['mikrotik', 'hsgq', 'vsol', 'hisfocus', 'hioso', 'cdata', 'zte', 'huawei', 'lainnya']);
    const tipe = v.enumOf(req.body.tipe, ['router', 'olt'], brand === 'mikrotik' ? 'router' : 'olt');
    const alamat = v.str(req.body.alamat, { min: 1, max: 100 });
    const port = v.num(req.body.port, { min: 1, max: 65535, def: brand === 'mikrotik' ? 8728 : 80 });
    const useHttps = req.body.use_https ? 1 : 0;
    const username = v.str(req.body.username, { max: 60, def: null });
    const password = req.body.password ? String(req.body.password).slice(0, 200) : null;
    const lokasi = v.str(req.body.lokasi, { max: 120, def: null });

    const id = await db.insert(
      `INSERT INTO master_perangkat (id_data_server, nama, brand, tipe, alamat, port, use_https, username, password_enc, lokasi)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [ds, nama, brand, tipe, alamat, port, useHttps, username, password ? crypto.encrypt(password) : null, lokasi]
    );
    if (tipe === 'olt') {
      await db.insert('INSERT INTO setting_olt (id_perangkat) VALUES (?)', [id]);
    } else if (brand === 'mikrotik') {
      await db.insert(
        'INSERT INTO setting_mikrotik (id_data_server, id_perangkat, nama) VALUES (?,?,?)',
        [ds, id, nama]);
    }
    await db.insert('INSERT INTO audit_log (user_id, id_data_server, aksi, detail, ip) VALUES (?,?,?,?,?)',
      [req.user.id, ds, 'tambah_perangkat', `${nama} (${brand})`, (req.ip || '').replace('::ffff:', '')]);
    res.json({ id });
  } catch (e) { next(e); }
});

router.put('/perangkat/:id', requirePJ(), requireMenu('perangkat', 'ubah'), async (req, res, next) => {
  try {
    const id = v.num(req.params.id, { int: true, min: 1 });
    const ts = tenantSql(req, 'id_data_server');
    const d = await db.one(`SELECT * FROM master_perangkat WHERE id = ?${ts.sql}`, [id, ...ts.params]);
    if (!d) return res.status(404).json({ error: 'Perangkat tidak ada' });
    const nama = v.str(req.body.nama, { min: 2, max: 100, def: d.nama });
    const alamat = v.str(req.body.alamat, { min: 1, max: 100, def: d.alamat });
    const port = v.num(req.body.port, { min: 1, max: 65535, def: d.port ? Number(d.port) : 80 });
    const useHttps = req.body.use_https === undefined ? d.use_https : (req.body.use_https ? 1 : 0);
    const username = v.str(req.body.username, { max: 60, def: d.username });
    const lokasi = v.str(req.body.lokasi, { max: 120, def: d.lokasi });
    const status = v.enumOf(req.body.status, ['aktif', 'nonaktif'], d.status);
    const patch = ['nama=?', 'alamat=?', 'port=?', 'use_https=?', 'username=?', 'lokasi=?', 'status=?'];
    const vals = [nama, alamat, port, useHttps, username, lokasi, status];
    if (req.body.password) {
      patch.push('password_enc=?');
      vals.push(crypto.encrypt(String(req.body.password).slice(0, 200)));
    }
    vals.push(id);
    await db.run(`UPDATE master_perangkat SET ${patch.join(',')} WHERE id=?`, vals);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

router.delete('/perangkat/:id', requirePJ(), requireMenu('perangkat', 'hapus'), async (req, res, next) => {
  try {
    const id = v.num(req.params.id, { int: true, min: 1 });
    const ts = tenantSql(req, 'id_data_server');
    const d = await db.one(
      `SELECT id, id_data_server, nama FROM master_perangkat WHERE id = ?${ts.sql}`, [id, ...ts.params]);
    if (!d) return res.status(404).json({ error: 'Perangkat tidak ada' });
    await db.run('DELETE FROM setting_olt WHERE id_perangkat = ?', [id]);
    await db.run('DELETE FROM setting_mikrotik WHERE id_perangkat = ?', [id]);
    await db.run('DELETE FROM master_perangkat WHERE id = ?', [id]);
    await db.insert('INSERT INTO audit_log (user_id, id_data_server, aksi, detail, ip) VALUES (?,?,?,?,?)',
      [req.user.id, d.id_data_server, 'hapus_perangkat', `${d.nama} (#${id})`, (req.ip || '').replace('::ffff:', '')]);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

/** Tes koneksi perangkat (MikroTik API / login OLT). */
router.post('/perangkat/:id/test', requireRole('superadmin', 'master', 'teknisi'), async (req, res, next) => {
  try {
    const id = v.num(req.params.id, { int: true, min: 1 });
    const ts = tenantSql(req, 'id_data_server');
    const d = await db.one(`SELECT * FROM master_perangkat WHERE id = ?${ts.sql}`, [id, ...ts.params]);
    if (!d) return res.status(404).json({ error: 'Perangkat tidak ada' });
    const pass = crypto.decrypt(d.password_enc);
    if (d.brand === 'mikrotik') {
      const r = await testConnection({ host: d.alamat, port: d.port || 8728, user: d.username, password: pass });
      // Koneksi terbukti = kesempatan memasang script + schedule push sesi,
      // persis tombol Test di gratisinaja. Gagal pasang tidak boleh membuat
      // perangkat terlihat mati, jadi hasilnya hanya dilaporkan sebagai 'push'.
      let push = null;
      if (r.ok) {
        try { push = await monitor.pasangPush(d.id); }
        catch (e) { push = { gagal: String(e.message).slice(0, 200) }; }
      }
      return res.json({ ...r, push });
    }
    // OLT: uji login driver
    try {
      await olt.pollOlt({ ...d, password: pass }, { olt_tx_dbm: 4, rx_min_dbm: -27, att_max_db: 28 });
      res.json({ ok: true });
    } catch (e) {
      res.json({ ok: false, error: e.message });
    }
  } catch (e) { next(e); }
});

// ------------------------------------------- interface monitoring
router.get('/interface', requireRole('superadmin', 'master', 'teknisi'), async (req, res, next) => {
  try {
    const ts = tenantSql(req, 's.id_data_server');
    const idSetting = v.num(req.query.setting_id, { int: true, min: 1, def: null });
    const where = idSetting ? ['l.id_setting = ?'] : ['1=1'];
    const params = idSetting ? [idSetting] : [];
    where.push(`1=1${ts.sql}`);
    params.push(...ts.params);
    // interface terakhir per nama + agregat 5 menit terakhir
    const rows = await db.q(
      `SELECT l.id_setting, l.iface, l.tipe, l.status, l.rx_bps, l.tx_bps, l.cek_at, s.nama AS router
       FROM interface_log l
       JOIN setting_mikrotik s ON s.id = l.id_setting
       WHERE ${where.join(' AND ')} AND l.cek_at >= NOW() - INTERVAL 10 MINUTE
       ORDER BY l.cek_at DESC LIMIT 200`,
      params
    );
    // ringkas: nilai terbaru tiap interface
    const terbaru = {};
    for (const r of rows) {
      const k = `${r.id_setting}|${r.iface}`;
      if (!terbaru[k]) terbaru[k] = r;
    }
    res.json({
      data: Object.values(terbaru),
      catatan: 'Interface PPPoE tidak ditampilkan (sesuai spesifikasi monitoring).'
    });
  } catch (e) { next(e); }
});

router.get('/interface/riwayat', requireRole('superadmin', 'master', 'teknisi'), async (req, res, next) => {
  try {
    const iface = v.str(req.query.iface, { min: 1, max: 80 });
    const idSetting = v.num(req.query.setting_id, { int: true, min: 1 });
    const ts = tenantSql(req, 's.id_data_server');
    const rows = await db.q(
      `SELECT l.rx_bps, l.tx_bps, l.status, l.cek_at FROM interface_log l
       JOIN setting_mikrotik s ON s.id = l.id_setting
       WHERE l.id_setting = ? AND l.iface = ?${ts.sql} AND l.cek_at >= NOW() - INTERVAL 1 HOUR
       ORDER BY l.cek_at ASC LIMIT 300`,
      [idSetting, iface, ...ts.params]);
    res.json({ data: rows });
  } catch (e) { next(e); }
});

router.get('/resource', requireRole('superadmin', 'master', 'teknisi'), async (req, res, next) => {
  try {
    const ts = tenantSql(req, 's.id_data_server');
    const rows = await db.q(
      `SELECT s.nama, r.cpu_load, r.memory_used, r.cek_at FROM router_resource_log r
       JOIN setting_mikrotik s ON s.id = r.id_setting
       WHERE r.cek_at >= NOW() - INTERVAL 30 MINUTE${ts.sql}
       ORDER BY r.cek_at DESC LIMIT 100`,
      ts.params
    );
    res.json({ data: rows });
  } catch (e) { next(e); }
});

router.post('/interface/poll', requirePJ(), requireMenu('perangkat', 'poll'), async (req, res, next) => {
  try { res.json(await monitor.pollSemuaRouter(tenantAktif(req))); }
  catch (e) { next(e); }
});

// ------------------------------------------------- OLT & redaman
router.get('/olt/setting', requireRole('superadmin', 'master', 'teknisi'), async (req, res, next) => {
  try {
    const ts = tenantSql(req, 'd.id_data_server');
    const rows = await db.q(
      `SELECT s.*, d.id_data_server, d.nama, d.brand, d.alamat, d.port, d.use_https FROM setting_olt s
       JOIN master_perangkat d ON d.id = s.id_perangkat
       WHERE 1=1${ts.sql} ORDER BY d.nama`, ts.params);
    res.json({ data: rows });
  } catch (e) { next(e); }
});

router.put('/olt/setting/:id', requirePJ(), requireMenu('perangkat', 'ubah'), async (req, res, next) => {
  try {
    const id = v.num(req.params.id, { int: true, min: 1 });
    const ts = tenantSql(req, 'd.id_data_server');
    const s = await db.one(
      `SELECT s.* FROM setting_olt s JOIN master_perangkat d ON d.id = s.id_perangkat
       WHERE s.id = ?${ts.sql}`, [id, ...ts.params]);
    if (!s) return res.status(404).json({ error: 'Setting OLT tidak ada' });
    const amb = {
      olt_tx: v.num(req.body.olt_tx_dbm, { min: -40, max: 40, def: Number(s.olt_tx_dbm) }),
      rxmin: v.num(req.body.rx_min_dbm, { min: -50, max: 0, def: Number(s.rx_min_dbm) }),
      attmax: v.num(req.body.att_max_db, { min: 0, max: 60, def: Number(s.att_max_db) }),
      interval: v.num(req.body.interval_menit, { min: 1, max: 1440, def: s.interval_menit, int: true }),
      status: v.enumOf(req.body.status, ['aktif', 'inaktif'], s.status)
    };
    await db.run(
      `UPDATE setting_olt SET olt_tx_dbm=?, rx_min_dbm=?, att_max_db=?, interval_menit=?, status=? WHERE id=?`,
      [amb.olt_tx, amb.rxmin, amb.attmax, amb.interval, amb.status, id]);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

router.get('/olt/onu', requireRole('superadmin', 'master', 'teknisi'), async (req, res, next) => {
  try {
    const ts = tenantSql(req, 'd.id_data_server');
    const idPerangkat = v.num(req.query.perangkat_id, { int: true, min: 1, def: null });
    const where = idPerangkat ? ['o.id_perangkat = ?'] : ['1=1'];
    const params = idPerangkat ? [idPerangkat] : [];
    where.push(`1=1${ts.sql}`);
    params.push(...ts.params);
    const rows = await db.q(
      `SELECT o.*, d.nama AS nama_olt, p.nama AS nama_pelanggan FROM master_onu o
       JOIN master_perangkat d ON d.id = o.id_perangkat
       LEFT JOIN pelanggan p ON p.id = o.id_pelanggan
       WHERE ${where.join(' AND ')} ORDER BY d.nama, o.pon, o.nama_onu LIMIT 500`,
      params);
    res.json({ data: rows });
  } catch (e) { next(e); }
});

router.get('/olt/redaman', requireRole('superadmin', 'master', 'teknisi'), async (req, res, next) => {
  try {
    const ts = tenantSql(req, 'd.id_data_server');
    const rows = await db.q(
      `SELECT r.*, d.nama AS nama_olt FROM redaman_log r
       JOIN master_perangkat d ON d.id = r.id_perangkat
       WHERE 1=1${ts.sql} ORDER BY r.id DESC LIMIT 200`, ts.params);
    res.json({ data: rows });
  } catch (e) { next(e); }
});

router.post('/olt/poll/:id', requirePJ(), requireMenu('perangkat', 'poll'), async (req, res, next) => {
  try {
    const id = v.num(req.params.id, { int: true, min: 1 });
    const ts = tenantSql(req, 'd.id_data_server');
    const d = await db.one(
      `SELECT d.*, s.olt_tx_dbm, s.rx_min_dbm, s.att_max_db FROM setting_olt s
       JOIN master_perangkat d ON d.id = s.id_perangkat WHERE s.id = ?${ts.sql}`, [id, ...ts.params]);
    if (!d) return res.status(404).json({ error: 'Setting OLT tidak ada' });
    const hasil = await olt.pollOlt({ ...d, password: crypto.decrypt(d.password_enc) }, d);
    // simpan seperti polling scheduler: tombol manual dulu hanya menampilkan
    const disimpan = await onu.simpan(d.id, hasil.onus);
    const cocok = await onu.cocokkan({ idPerangkat: d.id });
    await db.run('UPDATE setting_olt SET last_check_at=NOW(), last_check_msg=? WHERE id=?',
      [`manual: ${hasil.onus.length} ONU tersimpan:${disimpan.tersimpan} cocok:${cocok.berubah}`, id]);
    res.json({ ok: true, pons: hasil.pons, onus: hasil.onus, disimpan, cocok });
  } catch (e) { next(e); }
});

router.get('/olt/brands', (req, res) => {
  res.json({ data: ['hsgq', 'vsol', 'hisfocus', 'hioso', 'cdata', 'zte', 'huawei'] });
});

// ------------------------------------------- remote ONU (auto NAT)
/**
 * Bagian bersama remote ONU: kunci 180 detik antar teknisi lalu pindahkan
 * rule dst-nat ke IP target. Dipakai tombol di daftar pelanggan DAN di tab
 * Unmanage — dua implementasi NAT akan saling bertabrakan di port yang sama.
 * s = baris setting_mikrotik + kolom api; ipUser sudah selesai diresolve.
 */
async function bukaRemote({ req, s, ipUser, label }) {
  const portRemote = Number(s.port_remote) || 8080;
  const kunci = s.last_remote ? new Date(s.last_remote).getTime() : 0;
  const sedang = s.user_remote && s.user_remote !== req.user.username && (Date.now() - kunci) <= 180000;
  if (sedang) {
    const e = new Error(`Akun ${s.user_remote} sedang remote pelanggan lain — tunggu beberapa saat`);
    e.status = 409;
    throw e;
  }

  await db.run('UPDATE setting_mikrotik SET user_remote=?, last_remote=NOW() WHERE id=?',
    [req.user.username || req.user.nama, s.id]);

  const api = new RouterOS({
    host: s.alamat_api, port: s.port_api || 8728,
    user: s.user_api, password: crypto.decrypt(s.password_enc), timeout: 8000
  });
  let aksiNat = '';
  try {
    const ada = await api.run(['/ip/firewall/nat/print', '=.proplist=.id', `?dst-port=${portRemote}`]);
    if (ada[0] && ada[0]['.id']) {
      await api.run(['/ip/firewall/nat/set', `=.id=${ada[0]['.id']}`, `=to-addresses=${ipUser}`]);
      aksiNat = 'update';
    } else {
      await api.run(['/ip/firewall/nat/add',
        '=chain=dstnat', '=protocol=tcp',
        `=dst-address=${s.alamat_api}`, `=dst-port=${portRemote}`,
        `=to-addresses=${ipUser}`, '=to-ports=80',
        '=comment=Remote ONU - ivvibill']);
      aksiNat = 'buat';
    }
  } finally { api.close(); }

  await db.insert(
    'INSERT INTO audit_log (user_id, id_data_server, aksi, detail, ip) VALUES (?,?,?,?,?)',
    [req.user.id, Number(s.id_data_server), 'remote_onu',
      `${label} → ${ipUser}:${portRemote} (${aksiNat})`, (req.ip || '').replace('::ffff:', '')]);

  return {
    ok: true, link: `http://${s.alamat_api}:${portRemote}`,
    ip_pelanggan: ipUser, port_remote: portRemote, nat: aksiNat, router: s.nama
  };
}

/** Kolom router + kredensial yang dibutuhkan bukaRemote, scoped ke tenant. */
async function routerRemote(idRouter, ts) {
  const dasar = `SELECT s.*, d.alamat AS alamat_api, d.port AS port_api,
       d.username AS user_api, d.password_enc
     FROM setting_mikrotik s
     JOIN master_perangkat d ON d.id = s.id_perangkat`;
  return idRouter
    ? db.one(`${dasar} WHERE s.id = ?${ts.sql}`, [idRouter, ...ts.params])
    : db.one(`${dasar} WHERE s.status = 'active'${ts.sql} ORDER BY s.id LIMIT 1`, ts.params);
}

/**
 * Remote ONU pelanggan — meniru gratisinaja user_remote:
 * resolve IP pelanggan (live dari /ppp/active bila status basi), kunci
 * remote 180 detik antar teknisi, lalu auto-generate/update rule dst-nat
 * MikroTik supaya http://router:port_remote menunjuk ke web ONU pelanggan.
 */
router.post('/pelanggan/:id/remote-onu', requireRole('superadmin', 'master', 'teknisi'),
  requireMenu('pelanggan', 'ubah'), async (req, res, next) => {
  try {
    const idPel = v.num(req.params.id, { int: true, min: 1 });
    const ts = tenantSql(req, 'id_data_server');
    const tsR = tenantSql(req, 's.id_data_server');
    const p = await db.one(
      `SELECT p.id, p.nama, p.alamat, p.username_pppoe, ps.ip_address AS ip_lokal, ps.online
       FROM pelanggan p
       LEFT JOIN pppoe_status ps ON ps.id_pelanggan = p.id
       WHERE p.id = ?${ts.sql}`, [idPel, ...ts.params]);
    if (!p) return res.status(404).json({ error: 'Pelanggan tidak ada' });

    const idRouter = v.num(req.body && req.body.router_id, { int: true, min: 1, def: null });
    const s = await routerRemote(idRouter, tsR);
    if (!s) return res.status(400).json({ error: 'Router MikroTik tidak ditemukan di tenant ini' });

    // IP pelanggan: dari status PPPoE; bila kosong/basi, tanya langsung ke router
    let ipUser = p.ip_lokal || null;
    const via = ipUser ? 'pppoe_status' : 'live';
    if (!ipUser && p.username_pppoe) {
      const api0 = new RouterOS({
        host: s.alamat_api, port: s.port_api || 8728,
        user: s.user_api, password: crypto.decrypt(s.password_enc), timeout: 5000
      });
      try {
        const rows = await api0.run(['/ppp/active/print', `?name=${p.username_pppoe}`]);
        ipUser = rows[0] && rows[0].address ? rows[0].address : null;
      } catch (_) { ipUser = null; }
      finally { api0.close(); }
    }
    if (!ipUser) {
      return res.status(400).json({ error: 'IP Address pelanggan tidak ditemukan — pastikan akun PPPoE sedang online' });
    }

    const r = await bukaRemote({ req, s, ipUser, label: `#${p.id} ${p.nama}` });
    res.json({ ...r, nama: p.nama, alamat: p.alamat || '-', via });
  } catch (e) { next(e); }
});

/**
 * Remote ONU sesi unmanage (PPPoE aktif yang tidak ada di daftar pelanggan).
 * IP sudah dibawa dari daftar unmanage, jadi tidak perlu resolve apa pun —
 * ini yang membuat gratisinaja bisa remote dari daftar yang sama.
 */
router.post('/remote-onu', requireRole('superadmin', 'master', 'teknisi'),
  requireMenu('pelanggan', 'ubah'), async (req, res, next) => {
  try {
    const ip = v.str(req.body && req.body.ip, { max: 45, def: '' });
    if (!/^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/.test(ip)) {
      return res.status(400).json({ error: 'IP target tidak valid' });
    }
    const ts = tenantSql(req, 's.id_data_server');
    const idRouter = v.num(req.body && req.body.router_id, { int: true, min: 1, def: null });
    const s = await routerRemote(idRouter, ts);
    if (!s) return res.status(400).json({ error: 'Router MikroTik tidak ditemukan di tenant ini' });
    const akun = v.str(req.body && req.body.akun, { max: 60, def: '' });
    const r = await bukaRemote({ req, s, ipUser: ip, label: `unmanage ${akun || ip}` });
    res.json({ ...r, akun, via: 'unmanage' });
  } catch (e) { next(e); }
});

/** Profile hotspot yang tersedia di router tenant — untuk dropdown form paket. */
router.get('/hotspot/profil', async (req, res, next) => {
  try {
    res.json(await monitor.profilHotspot(tenantAktif(req)));
  } catch (e) { next(e); }
});

/** Jalankan pencocokan ONU <-> pelanggan sekarang (tanpa menunggu polling). */
router.post('/olt/cocok', requireRole('superadmin', 'master'), requireMenu('perangkat', 'poll'),
  async (req, res, next) => {
  try {
    const idPerangkat = v.num(req.body && req.body.id_perangkat, { int: true, min: 1, def: null });
    res.json(await onu.cocokkan({ idPerangkat }));
  } catch (e) { next(e); }
});

module.exports = router;
