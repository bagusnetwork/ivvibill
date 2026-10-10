'use strict';
// ============================================================
// Monitoring — interface router (KECUALI pppoe), resource,
// deteksi issue pelanggan PPPoE (offline > batas), dan tulis-menulis
// akun di router: secret PPPoE + user hotspot voucher.
// ============================================================
const db = require('../db');
const { RouterOS } = require('./routeros');
const crypto = require('../util/crypto');
const cryptoLib = require('crypto');
const config = require('../config');
const wa = require('./wa');

async function perangkatMikrotik(idSetting) {
  const s = await db.one('SELECT * FROM setting_mikrotik WHERE id = ?', [idSetting]);
  if (!s) throw new Error('Setting MikroTik tidak ada');
  const dev = await db.one('SELECT * FROM master_perangkat WHERE id = ?', [s.id_perangkat]);
  if (!dev) throw new Error('Perangkat tidak ada');
  return { setting: s, dev };
}

/**
 * Per-router penghitung siklus gagal berturut-turut. Status 'down' di DB baru
 * ditulis setelah AMBANG_DOWN siklus gagal, supaya link yang sering membuang
 * paket (EHOSTUNREACH) tidak membuat router tampak mati.
 */
const gagalRouter = new Map();
const AMBANG_DOWN = 3;

function klien(dev) {
  return new RouterOS({
    host: dev.alamat,
    port: dev.port || 8728,
    user: dev.username,
    password: crypto.decrypt(dev.password_enc),
    timeout: 9000
  });
}

/**
 * Router jauh bisa reachable tapi link-nya sering membuang SYN (EHOSTUNREACH),
 * jadi koneksi API dicoba beberapa kali sebelum dianggap down.
 */
async function sambungkan(c, percobaan = 3, jedaMs = 1200) {
  let err = new Error('Koneksi RouterOS gagal');
  for (let i = 1; i <= percobaan; i++) {
    try { await c.connect(); return; }
    catch (e) {
      err = e;
      c.close();
      if (i < percobaan) await new Promise(r => setTimeout(r, jedaMs));
    }
  }
  throw err;
}

/**
 * Polling satu router: interface (tanpa pppoe) + traffic + resource.
 * Hasil disimpan ke interface_log / router_resource_log / setting_mikrotik.
 */
async function pollRouter(idSetting) {
  const { setting, dev } = await perangkatMikrotik(idSetting);
  const c = klien(dev);
  try {
    await sambungkan(c);
    const ifaces = await c.listInterfaces();       // ← sudah difilter: tanpa pppoe
    const names = ifaces.map(i => i.name).filter(Boolean);
    // rate dihitung dari selisih counter rx-byte/tx-byte vs sampel poll sebelumnya
    let traffic = {};
    try { traffic = c.monitorRate(names, ifaces); } catch (_) { /* perangkat lama */ }

    let res = {};
    try { res = await c.resource(); } catch (_) {}

    for (const i of ifaces) {
      const t = traffic[i.name] || { rx: 0, tx: 0 };
      const up = String(i.disabled) !== 'true' && String(i.running ?? 'true') !== 'false';
      await db.insert(
        'INSERT INTO interface_log (id_setting, iface, tipe, status, rx_bps, tx_bps) VALUES (?,?,?,?,?,?)',
        [setting.id, i.name, i.type || 'ether', up ? 'up' : 'down', Number(t.rx) || 0, Number(t.tx) || 0]
      );
    }
    if (res.cpu_load !== undefined) {
      await db.insert(
        'INSERT INTO router_resource_log (id_setting, cpu_load, memory_used) VALUES (?,?,?)',
        [setting.id, res.cpu_load, res.memory_used]
      );
      await db.run(
        `UPDATE setting_mikrotik SET last_check = NOW(), cpu_load = ?, memory_usage = ?,
         uptime = ?, board_name = ?, status = 'active' WHERE id = ?`,
        [String(res.cpu_load ?? ''), res.memory_used !== null && res.memory_used !== undefined ? res.memory_used + '%' : null,
         res.uptime || null, res.board_name || null, setting.id]
      );
    } else {
      await db.run(
        `UPDATE setting_mikrotik SET last_check = NOW(), status = 'active' WHERE id = ?`,
        [setting.id]
      );
    }
    await db.run('UPDATE master_perangkat SET last_check = NOW(), last_msg = ? WHERE id = ?',
      ['OK', dev.id]);
    gagalRouter.delete(setting.id);
    return { ok: true, interfaces: ifaces.length };
  } catch (e) {
    // link ke router jauh bisa drop sebentar (EHOSTUNREACH) — status 'down'
    // baru dipasang setelah beberapa siklus gagal berturut-turut.
    const gagal = (gagalRouter.get(setting.id) || 0) + 1;
    gagalRouter.set(setting.id, gagal);
    if (gagal >= AMBANG_DOWN) {
      await db.run(
        `UPDATE setting_mikrotik SET last_check = NOW(), status = 'down' WHERE id = ?`,
        [setting.id]
      );
    }
    await db.run('UPDATE master_perangkat SET last_check = NOW(), last_msg = ? WHERE id = ?',
      [`gagal ke-${gagal}: ${String(e.message).slice(0, 200)}`, dev.id]);
    throw e;
  } finally {
    c.close();
  }
}

