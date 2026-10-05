/* ivvibill — Dashboard Pelanggan PPPoE */
'use strict';
const JUDUL = { dashboard: 'Beranda', tagihan: 'Tagihan & Bayar',
  koneksi: 'Status Koneksi', tiket: 'Tiket Gangguan' };
let PROFIL = null, TAGIHAN = [];

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
    TAGIHAN = d.data || [];
    const badge = (s) => ({ buat: 'info', terkirim: 'info', menunggu: 'warn', lunas: 'ok', jatuh_tempo: 'bad', batal: 'mute' }[s] || 'mute');
    document.getElementById('tbTagihan').innerHTML = TAGIHAN.map(t => `
      <tr><td><b>${esc(t.nomor_invoice)}</b></td><td>${esc(t.periode)}</td>
        <td>${esc(t.keterangan || '-')}</td>
        <td class="t-num">${rupiah(t.total)}</td><td>${tgl(t.jatuh_tempo)}</td>
        <td><span class="badge ${badge(t.status)}">${esc(t.status)}</span></td>
        <td class="t-actions">${t.status !== 'lunas' && t.status !== 'batal'
          ? `<button class="btn sm" onclick="formBayar(${t.id})">Bayar</button>` : '-'}</td></tr>`).join('')
      || '<tr><td colspan="7" class="empty">Belum ada tagihan</td></tr>';

    document.getElementById('tbRek').innerHTML = (rk.data || []).map(r => `
      <tr><td>${esc(r.bank)}</td><td>${esc(r.no_rek)}</td><td>${esc(r.atas_nama)}</td></tr>`).join('')
      || '<tr><td colspan="3" class="empty">Belum ada rekening</td></tr>';
  } catch (e) { toast(e.message, true); }
}

let bayarId = null;
function formBayar(id) {
  const t = TAGIHAN.find(x => x.id === id);
  if (!t) return;
  bayarId = id;
  document.getElementById('byInfo').innerHTML =
    `Invoice <b>${esc(t.nomor_invoice)}</b> — total <b>${rupiah(t.total)}</b>, jatuh tempo ${tgl(t.jatuh_tempo)}.`;
  document.getElementById('byBukti').value = '';
  document.getElementById('byKet').value = '';
  modalOpen('mBayar');
}

async function kirimBayar() {
  try {
    const metode = document.getElementById('byMetode').value;
    if (metode === 'midtrans') {
      const r = await API.post('/api/gateway/midtrans/snap', { tagihan_id: bayarId });
      if (r.redirect_url) { window.open(r.redirect_url, '_blank'); modalClose('mBayar'); return; }
      toast(r.token ? 'Snap token dibuat' : 'Gateway tidak siap', !r.token);
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
  window.go(location.hash.replace('#', '') || 'dashboard');
});
