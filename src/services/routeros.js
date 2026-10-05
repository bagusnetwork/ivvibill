'use strict';
// ============================================================
// Klien RouterOS API (protocol bawaan MikroTik, port 8728/TCP).
// Implementasi sendiri — tanpa dependensi native.
// Dipakai untuk monitoring interface (KECUALI pppoe), resource,
// dan status koneksi PPPoE pelanggan.
//
// Catatan format: RouterOS mengirim atribut sebagai SATU kata
// "=kunci=nilai" (contoh "=name=ether1"), bukan dua kata terpisah.
// ============================================================
const net = require('net');
const crypto = require('crypto');

// Sampel counter kumulatif terakhir per (host:port, interface) untuk
// menghitung bits/detik dari selisih rx-byte/tx-byte.
const sampelSebelum = new Map();

class RouterOS {
  constructor({ host, port = 8728, user, password, timeout = 8000 }) {
    this.host = host;
    this.port = Number(port);
    this.user = user;
    this.password = password;
    this.timeout = Number(timeout);
    this.sock = null;
    this.buf = Buffer.alloc(0);
  }

  // --- encoding kata RouterOS: [len][byte4...][len][byte...] ... 0 ---
  static _encWord(word) {
    const b = Buffer.from(String(word), 'utf8');
    const l = b.length;
    let len;
    if (l < 0x80) len = Buffer.from([l]);
    else if (l < 0x4000) len = Buffer.from([0x80 | (l >> 8), l & 0xff]);
    else if (l < 0x200000) len = Buffer.from([0xc0 | (l >> 16), (l >> 8) & 0xff, l & 0xff]);
    else if (l < 0x10000000) len = Buffer.from([0xe0 | (l >> 24), (l >> 16) & 0xff, (l >> 8) & 0xff, l & 0xff]);
    else throw new Error('Kata terlalu panjang');
    return Buffer.concat([len, b]);
  }

  static _readLen(buf, i) {
    const b0 = buf[i];
    if (b0 < 0x80) return [b0, 1];
    if ((b0 & 0xc0) === 0x80) return [((b0 & 0x3f) << 8) | buf[i + 1], 2];
    if ((b0 & 0xe0) === 0xc0) return [((b0 & 0x1f) << 16) | (buf[i + 1] << 8) | buf[i + 2], 3];
    if ((b0 & 0xf0) === 0xe0) return [((b0 & 0x0f) << 24) | (buf[i + 1] << 16) | (buf[i + 2] << 8) | buf[i + 3], 4];
    throw new Error('Byte panjang tidak valid');
  }

  static _encodeSentence(words) {
    const parts = words.map(w => RouterOS._encWord(w));
    parts.push(Buffer.from([0]));
    return Buffer.concat(parts);
  }

  /** Decode seluruh buffer menjadi array kalimat (array kata). */
  static _decodeSentences(buf) {
    const out = [];
    let i = 0;
    while (i < buf.length) {
      const words = [];
      let done = false;
      while (i < buf.length) {
        if (buf[i] === 0) { i++; done = true; break; }
        const [len, nb] = RouterOS._readLen(buf, i);
        i += nb;
        if (i + len > buf.length) return { sentences: out, rest: buf.slice(i - nb) };
        words.push(buf.slice(i, i + len).toString('utf8'));
        i += len;
      }
      if (words.length) out.push(words);
      if (!done) break;
    }
    return { sentences: out, rest: Buffer.alloc(0) };
  }

  /** "name=ether1" -> { key: 'name', value: 'ether1' } (kata tunggal dari router). */
  static _attr(word) {
    if (!word.startsWith('=')) return null;
    const body = word.slice(1);
    const eq = body.indexOf('=');
    if (eq < 0) return { key: body, value: '' };
    return { key: body.slice(0, eq), value: body.slice(eq + 1) };
  }

  /** Kumpulkan kalimat sampai !done/!fatal — reply router bisa terpecah beberapa paket. */
  async _recvUntilDone() {
    const semua = [];
    for (;;) {
      const bagian = await this._recv(this.sock);
      semua.push(...bagian);
      if (bagian.some(s => s[0] === '!done' || s[0] === '!fatal')) return semua;
    }
  }