/**
 * Cek status koneksi PPPoE semua pelanggan aktif → tandai offline,
 * buat issue + pesan WA sesuai batas_offline_menit.
 */
async function cekPppoePelanggan(idDataServer = 1) {
  const aktif = await db.q(
    `SELECT p.id, p.nama, p.username_pppoe, p.nomor_whatsapp, p.id_data_server
     FROM pelanggan p
     WHERE p.id_data_server = ? AND p.status = 'aktif' AND p.tipe = 'pppoe'
       AND p.username_pppoe IS NOT NULL AND p.username_pppoe != ''`,
    [idDataServer]
  );
  if (!aktif.length) return { dicek: 0, offline: 0 };

  const routers = await db.q(
    `SELECT s.id FROM setting_mikrotik s
     JOIN master_perangkat d ON d.id = s.id_perangkat
     WHERE s.id_data_server = ? AND d.status = 'aktif'`,
    [idDataServer]
  );

  const online = new Set();
  let routerSukses = 0;
  for (const r of routers) {
    try {
      const { setting, dev } = await perangkatMikrotik(r.id);
      const c = klien(dev);
      try {
        await sambungkan(c);
        const act = await c.pppoeActive();
        act.forEach(a => online.add(String(a.user).toLowerCase()));
        routerSukses++;
      } finally { c.close(); }
    } catch (_) { /* router gagal diakses → tidak dihitung */ }
  }

  // Tidak ada satu router pun yang terbaca: daftar sesi online kosong bukan karena
  // pelanggan mati, tapi karena link-nya yang gagal. Menandai semua pelanggan
  // offline di sini akan membuat issue palsu + spam WA.
  if (routers.length > 0 && routerSukses === 0) {
    return { dicek: aktif.length, offline: 0, semuaRouterGagal: true };
  }

  let off = 0;
  for (const p of aktif) {
    const isOn = online.has(String(p.username_pppoe).toLowerCase());
    const now = new Date();
    if (isOn) {
      await db.run(
        `INSERT INTO pppoe_status (id_pelanggan, online, last_seen) VALUES (?, 1, NOW())
         ON DUPLICATE KEY UPDATE online = 1, last_seen = NOW(), since_off = NULL`,
        [p.id]
      );
      await db.run(
        `UPDATE issue_pelanggan SET status = 'resolved', resolved_at = NOW()
         WHERE id_pelanggan = ? AND tipe = 'offline' AND status = 'open'`,
        [p.id]
      );
      continue;
    }
    off++;
    const row = await db.one('SELECT since_off FROM pppoe_status WHERE id_pelanggan = ?', [p.id]);
    let since = row && row.since_off ? new Date(row.since_off) : null;
    if (!since) {
      await db.run(
        `INSERT INTO pppoe_status (id_pelanggan, online, since_off) VALUES (?, 0, NOW())
         ON DUPLICATE KEY UPDATE online = 0, since_off = IFNULL(since_off, NOW())`,
        [p.id]
      );
      since = now;
    }
    const menit = Math.round((now - new Date(since)) / 60000);
    const batas = Number((await db.one(
      `SELECT nilai FROM setting_app WHERE kunci = 'batas_offline_menit'`
    ))?.nilai || 15);
    if (menit >= batas) {
      const ada = await db.one(
        `SELECT id FROM issue_pelanggan WHERE id_pelanggan = ? AND tipe = 'offline' AND status = 'open'`,
        [p.id]
      );
      if (!ada) {
        await db.insert(
          'INSERT INTO issue_pelanggan (id_pelanggan, tipe, pesan) VALUES (?,?,?)',
          [p.id, 'offline', `PPPoE ${p.username_pppoe} offline ≥ ${menit} menit`]
        );
        if (p.nomor_whatsapp) {
          const tpl = await wa.ambilTemplate('koneksi_off', idDataServer);
          const pesan = wa.render(tpl, {
            usr: p.nama, lyn: 'layanan', srv: 'IVVI',
            jam: since.toISOString().slice(0, 16).replace('T', ' ')
          });
          await wa.enqueue({ tujuan: p.nomor_whatsapp, jenis: 'koneksi_off', pesan, idRef: p.id, idDataServer });
        }
      }
    }
  }
  return { dicek: aktif.length, offline: off };
}

