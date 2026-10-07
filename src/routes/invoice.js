'use strict';
// ============================================================
// Invoice penjualan barang/jasa — modul TERPISAH dari tagihan
// langganan (meniru invoice + invoice_list gratisinaja).
// Butirnya diketik manual: uraian bebas, qty, harga. Tidak terikat
// paket, tidak menyentuh stok, dan tidak ikut siklus tagihan bulanan.
// ============================================================
const express = require('express');
const db = require('../db');
const v = require('../util/validate');
const { requireAuth, requireRole, requirePJ } = require('../middleware/auth');
const { tenantSql, tenantAktif, requireMenu } = require('../util/scope');
const kwitansi = require('../services/kwitansi');
const wa = require('../services/wa');
const cfgData = require('../services/configData');

const router = express.Router();
router.use(requireAuth);

const STATUS = ['buat', 'terkirim', 'lunas', 'batal'];

function audit(req, aksi, detail, ds) {
  return db.insert(
    'INSERT INTO audit_log (user_id, id_data_server, aksi, detail, ip) VALUES (?,?,?,?,?)',
    [req.user.id, ds, aksi, detail, (req.ip || '').replace('::ffff:', '')]
  );
}

/** Nomor INV<yyMM><urut 4 digit>, urut dihitung per data server per bulan. */
async function nomorBaru(idDataServer) {
  const now = new Date();
  const awalan = `INV${String(now.getFullYear()).slice(2)}${String(now.getMonth() + 1).padStart(2, '0')}`;
  const last = await db.one(
    'SELECT MAX(nomor) AS m FROM invoice WHERE id_data_server = ? AND nomor LIKE ?',
    [idDataServer, `${awalan}%`]
  );
  let urut = 1;
  if (last && last.m && String(last.m).startsWith(awalan)) {
    urut = Number(String(last.m).slice(awalan.length)) + 1;
  }
  for (let coba = 0; coba < 25; coba++) {
    const nomor = `${awalan}${String(urut + coba).padStart(4, '0')}`;
    const ada = await db.one('SELECT id FROM invoice WHERE nomor = ?', [nomor]);
    if (!ada) return nomor;
  }
  throw new Error('Gagal membuat nomor invoice — terlalu banyak tabrakan');
}

/** Total satu invoice dari butirnya (qty x harga), dipakai di semua respons. */
async function totalItem(idInvoice) {
  const r = await db.one(
    `SELECT COALESCE(SUM(quantity*harga),0) AS total, COUNT(*) AS butir
     FROM invoice_item WHERE id_invoice = ?`, [idInvoice]
  );
  return { total: Number(r.total), butir: Number(r.butir) };
}

async function muatInvoice(req, id) {
  const ts = tenantSql(req, 'i.id_data_server');
  return db.one(
    `SELECT i.*, p.nama AS nama_pelanggan, p.kode AS kode_pelanggan,
            p.nomor_whatsapp AS wa_pelanggan, a.nama AS nama_agen,
            (SELECT COALESCE(SUM(ii.quantity*ii.harga),0) FROM invoice_item ii WHERE ii.id_invoice = i.id) AS total
     FROM invoice i
     LEFT JOIN pelanggan p ON p.id = i.id_pelanggan
     LEFT JOIN agen a ON a.id = i.id_agen
     WHERE i.id = ?${ts.sql}`, [id, ...ts.params]
  );
}

