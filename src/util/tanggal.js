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

module.exports = { BULAN, tglIndo, periodeIndo };
