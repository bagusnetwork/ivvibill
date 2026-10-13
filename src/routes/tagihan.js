'use strict';
// ============================================================
// Tagihan + Pembayaran (manual pay & payment gateway)
// Semua akses terisolasi per tenant (data_server); tabel anak
// (pembayaran, rekening) discope lewat JOIN ke induknya.
// ============================================================
const express = require('express');
const db = require('../db');
const v = require('../util/validate');
const { requireAuth, requireRole, requirePJ } = require('../middleware/auth');
const { tenantSql, tenantAktif, requireMenu } = require('../util/scope');
const billing = require('../services/billing');
const wa = require('../services/wa');
const cfgData = require('../services/configData');
const crypto = require('../util/crypto');
const http = require('../util/http');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const config = require('../config');

const router = express.Router();
router.use(requireAuth);

fs.mkdirSync(config.security.uploadDir, { recursive: true });
const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, config.security.uploadDir),
    filename: (req, file, cb) => {
      const safe = file.originalname.replace(/[^A-Za-z0-9._-]/g, '_').slice(-60);
      cb(null, `${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${safe}`);
    }
  }),
  limits: { fileSize: 3 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ok = /image\/(png|jpe?g|webp)/.test(file.mimetype);
    cb(ok ? null : new Error('File harus gambar (png/jpg/webp)'), ok);
  }
});

function scopeTagihan(req) {
  const ts = tenantSql(req, 't.id_data_server');
  const u = req.user;
  if (u.role === 'pelanggan') return { where: `t.id_pelanggan = ?${ts.sql}`, params: [u.id_ref, ...ts.params] };
  if (u.role === 'agen') return { where: `p.id_agen = ?${ts.sql}`, params: [u.id_ref, ...ts.params] };
  return { where: `1=1${ts.sql}`, params: [...ts.params] };
}

/** Tagihan satu baris dalam scope tenant pemohon (null bila lintas tenant). */
async function cariTagihan(req, id) {
  const ts = tenantSql(req, 't.id_data_server');
  return db.one(
    `SELECT t.* FROM tagihan t JOIN pelanggan p ON p.id = t.id_pelanggan WHERE t.id = ?${ts.sql}`,
    [id, ...ts.params]
  );
}

