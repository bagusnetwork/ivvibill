'use strict';
// ============================================================
// Validasi input ringkas — semua input API wajib lewat sini.
//
// KONVENSI WAJIB ISI: opsi `def` yang TIDAK dikirim berarti kolom itu wajib.
// Sebelumnya `def` berdefault null, sehingga field yang tidak dikirim diam-diam
// menjadi NULL dan jatuh ke constraint database → HTTP 500 "Column 'x' cannot
// be null". Kini field wajib yang hilang langsung ditolak 400 "Nilai wajib
// diisi". Kolom opsional tetap menulis `def: null` (atau nilai lain) secara
// eksplisit — seperti yang sudah dilakukan sebagian besar pemanggilan.
// ============================================================

function str(v, { min = 0, max = 10000, def = undefined, trim = true } = {}) {
  if (v === undefined || v === null || v === '') {
    if (def === undefined) throw new Error('Nilai wajib diisi');
    return def;
  }
  let s = String(v);
  if (trim) s = s.trim();
  if (s.length < min) throw new Error(`Minimal ${min} karakter`);
  if (s.length > max) throw new Error(`Maksimal ${max} karakter`);
  return s;
}

function num(v, { min = null, max = null, def = undefined, int = false } = {}) {
  if (v === undefined || v === null || v === '') {
    if (def === undefined) throw new Error('Nilai wajib diisi');
    return def;
  }
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error('Harus berupa angka');
  if (int && !Number.isInteger(n)) throw new Error('Harus bilangan bulat');
  if (min !== null && n < min) throw new Error(`Minimal ${min}`);
  if (max !== null && n > max) throw new Error(`Maksimal ${max}`);
  return n;
}

function enumOf(v, allowed, def = undefined) {
  if (v === undefined || v === null || v === '') {
    if (def === undefined) throw new Error('Nilai wajib diisi');
    return def;
  }
  const s = String(v);
  if (!allowed.includes(s)) throw new Error(`Nilai tidak valid: ${s}`);
  return s;
}

function phone(v) {
  if (v === undefined || v === null || v === '') return null;
  let s = String(v).replace(/[^0-9]/g, '');
  if (s.startsWith('0')) s = '62' + s.slice(1);
  if (!s.startsWith('62')) s = '62' + s;
  if (s.length < 10 || s.length > 15) throw new Error('Nomor WhatsApp tidak valid');
  return s;
}

function email(v) {
  if (v === undefined || v === null || v === '') return null;
  const s = String(v).trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(s)) throw new Error('Email tidak valid');
  return s;
}

function tgl(v, def = null) {
  if (v === undefined || v === null || v === '') return def;
  const s = String(v);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) throw new Error('Format tanggal YYYY-MM-DD');
  const d = new Date(s + 'T00:00:00Z');
  if (isNaN(d.getTime())) throw new Error('Tanggal tidak valid');
  return s;
}

/** username: huruf/angka/._ -, 3-50 */
function username(v) {
  const s = str(v, { min: 3, max: 50 });
  if (!/^[A-Za-z0-9._-]+$/.test(s)) throw new Error('Username hanya huruf, angka, . _ -');
  return s;
}

/** password kuat: min 8, ada huruf & angka */
function password(v) {
  const s = String(v || '');
  if (s.length < 8) throw new Error('Password minimal 8 karakter');
  if (!/[A-Za-z]/.test(s) || !/[0-9]/.test(s)) throw new Error('Password harus memuat huruf dan angka');
  if (s.length > 72) throw new Error('Password maksimal 72 karakter');
  return s;
}

module.exports = { str, num, enumOf, phone, email, tgl, username, password };
