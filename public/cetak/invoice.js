'use strict';
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
const badge = (s) => ({ lunas: 'ok', terkirim: 'warn', menunggu: 'warn', buat: 'mute', jatuh_tempo: 'bad', batal: 'mute' }[s] || 'mute');

// angka → huruf (terbilang), maksimal miliaran
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

async function muat() {
  const no = new URLSearchParams(location.search).get('no') || '';
  const box = document.getElementById('isi');
  if (!no) { box.innerHTML = '<div class="err">Nomor invoice tidak ada di URL (?no=INV…)</div>'; return; }
  let d;
  try {
    const r = await fetch('/api/tagihan/invoice-data?nomor=' + encodeURIComponent(no));
    d = await r.json();
    if (!r.ok) throw new Error((d && d.error) || 'HTTP ' + r.status);
  } catch (e) {
    box.innerHTML = `<div class="err"><b>Gagal memuat invoice.</b><br>${esc(e.message)}<br>
      <span class="note">Bila sesi berakhir, login ulang lalu buka kembali dari menu Tagihan.</span></div>`;
    return;
  }
  const t = d.tagihan, srv = d.data_server || {};
  document.title = `Invoice ${t.nomor_invoice} — ${srv.nama_server || 'ivvibill'}`;
  const waBtn = document.getElementById('btnWa');
  if (t.wa_pelanggan) {
    waBtn.style.display = '';
    waBtn.href = `https://wa.me/${t.wa_pelanggan}?text=${encodeURIComponent('Halo ' + t.nama_pelanggan + ', tagihan invoice ' + t.nomor_invoice + ' sebesar ' + rupiah(t.total) + ' dengan jatuh tempo ' + tglIndo(t.jatuh_tempo) + '.')}`;
  }
  const lunas = t.status === 'lunas';
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
        <div class="no">INVOICE</div>
        <div class="sub">${esc(t.nomor_invoice)}</div>
        <div class="st"><span class="badge ${badge(t.status)}">${esc(t.status)}</span></div>
      </div>
    </div>

    <div class="grid">
      <div><div class="k">Pelanggan</div><div class="v">${esc(t.nama_pelanggan)}</div></div>
      <div><div class="k">Kode pelanggan</div><div class="v">${esc(t.kode_pelanggan || '-')}</div></div>
      <div><div class="k">Alamat</div><div class="v">${esc(t.alamat_pelanggan || '-')}</div></div>
      <div><div class="k">Paket layanan</div><div class="v">${esc(t.nama_paket || '-')}${t.username_pppoe ? ' · ' + esc(t.username_pppoe) : ''}</div></div>
      <div><div class="k">Tanggal invoice</div><div class="v">${tglIndo(t.tanggal_buat)}</div></div>
      <div><div class="k">Jatuh tempo</div><div class="v">${tglIndo(t.jatuh_tempo)}</div></div>
      <div><div class="k">Periode tagihan</div><div class="v">${esc(t.periode || '-')}</div></div>
      <div><div class="k">Metode bayar</div><div class="v">${esc(t.metode_bayar || '-')}${lunas && t.paid_at ? ' · ' + esc(String(t.paid_at).slice(0, 16)) : ''}</div></div>
    </div>

    <table>
      <thead><tr><th>Uraian</th><th class="num">Jumlah</th></tr></thead>
      <tbody>
        <tr><td>Tagihan layanan ${esc(t.nama_paket || 'internet')} periode ${esc(t.periode || '-')}${t.keterangan ? ' — ' + esc(t.keterangan) : ''}</td>
          <td class="num">${rupiah(t.jumlah)}</td></tr>
        ${Number(t.kode_unik) ? `<tr><td>Kode unik</td><td class="num">${rupiah(t.kode_unik)}</td></tr>` : ''}
        ${Number(t.ppn) ? `<tr><td>PPN</td><td class="num">${rupiah(t.ppn)}</td></tr>` : ''}
        <tr class="total-row"><td>TOTAL ${lunas ? '(LUNAS)' : ''}</td><td class="num">${rupiah(t.total)}</td></tr>
      </tbody>
    </table>
    <div class="terbilang">Terbilang: ${esc(terbilang(t.total))} rupiah</div>

    ${d.rekening && d.rekening.length ? `
    <div class="rek">
      <h3>Rekening tujuan transfer</h3>
      <table><tbody>
        ${d.rekening.map(r => `<tr><td>${esc(r.bank)}</td><td>${esc(r.no_rek)}</td><td>${esc(r.atas_nama)}</td></tr>`).join('')}
      </tbody></table>
    </div>` : ''}

    ${d.pembayaran && d.pembayaran.length ? `
    <div class="rek riwayat">
      <h3>Riwayat pembayaran diterima</h3>
      <table><tbody>
        ${d.pembayaran.map(b => `<tr><td>${esc(String(b.created_at).slice(0, 10))}</td><td>${esc(b.metode)}</td><td class="num">${rupiah(b.jumlah)}</td></tr>`).join('')}
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