  _connect() {
    return new Promise((resolve, reject) => {
      const sock = net.createConnection({ host: this.host, port: this.port }, () => resolve(sock));
      sock.setTimeout(this.timeout);
      sock.on('error', reject);
      sock.on('timeout', () => sock.destroy(new Error('Timeout koneksi RouterOS')));
    });
  }

  _send(sock, words) {
    return new Promise((resolve, reject) => {
      sock.write(RouterOS._encodeSentence(words), err => (err ? reject(err) : resolve()));
    });
  }

  /** Baca kalimat berikutnya dari socket (dengan buffer). */
  _recv(sock) {
    return new Promise((resolve, reject) => {
      const onData = (chunk) => {
        this.buf = Buffer.concat([this.buf, chunk]);
        const { sentences, rest } = RouterOS._decodeSentences(this.buf);
        if (sentences.length) {
          this.buf = rest;
          cleanup();
          resolve(sentences);
        }
      };
      const onErr = (e) => { cleanup(); reject(e); };
      const onClose = () => { cleanup(); reject(new Error('Koneksi ditutup RouterOS')); };
      const cleanup = () => {
        sock.off('data', onData); sock.off('error', onErr);
        sock.off('close', onClose); sock.off('timeout', onT);
      };
      const onT = () => { cleanup(); reject(new Error('Timeout baca data RouterOS')); };
      sock.on('data', onData); sock.on('error', onErr);
      sock.on('close', onClose); sock.on('timeout', onT);
      if (this.buf.length) onData(Buffer.alloc(0));
    });
  }

  async connect() {
    this.buf = Buffer.alloc(0);
    const sock = await this._connect();
    this.sock = sock;
    await this._login(sock);
    return this;
  }

  /** ROS >= 6.43 login password polos; versi lama mengirim challenge MD5 (=ret=). */
  async _login(sock) {
    await this._send(sock, ['/login', `=name=${this.user}`, `=password=${this.password}`]);
    const jawab = await this._recvUntilDone();
    const kata = jawab.flatMap(s => s.slice(1));
    const ret = kata.map(w => RouterOS._attr(w)).find(a => a && a.key === 'ret');
    if (ret && ret.value) {
      // router lama meminta challenge-response
      const hash = crypto.createHash('md5')
        .update('\0' + String(this.password) + ret.value, 'utf8').digest('hex');
      await this._send(sock, ['/login', `=name=${this.user}`, `=password=${hash}`]);
      const lagi = await this._recvUntilDone();
      if (lagi.some(s => s[0] === '!trap' || s[0] === '!fatal')) {
        sock.destroy();
        throw new Error('Login RouterOS gagal (kredensial salah)');
      }
      return;
    }
    if (jawab.some(s => s[0] === '!trap' || s[0] === '!fatal')) {
      sock.destroy();
      throw new Error('Login RouterOS gagal (kredensial salah)');
    }
  }

  /** Jalankan perintah, contoh: ['/interface/print'] atau ['/interface/set', '=.id=*1', '=disabled=no'] */
  async run(words) {
    if (!this.sock) await this.connect();
    await this._send(this.sock, words);
    const sentences = await this._recvUntilDone();
    let trap = null;
    const rows = [];
    let cur = null;
    // RouterOS mengirim baris sebagai satu kalimat: ['!re', '=name=ether1', ...]
    for (const s of sentences) {
      const head = String(s[0] || '');
      let kata = s;
      if (head.startsWith('!')) {
        if (head === '!re') { cur = {}; rows.push(cur); kata = s.slice(1); }
        else if (head === '!trap' || head === '!fatal') {
          const a = RouterOS._attr(s[1]);
          trap = (a && a.key === 'message') ? a.value : s.slice(1).join(' ');
          continue;
        } else { cur = null; continue; }   // !done / !empty
      }
      if (cur === null) continue;
      for (const w of kata) {
        const a = RouterOS._attr(w);
        if (a) cur[a.key] = a.value;
      }
    }
    if (trap) throw new Error(`RouterOS: ${trap}`);
    return rows;
  }

