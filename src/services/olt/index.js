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
// Normalisasi respons WebFig — nama kolom berbeda antar firmware
// -----------------------------------------------------------
// Driver produksi (GratisinAja config/hsgq_olt.class.php) menghadapi firmware
// yang mengirim kunci berbeda, baris sebagai string berpisah koma, dan nilai
// dBm berpemisah koma. Aturan yang sama dipakai di sini supaya satu driver tidak
// lagi mengasumsikan satu bentuk respons.
const KEYS = {
  pon: ['port_id', 'pon', 'ponid', 'pon_id', 'port', 'portid', 'interface', 'name_pon'],
  onu: ['onu_id', 'onu', 'onuid', 'index', 'llid'],
  sn: ['sn', 'onu_sn', 'serial', 'serialnumber', 'sn_number', 'vendor_sn', 'onu_sn_full'],
  mac: ['macaddr', 'mac', 'mac_address', 'onu_mac', 'pon_mac'],
  loid: ['loid', 'loid_name', 'onu_loid', 'auth_string'],
  nama: ['onu_name', 'name', 'alias', 'desp', 'description'],
  status: ['status', 'state', 'onu_status', 'run_state', 'operstate'],
  tx: ['transmit_power', 'tx_power', 'txpower', 'tx', 'optical_tx'],
  rx: ['receive_power', 'rx_power', 'rxpower', 'rx', 'optical_rx']
};

/** Nilai pertama dari beberapa kemungkinan nama kunci (case-insensitive). */
function pick(row, keys) {
  // "RX Power", "rx_power" dan "rxPower" adalah kolom yang sama di firmware
  // berbeda, jadi nama kunci disamakan bentuknya lebih dulu.
  const low = {};
  for (const k of Object.keys(row || {})) low[String(k).toLowerCase().replace(/[^a-z0-9]/g, '')] = row[k];
  for (const key of keys) {
    const v = low[key.toLowerCase().replace(/[^a-z0-9]/g, '')];
    if (v !== null && v !== undefined && v !== '') return v;
  }
  return null;
}

/**
 * Baris respons bisa berupa array of object, object ber-key nomor ("0","1",...),
 * atau tabel teks: baris pertama berisi nama kolom dan baris berikutnya string
 * berpisah koma (firmware lama). Normalisasikan ke array of object.
 *
 * Baris posisional TANPA baris judul sengaja tidak dipakai: menebak letak kolom
 * akan menaruh MAC di kolom SN, dan master_onu.sn itulah yang dipakai mencocokkan
 * ONU dengan pelanggan.
 */
const normalNama = s => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');
const NAMA_KOLOM = new Set([].concat(...Object.values(KEYS)).map(normalNama));

function rowsOf(data) {
  let d = data;
  if (d && typeof d === 'object' && !Array.isArray(d)) {
    if (Array.isArray(d.data)) d = d.data;
    else if (Array.isArray(d.list)) d = d.list;
    else if (d.data && typeof d.data === 'object') d = d.data;
    else return [];
  }
  if (d && typeof d === 'object' && !Array.isArray(d)) d = Object.values(d);
  if (!Array.isArray(d)) return [];

  const mentah = d.map(v => {
    if (v && typeof v === 'object' && !Array.isArray(v)) return v;
    if (Array.isArray(v)) return v.map(String);
    if (typeof v === 'string') return v.split(',').map(s => s.trim());
    return null;
  }).filter(Boolean);

  const judul = mentah.find(r => Array.isArray(r) && r.some(c => NAMA_KOLOM.has(normalNama(c))));
  const out = [];
  for (const r of mentah) {
    if (!Array.isArray(r)) { out.push(r); continue; }
    if (!judul || r === judul) continue;
    const o = {};
    judul.forEach((k, i) => { if (k && r[i] !== undefined) o[String(k).trim()] = r[i]; });
    out.push(o);
  }
  return out;
}

