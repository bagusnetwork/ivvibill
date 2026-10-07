'use strict';
// ============================================================
// Kwitansi lunas sebagai gambar PNG — padanan
// Pembayaran::buatKwitansi() milik gratisinaja (GD/imagestring),
// dikirim ke WhatsApp pelanggan lewat sendMediaFromUrl.
// ============================================================
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('../config');
const { Kanvas, HITAM, PUTIH, BIRU, ABU, ORANYE } = require('../util/png');
const { tglIndo } = require('../util/tanggal');

const LEBAR = 640;
const TINGGI = 440;
const MARGIN = 18;
const KOLOM = MARGIN + 250;   // nilai mulai di sini (label skala 2 <= 20 karakter)

// Nama orang/alamat kadang memakai huruf beraksen yang tidak ada di font 5x7.
function ascii(s) {
  return String(s == null ? '' : s)
    .replace(/[áàâä]/g, 'a').replace(/[ÁÀÂÄ]/g, 'A')
    .replace(/[éèêë]/g, 'e').replace(/[ÉÈÊË]/g, 'E')
    .replace(/[íìîï]/g, 'i').replace(/[ÍÌÎÏ]/g, 'I')
    .replace(/[óòôö]/g, 'o').replace(/[ÓÒÔÖ]/g, 'O')
    .replace(/[úùûü]/g, 'u').replace(/[ÚÙÛÜ]/g, 'U')
    .replace(/[^ -~]/g, '')
    .trim();
}

function rupiah(n) {
  return 'Rp ' + Number(n || 0).toLocaleString('id-ID');
}

/** Potong teks agar muat di kanvas (skala 2 = 12 px per karakter). */
function pas(t, maksKarakter) {
  const s = ascii(t);
  return s.length > maksKarakter ? s.slice(0, Math.max(0, maksKarakter - 3)) + '...' : s;
}

/**
 * Angka → huruf. Dipakai di kwitansi dan di halaman cetak invoice,
 * jadi berada di sisi server agar keduanya tidak berbeda.
 */
function terbilang(n) {
  n = Math.round(Number(n) || 0);
  if (n === 0) return 'nol';
  const a = ['', 'satu', 'dua', 'tiga', 'empat', 'lima', 'enam', 'tujuh', 'delapan',
    'sembilan', 'sepuluh', 'sebelas'];
  const f = (x) => {
    if (x < 12) return a[x];
    if (x < 20) return `${f(x - 10)} belas`;
    if (x < 100) return `${f(Math.floor(x / 10))} puluh ${f(x % 10)}`;
    if (x < 200) return `seratus ${f(x - 100)}`;
    if (x < 1000) return `${f(Math.floor(x / 100))} ratus ${f(x % 100)}`;
    if (x < 2000) return `seribu ${f(x - 1000)}`;
    if (x < 1e6) return `${f(Math.floor(x / 1000))} ribu ${f(x % 1000)}`;
    if (x < 1e9) return `${f(Math.floor(x / 1e6))} juta ${f(x % 1e6)}`;
    return `${f(Math.floor(x / 1e9))} miliar ${f(x % 1e9)}`;
  };
  return f(n).replace(/\s+/g, ' ').trim();
}