// ------------------------------------------------------ daftar
router.get('/invoice', async (req, res, next) => {
  try {
    const ts = tenantSql(req, 'i.id_data_server');
    const status = v.enumOf(req.query.status, STATUS, null);
    const cari = v.str(req.query.q, { max: 60, def: '' });
    const limit = v.num(req.query.limit, { def: 50, min: 1, max: 200 });
    const offset = v.num(req.query.offset, { def: 0, min: 0 });
    const where = [`1=1${ts.sql}`];
    const params = [...ts.params];
    if (status) { where.push('i.status = ?'); params.push(status); }
    if (cari) {
      where.push('(i.nomor LIKE ? OR i.nama_tujuan LIKE ? OR p.nama LIKE ? OR ii.uraian LIKE ?)');
      params.push(`%${cari}%`, `%${cari}%`, `%${cari}%`, `%${cari}%`);
    }
    const w = where.join(' AND ');
    const rows = await db.q(
      `SELECT i.*, p.nama AS nama_pelanggan,
              (SELECT COALESCE(SUM(ii.quantity*ii.harga),0) FROM invoice_item ii WHERE ii.id_invoice = i.id) AS total,
              (SELECT COUNT(*) FROM invoice_item ii WHERE ii.id_invoice = i.id) AS butir
       FROM invoice i
       LEFT JOIN pelanggan p ON p.id = i.id_pelanggan
       LEFT JOIN invoice_item ii ON ii.id_invoice = i.id
       WHERE ${w}
       GROUP BY i.id
       ORDER BY i.id DESC LIMIT ? OFFSET ?`, [...params, limit, offset]
    );
    const [cnt] = await db.q(
      `SELECT COUNT(DISTINCT i.id) AS total FROM invoice i
       LEFT JOIN pelanggan p ON p.id = i.id_pelanggan
       LEFT JOIN invoice_item ii ON ii.id_invoice = i.id WHERE ${w}`, params
    );
    res.json({ data: rows, total: Number(cnt.total), limit, offset });
  } catch (e) { next(e); }
});

// ------------------------------------------------------ angka tab status
// Didaftarkan sebelum /invoice/:id supaya tidak tertangkap rute itu.
router.get('/invoice/jumlah', async (req, res, next) => {
  try {
    const ts = tenantSql(req, 'id_data_server');
    const rows = await db.q(
      `SELECT status, COUNT(*) AS n, COALESCE(SUM(
         (SELECT COALESCE(SUM(ii.quantity*ii.harga),0) FROM invoice_item ii WHERE ii.id_invoice = invoice.id)),0) AS nilai
       FROM invoice WHERE 1=1${ts.sql} GROUP BY status`, ts.params
    );
    const out = { semua: 0 };
    for (const r of rows) {
      out[r.status] = { jumlah: Number(r.n), nilai: Number(r.nilai) };
      out.semua += Number(r.n);
    }
    res.json(out);
  } catch (e) { next(e); }
});

// ------------------------------------------------------ data untuk halaman cetak
// Didaftarkan sebelum /invoice/:id supaya 'invoice-data' tidak dibaca sebagai id.
router.get('/invoice/invoice-data', async (req, res, next) => {
  try {
    const nomor = v.str(req.query.nomor, { min: 3, max: 25 });
    const ts = tenantSql(req, 'i.id_data_server');
    const u = req.user;
    const params = [nomor, ...ts.params];
    let scope = '';
    if (u.role === 'pelanggan') { scope = ' AND i.id_pelanggan = ?'; params.push(u.id_ref); }
    else if (u.role === 'agen') { scope = ' AND i.id_agen = ?'; params.push(u.id_ref); }
    const inv = await db.one(
      `SELECT i.*, p.nama AS nama_pelanggan, p.kode AS kode_pelanggan,
              p.alamat AS alamat_pelanggan, p.nomor_whatsapp AS wa_pelanggan
       FROM invoice i
       LEFT JOIN pelanggan p ON p.id = i.id_pelanggan
       WHERE i.nomor = ?${ts.sql}${scope}`, params
    );
    if (!inv) return res.status(404).json({ error: 'Invoice tidak ada' });
    const item = await db.q(
      'SELECT tanggal, uraian, quantity, harga FROM invoice_item WHERE id_invoice = ? ORDER BY id',
      [inv.id]
    );
    const srv = await db.one(
      `SELECT nama_server, nama_pemilik, alamat, logo, nomor_whatsapp, email
       FROM data_server WHERE id = ?`, [inv.id_data_server]
    );
    const rek = await db.q(
      'SELECT bank, no_rek, atas_nama FROM rekening WHERE id_data_server = ? AND status = ? ORDER BY id',
      [inv.id_data_server, 'aktif']
    );
    res.json({ invoice: inv, item, data_server: srv, rekening: rek });
  } catch (e) { next(e); }
});

