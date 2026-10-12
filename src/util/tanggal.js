'use strict';
// Format tanggal Indonesia dipakai bersama oleh layanan tagihan (billing),
// kwitansi gambar, dan invoice barang — ditaruh di util agar tidak terjadi
// require melingkar antar layanan.

const BULAN = ['Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni',
  'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember'];

/** '2026-10-07' (atau Date/DateTime MySQL) → '7 Oktober 2026'. */
function tglIndo(d) {
  if (!d) return '';
  const [y, m, day] = String(d).slice(0, 10).split('-');
  if (!m || !day) return String(d).slice(0, 10);
  return `${Number(day)} ${BULAN[Number(m) - 1] || ''} ${y}`.trim();
}

/** '2026-10' → 'Oktober 2026'. */
function periodeIndo(p) {
  const [y, m] = String(p || '').split('-');
  return m ? `${BULAN[Number(m) - 1] || m} ${y}` : String(p || '');
}

// ------------------------------------------------------------ waktu siklus
// Jadwal tagihan dipakai lewat scheduler in-process yang tadinya membaca
// getUTCDate()/getUTCHours(). Server ini jalan di WIB (TZ=Asia/Jakarta), jadi
// "tgl 1" dan "jam 07:00" yang dilihat cron selalu meleset 7 jam dari jam
// dinding yang dibaca pemilik ISP di menu Pengaturan — dan karena pencocokan
// dulu pakai = (sama persis), satu menit yang terlewat berarti siklus bulan itu
// tidak pernah jalan. Semua pembanding jadwal sekarang lewat fungsi ini.
const ZONA = process.env.TZ_TAGIHAN || process.env.TZ || 'Asia/Jakarta';

/** Bagian tanggal/jam di zona aplikasi, bukan UTC dan bukan zona browser. */
function waktuSiklus(d = new Date()) {
  const p = new Intl.DateTimeFormat('en-CA', {
    timeZone: ZONA, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
  }).formatToParts(d);
  const amb = (jenis) => ((p.find((x) => x.type === jenis) || {}).value || '');
  const jam = String(amb('hour')).padStart(2, '0');
  const menit = String(amb('minute')).padStart(2, '0');
  const tanggal = Number(amb('day'));
  return {
    zona: ZONA,
    tanggal,                                     // 1..31, hari di jam dinding ISP
    periode: `${amb('year')}-${amb('month')}`,   // YYYY-MM versi lokal
    hari: `${amb('year')}-${amb('month')}-${amb('day')}`,
    jam: `${jam}:${menit}`,                      // HH:MM untuk dibandingkan jam_kirim
  };
}

/** 'HH:MM' — nilai tidak sah dianggap '00:00' supaya jadwal tetap jalan. */
function normJam(s) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(s || '').trim());
  if (!m) return '00:00';
  const jam = Math.min(23, Number(m[1])), menit = Math.min(59, Number(m[2]));
  return `${String(jam).padStart(2, '0')}:${String(menit).padStart(2, '0')}`;
}

/** Bandingkan HH:MM sebagai angka menit (menghindari '9:00' > '10:00'). */
function lewatJam(sekarang, target) {
  const ke = (x) => { const [a, b] = normJam(x).split(':'); return Number(a) * 60 + Number(b); };
  return ke(sekarang) >= ke(target);
}

module.exports = { BULAN, tglIndo, periodeIndo, waktuSiklus, normJam, lewatJam, ZONA };
