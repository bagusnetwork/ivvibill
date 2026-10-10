'use strict';
// ============================================================
// ivvibill — konfigurasi pusat (env, aman untuk produksi)
// ============================================================
require('dotenv').config();
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const env = process.env || {};

function loadSecret() {
  // Kunci enkripsi rahasia perangkat & gateway disimpan di file di luar web root
  // bila dipasang di VPS; fallback ke file lokal .secret (mode hosting).
  const candidates = [
    env.APP_SECRET_FILE,
    '/etc/ivvibill/secret.key',
    path.join(ROOT, '.secret')
  ].filter(Boolean);

  for (const f of candidates) {
    try {
      if (fs.existsSync(f)) {
        const v = fs.readFileSync(f, 'utf8').trim();
        if (v.length >= 32) return v;
      }
    } catch (_) { /* lanjut */ }
  }
  if (env.APP_SECRET && env.APP_SECRET.length >= 32) return env.APP_SECRET;
  throw new Error(
    'APP_SECRET belum diisi. Jalankan `npm run init-secret` atau set env APP_SECRET (min 32 karakter).'
  );
}

const config = {
  root: ROOT,
  app: {
    name: 'ivvibill',
    version: '1.7.0',
    tz: env.TZ || 'Asia/Jakarta',
    baseUrl: (env.BASE_URL || '').replace(/\/+$/, ''),
    env: env.NODE_ENV || 'production',
    // true bila BASE_URL https — dipakai untuk CSP upgrade-insecure-requests & HSTS
    https: /^https:/i.test(env.BASE_URL || '')
  },
  db: {
    host: env.DB_HOST || 'localhost',
    port: Number(env.DB_PORT || 3306),
    user: env.DB_USER || 'ivvibill_app',
    password: env.DB_PASS || '',
    database: env.DB_NAME || 'ivvibill',
    connectionLimit: Number(env.DB_POOL || 10),
    charset: 'utf8mb4_unicode_ci'
  },
  server: {
    port: Number(env.PORT || 3010),
    bind: env.BIND || '127.0.0.1',
    // IP yang boleh memanggil endpoint internal/cron (whitelist)
    trustedIps: (env.TRUSTED_IPS || '127.0.0.1,::1').split(',').map(s => s.trim()).filter(Boolean),
    proxy: process.env.TRUST_PROXY === '1'
  },
  jwt: {
    secret: env.JWT_SECRET || null, // diisi saat init bila APP_SECRET tidak cukup
    ttl: env.JWT_TTL || '12h'
  },
  security: {
    secretKey: loadSecret(),
    bcryptRounds: Number(env.BCRYPT_ROUNDS || 10),
    maxLoginFail: Number(env.MAX_LOGIN_FAIL || 5),
    lockMinutes: Number(env.LOCK_MINUTES || 15),
    uploadDir: env.UPLOAD_DIR || path.join(ROOT, 'storage', 'uploads')
  },
  files: {
    secretFile: env.APP_SECRET_FILE || path.join(ROOT, '.secret'),
    envFile: path.join(ROOT, '.env')
  }
};

if (!config.jwt.secret) config.jwt.secret = config.security.secretKey;

module.exports = config;