// ------------------------------------------------------ satu invoice + butirnya
router.get('/invoice/:id', async (req, res, next) => {
  try {
    const id = v.num(req.params.id, { int: true, min: 1 });
    const inv = await muatInvoice(req, id);
    if (!inv) return res.status(404).json({ error: 'Invoice tidak ada' });
    const item = await db.q(
      'SELECT * FROM invoice_item WHERE id_invoice = ? ORDER BY id', [id]
    );
    res.json({ invoice: inv, item });
  } catch (e) { next(e); }
});

// ------------------------------------------------------ buat header
router.post('/invoice', requireRole('superadmin', 'master', 'teknisi'),
  requireMenu('invoice', 'tambah'), async (req, res, next) => {
    try {
      const ds = tenantAktif(req);
      const b = req.body || {};
      const idPelanggan = v.num(b.id_pelanggan, { int: true, min: 1, def: null });
      if (idPelanggan) {
        const p = await db.one(
          'SELECT id, nama, nomor_whatsapp, alamat FROM pelanggan WHERE id = ? AND id_data_server = ?',
          [idPelanggan, ds]
        );
        if (!p) return res.status(400).json({ error: 'Pelanggan bukan milik tenant ini' });
        b.nama_tujuan = b.nama_tujuan || p.nama;
      }
      const nomor = await nomorBaru(ds);
      const id = await db.insert(
        `INSERT INTO invoice
         (id_data_server, nomor, tanggal, jatuh_tempo, id_pelanggan, id_agen,
          nama_tujuan, alamat_tujuan, whatsapp_tujuan, catatan, status, dibuat_oleh)
         VALUES (?,?,?,?,?,?,?,?,?,?, 'buat', ?)`,
        [ds, nomor,
         v.tgl(b.tanggal, new Date().toISOString().slice(0, 10)),
         v.tgl(b.jatuh_tempo, null),
         idPelanggan,
         v.num(b.id_agen, { int: true, min: 1, def: null }),
         v.str(b.nama_tujuan, { max: 100, def: '' }),
         v.str(b.alamat_tujuan, { max: 200, def: '' }),
         v.str(b.whatsapp_tujuan, { max: 20, def: '' }),
         v.str(b.catatan, { max: 255, def: '' }),
         req.user.id]
      );
      await audit(req, 'buat_invoice', nomor, ds);
      res.json({ id, nomor });
    } catch (e) { next(e); }
  });

router.put('/invoice/:id', requireRole('superadmin', 'master', 'teknisi'),
  requireMenu('invoice', 'ubah'), async (req, res, next) => {
    try {
      const id = v.num(req.params.id, { int: true, min: 1 });
      const inv = await muatInvoice(req, id);
      if (!inv) return res.status(404).json({ error: 'Invoice tidak ada' });
      if (inv.status === 'lunas') return res.status(400).json({ error: 'Invoice lunas tidak bisa diubah' });
      const b = req.body || {};
      await db.run(
        `UPDATE invoice SET tanggal=?, jatuh_tempo=?, nama_tujuan=?, alamat_tujuan=?,
                            whatsapp_tujuan=?, catatan=? WHERE id=?`,
        [v.tgl(b.tanggal, inv.tanggal), v.tgl(b.jatuh_tempo, inv.jatuh_tempo),
         v.str(b.nama_tujuan, { max: 100, def: inv.nama_tujuan }),
         v.str(b.alamat_tujuan, { max: 200, def: inv.alamat_tujuan }),
         v.str(b.whatsapp_tujuan, { max: 20, def: inv.whatsapp_tujuan }),
         v.str(b.catatan, { max: 255, def: inv.catatan }), id]
      );
      await audit(req, 'ubah_invoice', inv.nomor, inv.id_data_server);
      res.json({ ok: true });
    } catch (e) { next(e); }
  });

