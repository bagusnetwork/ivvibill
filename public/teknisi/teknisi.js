/* ivvibill — Karyawan & Teknisi */
'use strict';
const JUDUL = { dashboard: 'Ringkasan', pekerjaan: 'Order Pekerjaan', tiket: 'Tiket Gangguan',
  pelanggan: 'Pelanggan', interface: 'Monitoring Interface', olt: 'Redaman OLT', issue: 'Issue PPPoE' };

async function loadDash() {
  try {
    const d = await API.get('/api/dashboard');
    const r = d.ringkas || {};
    document.getElementById('tkCards').innerHTML = `
      <div class="card green"><div class="label">Pelanggan aktif</div><div class="value">${r.pelanggan_aktif || 0}</div></div>
      <div class="card amber"><div class="label">Isolir</div><div class="value">${r.pelanggan_isolir || 0}</div></div>
      <div class="card red"><div class="label">Issue terbuka</div><div class="value">${r.issue_open || 0}</div></div>
      <div class="card blue"><div class="label">Tiket aktif</div><div class="value">${r.tiket_open || 0}</div></div>`;
    document.getElementById('dashIssue').innerHTML = (d.issue || []).map(i => `
      <tr><td>${esc(i.nama_pelanggan)}</td><td><span class="badge bad">${esc(i.tipe)}</span></td>
      <td>${esc(i.pesan)}</td>
      <td class="t-actions"><button class="btn sm" onclick="selesaiIssue(${i.id})">Selesai</button></td></tr>`).join('')
      || '<tr><td colspan="4" class="empty">Kosong</td></tr>';
  } catch (e) { toast(e.message, true); }
}

async function selesaiIssue(id) {
  try { await API.put(`/api/issue/${id}/selesai`, {}); toast('Diselesaikan'); loadDash(); }
  catch (e) { toast(e.message, true); }
}

// ---------------- pekerjaan
async function loadKerja() {
  try {
    const st = document.getElementById('kStatus').value;
    const d = await API.get(`/api/pekerjaan?status=${st}`);
    const badge = (s) => ({ antrian: 'info', dikerjakan: 'warn', selesai: 'ok', batal: 'mute' }[s] || 'mute');
    document.getElementById('tbKerja').innerHTML = (d.data || []).map(k => `
      <tr><td>${k.id}</td><td>${esc(k.jenis)}</td><td>${esc(k.nama)}</td>
        <td>${esc(k.alamat || '-')}</td><td>${esc(k.nama_teknisi || '-')}</td>
        <td><span class="badge ${badge(k.status)}">${esc(k.status)}</span></td>
        <td class="t-actions">
          ${k.status === 'antrian' ? `<button class="btn sm" onclick="kerja(${k.id},'dikerjakan')">Kerjakan</button> ` : ''}
          ${k.status === 'dikerjakan' ? `<button class="btn sm" onclick="kerja(${k.id},'selesai')">Selesai</button> ` : ''}
          <button class="btn sm secondary" onclick='formKerja(${JSON.stringify(k)})'>Ubah</button>
        </td></tr>`).join('') || '<tr><td colspan="7" class="empty">Belum ada order</td></tr>';
  } catch (e) { toast(e.message, true); }
}
function formKerja(k) {
  document.getElementById('wId').value = k ? k.id : '';
  document.getElementById('wJenis').value = k ? k.jenis : 'pasang';
  document.getElementById('wNama').value = k ? k.nama : '';
  document.getElementById('wAlamat').value = k ? (k.alamat || '') : '';
  document.getElementById('wStatus').value = k ? k.status : 'antrian';
  document.getElementById('wCatatan').value = k ? (k.catatan || '') : '';
  modalOpen('mKerja');
}
async function simpanKerja() {
  const id = document.getElementById('wId').value;
  const body = {
    jenis: document.getElementById('wJenis').value,
    nama: document.getElementById('wNama').value,
    alamat: document.getElementById('wAlamat').value,
    status: document.getElementById('wStatus').value,
    catatan: document.getElementById('wCatatan').value
  };
  try {
    if (id) await API.put(`/api/pekerjaan/${id}`, body);
    else await API.post('/api/pekerjaan', body);
    modalClose('mKerja'); toast('Tersimpan'); loadKerja();
  } catch (e) { toast(e.message, true); }
}
async function kerja(id, status) {
  try { await API.put(`/api/pekerjaan/${id}`, { status }); toast('Diperbarui'); loadKerja(); }
  catch (e) { toast(e.message, true); }
}

