'use strict';
// Halaman cetak invoice penjualan barang/jasa (modul Invoice).
// Data: GET /api/invoice/invoice-data?nomor=INV…
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g,
  c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const rupiah = (n) => 'Rp ' + Number(n || 0).toLocaleString('id-ID');
const tglIndo = (s) => {
  if (!s) return '-';
  const b = ['Januari','Februari','Maret','April','Mei','Juni','Juli','Agustus','September','Oktober','November','Desember'];
  const d = new Date(String(s).slice(0, 10));
  if (isNaN(d.getTime())) return String(s).slice(0, 10);
  return `${d.getDate()} ${b[d.getMonth()]} ${d.getFullYear()}`;
};
const badge = (s) => ({ lunas: 'ok', terkirim: 'warn', buat: 'mute', batal: 'mute' }[s] || 'mute');

function terbilang(n) {
  n = Math.round(Number(n) || 0);
  if (n === 0) return 'nol';
  const a = ['', 'satu', 'dua', 'tiga', 'empat', 'lima', 'enam', 'tujuh', 'delapan', 'sembilan', 'sepuluh', 'sebelas'];
  const f = (x) => {
    if (x < 12) return a[x];
    if (x < 20) return f(x - 10) + ' belas';
    if (x < 100) return f(Math.floor(x / 10)) + ' puluh ' + f(x % 10);
    if (x < 200) return 'seratus ' + f(x - 100);
    if (x < 1000) return f(Math.floor(x / 100)) + ' ratus ' + f(x % 100);
    if (x < 2000) return 'seribu ' + f(x - 1000);
    if (x < 1e6) return f(Math.floor(x / 1000)) + ' ribu ' + f(x % 1000);
    if (x < 1e9) return f(Math.floor(x / 1e6)) + ' juta ' + f(x % 1e6);
    return f(Math.floor(x / 1e9)) + ' miliar ' + f(x % 1e9);
  };
  return f(n).replace(/\s+/g, ' ').trim();
}

const qty = (q) => {
  const n = Number(q || 0);
  return Number.isInteger(n) ? String(n) : n.toLocaleString('id-ID');
};