// ------------------------------------------------------- tagihan
router.get('/tagihan', async (req, res, next) => {
  try {
    const s = scopeTagihan(req);
    const status = v.enumOf(req.query.status, ['buat', 'terkirim', 'menunggu', 'lunas', 'jatuh_tempo', 'batal'], null);
    const cari = v.str(req.query.q, { max: 100, def: '' });
    const limit = v.num(req.query.limit, { min: 1, max: 200, def: 50, int: true });
    const offset = v.num(req.query.offset, { min: 0, max: 1e6, def: 0, int: true });

    const where = [s.where];
    const params = [...s.params];
    if (status) { where.push('t.status = ?'); params.push(status); }
    if (cari) { where.push('(t.nomor_invoice LIKE ? OR p.nama LIKE ?)'); params.push(`%${cari}%`, `%${cari}%`); }

    const rows = await db.q(
      `SELECT t.*, p.nama AS nama_pelanggan, p.nomor_whatsapp
       FROM tagihan t JOIN pelanggan p ON p.id = t.id_pelanggan
       WHERE ${where.join(' AND ')}
       ORDER BY t.id DESC LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );
    const [cntRows, belumLunas] = await Promise.all([
      db.q(`SELECT COUNT(*) AS total FROM tagihan t JOIN pelanggan p ON p.id=t.id_pelanggan WHERE ${where.join(' AND ')}`, params),
      db.q(
        `SELECT IFNULL(SUM(t.total),0) AS nominal FROM tagihan t JOIN pelanggan p ON p.id=t.id_pelanggan
         WHERE ${where.join(' AND ')} AND t.status != 'lunas'`,
        params
      )
    ]);
    const total = cntRows[0] ? Number(cntRows[0].total) : 0;
    res.json({ data: rows, total, nominal_belum_lunas: Number(belumLunas[0].nominal) });
  } catch (e) { next(e); }
});

// --------------------------------------------- data invoice cetak
// (didahulukan supaya tidak tertangkap /tagihan/:id)
router.get('/tagihan/invoice-data', async (req, res, next) => {
  try {
    const nomor = v.str(req.query.nomor, { min: 3, max: 25 });
    const ts = tenantSql(req, 't.id_data_server');
    const u = req.user;
    const params = [nomor, ...ts.params];
    let scope = '';
    if (u.role === 'pelanggan') { scope = ' AND t.id_pelanggan = ?'; params.push(u.id_ref); }
    else if (u.role === 'agen') { scope = ' AND p.id_agen = ?'; params.push(u.id_ref); }
    const t = await db.one(
      `SELECT t.*, p.nama AS nama_pelanggan, p.kode AS kode_pelanggan,
              p.alamat AS alamat_pelanggan, p.nomor_whatsapp AS wa_pelanggan,
              p.username_pppoe, pk.nama_paket, pk.harga
       FROM tagihan t
       JOIN pelanggan p ON p.id = t.id_pelanggan
       LEFT JOIN paket pk ON pk.id = p.id_paket
       WHERE t.nomor_invoice = ?${ts.sql}${scope}`, params);
    if (!t) return res.status(404).json({ error: 'Tagihan tidak ada' });
    const srv = await db.one(
      `SELECT nama_server, nama_pemilik, alamat, logo, nomor_whatsapp, email
       FROM data_server WHERE id = ?`, [t.id_data_server]);
    const bayar = await db.q(
      `SELECT jumlah, metode, status, keterangan, created_at
       FROM pembayaran WHERE id_tagihan = ? AND status = 'diterima' ORDER BY id`, [t.id]);
    const rek = await db.q(
      `SELECT bank, no_rek, atas_nama FROM rekening
       WHERE id_data_server = ? AND status = 'aktif' ORDER BY id`, [t.id_data_server]);
    res.json({ tagihan: t, data_server: srv, pembayaran: bayar, rekening: rek });
  } catch (e) { next(e); }
});

/** Jadwal siklus otomatis — dipakai panel supaya "kapan dibuat/dikirim/diisolir
 *  otomatis" terlihat, bukan hanya dipercaya. Jamnya jam dinding ISP (zona
 *  aplikasi), bukan UTC. */
router.get('/tagihan/jadwal', async (req, res, next) => {
  try {
    const ds = tenantAktif(req);
    const srv = await cfgData.getServer(ds, true);
    const w = billing.waktuSiklus();
    const berikut = (hari) => {
      const h = Math.max(1, Math.min(28, Number(hari) || 1));
      const tgt = String(h).padStart(2, '0');
      if (h > w.tanggal) return `${w.periode}-${tgt}`;
      const d = new Date(`${w.periode}-01T12:00:00`);
      d.setMonth(d.getMonth() + 1);
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${tgt}`;
    };
    res.json({
      zona: w.zona, sekarang: `${w.hari} ${w.jam}`, tanggal: w.tanggal,
      buat: { hari: Number(srv.jadwal_buat_hari), berikutnya: berikut(srv.jadwal_buat_hari) },
      kirim: {
        hari: Number(srv.jadwal_kirim_hari), jam: srv.jam_kirim || '07:00',
        berikutnya: berikut(srv.jadwal_kirim_hari)
      },
      isolir: {
        mulai_jam: srv.jam_isolir || '09:00', tiap_hari: true,
        peringatan_jam: srv.jam_peringatan || '08:00'
      },
      belum_terkirim: (await db.one(
        `SELECT COUNT(*) AS n FROM tagihan t WHERE t.id_data_server = ? AND t.status = 'buat'`, [ds]
      ) || {}).n || 0,
      // v2.0: jadwal hari ini bukan satu angka lagi — tiap profil tagihan punya
      // tanggalnya sendiri, jadi panel menampilkan per profil + hitungan yang
      // masih mengikuti jadwal tenant (belum ditautkan).
      profil: await jadwalProfil(ds, berikut),
      // dua angka dengan makna berbeda: total tunggakan lewat tempo (semua
      // status pelanggan, termasuk yang sudah diisolir) dan yang masih aktif
      // sehingga akan diputus pada langkah isolir berikutnya
      lewat_tempo: (await db.one(
        `SELECT COUNT(*) AS n FROM tagihan
         WHERE id_data_server = ? AND status NOT IN ('lunas','batal')
           AND jatuh_tempo < CURDATE()`, [ds]
      ) || {}).n || 0,
      akan_isolir: (await db.one(
        `SELECT COUNT(*) AS n FROM tagihan t JOIN pelanggan p ON p.id = t.id_pelanggan
         WHERE t.id_data_server = ? AND t.status NOT IN ('lunas','batal')
           AND t.jatuh_tempo < CURDATE() AND p.status = 'aktif'`, [ds]
      ) || {}).n || 0
    });
  } catch (e) { next(e); }
});

router.get('/tagihan/:id', async (req, res, next) => {
  try {
    const id = v.num(req.params.id, { int: true, min: 1 });
    const ts = tenantSql(req, 't.id_data_server');
    const t = await db.one(
      `SELECT t.*, p.nama AS nama_pelanggan, p.nomor_whatsapp, p.alamat
       FROM tagihan t JOIN pelanggan p ON p.id = t.id_pelanggan WHERE t.id = ?${ts.sql}`,
      [id, ...ts.params]);
    if (!t) return res.status(404).json({ error: 'Tagihan tidak ada' });
    if (req.user.role === 'pelanggan' && Number(t.id_pelanggan) !== Number(req.user.id_ref)) {
      return res.status(403).json({ error: 'Akses ditolak' });
    }
    const bayar = await db.q('SELECT * FROM pembayaran WHERE id_tagihan = ? ORDER BY id DESC', [id]);
    res.json({ data: t, pembayaran: bayar });
  } catch (e) { next(e); }
});

router.post('/tagihan/buat', requirePJ(), requireMenu('tagihan', 'tambah'), async (req, res, next) => {
  try {
    const force = req.body.force === true || req.body.force === '1';
    const r = await billing.buatTagihanBulanan(tenantAktif(req), force);
    res.json(r);
  } catch (e) { next(e); }
});

router.post('/tagihan/kirim-wa', requirePJ(), requireMenu('tagihan', 'kirim'), async (req, res, next) => {
  try { res.json(await billing.kirimTagihanWajib(tenantAktif(req), 100)); }
  catch (e) { next(e); }
});

/** Kirim / kirim ulang WA satu tagihan — tombol manual per baris. */
router.post('/tagihan/:id/kirim', requirePJ(), requireMenu('tagihan', 'kirim'), async (req, res, next) => {
  try {
    const id = v.num(req.params.id, { int: true, min: 1 });
    const t = await cariTagihan(req, id);
    if (!t) return res.status(404).json({ error: 'Tagihan tidak ada' });
    const r = await billing.kirimTagihanSatuan(id, Number(t.id_data_server));
    await db.insert('INSERT INTO audit_log (user_id, id_data_server, aksi, detail, ip) VALUES (?,?,?,?,?)',
      [req.user.id, t.id_data_server, r.ok ? 'kirim_wa_tagihan' : 'kirim_wa_tagihan_gagal',
       `#${id} ${r.ok ? '-> ' + r.tujuan : r.alasan}`, (req.ip || '').replace('::ffff:', '')]);
    res.json(r);
  } catch (e) { next(e); }
});