// ---------------- tiket
async function loadTiket() {
  try {
    const st = document.getElementById('tStatus').value;
    const d = await API.get(`/api/tiket?status=${st}`);
    const badge = (s) => ({ baru: 'bad', diproses: 'warn', selesai: 'ok', ditutup: 'mute' }[s] || 'mute');
    document.getElementById('tbTiket').innerHTML = (d.data || []).map(t => `
      <tr><td>${t.id}</td><td>${esc(t.nama_pelanggan)}</td><td>${esc(t.judul)}</td>
        <td><span class="badge ${t.prioritas === 'tinggi' ? 'bad' : t.prioritas === 'sedang' ? 'warn' : 'mute'}">${esc(t.prioritas)}</span></td>
        <td><span class="badge ${badge(t.status)}">${esc(t.status)}</span></td>
        <td class="t-actions"><button class="btn sm secondary" onclick='formTiket(${JSON.stringify(t)})'>Proses</button></td>
      </tr>`).join('') || '<tr><td colspan="6" class="empty">Tidak ada tiket</td></tr>';
  } catch (e) { toast(e.message, true); }
}
async function formTiket(t) {
  try {
    const p = await API.get('/api/pelanggan?limit=200');
    document.getElementById('gPel').innerHTML = (p.data || []).map(x =>
      `<option value="${x.id}">${esc(x.nama)}</option>`).join('');
    document.getElementById('gId').value = t ? t.id : '';
    document.getElementById('gJudul').value = t ? t.judul : '';
    document.getElementById('gPesan').value = t ? (t.pesan || '') : '';
    document.getElementById('gPri').value = t ? t.prioritas : 'sedang';
    document.getElementById('gStatus').value = t ? t.status : 'baru';
    document.getElementById('gJawab').value = t ? (t.jawaban || '') : '';
    document.getElementById('gStatusWrap').style.display = t ? '' : 'none';
    document.getElementById('gJawabWrap').style.display = t ? '' : 'none';
    if (t) document.getElementById('gPel').value = t.id_pelanggan;
    modalOpen('mTiket');
  } catch (e) { toast(e.message, true); }
}
async function simpanTiket() {
  const id = document.getElementById('gId').value;
  try {
    if (id) {
      await API.put(`/api/tiket/${id}`, {
        status: document.getElementById('gStatus').value,
        jawaban: document.getElementById('gJawab').value
      });
    } else {
      await API.post('/api/tiket', {
        id_pelanggan: document.getElementById('gPel').value,
        judul: document.getElementById('gJudul').value,
        pesan: document.getElementById('gPesan').value,
        prioritas: document.getElementById('gPri').value
      });
    }
    modalClose('mTiket'); toast('Tersimpan'); loadTiket();
  } catch (e) { toast(e.message, true); }
}

// ---------------- pelanggan
async function loadPelanggan() {
  try {
    const q = encodeURIComponent(document.getElementById('pq').value || '');
    const d = await API.get(`/api/pelanggan?q=${q}&limit=100`);
    document.getElementById('tbPel').innerHTML = (d.data || []).map(p => `
      <tr><td>${esc(p.kode)}</td><td><b>${esc(p.nama)}</b></td>
        <td><span class="badge ${p.tipe === 'pppoe' ? 'info' : 'warn'}">${esc(p.tipe)}</span></td>
        <td>${esc(p.nama_paket || '-')}</td><td>${esc(p.username_pppoe || '-')}</td>
        <td><span class="badge ${p.status === 'aktif' ? 'ok' : p.status === 'isolir' ? 'bad' : 'mute'}">${esc(p.status)}</span></td>
        <td>${p.pppoe_online ? '<span class="badge ok">online</span>' : '<span class="badge mute">offline</span>'}</td>
      </tr>`).join('') || '<tr><td colspan="7" class="empty">Kosong</td></tr>';
  } catch (e) { toast(e.message, true); }
}

// ---------------- monitoring
async function loadInterface() {
  try {
    const d = await API.get('/api/interface');
    document.getElementById('tbIf').innerHTML = (d.data || []).map(r => `
      <tr><td>${esc(r.router)}</td><td><b>${esc(r.iface)}</b></td><td>${esc(r.tipe || '-')}</td>
      <td><span class="badge ${r.status === 'up' ? 'ok' : 'bad'}">${esc(r.status)}</span></td>
      <td class="t-num">${(Number(r.rx_bps) / 1024).toFixed(1)} Kbps</td>
      <td class="t-num">${(Number(r.tx_bps) / 1024).toFixed(1)} Kbps</td></tr>`).join('')
      || '<tr><td colspan="6" class="empty">Belum ada data</td></tr>';
  } catch (e) { toast(e.message, true); }
}

async function loadOlt() {
  try {
    const o = await API.get('/api/olt/onu');
    document.getElementById('tbOnu').innerHTML = (o.data || []).slice(0, 100).map(x => `
      <tr><td>${esc(x.nama_olt)}</td><td>${esc(x.pon || '-')}</td><td>${esc(x.sn || '-')}</td>
      <td>${esc(x.nama_onu || x.nama_pelanggan || '-')}</td>
      <td class="t-num">${x.rx_dbm != null ? esc(x.rx_dbm) : '-'}</td>
      <td class="t-num">${x.redaman_db != null ? esc(x.redaman_db) + ' dB' : '-'}</td>
      <td><span class="badge ${x.status_online ? 'ok' : 'mute'}">${x.status_online ? 'online' : 'off'}</span></td></tr>`).join('')
      || '<tr><td colspan="7" class="empty">Belum ada data ONU</td></tr>';
  } catch (e) { toast(e.message, true); }
}

async function loadIssue() {
  try {
    const d = await API.get('/api/issue');
    document.getElementById('tbIssue').innerHTML = (d.data || []).map(i => `
      <tr><td>${esc(i.nama_pelanggan)}</td><td>${esc(i.username_pppoe || '-')}</td>
      <td><span class="badge bad">${esc(i.tipe)}</span></td><td>${esc(i.pesan)}</td>
      <td class="t-actions"><button class="btn sm" onclick="selesaiIssue2(${i.id})">Selesai</button></td></tr>`).join('')
      || '<tr><td colspan="5" class="empty">Kosong</td></tr>';
  } catch (e) { toast(e.message, true); }
}
async function selesaiIssue2(id) {
  try { await API.put(`/api/issue/${id}/selesai`, {}); toast('Diselesaikan'); loadIssue(); }
  catch (e) { toast(e.message, true); }
}

document.addEventListener('DOMContentLoaded', async () => {
  try { await requireLogin(['teknisi']); } catch (_) { return; }
  document.querySelectorAll('.nav a[data-page]').forEach(a =>
    a.addEventListener('click', (e) => { e.preventDefault(); go(a.dataset.page); }));
  const origGo = window.go;
  window.go = (p) => { origGo(p); document.getElementById('judul').textContent = JUDUL[p] || p; };
  window.go(location.hash.replace('#', '') || 'dashboard');
});