async function muat() {
  const no = new URLSearchParams(location.search).get('no') || '';
  const box = document.getElementById('isi');
  if (!no) { box.innerHTML = '<div class="err">Nomor invoice tidak ada di URL (?no=INV…)</div>'; return; }
  let d;
  try {
    const r = await fetch('/api/invoice/invoice-data?nomor=' + encodeURIComponent(no));
    d = await r.json();
    if (!r.ok) throw new Error((d && d.error) || 'HTTP ' + r.status);
  } catch (e) {
    box.innerHTML = `<div class="err"><b>Gagal memuat invoice.</b><br>${esc(e.message)}<br>
      <span class="note">Bila sesi berakhir, login ulang lalu buka kembali dari menu Invoice.</span></div>`;
    return;
  }
  const inv = d.invoice, srv = d.data_server || {}, item = d.item || [];
  const subtotal = item.reduce((s, i) => s + Number(i.quantity) * Number(i.harga), 0);
  document.title = `Invoice ${inv.nomor} — ${srv.nama_server || 'ivvibill'}`;

  const tujuan = inv.whatsapp_tujuan || inv.wa_pelanggan;
  if (tujuan) {
    const waBtn = document.getElementById('btnWa');
    waBtn.style.display = '';
    waBtn.href = `https://wa.me/${tujuan}?text=${encodeURIComponent(
      'Halo ' + (inv.nama_tujuan || inv.nama_pelanggan || 'Pelanggan') +
      ', invoice ' + inv.nomor + ' sebesar ' + rupiah(subtotal) +
      (inv.jatuh_tempo ? ' dengan jatuh tempo ' + tglIndo(inv.jatuh_tempo) : '') + '.')}`;
  }

  const lunas = inv.status === 'lunas';
  box.innerHTML = `
  <div class="sheet">
    <div class="head">
      <div class="brand">
        ${srv.logo ? `<img src="${esc(srv.logo)}" alt="logo">` : '<div class="mark">iV</div>'}
        <div><h1>${esc(srv.nama_server || 'ivvibill')}</h1>
          <div class="sub">${esc(srv.alamat || '')}${srv.nomor_whatsapp ? '<br>WA: ' + esc(srv.nomor_whatsapp) : ''}${srv.email ? '<br>' + esc(srv.email) : ''}</div>
        </div>
      </div>
      <div class="inv-title">
        <div class="no">INVOICE PENJUALAN</div>
        <div class="sub">${esc(inv.nomor)}</div>
        <div class="st"><span class="badge ${badge(inv.status)}">${esc(inv.status)}</span></div>
      </div>
    </div>

    <div class="bill">
      <div><div class="k">Ditagihkan kepada</div><div class="v">${esc(inv.nama_tujuan || inv.nama_pelanggan || '-')}</div></div>
      <div><div class="k">Kode pelanggan</div><div class="v">${esc(inv.kode_pelanggan || '-')}</div></div>
      <div><div class="k">Alamat</div><div class="v">${esc(inv.alamat_tujuan || inv.alamat_pelanggan || '-')}</div></div>
      <div><div class="k">Nomor WhatsApp</div><div class="v">${esc(tujuan || '-')}</div></div>
      <div><div class="k">Tanggal invoice</div><div class="v">${tglIndo(inv.tanggal)}</div></div>
      <div><div class="k">Jatuh tempo</div><div class="v">${inv.jatuh_tempo ? tglIndo(inv.jatuh_tempo) : '-'}</div></div>
    </div>

    <table>
      <thead><tr>
        <th class="tgl">No</th><th class="tgl">Tanggal</th><th>Uraian</th>
        <th class="num">Qty</th><th class="num">Harga</th><th class="num">Jumlah</th>
      </tr></thead>
      <tbody>
        ${item.length ? item.map((i, idx) => `<tr>
          <td class="tgl">${idx + 1}</td>
          <td class="tgl">${esc(tglIndo(i.tanggal))}</td>
          <td>${esc(i.uraian)}</td>
          <td class="num">${qty(i.quantity)}</td>
          <td class="num">${rupiah(i.harga)}</td>
          <td class="num">${rupiah(Number(i.quantity) * Number(i.harga))}</td>
        </tr>`).join('') : '<tr><td colspan="6">Belum ada uraian barang/jasa.</td></tr>'}
        <tr class="tot"><td colspan="5">TOTAL</td><td class="num">${rupiah(subtotal)}</td></tr>
      </tbody>
    </table>
    <div class="terbilang">Terbilang: ${esc(terbilang(subtotal))} rupiah</div>

    ${inv.catatan ? `<div class="catatan"><b>Catatan:</b> ${esc(inv.catatan)}</div>` : ''}

    ${d.rekening && d.rekening.length ? `
    <div class="rek">
      <h3>Rekening tujuan transfer</h3>
      <table><tbody>
        ${d.rekening.map(r => `<tr><td>${esc(r.bank)}</td><td>${esc(r.no_rek)}</td><td>${esc(r.atas_nama)}</td></tr>`).join('')}
      </tbody></table>
    </div>` : ''}

    <div class="foot">
      <div class="note">Dicetak dari ivvibill — sistem billing ${esc(srv.nama_server || '')}.<br>
        ${lunas ? 'Pembayaran telah kami terima. Terima kasih.' : 'Mohon melakukan pembayaran sebelum jatuh tempo.'}</div>
      <div class="ttd">Hormat kami,<br><b>${esc(srv.nama_server || 'Administrator')}</b>
        <div class="line">${esc(srv.nama_pemilik || 'Administrator')}</div></div>
    </div>
  </div>`;
}
muat();