// ------------------------------------------------------ butir
async function simpanItem(req, id, b) {
  const uraian = v.str(b.uraian, { min: 1, max: 150 });
  const quantity = v.num(b.quantity, { def: 1, min: 0.01, max: 1e6 });
  const harga = v.num(b.harga, { def: 0, min: 0, max: 1e12 });
  const tanggal = v.tgl(b.tanggal, new Date().toISOString().slice(0, 10));
  return { uraian, quantity, harga, tanggal, id };
}

router.post('/invoice/:id/item', requireRole('superadmin', 'master', 'teknisi'),
  requireMenu('invoice', 'ubah'), async (req, res, next) => {
    try {
      const inv = await muatInvoice(req, v.num(req.params.id, { int: true, min: 1 }));
      if (!inv) return res.status(404).json({ error: 'Invoice tidak ada' });
      if (inv.status === 'lunas') return res.status(400).json({ error: 'Invoice lunas tidak bisa diubah' });
      const s = await simpanItem(req, inv.id, req.body || {});
      const id = await db.insert(
        'INSERT INTO invoice_item (id_invoice, tanggal, uraian, quantity, harga) VALUES (?,?,?,?,?)',
        [s.id, s.tanggal, s.uraian, s.quantity, s.harga]
      );
      res.json({ id, total: (await totalItem(inv.id)).total });
    } catch (e) { next(e); }
  });

router.put('/invoice/item/:iid', requireRole('superadmin', 'master', 'teknisi'),
  requireMenu('invoice', 'ubah'), async (req, res, next) => {
    try {
      const iid = v.num(req.params.iid, { int: true, min: 1 });
      const it = await db.one('SELECT * FROM invoice_item WHERE id = ?', [iid]);
      if (!it) return res.status(404).json({ error: 'Butir tidak ada' });
      const inv = await muatInvoice(req, it.id_invoice);
      if (!inv) return res.status(404).json({ error: 'Invoice tidak ada' });
      if (inv.status === 'lunas') return res.status(400).json({ error: 'Invoice lunas tidak bisa diubah' });
      const s = await simpanItem(req, it.id_invoice, req.body || {});
      await db.run('UPDATE invoice_item SET tanggal=?, uraian=?, quantity=?, harga=? WHERE id=?',
        [s.tanggal, s.uraian, s.quantity, s.harga, iid]);
      res.json({ ok: true, total: (await totalItem(it.id_invoice)).total });
    } catch (e) { next(e); }
  });

router.delete('/invoice/item/:iid', requireRole('superadmin', 'master', 'teknisi'),
  requireMenu('invoice', 'hapus'), async (req, res, next) => {
    try {
      const iid = v.num(req.params.iid, { int: true, min: 1 });
      const it = await db.one('SELECT * FROM invoice_item WHERE id = ?', [iid]);
      if (!it) return res.status(404).json({ error: 'Butir tidak ada' });
      const inv = await muatInvoice(req, it.id_invoice);
      if (!inv) return res.status(404).json({ error: 'Invoice tidak ada' });
      if (inv.status === 'lunas') return res.status(400).json({ error: 'Invoice lunas tidak bisa diubah' });
      await db.run('DELETE FROM invoice_item WHERE id = ?', [iid]);
      res.json({ ok: true, total: (await totalItem(it.id_invoice)).total });
    } catch (e) { next(e); }
  });

