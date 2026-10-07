'use strict';
// ============================================================
// Billing — pembuatan tagihan, pembayaran manual & gateway,
// pelunasan, isolir, plus deteksi issue pelanggan PPPoE.
// ============================================================
const db = require('../db');
const cfgData = require('./configData');
const wa = require('./wa');
const mon = require('./monitoring');
const kwitansi = require('./kwitansi');
const { tglIndo } = require('../util/tanggal');

/**
 * Buat tagihan bulanan untuk periode berjalan.
 * Dipanggil cron harian sesuai jadwal_buat_hari (data_server).
 */
async function buatTagihanBulanan(idDataServer = 1, force = false) {
  const srv = await cfgData.getServer(idDataServer, true);
  const now = new Date();
  const tglSekarang = now.getUTCDate();
  const periode = now.toISOString().slice(0, 7);

  if (!force && tglSekarang !== Number(srv.jadwal_buat_hari)) {
    return { skipped: true, reason: `jadwal buat tgl ${srv.jadwal_buat_hari}` };
  }

  const pelanggan = await db.q(
    `SELECT p.*, pk.harga, pk.nama_paket FROM pelanggan p
     LEFT JOIN paket pk ON pk.id = p.id_paket
     WHERE p.id_data_server = ? AND p.status IN ('aktif','isolir') AND p.tipe = 'pppoe'`,
    [idDataServer]
  );

  let dibuat = 0;
  for (const p of pelanggan) {
    const dup = await db.one(
      'SELECT id FROM tagihan WHERE id_pelanggan = ? AND periode = ? AND status != ?',
      [p.id, periode, 'batal']
    );
    if (dup) continue;

    const jumlah = Number(p.harga || 0);
    const kodeUnik = force ? 0 : Math.floor(Math.random() * 900) + 100; // kode unik 3 digit
    const ppn = Number((jumlah * Number(srv.ppn_persen || 0) / 100).toFixed(2));
    const total = jumlah + kodeUnik + ppn;
    const tanggalBuat = `${periode}-${String(srv.jadwal_buat_hari).padStart(2, '0')}`;
    const jt = `${periode}-${String(srv.jadwal_limit_hari).padStart(2, '0')}`;

    const invoice = await cfgData.nomorInvoice(idDataServer);
    await db.insert(
      `INSERT INTO tagihan
       (id_data_server, id_pelanggan, nomor_invoice, periode, keterangan, jumlah, kode_unik, ppn, total, tanggal_buat, jatuh_tempo, status)
       VALUES (?,?,?,?,?,?,?,?,?,?,?, 'buat')`,
      [idDataServer, p.id, invoice, periode, p.nama_paket || 'Langganan',
       jumlah, kodeUnik, ppn, total, tanggalBuat, jt]
    );
    dibuat++;
  }
  return { dibuat };
}

/**
 * Satu tagihan manual — padanan tagihan_buat_satuan.php.
 * `keterangan` boleh diketik operator (uraian layanan internet), boleh juga
 * `jumlah` disetel sendiri bila bukan harga paket (proyek/harga nego).
 */
