'use strict';
// ============================================================
// Billing — pembuatan tagihan, pembayaran manual & gateway,
// pelunasan, isolir, plus deteksi issue pelanggan PPPoE.
// ============================================================
const db = require('../db');
const cfgData = require('./configData');
const wa = require('./wa');

function tglIndo(d) {
  if (!d) return '';
  const bulan = ['Januari','Februari','Maret','April','Mei','Juni','Juli','Agustus','September','Oktober','November','Desember'];
  const [y, m, day] = String(d).split('-');
  return `${Number(day)} ${bulan[Number(m) - 1]} ${y}`;
}

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

    const invoice = await cfgData.nomorInvoice();
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

  const p = await db.one('SELECT * FROM pelanggan WHERE id = ?', [t.id_pelanggan]);
  if (p) {
    await db.run('UPDATE pelanggan SET status = ? WHERE id = ? AND status = ?', ['aktif', p.id, 'isolir']);
    await db.run('DELETE FROM issue_pelanggan WHERE id_pelanggan = ? AND tipe IN (?,?)', [p.id, 'menunggak', 'isolir']);
    if (p.nomor_whatsapp) {
      const tpl = await wa.ambilTemplate('lunas', t.id_data_server);
      const srv = await cfgData.getServer(t.id_data_server);
      const pesan = wa.render(tpl, {
        usr: p.nama, tot: Number(t.total).toLocaleString('id-ID'),
        inv: t.nomor_invoice, srv: (srv && srv.nama_server) || ''
      });
      await wa.enqueue({ tujuan: p.nomor_whatsapp, jenis: 'lunas', pesan, idRef: t.id, idDataServer: t.id_data_server });
    }
  }
  return { ok: true };
}

/** Isolir pelanggan yang lewat jatuh tempo + pesan isolir. */
async function isolirJatuhTempo(idDataServer = 1) {
  const tagihan = await db.q(
    `SELECT t.*, p.nama, p.nomor_whatsapp, p.id AS pid
     FROM tagihan t JOIN pelanggan p ON p.id = t.id_pelanggan
     WHERE t.id_data_server = ? AND t.status = 'jatuh_tempo' AND p.status = 'aktif'
     LIMIT 50`,
    [idDataServer]
  );
  let n = 0;
  for (const t of tagihan) {
    await db.run('UPDATE pelanggan SET status = ? WHERE id = ?', ['isolir', t.pid]);
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
  return { isolir: n };
}

module.exports = {
  tglIndo, buatTagihanBulanan, kirimTagihanWajib,
  peringatanTagihan, lunaskanTagihan, isolirJatuhTempo
};