/** Poll semua router + cek pppoe — dipanggil scheduler. */
async function pollSemuaRouter(idDataServer = null) {
  const filter = idDataServer ? ' AND s.id_data_server = ?' : '';
  const rows = await db.q(
    `SELECT s.id FROM setting_mikrotik s
     JOIN master_perangkat d ON d.id = s.id_perangkat
     WHERE d.status = 'aktif'${filter}`,
    idDataServer ? [Number(idDataServer)] : []
  );
  const hasil = [];
  for (const r of rows) {
    try { hasil.push({ id: r.id, ...(await pollRouter(r.id)) }); }
    catch (e) { hasil.push({ id: r.id, ok: false, error: e.message }); }
  }
  return hasil;
}

/** Router aktif milik satu tenant (urut, belum disentuh). */
async function routerTenant(idDataServer) {
  return db.q(
    `SELECT s.id, s.id_perangkat, d.nama FROM setting_mikrotik s
     JOIN master_perangkat d ON d.id = s.id_perangkat
     WHERE s.id_data_server = ? AND d.status = 'aktif'`,
    [Number(idDataServer)]
  );
}

/**
 * Aktifkan/nonaktifkan secret PPPoE milik pelanggan di router.
 * Pelanggan tidak punya kolom router di skema ini, jadi tiap router tenant
 * dicoba sampai username-nya ketemu. Saat mematikan, sesi yang sedang jalan
 * ikut dibuang: secret cacat (disabled) tidak memutus koneksi yang sudah naik.
 */
async function setSecret(user, { disabled, idDataServer }) {
  const nama = String(user || '').trim();
  if (!nama) throw new Error('Username PPPoE kosong');
  const hasil = { router: null, disabled: !!disabled, sesi_dibuang: 0, gagal: [] };
  for (const r of await routerTenant(idDataServer)) {
    let c;
    try {
      const { dev } = await perangkatMikrotik(r.id);
      c = klien(dev);
      await sambungkan(c);
      const secret = await c.run(['/ppp/secret/print', '?name=' + nama]);
      if (!secret.length || !secret[0]['.id']) continue;
      await c.run(['/ppp/secret/set', '=.id=' + secret[0]['.id'],
        '=disabled=' + (disabled ? 'yes' : 'no')]);
      if (disabled) {
        const sesi = await c.run(['/ppp/active/print', '?user=' + nama]);
        for (const s of sesi) {
          if (!s['.id']) continue;
          try { await c.run(['/ppp/active/remove', '=.id=' + s['.id']]); hasil.sesi_dibuang++; }
          catch (_) { /* sesi sudah putus sendiri */ }
        }
      }
      hasil.router = dev.nama;
      return hasil;
    } catch (e) {
      hasil.gagal.push(`${r.nama}: ${String(e.message).slice(0, 120)}`);
    } finally { if (c) c.close(); }
  }
  return hasil;
}

/**
 * Sesi PPPoE yang sedang aktif di router tenant tetapi usernya tidak ada di
 * tabel pelanggan — akun internet yang tidak akan pernah tertagih.
 */
async function sesiTakTerkenal(idDataServer) {
  const akun = new Set((await db.q(
    `SELECT username_pppoe FROM pelanggan WHERE id_data_server = ?
       AND username_pppoe IS NOT NULL AND username_pppoe != ''`,
    [Number(idDataServer)]
  )).map(r => String(r.username_pppoe).toLowerCase()));
  const out = [];
  const routerGagal = [];
  for (const r of await routerTenant(idDataServer)) {
    let c;
    try {
      const { dev } = await perangkatMikrotik(r.id);
      c = klien(dev);
      await sambungkan(c);
      for (const a of await c.pppoeActive()) {
        const u = String(a.user || '').trim();
        if (!u || akun.has(u.toLowerCase())) continue;
        out.push({ router: dev.nama, user: u, address: a.address || '', uptime: a.uptime || '' });
      }
    } catch (e) {
      routerGagal.push(`${r.nama}: ${String(e.message).slice(0, 120)}`);
      // API router sedang tidak bisa diajak bicara — laporan 40 detik terakhir dari
      // router sendiri masih lebih berguna daripada daftar kosong.
      try {
        for (const s of await sesiSnapshot(r.id_perangkat)) {
          const u = String(s.akun || '').trim();
          if (!u || akun.has(u.toLowerCase())) continue;
          out.push({ router: r.nama, user: u, address: s.ip || '', uptime: s.uptime || '',
            dari: 'snapshot', seen_at: s.seen_at });
        }
      } catch (_) { /* snapshot ikut tidak terbaca — biarkan kosong */ }
    } finally { if (c) c.close(); }
  }
  return { data: out, router_gagal: routerGagal, tercatat: akun.size };
}

// ------------------------------------------------- user hotspot (voucher)

/**
 * Penjaga staging: voucher yang di-generate di mesin uji tidak boleh membuat
 * user hotspot nyata di CCR1009 produksi, jadi push bisa dimatikan lewat env
 * PUSH_HOTSPOT=0. Arah gagalnya sengaja default-nyala: di produksi lupa-set
 * berarti fitur tidak jalan (terlihat), bukan fitur jalan diam-diam di staging.
 */
