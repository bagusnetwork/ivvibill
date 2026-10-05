'use strict';
// ============================================================
// Pemicu cron EKSTERNAL — untuk shared hosting / PaaS yang tidak
// boleh menjalankan proses Node panjang (scheduler in-process).
//
// Pemakaian:
//   node scripts/cron.js billing      # buat+kirim tagihan & isolir
//   node scripts/cron.js wa           # kirim antrean WhatsApp
//   node scripts/cron.js router       # polling interface router
//   node scripts/cron.js olt          # polling redaman OLT
//   node scripts/cron.js issue        # deteksi issue pelanggan PPPoE
//   node scripts/cron.js semwa        # semua tugas di atas
//
// Mode ini MENGANTIKAN scheduler in-process. Matikan scheduler
// dengan env DISABLE_SCHEDULER=1 di .env.
// ============================================================
const scheduler = require('../src/scheduler');

const TUGAS = {
  billing: () => scheduler.tugasBilling(),
  wa: () => scheduler.tugasWa(),
  router: () => scheduler.tugasRouter(),
  olt: () => scheduler.tugasOlt(),
  issue: () => scheduler.tugasIssue()
};

(async () => {
  const nama = (process.argv[2] || '').toLowerCase();
  if (nama === 'semwa') {
    for (const k of Object.keys(TUGAS)) {
      const r = await TUGAS[k]();
      console.log(`${k}:`, JSON.stringify(r ?? 'ok'));
    }
    process.exit(0);
  }
  const fn = TUGAS[nama];
  if (!fn) {
    console.error('Tugas tidak dikenal:', nama || '(kosong)');
    console.error('Pilihan:', Object.keys(TUGAS).join(', '), ', semwa');
    process.exit(1);
  }
  const r = await fn();
  console.log(`${nama}:`, JSON.stringify(r ?? 'ok'));
  process.exit(0);
})().catch(e => { console.error('GAGAL:', e.message); process.exit(1); });
