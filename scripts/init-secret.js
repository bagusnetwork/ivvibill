'use strict';
// ============================================================
// Buat/isi berkas rahasia enkripsi (.secret) untuk ivvibill.
// Pemakaian:
//   npm run init-secret                    → tulis <root>/.secret
//   npm run init-secret -- /etc/ivvibill/secret.key
//
// Prioritas baca di src/config.js:
//   APP_SECRET_FILE → /etc/ivvibill/secret.key → <root>/.secret → APP_SECRET
//
// Di VPS yang aman, pindahkan ke luar web root:
//   npm run init-secret -- /etc/ivvibill/secret.key
//   lalu set APP_SECRET_FILE=/etc/ivvibill/secret.key di .env
// ============================================================
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const tujuan = process.argv[2] || path.join(__dirname, '..', '.secret');

if (fs.existsSync(tujuan)) {
  const lama = fs.readFileSync(tujuan, 'utf8').trim();
  if (lama.length >= 32) {
    console.log(`Sudah ada & valid (32+ karakter): ${tujuan}`);
    console.log('Tidak ditimpa. Hapus file dulu bila ingin membuat baru.');
    process.exit(0);
  }
}

fs.mkdirSync(path.dirname(tujuan), { recursive: true });
const kunci = crypto.randomBytes(48).toString('base64url'); // 64 karakter
fs.writeFileSync(tujuan, kunci + '\n', { mode: 0o600 });
fs.chmodSync(tujuan, 0o600);

console.log(`Kunci rahasia dibuat: ${tujuan}`);
console.log(`Panjang: ${kunci.length} karakter (mode 600)`);
console.log('');
console.log('Langkah berikutnya:');
console.log('  1. Pastikan .env punya JWT_SECRET (boleh beda nilai, bebas).');
console.log('  2. Bila memindahkan ke luar web root, set APP_SECRET_FILE di .env.');
console.log('  3. Jangan commit berkas ini ke repositori publik.');
process.exit(0);