  close() {
    if (this.sock) { try { this.sock.destroy(); } catch (_) {} this.sock = null; }
  }

  // ==== Fitur khusus ivvibill =================================

  /** Daftar interface — PENGECUALIAN tipe pppoe sesuai spesifikasi. */
  async listInterfaces() {
    const rows = await this.run(['/interface/print',
      '=.proplist=.id,name,type,disabled,running,rx-byte,tx-byte']);
    return rows.filter(r => {
      const t = (r.type || '').toLowerCase();
      const name = (r.name || '').toLowerCase();
      // kecualikan interface pppoe (client/server) & sejenis ppp lain
      if (t.includes('pppoe') || t.startsWith('ppp')) return false;
      if (/^pppoe[-_]/.test(name) || name.startsWith('pppoe-out')) return false;
      return true;
    });
  }

  /**
   * Traffic rx/tx (bits per detik) — dihitung dari selisih counter kumulatif
   * rx-byte/tx-byte terhadap sampel sebelumnya per interface.
   */
  monitorRate(names, rows) {
    const now = Date.now();
    const kunci = `${this.host}:${this.port}`;
    const lama = sampelSebelum.get(kunci) || {};
    const terbaru = {};
    const out = {};
    for (const r of rows) {
      if (!r.name || !names.includes(r.name)) continue;
      const rx = Number(r['rx-byte'] || 0), tx = Number(r['tx-byte'] || 0);
      const l = lama[r.name];
      if (l && now > l.at && rx >= l.rx && tx >= l.tx) {
        const detik = (now - l.at) / 1000;
        out[r.name] = {
          rx: Math.round((rx - l.rx) * 8 / detik),
          tx: Math.round((tx - l.tx) * 8 / detik)
        };
      } else {
        out[r.name] = { rx: 0, tx: 0 };
      }
      terbaru[r.name] = { rx, tx, at: now };
    }
    sampelSebelum.set(kunci, terbaru);
    return out;
  }

  /** resource: cpu, memory, uptime, board */
  async resource() {
    let rows;
    try {
      rows = await this.run(['/system/resource/print']);
    } catch (_) {
      rows = await this.run(['/resource/print']);   // RouterOS <= 6
    }
    const [r] = rows;
    if (!r) return {};
    const memTotal = Number(r['total-memory'] || 0);
    const memFree = Number(r['free-memory'] || 0);
    return {
      cpu_load: Number(r['cpu-load'] || 0),
      memory_used: memTotal ? Math.round(((memTotal - memFree) / memTotal) * 100) : null,
      uptime: r.uptime || '',
      board_name: r['board-name'] || r['architecture-name'] || ''
    };
  }

  /** Status koneksi PPPoE aktif (untuk deteksi offline pelanggan). */
  async pppoeActive() {
    try {
      const rows = await this.run(['/ppp/active/print',
        '=.proplist=.id,name,user,service,address,uptime']);
      return rows.map(r => ({
        // pada beberapa router, kolom user kosong dan nama koneksi = username PPPoE
        name: r.name || '',
        user: r.user || r.name || '',
        address: r.address || '',
        uptime: r.uptime || '',
        service: r.service || ''
      })).filter(r => (r.service || '').toLowerCase() === 'pppoe' || r.service === '');
    } catch (e) {
      return [];
    }
  }
}

/** Uji koneksi cepat (untuk tombol "Tes Koneksi" di panel). */
async function testConnection(opts) {
  const t0 = Date.now();
  const c = new RouterOS(opts);
  let err = new Error('Koneksi RouterOS gagal');
  for (let i = 1; i <= 3; i++) {
    try {
      await c.connect();
      const ifaces = await c.listInterfaces();
      return { ok: true, ms: Date.now() - t0, interfaces: ifaces.length };
    } catch (e) {
      err = e;
      c.close();
      // kredensial salah / perintah ditolak: percobaan ulang tidak membantu
      if (/kredensial|RouterOS:/i.test(String(e.message))) break;
      if (i < 3) await new Promise(r => setTimeout(r, 1200));
    }
  }
  return { ok: false, ms: Date.now() - t0, error: String(err.message).slice(0, 200) };
}

module.exports = { RouterOS, testConnection };
