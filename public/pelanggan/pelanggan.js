/* ivvibill — Dashboard Pelanggan PPPoE */
'use strict';
const JUDUL = { dashboard: 'Beranda', tagihan: 'Tagihan & Bayar',
  koneksi: 'Status Koneksi', tiket: 'Tiket Gangguan' };
let PROFIL = null, TAGIHAN = [];
/* Metode bayar yang benar-benar aktif di ISP ini. Dulu pilihan Midtrans selalu
   muncul walaupun tenant-nya gateway 'manual' — pelanggan menekan Bayar lalu
   menerima "Midtrans belum diaktifkan". Nilainya ditanyakan ke backend. */
let METODE = { manual: true, midtrans: false, flip: false, treepay: false };

async function loadDash() {
  try {
    const d = await API.get('/api/dashboard');
    const p = d.profil;
    PROFIL = p;
    const status = d.status || {};
    document.getElementById('plCards').innerHTML = `
      <div class="card ${p && p.status === 'aktif' ? 'green' : 'red'}">
        <div class="label">Status layanan</div>
        <div class="value" style="font-size:20px">${p ? esc(p.status).toUpperCase() : '-'}</div>
        <div class="sub">${p ? esc(p.tipe) : ''}</div></div>
      <div class="card ${status.online ? 'green' : ''}">
        <div class="label">Koneksi</div>
        <div class="value" style="font-size:20px">${status.online ? 'ONLINE' : 'OFFLINE'}</div>
        <div class="sub">${status.last_seen ? 'terakhir ' + esc(String(status.last_seen).slice(0, 16)) : ''}</div></div>
      <div class="card blue"><div class="label">Paket</div>
        <div class="value" style="font-size:19px">${p ? esc(PROFIL.nama_paket || '-') : '-'}</div>
        <div class="sub">${p && p.harga ? rupiah(p.harga) + '/bln' : ''}</div></div>
      <div class="card amber"><div class="label">Tagihan belum bayar</div>
        <div class="value" style="font-size:20px">${rupiah((d.tagihan || []).filter(t => t.status !== 'lunas' && t.status !== 'batal').reduce((s, t) => s + Number(t.total), 0))}</div>
        <div class="sub">${(d.tagihan || []).filter(t => t.status !== 'lunas').length} tagihan</div></div>`;

    const badge = (s) => ({ buat: 'info', terkirim: 'info', menunggu: 'warn', lunas: 'ok', jatuh_tempo: 'bad', batal: 'mute' }[s] || 'mute');
    document.getElementById('dashTagihan').innerHTML = (d.tagihan || []).map(t => `
      <tr><td>${esc(t.nomor_invoice)}</td><td>${esc(t.periode)}</td>
      <td class="t-num">${rupiah(t.total)}</td><td>${tgl(t.jatuh_tempo)}</td>
      <td><span class="badge ${badge(t.status)}">${esc(t.status)}</span></td></tr>`).join('')
      || '<tr><td colspan="5" class="empty">Belum ada tagihan</td></tr>';

    document.getElementById('profilBox').innerHTML = p ? `
      <div class="form-grid">
        <div><div class="hint">Nama</div><b>${esc(p.nama)}</b></div>
        <div><div class="hint">Kode pelanggan</div><b>${esc(p.kode || '-')}</b></div>
        <div><div class="hint">Username PPPoE</div><b>${esc(p.username_pppoe || '-')}</b></div>
        <div><div class="hint">Password PPPoE</div><b>${esc(p.password_pppoe || '-')}</b></div>
        <div><div class="hint">WhatsApp</div><b>${esc(p.nomor_whatsapp || '-')}</b></div>
        <div><div class="hint">Alamat</div><b>${esc(p.alamat || '-')}</b></div>
        <div><div class="hint">Tanggal masuk</div><b>${tgl(p.tanggal_masuk)}</b></div>
        <div><div class="hint">Jatuh tempo bulanan</div><b>tgl ${esc(p.hari_tagihan)}</b></div>
      </div>` : 'Data tidak ditemukan';
  } catch (e) { toast(e.message, true); }
}

