'use strict';
// ============================================================
// Scheduler internal (tanpa dependensi) — cronjob ivvibill:
//  1. Buat tagihan bulanan        (sesuai jadwal_buat_hari)
//  2. Kirim tagihan WA            (sesuai jadwal_kirim_hari + jam)
//  3. Peringatan tagihan          (H-3 & penanda lewat tempo)
//  4. Isolir menunggak            (lewat jatuh tempo)
//  5. Antrean WhatsApp             (tiap menit)
//  6. Polling router interface    (tiap menit, kecuali pppoe)
//  7. Polling redaman OLT         (interval per perangkat) + cocokkan ONU
//  8. Deteksi issue pelanggan PPPoE (offline/isolir)
//  9. Jadwal voucher hotspot: cabut user jatuh tempo + retry push gagal
//
// Semua tugas berjalan in-process; untuk shared hosting tanpa
// proses panjang, tersedia juga skrip cron eksternal di
// scripts/cron.js (lihat docs/CRON.md).
// ============================================================
const db = require('./db');
const billing = require('./services/billing');
const wa = require('./services/wa');
const monitor = require('./services/monitoring');
const olt = require('./services/olt');
const onu = require('./services/onu');

/** Daftar ISP aktif; kolom jadwal dipilih eksplisit agar rahasia gateway tidak terbawa. */
async function daftarTenant() {
  return db.q(
    `SELECT id, nama_server, jadwal_buat_hari, jadwal_kirim_hari, jadwal_limit_hari, jam_kirim
     FROM data_server WHERE status = 'Aktif' ORDER BY id`
  );
}

const log = (...a) => console.log(`[ivvibill ${new Date().toISOString()}]`, ...a);

let timers = [];
let running = { wa: false, router: false, olt: false, billing: false, issue: false, voucher: false };

// ---------- tugas ------------------------------------------------

async function tugasWa() {
  if (running.wa) return;
  running.wa = true;
  try {
    const r = await wa.prosesAntrean(30);
    if (r.sent || r.failed) log('WA antrean:', JSON.stringify(r));
  } catch (e) { log('WA error:', e.message); }
  finally { running.wa = false; }
}

async function tugasRouter() {
  if (running.router) return;
  running.router = true;
  try {
    const r = await monitor.pollSemuaRouter();
    const err = r.filter(x => !x.ok);
    if (err.length) log('Gagal polling router:', err.map(e => `${e.id}:${e.error}`).join('; '));
  } catch (e) { log('Router error:', e.message); }
  finally { running.router = false; }
}

async function tugasOlt() {
  if (running.olt) return;
  running.olt = true;
  try {
    const due = await db.q(
      `SELECT d.*, s.olt_tx_dbm, s.rx_min_dbm, s.att_max_db, s.interval_menit, s.last_check_at, s.id AS sid
       FROM setting_olt s JOIN master_perangkat d ON d.id = s.id_perangkat
       WHERE s.status = 'aktif' AND d.status = 'aktif'`
    );
    const now = new Date();
    for (const dev of due) {
      const interval = Number(dev.interval_menit || 5) * 60000;
      const last = dev.last_check_at ? new Date(dev.last_check_at).getTime() : 0;
      if (now - last < interval) continue;
      try {
        const hasil = await olt.pollOlt(dev, dev);
        const s = await onu.simpan(dev.id, hasil.onus);
        await db.run(
          `UPDATE setting_olt SET last_check_at = NOW(), last_check_msg = ? WHERE id = ?`,
          [`ONU:${hasil.onus.length} kritis:${s.kritis} warning:${s.warning}`, dev.sid]
        );
        await db.run(`UPDATE master_perangkat SET last_check = NOW(), last_msg = ? WHERE id = ?`,
          [`OK ${hasil.onus.length} ONU`, dev.id]);
        // redaman baru berarti baris ONU baru; pengikatan ke pelanggan mengikuti
        const c = await onu.cocokkan({ idPerangkat: dev.id });
        if (c.berubah) log(`Cocok ONU ${dev.nama}:`, JSON.stringify(c));
      } catch (e) {
        await db.run(`UPDATE setting_olt SET last_check_at = NOW(), last_check_msg = ? WHERE id = ?`,
          [String(e.message).slice(0, 250), dev.sid]);
        await db.run(`UPDATE master_perangkat SET last_check = NOW(), last_msg = ? WHERE id = ?`,
          [String(e.message).slice(0, 250), dev.id]);
        log(`OLT ${dev.nama} error:`, e.message);
      }
    }
  } catch (e) { log('OLT error:', e.message); }
  finally { running.olt = false; }
}