// ------------------------------------------------------ kirim / lunas / batal
router.post('/invoice/:id/kirim', requirePJ(), requireMenu('invoice', 'kirim'),
  async (req, res, next) => {
    try {
      const inv = await muatInvoice(req, v.num(req.params.id, { int: true, min: 1 }));
      if (!inv) return res.status(404).json({ error: 'Invoice tidak ada' });
      const tujuan = inv.whatsapp_tujuan || inv.wa_pelanggan;
      if (!tujuan) return res.status(400).json({ error: 'Nomor WhatsApp tujuan kosong' });
      const tpl = await wa.ambilTemplate('tagihan', inv.id_data_server);
      const pesan = wa.render(tpl, {
        usr: inv.nama_tujuan || inv.nama_pelanggan, tot: Number(inv.total).toLocaleString('id-ID'),
        inv: inv.nomor, prd: 'penjualan', lmt: inv.jatuh_tempo || ''
      }) || `Invoice ${inv.nomor} sebesar Rp ${Number(inv.total).toLocaleString('id-ID')}`;
      await wa.enqueue({ tujuan, jenis: 'invoice', pesan, idRef: inv.id, idDataServer: inv.id_data_server });
      if (inv.status === 'buat') await db.run('UPDATE invoice SET status=? WHERE id=?', ['terkirim', inv.id]);
      await audit(req, 'kirim_invoice', inv.nomor, inv.id_data_server);
      res.json({ ok: true, antre: true });
    } catch (e) { next(e); }
  });

/** Tandai lunas: status + kas + kwitansi gambar ke WA (sama seperti tagihan). */
router.post('/invoice/:id/lunas', requirePJ(), requireMenu('invoice', 'verifikasi'),
  async (req, res, next) => {
    try {
      const id = v.num(req.params.id, { int: true, min: 1 });
      const inv = await muatInvoice(req, id);
      if (!inv) return res.status(404).json({ error: 'Invoice tidak ada' });
      if (inv.status === 'lunas') return res.json({ ok: true, already: true });
      if (!(await totalItem(id)).butir) return res.status(400).json({ error: 'Invoice belum punya butir' });

      const metode = v.str(req.body && req.body.metode, { max: 30, def: 'manual' });
      await db.run("UPDATE invoice SET status='lunas', metode_bayar=?, paid_at=NOW() WHERE id=?", [metode, id]);
      const nominal = Number(inv.total);
      try {
        await db.insert(
          `INSERT INTO kas (id_data_server, tipe, kategori, jumlah, keterangan, id_ref, dibuat_oleh)
           VALUES (?, 'masuk', 'pembayaran', ?, ?, ?, ?)`,
          [inv.id_data_server, nominal, `Invoice ${inv.nomor} (${metode})`, id, req.user.id]
        );
      } catch (_) { /* kas tidak boleh membatalkan pelunasan */ }

      let kw = null, kwGagal = null;
      try { kw = await kirimKwitansiInvoice(id); } catch (e) { kwGagal = String(e.message).slice(0, 160); }
      await audit(req, 'lunas_invoice', `${inv.nomor} Rp ${nominal}`, inv.id_data_server);
      res.json({ ok: true, kwitansi: kw, kwitansi_gagal: kwGagal });
    } catch (e) { next(e); }
  });

