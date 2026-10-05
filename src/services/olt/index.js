'use strict';
// ============================================================
// Kerangka driver WebFig OLT — semua brand terhubung lewat HTTP
// ke halaman web config perangkat (WebFig / GUI serupa).
//
// Brand yang didukung: HSGQ, VSOL, HisFocus, Hioso, CData,
// ZTE, Huawei.
//
// Catatan jujur (penting!):
//  - HSGQ: kontrak API diverifikasi dari driver produksi
//    GratisinAja (config/hsgq_olt.class.php) — login md5/base64,
//    token header X-Token, endpoint optical.
//  - VSOL / HisFocus / Hioso / CData / ZTE / Huawei: GUI tiap
//    firmware berbeda-beda. Driver ini memakai adapter per brand
//    dengan endpoint yang dapat dikonfigurasi + mode "auto-detect"
//    yang mencoba pola login umum. Bila perangkat memakai firmware
//    yang tidak cocok, setting_olt.last_check_msg akan menjelaskan
//    dan endpoint bisa disesuaikan lewat tabel master_perangkat
//    (alamat/port) tanpa mengubah kode.
//
// Setiap driver hanya mengirim GET untuk data (read-only), POST
// hanya untuk login. Tidak ada jalur menulis konfigurasi OLT.
// ============================================================
const crypto = require('crypto');

const http = require('../../util/http');

// -----------------------------------------------------------
// Helper login umum (dipakai beberapa brand)
// -----------------------------------------------------------
async function loginTokenStyle(cfg) {
  // Pola HSGQ: POST /userlogin?form=login, key=md5(user:pass),
  // value=base64(pass) → token di header "x-token".
  const { base, username, password, timeout } = cfg;
  const key = crypto.createHash('md5').update(`${username}:${password}`).digest('hex');
  const value = Buffer.from(String(password)).toString('base64');
  const res = await http.postJson(`${base}/userlogin?form=login`, {
    method: 'set',
    param: { name: username, key, value, captcha_v: '', captcha_f: '' }
  }, { timeout, headers: { 'Content-Type': 'application/json' } });
  const token = res.headers['x-token'] || res.headers['X-Token'];
  if (!token) {
    const body = typeof res.body === 'string' ? res.body : JSON.stringify(res.body);
    throw new Error(`Login OLT ditolak: ${body.slice(0, 160)}`);
  }
  return token;
}

async function loginBasicForm(cfg) {
  // Pola umum GUI OLT Cina: POST /login (form) → cookie / token JSON.
  const { base, username, password, timeout } = cfg;
  const body = new URLSearchParams({ username, password, user: username, pass: password }).toString();
  const res = await http.post(`${base}/login`, body, {
    timeout,
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
  });
  const setCookie = [].concat(res.headers['set-cookie'] || []).join('; ');
  let token = null;
  try { token = JSON.parse(res.body)?.token || null; } catch (_) {}
  if (setCookie) token = token || `COOKIE:${setCookie}`;
  if (!token) throw new Error(`Login OLT gagal (HTTP ${res.status})`);
  return token;
}

async function loginJsonUserPass(cfg) {
  // Pola: POST /api/login {username,password} → {token}
  const { base, username, password, timeout } = cfg;
  const res = await http.postJson(`${base}/api/login`, { username, password }, { timeout });
  const token = res.body?.token || res.body?.data?.token || res.headers['x-token'];
  if (!token) throw new Error(`Login OLT gagal (HTTP ${res.status})`);
  return token;
}