async function buatTagihanSatuan({
  idDataServer, idPelanggan, periode, keterangan = null,
  jumlah = null, diskon = 0, jatuhTempo = null
}) {
  const srv = await cfgData.getServer(idDataServer, true);
  const p = await db.one(
    `SELECT p.*, pk.harga, pk.nama_paket FROM pelanggan p
     LEFT JOIN paket pk ON pk.id = p.id_paket
     WHERE p.id = ? AND p.id_data_server = ?`, [idPelanggan, idDataServer]
  );
  if (!p) throw new Error('Pelanggan tidak ditemukan di tenant ini');

  const per = periode || new Date().toISOString().slice(0, 7);
  const dup = await db.one(
    'SELECT id FROM tagihan WHERE id_pelanggan = ? AND periode = ? AND status != ?',
    [p.id, per, 'batal']
  );
  if (dup) return { sudah_ada: true, id: dup.id };

  const dasar = jumlah !== null && jumlah !== '' ? Number(jumlah) : Number(p.harga || 0);
  const potongan = Number(diskon || 0);
  const netto = Math.max(0, dasar - potongan);
  const kodeUnik = Math.floor(Math.random() * 900) + 100;
  const ppn = Number((netto * Number(srv.ppn_persen || 0) / 100).toFixed(2));
  const total = netto + kodeUnik + ppn;
  const uraian = keterangan || `${p.nama_paket || 'Langganan'} periode ${per}`;
  const jt = jatuhTempo || `${per}-${String(srv.jadwal_limit_hari || 20).padStart(2, '0')}`;

  const nomor = await cfgData.nomorInvoice(idDataServer);
  const id = await db.insert(
    `INSERT INTO tagihan
     (id_data_server, id_pelanggan, nomor_invoice, periode, keterangan, jumlah, kode_unik, ppn, total, tanggal_buat, jatuh_tempo, status)
     VALUES (?,?,?,?,?,?,?,?,?,?,?, 'buat')`,
    [idDataServer, p.id, nomor, per, uraian, dasar, kodeUnik, ppn, total,
     new Date().toISOString().slice(0, 10), jt]
  );
  return { id, nomor, total, sudah_ada: false };
}

/** Kirim tagihan (status buat → terkirim) via antrean WA. */
async function kirimTagihanWajib(idDataServer = 1, limit = 25) {
  const srv = await cfgData.getServer(idDataServer, true);
  const tags = await db.q(
    `SELECT t.*, p.nama, p.nomor_whatsapp FROM tagihan t
     JOIN pelanggan p ON p.id = t.id_pelanggan
     WHERE t.id_data_server = ? AND t.status = 'buat'
     ORDER BY t.id ASC LIMIT ?`,
    [idDataServer, Number(limit)]
  );
  let n = 0;
  for (const t of tags) {
    const tpl = await wa.ambilTemplate('tagihan', idDataServer);
    const pesan = wa.render(tpl, {
      usr: t.nama, inv: t.nomor_invoice, prd: t.periode,
      tot: Number(t.total).toLocaleString('id-ID'),
      lmt: tglIndo(t.jatuh_tempo),
      lnk: srv.base_url ? `${srv.base_url}/pelanggan` : ''
    });
    if (t.nomor_whatsapp) {
      await wa.enqueue({ tujuan: t.nomor_whatsapp, jenis: 'tagihan', pesan, idRef: t.id, idDataServer });
    }
    await db.run('UPDATE tagihan SET status = ? WHERE id = ?', ['terkirim', t.id]);
    n++;
  }
  return { dikirim: n };
}

/** Peringatan H-3 & penanda jatuh tempo. */
async function peringatanTagihan(idDataServer = 1, limit = 25) {
  const tags = await db.q(
    `SELECT t.*, p.nama, p.nomor_whatsapp FROM tagihan t
     JOIN pelanggan p ON p.id = t.id_pelanggan
     WHERE t.id_data_server = ? AND t.status IN ('terkirim','jatuh_tempo')
       AND t.jatuh_tempo BETWEEN CURDATE() AND DATE_ADD(CURDATE(), INTERVAL 3 DAY)
     ORDER BY t.jatuh_tempo ASC LIMIT ?`,
    [idDataServer, Number(limit)]
  );
  let n = 0;
  for (const t of tags) {
    const tpl = await wa.ambilTemplate('peringatan', idDataServer);
    const pesan = wa.render(tpl, {
      usr: t.nama, inv: t.nomor_invoice,
      tot: Number(t.total).toLocaleString('id-ID'),
      lmt: tglIndo(t.jatuh_tempo)
    });
    if (t.nomor_whatsapp) {
      await wa.enqueue({ tujuan: t.nomor_whatsapp, jenis: 'peringatan', pesan, idRef: t.id, idDataServer });
    }
    n++;
  }
  // tandai lewat jatuh tempo
  await db.run(
    `UPDATE tagihan SET status = 'jatuh_tempo'
     WHERE id_data_server = ? AND status IN ('terkirim','buat') AND jatuh_tempo < CURDATE()`,
    [idDataServer]
  );
  return { diperingat: n };
}

