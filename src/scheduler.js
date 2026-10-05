'use strict';
// ============================================================
// Scheduler internal (tanpa dependensi) — cronjob ivvibill:
//  1. Buat tagihan bulanan        (sesuai jadwal_buat_hari)
//  2. Kirim tagihan WA            (sesuai jadwal_kirim_hari + jam)
//  3. Peringatan tagihan          (H-3 & penanda lewat tempo)
//  4. Isolir menunggak            (lewat jatuh tempo)
//  5. Antrean WhatsApp             (tiap menit)
//  6. Polling router interface    (tiap menit, kecuali pppoe)
//  7. Polling redaman OLT         (interval per perangkat)
//  8. Deteksi issue pelanggan PPPoE (offline/isolir)
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

const log = (...a) => console.log(`[ivvibill ${new Date().toISOString()}]`, ...a);

let timers = [];
let running = { wa: false, router: false, olt: false, billing: false, issue: false };

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
    if (err.length) log('Router down:', err.map(e => `${e.id}:${e.error}`).join('; '));
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
        let kritis = 0, warning = 0;
        for (const o of hasil.onus) {
          if (o.error) continue;
          if (o.status_redaman === 'kritis') kritis++;
          else if (o.status_redaman === 'warning') warning++;
          if (o.sn) {
            await db.run(
              `INSERT INTO master_onu (id_perangkat, pon, sn, mac, nama_onu, rx_dbm, tx_dbm, status_online)
               VALUES (?,?,?,?,?,?,?,?)
               ON DUPLICATE KEY UPDATE pon=VALUES(pon), mac=VALUES(mac), nama_onu=VALUES(nama_onu),
                 rx_dbm=VALUES(rx_dbm), tx_dbm=VALUES(tx_dbm), status_online=VALUES(status_online)`,
              [dev.id, o.pon, o.sn, o.mac || null, o.nama || null, o.rx, o.tx, o.online ? 1 : 0]
            );
            await db.insert(
              'INSERT INTO redaman_log (id_perangkat, sn, pon, rx_dbm, redaman_db, status) VALUES (?,?,?,?,?,?)',
              [dev.id, o.sn, o.pon, o.rx, o.redaman, o.status_redaman]
            );
          }
        }
        await db.run(
          `UPDATE setting_olt SET last_check_at = NOW(), last_check_msg = ? WHERE id = ?`,
          [`ONU:${hasil.onus.length} kritis:${kritis} warning:${warning}`, dev.sid]
        );
        await db.run(`UPDATE master_perangkat SET last_check = NOW(), last_msg = ? WHERE id = ?`,
          [`OK ${hasil.onus.length} ONU`, dev.id]);
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
    const srv = await require('./services/configData').getServer(1, true);

    if (now.getUTCDate() === Number(srv.jadwal_buat_hari)) {
      const r = await billing.buatTagihanBulanan(1, false);
      if (r.dibuat) log('Tagihan dibuat:', r.dibuat);
    }
    if (now.getUTCDate() === Number(srv.jadwal_kirim_hari) && jam === srv.jam_kirim) {
      const r = await billing.kirimTagihanWajib(1, 50);
      log('Tagihan dikirim WA:', r.dikirim);
    }
    // peringatan tiap hari jam 08:00
    if (jam === '08:00') {
      const r = await billing.peringatanTagihan(1, 50);
      if (r.diperingat) log('Peringatan:', r.diperingat);
    }
    // isolir tiap hari jam 09:00
    if (jam === '09:00') {
      const r = await billing.isolirJatuhTempo(1);
      if (r.isolir) log('Isolir:', r.isolir);
    }
  } catch (e) { log('Billing error:', e.message); }
  finally { running.billing = false; }
}

async function tugasIssue() {
  if (running.issue) return;
  running.issue = true;
  try {
    const r = await monitor.cekPppoePelanggan(1);
    if (r.offline) log('PPPoE offline:', r.offline, '/', r.dicek);
  } catch (e) { log('Issue error:', e.message); }
  finally { running.issue = false; }
}

// ---------- kontrol ------------------------------------------------

function mulai() {
  if (timers.length) return;
  timers.push(setInterval(tugasWa, 60 * 1000));                 // antrean WA tiap menit
  timers.push(setInterval(tugasRouter, 60 * 1000));             // router tiap menit
  timers.push(setInterval(tugasOlt, 60 * 1000));                // cek jadwal OLT tiap menit
  timers.push(setInterval(tugasBilling, 60 * 1000));            // billing tiap menit
  timers.push(setInterval(tugasIssue, Number(process.env.ISSUE_INTERVAL_MIN || 10) * 60 * 1000));
  // run sekali di awal (delay supaya server siap)
  setTimeout(() => { tugasWa(); tugasRouter(); }, 5000);
  log('Scheduler aktif (wa, router, olt, billing, issue)');
}

function berhenti() {
  timers.forEach(clearInterval);
  timers = [];
}

module.exports = { mulai, berhenti, tugasWa, tugasRouter, tugasOlt, tugasBilling, tugasIssue };