async function loadTagihan() {
  try {
    const [d, rk] = await Promise.all([API.get('/api/tagihan?limit=100'), API.get('/api/rekening')]);
    await muatMetode();
    TAGIHAN = d.data || [];
    const badge = (s) => ({ buat: 'info', terkirim: 'info', menunggu: 'warn', lunas: 'ok', jatuh_tempo: 'bad', batal: 'mute' }[s] || 'mute');
    document.getElementById('tbTagihan').innerHTML = TAGIHAN.map(t => `
      <tr><td><b>${esc(t.nomor_invoice)}</b></td><td>${esc(t.periode)}</td>
        <td>${esc(t.keterangan || '-')}</td>
        <td class="t-num">${rupiah(t.total)}</td><td>${tgl(t.jatuh_tempo)}</td>
        <td><span class="badge ${badge(t.status)}">${esc(t.status)}</span>
          ${t.status === 'menunggu'
            ? `<div class="hint">${t.ref_gateway ? 'menunggu pembayaran di gateway' : 'menunggu verifikasi admin'}</div>` : ''}</td>
        <td class="t-actions">${t.status !== 'lunas' && t.status !== 'batal'
          ? `<button class="btn sm" onclick="formBayar(${t.id})">Bayar</button>` : '-'}</td></tr>`).join('')
      || '<tr><td colspan="7" class="empty">Belum ada tagihan</td></tr>';

    document.getElementById('tbRek').innerHTML = (rk.data || []).map(r => `
      <tr><td>${esc(r.bank)}</td><td>${esc(r.no_rek)}</td><td>${esc(r.atas_nama)}</td></tr>`).join('')
      || '<tr><td colspan="3" class="empty">Belum ada rekening</td></tr>';
  } catch (e) { toast(e.message, true); }
}

/** Tanya metode apa yang diizinkan ISP ini; gagal tanya = manual saja. */
async function muatMetode() {
  try { const m = await API.get('/api/gateway/metode');
    METODE = { manual: true, midtrans: !!m.midtrans, flip: !!m.flip, treepay: !!m.treepay }; }
  catch (_) { METODE = { manual: true, midtrans: false, flip: false, treepay: false }; }
  return METODE;
}

let bayarId = null;
// true setelah satu QRIS TriPay berhasil dibuat untuk invoice ini — mencegah
// klik kedua diam-diam membuat transaksi kedua.
let qrisSiap = false;
function formBayar(id) {
  const t = TAGIHAN.find(x => x.id === id);
  if (!t) return;
  bayarId = id;
  const sel = document.getElementById('byMetode');
  qrisSiap = false;
  // Hanya tawarkan yang benar-benar aktif di tenant ini.
  Array.from(sel.options).forEach(o => {
    const boleh = METODE[o.value] !== false;
    o.hidden = !boleh; o.disabled = !boleh;
  });
  sel.value = 'manual';
  const bukti = document.getElementById('byBuktiWrap');
  // Bukti transfer hanya relevan untuk metode manual; gateway (Midtrans/TriPay)
  // mencatat pelunasannya sendiri lewat notifikasi.
  const aturBukti = () => {
    if (bukti) bukti.style.display = sel.value === 'manual' ? '' : 'none';
    // Setelah QRIS tampil, tombol jadi 'Tutup' — kembali ke manual/gateway lain
    // harus mengembalikan labelnya supaya tidak mengira tinggal menutup.
    const k = document.getElementById('byKirim');
    if (k && qrisSiap && sel.value === 'treepay') k.textContent = 'Tutup';
    else if (k) k.textContent = 'Kirim pembayaran';
  };
  sel.onchange = aturBukti;
  aturBukti();
  // Panel QRIS disembunyikan sampai transaksi TriPay benar-benar dibuat.
  const qw = document.getElementById('byQrisWrap');
  if (qw) qw.style.display = 'none';
  const qbox = document.getElementById('byQris');
  if (qbox) qbox.innerHTML = '';
  const kirim = document.getElementById('byKirim');
  if (kirim) kirim.textContent = 'Kirim pembayaran';
  let catatan = '';
  if (METODE.midtrans) {
    catatan += '<div class="hint">Pilih <b>Payment gateway (Midtrans)</b> untuk bayar langsung di halaman Midtrans '
      + '(VA bank / QRIS / e-wallet); tagihan berubah menjadi <b>lunas</b> otomatis begitu uangnya masuk.</div>';
  }
  if (METODE.treepay) {
    catatan += '<div class="hint">Pilih <b>QRIS (TriPay)</b>, pindai QR-nya dengan aplikasi apa pun yang mendukung '
      + 'QRIS (GoPay, OVO, DANA, ShopeePay, m-banking); tagihan berubah menjadi <b>lunas</b> otomatis begitu uangnya masuk.</div>';
  }
  document.getElementById('byInfo').innerHTML =
    `Invoice <b>${esc(t.nomor_invoice)}</b> — total <b>${rupiah(t.total)}</b>, jatuh tempo ${tgl(t.jatuh_tempo)}.` + catatan;
  document.getElementById('byBukti').value = '';
  document.getElementById('byKet').value = '';
  modalOpen('mBayar');
}