/**
 * Jalankan siklus sekarang juga. Sejak v2.0.1 gerbangnya DIPINJAM dari scheduler
 * (billing.jalankanSiklusTenant): satu langkah hanya jalan bila ada profil tagihan
 * yang harinya jatuh hari ini, dan langkah berjam (kirim WA / pengingat / isolir)
 * baru jalan setelah ambang jam tenant-nya. Dulu tombol ini memakai force=true
 * sehingga sekali klik pada tanggal 11 langsung membuat tagihan untuk SEMUA
 * golongan — jatuh temponya pun bisa sudah lewat saat itu juga.
 *
 * `paksa: true` tetap tersedia (hanya lewat API) untuk menagih semua golongan
 * sekaligus, misalnya setelah server mati berhari-hari. Panel tidak pernah
 * mengirimnya.
 */
router.post('/tagihan/siklus', requireRole('superadmin', 'master'), async (req, res, next) => {
  try {
    const ds = tenantAktif(req);
    const paksa = req.body.paksa === true || req.body.paksa === '1';
    const w = billing.waktuSiklus();
    let hasil;
    if (paksa) {
      hasil = {
        tanggal: w.hari, hari: w.tanggal, jam: w.jam, periode: w.periode, paksa: true,
        langkah: {
          buat: { jalan: true, ...(await billing.buatTagihanBulanan(ds, true)) },
          kirim: { jalan: true, ...(await billing.kirimTagihanWajib(ds, 100)) },
          peringatan: { jalan: true, ...(await billing.peringatanTagihan(ds, 100)) },
          isolir: { jalan: true, ...(await billing.isolirJatuhTempo(ds)) }
        }
      };
    } else {
      const srv = await cfgData.getServer(ds, true);
      hasil = { paksa: false, ...(await billing.jalankanSiklusTenant(srv, w, 100)) };
    }
    const l = hasil.langkah;
    await db.insert('INSERT INTO audit_log (user_id, id_data_server, aksi, detail, ip) VALUES (?,?,?,?,?)',
      [req.user.id, ds, 'jalankan_siklus',
       JSON.stringify({ paksa, dibuat: l.buat.dibuat, dikirim: l.kirim.dikirim,
         diperingat: l.peringatan.diperingat, isolir: l.isolir.isolir }),
       (req.ip || '').replace('::ffff:', '')]);
    res.json(hasil);
  } catch (e) { next(e); }
});

/** Buat tagihan satuan — keterangan internet diketik manual, jumlah bebas. */
router.post('/tagihan/buat-satuan', requirePJ(), requireMenu('tagihan', 'tambah'), async (req, res, next) => {
  try {
    const ds = tenantAktif(req);
    const idPelanggan = v.num(req.body.id_pelanggan, { int: true, min: 1 });
    const periode = v.str(req.body.periode, { min: 7, max: 7 });
    if (!/^\d{4}-\d{2}$/.test(periode || '')) return res.status(400).json({ error: 'Periode harus YYYY-MM' });
    const r = await billing.buatTagihanSatuan({
      idDataServer: ds,
      idPelanggan,
      periode,
      keterangan: v.str(req.body.keterangan, { max: 255, def: null }),
      jumlah: req.body.jumlah === '' || req.body.jumlah == null ? null : v.num(req.body.jumlah, { min: 0, max: 1e9 }),
      diskon: v.num(req.body.diskon, { min: 0, max: 1e9, def: 0 }),
      jatuhTempo: v.tgl(req.body.jatuh_tempo, null)
    });
    await db.insert('INSERT INTO audit_log (user_id, id_data_server, aksi, detail, ip) VALUES (?,?,?,?,?)',
      [req.user.id, ds, 'buat_tagihan_satuan', `pelanggan #${idPelanggan} ${periode}`, (req.ip || '').replace('::ffff:', '')]);
    res.json(r);
  } catch (e) { next(e); }
});

/** Ubah keterangan/uraian tagihan sebelum dikirim. */
router.put('/tagihan/:id/keterangan', requirePJ(), requireMenu('tagihan', 'ubah'), async (req, res, next) => {
  try {
    const id = v.num(req.params.id, { int: true, min: 1 });
    const t = await cariTagihan(req, id);
    if (!t) return res.status(404).json({ error: 'Tagihan tidak ada' });
    if (t.status === 'lunas') return res.status(400).json({ error: 'Tagihan sudah lunas' });
    const keterangan = v.str(req.body.keterangan, { min: 3, max: 255 });
    await db.run('UPDATE tagihan SET keterangan = ? WHERE id = ?', [keterangan, id]);
    await db.insert('INSERT INTO audit_log (user_id, id_data_server, aksi, detail, ip) VALUES (?,?,?,?,?)',
      [req.user.id, t.id_data_server, 'ubah_keterangan_tagihan', `#${id}`, (req.ip || '').replace('::ffff:', '')]);
    res.json({ ok: true, keterangan });
  } catch (e) { next(e); }
});

