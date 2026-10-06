/* ivvibill — Agen Hotspot */
'use strict';
const JUDUL = { dashboard: 'Saldo & Ringkasan', beli: 'Beli Voucher', voucher: 'Voucher Saya',
  mutasi: 'Riwayat Mutasi', pelanggan: 'Pelanggan Saya' };
let AGEN = null, PAKET = [];

async function loadDash() {
  try {
    const d = await API.get('/api/dashboard');
    document.getElementById('agCards').innerHTML = `
      <div class="card green"><div class="label">Saldo</div><div class="value">${rupiah(d.saldo)}</div></div>
      <div class="card blue"><div class="label">Pelanggan aktif</div>
        <div class="value">${d.pelanggan ? d.pelanggan.jml : 0}</div></div>
      <div class="card amber"><div class="label">Voucher stok</div>
        <div class="value">${(d.voucher || []).filter(v => v.status === 'stok').reduce((s, v) => s + Number(v.jml), 0)}</div></div>
      <div class="card"><div class="label">Terjual</div>
        <div class="value">${(d.voucher || []).filter(v => v.status === 'terjual').reduce((s, v) => s + Number(v.jml), 0)}</div></div>`;
    const s = await API.get('/api/voucher/stok-ringkas');
    document.getElementById('tbStok').innerHTML = (s.data || []).map(r => `
      <tr><td>${PAKET.find(p => p.id === r.id_paket) ? esc(PAKET.find(p => p.id === r.id_paket).nama_paket) : '#' + r.id_paket}</td>
      <td><span class="badge ${r.status === 'stok' ? 'ok' : 'mute'}">${esc(r.status)}</span></td>
      <td class="t-num">${esc(r.jml)}</td></tr>`).join('')
      || '<tr><td colspan="3" class="empty">Belum ada voucher — beli dulu di menu Beli Voucher</td></tr>';
  } catch (e) { toast(e.message, true); }
}

async function loadBeli() {
  try {
    const d = await API.get('/api/paket');
    PAKET = (d.data || []).filter(p => p.jenis === 'hotspot');
    document.getElementById('bPaket').innerHTML = PAKET.map(p =>
      `<option value="${p.id}">${esc(p.nama_paket)} — ${rupiah(p.harga_agen)}</option>`).join('')
      || '<option value="">Belum ada paket hotspot</option>';
    document.getElementById('tbPaketAg').innerHTML = (d.data || []).filter(p => p.jenis === 'hotspot').map(p => `
      <tr><td>${esc(p.nama_paket)}</td><td class="t-num">${rupiah(p.harga_agen)}</td>
      <td class="t-num">${rupiah(p.harga)}</td><td>${esc(p.masa_aktif)} hari</td></tr>`).join('')
      || '<tr><td colspan="4" class="empty">Belum ada paket hotspot</td></tr>';
  } catch (e) { toast(e.message, true); }
}

async function beliVoucher() {
  try {
    const r = await API.post('/api/voucher/beli', {
      id_paket: document.getElementById('bPaket').value,
      jumlah: document.getElementById('bJml').value
    });
    toast(`Berhasil: ${r.jumlah} voucher · saldo ${rupiah(r.saldo)}`);
    loadDash();
  } catch (e) { toast(e.message, true); }
}

async function loadVoucher() {
  try {
    const q = encodeURIComponent(document.getElementById('vq').value || '');
    const st = document.getElementById('vstatus').value;
    const d = await API.get(`/api/voucher?q=${q}&status=${st}&limit=100`);
    const badge = (s) => ({ stok: 'info', terjual: 'warn', terpakai: 'ok' }[s] || 'mute');
    document.getElementById('tbVoucher').innerHTML = (d.data || []).map(v => `
      <tr><td><b>${esc(v.kode)}</b></td><td>${esc(v.nama_paket || '-')}</td>
        <td class="t-num">${rupiah(v.harga_jual)}</td>
        <td><span class="badge ${badge(v.status)}">${esc(v.status)}</span></td>
        <td class="t-actions">${v.status === 'stok'
          ? `<button class="btn sm" onclick="jualVoucher(${v.id})">Tandai terjual</button>` : '-'}</td></tr>`).join('')
      || '<tr><td colspan="5" class="empty">Belum ada voucher</td></tr>';
  } catch (e) { toast(e.message, true); }
}

async function jualVoucher(id) {
  try { await API.post(`/api/voucher/${id}/jual`, {}); toast('Ditandai terjual'); loadVoucher(); }
  catch (e) { toast(e.message, true); }
}

async function loadMutasi() {
  try {
    const me = await API.get('/api/agen');
    AGEN = (me.data || [])[0] || null;
    if (!AGEN) return;
    const d = await API.get(`/api/agen/${AGEN.id}/mutasi`);
    document.getElementById('tbMutasi').innerHTML = (d.data || []).map(m => `
      <tr><td>${esc(String(m.created_at).slice(0, 16))}</td>
      <td><span class="badge ${m.tipe === 'topup' ? 'ok' : 'warn'}">${esc(m.tipe)}</span></td>
      <td class="t-num">${rupiah(m.jumlah)}</td><td class="t-num">${rupiah(m.saldo_sisa)}</td>
      <td>${esc(m.keterangan || '')}</td></tr>`).join('')
      || '<tr><td colspan="5" class="empty">Belum ada mutasi</td></tr>';
  } catch (e) { toast(e.message, true); }
}

async function loadPelanggan() {
  try {
    const d = await API.get('/api/pelanggan?limit=100');
    document.getElementById('tbPel').innerHTML = (d.data || []).map(p => `
      <tr><td>${esc(p.nama)}</td><td>${esc(p.nomor_whatsapp || '-')}</td>
      <td>${esc(p.nama_paket || '-')}</td>
      <td><span class="badge ${p.status === 'aktif' ? 'ok' : 'mute'}">${esc(p.status)}</span></td></tr>`).join('')
      || '<tr><td colspan="4" class="empty">Belum ada pelanggan</td></tr>';
  } catch (e) { toast(e.message, true); }
}

document.addEventListener('DOMContentLoaded', async () => {
  try { await requireLogin(['agen']); } catch (_) { return; }
  document.querySelectorAll('.nav a[data-page]').forEach(a =>
    a.addEventListener('click', (e) => { e.preventDefault(); go(a.dataset.page); }));
  const origGo = window.go;
  window.go = (p) => { origGo(p); document.getElementById('judul').textContent = JUDUL[p] || p; };
  loadBeli();
  window.go(halamanAwal());
});
