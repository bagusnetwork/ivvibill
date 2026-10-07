'use strict';
// ============================================================
// Parser/serializer CSV ringkas (tanpa dependensi eksternal).
// Dipakai export & import data pelanggan:
//  - delimiter terdeteksi dari baris header pertama: , ; \t
//    (Excel berbahasa Indonesia menyimpan CSV dengan ';')
//  - mendukung kutip "..." dengan kutip ganda "" di dalamnya,
//    BOM UTF-8, dan baris CRLF/LF/CR
//  - baris kosong dan baris komentar (diawali #) diabaikan;
//    nomor baris asli dipertahankan supaya pesan error import
//    menunjuk baris yang terlihat di Excel.
// ============================================================

/** Hitung kemunculan `ch` di luar bagian berkutip. */
function hitungDiLuarKutip(s, ch) {
  let n = 0, inKutip = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '"') {
      if (inKutip && s[i + 1] === '"') i++;      // "" = kutip literal
      else inKutip = !inKutip;
    } else if (!inKutip && c === ch) n++;
  }
  return n;
}

/** Deteksi delimiter: kandidat , ; tab — dipilih yang paling sering muncul. */
function deteksiDelimiter(contoh) {
  let terbaik = ',', nTerbaik = -1;
  for (const d of [',', ';', '\t']) {
    const n = hitungDiLuarKutip(contoh, d);
    if (n > nTerbaik) { nTerbaik = n; terbaik = d; }
  }
  return terbaik;
}

/** Parse satu baris CSV → array sel. */
function parseBaris(baris, d) {
  const hasil = [];
  let cur = '', inKutip = false;
  for (let i = 0; i < baris.length; i++) {
    const c = baris[i];
    if (inKutip) {
      if (c === '"') {
        if (baris[i + 1] === '"') { cur += '"'; i++; }
        else inKutip = false;
      } else cur += c;
    } else if (c === '"') inKutip = true;
    else if (c === d) { hasil.push(cur); cur = ''; }
    else cur += c;
  }
  hasil.push(cur);
  return hasil;
}

/**
 * Parse teks CSV penuh → [{ baris: <nomor 1-based>, sel: [..] }].
 * Baris komentar (#) dan baris kosong dibuang, tetapi nomor baris asli
 * tetap dilekatkan pada tiap entri.
 */
function parseCsv(teks) {
  const bersih = String(teks).replace(/^\uFEFF/, '')
    .replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const baris = bersih.split('\n');

  // contoh delimiter = baris pertama yang bukan komentar/kosong
  let contoh = '';
  for (const b of baris) { if (b.trim() && !b.trim().startsWith('#')) { contoh = b; break; } }
  const d = contoh ? deteksiDelimiter(contoh) : ',';

  const hasil = [];
  for (let i = 0; i < baris.length; i++) {
    const t = baris[i].trim();
    if (!t || t.startsWith('#')) continue;
    const sel = parseBaris(baris[i], d);
    // komentar yang ikut terkutip ("# …") tetap diabaikan
    if (String(sel[0] || '').trim().startsWith('#')) continue;
    if (sel.every(c => !String(c).trim())) continue;
    hasil.push({ baris: i + 1, sel });
  }
  return hasil;
}

/** Sel CSV — dikutip bila mengandung delimiter/kutip/garis baru. */
function selCsv(x) {
  const s = (x === null || x === undefined) ? '' : String(x);
  return /[",;\n\r\t]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

/** Tulis teks CSV (baris dipisah CRLF; BOM opsional agar Excel membaca UTF-8). */
function tulisCsv(baris, { bom = false } = {}) {
  const teks = baris.map(r => r.map(selCsv).join(',')).join('\r\n') + '\r\n';
  return (bom ? '\uFEFF' : '') + teks;
}

module.exports = { parseCsv, selCsv, tulisCsv, deteksiDelimiter };