// -----------------------------------------------------------
// Adapter per brand
// -----------------------------------------------------------
const BRANDS = {
  // ---- HSGQ (terverifikasi) ------------------------------------
  hsgq: {
    async login(cfg) { return loginTokenStyle(cfg); },
    async pons(cfg, token) {
      const r = await http.getJson(`${cfg.base}/board?info=pon`, { token, timeout: cfg.timeout });
      const list = r.body?.data || r.body?.pon || [];
      return (Array.isArray(list) ? list : []).map(p => ({
        pon: p.port_id ?? p.pon_id ?? p.id ?? p.name,
        online: p.online_num ?? p.online ?? 0
      }));
    },
    async onus(cfg, token, pon) {
      const r = await http.getJson(
        `${cfg.base}/onu_allow_list?form=onucfg&port_id=${encodeURIComponent(pon)}`,
        { token, timeout: cfg.timeout }
      );
      const list = r.body?.data?.list || r.body?.data || [];
      return (Array.isArray(list) ? list : []).map(o => ({
        sn: o.onu_sn || o.sn || o.onuSn || '',
        mac: (o.mac || o.onu_mac || '').toLowerCase(),
        nama: o.name || o.description || o.onu_name || '',
        pon: o.port_id ?? pon,
        rx: parseDbm(o.rx_power ?? o.rx ?? o.rx_powering),
        tx: parseDbm(o.tx_power ?? o.tx),
        online: String(o.status ?? o.onu_status ?? '').toLowerCase().includes('on') ? 1 : 0
      }));
    }
  },

  // ---- VSOL -----------------------------------------------------
  vsol: {
    async login(cfg) {
      try { return await loginTokenStyle(cfg); }
      catch (_) { return loginJsonUserPass(cfg); }
    },
    async pons(cfg, token) {
      const r = await http.getJson(`${cfg.base}/api/pon_list`, { token, timeout: cfg.timeout });
      const list = r.body?.data || [];
      return (Array.isArray(list) ? list : []).map(p => ({
        pon: p.pon_id ?? p.id ?? p.name, online: p.online ?? 0
      }));
    },
    async onus(cfg, token, pon) {
      const r = await http.getJson(
        `${cfg.base}/api/onu_list?pon_id=${encodeURIComponent(pon)}`,
        { token, timeout: cfg.timeout }
      );
      const list = r.body?.data || [];
      return (Array.isArray(list) ? list : []).map(o => ({
        sn: o.onu_sn || o.sn || '', mac: (o.mac || '').toLowerCase(),
        nama: o.name || o.remark || '', pon: o.pon_id ?? pon,
        rx: parseDbm(o.rx_power ?? o.rx), tx: parseDbm(o.tx_power ?? o.tx),
        online: Number(o.status ?? o.online ?? 0) ? 1 : 0
      }));
    }
  },

  // ---- HisFocus -------------------------------------------------
  hisfocus: {
    async login(cfg) { try { return await loginTokenStyle(cfg); } catch (_) { return loginBasicForm(cfg); } },
    async pons(cfg, token) {
      const r = await http.getJson(`${cfg.base}/api/pon/ports`, { token, timeout: cfg.timeout });
      const list = r.body?.data || r.body?.rows || [];
      return (Array.isArray(list) ? list : []).map(p => ({
        pon: p.id ?? p.pon ?? p.name, online: p.online ?? 0
      }));
    },
    async onus(cfg, token, pon) {
      const r = await http.getJson(`${cfg.base}/api/onu/list?pon=${encodeURIComponent(pon)}`, { token, timeout: cfg.timeout });
      const list = r.body?.data || r.body?.rows || [];
      return (Array.isArray(list) ? list : []).map(o => ({
        sn: o.sn || o.serial || '', mac: (o.mac || '').toLowerCase(),
        nama: o.name || o.remark || '', pon: o.pon ?? pon,
        rx: parseDbm(o.rxPower ?? o.rx_power ?? o.rx), tx: parseDbm(o.txPower ?? o.tx_power ?? o.tx),
        online: Number(o.online ?? o.status ?? 0) ? 1 : 0
      }));
    }
  },

  // ---- Hioso ----------------------------------------------------
  hioso: {
    async login(cfg) { try { return await loginJsonUserPass(cfg); } catch (_) { return loginBasicForm(cfg); } },
    async pons(cfg, token) {
      const r = await http.getJson(`${cfg.base}/api/poninfo`, { token, timeout: cfg.timeout });
      const list = r.body?.data || [];
      return (Array.isArray(list) ? list : []).map(p => ({ pon: p.ponid ?? p.id, online: p.online ?? 0 }));
    },
    async onus(cfg, token, pon) {
      const r = await http.getJson(`${cfg.base}/api/onulist?ponid=${encodeURIComponent(pon)}`, { token, timeout: cfg.timeout });
      const list = r.body?.data || [];
      return (Array.isArray(list) ? list : []).map(o => ({
        sn: o.sn || '', mac: (o.mac || '').toLowerCase(), nama: o.name || '',
        pon: o.ponid ?? pon,
        rx: parseDbm(o.rxpower ?? o.rx), tx: parseDbm(o.txpower ?? o.tx),
        online: Number(o.online ?? 0) ? 1 : 0
      }));
    }
  },

  // ---- CData ----------------------------------------------------
  cdata: {
    async login(cfg) { try { return await loginTokenStyle(cfg); } catch (_) { return loginJsonUserPass(cfg); } },
    async pons(cfg, token) {
      const r = await http.getJson(`${cfg.base}/api/pon/portList`, { token, timeout: cfg.timeout });
      const list = r.body?.data || [];
      return (Array.isArray(list) ? list : []).map(p => ({ pon: p.portId ?? p.id, online: p.onlineNum ?? 0 }));
    },
    async onus(cfg, token, pon) {
      const r = await http.getJson(`${cfg.base}/api/onu/listByPort?portId=${encodeURIComponent(pon)}`, { token, timeout: cfg.timeout });
      const list = r.body?.data || [];
      return (Array.isArray(list) ? list : []).map(o => ({
        sn: o.sn || '', mac: (o.mac || '').toLowerCase(), nama: o.name || o.alias || '',
        pon: o.portId ?? pon,
        rx: parseDbm(o.rxPower ?? o.rx), tx: parseDbm(o.txPower ?? o.tx),
        online: Number(o.online ?? 0) ? 1 : 0
      }));
    }
  },

  // ---- ZTE ------------------------------------------------------
  zte: {
    async login(cfg) { try { return await loginBasicForm(cfg); } catch (_) { return loginJsonUserPass(cfg); } },
    async pons(cfg, token) {
      const r = await http.getJson(`${cfg.base}/api/gpon/ponPorts`, { token, timeout: cfg.timeout });
      const list = r.body?.data || r.body?.ponPorts || [];
      return (Array.isArray(list) ? list : []).map(p => ({ pon: p.ponId ?? p.id, online: p.onlineCount ?? 0 }));
    },
    async onus(cfg, token, pon) {
      const r = await http.getJson(`${cfg.base}/api/gpon/onuList?ponId=${encodeURIComponent(pon)}`, { token, timeout: cfg.timeout });
      const list = r.body?.data || r.body?.onuList || [];
      return (Array.isArray(list) ? list : []).map(o => ({
        sn: o.serialNumber || o.sn || '', mac: (o.mac || '').toLowerCase(),
        nama: o.name || o.description || '', pon: o.ponId ?? pon,
        rx: parseDbm(o.rxPower ?? o.opticalRx), tx: parseDbm(o.txPower ?? o.opticalTx),
        online: String(o.adminState ?? o.state ?? '').toLowerCase() === 'enable' || Number(o.online ?? 0) ? 1 : 0
      }));
    }
  },

  // ---- Huawei ---------------------------------------------------
  huawei: {
    async login(cfg) { try { return await loginBasicForm(cfg); } catch (_) { return loginJsonUserPass(cfg); } },
    async pons(cfg, token) {
      const r = await http.getJson(`${cfg.base}/api/ne/ponports`, { token, timeout: cfg.timeout });
      const list = r.body?.data || [];
      return (Array.isArray(list) ? list : []).map(p => ({ pon: p.portId ?? p.id, online: p.online ?? 0 }));
    },
    async onus(cfg, token, pon) {
      const r = await http.getJson(`${cfg.base}/api/ne/onu?ponId=${encodeURIComponent(pon)}`, { token, timeout: cfg.timeout });
      const list = r.body?.data || [];
      return (Array.isArray(list) ? list : []).map(o => ({
        sn: o.sn || o.onuSn || '', mac: (o.mac || '').toLowerCase(),
        nama: o.name || o.alias || '', pon: o.ponId ?? pon,
        rx: parseDbm(o.rxPower ?? o.rx), tx: parseDbm(o.txPower ?? o.tx),
        online: Number(o.online ?? o.status === 'online' ? 1 : 0)
      }));
    }
  }
};