/**
 * Buat kwitansi gambar untuk tagihan yang sudah lunas dan antrekan ke WA
 * pelanggan (padanan Pembayaran::kirimKwitansi di gratisinaja).
 * Dipakai saat pelunasan DAN saat tombol "kirim ulang" di panel.
 */
async function kirimKwitansi(idTagihan) {
  const t = await db.one('SELECT * FROM tagihan WHERE id = ?', [idTagihan]);
  if (!t) throw new Error('Tagihan tidak ditemukan');
  if (t.status !== 'lunas') return { ok: false, alasan: 'tagihan belum lunas' };
  const p = await db.one('SELECT * FROM pelanggan WHERE id = ?', [t.id_pelanggan]);
  if (!p || !p.nomor_whatsapp) return { ok: false, alasan: 'nomor WhatsApp pelanggan kosong' };

  const srv = await cfgData.getServer(t.id_data_server);
  const bayar = await db.one(
    `SELECT jumlah, metode, created_at FROM pembayaran
     WHERE id_tagihan = ? AND status = 'diterima' ORDER BY id DESC LIMIT 1`, [t.id]
  );
  const kw = kwitansi.buat({
    tagihan: t, pelanggan: p, server: srv,
    bayar: { tanggal: bayar && bayar.created_at, metode: bayar && bayar.metode }
  }, null, t.img_invoice);
  await db.run('UPDATE tagihan SET img_invoice = ? WHERE id = ?', [kw.file, t.id]);

  const tpl = await wa.ambilTemplate('lunas', t.id_data_server);
  const caption = wa.render(tpl, {
    usr: p.nama, tot: Number(t.total).toLocaleString('id-ID'),
    inv: t.nomor_invoice, srv: (srv && srv.nama_server) || '',
    ket: t.keterangan || '', prd: t.periode || '',
    tgl: tglIndo(bayar && bayar.created_at)
  }) || `Kwitansi pembayaran ${t.nomor_invoice}`;
  await wa.enqueue({
    tujuan: p.nomor_whatsapp, jenis: 'lunas', pesan: caption,
    media: kw.url, idRef: t.id, idDataServer: t.id_data_server
  });
  return { ok: true, url: kw.url, tujuan: p.nomor_whatsapp };
}

/** Pelunasan → status lunas + pesan WA + aktifkan kembali pelanggan. */
async function lunaskanTagihan(idTagihan, metode, { verifiedBy = null, ref = null, jumlah = null } = {}) {
  const t = await db.one('SELECT * FROM tagihan WHERE id = ?', [idTagihan]);
  if (!t) throw new Error('Tagihan tidak ditemukan');
  if (t.status === 'lunas') return { already: true };

  await db.run(
    'UPDATE tagihan SET status = ?, metode_bayar = ?, paid_at = NOW() WHERE id = ?',
    ['lunas', metode, idTagihan]
  );
  if (jumlah !== null) {
    await db.insert(
      'INSERT INTO pembayaran (id_tagihan, jumlah, metode, status, ref, verified_by) VALUES (?,?,?,?,?,?)',
      [idTagihan, jumlah, metode === 'manual' ? 'manual' : metode, 'diterima', ref, verifiedBy]
    );
  }

  // catat pemasukan ke kas (laporan keuangan) — idempoten karena fungsi ini
  // sudah kembali lebih dulu bila tagihan sebelumnya lunas
  const nominal = Number(jumlah !== null ? jumlah : t.total);
  if (nominal > 0) {
    try {
      await db.insert(
        `INSERT INTO kas (id_data_server, tipe, kategori, jumlah, keterangan, id_ref, dibuat_oleh)
         VALUES (?, 'masuk', 'pembayaran', ?, ?, ?, ?)`,
        [t.id_data_server, nominal, `Invoice ${t.nomor_invoice} (${metode})`, idTagihan, verifiedBy]
      );
    } catch (_) { /* kas tidak boleh menggagalkan pelunasan tagihan */ }
  }

  const p = await db.one('SELECT * FROM pelanggan WHERE id = ?', [t.id_pelanggan]);
  let router = null;
  if (p) {
    await db.run('UPDATE pelanggan SET status = ? WHERE id = ? AND status = ?', ['aktif', p.id, 'isolir']);
    await db.run('DELETE FROM issue_pelanggan WHERE id_pelanggan = ? AND tipe IN (?,?)', [p.id, 'menunggak', 'isolir']);
    // Pelanggan yang diisolir otomatis juga dimatikan secret-nya di router,
    // jadi pelunasan harus mengembalikannya — kalau tidak, status bilang aktif
    // tapi warga tetap tidak bisa connect.
    if (p.tipe === 'pppoe' && p.username_pppoe) {
      try { router = await mon.setSecret(p.username_pppoe, { disabled: false, idDataServer: t.id_data_server }); }
      catch (e) { router = { router: null, gagal: [String(e.message).slice(0, 120)] }; }
    }
  }
  // Kwitansi gambar menyusul: gateway WA yang mati tidak boleh membatalkan
  // pelunasan (sama seperti gratisinaja — kegagalan kirim jadi peringatan).
  let kw = null, kwGagal = null;
  try { kw = await kirimKwitansi(idTagihan); }
  catch (e) { kwGagal = String(e.message).slice(0, 160); }
  return { ok: true, router, kwitansi: kw, kwitansi_gagal: kwGagal };
}