async function tugasBilling() {
  if (running.billing) return;
  running.billing = true;
  try {
    const now = new Date();
    const jam = `${String(now.getUTCHours()).padStart(2, '0')}:${String(now.getUTCMinutes()).padStart(2, '0')}`;

    for (const srv of await daftarTenant()) {
      const tag = `[${srv.id} ${srv.nama_server}]`;
      if (now.getUTCDate() === Number(srv.jadwal_buat_hari)) {
        const r = await billing.buatTagihanBulanan(srv.id, false);
        if (r.dibuat) log('Tagihan dibuat', tag + ':', r.dibuat);
      }
      if (now.getUTCDate() === Number(srv.jadwal_kirim_hari) && jam === srv.jam_kirim) {
        const r = await billing.kirimTagihanWajib(srv.id, 50);
        log('Tagihan dikirim WA', tag + ':', r.dikirim);
      }
      // peringatan tiap hari jam 08:00
      if (jam === '08:00') {
        const r = await billing.peringatanTagihan(srv.id, 50);
        if (r.diperingat) log('Peringatan', tag + ':', r.diperingat);
      }
      // isolir tiap hari jam 09:00
      if (jam === '09:00') {
        const r = await billing.isolirJatuhTempo(srv.id);
        if (r.isolir) log('Isolir', tag + ':', r.isolir);
        // status DB sudah isolir tapi secret masih hidup = layanan tidak putus
        if (r.router_gagal && r.router_gagal.length) {
          log('Isolir TANPA router', tag + ':', r.router_gagal.slice(0, 3).join(' | '));
        }
      }
    }
  } catch (e) { log('Billing error:', e.message); }
  finally { running.billing = false; }
}

async function tugasIssue() {
  if (running.issue) return;
  running.issue = true;
  try {
    let dicek = 0, offline = 0;
    for (const srv of await daftarTenant()) {
      const r = await monitor.cekPppoePelanggan(srv.id);
      dicek += r.dicek; offline += r.offline;
    }
    if (offline) log('PPPoE offline:', offline, '/', dicek);
  } catch (e) { log('Issue error:', e.message); }
  finally { running.issue = false; }
}

/**
 * Jadwal voucher hotspot — versi ivvibill dari '/system schedule' gratisinaja.
 * Gratisinaja menaruh hitung mundurnya di router (skrip On Login membuat
 * entri scheduler per voucher); di sini jatuh tempo dijalankan proses sendiri
 * supaya statusnya terlihat di panel dan bisa diulang kalau router macet.
 *  1. voucher lewat expired_at  -> user hotspot + sesinya dibuang, status batal
 *     pakai 'kedaluwarsa'
 *  2. push yang gagal/belum, selama masih berlaku dan baru dibuat -> dikirim
 *     ulang, jadi router yang tadi mati tidak membuat voucher selamanya cacat
 */
