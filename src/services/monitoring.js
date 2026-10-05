'use strict';
// ============================================================
// Monitoring — interface router (KECUALI pppoe), resource,
// dan deteksi issue pelanggan PPPoE (offline > batas).
// ============================================================
const db = require('../db');
const { RouterOS } = require('./routeros');
const crypto = require('../util/crypto');
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
async function pollSemuaRouter() {
  const rows = await db.q(
    `SELECT s.id FROM setting_mikrotik s
     JOIN master_perangkat d ON d.id = s.id_perangkat
     WHERE d.status = 'aktif'`
  );
  const hasil = [];
  for (const r of rows) {
    try { hasil.push({ id: r.id, ...(await pollRouter(r.id)) }); }
    catch (e) { hasil.push({ id: r.id, ok: false, error: e.message }); }
  }
  return hasil;
}

module.exports = { pollRouter, cekPppoePelanggan, pollSemuaRouter, klien, perangkatMikrotik, sambungkan };