/** Isolir pelanggan yang lewat jatuh tempo + pesan isolir. */
async function isolirJatuhTempo(idDataServer = 1) {
  const tagihan = await db.q(
    `SELECT t.*, p.nama, p.nomor_whatsapp, p.tipe, p.username_pppoe, p.id AS pid
     FROM tagihan t JOIN pelanggan p ON p.id = t.id_pelanggan
     WHERE t.id_data_server = ? AND t.status = 'jatuh_tempo' AND p.status = 'aktif'
     LIMIT 50`,
    [idDataServer]
  );
  let n = 0;
  const routerGagal = [];
  for (const t of tagihan) {
    await db.run('UPDATE pelanggan SET status = ? WHERE id = ?', ['isolir', t.pid]);
    // Status DB saja tidak memutus layanan: secret PPPoE harus ikut disabled
    // dan sesi yang sedang naik harus dibuang.
    if (t.tipe === 'pppoe' && t.username_pppoe) {
      try {
        const r = await mon.setSecret(t.username_pppoe, { disabled: true, idDataServer });
        if (!r.router) routerGagal.push(`${t.username_pppoe}: ${r.gagal.join(' / ') || 'secret tidak ada di router tenant'}`);
      } catch (e) {
        routerGagal.push(`${t.username_pppoe}: ${String(e.message).slice(0, 120)}`);
      }
    }
    await db.insert(
      'INSERT INTO issue_pelanggan (id_pelanggan, tipe, pesan) VALUES (?,?,?)',
      [t.pid, 'isolir', `Menunggak tagihan ${t.nomor_invoice} (Rp ${Number(t.total).toLocaleString('id-ID')})`]
    );
    if (t.nomor_whatsapp) {
      const tpl = await wa.ambilTemplate('isolir', t.id_data_server);
      const pesan = wa.render(tpl, {
        usr: t.nama, inv: t.nomor_invoice,
        tot: Number(t.total).toLocaleString('id-ID'),
        lmt: tglIndo(t.jatuh_tempo), lyn: 'layanan'
      });
      await wa.enqueue({ tujuan: t.nomor_whatsapp, jenis: 'isolir', pesan, idRef: t.id, idDataServer: idDataServer });
    }
    n++;
  }
  return { isolir: n, router_gagal: routerGagal };
}

module.exports = {
  tglIndo, buatTagihanBulanan, buatTagihanSatuan, kirimTagihanWajib,
  peringatanTagihan, lunaskanTagihan, isolirJatuhTempo, kirimKwitansi
};
