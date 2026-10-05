'use strict';
// ============================================================
// Klien RouterOS API (protocol bawaan MikroTik, port 8728/TCP).
// Implementasi sendiri — tanpa dependensi native.
// Dipakai untuk monitoring interface (KECUALI pppoe), resource,
// dan status koneksi PPPoE pelanggan.
// ============================================================
const net = require('net');

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
    // RouterOS >= 6.43: login plane dengan password polos
    await this._send(sock, ['/login', `name=${this.user}`, `password=${this.password}`]);
    const reply = await this._recv(sock);
    const line = reply[0] || [];
    if (line[0] === '!trap' || line.some(w => /invalid user name or password/i.test(w))) {
      sock.destroy();
      throw new Error('Login RouterOS gagal (kredensial salah)');
    }
    return this;
  }

  /** Jalankan perintah, contoh: ['/interface/print'] atau ['/interface/set', '.id=ether1', 'disabled=no'] */
  async run(words) {
    if (!this.sock) await this.connect();
    await this._send(this.sock, words);
    const sentences = await this._recv(this.sock);
    let trap = null;
    const rows = [];
    let cur = null;
    for (const s of sentences) {
      if (s[0] === '!re') { cur = {}; rows.push(cur); continue; }
      if (s[0] === '!trap' || s[0] === '!fatal') { trap = s.slice(1).join(' '); continue; }
      if (s[0] === '!done') { if (cur === null) rows.push({}); continue; }
      if (cur !== null && s.length >= 2 && s[0].startsWith('=')) {
        const k = s[0].slice(1);
        const eq = s.indexOf('=');
        if (eq >= 0) cur[k] = s.slice(eq + 1).join('=');
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
    const rows = await this.run(['/interface/print']);
    return rows.filter(r => {
      const t = (r.type || '').toLowerCase();
      const name = (r.name || '').toLowerCase();
      // kecualikan interface pppoe (client/server) & sejenis ppp lain
      if (t.includes('pppoe') || t.startsWith('ppp')) return false;
      if (/^pppoe[-_]/.test(name) || name.startsWith('pppoe-out')) return false;
      return true;
    });
  }

  /** Traffic rx/tx (bits per detik) untuk nama interface tertentu. */
  async monitorTraffic(names) {
    if (!names.length) return {};
    const rows = await this.run(['/interface/monitor-traffic', ...names.map(n => `=.proplist=${n}`), '=once=']);
    // format riil: tiap baris = {name, rx, tx} — tangani varian penulisan
    const out = {};
    for (const r of rows) {
      const n = r.name || r['=name'];
      if (!n) continue;
      out[n] = { rx: Number(r.rx || 0), tx: Number(r.tx || 0) };
    }
    return out;
  }

  /** resource: cpu, memory, uptime, board */
  async resource() {
    const [r] = await this.run(['/system/resource/print']);
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
      const rows = await this.run(['/ppp/active/print']);
      return rows.map(r => ({
        name: r.name || r.user || '',
        user: r.user || '',
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
  try {
    const ifaces = await c.listInterfaces();
    return { ok: true, ms: Date.now() - t0, interfaces: ifaces.length };
  } catch (e) {
    return { ok: false, ms: Date.now() - t0, error: e.message };
  } finally {
    c.close();
  }
}

module.exports = { RouterOS, testConnection };