/**
 * Tampilkan QRIS hasil TriPay. `qr_string` adalah payload QR mentah (EMVCo) —
 * dirender menjadi gambar QR oleh api.qrserver.com supaya bisa dipindai langsung
 * di halaman ini; `checkout_url` selalu ikut ditawarkan sebagai cadangan bila
 * gambar gagal dimuat atau pelanggan lebih suka halaman bayar TriPay.
 */
function tampilQris(r) {
  qrisSiap = true;
  const box = document.getElementById('byQris');
  if (!box) return;
  const bagian = [];
  if (r.qr_string) {
    const src = 'https://api.qrserver.com/v1/create-qr-code/?size=260x260&margin=8&data='
      + encodeURIComponent(r.qr_string);
    bagian.push(`<div style="text-align:center;padding:8px 0">
        <img src="${esc(src)}" alt="QRIS" width="260" height="260"
          style="max-width:100%;image-rendering:pixelated">
        <div class="hint" style="word-break:break-all;margin-top:6px">${esc(r.qr_string).slice(0, 120)}…</div>
      </div>`);
  }
  if (r.checkout_url) {
    bagian.push(`<div class="form-row"><a class="btn" href="${esc(r.checkout_url)}" target="_blank" rel="noopener">Buka halaman bayar TriPay</a></div>`);
  }
  if (r.expired_time) {
    const s = String(r.expired_time);
    const iso = /^\d+$/.test(s) ? new Date(Number(s) * 1000) : new Date(s.includes('T') ? s : s.replace(' ', 'T'));
    const umur = Math.round((Number(iso) - Date.now()) / 60000);
    if (Number.isFinite(umur)) bagian.push(`<div class="hint">Berlaku sampai ${esc(s)} (${umur} menit dari sekarang).</div>`);
  }
  if (!bagian.length) bagian.push('<div class="hint">Transaksi dibuat, tapi TriPay tidak mengirim QR. Hubungi ISP Anda.</div>');
  box.innerHTML = bagian.join('');
  const wrap = document.getElementById('byQrisWrap');
  if (wrap) wrap.style.display = '';
}

async function kirimBayar() {
  try {
    const metode = document.getElementById('byMetode').value;
    if (metode === 'midtrans') {
      const r = await API.post('/api/gateway/midtrans/snap', { tagihan_id: bayarId });
      if (r.redirect_url) {
        window.open(r.redirect_url, '_blank');
        modalClose('mBayar');
        toast('Halaman bayar Midtrans dibuka — setelah selesai, kembali ke sini dan daftar tagihan diperbarui');
        setTimeout(loadTagihan, 10000);
        return;
      }
      toast('Gateway tidak memberikan tautan bayar — hubungi ISP Anda', true);
      return;
    }
    if (metode === 'treepay') {
      if (qrisSiap) { modalClose('mBayar'); loadTagihan(); return; }
      const r = await API.post('/api/gateway/tripay/charge', { tagihan_id: bayarId });
      tampilQris(r);
      const kirim = document.getElementById('byKirim');
      if (kirim) kirim.textContent = 'Tutup';
      toast('QRIS siap dipindai — tagihan jadi lunas otomatis setelah bayar');
      setTimeout(loadTagihan, 20000);
      return;
    }
    const fd = new FormData();
    fd.append('keterangan', document.getElementById('byKet').value);
    const f = document.getElementById('byBukti').files[0];
    if (f) fd.append('bukti', f);
    const r = await API.post(`/api/tagihan/${bayarId}/bayar`, fd, true);
    modalClose('mBayar');
    toast(r.status === 'lunas' ? 'Lunas 🎉' : 'Bukti terkirim — menunggu verifikasi admin');
    loadTagihan();
  } catch (e) { toast(e.message, true); }
}