function pushHotspotAktif() { return process.env.PUSH_HOTSPOT !== '0'; }

/** Nilai tidak boleh membawa '=' atau baris baru: argumen API dipisah per kata. */
function bersih(v, max = 64) {
  const s = String(v == null ? '' : v).replace(/[\r\n=]/g, '').trim().slice(0, max);
  return s || null;
}

/** Paket (masa_aktif + satuan) -> interval schedule RouterOS: 3 jam = "3h", 30 hari = "30d". */
function intervalVoucher(paket) {
  const n = Math.max(1, Number(paket && paket.masa_aktif || 0) || 0);
  if (!n) return null;
  return `${n}${paket && paket.satuan === 'jam' ? 'h' : 'd'}`;
}

/** Interval schedule RouterOS: hanya angka+bentuk satuan pendek ("3h", "30d", "1w2d"). */
function amanInterval(v) {
  const s = String(v == null ? '' : v).trim().toLowerCase();
  if (s && /^([0-9]{1,4}[wdhms]){1,4}$/.test(s)) return s;
  return null;
}

/**
 * Schedule penjatuh tempo di router (meniru script On-Login gratisinaja):
 * name = kode voucher, mulai sekarang, hitung mundur sendiri, dan menghapus
 * dirinya sesudah bekerja supaya daftar schedule tidak menumpuk.
 * Kegagalan dicatat terpisah, TIDAK membatalkan user hotspot.
 */
async function buatJadwalVoucher(c, user, interval, jam, hasil) {
  try {
    const lama = await c.run(['/system/schedule/print', '=.proplist=.id', `?name=${user}`]);
    for (const s of lama) {
      if (s['.id']) await c.run(['/system/schedule/remove', `=.id=${s['.id']}`]);
    }
    await c.run(['/system/schedule/add',
      `=name=${user}`, `=start-date=${bersih(jam.date, 16)}`, `=start-time=${bersih(jam.time, 12)}`,
      `=interval=${interval}`, `=recurring=no`,
      `=on-event=/ip hotspot active remove [find where user="${user}"]; ` +
        `/ip hotspot user remove [find where name="${user}"]; ` +
        `/system schedule remove [find where name="${user}"]`,
      `=comment=ivvibill voucher ${user}`]);
  } catch (e) {
    hasil.jadwal_gagal[user] = String(e.message).slice(0, 250);
  }
}

/**
 * Daftar profile bandwidth di seluruh router tenant, berikut rate-limit-nya.
 * hotspot dibaca dari /ip/hotspot/user/profile, pppoe dari /ppp/profile —
 * keduanya punya nama kolom yang sama, jadi satu fungsi cukup untuk dua jenis.
 *
 * return { data: [{router, nama, kecepatan, shared, nonaktif}], gagal: [pesan] }
 */
async function profilRouter(idDataServer, jenis = 'hotspot') {
  const out = [];
  const gagal = [];
  const jalur = jenis === 'pppoe' ? '/ppp/profile/print' : '/ip/hotspot/user/profile/print';
  for (const r of await routerTenant(idDataServer)) {
    let c;
    try {
      const { dev } = await perangkatMikrotik(r.id);
      c = klien(dev);
      await sambungkan(c);
      const rows = await c.run([jalur, '=.proplist=name,rate-limit,shared-users,disabled']);
      for (const p of rows) {
        if (!p.name) continue;
        out.push({
          router: dev.nama,
          nama: p.name,
          kecepatan: amanTeks(p['rate-limit'], 40) || null,
          shared: amanTeks(p['shared-users'], 16) || null,
          nonaktif: p.disabled === 'yes'
        });
      }
    } catch (e) {
      gagal.push(`${r.nama}: ${String(e.message).slice(0, 120)}`);
    } finally { if (c) c.close(); }
  }
  return { data: out, gagal };
}

/**
 * Profile hotspot yang tersedia di router tenant — dipakai form paket supaya
 * admin memilih nama yang benar-benar ada, bukan menebak.
 */
async function profilHotspot(idDataServer) {
  const h = await profilRouter(idDataServer, 'hotspot');
  return { data: h.data.map(p => ({ router: p.router, nama: p.nama })), gagal: h.gagal };
}

/**
 * Buat user hotspot untuk sekelompok kode sekaligus (satu sesi API per router,
 * 500 voucher tidak berarti 500 koneksi). Meniru gratisinaja: profile dicek
 * lebih dulu dan kalau tidak ada, transaksi dibatalkan — bukan user dibuat
 * dengan profile fallback yang diam-diam memberi kecepatan berbeda.
 *
 * jadwal = interval RouterOS ("3h", "30d") untuk schedule penjatuh tempo di
 * router. Hanya boleh dipakai saat voucher benar-benar dipakai: stok yang belum
 * terjual tidak punya hak mati sebelum login pertama. Gagal membuat schedule
 * TIDAK membatalkan user (dicatat terpisah) — scheduler ivvibill tetap
 * mencabut user saat expired_at, jadi pelanggan tetap kehilangan akses.
 *
 * return { router, dibuat: [kode], gagal: {kode: pesan}, jadwal_gagal: {kode: pesan},
 *          profil_tidak_ada, router_gagal: [..] }
 */