/** "-23,5 dBm" / "&nbsp;4" / "-inf dBm" -> float | null */
function parseDbm(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  let s = String(v).toLowerCase()
    .replace(/&nbsp;/g, '').replace(/\u00a0/g, '')
    .replace(/dbm/g, '').replace(/[\s]/g, '');
  if (s === '' || s.includes('inf') || s.includes('nan')) return null;
  if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.');
  s = s.replace(/[^0-9.+-]/g, '');
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/** Status ONU dalam bentuk apa pun -> 1 online, 0 bukan online, 0 tidak dikenal. */
function onlineOf(v) {
  const s = String(v === null || v === undefined ? '' : v).trim().toLowerCase();
  if (s === '') return 0;
  if (/^(1|true|on|online|active|up)/.test(s)) return 1;
  if (/on$|online|active|up/.test(s) && !/off/.test(s)) return 1;
  return 0;
}

/**
 * Firmware WebFig menandai keberhasilan dengan {code:1}. Tanpa pemeriksaan ini,
 * respons "tidak login" / "port tidak ada" terlihat seperti data kosong, sehingga
 * panel menampilkan daftar ONU kosong tanpa satu pun petunjuk.
 */
function cekKode(res, whence) {
  const b = res.body;
  if (b === null || b === undefined || typeof b !== 'object') {
    throw new Error(`${whence}: respons bukan JSON (HTTP ${res.status}) — periksa alamat/port/HTTPS perangkat`);
  }
  const c = b.code;
  if (c !== undefined && c !== null && String(c) !== '1') {
    const msg = String(b.message || b.msg || b.error || '').trim();
    throw new Error(`${whence}: kode ${c}${msg ? ` — ${msg.slice(0, 140)}` : ''}`);
  }
}

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
      const rows = rowsOf(r.body);
      const out = [];
      for (const row of rows) {
        const p = pick(row, KEYS.pon);
        if (p === null) continue;
        out.push({
          pon: p,
          online: Number(pick(row, ['online_num', 'online', 'onu_online', 'count']) || 0),
          // daya TX modul SFP = acuan redaman yang sebenarnya; kalau firmware
          // tidak mengirimnya di halaman ini, pollOlt memakai ambang tenant.
          tx: parseDbm(pick(row, KEYS.tx))
        });
      }
      if (!out.length) {
        // Firmware lama tidak menjawab /board?info=pon. Sama seperti driver
        // produksi: pakai port 1..4, port yang tidak ada hanya menghasilkan kosong.
        out.push(...[1, 2, 3, 4].map(p => ({ pon: p, online: 0, tx: null })));
      }
      // Daya TX modul SFP per port = acuan redaman yang sebenarnya. Halaman
      // optical_poninfo mengirimnya untuk semua port dalam satu permintaan.
      // Penting: di HSGQ PASNET TX modul 7,5 dBm sedangkan ambang tenant 4 dBm —
      // tanpa angka ini redaman semua ONU salah hitung sekitar 3,5 dB.
      try {
        const o = await http.getJson(`${cfg.base}/ponmgmt?form=optical_poninfo`, { token, timeout: cfg.timeout });
        for (const row of rowsOf(o.body)) {
          const p = pick(row, KEYS.pon);
          const tx = parseDbm(pick(row, KEYS.tx));
          if (p === null || tx === null) continue;
          const target = out.find(x => String(x.pon) === String(p));
          if (target && (target.tx === null || target.tx === undefined)) target.tx = tx;
        }
      } catch (_) { /* acuan tetap memakai ambang tenant */ }
      return out;
    },
    async onus(cfg, token, pon) {
      const r = await http.getJson(
        `${cfg.base}/onu_allow_list?form=onucfg&port_id=${encodeURIComponent(pon)}`,
        { token, timeout: cfg.timeout }
      );
      cekKode(r, 'daftar ONU');
      const list = rowsOf(r.body).map(row => {
        const idOnu = pick(row, KEYS.onu);
        const asli = String(pick(row, KEYS.sn) || '').trim().toUpperCase();
        return {
          // Firmware ini tidak mengirim serial number di halaman onucfg, dan
          // onu.simpan membuang baris tanpa sn — itulah sebabnya daftar ONU
          // tetap kosong walau login sudah berhasil. Identitas cadangan mengikuti
          // driver produksi: "P<port>O<onu_id>", stabil selama ONU tidak dipindah.
          sn: asli || `P${pon}O${idOnu === null ? 'x' : idOnu}`,
          sn_asli: asli || null,
          mac: String(pick(row, KEYS.mac) || '').toLowerCase(),
          nama: String(pick(row, KEYS.nama) || pick(row, KEYS.loid) || '').trim(),
          pon: pick(row, KEYS.pon) ?? pon,
          onu: idOnu,
          rx: parseDbm(pick(row, KEYS.rx)),
          tx: parseDbm(pick(row, KEYS.tx)),
          online: onlineOf(pick(row, KEYS.status))
        };
      });
      // Sebagian firmware memisahkan daftar (identitas) dari optik (daya).
      // Kalau tidak ada satu pun RX di halaman onucfg, ambil dari optical_onu —
      // halaman ini lambat (OLT mengukur ONU satu per satu), jadi hanya dipakai
      // bila memang perlu.
      if (list.length && list.every(o => o.rx === null)) {
        try {
          const o = await http.getJson(
            `${cfg.base}/ponmgmt?form=optical_onu&port_id=${encodeURIComponent(pon)}`,
            { token, timeout: Math.max(cfg.timeout, 30000) }
          );
          for (const row of rowsOf(o.body)) {
            const idOnu = pick(row, KEYS.onu);
            const snRow = String(pick(row, KEYS.sn) || '').trim().toUpperCase();
            const target = list.find(x => String(x.onu) === String(idOnu)) ||
              list.find(x => x.sn_asli && x.sn_asli === snRow);
            if (!target) continue;
            const rx = parseDbm(pick(row, KEYS.rx));
            const tx = parseDbm(pick(row, KEYS.tx));
            if (target.rx === null && rx !== null) target.rx = rx;
            if (target.tx === null && tx !== null) target.tx = tx;
            if (!target.sn_asli && snRow) { target.sn_asli = snRow; target.sn = snRow; }
          }
        } catch (_) { /* optik tambahan, bukan syarat keberhasilan poll */ }
      }
      return list;
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
/** Redaman = tx OLT acuan − rx ONU. */
function hitungRedaman(rx, oltTx) {
  if (rx === null || oltTx === null || oltTx === undefined) return null;
  return Number((Number(oltTx) - Number(rx)).toFixed(2));
}

// Ambang disimpan di setting_olt dengan nama kolom rx_min_dbm / att_max_db;
// destructuring dulu memakai nama pendek (rx_min/att_max) sehingga keduanya
// selalu undefined, semua perbandingan jadi NaN, dan setiap ONU terlacak
// berstatus 'ok' — termasuk yang redamannya jebol.
function classify(rx, { rx_min_dbm, att_max_db }, oltTx) {
  if (rx === null) return 'warning';
  const att = hitungRedaman(rx, oltTx);
  if (rx < Number(rx_min_dbm) || (att !== null && att > Number(att_max_db))) return 'kritis';
  if (rx < Number(rx_min_dbm) + 3 || (att !== null && att > Number(att_max_db) - 3)) return 'warning';
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
  // Kolom alamat sering terisi "103.242.105.199:2423" sementara field port juga
  // terisi; gabung keduanya menghasilkan URL cacat (Failed to parse URL). Pisahkan
  // host dan port, dan pakai port bawaan alamat hanya bila field port kosong.
  let host = String(dev.alamat || '').trim().replace(/^https?:\/\//, '');
  let port = dev.port ? Number(dev.port) : null;
  if (host.includes(':')) {
    const [h, p] = host.split(':');
    host = h;
    if (!port && /^\d+$/.test(String(p))) port = Number(p);
  }
  const base = `${dev.use_https ? 'https' : 'http'}://${host}${port ? ':' + port : ''}`;
  const cfg = { base, username: dev.username, password: dev.password, timeout: 12000 };

  const token = await driver.login(cfg);
  const pons = await driver.pons(cfg, token);
  if (!pons.length) throw new Error('Port PON tidak terbaca dari perangkat');
  const semua = [];
  const gagal = [];
  for (const p of pons) {
    try {
      const list = await driver.onus(cfg, token, p.pon);
      // Redaman dihitung dari daya TX modul port itu bila perangkat mengirimnya;
      // ambang tenant (olt_tx_dbm) hanya cadangan.
      const txAcuan = p.tx !== null && p.tx !== undefined ? p.tx : amb.olt_tx_dbm;
      for (const o of list) {
        const st = classify(o.rx, amb, txAcuan);
        semua.push({
          ...o,
          pon: String(o.pon ?? p.pon),
          redaman: hitungRedaman(o.rx, txAcuan),
          status_redaman: st
        });
      }
    } catch (e) {
      semua.push({ pon: String(p.pon), error: e.message });
      // Tanpa ini, seluruh port gagal = polling "sukses" dengan nol ONU dan
      // panel hanya menampilkan daftar kosong.
      if (gagal.length < 3) gagal.push(`port ${p.pon}: ${e.message}`);
    }
  }
  if (!semua.some(o => o.sn) && gagal.length) {
    throw new Error(gagal.join(' | ').slice(0, 240));
  }
  return { pons, onus: semua, gagal };
}

function brands() {
  return Object.keys(BRANDS);
}

module.exports = { pollOlt, hitungRedaman, classify, brands };