async function tugasVoucher() {
  if (running.voucher) return;
  running.voucher = true;
  try {
    const mati = await db.q(
      `SELECT id, kode, id_data_server, router_status FROM voucher
       WHERE status IN ('stok','terjual','terpakai') AND expired_at < NOW()
       ORDER BY expired_at LIMIT 50`);
    let dicabut = 0, ditunda = 0, hangus = 0;
    for (const m of mati) {
      let h = { ada: false, gagal: [] };
      if (m.router_status === 'ok') h = await monitor.hapusHotspotUser(m.kode, Number(m.id_data_server));
      if (h.gagal && h.gagal.length) { ditunda++; continue; }   // router macet: coba lagi siklus berikut
      await db.run("UPDATE voucher SET status='kedaluwarsa', router_status='belum', router_nama=NULL WHERE id=?",
        [m.id]);
      if (h.ada) dicabut++;
      hangus++;
    }

    const tunggu = await db.q(
      `SELECT vc.id, vc.kode, vc.id_data_server, vc.status, pk.profile_hotspot, pk.nama_paket,
              pk.masa_aktif, pk.satuan
       FROM voucher vc JOIN paket pk ON pk.id = vc.id_paket
       WHERE vc.router_status <> 'ok' AND vc.status IN ('stok','terjual','terpakai')
         AND vc.expired_at > NOW() AND vc.created_at > NOW() - INTERVAL 7 DAY
         AND pk.profile_hotspot IS NOT NULL AND pk.profile_hotspot <> ''
       ORDER BY vc.id LIMIT 20`);
    let terkirim = 0;
    const perTenant = new Map();
    for (const t of tunggu) {
      // hanya voucher yang sudah login punya schedule: stok tidak boleh
      // kehabisan masa aktif sebelum terjual
      const dur = t.status === 'terpakai' ? monitor.intervalVoucher(t) : null;
      const k = `${t.id_data_server}\n${dur ? 'j' : '-'}\n${t.profile_hotspot}`;
      if (!perTenant.has(k)) perTenant.set(k, []);
      perTenant.get(k).push(t);
    }
    for (const [k, rows] of perTenant) {
      const [ds, kinds, profil] = k.split('\n');
      try {
        const r = await monitor.pushVoucher(Number(ds), rows,
          { profil, komentar: `ivvibill ${rows[0].nama_paket || ''}`,
            jadwal: kinds === 'j' ? monitor.intervalVoucher(rows[0]) : null });
        terkirim += r.terkirim;
      } catch (e) { log('Retry voucher error:', e.message); }
    }
    if (hangus || terkirim || ditunda) {
      log('Jadwal voucher:', JSON.stringify({ hangus, dicabut, terkirim_ulang: terkirim, ditunda }));
    }
    // ikut dikembalikan: endpoint /internal/cron/voucher memakainya sebagai
    // bukti siklus benar-benar berjalan, bukan hanya "200 kosong"
    return { hangus, dicabut, terkirim_ulang: terkirim, ditunda };
  } catch (e) { log('Voucher error:', e.message); return { error: e.message }; }
  finally { running.voucher = false; }
}

// ---------- kontrol ------------------------------------------------

function mulai() {
  if (timers.length) return;
  timers.push(setInterval(tugasWa, 60 * 1000));                 // antrean WA tiap menit
  timers.push(setInterval(tugasRouter, 60 * 1000));             // router tiap menit
  timers.push(setInterval(tugasOlt, 60 * 1000));                // cek jadwal OLT tiap menit
  timers.push(setInterval(tugasBilling, 60 * 1000));            // billing tiap menit
  timers.push(setInterval(tugasVoucher, 60 * 1000));            // jatuh tempo + retry push voucher
  timers.push(setInterval(tugasIssue, Number(process.env.ISSUE_INTERVAL_MIN || 10) * 60 * 1000));
  // run sekali di awal (delay supaya server siap)
  setTimeout(() => { tugasWa(); tugasRouter(); tugasVoucher(); }, 5000);
  log('Scheduler aktif (wa, router, olt, billing, voucher, issue)');
}

function berhenti() {
  timers.forEach(clearInterval);
  timers = [];
}

module.exports = { mulai, berhenti, tugasWa, tugasRouter, tugasOlt, tugasBilling, tugasIssue, tugasVoucher };