async function tambahHotspotUser(kodeList, { profil, komentar, idDataServer, jadwal }) {
  const nama = bersih(profil);
  const interval = amanInterval(jadwal);
  const hasil = { router: null, dibuat: [], gagal: {}, jadwal_gagal: {}, profil_tidak_ada: false, router_gagal: [] };
  if (!pushHotspotAktif()) {
    for (const k of kodeList) hasil.gagal[k] = 'push hotspot dimatikan (PUSH_HOTSPOT=0)';
    return hasil;
  }
  if (!nama) {
    for (const k of kodeList) hasil.gagal[k] = 'paket belum punya profile hotspot';
    return hasil;
  }
  const comment = bersih(komentar, 120) || 'ivvibill';
  for (const r of await routerTenant(idDataServer)) {
    let c;
    try {
      const { dev } = await perangkatMikrotik(r.id);
      c = klien(dev);
      await sambungkan(c);
      const pf = await c.run(['/ip/hotspot/user/profile/print', '=.proplist=.id', `?name=${nama}`]);
      if (!pf.length || !pf[0]['.id']) { hasil.profil_tidak_ada = true; continue; }
      // jam router dipakai sebagai awal schedule: format & zona waktunya RouterOS,
      // bukan jam server — menebak format tanggal adalah cara tercepat salah jatuh tempo
      let jam = null;
      if (interval) {
        const j = (await c.run(['/system/clock/print', '=.proplist=date,time']))[0] || {};
        if (j.date && j.time) jam = j;
      }
      // satu print untuk seluruh batch: tanpa ini 500 voucher = 500 round-trip
      const sudah = new Set((await c.run(['/ip/hotspot/user/print', '=.proplist=name']))
        .map(u => String(u.name || '').toLowerCase()));
      for (const kode of kodeList) {
        const user = bersih(kode, 63);
        if (!user) { hasil.gagal[kode] = 'kode voucher tidak valid untuk username'; continue; }
        try {
          if (sudah.has(user.toLowerCase())) {
            await c.run(['/ip/hotspot/user/set', `=numbers=${user}`,
              `=password=${user}`, `=profile=${nama}`, `=comment=${comment}`, '=disabled=no']);
          } else {
            await c.run(['/ip/hotspot/user/add', `=name=${user}`, `=password=${user}`,
              `=profile=${nama}`, '=server=all', `=comment=${comment}`]);
          }
          hasil.dibuat.push(kode);
        } catch (e) {
          hasil.gagal[kode] = String(e.message).slice(0, 250);
          continue;
        }
        if (interval && jam) await buatJadwalVoucher(c, user, interval, jam, hasil);
      }
      hasil.router = dev.nama;
      return hasil;
    } catch (e) {
      hasil.router_gagal.push(`${r.nama}: ${String(e.message).slice(0, 120)}`);
    } finally { if (c) c.close(); }
  }
  if (!hasil.router && hasil.dibuat.length === 0) {
    const pesan = hasil.profil_tidak_ada
      ? `profile '${nama}' tidak ada di router tenant`
      : `router tidak terjangkau: ${hasil.router_gagal.join(' | ') || 'tidak ada router aktif'}`;
    for (const k of kodeList) if (!hasil.gagal[k]) hasil.gagal[k] = pesan.slice(0, 250);
  }
  return hasil;
}

/**
 * Buat user hotspot untuk sekelompok baris voucher lalu catat hasil push per
 * baris. Satu-satunya tempat status push ditulis, supaya retry scheduler dan
 * tombol panel tidak punya versi kebenaran yang berbeda.
 * rows = [{ id, kode }]
 */
async function pushVoucher(idDataServer, rows, { profil, komentar, jadwal }) {
  const h = await tambahHotspotUser(rows.map(r => r.kode), { profil, komentar, idDataServer, jadwal });
  const berhasil = new Set(h.dibuat);
  for (const r of rows) {
    const ok = berhasil.has(r.kode);
    // user sudah ada tapi schedule-nya gagal: status tetap ok (pelanggan bisa
    // login), hanya pesannya mengingatkan bahwa jatuh tempo hanya dijaga cron
    const pesan = ok
      ? (h.jadwal_gagal[r.kode] ? `jadwal router gagal: ${h.jadwal_gagal[r.kode]}` : null)
      : String(h.gagal[r.kode] || 'tidak tersampaikan ke router').slice(0, 250);
    await db.run(
      `UPDATE voucher SET router_status=?, router_nama=?, router_error=?, pushed_at=NOW()
       WHERE id=?`,
      [ok ? 'ok' : 'gagal', ok ? h.router : null, pesan, r.id]);
  }
  return {
    terkirim: berhasil.size, gagal: rows.length - berhasil.size,
    jadwal_gagal: Object.keys(h.jadwal_gagal).length,
    router: h.router, profil_tidak_ada: h.profil_tidak_ada
  };
}

