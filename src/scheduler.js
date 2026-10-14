'use strict';
// ============================================================
// Scheduler internal (tanpa dependensi) — cronjob ivvibill:
//  1. Buat tagihan bulanan        (hari dari profil_tagihan pelanggan;
//                                 fallback jadwal_buat_hari)
//  2. Kirim tagihan WA            (hari dari profil_tagihan + jam_kirim)
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
//
// Tanggal & jam yang dibandingkan di tugasBilling adalah jam dinding ISP
// (zona aplikasi, default Asia/Jakarta) lewat util/tanggal.waktuSiklus —
// bukan UTC. Ambang "sudah lewat jam" dipakai supaya siklus tidak hilang
// kalau proses sedang restart tepat pada menit jam_kirim.
// ============================================================
const db = require('./db');
const billing = require('./services/billing');
const wa = require('./services/wa');
const monitor = require('./services/monitoring');
const olt = require('./services/olt');
const onu = require('./services/onu');
const cfgData = require('./services/configData');
const crypto = require('./util/crypto');
const { waktuSiklus } = require('./util/tanggal');

/**
 * Daftar ISP yang berhak disiklus; kolom jadwal dipilih eksplisit agar rahasia
 * gateway tidak terbawa. Termasuk gerbang masa aktif: dulu hanya status='Aktif',
 * jadi ISP yang sudah habis expaired_date-nya tetap dibuatkan tagihan,
 * tetap dikirim WhatsApp, dan tetap di-isolir pelanggannya oleh scheduler.
 *
 * Klause langganannya dipakai dari configData (FILTER_BERLANGGANAN) supaya
 * scheduler dan gerbang login tidak bisa lagi punya aturan yang berbeda.
 * expaired_date = hari TERAKHIR yang masih berlaku, jadi `>= CURDATE()`:
 * sebelumnya di sini ada kelonggaran INTERVAL 1 DAY sehingga ISP yang
 * configData.habisMasa() sudah nyatakan berakhir masih ikut disiklus.
 */
async function daftarTenant() {
  return db.q(
    `SELECT id, nama_server, jadwal_buat_hari, jadwal_kirim_hari, jadwal_limit_hari,
            jam_kirim, jam_peringatan, jam_isolir
     FROM data_server
     WHERE 1=1${cfgData.FILTER_BERLANGGANAN}
     ORDER BY id`
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
    // pesan yang pernah gagal (gateway sempat mati / URL media ditolak) jangan
    // berhenti di 'gagal' selamanya: dicoba lagi sampai MAX_PERCOBAAN
    const u = await wa.prosesAntrean(10, null, 'gagal');
    if (u.sent || u.failed) log('WA ulang:', JSON.stringify(u));
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
      `SELECT d.*, s.olt_tx_dbm, s.rx_min_dbm, s.att_max_db, s.interval_menit,
              s.last_check_at, s.last_check_msg, s.id AS sid
       FROM setting_olt s JOIN master_perangkat d ON d.id = s.id_perangkat
       WHERE s.status = 'aktif' AND d.status = 'aktif'`
    );
    const now = new Date();
    for (const dev of due) {
      const interval = Number(dev.interval_menit || 5) * 60000;
      const last = dev.last_check_at ? new Date(dev.last_check_at).getTime() : 0;
      // "Password check failed" dari perangkat = kredensialnya yang salah, bukan
      // jaringannya. Banyak firmware mengunci akun admin setelah sejumlah percobaan
      // gagal, jadi mundur minimal 15 menit daripada menembak tiap interval dan
      // mengunci akun yang justru dibutuhkan teknisi.
      const ditolak = /password|login ditolak|4031|4034|unauth|not login/i
        .test(String(dev.last_check_msg || ''));
      if (now - last < (ditolak ? Math.max(interval, 15 * 60000) : interval)) continue;
      try {
        // Kolom di DB adalah password_enc (AES-GCM) sedangkan driver membaca
        // dev.password. Dulu baris hasil query dikirim apa adanya, sehingga SETIAP
        // polling otomatis login dengan md5("user:undefined") dan selalu ditolak
        // perangkat — list ONU dan redaman tidak pernah terisi.
        const hasil = await olt.pollOlt(
          { ...dev, password: crypto.decrypt(dev.password_enc) }, dev);
        const s = await onu.simpan(dev.id, hasil.onus);
        const pesan = s.tersimpan
          ? `ONU:${s.tersimpan} kritis:${s.kritis} warning:${s.warning}`
          : `Nol ONU tersimpan${(hasil.gagal || []).length ? ' — ' + hasil.gagal.join('; ') : ''}`;
        await db.run(
          `UPDATE setting_olt SET last_check_at = NOW(), last_check_msg = ? WHERE id = ?`,
          [pesan, dev.sid]
        );
        await db.run(`UPDATE master_perangkat SET last_check = NOW(), last_msg = ? WHERE id = ?`,
          [`OK ${s.tersimpan} ONU`, dev.id]);
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
    const w = waktuSiklus();
    const logLokal = (...a) => log(`[siklus ${w.hari} ${w.jam} ${w.zona}]`, ...a);

    for (const srv of await daftarTenant()) {
      const tag = `[${srv.id} ${srv.nama_server}]`;
      // Seluruh gerbang hari/jam ada di billing.jalankanSiklusTenant() — fungsi
      // yang sama dipanggil tombol "Jalankan Siklus" di panel, jadi tidak ada
      // lagi dua jalur yang bisa berbeda perilaku. COALESCE di dalamnya tetap
      // memakai jadwal_buat_hari/jadwal_kirim_hari bila pelanggan belum punya
      // profil, sehingga tenant lama tidak berubah perilakunya.
      const { langkah: l } = await billing.jalankanSiklusTenant(srv, w, 50);

      if (l.buat.jalan && l.buat.dibuat)
        logLokal('Tagihan dibuat', tag + ':', l.buat.dibuat, JSON.stringify(l.buat.per_profil));
      if (l.kirim.jalan && l.kirim.dikirim)
        logLokal('Tagihan dikirim WA', tag + ':', l.kirim.dikirim);
      if (l.peringatan.jalan && l.peringatan.diperingat)
        logLokal('Peringatan', tag + ':', l.peringatan.diperingat);

      if (l.isolir.jalan && l.isolir.isolir) {
        // operator perlu bukti sesi yang sedang naik benar-benar diputus,
        // bukan cuma status DB yang berubah
        const sesi = (l.isolir.daftar || []).reduce((a, x) => a + Number(x.sesi_dibuang || 0), 0);
        logLokal('Isolir', tag + ':', l.isolir.isolir,
          sesi ? `(sesi aktif dibuang: ${sesi})` : '(tidak ada sesi aktif)');
      }
      // status DB sudah isolir tapi secret masih hidup = layanan tidak putus
      if (l.isolir.router_gagal && l.isolir.router_gagal.length)
        logLokal('Isolir TANPA router', tag + ':', l.isolir.router_gagal.slice(0, 3).join(' | '));
      // pelanggan tanpa nomor WA tetap diisolir + dicatat, jangan diam-diam
      if (l.isolir.tanpa_nomor_wa && l.isolir.tanpa_nomor_wa.length)
        logLokal('Isolir tanpa WA', tag + ':', l.isolir.tanpa_nomor_wa.slice(0, 3).join(', '));
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

module.exports = { mulai, berhenti, tugasWa, tugasRouter, tugasOlt, tugasBilling, tugasIssue, tugasVoucher, daftarTenant };
