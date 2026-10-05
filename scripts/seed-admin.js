'use strict';
// ============================================================
// Buat akun superadmin awal.
// Pemakaian:
//   node scripts/seed-admin.js                       → user/pass acak (dicetak)
//   node scripts/seed-admin.js admin mypass123       → tentukan sendiri
// ============================================================
const bcrypt = require('bcryptjs');
const db = require('../src/db');
const config = require('../src/config');

function acakPass() {
  const a = 'abcdefghjkmnpqrstuvwxyz';
  const n = '23456789';
  let s = '';
  for (let i = 0; i < 4; i++) s += a[Math.floor(Math.random() * a.length)];
  for (let i = 0; i < 4; i++) s += n[Math.floor(Math.random() * n.length)];
  return s;
}

(async () => {
  const username = process.argv[2] || 'superadmin';
  let pass = process.argv[3] || acakPass();
  const hash = await bcrypt.hash(pass, config.security.bcryptRounds);

  const ada = await db.one('SELECT id FROM app_user WHERE username = ?', [username]);
  if (ada) {
    await db.run('UPDATE app_user SET password_hash = ?, role = ?, status = ? WHERE id = ?',
      [hash, 'superadmin', 'aktif', ada.id]);
    console.log(`Akun "${username}" diperbarui.`);
  } else {
    await db.insert(
      `INSERT INTO app_user (username, password_hash, nama, role, status) VALUES (?,?,?, 'superadmin', 'aktif')`,
      [username, hash, 'Super Admin']);
    console.log(`Akun superadmin "${username}" dibuat.`);
  }
  console.log(`Password: ${pass}`);
  console.log('Simpan sekarang — password tidak disimpan plaintext.');
  process.exit(0);
})().catch(e => { console.error('GAGAL:', e.message); process.exit(1); });