/**
 * Buang user hotspot (voucher kedaluwarsa / dibatalkan) plus sesi yang sedang
 * jalan — user cacat tidak memutus koneksi yang sudah naik. Schedule jatuh
 * tempo di router ikut dibuang, kalau tidak namanya akan menghalangi kode
 * voucher berikutnya yang kebetulan sama dan meninggalkan baris mati.
 */
async function hapusHotspotUser(kode, idDataServer) {
  const hasil = { router: null, ada: false, sesi_dibuang: 0, gagal: [] };
  const user = bersih(kode, 63);
  if (!user) throw new Error('Kode voucher tidak valid');
  if (!pushHotspotAktif()) { hasil.gagal.push('PUSH_HOTSPOT=0'); return hasil; }
  for (const r of await routerTenant(idDataServer)) {
    let c;
    try {
      const { dev } = await perangkatMikrotik(r.id);
      c = klien(dev);
      await sambungkan(c);
      const u = await c.run(['/ip/hotspot/user/print', '=.proplist=.id', `?name=${user}`]);
      const j = await c.run(['/system/schedule/print', '=.proplist=.id', `?name=${user}`]);
      if (!u.length || !u[0]['.id']) {
        for (const s of j) {
          if (!s['.id']) continue;
          try { await c.run(['/system/schedule/remove', `=.id=${s['.id']}`]); } catch (_) { /* sudah hilang */ }
        }
        continue;
      }
      const sesi = await c.run(['/ip/hotspot/active/print', '=.proplist=.id', `?user=${user}`]);
      for (const s of sesi) {
        if (!s['.id']) continue;
        try { await c.run(['/ip/hotspot/active/remove', `=.id=${s['.id']}`]); hasil.sesi_dibuang++; }
        catch (_) { /* sesi sudah putus sendiri */ }
      }
      await c.run(['/ip/hotspot/user/remove', `=.id=${u[0]['.id']}`]);
      for (const s of j) {
        if (!s['.id']) continue;
        try { await c.run(['/system/schedule/remove', `=.id=${s['.id']}`]); } catch (_) { /* sudah hilang */ }
      }
      hasil.ada = true;
      hasil.router = dev.nama;
      return hasil;
    } catch (e) {
      hasil.gagal.push(`${r.nama}: ${String(e.message).slice(0, 120)}`);
    } finally { if (c) c.close(); }
  }
  return hasil;
}

// ------------------------------------------- push sesi router -> aplikasi
//
// Meniru gratisinaja: tombol 'Test' pada perangkat MikroTik memasang satu
// /system script + satu /system schedule berinterval 40 detik di router, dan
// script itu mengirim daftar sesi (PPPoE + hotspot) ke endpoint publik
// /api/router/push. Manfaatnya: link API ke CCR1009 sering drop (1 dari 3
// percobaan EHOSTUNREACH), sementara daftar Unmanage dan status online tetap
// punya angka segar karena datanya datang dari router, bukan dari polling kita.

const NAMA_SCRIPT_PUSH = 'IvvibillAPI';
const NAMA_JADWAL_PUSH = 'SchIvvibill';
const INTERVAL_PUSH = '40s';
const BATAS_SESI = 2000;

