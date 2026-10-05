'use strict';
// ============================================================
// Enkripsi AES-256-GCM untuk rahasia (password perangkat,
// kunci gateway). Format tersimpan:
//   v1.<iv-b64>.<tag-b64>.<cipher-b64>
// ============================================================
const crypto = require('crypto');
const config = require('../config');

const KEY = crypto.createHash('sha256').update(String(config.security.secretKey)).digest();

function encrypt(plain) {
  if (plain === null || plain === undefined || plain === '') return plain;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', KEY, iv);
  const enc = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1.${iv.toString('base64')}.${tag.toString('base64')}.${enc.toString('base64')}`;
}

function decrypt(stored) {
  if (stored === null || stored === undefined || stored === '') return stored;
  if (!String(stored).startsWith('v1.')) return stored; // nilai lama / bukan enkripsi
  try {
    const [, ivB, tagB, dataB] = String(stored).split('.');
    const decipher = crypto.createDecipheriv('aes-256-gcm', KEY, Buffer.from(ivB, 'base64'));
    decipher.setAuthTag(Buffer.from(tagB, 'base64'));
    return Buffer.concat([
      decipher.update(Buffer.from(dataB, 'base64')),
      decipher.final()
    ]).toString('utf8');
  } catch (e) {
    throw new Error('Gagal dekripsi rahasia: APP_SECRET mungkin berganti.');
  }
}

/** Hash token acak untuk disimpan (mis. API key). */
function hashToken(t) {
  return crypto.createHash('sha256').update(String(t)).digest('hex');
}

function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('hex');
}

module.exports = { encrypt, decrypt, hashToken, randomToken };