async function loadKoneksi() {
  try {
    const d = await API.get('/api/dashboard');
    const p = d.profil, st = d.status || {};
    document.getElementById('knCards').innerHTML = `
      <div class="card ${st.online ? 'green' : 'red'}"><div class="label">Status PPPoE</div>
        <div class="value">${st.online ? 'ONLINE' : 'OFFLINE'}</div>
        <div class="sub">${st.uptime ? 'uptime ' + esc(st.uptime) : ''}</div></div>
      <div class="card blue"><div class="label">IP address</div>
        <div class="value" style="font-size:19px">${esc(st.ip_address || '-')}</div></div>
      <div class="card"><div class="label">Terakhir terlihat</div>
        <div class="value" style="font-size:17px">${st.last_seen ? esc(String(st.last_seen).slice(0, 16)) : '-'}</div></div>
      <div class="card amber"><div class="label">Status layanan</div>
        <div class="value" style="font-size:19px">${p ? esc(p.status) : '-'}</div></div>`;

    const t = await API.get('/api/tagihan?limit=50');
    const rows = (t.data || []).filter(x => x.status === 'lunas').slice(0, 10);
    document.getElementById('tbRiwayat').innerHTML = rows.length ? rows.map(x => `
      <tr><td>${esc(x.nomor_invoice)}</td><td class="t-num">${rupiah(x.total)}</td>
        <td>${esc(x.metode_bayar || '-')}</td>
        <td><span class="badge ok">lunas</span></td>
        <td>${x.paid_at ? esc(String(x.paid_at).slice(0, 16)) : '-'}</td></tr>`).join('')
      : '<tr><td colspan="5" class="empty">Belum ada pembayaran lunas</td></tr>';
  } catch (e) { toast(e.message, true); }
}

async function loadTiket() {
  try {
    const d = await API.get('/api/tiket');
    const badge = (s) => ({ baru: 'bad', diproses: 'warn', selesai: 'ok', ditutup: 'mute' }[s] || 'mute');
    document.getElementById('tbTiket').innerHTML = (d.data || []).map(t => `
      <tr><td>${t.id}</td><td><b>${esc(t.judul)}</b></td><td>${esc((t.pesan || '').slice(0, 60))}</td>
        <td><span class="badge ${badge(t.status)}">${esc(t.status)}</span></td>
        <td class="hint">${esc((t.jawaban || '').slice(0, 80) || '-')}</td></tr>`).join('')
      || '<tr><td colspan="5" class="empty">Belum ada tiket</td></tr>';
  } catch (e) { toast(e.message, true); }
}

function formTiket() {
  document.getElementById('gJudul').value = '';
  document.getElementById('gPesan').value = '';
  modalOpen('mTiket');
}
async function kirimTiket() {
  try {
    await API.post('/api/tiket', {
      judul: document.getElementById('gJudul').value,
      pesan: document.getElementById('gPesan').value,
      prioritas: document.getElementById('gPri').value
    });
    modalClose('mTiket'); toast('Tiket terkirim'); loadTiket();
  } catch (e) { toast(e.message, true); }
}

document.addEventListener('DOMContentLoaded', async () => {
  try { await requireLogin(['pelanggan']); } catch (_) { return; }
  document.querySelectorAll('.nav a[data-page]').forEach(a =>
    a.addEventListener('click', (e) => { e.preventDefault(); go(a.dataset.page); }));
  const origGo = window.go;
  window.go = (p) => { origGo(p); document.getElementById('judul').textContent = JUDUL[p] || p; };
  window.go(halamanAwal());
});