/** Kirim ulang kwitansi lunas (gambar PNG) ke WhatsApp pelanggan. */
router.post('/tagihan/:id/kwitansi', requirePJ(), requireMenu('tagihan', 'kirim'), async (req, res, next) => {
  try {
    const id = v.num(req.params.id, { int: true, min: 1 });
    const t = await cariTagihan(req, id);
    if (!t) return res.status(404).json({ error: 'Tagihan tidak ada' });
    if (t.status !== 'lunas') return res.status(400).json({ error: 'Kwitansi hanya untuk tagihan lunas' });
    const r = await billing.kirimKwitansi(id);
    await db.insert('INSERT INTO audit_log (user_id, id_data_server, aksi, detail, ip) VALUES (?,?,?,?,?)',
      [req.user.id, t.id_data_server, 'kirim_kwitansi', `tagihan #${id}`, (req.ip || '').replace('::ffff:', '')]);
    res.json(r);
  } catch (e) { next(e); }
});

router.post('/tagihan/:id/batal', requirePJ(), requireMenu('tagihan', 'batal'), async (req, res, next) => {
  try {
    const id = v.num(req.params.id, { int: true, min: 1 });
    const t = await cariTagihan(req, id);
    if (!t) return res.status(404).json({ error: 'Tagihan tidak ada' });
    await db.run(`UPDATE tagihan SET status='batal' WHERE id=? AND status!='lunas'`, [id]);
    await db.insert('INSERT INTO audit_log (user_id, id_data_server, aksi, detail, ip) VALUES (?,?,?,?,?)',
      [req.user.id, t.id_data_server, 'batal_tagihan', `#${id}`, (req.ip || '').replace('::ffff:', '')]);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// ----------------------------------------------- pembayaran manual
router.post('/tagihan/:id/bayar', upload.single('bukti'), async (req, res, next) => {
  try {
    const id = v.num(req.params.id, { int: true, min: 1 });
    const t = await cariTagihan(req, id);
    if (!t) return res.status(404).json({ error: 'Tagihan tidak ada' });
    if (t.status === 'lunas') return res.status(400).json({ error: 'Tagihan sudah lunas' });
    if (req.user.role === 'pelanggan' && Number(t.id_pelanggan) !== Number(req.user.id_ref)) {
      return res.status(403).json({ error: 'Akses ditolak' });
    }
    const keterangan = v.str(req.body.keterangan, { max: 255, def: null });
    const bukti = req.file ? `/uploads/${req.file.filename}` : null;
    // Pelanggan mengunggah bukti → status menunggu verifikasi penanggung jawab.
    // Pemilik ISP / superadmin boleh langsung tandai lunas.
    const langsungLunas = req.user.role === 'superadmin' || req.user.role === 'master';

    await db.insert(
      `INSERT INTO pembayaran (id_tagihan, jumlah, metode, status, bukti, keterangan, verified_by)
       VALUES (?,?, 'manual', ?, ?, ?, ?)`,
      [id, t.total, langsungLunas ? 'diterima' : 'menunggu', bukti, keterangan, langsungLunas ? req.user.id : null]
    );
    if (langsungLunas) {
      await billing.lunaskanTagihan(id, 'manual', {
        verifiedBy: req.user.id, jumlah: Number(t.total), sudahDicatat: true });
    } else {
      await db.run(`UPDATE tagihan SET status='menunggu' WHERE id=?`, [id]);
    }
    await db.insert('INSERT INTO audit_log (user_id, id_data_server, aksi, detail, ip) VALUES (?,?,?,?,?)',
      [req.user.id, t.id_data_server, 'bayar_manual', `tagihan #${id}`, (req.ip || '').replace('::ffff:', '')]);
    res.json({ ok: true, status: langsungLunas ? 'lunas' : 'menunggu' });
  } catch (e) { next(e); }
});

router.get('/pembayaran/menunggu', requirePJ(), async (req, res, next) => {
  try {
    const ts = tenantSql(req, 't.id_data_server');
    const rows = await db.q(
      `SELECT b.*, t.nomor_invoice, t.total, t.id_data_server, p.nama AS nama_pelanggan
       FROM pembayaran b
       JOIN tagihan t ON t.id = b.id_tagihan
       JOIN pelanggan p ON p.id = t.id_pelanggan
       WHERE b.status = 'menunggu'${ts.sql} ORDER BY b.id DESC LIMIT 100`,
      ts.params
    );
    res.json({ data: rows });
  } catch (e) { next(e); }
});

router.post('/pembayaran/:id/verifikasi', requirePJ(), requireMenu('pembayaran', 'verifikasi'), async (req, res, next) => {
  try {
    const id = v.num(req.params.id, { int: true, min: 1 });
    const aksi = v.enumOf(req.body.aksi, ['terima', 'tolak']);
    const ts = tenantSql(req, 't.id_data_server');
    const b = await db.one(
      `SELECT b.*, t.id_data_server FROM pembayaran b
       JOIN tagihan t ON t.id = b.id_tagihan WHERE b.id = ?${ts.sql}`,
      [id, ...ts.params]
    );
    if (!b) return res.status(404).json({ error: 'Pembayaran tidak ada' });
    if (b.status !== 'menunggu') return res.status(400).json({ error: 'Sudah diproses' });
    if (aksi === 'terima') {
      await db.run(`UPDATE pembayaran SET status='diterima', verified_by=? WHERE id=?`, [req.user.id, id]);
      await billing.lunaskanTagihan(b.id_tagihan, b.metode, {
        verifiedBy: req.user.id, jumlah: Number(b.jumlah), sudahDicatat: true });
    } else {
      await db.run(`UPDATE pembayaran SET status='ditolak', verified_by=? WHERE id=?`, [req.user.id, id]);
      await db.run(`UPDATE tagihan SET status='terkirim' WHERE id=? AND status='menunggu'`, [b.id_tagihan]);
    }
    await db.insert('INSERT INTO audit_log (user_id, id_data_server, aksi, detail, ip) VALUES (?,?,?,?,?)',
      [req.user.id, b.id_data_server, `verifikasi_${aksi}`, `pembayaran #${id}`, (req.ip || '').replace('::ffff:', '')]);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// --------------------------------------------- payment gateway
/** Bentuk kunci Midtrans — dipakai untuk membedakan "salin tempel rusak" dari
 *  "akun belum boleh transaksi". Nilai aslinya tidak pernah ditampilkan.
 *  Label ini sengaja HANYA mendeskripsikan bentuk kunci (jenis + panjang +
 *  pola), bukan lingkungan. Dashboard Midtrans model baru mengeluarkan kunci
 *  sandbox tanpa prefiks 'SB-', jadi awalan tidak lagi bisa dipakai untuk
 *  menebak production/sandbox — environment ditentukan kolom pg_midtrans_env
 *  dan ditampilkan panel lewat badge midtrans_mode, bukan dari string ini. */
function bentukKunciMidtrans(k) {
  const s = String(k || '');
  if (!s) return 'kosong';
  const sandbox = s.startsWith('SB-');
  // Kunci asli Midtrans memakai alfabet base64url di belakang prefiks —
  // huruf, angka, serta '-' dan '_' — dan panjang ekornya bervariasi
  // (client key = 16 karakter, server key = 24). Karena itu pola yang
  // dipakai [A-Za-z0-9_-] dengan rentang lebar, BUKAN [A-Za-z0-9]{20,24}:
  // varian sempit itu menandai kunci asli sebagai "POLA TIDAK LAZIM",
  // padahal fungsi label ini justru membedakan tempelan rusak dari akun
  // yang belum diizinkan transaksi — salah tuduh membuatnya tidak berguna.
  const polanya = sandbox
    ? /^SB-Mid-(server|client)-[A-Za-z0-9_-]{8,64}$/
    : /^Mid-(server|client)-[A-Za-z0-9_-]{8,64}$/;
  const jenis = /server/.test(s.slice(0, 16)) ? 'server' : /client/.test(s.slice(0, 16)) ? 'client' : 'tak dikenal';
  return `${jenis} · ${s.length} karakter · ${polanya.test(s) ? 'pola benar' : 'POLA TIDAK LAZIM'}`;
}

router.get('/gateway', requirePJ(), async (req, res, next) => {
  try {
    const ds = tenantAktif(req);
    const s = await cfgData.getServer(ds, true);
    let mode = 'belum_ada';
    let bentuk = 'kosong';
    // Lingkungan yang sebenarnya dipakai = pilihan ISP (pg_midtrans_env) ATAU
    // awalan 'SB-' pada kunci. Dashboard Midtrans terbaru menerbitkan kunci
    // sandbox TANPA prefiks 'SB-', jadi tanpa kolom env ini kunci sandbox user
    // salah routed ke endpoint production dan memberi 401 yang mudah
    // disalahartikan sebagai "akun belum diizinkan".
    const env = String(s.pg_midtrans_env || '').toLowerCase() === 'sandbox' ? 'sandbox' : 'production';
    if (s.pg_midtrans_server_key) {
      let k = '';
      try { k = crypto.decrypt(s.pg_midtrans_server_key); } catch (_) { k = ''; }
      mode = midtransSandbox(k, s.pg_midtrans_env) ? 'sandbox' : (k ? 'live' : 'rusak');
      bentuk = bentukKunciMidtrans(k);
    }
    res.json({
      data: {
        pg_active: s.pg_active,
        midtrans_server_key: s.pg_midtrans_server_key ? '****' : '',
        midtrans_client_key: s.pg_midtrans_client_key || '',
        midtrans_mode: mode,
        midtrans_bentuk: bentuk,
        midtrans_env: env,
        midtrans_siap: s.pg_active === 'midtrans' && !!s.pg_midtrans_server_key,
        flip_siap: s.pg_active === 'flip' && !!s.pg_flip_secret_key,
        flip_secret: s.pg_flip_secret_key ? '****' : '',
        flip_public: s.pg_flip_public_key || '',
        wa_gateway_url: s.wa_gateway_url || '',
        wa_gateway_key: s.wa_gateway_key ? '****' : '',
        wa_status: s.wa_status,
        // URL yang harus ditempel di dashboard Midtrans/Flip (Settings →
        // Notifications). Tanpa ini notifikasi tidak pernah sampai dan tagihan
        // tetap 'menunggu' selamanya meski pelanggan sudah bayar.
        webhook_midtrans: (config.app.baseUrl || '') + '/api/webhook/midtrans',
        webhook_flip: (config.app.baseUrl || '') + '/api/webhook/flip'
      }
    });
  } catch (e) { next(e); }
});

/**
 * Metode bayar mana yang boleh ditawarkan ke pemohon ini. Dipakai aplikasi
 * pelanggan & panel; isi jawaban sengaja minimal (tidak ada kunci, tidak ada
 * URL gateway) supaya role pelanggan tidak membaca konfigurasi tenant.
 */
router.get('/gateway/metode', async (req, res, next) => {
  try {
    const ds = tenantAktif(req);
    const s = await cfgData.getServer(ds, true);
    res.json({
      manual: true,
      midtrans: s.pg_active === 'midtrans' && !!s.pg_midtrans_server_key,
      flip: s.pg_active === 'flip' && !!s.pg_flip_secret_key,
      aktif: s.pg_active || 'manual'
    });
  } catch (e) { next(e); }
});

/** Pairing WhatsApp — proxy ke gateway WHAPI tenant; API key tidak pernah turun ke browser. */
router.get('/gateway/wa/pairing', requirePJ(), async (req, res, next) => {
  try {
    const s = await cfgData.getServer(tenantAktif(req), true);
    res.json(await wa.pairing(s));
  } catch (e) { next(e); }
});

router.post('/gateway/wa/start', requirePJ(), requireMenu('setting', 'gateway'), async (req, res, next) => {
  try {
    const ds = tenantAktif(req);
    const s = await cfgData.getServer(ds, true);
    const hasil = await wa.mulaiPairing(s);
    await db.insert('INSERT INTO audit_log (user_id, id_data_server, aksi, detail, ip) VALUES (?,?,?,?,?)',
      [req.user.id, ds, 'wa_pairing_start', hasil.state || 'tanpa state', (req.ip || '').replace('::ffff:', '')]);
    res.json(hasil);
  } catch (e) { next(e); }
});

router.put('/gateway', requirePJ(), requireMenu('setting', 'gateway'), async (req, res, next) => {
  try {
    const ds = tenantAktif(req);
    const aktif = v.enumOf(req.body.pg_active, ['manual', 'midtrans', 'flip'], 'manual');
    // Lingkungan Midtrans dipilih eksplisit oleh ISP. Default 'production' agar
    // tenant lama tidak berubah perilaku; tenant uji sandbox memilih 'sandbox'.
    const midEnv = v.enumOf(req.body.pg_midtrans_env, ['production', 'sandbox'], 'production');
    // Kunci tidak pernah berisi spasi; satu enter yang ikut tersalin saat
    // tempel cukup membuat semua transaksi ditolak gateway, jadi dibuang
    // seluruh whitespace-nya di sini.
    const bersihKey = (x) => (x ? String(x).replace(/\s+/g, '') : x);
    const msKey = bersihKey(v.str(req.body.midtrans_server_key, { max: 400, def: null }));
    const mcKey = bersihKey(v.str(req.body.midtrans_client_key, { max: 200, def: null }));
    const fSec = bersihKey(v.str(req.body.flip_secret, { max: 400, def: null }));
    const fPub = bersihKey(v.str(req.body.flip_public, { max: 200, def: null }));
    const waUrl = v.str(req.body.wa_gateway_url, { max: 255, def: null });
    const waKey = v.str(req.body.wa_gateway_key, { max: 400, def: null });

    const patch = ['pg_active = ?', 'pg_midtrans_env = ?'];
    const vals = [aktif, midEnv];
    if (msKey && msKey !== '****') { patch.push('pg_midtrans_server_key = ?'); vals.push(crypto.encrypt(msKey)); }
    if (mcKey) { patch.push('pg_midtrans_client_key = ?'); vals.push(mcKey); }
    if (fSec && fSec !== '****') { patch.push('pg_flip_secret_key = ?'); vals.push(crypto.encrypt(fSec)); }
    if (fPub) { patch.push('pg_flip_public_key = ?'); vals.push(fPub); }
    if (waUrl !== null) { patch.push('wa_gateway_url = ?'); vals.push(waUrl); }
    if (waKey && waKey !== '****') { patch.push('wa_gateway_key = ?', 'wa_status = ?'); vals.push(crypto.encrypt(waKey), 'Aktif'); }
    vals.push(ds);
    await db.run(`UPDATE data_server SET ${patch.join(', ')} WHERE id = ?`, vals);
    cfgData.invalidate(ds);
    await db.insert('INSERT INTO audit_log (user_id, id_data_server, aksi, detail, ip) VALUES (?,?,?,?,?)',
      [req.user.id, ds, 'ubah_gateway', aktif, (req.ip || '').replace('::ffff:', '')]);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

/**
 * Environment Midtrans efektif. Dashboard Midtrans model baru menampilkan
 * kunci sandbox TANPA awalan 'SB-', jadi awalan tidak bisa lagi jadi satu-satunya
 * penanda. `pg_midtrans_env` (dipilih ISP di panel) yang menentukan; awalan 'SB-'
 * tetap dihormati sebagai kompatibilitas mundur untuk kunci lama.
 */
function midtransSandbox(serverKey, env) {
  return String(env || '').toLowerCase() === 'sandbox' || String(serverKey || '').startsWith('SB-');
}
/** Basis URL Midtrans: sandbox bila environment-nya sandbox, selain itu production. */
function basisMidtrans(serverKey, env) {
  return midtransSandbox(serverKey, env) ? 'https://app.sandbox.midtrans.com' : 'https://app.midtrans.com';
}
function headerMidtrans(serverKey) {
  return {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    Authorization: 'Basic ' + Buffer.from(serverKey + ':').toString('base64')
  };
}
/** Pesan error gateway (selalu array error_messages) untuk dibaca ISP. */
function pesanGateway(body, text) {
  if (body && Array.isArray(body.error_messages)) return body.error_messages.join(' | ');
  if (body && (body.status_message || body.message)) return String(body.status_message || body.message);
  return String(text || '(tanpa pesan)').slice(0, 240);
}

/** Checkout Midtrans Snap — membuat transaksi, mengembalikan snap URL. */
router.post('/gateway/midtrans/snap', requireRole('superadmin', 'master', 'pelanggan'), async (req, res, next) => {
  try {
    const tagihanId = v.num(req.body.tagihan_id, { int: true, min: 1 });
    const t = await cariTagihan(req, tagihanId);
    if (!t || t.status === 'lunas') return res.status(400).json({ error: 'Tagihan tidak valid' });
    if (req.user.role === 'pelanggan' && Number(t.id_pelanggan) !== Number(req.user.id_ref)) {
      return res.status(403).json({ error: 'Akses ditolak' });
    }
    const ds = Number(t.id_data_server);
    const s = await cfgData.getServer(ds, true);
    if (s.pg_active !== 'midtrans' || !s.pg_midtrans_server_key) {
      return res.status(400).json({ error: 'Midtrans belum diaktifkan' });
    }
    const serverKey = crypto.decrypt(s.pg_midtrans_server_key);
    const prefix = String(s.prefix_invoice || 'IVV').replace(/-+$/, '');
    // order_id memuat id tagihan pada posisi kedua-dari-ujung, dan itu yang
    // dipakai webhook untuk mencari tenant + kuncinya.
    const order = `${prefix}-${t.id}-${Date.now()}`;
    const payload = {
      transaction_details: { order_id: order, gross_amount: Number(t.total) },
      // sengaja TANPA nama/telepon pelanggan: nomor order sudah cukup untuk
      // pencocokan, dan data pribadi tidak perlu berangkat ke gateway
      customer_details: { first_name: String(t.id_pelanggan), email: null }
    };
    const r = await http.post(`${basisMidtrans(serverKey, s.pg_midtrans_env)}/snap/v1/transactions`,
      JSON.stringify(payload), { timeout: 20000, headers: headerMidtrans(serverKey) });
    if (r.status >= 400) {
      return res.status(502).json({ error: `Midtrans: ${pesanGateway(r.body, r.text)}` });
    }
    // Simpan order id-nya: notifikasi (settlement maupun expire) dicocokkan
    // lewat kolom ini, dan operator bisa melihat transaksi mana yang menunggu.
    await db.run('UPDATE tagihan SET ref_gateway = ? WHERE id = ?', [order, tagihanId]);
    await db.run(`UPDATE tagihan SET status='menunggu' WHERE id=? AND status IN ('buat','terkirim','jatuh_tempo')`, [tagihanId]);
    await db.insert('INSERT INTO audit_log (user_id, id_data_server, aksi, detail, ip) VALUES (?,?,?,?,?)',
      [req.user.id, ds, 'checkout_midtrans', `${order} · tagihan ${t.nomor_invoice} Rp ${Math.round(Number(t.total))}`,
       (req.ip || '').replace('::ffff:', '')]);
    res.json({ token: r.body?.token, redirect_url: r.body?.redirect_url || null, order_id: order });
  } catch (e) { next(e); }
});

/**
 * Uji kunci Midtrans milik tenant ini — dijalankan dari tombol di Pengaturan.
 * Membuat SATU transaksi Snap Rp 1.000 yang tidak ada yang membayar; gunanya
 * supaya kegagalan konfigurasi (kunci salah, akun belum boleh transaksi,
 * channel belum diaktifkan) terlihat di panel alih-alih baru ketahuan ketika
 * pelanggan benar-benar mencoba bayar.
 */
router.post('/gateway/midtrans/tes', requirePJ(), requireMenu('setting', 'gateway'), async (req, res, next) => {
  try {
    const ds = tenantAktif(req);
    const s = await cfgData.getServer(ds, true);
    if (!s.pg_midtrans_server_key) {
      return res.status(400).json({ error: 'Server key Midtrans belum disimpan — isi kolomnya dulu' });
    }
    const serverKey = crypto.decrypt(s.pg_midtrans_server_key);
    const basis = basisMidtrans(serverKey, s.pg_midtrans_env);
    const prefix = String(s.prefix_invoice || 'IVV').replace(/-+$/, '');
    const order = `${prefix}-UJI-${Date.now()}`;
    const r = await http.post(`${basis}/snap/v1/transactions`,
      JSON.stringify({
        transaction_details: { order_id: order, gross_amount: '1000' },
        customer_details: { first_name: 'uji-kunci-ivvibill', email: null }
      }), { timeout: 20000, headers: headerMidtrans(serverKey) });
    const lolos = r.status < 400 && !!(r.body && r.body.token);
    const detail = lolos
      ? 'Kunci diterima Midtrans — Snap siap dipakai pelanggan.'
      : pesanGateway(r.body, r.text);
    await db.insert('INSERT INTO audit_log (user_id, id_data_server, aksi, detail, ip) VALUES (?,?,?,?,?)',
      [req.user.id, ds, 'uji_midtrans', `HTTP ${r.status} · ${order} · ${detail}`,
       (req.ip || '').replace('::ffff:', '')]);
    res.json({
      ok: lolos, http: r.status,
      lingkungan: midtransSandbox(serverKey, s.pg_midtrans_env) ? 'sandbox' : 'production',
      bentuk_server_key: bentukKunciMidtrans(serverKey),
      bentuk_client_key: bentukKunciMidtrans(s.pg_midtrans_client_key || ''),
      order_id: order,
      pesan: detail,
      peringatan: lolos ? null
        : 'Uraikan penyebabnya di dashboard Midtrans (Settings → Access Key untuk bentuk kunci, Payment Channel Configuration untuk metode yang aktif, dan status aktivasi akun untuk transaksi live).'
    });
  } catch (e) { next(e); }
});

router.get('/rekening', async (req, res, next) => {
  try {
    const ts = tenantSql(req, 'id_data_server');
    res.json({ data: await db.q(`SELECT * FROM rekening WHERE status='aktif'${ts.sql}`, ts.params) });
  } catch (e) { next(e); }
});

// ------------------------------------------------ profil tagihan (v2.0)
// Pengganti "Hari Tagihan" per pelanggan: satu profil = satu kebijakan
// penagihan (tanggal buat / kirim / isolir, PPN, peringatan, kompensasi).
// Ganti jadwal satu golongan = edit satu profil, bukan sunat 171 pelanggan.
const profilCtl = require('../services/profilTagihan');

router.get('/profil-tagihan', async (req, res, next) => {
  try { res.json({ data: await profilCtl.daftar(tenantAktif(req)) }); }
  catch (e) { next(e); }
});

router.post('/profil-tagihan', requirePJ(), requireMenu('profil_tagihan', 'tambah'), async (req, res, next) => {
  try {
    const ds = tenantAktif(req);
    const r = await profilCtl.buat(ds, req.body);
    await db.insert('INSERT INTO audit_log (user_id, id_data_server, aksi, detail, ip) VALUES (?,?,?,?,?)',
      [req.user.id, ds, 'tambah_profil_tagihan', `${r.nama} (buat ${r.tanggal_buat}, kirim ${r.tanggal_kirim}, isolir ${r.tanggal_isolir})`,
       (req.ip || '').replace('::ffff:', '')]);
    res.json({ id: r.id, ok: true });
  } catch (e) { next(e); }
});

router.put('/profil-tagihan/:id', requirePJ(), requireMenu('profil_tagihan', 'ubah'), async (req, res, next) => {
  try {
    const ds = tenantAktif(req);
    const id = v.num(req.params.id, { int: true, min: 1 });
    const r = await profilCtl.ubah(id, ds, req.body);
    await db.insert('INSERT INTO audit_log (user_id, id_data_server, aksi, detail, ip) VALUES (?,?,?,?,?)',
      [req.user.id, ds, 'ubah_profil_tagihan', `#${id} ${r.nama} (isolir ${r.tanggal_isolir})`,
       (req.ip || '').replace('::ffff:', '')]);
    res.json(r);
  } catch (e) { next(e); }
});

router.delete('/profil-tagihan/:id', requirePJ(), requireMenu('profil_tagihan', 'hapus'), async (req, res, next) => {
  try {
    const ds = tenantAktif(req);
    const id = v.num(req.params.id, { int: true, min: 1 });
    const r = await profilCtl.hapus(id, ds);
    await db.insert('INSERT INTO audit_log (user_id, id_data_server, aksi, detail, ip) VALUES (?,?,?,?,?)',
      [req.user.id, ds, 'hapus_profil_tagihan', `#${id} ${r.nama}`, (req.ip || '').replace('::ffff:', '')]);
    res.json(r);
  } catch (e) { next(e); }
});

/**
 * Tautkan profil ke banyak pelanggan sekaligus (aksi massal di daftar
 * pelanggan). ids boleh kosong bila filter `q`/`status` dipakai, jadi
 * "pindahkan seluruh golongan" cukup satu kali klik.
 */
router.post('/profil-tagihan/terapkan', requirePJ(), requireMenu('profil_tagihan', 'tautkan'), async (req, res, next) => {
  try {
    const ds = tenantAktif(req);
    const idProfil = req.body.id_profil_tagihan === undefined ? null
      : v.num(req.body.id_profil_tagihan, { int: true, min: 1, def: null });
    let ids = Array.isArray(req.body.ids) ? req.body.ids : String(req.body.ids || '').split(',');
    ids = ids.map(x => v.num(x, { int: true, min: 1, def: null })).filter(x => x !== null).slice(0, 1000);
    if (!ids.length) return res.status(400).json({ error: 'Belum ada pelanggan dipilih' });
    const r = await profilCtl.tautkan(ds, idProfil, ids);
    await db.insert('INSERT INTO audit_log (user_id, id_data_server, aksi, detail, ip) VALUES (?,?,?,?,?)',
      [req.user.id, ds, 'terapkan_profil_tagihan', `${r.profil || '(lepas)'} -> ${r.ditautkan} pelanggan`,
       (req.ip || '').replace('::ffff:', '')]);
    res.json(r);
  } catch (e) { next(e); }
});

/** Ringkasan jadwal per profil — dipakai kartu "Jadwal siklus" di panel. */
async function jadwalProfil(ds, berikutFn) {
  const rows = await db.q(
    `SELECT pt.id, pt.nama, pt.status, pt.tanggal_buat, pt.tanggal_kirim, pt.tanggal_isolir,
            pt.ppn_mode, pt.kirim_peringatan, pt.kompensasi_desimal,
            (SELECT COUNT(*) FROM pelanggan p WHERE p.id_profil_tagihan = pt.id
              AND p.id_data_server = pt.id_data_server AND p.status IN ('aktif','isolir')) AS jumlah_aktif
     FROM profil_tagihan pt WHERE pt.id_data_server = ? ORDER BY pt.tanggal_buat, pt.nama`,
    [ds]
  );
  const tanpa = await db.one(
    `SELECT COUNT(*) AS n FROM pelanggan p
     WHERE p.id_data_server = ? AND p.id_profil_tagihan IS NULL AND p.status IN ('aktif','isolir')`, [ds]
  );
  return {
    data: rows.map(r => ({
      ...r,
      berikutnya_buat: berikutFn(r.tanggal_buat),
      berikutnya_kirim: berikutFn(r.tanggal_kirim),
      berikutnya_isolir: berikutFn(r.tanggal_isolir)
    })),
    tanpa_profil: Number((tanpa && tanpa.n) || 0)
  };
}

module.exports = router;