/** Kwitansi invoice: memakai renderer yang sama dengan tagihan. */
async function kirimKwitansiInvoice(id) {
  const inv = await db.one('SELECT * FROM invoice WHERE id = ?', [id]);
  const p = inv.id_pelanggan
    ? await db.one('SELECT * FROM pelanggan WHERE id = ?', [inv.id_pelanggan]) : null;
  const srv = await cfgData.getServer(inv.id_data_server);
  const item = await db.q('SELECT uraian FROM invoice_item WHERE id_invoice = ? ORDER BY id LIMIT 3', [id]);
  const uraian = item.map(i => i.uraian).join(', ') || 'Penjualan';
  // `total` bukan kolom di tabel invoice — selalu hasil penjumlahan butir,
  // jadi harus dihitung ulang di sini (SELECT * di atas tidak membawanya).
  const { total } = await totalItem(id);
  const kw = kwitansi.buat({
    tagihan: {
      id: inv.id, nomor_invoice: inv.nomor, total, paid_at: inv.paid_at,
      periode: null, metode_bayar: inv.metode_bayar, username_pppoe: null,
      keterangan: uraian, nama_pelanggan: inv.nama_tujuan || (p && p.nama) || '-'
    },
    pelanggan: p || { nama: inv.nama_tujuan || '-' },
    server: srv,
    bayar: { tanggal: inv.paid_at, metode: inv.metode_bayar }
  }, `kwitansi-inv-${inv.id}`, inv.img_invoice);
  await db.run('UPDATE invoice SET img_invoice = ? WHERE id = ?', [kw.file, id]);
  const tujuan = inv.whatsapp_tujuan || (p && p.nomor_whatsapp);
  if (!tujuan) return { ok: false, alasan: 'nomor WhatsApp tujuan kosong', url: kw.url };
  const tpl = await wa.ambilTemplate('lunas', inv.id_data_server);
  const caption = wa.render(tpl, {
    usr: inv.nama_tujuan || (p && p.nama) || '', tot: total.toLocaleString('id-ID'),
    inv: inv.nomor, srv: (srv && srv.nama_server) || '', ket: uraian
  }) || `Kwitansi invoice ${inv.nomor}`;
  await wa.enqueue({
    tujuan, jenis: 'lunas', pesan: caption, media: kw.url,
    idRef: inv.id, idDataServer: inv.id_data_server
  });
  return { ok: true, url: kw.url, tujuan };
}

router.post('/invoice/:id/kwitansi', requirePJ(), requireMenu('invoice', 'kirim'),
  async (req, res, next) => {
    try {
      const id = v.num(req.params.id, { int: true, min: 1 });
      const inv = await muatInvoice(req, id);
      if (!inv) return res.status(404).json({ error: 'Invoice tidak ada' });
      if (inv.status !== 'lunas') return res.status(400).json({ error: 'Kwitansi hanya untuk invoice lunas' });
      res.json(await kirimKwitansiInvoice(id));
    } catch (e) { next(e); }
  });

router.post('/invoice/:id/batal', requirePJ(), requireMenu('invoice', 'batal'),
  async (req, res, next) => {
    try {
      const id = v.num(req.params.id, { int: true, min: 1 });
      const inv = await muatInvoice(req, id);
      if (!inv) return res.status(404).json({ error: 'Invoice tidak ada' });
      if (inv.status === 'lunas') return res.status(400).json({ error: 'Invoice lunas tidak bisa dibatalkan' });
      await db.run("UPDATE invoice SET status='batal' WHERE id=?", [id]);
      await audit(req, 'batal_invoice', inv.nomor, inv.id_data_server);
      res.json({ ok: true });
    } catch (e) { next(e); }
  });

router.delete('/invoice/:id', requireRole('superadmin', 'master'),
  requireMenu('invoice', 'hapus'), async (req, res, next) => {
    try {
      const id = v.num(req.params.id, { int: true, min: 1 });
      const inv = await muatInvoice(req, id);
      if (!inv) return res.status(404).json({ error: 'Invoice tidak ada' });
      if (inv.status === 'lunas') return res.status(400).json({ error: 'Hapus kwitansi/invoice lunas lewat pembatalan, bukan dihapus' });
      await db.run('DELETE FROM invoice_item WHERE id_invoice = ?', [id]);
      await db.run('DELETE FROM invoice WHERE id = ?', [id]);
      await audit(req, 'hapus_invoice', inv.nomor, inv.id_data_server);
      res.json({ ok: true });
    } catch (e) { next(e); }
  });

module.exports = router;
module.exports.kirimKwitansiInvoice = kirimKwitansiInvoice;
module.exports.nomorBaru = nomorBaru;