/** Karakter yang bisa merusak kata argumen RouterOS / JSON di /tool fetch. */
function amanTeks(v, max) {
  return String(v == null ? '' : v).replace(/["\\\r\n]/g, '').trim().slice(0, max);
}

/** Kunci endpoint per perangkat — bukan kredensial login, hanya penanda perangkat. */
function tokenBaru() { return cryptoLib.randomBytes(20).toString('hex'); }

/**
 * Alamat yang harus DIJANGKAU ROUTER, bukan alamat browser. BASE_URL isi di .env;
 * PUSH_URL untuk kasus router tidak bisa lewat nama host utama.
 */
function urlPush() {
  const paksa = String(process.env.PUSH_URL || '').trim().replace(/\/+$/, '');
  const dasar = paksa || String(config.app.baseUrl || '').trim().replace(/\/+$/, '');
  return dasar ? `${dasar}/api/router/push` : null;
}

/** Isi /system script: kumpulkan sesi, kirim POST, jangan simpan hasilnya. */
function sandiPush(url, token) {
  const u = amanTeks(url, 300);
  const t = amanTeks(token, 64);
  const mode = /^https:/i.test(u) ? 'https' : 'http';
  return ':local ivvi ""; :local hsv ""; ' +
    ':local ut [/system resource get uptime]; :local bm [/system resource get board-name]; ' +
    ':do { :foreach i in=[/ppp active find] do={ ' +
      ':local n [/ppp active get $i name]; :local a [/ppp active get $i address]; ' +
      ':local p [/ppp active get $i uptime]; :set $ivvi ("$ivvi$n|$a|$p;"); }; } on-error={ }; ' +
    ':do { :foreach h in=[/ip hotspot active find] do={ ' +
      ':local n [/ip hotspot active get $h user]; :local a [/ip hotspot active get $h address]; ' +
      ':local p [/ip hotspot active get $h uptime]; :set $hsv ("$hsv$n|$a|$p;"); }; } on-error={ }; ' +
    `/tool fetch url="${u}?token=${t}" mode=${mode} http-method=post ` +
    'http-data="{\\"ivvi\\":\\"$ivvi\\",\\"hsa\\":\\"$hsv\\",\\"ut\\":\\"$ut\\",\\"bm\\":\\"$bm\\"}" ' +
    'keep-result=no; :delay 1s; :set $ivvi ""; :set $hsv "";';
}

/** Tulis/perbarui script + schedule. Nama lama milik aplikasi lain TIDAK disentuh. */
async function pasangScriptPush(c, url, token) {
  const sumber = sandiPush(url, token);
  const scp = await c.run(['/system/script/print', '=.proplist=.id', `?name=${NAMA_SCRIPT_PUSH}`]);
  let statusScript = 'dibuat';
  if (scp.length && scp[0]['.id']) {
    await c.run(['/system/script/set', `=.id=${scp[0]['.id']}`, `=source=${sumber}`]);
    statusScript = 'diperbarui';
  } else {
    await c.run(['/system/script/add', `=name=${NAMA_SCRIPT_PUSH}`, `=source=${sumber}`,
      '=comment=ivvibill push sesi']);
  }
  const jd = await c.run(['/system/scheduler/print', '=.proplist=.id', `?name=${NAMA_JADWAL_PUSH}`]);
  let statusJadwal = 'dibuat';
  if (jd.length && jd[0]['.id']) {
    await c.run(['/system/scheduler/set', `=.id=${jd[0]['.id']}`, `=interval=${INTERVAL_PUSH}`,
      `=on-event=/system script run ${NAMA_SCRIPT_PUSH}`, '=disabled=no']);
    statusJadwal = 'diperbarui';
  } else {
    await c.run(['/system/scheduler/add', `=name=${NAMA_JADWAL_PUSH}`, `=interval=${INTERVAL_PUSH}`,
      `=on-event=/system script run ${NAMA_SCRIPT_PUSH}`, '=disabled=no']);
  }
  return { script: NAMA_SCRIPT_PUSH, jadwal: NAMA_JADWAL_PUSH, interval: INTERVAL_PUSH,
    status_script: statusScript, status_jadwal: statusJadwal };
}

/**
 * Dipanggil rute Test perangkat. Token dibuat sekali lalu dipertahankan, supaya
 * menekan Test tidak mengganti-ganti kunci yang sudah terlanjur ada di router.
 */
async function pasangPush(idPerangkat) {
  const dev = await db.one('SELECT * FROM master_perangkat WHERE id = ?', [Number(idPerangkat)]);
  if (!dev) throw new Error('Perangkat tidak ada');
  if (dev.brand !== 'mikrotik') return { dilewati: 'selain MikroTik tidak ada schedule yang dipasang' };
  // Penjaga yang sama seperti push voucher: staging memakai kredensial router
  // produksi, dan tanpa ini menekan tombol Test di staging akan memasang schedule
  // yang menembak 127.0.0.1:3011 milik staging.
  if (String(process.env.PUSH_HOTSPOT || '') === '0') {
    return { gagal: 'push router dimatikan (PUSH_HOTSPOT=0)' };
  }
  const url = urlPush();
  if (!url) {
    return { gagal: 'BASE_URL/PUSH_URL belum diisi — router tidak tahu harus mengirim ke mana' };
  }
  const token = dev.token_push || tokenBaru();
  if (!dev.token_push) {
    await db.run('UPDATE master_perangkat SET token_push = ? WHERE id = ?', [token, dev.id]);
  }
  const c = klien(dev);
  try {
    await sambungkan(c);
    const hasil = await pasangScriptPush(c, url, token);
    await db.run('UPDATE master_perangkat SET last_msg = ? WHERE id = ?',
      [`push ${hasil.interval}: ${hasil.jadwal} ${hasil.status_jadwal}`, dev.id]);
    return { ...hasil, url };
  } finally { c.close(); }
}

/** 'user|10.0.0.5|3h12m;' -> [{akun, ip, uptime}] */
function uraiSesi(s) {
  const out = [];
  for (const rek of String(s || '').split(';')) {
    const bagian = rek.split('|');
    const akun = String(bagian[0] || '').trim();
    if (!akun) continue;
    out.push({
      akun: akun.slice(0, 120),
      ip: String(bagian[1] || '').trim().slice(0, 45),
      uptime: String(bagian[2] || '').trim().slice(0, 60)
    });
    if (out.length >= BATAS_SESI) break;
  }
  return out;
}

/**
 * Terima laporan router: simpan snapshot sesi, buang sesi yang tidak dilaporkan
 * lagi, segarkan status pelanggan yang dikenali. TIDAK menandai offline — satu
 * router hanya tahu sesinya sendiri, sementara pelanggan bisa nempel di router lain.
 */
async function simpanPush(perangkat, body) {
  const idp = Number(perangkat.id);
  const pppoe = uraiSesi(body && body.ivvi);
  const hotspot = uraiSesi(body && body.hsa);
  // Penanda per laporan, bukan per detik: DATETIME hanya berpresisi 1 detik, jadi
  // "seen_at < NOW()" kehilangan baris yang ditulis push sebelumnya pada detik yang
  // sama, dan sesi yang sudah putus tertinggal di daftar selamanya.
  const tanda = cryptoLib.randomBytes(8).toString('hex');

  for (const [tipe, daftar] of [['pppoe', pppoe], ['hotspot', hotspot]]) {
    for (const s of daftar) {
      await db.insert(
        `INSERT INTO sesi_router (id_perangkat, tipe, akun, ip, uptime, seen_at, tanda_push)
         VALUES (?,?,?,?,?,NOW(),?)
         ON DUPLICATE KEY UPDATE ip = VALUES(ip), uptime = VALUES(uptime),
           seen_at = NOW(), tanda_push = VALUES(tanda_push)`,
        [idp, tipe, s.akun, s.ip || null, s.uptime || null, tanda]);
    }
    await db.run('DELETE FROM sesi_router WHERE id_perangkat = ? AND tipe = ? AND tanda_push <> ?',
      [idp, tipe, tanda]);
  }

  const warga = await db.q(
    `SELECT id, LOWER(username_pppoe) AS u FROM pelanggan
     WHERE id_data_server = ? AND username_pppoe IS NOT NULL AND username_pppoe <> ''`,
    [Number(perangkat.id_data_server)]);
  const peta = new Map(warga.map(r => [String(r.u), Number(r.id)]));
  const kena = [];
  for (const s of pppoe) {
    const id = peta.get(s.akun.toLowerCase());
    if (id) kena.push([id, 1, s.ip || null, s.uptime || null]);
  }
  if (kena.length) {
    const nilai = kena.map(() => '(?,?,?,?,NOW())').join(',');
    const arg = kena.reduce((a, r) => a.concat(r), []);
    await db.run(
      `INSERT INTO pppoe_status (id_pelanggan, online, ip_address, uptime, last_seen) VALUES ${nilai}
       ON DUPLICATE KEY UPDATE online = 1, ip_address = VALUES(ip_address),
         uptime = VALUES(uptime), last_seen = NOW(), since_off = NULL`, arg);
    await db.run(
      `UPDATE issue_pelanggan i JOIN pppoe_status ps ON ps.id_pelanggan = i.id_pelanggan
       SET i.status = 'resolved', i.resolved_at = NOW()
       WHERE i.tipe = 'offline' AND i.status = 'open' AND ps.online = 1
         AND i.id_pelanggan IN (${kena.map(() => '?').join(',')})`,
      kena.map(r => r[0]));
  }

  await db.run(
    'UPDATE setting_mikrotik SET last_check = NOW(), status = ?, uptime = ?, board_name = ? WHERE id_perangkat = ?',
    ['active', amanTeks(body && body.ut, 60) || null, amanTeks(body && body.bm, 100) || null, idp]);
  await db.run('UPDATE master_perangkat SET last_check = NOW(), last_msg = ? WHERE id = ?',
    [`push ${pppoe.length} pppoe / ${hotspot.length} hotspot`, idp]);
  return { pppoe: pppoe.length, hotspot: hotspot.length, pelanggan: kena.length };
}

/** Snapshot terakhir per perangkat — dipakai daftar Unmanage saat API router drop. */
async function sesiSnapshot(idPerangkat, menit = 5) {
  return db.q(
    `SELECT akun, ip, uptime, seen_at FROM sesi_router
     WHERE id_perangkat = ? AND tipe = 'pppoe' AND seen_at >= DATE_SUB(NOW(), INTERVAL ? MINUTE)
     ORDER BY akun`, [Number(idPerangkat), Number(menit)]);
}

module.exports = {
  pollRouter, cekPppoePelanggan, pollSemuaRouter, klien, perangkatMikrotik, sambungkan,
  setSecret, sesiTakTerkenal, routerTenant,
  pushHotspotAktif, profilHotspot, profilRouter, tambahHotspotUser, hapusHotspotUser, pushVoucher,
  intervalVoucher,
  urlPush, sandiPush, pasangPush, simpanPush, sesiSnapshot, tokenBaru,
  NAMA_SCRIPT_PUSH, NAMA_JADWAL_PUSH, INTERVAL_PUSH
};