/** Gambar kwitansi untuk satu pelunasan tagihan. */
function gambar({ tagihan, pelanggan = {}, server = {}, bayar = {} }) {
  const k = new Kanvas(LEBAR, TINGGI, PUTIH);
  k.kotak(0, 0, LEBAR, 54, BIRU);
  k.teks(MARGIN, 12, pas((server.nama_server || 'ivvibill').toUpperCase(), 46), PUTIH, 2);
  k.teks(MARGIN, 32, pas(server.alamat || '', 62), PUTIH, 1);
  k.teksTengah(70, 'KWITANSI PEMBAYARAN', HITAM, 3);
  k.garis(MARGIN, 96, LEBAR - MARGIN, 96, ORANYE);

  const noKwitansi = `KM${String(tagihan.nomor_invoice || '').replace(/[^A-Za-z0-9]/g, '')}`;
  const tanggal = tglIndo(bayar.tanggal || tagihan.paid_at || tagihan.jatuh_tempo);
  const baris = [
    ['No. Kwitansi', noKwitansi],
    ['Tanggal', tanggal],
    ['Diterima dari', pelanggan.nama || tagihan.nama_pelanggan || '-'],
    ['Nomor layanan', pelanggan.username_pppoe || tagihan.username_pppoe || null],
    ['Pembayaran', tagihan.keterangan || `Langganan ${tagihan.periode || ''}`],
    ['Nomor invoice', tagihan.nomor_invoice || '-'],
    ['Jumlah', rupiah(tagihan.total)],
    ['Terbilang', `${terbilang(tagihan.total)} rupiah`, 1],
    ['Metode', bayar.metode || tagihan.metode_bayar || 'manual']
  ];
  let y = 112;
  for (const [label, isi, skalaNilai] of baris) {
    if (isi === null) continue;   // baris yang tidak berlaku (mis. nomor layanan pada invoice barang)
    const sk = skalaNilai || 2;
    k.teks(MARGIN, y, pas(label, 18), ABU, 2);
    k.teks(KOLOM, y, pas(isi, Math.floor((LEBAR - MARGIN - KOLOM) / (sk * 6))), HITAM, sk);
    y += 24;
  }

  k.garis(MARGIN, y + 4, LEBAR - MARGIN, y + 4, ABU);
  const kota = ascii(server.alamat || '').split(',').pop().trim();
  const tglTtd = `${kota ? kota + ', ' : ''}${tanggal}`;
  // rata kanan ke margin: nama kota panjang tidak boleh keluar kanvas
  const kanan = (yy, teks, sk = 2) => {
    const t = pas(teks, Math.floor((LEBAR - MARGIN) / (sk * 6)));
    k.teks(LEBAR - MARGIN - t.length * sk * 6, yy, t, HITAM, sk);
  };
  kanan(y + 16, tglTtd, tglTtd.length > 24 ? 1 : 2);
  kanan(y + 40, 'Hormat kami,');
  k.garis(LEBAR - 300, y + 82, LEBAR - MARGIN, y + 82, ABU);
  kanan(y + 86, server.nama_pemilik || '');
  return k;
}

/**
 * Tulis PNG kwitansi ke folder upload dan balas lokasi publiknya.
 * Nama berkas ditentukan pemanggil supaya kwitansi tagihan dan kwitansi
 * invoice tidak saling menimpa; token acak ditambahkan karena isinya
 * data pribadi dan folder upload disajikan tanpa login.
 */
function simpan(data, nama, ganti = null) {
  const folder = path.join(config.security.uploadDir, 'kwitansi');
  fs.mkdirSync(folder, { recursive: true });
  const dasar = String(nama).replace(/[^A-Za-z0-9_-]/g, '');
  const berkas = `${dasar}-${crypto.randomBytes(4).toString('hex')}.png`;
  fs.writeFileSync(path.join(folder, berkas), data.toBuffer());
  if (ganti && ganti !== `kwitansi/${berkas}`) {
    try { fs.unlinkSync(path.join(config.security.uploadDir, ganti)); } catch (_) { /* berkas lama boleh tertinggal */ }
  }
  const url = `${config.app.baseUrl}/uploads/kwitansi/${berkas}`;
  return { file: `kwitansi/${berkas}`, url };
}

/**
 * Buat + simpan kwitansi. Gagal render tidak boleh membatalkan pelunasan,
 * jadi pemanggil membungkusnya dengan try/catch.
 */
function buat(params, nama, ganti = null) {
  return simpan(gambar(params), nama || `kwitansi-${params.tagihan.id}`, ganti);
}

module.exports = { buat, gambar, terbilang, rupiah, ascii };