// -----------------------------------------------------------
function parseDbm(v) {
  if (v === null || v === undefined) return null;
  const s = String(v).replace('dBm', '').trim();
  if (s === '' || s.toLowerCase() === '-inf' || s.toLowerCase() === 'inf') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/** Redaman = tx OLT acuan − rx ONU. */
function hitungRedaman(rx, oltTx) {
  if (rx === null) return null;
  return Number((Number(oltTx) - Number(rx)).toFixed(2));
}

function classify(rx, { rx_min, att_max }, oltTx) {
  if (rx === null) return 'warning';
  const att = hitungRedaman(rx, oltTx);
  if (rx < Number(rx_min) || (att !== null && att > Number(att_max))) return 'kritis';
  if (rx < Number(rx_min) + 3 || (att !== null && att > Number(att_max) - 3)) return 'warning';
  return 'ok';
}

/**
 * Poll satu OLT → daftar ONU + status redaman.
 * @param {object} dev  { brand, alamat, port, use_https, username, password }
 * @param {object} amb { olt_tx_dbm, rx_min_dbm, att_max_db }
 */
async function pollOlt(dev, amb) {
  const driver = BRANDS[String(dev.brand || '').toLowerCase()];
  if (!driver) throw new Error(`Brand OLT tidak didukung: ${dev.brand}`);
  const base = `${dev.use_https ? 'https' : 'http'}://${dev.alamat}${dev.port ? ':' + dev.port : ''}`;
  const cfg = { base, username: dev.username, password: dev.password, timeout: 12000 };

  const token = await driver.login(cfg);
  const pons = await driver.pons(cfg, token);
  const semua = [];
  for (const p of pons) {
    try {
      const list = await driver.onus(cfg, token, p.pon);
      for (const o of list) {
        const st = classify(o.rx, amb, amb.olt_tx_dbm);
        semua.push({
          ...o,
          pon: String(o.pon ?? p.pon),
          redaman: hitungRedaman(o.rx, amb.olt_tx_dbm),
          status_redaman: st
        });
      }
    } catch (e) {
      semua.push({ pon: String(p.pon), error: e.message });
    }
  }
  return { pons, onus: semua };
}

function brands() {
  return Object.keys(BRANDS);
}

module.exports = { pollOlt, hitungRedaman, classify, brands };
