/* ivvibill — Panel Data Server (superadmin) */
'use strict';

const JUDUL = {
  dashboard: 'Dashboard', pelanggan: 'Pelanggan', tagihan: 'Tagihan',
  invoice: 'Invoice Penjualan',
  pembayaran: 'Pembayaran', paket: 'Paket Layanan', voucher: 'Voucher',
  agen: 'Agen Hotspot', interface: 'Monitoring Interface', olt: 'Redaman OLT',
  issue: 'Issue PPPoE', perangkat: 'Perangkat', pengguna: 'Pengguna & Audit',
  wa: 'WhatsApp Gateway', setting: 'Pengaturan',
  tenant: 'Data Server (ISP)', group: 'Group Akses',
  topologi: 'Master Topologi (ODP)', desa: 'Master Desa',
  noc: 'NOC — Ping Test Internet', keuangan: 'Keuangan (Kas)', tiket: 'Tiket Gangguan',
  peta: 'Peta Sebaran'
};

const LABEL_MENU = {
  dashboard: 'Dashboard', pelanggan: 'Pelanggan', tagihan: 'Tagihan',
  invoice: 'Invoice Penjualan',
  pembayaran: 'Pembayaran', paket: 'Paket', voucher: 'Voucher', agen: 'Agen',
  interface: 'Interface', olt: 'Redaman OLT', issue: 'Issue', perangkat: 'Perangkat',
  pengguna: 'Pengguna', wa: 'WhatsApp', setting: 'Pengaturan',
  data_server: 'Data Server', group_akses: 'Group Akses',
  topologi: 'Topologi', desa: 'Desa', noc: 'NOC', keuangan: 'Keuangan', tiket: 'Tiket',
  peta: 'Peta Sebaran'
};

/** Hanya pemilik platform (superadmin) yang boleh memindah grup/pengguna antar tenant. */
function bolehTenantLain() {
  const s = sesi();
  return !!(s && s.tenantSemua);
}

let PAKET_LIST = [], AGEN_LIST = [], TOPO_LIST = [], DESA_LIST = [];
let GRAFIK = null;
let PLG_ROWS = [], PLG_TOTAL = 0, PLG_OFFSET = 0, PLG_TAB = '', PLG_WAKTU = null;
const PLG_LIMIT = 50;

// ============================================================ DASHBOARD
async function loadDashboard() {
  try {
    const d = await API.get('/api/dashboard');
    const r = d.ringkas || {};
    const t = d.tenant || {};

    const peringatan = [];
    if (t.expaired_date) {
      const sisa = Math.ceil((new Date(t.expaired_date) - new Date()) / 86400000);
      if (sisa < 0) peringatan.push(`<div class="peringatan bad">Masa aktif ${esc(t.nama_server || 'data server')} habis ${esc(tgl(t.expaired_date))} — perpanjang sebelum tagihan terhenti.</div>`);
      else if (sisa <= 30) peringatan.push(`<div class="peringatan">Masa aktif ${esc(t.nama_server || 'data server')} tinggal ${sisa} hari (${esc(tgl(t.expaired_date))}).</div>`);
    }
    if (Number(r.pppoe_offline) > 0) peringatan.push(`<div class="peringatan">${r.pppoe_offline} pelanggan aktif sedang tidak terhubung ke router.</div>`);
    document.getElementById('dashPeringatan').innerHTML = peringatan.join('');

    const kartu = [
      ['Pelanggan aktif', r.pelanggan_aktif || 0, `PPPoE ${r.pppoe_aktif || 0} · Hotspot ${r.hotspot_aktif || 0}`, 'green'],
      ['Offline di router', r.pppoe_offline || 0, 'aktif tapi tidak terhubung', 'amber'],
      ['Pemasukan bulan ini', rupiah(r.pemasukan), `${r.lunas_bulan_ini || 0} tagihan lunas · ${rupiah(r.pemasukan_bulan_lalu)} bulan lalu`, 'blue'],
      ['Pemasukan tahun ini', rupiah(r.pemasukan_tahun), 'akumulasi pembayaran', 'blue'],
      ['Belum lunas', rupiah(r.belum_lunas), `${r.jatuh_tempo || 0} lewat tempo`, 'amber'],
      ['Isolir', r.pelanggan_isolir || 0, 'putus karena tunggakan', 'red'],
      ['Register', r.pelanggan_baru || 0, 'belum diaktifkan', ''],
      ['Tidak aktif', r.pelanggan_nonaktif || 0, 'pelanggan nonaktif', ''],
      ['Pasang baru', r.pasang_baru_bulan || 0, `${r.pasang_baru_tahun || 0} sepanjang tahun`, 'green'],
      ['Order pekerjaan', r.order_antrian || 0, `${r.order_dikerjakan || 0} dikerjakan · ${r.order_selesai_bulan || 0} selesai bulan ini`, 'blue'],
      ['Issue terbuka', r.issue_open || 0, `${r.tiket_open || 0} tiket`, 'red'],
      ['Voucher stok', r.voucher_stok || 0, `${r.voucher_terjual_bulan || 0} terjual bulan ini`, '']
    ];
    document.getElementById('dashCards').innerHTML = kartu.map(k => `
      <div class="card ${k[3]}"><div class="label">${k[0]}</div><div class="value">${k[1]}</div>
      <div class="sub">${k[2]}</div></div>`).join('');

    await muatGrafik();

    document.getElementById('dashOlt').innerHTML = (d.olt || []).length ? d.olt.map(o => `
      <tr><td>${esc(o.nama)}</td><td>${esc(o.brand).toUpperCase()}</td>
      <td>${esc(o.last_check_at || '-')}</td>
      <td>${o.last_check_msg ? `<span class="badge ${/kritis|error|gagal/i.test(o.last_check_msg) ? 'bad' : 'ok'}">${esc(o.last_check_msg)}</span>` : '<span class="badge mute">belum</span>'}</td></tr>`).join('')
      : '<tr><td colspan="4" class="empty">Belum ada OLT — tambah di menu Perangkat</td></tr>';

    document.getElementById('dashRouter').innerHTML = (d.router || []).length ? d.router.map(o => `
      <tr><td>${esc(o.nama)}</td><td>${esc(o.cpu_load || '-')}${o.cpu_load ? '%' : ''}</td>
      <td>${esc(o.memory_usage || '-')}</td>
      <td><span class="badge ${o.status === 'active' ? 'ok' : 'bad'}">${esc(o.status || '-')}</span></td></tr>`).join('')
      : '<tr><td colspan="4" class="empty">Belum ada router</td></tr>';

    document.getElementById('dashIssue').innerHTML = (d.issue || []).length ? d.issue.map(o => `
      <tr><td>${esc(o.nama_pelanggan)}</td>
      <td><span class="badge bad">${esc(o.tipe)}</span></td>
      <td>${esc(o.pesan)}</td><td>${esc(String(o.created_at).slice(0, 16))}</td></tr>`).join('')
      : '<tr><td colspan="4" class="empty">Tidak ada issue</td></tr>';
  } catch (e) { toast(e.message, true); }
}

/** Deret batang pemasukan vs piutang untuk satu tahun. */
async function muatGrafik() {
  try {
    const sel = document.getElementById('dashTahun');
    const k = await API.get(`/api/dashboard/keuangan?tahun=${sel.value || new Date().getFullYear()}`);
    if (!sel.options.length) {
      sel.innerHTML = (k.tahun_tersedia || [k.tahun]).map(y => `<option value="${y}">${y}</option>`).join('');
    }
    sel.value = k.tahun;
    const jumlah = (a) => (a || []).reduce((x, y) => x + Number(y || 0), 0);
    const hint = document.getElementById('dashChartHint');
    if (!window.Chart) {
      hint.textContent = `${k.tahun}: pemasukan ${rupiah(jumlah(k.pemasukan))} · piutang ${rupiah(jumlah(k.piutang))} (grafik butuh chart.js)`;
      return;
    }
    if (GRAFIK) GRAFIK.destroy();
    GRAFIK = new Chart(document.getElementById('dashChart'), {
      type: 'bar',
      data: {
        labels: ['Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 'Jul', 'Agu', 'Sep', 'Okt', 'Nov', 'Des'],
        datasets: [
          { label: 'Pemasukan (lunas)', data: k.pemasukan, backgroundColor: '#2f6fed' },
          { label: 'Piutang (belum lunas)', data: k.piutang, backgroundColor: '#d9a441' }
        ]
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: { legend: { labels: { color: '#dfe6f1' } } },
        scales: {
          x: { ticks: { color: '#9fb0c8' }, grid: { color: 'rgba(255,255,255,.06)' } },
          y: { ticks: { color: '#9fb0c8' }, grid: { color: 'rgba(255,255,255,.06)' } }
        }
      }
    });
    hint.textContent = `${k.tahun}: ${jumlah(k.tagihan_lunas)} tagihan lunas · ${jumlah(k.pasang_baru)} pasang baru · piutang ${rupiah(jumlah(k.piutang))}`;
  } catch (e) { toast(e.message, true); }
}

// ============================================================ PELANGGAN
async function loadPelanggan() {
  try {
    const q = encodeURIComponent(document.getElementById('pq').value || '');
    const tp = document.getElementById('ptipe').value;
    const d = await API.get(
      `/api/pelanggan?q=${q}&status=${PLG_TAB}&tipe=${tp}&limit=${PLG_LIMIT}&offset=${PLG_OFFSET}`);
    PLG_ROWS = d.data || [];
    PLG_TOTAL = Number(d.total || 0);
    const badgeRedaman = (s) => ({ ok: 'ok', warning: 'warn', kritis: 'bad' }[s] || 'mute');
    const koor = (p) => {
      const lat = p.latitude, long = p.longitude;
      if (lat && long) return `<a href="https://google.com/maps/?q=${esc(lat)},${esc(long)}" target="_blank" rel="noopener" title="${esc(lat)}, ${esc(long)}">📍 koordinat</a>`;
      if (p.titik_koordinat) return `<a href="https://google.com/maps/?q=${encodeURIComponent(p.titik_koordinat)}" target="_blank" rel="noopener" title="${esc(p.titik_koordinat)}">📍 ODP</a>`;
      return '<span class="hint">-</span>';
    };
    document.getElementById('tbPelanggan').innerHTML = PLG_ROWS.map(p => `
      <tr>
        <td><input type="checkbox" class="plgSel" value="${p.id}" onchange="plgPilihBaris()"></td>
        <td>${esc(p.kode)}</td>
        <td><b>${esc(p.nama)}</b><div class="hint">${koor(p)}</div></td>
        <td><span class="badge ${p.tipe === 'pppoe' ? 'info' : 'warn'}">${esc(p.tipe)}</span>
          <div class="hint">${esc(p.nama_paket || '-')}</div></td>
        <td>${esc(p.nama_topologi || '-')}${p.port_odp ? ' · port ' + esc(p.port_odp) : ''}
          <div class="hint">${esc(p.nama_desa || '')}</div></td>
        <td>${esc(p.username_pppoe || '-')}</td>
        <td>${esc(p.ip_lokal || '-')}
          <div class="hint">MAC: ${esc(p.mac_onu || p.mac_address || '-')}</div></td>
        <td>${esc(p.nomor_whatsapp || '-')}
          ${p.nomor_whatsapp ? `<br><a class="btn sm wa" style="background:#16a34a;color:#fff" target="_blank" rel="noopener" href="https://wa.me/${esc(p.nomor_whatsapp)}">WA</a>` : ''}</td>
        <td>${p.redaman_db != null
          ? `<span class="badge ${badgeRedaman(p.status_redaman)}">${esc(p.redaman_db)} dB</span>`
          : '<span class="badge mute">-</span>'}</td>
        <td><span class="badge ${p.status === 'aktif' ? 'ok' : p.status === 'isolir' ? 'bad' : 'mute'}">${esc(p.status)}</span>
          ${p.tipe === 'pppoe' ? `<div class="hint">${p.pppoe_online ? '🟢 online' : '⚪ offline'}</div>` : ''}</td>
        <td class="t-actions">
          <button class="btn sm" onclick="remoteOnu(${p.id})" title="Auto-generate NAT MikroTik → web ONU">Remote ONU</button>
          <button class="btn sm secondary" onclick="formPelanggan(${esc(JSON.stringify(p))})">Ubah</button>
          ${p.status !== 'aktif' ? `<button class="btn sm" onclick="plgStatus(${p.id},'aktif')">Aktifkan</button>` : ''}
          ${p.status !== 'isolir' ? `<button class="btn sm secondary" onclick="plgStatus(${p.id},'isolir')">Isolir</button>` : ''}
          ${p.status !== 'nonaktif' ? `<button class="btn sm secondary" onclick="plgStatus(${p.id},'nonaktif')">Nonaktif</button>` : ''}
          <button class="btn sm ghost" onclick="plgHapus(${p.id})">Hapus</button>
        </td>
      </tr>`).join('') || '<tr><td colspan="11" class="empty">Belum ada pelanggan</td></tr>';

    const halaman = Math.floor(PLG_OFFSET / PLG_LIMIT) + 1;
    const terakhir = Math.max(1, Math.ceil(PLG_TOTAL / PLG_LIMIT));
    document.getElementById('plgHalInfo').textContent = `Halaman ${halaman} / ${terakhir}`;
    document.getElementById('pelangganTotal').textContent = `${PLG_TOTAL} pelanggan`;
    document.getElementById('lnEkspor').href = `/api/pelanggan/export?q=${q}&status=${PLG_TAB}&tipe=${tp}`;
    document.getElementById('plgAll').checked = false;
    plgPilihBaris();
    muatJumlah();
  } catch (e) { toast(e.message, true); }
}

/** Jumlah per status untuk label tab (mengikuti pencarian & tipe yang aktif). */
async function muatJumlah() {
  try {
    const q = encodeURIComponent(document.getElementById('pq').value || '');
    const tp = document.getElementById('ptipe').value;
    const j = await API.get(`/api/pelanggan/jumlah?q=${q}&tipe=${tp}`);
    document.getElementById('jnSemua').textContent = j.semua;
    document.getElementById('jnAktif').textContent = j.aktif;
    document.getElementById('jnBaru').textContent = j.baru;
    document.getElementById('jnIsolir').textContent = j.isolir;
    document.getElementById('jnNonaktif').textContent = j.nonaktif;
  } catch (_) { /* label tab tidak sampai mengganggu daftar */ }
}

function plgTab(el) {
  document.querySelectorAll('#plgTabs .tab').forEach(t => t.classList.remove('on'));
  el.classList.add('on');
  document.getElementById('plgUnmanageBox').style.display = 'none';
  PLG_TAB = el.dataset.status || '';
  PLG_OFFSET = 0;
  loadPelanggan();
}

function plgCari() {
  clearTimeout(PLG_WAKTU);
  PLG_WAKTU = setTimeout(() => { PLG_OFFSET = 0; loadPelanggan(); }, 300);
}

function plgHal(arah) {
  const maks = Math.max(0, Math.ceil((PLG_TOTAL - PLG_LIMIT) / PLG_LIMIT) * PLG_LIMIT);
  PLG_OFFSET = Math.max(0, Math.min(PLG_OFFSET + arah * PLG_LIMIT, maks));
  loadPelanggan();
}

function plgTerpilih() {
  return [...document.querySelectorAll('.plgSel:checked')].map(c => Number(c.value));
}

function plgPilihAll(chk) {
  document.querySelectorAll('.plgSel').forEach(c => { c.checked = chk.checked; });
  plgPilihBaris();
}

function plgPilihBaris() {
  const ids = plgTerpilih();
  document.getElementById('plgBulk').style.display = ids.length ? 'flex' : 'none';
  document.getElementById('plgBulkJml').textContent = `${ids.length} dipilih`;
}

function plgBulkBersihkan() {
  document.querySelectorAll('.plgSel').forEach(c => { c.checked = false; });
  document.getElementById('plgAll').checked = false;
  plgPilihBaris();
}

async function plgBulkTerapkan() {
  const ids = plgTerpilih();
  if (!ids.length) return toast('Belum ada pelanggan dipilih', true);
  const status = document.getElementById('plgBulkStatus').value;
  try {
    const r = await API.post('/api/pelanggan/status', { ids, status });
    const gagal = (r.gagal || []).length;
    toast(`${(r.diubah || []).length} pelanggan -> ${status}${gagal ? ` · ${gagal} gagal` : ''}`, gagal > 0);
    (r.gagal || []).slice(0, 3).forEach(g => toast(`#${g.id}: ${g.alasan}`, true));
    plgBulkBersihkan();
    loadPelanggan();
  } catch (e) { toast(e.message, true); }
}

async function plgStatus(id, status) {
  try {
    const r = await API.post(`/api/pelanggan/${id}/status`, { status });
    const g = (r.diubah || [])[0] || {};
    const rb = g.router;
    if (rb && rb.gagal && rb.gagal.length) toast(`Status diubah, tapi router gagal: ${rb.gagal[0]}`, true);
    else if (rb && !rb.router) toast(`Status -> ${status} (username PPPoE tidak ditemukan di router)`, true);
    else if (rb) toast(`${status === 'aktif' ? 'Secret diaktifkan' : 'Secret dimatikan'}${rb.sesi_dibuang ? ` · ${rb.sesi_dibuang} sesi putus` : ''}`);
    else toast(`Status -> ${status} (pelanggan ini tidak punya secret PPPoE)`);
    (r.gagal || []).slice(0, 3).forEach(x => toast(`#${x.id}: ${x.alasan}`, true));
  } catch (e) { toast(e.message, true); }
  loadPelanggan();
}

async function plgHapus(id) {
  if (!confirm('Hapus pelanggan ini? Riwayat tagihan harus kosong.')) return;
  try {
    await API.del(`/api/pelanggan/${id}`);
    toast('Pelanggan dihapus');
    loadPelanggan();
  } catch (e) { toast(e.message, true); }
}

function plgUnmanage() {
  const box = document.getElementById('plgUnmanageBox');
  const tampil = box.style.display === 'none';
  box.style.display = tampil ? 'block' : 'none';
  document.querySelectorAll('#plgTabs .tab').forEach(t => t.classList.remove('on'));
  document.querySelector('#plgTabs .tab[data-unmanage]').classList.add('on');
  if (tampil) muatUnmanage();
}

/** Lihat saja: sesi PPPoE di router yang tidak ada di daftar pelanggan. */
async function muatUnmanage() {
  const tb = document.getElementById('tbUnmanage');
  tb.innerHTML = '<tr><td colspan="4" class="empty">Menghubungi router…</td></tr>';
  try {
    const d = await API.get('/api/pelanggan/unmanage');
    document.getElementById('jnUnmanage').textContent = (d.data || []).length;
    tb.innerHTML = (d.data || []).length ? d.data.map(s => `
      <tr><td>${esc(s.router)}</td><td><b>${esc(s.user)}</b></td>
        <td>${esc(s.address || '-')}</td><td>${esc(s.uptime || '-')}</td></tr>`).join('')
      : '<tr><td colspan="4" class="empty">Semua sesi PPPoE tercatat sebagai pelanggan</td></tr>';
    if ((d.router_gagal || []).length) {
      document.getElementById('unmanageHint').textContent =
        `Router gagal disentuh: ${d.router_gagal.join(' | ')}`;
    }
  } catch (e) {
    tb.innerHTML = `<tr><td colspan="4" class="empty">${esc(e.message)}</td></tr>`;
  }
}

async function muatOpsi() {
  try {
    const [pk, ag, tp, ds] = await Promise.all([
      API.get('/api/paket'), API.get('/api/agen'),
      API.get('/api/master/topologi'), API.get('/api/master/desa')
    ]);
    PAKET_LIST = pk.data || []; AGEN_LIST = ag.data || [];
    TOPO_LIST = tp.data || []; DESA_LIST = ds.data || [];
    const oPaket = PAKET_LIST.map(p => `<option value="${p.id}">${esc(p.nama_paket)} (${esc(p.jenis)})</option>`).join('');
    const oAgen = '<option value="">— tanpa agen —</option>' + AGEN_LIST.map(a => `<option value="${a.id}">${esc(a.nama)}</option>`).join('');
    const kosong = (t) => `<option value="">— ${t} —</option>`;
    const oTopo = kosong('tanpa topologi') + TOPO_LIST.map(t =>
      `<option value="${t.id}">${esc(t.nama)} (${t.jumlah_terpakai}/${t.jumlah_port} port)</option>`).join('');
    const oDesa = kosong('tanpa desa') + DESA_LIST.map(x => `<option value="${x.id}">${esc(x.nama)}</option>`).join('');
    ['fPaket', 'vPaket'].forEach(id => { const el = document.getElementById(id); if (el) el.innerHTML = oPaket; });
    const fA = document.getElementById('fAgen'); if (fA) fA.innerHTML = oAgen;
    const fT = document.getElementById('fTopo'); if (fT) fT.innerHTML = oTopo;
    const fD = document.getElementById('fDesa'); if (fD) fD.innerHTML = oDesa;
  } catch (_) {}
}

function formPelanggan(p) {
  muatOpsi();
  document.getElementById('mPelangganTitle').textContent = p ? 'Ubah Pelanggan' : 'Tambah Pelanggan';
  document.getElementById('fPid').value = p ? p.id : '';
  document.getElementById('fNama').value = p ? p.nama : '';
  document.getElementById('fTipe').value = p ? p.tipe : 'pppoe';
  document.getElementById('fPaket').value = p && p.id_paket ? p.id_paket : '';
  document.getElementById('fWa').value = p ? (p.nomor_whatsapp || '') : '';
  document.getElementById('fUser').value = p ? (p.username_pppoe || '') : '';
  document.getElementById('fPass').value = p ? (p.password_pppoe || '') : '';
  document.getElementById('fAgen').value = p && p.id_agen ? p.id_agen : '';
  document.getElementById('fStatus').value = p ? p.status : 'baru';
  document.getElementById('fAlamat').value = p ? (p.alamat || '') : '';
  document.getElementById('fTopo').value = p && p.id_master_topologi ? p.id_master_topologi : '';
  document.getElementById('fDesa').value = p && p.id_master_desa ? p.id_master_desa : '';
  document.getElementById('fPortOdp').value = p ? (p.port_odp || '') : '';
  document.getElementById('fLat').value = p ? (p.latitude || '') : '';
  document.getElementById('fLong').value = p ? (p.longitude || '') : '';
  modalOpen('mPelanggan');
  setTimeout(() => { petaPilih('fPeta', cfgPetaPelanggan()); petaPilihSinkron('fPeta'); }, 60);
}

async function simpanPelanggan() {
  const id = document.getElementById('fPid').value;
  const body = {
    nama: document.getElementById('fNama').value,
    tipe: document.getElementById('fTipe').value,
    id_paket: document.getElementById('fPaket').value || null,
    nomor_whatsapp: document.getElementById('fWa').value,
    username_pppoe: document.getElementById('fUser').value,
    password_pppoe: document.getElementById('fPass').value,
    id_agen: document.getElementById('fAgen').value || null,
    status: document.getElementById('fStatus').value,
    alamat: document.getElementById('fAlamat').value,
    id_master_topologi: document.getElementById('fTopo').value || null,
    id_master_desa: document.getElementById('fDesa').value || null,
    port_odp: document.getElementById('fPortOdp').value || null,
    latitude: document.getElementById('fLat').value || null,
    longitude: document.getElementById('fLong').value || null
  };
  try {
    if (id) await API.put(`/api/pelanggan/${id}`, body);
    else await API.post('/api/pelanggan', body);
    modalClose('mPelanggan'); toast('Tersimpan'); loadPelanggan();
  } catch (e) { toast(e.message, true); }
}

// ------------------------------------------- export / import pelanggan
function formImporPelanggan() {
  document.getElementById('impFile').value = '';
  document.getElementById('impHasil').innerHTML = '';
  modalOpen('mImporPelanggan');
}

async function jalankanImport() {
  const f = document.getElementById('impFile').files[0];
  if (!f) return toast('Pilih file Excel atau CSV terlebih dulu', true);
  const fd = new FormData();
  fd.append('file', f);
  const box = document.getElementById('impHasil');
  box.textContent = 'Mengimpor…';
  try {
    const r = await API.post('/api/pelanggan/import', fd, true);
    box.innerHTML = `<b>${r.sukses}</b> dari ${r.total} baris berhasil ditambahkan` +
      (r.gagal ? `, <b>${r.gagal}</b> gagal:` : '.') +
      (r.detail && r.detail.length
        ? '\n' + r.detail.map(d => `Baris ${d.baris}${d.nama ? ' — ' + esc(d.nama) : ''}: ${esc(d.error)}`).join('\n')
        : '');
    toast(r.gagal ? `Import: ${r.sukses} berhasil, ${r.gagal} gagal` : `Import ${r.sukses} pelanggan selesai`, !!r.gagal);
    loadPelanggan();
  } catch (e) { box.textContent = ''; toast(e.message, true); }
}

// ============================================================ TAGIHAN
let TQ_ROWS = [];

async function loadTagihan() {
  try {
    const q = encodeURIComponent(document.getElementById('tq').value || '');
    const st = document.getElementById('tstatus').value;
    const d = await API.get(`/api/tagihan?q=${q}&status=${st}&limit=100`);
    document.getElementById('tBelum').textContent = rupiah(d.nominal_belum_lunas);
    document.getElementById('tJml').textContent = d.total || 0;
    const badge = (s) => ({
      buat: 'info', terkirim: 'info', menunggu: 'warn',
      lunas: 'ok', jatuh_tempo: 'bad', batal: 'mute'
    }[s] || 'mute');
    TQ_ROWS = d.data || [];
    document.getElementById('tbTagihan').innerHTML = TQ_ROWS.map(t => `
      <tr>
        <td><b>${esc(t.nomor_invoice)}</b></td>
        <td>${esc(t.nama_pelanggan)}</td>
        <td>${esc(t.periode)}</td>
        <td class="t-num">${rupiah(t.total)}</td>
        <td>${tgl(t.jatuh_tempo)}</td>
        <td><span class="badge ${badge(t.status)}">${esc(t.status)}</span></td>
        <td class="t-actions">
          <button class="btn sm ghost" onclick="cetakInvoice('${esc(t.nomor_invoice)}')" title="Cetak / simpan PDF invoice">Cetak</button>
          ${t.status !== 'lunas' && t.status !== 'batal'
            ? `<button class="btn sm" onclick="bayarTagihan(${t.id})">Bayar</button>
               <button class="btn sm ghost" onclick="formKeteranganTagihan(${TQ_ROWS.indexOf(t)})">Keterangan</button>
               <button class="btn sm ghost" onclick="batalTagihan(${t.id})">Batal</button>`
            : t.status === 'lunas'
              ? `<button class="btn sm ghost" onclick="kirimKwitansi(${t.id})" title="Kirim bukti lunas (gambar) ke WA">Kwitansi WA</button>` : ''}
        </td>
      </tr>`).join('') || '<tr><td colspan="7" class="empty">Belum ada tagihan</td></tr>';
  } catch (e) { toast(e.message, true); }
}

async function buatTagihan() {
  if (!confirm('Buat tagihan bulanan untuk semua pelanggan aktif periode berjalan?')) return;
  try {
    const r = await API.post('/api/tagihan/buat', { force: true });
    toast(r.skipped ? `Dilewati: ${r.reason}` : `Tagihan dibuat: ${r.dibuat || 0}`);
    loadTagihan();
  } catch (e) { toast(e.message, true); }
}

async function kirimTagihanWA() {
  try {
    const r = await API.post('/api/tagihan/kirim-wa', {});
    toast(`Tagihan dikirim ke antrean WA: ${r.dikirim || 0}`);
  } catch (e) { toast(e.message, true); }
}

async function bayarTagihan(id) {
  if (!confirm('Tandai tagihan LUNAS (pembayaran manual)?')) return;
  try {
    await API.post(`/api/tagihan/${id}/bayar`, { keterangan: 'manual' });
    toast('Lunas'); loadTagihan();
  } catch (e) { toast(e.message, true); }
}

async function batalTagihan(id) {
  if (!confirm('Batalkan tagihan ini?')) return;
  try { await API.post(`/api/tagihan/${id}/batal`, {}); toast('Dibatalkan'); loadTagihan(); }
  catch (e) { toast(e.message, true); }
}

function cetakInvoice(no) {
  window.open('/cetak/invoice.html?no=' + encodeURIComponent(no), '_blank');
}

// ------------------------------------------- tagihan satuan + kwitansi
async function opsiPelanggan(pilih = '') {
  // selalu ambil ulang: daftar pelanggan berubah saat pemilih tenant berpindah ISP
  await muatPelangganCache();
  return '<option value="">— pilih pelanggan —</option>' + PELANGGAN_CACHE.map(p =>
    `<option value="${p.id}" ${String(p.id) === String(pilih) ? 'selected' : ''}>${esc(p.nama)} (${esc(p.kode || p.id)})</option>`).join('');
}

async function formTagihanSatuan() {
  try {
    document.getElementById('tsPel').innerHTML = await opsiPelanggan();
    document.getElementById('tsPeriode').value = new Date().toISOString().slice(0, 7);
    ['tsKet', 'tsJumlah', 'tsJt'].forEach(i => { document.getElementById(i).value = ''; });
    document.getElementById('tsDiskon').value = '0';
    modalOpen('mTagSatuan');
  } catch (e) { toast(e.message, true); }
}

async function simpanTagihanSatuan() {
  try {
    const r = await API.post('/api/tagihan/buat-satuan', {
      id_pelanggan: document.getElementById('tsPel').value,
      periode: document.getElementById('tsPeriode').value,
      keterangan: document.getElementById('tsKet').value || null,
      jumlah: document.getElementById('tsJumlah').value || null,
      diskon: document.getElementById('tsDiskon').value || 0,
      jatuh_tempo: document.getElementById('tsJt').value || null
    });
    modalClose('mTagSatuan');
    toast(r.sudah_ada ? `Sudah ada tagihan periode ini (#${r.id})` : `Tagihan ${r.nomor} — ${rupiah(r.total)}`);
    loadTagihan();
  } catch (e) { toast(e.message, true); }
}

async function formKeteranganTagihan(i) {
  const t = TQ_ROWS[i];
  if (!t) return;
  document.getElementById('tkTagId').value = t.id;
  document.getElementById('tkTagKet').value = t.keterangan || '';
  modalOpen('mTagKet');
}

async function simpanKeteranganTagihan() {
  const id = document.getElementById('tkTagId').value;
  try {
    await API.put(`/api/tagihan/${id}/keterangan`, { keterangan: document.getElementById('tkTagKet').value });
    modalClose('mTagKet'); toast('Keterangan disimpan'); loadTagihan();
  } catch (e) { toast(e.message, true); }
}

async function kirimKwitansi(id) {
  if (!confirm('Kirim ulang bukti lunas (gambar kwitansi) ke WhatsApp pelanggan?')) return;
  try {
    const r = await API.post(`/api/tagihan/${id}/kwitansi`, {});
    toast(r.ok ? 'Kwitansi masuk antrean WA' : `Tidak dikirim: ${r.alasan || 'unknown'}`);
  } catch (e) { toast(e.message, true); }
}

// ============================================================ INVOICE PENJUALAN
let INV_ROWS = [], INV_ITEMS = [];

async function loadInvoice() {
  try {
    const q = encodeURIComponent(document.getElementById('ivq').value || '');
    const st = document.getElementById('ivstatus').value;
    const [d, j] = await Promise.all([
      API.get(`/api/invoice?q=${q}&status=${st}&limit=100`),
      API.get('/api/invoice/jumlah')
    ]);
    document.getElementById('ivJml').textContent = j.semua || 0;
    document.getElementById('ivLunas').textContent = rupiah(j.lunas ? j.lunas.nilai : 0);
    const belum = ['buat', 'terkirim'].reduce((s, k) => s + (j[k] ? j[k].nilai : 0), 0);
    document.getElementById('ivBelum').textContent = rupiah(belum);
    const badge = (s) => ({ lunas: 'ok', terkirim: 'warn', buat: 'info', batal: 'mute' }[s] || 'mute');
    INV_ROWS = d.data || [];
    document.getElementById('tbInvoice').innerHTML = INV_ROWS.map(iv => `
      <tr>
        <td><b>${esc(iv.nomor)}</b></td>
        <td>${tgl(iv.tanggal)}</td>
        <td>${esc(iv.nama_tujuan || iv.nama_pelanggan || '-')}</td>
        <td>${iv.butir || 0} butir</td>
        <td class="t-num">${rupiah(iv.total)}</td>
        <td><span class="badge ${badge(iv.status)}">${esc(iv.status)}</span></td>
        <td class="t-actions">
          <button class="btn sm ghost" onclick="cetakInvoiceBarang('${esc(iv.nomor)}')">Cetak</button>
          ${iv.status === 'lunas'
            ? `<button class="btn sm ghost" onclick="kirimKwitansiInvoice(${iv.id})">Kwitansi WA</button>`
            : `<button class="btn sm" onclick="formInvoice(${INV_ROWS.indexOf(iv)})">Ubah</button>
               <button class="btn sm" onclick="kirimInvoiceWA(${iv.id})">Kirim WA</button>
               <button class="btn sm ghost" onclick="lunasInvoice(${iv.id})">Lunas</button>
               <button class="btn sm ghost" onclick="batalInvoice(${iv.id})">Batal</button>`}
        </td>
      </tr>`).join('') || '<tr><td colspan="7" class="empty">Belum ada invoice</td></tr>';
  } catch (e) { toast(e.message, true); }
}

async function formInvoice(i) {
  const iv = typeof i === 'number' ? INV_ROWS[i] : null;
  document.getElementById('mInvTitle').textContent = iv ? `Invoice ${iv.nomor}` : 'Invoice Penjualan Barang / Jasa';
  document.getElementById('ivId').value = iv ? iv.id : '';
  document.getElementById('ivTanggal').value = iv ? String(iv.tanggal).slice(0, 10) : new Date().toISOString().slice(0, 10);
  document.getElementById('ivJt').value = iv && iv.jatuh_tempo ? String(iv.jatuh_tempo).slice(0, 10) : '';
  document.getElementById('ivPel').innerHTML = await opsiPelanggan(iv ? iv.id_pelanggan : '');
  document.getElementById('ivNama').value = iv ? (iv.nama_tujuan || '') : '';
  document.getElementById('ivAlamat').value = iv ? (iv.alamat_tujuan || '') : '';
  document.getElementById('ivWa').value = iv ? (iv.whatsapp_tujuan || '') : '';
  document.getElementById('ivCatatan').value = iv ? (iv.catatan || '') : '';
  document.getElementById('ivButirWrap').style.display = iv ? '' : 'none';
  if (iv) await muatButirInvoice(iv.id);
  modalOpen('mInvoice');
}

async function muatButirInvoice(id) {
  const d = await API.get(`/api/invoice/${id}`);
  INV_ITEMS = d.item || [];
  const total = INV_ITEMS.reduce((s, it) => s + Number(it.quantity) * Number(it.harga), 0);
  document.getElementById('ivTotalLabel').textContent = `total ${rupiah(total)}`;
  document.getElementById('tbInvItem').innerHTML = INV_ITEMS.map(it => `
    <tr><td>${tgl(it.tanggal)}</td><td>${esc(it.uraian)}</td>
      <td class="t-num">${Number(it.quantity)}</td>
      <td class="t-num">${rupiah(it.harga)}</td>
      <td class="t-num">${rupiah(Number(it.quantity) * Number(it.harga))}</td>
      <td class="t-actions">
        <button class="btn sm ghost" onclick="formInvItem(${INV_ITEMS.indexOf(it)})">Ubah</button>
        <button class="btn sm danger" onclick="hapusInvItem(${it.id})">Hapus</button></td></tr>`).join('')
    || '<tr><td colspan="6" class="empty">Belum ada butir — klik "Tambah butir"</td></tr>';
}

async function simpanInvoice() {
  const id = document.getElementById('ivId').value;
  const body = {
    tanggal: document.getElementById('ivTanggal').value,
    jatuh_tempo: document.getElementById('ivJt').value || null,
    id_pelanggan: document.getElementById('ivPel').value || null,
    nama_tujuan: document.getElementById('ivNama').value || null,
    alamat_tujuan: document.getElementById('ivAlamat').value || null,
    whatsapp_tujuan: document.getElementById('ivWa').value || null,
    catatan: document.getElementById('ivCatatan').value || null
  };
  try {
    if (id) {
      await API.put(`/api/invoice/${id}`, body);
      toast('Invoice diperbarui');
      modalClose('mInvoice');
    } else {
      const r = await API.post('/api/invoice', body);
      toast(`Invoice ${r.nomor} dibuat — sekarang tambah butir barangnya`);
      document.getElementById('ivId').value = r.id;
      document.getElementById('mInvTitle').textContent = `Invoice ${r.nomor}`;
      document.getElementById('ivButirWrap').style.display = '';
      INV_ITEMS = [];
      await muatButirInvoice(r.id);
    }
    loadInvoice();
  } catch (e) { toast(e.message, true); }
}

function formInvItem(idx) {
  const it = typeof idx === 'number' ? INV_ITEMS[idx] : null;
  const id = document.getElementById('ivId').value;
  if (!id) { toast('Simpan invoice dulu sebelum menambah butir', true); return; }
  document.getElementById('mInvItemTitle').textContent = it ? 'Ubah Butir' : 'Tambah Butir';
  document.getElementById('iviId').value = it ? it.id : '';
  document.getElementById('iviTanggal').value = it ? String(it.tanggal).slice(0, 10) : new Date().toISOString().slice(0, 10);
  document.getElementById('iviUraian').value = it ? it.uraian : '';
  document.getElementById('iviQty').value = it ? it.quantity : 1;
  document.getElementById('iviHarga').value = it ? it.harga : '';
  modalOpen('mInvoiceItem');
}

async function simpanInvItem() {
  const iid = document.getElementById('iviId').value;
  const id = document.getElementById('ivId').value;
  const body = {
    tanggal: document.getElementById('iviTanggal').value,
    uraian: document.getElementById('iviUraian').value,
    quantity: document.getElementById('iviQty').value,
    harga: document.getElementById('iviHarga').value
  };
  try {
    if (iid) await API.put(`/api/invoice/item/${iid}`, body);
    else await API.post(`/api/invoice/${id}/item`, body);
    modalClose('mInvoiceItem'); toast('Butir tersimpan');
    await muatButirInvoice(id); loadInvoice();
  } catch (e) { toast(e.message, true); }
}

async function hapusInvItem(iid) {
  if (!confirm('Hapus butir ini?')) return;
  const id = document.getElementById('ivId').value;
  try {
    await API.del(`/api/invoice/item/${iid}`);
    await muatButirInvoice(id); loadInvoice();
  } catch (e) { toast(e.message, true); }
}

function cetakInvoiceBarang(no) {
  window.open('/cetak/invoice-barang.html?no=' + encodeURIComponent(no), '_blank');
}

async function kirimInvoiceWA(id) {
  try {
    const r = await API.post(`/api/invoice/${id}/kirim`, {});
    toast(r.ok ? 'Invoice masuk antrean WA' : 'Gagal'); loadInvoice();
  } catch (e) { toast(e.message, true); }
}

async function lunasInvoice(id) {
  if (!confirm('Tandai invoice LUNAS? Kwitansi gambar akan dikirim ke WhatsApp tujuan.')) return;
  try {
    const r = await API.post(`/api/invoice/${id}/lunas`, { metode: 'manual' });
    toast(r.kwitansi && r.kwitansi.ok ? 'Lunas — kwitansi masuk antrean WA'
      : `Lunas${r.kwitansi_gagal ? ' (kwitansi: ' + r.kwitansi_gagal + ')' : ''}`);
    loadInvoice();
  } catch (e) { toast(e.message, true); }
}

async function kirimKwitansiInvoice(id) {
  if (!confirm('Kirim ulang kwitansi invoice ke WhatsApp?')) return;
  try {
    const r = await API.post(`/api/invoice/${id}/kwitansi`, {});
    toast(r.ok ? 'Kwitansi masuk antrean WA' : `Tidak dikirim: ${r.alasan || 'unknown'}`);
  } catch (e) { toast(e.message, true); }
}

async function batalInvoice(id) {
  if (!confirm('Batalkan invoice ini?')) return;
  try { await API.post(`/api/invoice/${id}/batal`, {}); toast('Dibatalkan'); loadInvoice(); }
  catch (e) { toast(e.message, true); }
}

// ============================================================ PEMBAYARAN
async function loadBayar() {
  try {
    const d = await API.get('/api/pembayaran/menunggu');
    document.getElementById('tbBayar').innerHTML = (d.data || []).map(b => `
      <tr>
        <td>${esc(b.nomor_invoice)}</td><td>${esc(b.nama_pelanggan)}</td>
        <td class="t-num">${rupiah(b.jumlah)}</td>
        <td>${b.bukti ? `<a href="${esc(b.bukti)}" target="_blank">lihat</a>` : '-'}</td>
        <td>${esc(b.keterangan || '-')}</td>
        <td class="t-actions">
          <button class="btn sm" onclick="verifBayar(${b.id},'terima')">Terima</button>
          <button class="btn sm danger" onclick="verifBayar(${b.id},'tolak')">Tolak</button>
        </td></tr>`).join('') || '<tr><td colspan="6" class="empty">Tidak ada bukti menunggu</td></tr>';

    const g = await API.get('/api/gateway');
    const gw = g.data || {};
    document.getElementById('gwInfo').innerHTML = `
      Gateway aktif: <b>${esc(gw.pg_active || 'manual')}</b> ·
      Midtrans: <b>${gw.midtrans_server_key ? 'terisi' : 'belum'}</b> ·
      Flip: <b>${gw.flip_secret ? 'terisi' : 'belum'}</b> ·
      WA gateway: <b>${gw.wa_gateway_url ? esc(gw.wa_gateway_url) : 'belum diatur'}</b>`;

    const rk = await API.get('/api/rekening');
    document.getElementById('tbRek').innerHTML = (rk.data || []).map(r => `
      <tr><td>${esc(r.bank)}</td><td>${esc(r.no_rek)}</td><td>${esc(r.atas_nama)}</td>
      <td class="t-actions"><button class="btn sm ghost" onclick="hapusRek(${r.id})">Nonaktif</button></td></tr>`).join('')
      || '<tr><td colspan="4" class="empty">Belum ada rekening</td></tr>';
  } catch (e) { toast(e.message, true); }
}

async function verifBayar(id, aksi) {
  try { await API.post(`/api/pembayaran/${id}/verifikasi`, { aksi }); toast('Diproses'); loadBayar(); }
  catch (e) { toast(e.message, true); }
}
async function simpanRek() {
  try {
    await API.post('/api/rekening', {
      bank: document.getElementById('rBank').value,
      no_rek: document.getElementById('rNo').value,
      atas_nama: document.getElementById('rAtas').value
    });
    modalClose('mRek'); toast('Tersimpan'); loadBayar();
  } catch (e) { toast(e.message, true); }
}
async function hapusRek(id) {
  try { await API.del(`/api/rekening/${id}`); toast('Dinonaktifkan'); loadBayar(); }
  catch (e) { toast(e.message, true); }
}

// ============================================================ PAKET
async function loadPaket() {
  try {
    const d = await API.get('/api/paket');
    document.getElementById('tbPaket').innerHTML = (d.data || []).map(p => `
      <tr><td><b>${esc(p.nama_paket)}</b></td>
        <td><span class="badge ${p.jenis === 'pppoe' ? 'info' : 'warn'}">${esc(p.jenis)}</span></td>
        <td class="t-num">${rupiah(p.harga)}</td>
        <td class="t-num">${rupiah(p.harga_agen)}</td>
        <td>${esc(p.kecepatan || '-')}</td>
        <td><span class="badge ${p.status === 'aktif' ? 'ok' : 'mute'}">${esc(p.status)}</span></td>
        <td class="t-actions"><button class="btn sm secondary" onclick="formPaket(${esc(JSON.stringify(p))})">Ubah</button></td>
      </tr>`).join('') || '<tr><td colspan="7" class="empty">Belum ada paket</td></tr>';
  } catch (e) { toast(e.message, true); }
}
function formPaket(p) {
  document.getElementById('kPid').value = p ? p.id : '';
  document.getElementById('kNama').value = p ? p.nama_paket : '';
  document.getElementById('kJenis').value = p ? p.jenis : 'pppoe';
  document.getElementById('kHarga').value = p ? Number(p.harga) : '';
  document.getElementById('kAgen').value = p ? Number(p.harga_agen) : '';
  document.getElementById('kSpeed').value = p ? (p.kecepatan || '') : '';
  document.getElementById('kAktif').value = p ? p.masa_aktif : 30;
  document.getElementById('kStatus').value = p ? p.status : 'aktif';
  modalOpen('mPaket');
}
async function simpanPaket() {
  const id = document.getElementById('kPid').value;
  const body = {
    nama_paket: document.getElementById('kNama').value,
    jenis: document.getElementById('kJenis').value,
    harga: document.getElementById('kHarga').value,
    harga_agen: document.getElementById('kAgen').value,
    kecepatan: document.getElementById('kSpeed').value,
    masa_aktif: document.getElementById('kAktif').value,
    status: document.getElementById('kStatus').value
  };
  try {
    if (id) await API.put(`/api/paket/${id}`, body);
    else await API.post('/api/paket', body);
    modalClose('mPaket'); toast('Tersimpan'); loadPaket();
  } catch (e) { toast(e.message, true); }
}

// ============================================================ VOUCHER
async function loadVoucher() {
  try {
    const q = encodeURIComponent(document.getElementById('vq').value || '');
    const st = document.getElementById('vstatus').value;
    const d = await API.get(`/api/voucher?q=${q}&status=${st}&limit=100`);
    const badge = (s) => ({ stok: 'info', terjual: 'warn', terpakai: 'ok', kedaluwarsa: 'mute', batal: 'mute' }[s] || 'mute');
    document.getElementById('tbVoucher').innerHTML = (d.data || []).map(v => `
      <tr><td><b>${esc(v.kode)}</b></td><td>${esc(v.nama_paket || '-')}</td>
        <td class="t-num">${rupiah(v.harga_jual)}</td>
        <td><span class="badge ${badge(v.status)}">${esc(v.status)}</span></td>
        <td>${esc(String(v.created_at).slice(0, 16))}</td>
        <td>${v.used_at ? esc(String(v.used_at).slice(0, 16)) : '-'}</td></tr>`).join('')
      || '<tr><td colspan="6" class="empty">Belum ada voucher</td></tr>';
  } catch (e) { toast(e.message, true); }
}
async function genVoucher() {
  try {
    const r = await API.post('/api/voucher/generate', {
      id_paket: document.getElementById('vPaket').value,
      jumlah: document.getElementById('vJml').value
    });
    modalClose('mVoucher'); toast(`${r.dibuat} voucher dibuat`); loadVoucher();
  } catch (e) { toast(e.message, true); }
}

// ============================================================ AGEN
async function loadAgen() {
  try {
    const d = await API.get('/api/agen');
    document.getElementById('tbAgen').innerHTML = (d.data || []).map(a => `
      <tr><td><b>${esc(a.nama)}</b></td><td>${esc(a.no_hp || '-')}</td>
        <td class="t-num">${rupiah(a.saldo)}</td><td class="t-num">${esc(a.komisi_pct)}</td>
        <td><span class="badge ${a.status === 'aktif' ? 'ok' : 'mute'}">${esc(a.status)}</span></td>
        <td class="t-actions"><button class="btn sm secondary" onclick="formAgen(${esc(JSON.stringify(a))})">Ubah</button></td>
      </tr>`).join('') || '<tr><td colspan="6" class="empty">Belum ada agen</td></tr>';
  } catch (e) { toast(e.message, true); }
}
function formAgen(a) {
  document.getElementById('aId').value = a ? a.id : '';
  document.getElementById('aNama').value = a ? a.nama : '';
  document.getElementById('aWa').value = a ? (a.no_hp || '') : '';
  document.getElementById('aKomisi').value = a ? Number(a.komisi_pct) : 0;
  document.getElementById('aSaldo').value = 0;
  modalOpen('mAgen');
}
async function simpanAgen() {
  const id = document.getElementById('aId').value;
  const body = {
    nama: document.getElementById('aNama').value,
    no_hp: document.getElementById('aWa').value,
    komisi_pct: document.getElementById('aKomisi').value
  };
  try {
    let agenId = id;
    if (id) await API.put(`/api/agen/${id}`, body);
    else { const r = await API.post('/api/agen', body); agenId = r.id; }
    const saldo = Number(document.getElementById('aSaldo').value || 0);
    if (saldo > 0) await API.post(`/api/agen/${agenId}/saldo`, { tipe: 'topup', jumlah: saldo, keterangan: 'setoran awal' });
    modalClose('mAgen'); toast('Tersimpan'); loadAgen();
  } catch (e) { toast(e.message, true); }
}

// ============================================================ INTERFACE
async function loadInterface() {
  try {
    const d = await API.get('/api/interface');
    const rows = d.data || [];
    document.getElementById('tbIf').innerHTML = rows.map(r => `
      <tr><td>${esc(r.router)}</td><td><b>${esc(r.iface)}</b></td><td>${esc(r.tipe || '-')}</td>
        <td><span class="badge ${r.status === 'up' ? 'ok' : 'bad'}">${esc(r.status)}</span></td>
        <td class="t-num">${(Number(r.rx_bps) / 1024).toFixed(1)} Kbps</td>
        <td class="t-num">${(Number(r.tx_bps) / 1024).toFixed(1)} Kbps</td>
        <td>${esc(String(r.cek_at).slice(11, 16))}</td></tr>`).join('')
      || '<tr><td colspan="7" class="empty">Belum ada data — pastikan perangkat MikroTik terdaftar & polling berjalan</td></tr>';

    const sel = document.getElementById('ifRouter');
    const names = [...new Set(rows.map(r => r.router))];
    const cur = sel.value;
    sel.innerHTML = '<option value="">Semua router</option>' + names.map(n => `<option>${esc(n)}</option>`).join('');
    sel.value = cur;

    const res = await API.get('/api/resource');
    document.getElementById('tbRes').innerHTML = (res.data || []).slice(0, 20).map(r => `
      <tr><td>${esc(r.nama)}</td><td>${esc(r.cpu_load ?? '-')}${r.cpu_load != null ? '%' : ''}</td>
        <td>${esc(r.memory_used ?? '-')}${r.memory_used != null ? '%' : ''}</td>
        <td>${esc(String(r.cek_at).slice(0, 16))}</td></tr>`).join('')
      || '<tr><td colspan="4" class="empty">Belum ada data resource</td></tr>';
  } catch (e) { toast(e.message, true); }
}
async function pollRouter() {
  toast('Polling berjalan…');
  try { const r = await API.post('/api/interface/poll', {}); toast(JSON.stringify(r).slice(0, 120)); loadInterface(); }
  catch (e) { toast(e.message, true); }
}

// ============================================================ OLT
async function loadOlt() {
  try {
    const [s, o] = await Promise.all([API.get('/api/olt/setting'), API.get('/api/olt/onu')]);
    document.getElementById('tbOlt').innerHTML = (s.data || []).map(x => `
      <tr><td><b>${esc(x.nama)}</b></td><td>${esc(x.brand).toUpperCase()}</td>
        <td class="t-num">${esc(x.olt_tx_dbm)}</td><td class="t-num">${esc(x.rx_min_dbm)}</td>
        <td class="t-num">${esc(x.att_max_db)}</td><td>${esc(x.interval_menit)} mnt</td>
        <td>${x.last_check_at ? `<span class="badge ${/kritis|error|gagal/i.test(x.last_check_msg || '') ? 'bad' : 'ok'}">${esc(String(x.last_check_at).slice(5, 16))}</span>` : '<span class="badge mute">belum</span>'}
            <div class="hint">${esc(x.last_check_msg || '')}</div></td>
        <td class="t-actions">
          <button class="btn sm secondary" onclick="formOlt(${esc(JSON.stringify(x))})">Ambang</button>
          <button class="btn sm" onclick="pollOlt(${x.id})">Poll</button></td></tr>`).join('')
      || '<tr><td colspan="8" class="empty">Belum ada OLT — daftarkan di menu Perangkat</td></tr>';

    document.getElementById('tbOnu').innerHTML = (o.data || []).slice(0, 80).map(x => `
      <tr><td>${esc(x.nama_olt)}</td><td>${esc(x.pon || '-')}</td><td>${esc(x.sn || '-')}</td>
        <td>${esc(x.nama_onu || x.nama_pelanggan || '-')}</td>
        <td class="t-num">${x.rx_dbm != null ? esc(x.rx_dbm) : '-'}</td>
        <td class="t-num">${x.redaman_db != null ? esc(x.redaman_db) + ' dB' : '-'}</td>
        <td><span class="badge ${x.status_online ? 'ok' : 'mute'}">${x.status_online ? 'online' : 'off'}</span></td></tr>`).join('')
      || '<tr><td colspan="7" class="empty">Belum ada ONU</td></tr>';
  } catch (e) { toast(e.message, true); }
}
function formOlt(x) {
  document.getElementById('oId').value = x.id;
  document.getElementById('oTx').value = x.olt_tx_dbm;
  document.getElementById('oRx').value = x.rx_min_dbm;
  document.getElementById('oAtt').value = x.att_max_db;
  document.getElementById('oInt').value = x.interval_menit;
  document.getElementById('oStatus').value = x.status;
  modalOpen('mOlt');
}
async function simpanOlt() {
  try {
    await API.put(`/api/olt/setting/${document.getElementById('oId').value}`, {
      olt_tx_dbm: document.getElementById('oTx').value,
      rx_min_dbm: document.getElementById('oRx').value,
      att_max_db: document.getElementById('oAtt').value,
      interval_menit: document.getElementById('oInt').value,
      status: document.getElementById('oStatus').value
    });
    modalClose('mOlt'); toast('Tersimpan'); loadOlt();
  } catch (e) { toast(e.message, true); }
}
async function pollOlt(id) {
  toast('Polling OLT…');
  try {
    const r = await API.post(`/api/olt/poll/${id}`, {});
    toast(`${(r.onus || []).length} ONU dibaca`); loadOlt();
  } catch (e) { toast(e.message, true); }
}

// ============================================================ ISSUE
async function loadIssue() {
  try {
    const d = await API.get('/api/issue');
    document.getElementById('tbIssue').innerHTML = (d.data || []).map(i => `
      <tr><td>${esc(i.nama_pelanggan)}</td><td>${esc(i.username_pppoe || '-')}</td>
        <td><span class="badge bad">${esc(i.tipe)}</span></td>
        <td>${esc(i.pesan)}</td><td>${esc(String(i.created_at).slice(0, 16))}</td>
        <td class="t-actions"><button class="btn sm" onclick="selesaiIssue(${i.id})">Selesai</button></td></tr>`).join('')
      || '<tr><td colspan="6" class="empty">Tidak ada issue terbuka 🎉</td></tr>';
  } catch (e) { toast(e.message, true); }
}
async function selesaiIssue(id) {
  try { await API.put(`/api/issue/${id}/selesai`, {}); toast('Diselesaikan'); loadIssue(); }
  catch (e) { toast(e.message, true); }
}

// ============================================================ PERANGKAT
async function loadPerangkat() {
  try {
    const d = await API.get('/api/perangkat');
    document.getElementById('tbPerangkat').innerHTML = (d.data || []).map(p => `
      <tr><td><b>${esc(p.nama)}</b></td><td>${esc(p.brand).toUpperCase()}</td>
        <td>${esc(p.tipe)}</td><td>${esc(p.alamat)}${p.port ? ':' + esc(p.port) : ''}</td>
        <td>${esc(p.lokasi || '-')}</td>
        <td>${p.last_check ? esc(String(p.last_check).slice(5, 16)) : '-'}<div class="hint">${esc(p.last_msg || '')}</div></td>
        <td><span class="badge ${p.status === 'aktif' ? 'ok' : 'mute'}">${esc(p.status)}</span></td>
        <td class="t-actions">
          <button class="btn sm ghost" onclick="testPerangkat(${p.id})">Tes</button>
          <button class="btn sm ghost" onclick="bukaWebfig(${esc(JSON.stringify(p))})" title="Buka halaman web perangkat (WebFig/GUI)">WebFig</button>
          <button class="btn sm secondary" onclick="formPerangkat(${esc(JSON.stringify(p))})">Ubah</button>
        </td></tr>`).join('') || '<tr><td colspan="8" class="empty">Belum ada perangkat</td></tr>';
    // WebFig/GUI: OLT memakai port web tersimpan; MikroTik selalu port 80/443 bawaan
    window.bukaWebfig = (p) => {
      const proto = p.use_https ? 'https' : 'http';
      const port = p.tipe === 'olt' && p.port && ![80, 443].includes(Number(p.port)) ? ':' + p.port : '';
      window.open(`${proto}://${p.alamat}${port}`, '_blank');
    };
  } catch (e) { toast(e.message, true); }
}
function formPerangkat(p) {
  document.getElementById('dId').value = p ? p.id : '';
  document.getElementById('dNama').value = p ? p.nama : '';
  document.getElementById('dBrand').value = p ? p.brand : 'mikrotik';
  document.getElementById('dAlamat').value = p ? p.alamat : '';
  document.getElementById('dPort').value = p && p.port ? p.port : '';
  document.getElementById('dUser').value = p ? (p.username || '') : '';
  document.getElementById('dPass').value = '';
  document.getElementById('dLokasi').value = p ? (p.lokasi || '') : '';
  document.getElementById('dHttps').value = p ? String(p.use_https || 0) : '0';
  modalOpen('mPerangkat');
}
async function simpanPerangkat() {
  const id = document.getElementById('dId').value;
  const body = {
    nama: document.getElementById('dNama').value,
    brand: document.getElementById('dBrand').value,
    alamat: document.getElementById('dAlamat').value,
    port: document.getElementById('dPort').value || null,
    username: document.getElementById('dUser').value,
    password: document.getElementById('dPass').value,
    lokasi: document.getElementById('dLokasi').value,
    use_https: document.getElementById('dHttps').value === '1'
  };
  if (!body.password) delete body.password;
  try {
    if (id) await API.put(`/api/perangkat/${id}`, body);
    else await API.post('/api/perangkat', body);
    modalClose('mPerangkat'); toast('Tersimpan'); loadPerangkat();
  } catch (e) { toast(e.message, true); }
}
async function testPerangkat(id) {
  toast('Menguji koneksi…');
  try {
    const r = await API.post(`/api/perangkat/${id}/test`, {});
    toast(r.ok ? `OK (${r.ms || '?'} ms${r.interfaces ? ', ' + r.interfaces + ' interface' : ''})` : `Gagal: ${r.error}`, !r.ok);
    loadPerangkat();
  } catch (e) { toast(e.message, true); }
}

// ============================================================ PENGGUNA
async function loadPengguna() {
  try {
    const d = await API.get('/api/pengguna');
    document.getElementById('tbPengguna').innerHTML = (d.data || []).map(u => `
      <tr><td><b>${esc(u.username)}</b></td><td>${esc(u.nama)}</td>
        <td><span class="badge ${u.role === 'superadmin' ? 'bad' : u.role === 'teknisi' ? 'info' : 'warn'}">${esc(u.role)}</span></td>
        <td>${esc(u.id_ref ?? '-')}</td>
        <td>${esc(u.id_data_server || 'semua')}</td>
        <td>${esc(u.nama_grup || 'semua menu')}</td>
        <td>${u.last_login ? esc(String(u.last_login).slice(0, 16)) : '-'}</td>
        <td><span class="badge ${u.status === 'aktif' ? 'ok' : 'bad'}">${esc(u.status)}</span></td>
        <td class="t-actions"><button class="btn sm secondary" onclick="formPengguna(${esc(JSON.stringify(u))})">Ubah</button></td>
      </tr>`).join('') || '<tr><td colspan="9" class="empty">Kosong</td></tr>';
    await isiOpsiGrup();

    const a = await API.get('/api/audit');
    document.getElementById('tbAudit').innerHTML = (a.data || []).slice(0, 30).map(x => `
      <tr><td>${esc(String(x.created_at).slice(0, 16))}</td><td>${esc(x.username || '-')}</td>
        <td>${esc(x.aksi)}</td><td>${esc(x.detail || '')}</td></tr>`).join('')
      || '<tr><td colspan="4" class="empty">Kosong</td></tr>';
  } catch (e) { toast(e.message, true); }
}
function formPengguna(u) {
  document.getElementById('uId').value = u ? u.id : '';
  document.getElementById('uUsername').value = u ? u.username : '';
  document.getElementById('uUsername').disabled = !!u;
  document.getElementById('uNama').value = u ? u.nama : '';
  document.getElementById('uRole').value = u ? u.role : 'teknisi';
  document.getElementById('uRef').value = u && u.id_ref ? u.id_ref : '';
  document.getElementById('uPass').value = '';
  document.getElementById('uStatus').value = u ? u.status : 'aktif';
  const bebas = bolehTenantLain();
  document.getElementById('uDsRow').style.display = bebas ? '' : 'none';
  document.getElementById('uGrupRow').style.display = bebas ? '' : 'none';
  if (bebas) {
    document.getElementById('uDs').value = u && u.id_data_server ? String(u.id_data_server) : '';
    saringOpsiGrup();
    document.getElementById('uGrup').value = u && u.id_group_akses ? String(u.id_group_akses) : '';
  }
  modalOpen('mPengguna');
}
async function simpanPengguna() {
  const id = document.getElementById('uId').value;
  const pass = document.getElementById('uPass').value;
  try {
    if (id) {
      const body = { nama: document.getElementById('uNama').value, status: document.getElementById('uStatus').value };
      if (pass) body.password = pass;
      if (bolehTenantLain()) {
        body.id_data_server = document.getElementById('uDs').value || 'all';
        body.id_group_akses = document.getElementById('uGrup').value || null;
      }
      await API.put(`/api/pengguna/${id}`, body);
    } else {
      const body = {
        username: document.getElementById('uUsername').value,
        nama: document.getElementById('uNama').value,
        role: document.getElementById('uRole').value,
        id_ref: document.getElementById('uRef').value || null,
        password: pass
      };
      if (bolehTenantLain()) {
        body.id_data_server = document.getElementById('uDs').value || 'all';
        body.id_group_akses = document.getElementById('uGrup').value || null;
      }
      await API.post('/api/pengguna', body);
    }
    modalClose('mPengguna'); toast('Tersimpan'); loadPengguna();
  } catch (e) { toast(e.message, true); }
}

// ============================================================ WA
async function loadWa() {
  try {
    const d = await API.get('/api/wa/log');
    document.getElementById('tbWaAntre').innerHTML = (d.antrean || []).map(w => `
      <tr><td>${esc(w.tujuan)}</td><td>${esc(w.jenis)}</td>
        <td>${esc(String(w.pesan).slice(0, 70))}</td><td>${esc(w.percobaan)}</td></tr>`).join('')
      || '<tr><td colspan="4" class="empty">Antrean kosong</td></tr>';
    document.getElementById('tbWaLog').innerHTML = (d.data || []).slice(0, 40).map(w => `
      <tr><td>${esc(String(w.created_at).slice(0, 16))}</td><td>${esc(w.tujuan)}</td>
        <td><span class="badge ${w.status === 'terkirim' ? 'ok' : 'bad'}">${esc(w.status)}</span></td>
        <td class="hint">${esc(String(w.response || '').slice(0, 60))}</td></tr>`).join('')
      || '<tr><td colspan="4" class="empty">Belum ada log</td></tr>';
  } catch (e) { toast(e.message, true); }
}
async function waKirim() {
  try {
    await API.post('/api/wa/kirim', {
      tujuan: document.getElementById('waNo').value,
      pesan: document.getElementById('waPesan').value
    });
    toast('Masuk antrean'); loadWa();
  } catch (e) { toast(e.message, true); }
}
async function waProses() {
  try { const r = await API.post('/api/wa/proses', {}); toast(`terkirim:${r.sent} gagal:${r.failed}`); loadWa(); }
  catch (e) { toast(e.message, true); }
}

// ============================================================ SETTING
async function loadSetting() {
  try {
    const d = await API.get('/api/setting');
    const s = d.data_server || {};
    document.getElementById('sNama').value = s.nama_server || '';
    document.getElementById('sWa').value = s.nomor_whatsapp || '';
    document.getElementById('sAlamat').value = s.alamat || '';
    document.getElementById('sBuat').value = s.jadwal_buat_hari || 1;
    document.getElementById('sKirim').value = s.jadwal_kirim_hari || 2;
    document.getElementById('sLimit').value = s.jadwal_limit_hari || 10;
    document.getElementById('sJam').value = s.jam_kirim || '07:00';
    document.getElementById('sPpn').value = Number(s.ppn_persen || 0);

    const g = await API.get('/api/gateway');
    const gw = g.data || {};
    document.getElementById('gAktif').value = gw.pg_active || 'manual';
    document.getElementById('gMs').value = '';
    document.getElementById('gMc').value = gw.midtrans_client_key || '';
    document.getElementById('gFs').value = '';
    document.getElementById('gFp').value = gw.flip_public || '';
    document.getElementById('gWaUrl').value = gw.wa_gateway_url || '';
    document.getElementById('gWaKey').value = '';
    muatPairingWa();

    const tpl = d.template || [];
    document.getElementById('tplBox').innerHTML =
      tpl.map(t => `<div class="form-row"><label>${esc(t.jenis)}</label>
        <textarea data-jenis="${esc(t.jenis)}">${esc(t.konten)}</textarea></div>`).join('') +
      '<button class="btn mt" onclick="simpanTemplate()">Simpan template</button>';
  } catch (e) { toast(e.message, true); }
}
async function simpanSetting() {
  try {
    await API.put('/api/setting', {
      nama_server: document.getElementById('sNama').value,
      nomor_whatsapp: document.getElementById('sWa').value,
      alamat: document.getElementById('sAlamat').value,
      jadwal_buat_hari: document.getElementById('sBuat').value,
      jadwal_kirim_hari: document.getElementById('sKirim').value,
      jadwal_limit_hari: document.getElementById('sLimit').value,
      jam_kirim: document.getElementById('sJam').value,
      ppn_persen: document.getElementById('sPpn').value
    });
    toast('Pengaturan tersimpan');
  } catch (e) { toast(e.message, true); }
}
async function simpanGateway() {
  try {
    await API.put('/api/gateway', {
      pg_active: document.getElementById('gAktif').value,
      midtrans_server_key: document.getElementById('gMs').value,
      midtrans_client_key: document.getElementById('gMc').value,
      flip_secret: document.getElementById('gFs').value,
      flip_public: document.getElementById('gFp').value,
      wa_gateway_url: document.getElementById('gWaUrl').value,
      wa_gateway_key: document.getElementById('gWaKey').value
    });
    toast('Gateway tersimpan'); loadSetting();
  } catch (e) { toast(e.message, true); }
}

// ============================================================ PAIRING WHATSAPP GATEWAY
const WA_LABEL = {
  CONNECTED: 'terhubung', PAIRING: 'menunggu pairing',
  SERVICE_SCAN: 'QR siap dipindai', SERVICE_OFF: 'service mati'
};
let waTimer = null;

/** QR dari WHAPI bisa berupa data URL atau URL host gateway; hanya yang
 *  boleh-CSP yang dipasang sebagai <img>, sisanya jadi tautan. */
function renderWaPair(d) {
  const kotak = document.getElementById('waPair');
  const img = document.getElementById('waQr');
  if (!kotak) return;
  const state = d.state || 'TIDAK DIKETAHUI';
  let isi = `Status gateway: <b>${esc(WA_LABEL[state] || state)}</b>`;
  if (d.pesan) isi += ` <span class="hint">${esc(d.pesan)}</span>`;
  if (state === 'SERVICE_OFF') isi += ' <button class="btn" onclick="mulaiPairingWa()">Mulai pairing</button>';
  if (state === 'CONNECTED') isi += ' — nomor sudah tertaut, tidak perlu scan lagi.';
  if (d.qr && /^(data:|blob:|\/)/.test(d.qr)) {
    img.src = d.qr; img.style.display = 'block';
  } else {
    img.style.display = 'none'; img.removeAttribute('src');
    if (d.qr) isi += ` <a href="${esc(d.qr)}" target="_blank" rel="noopener">buka QR di tab baru</a>`;
  }
  kotak.innerHTML = isi;
}

/** Baca status gateway lewat backend — API key tidak pernah dikirim ke browser. */
async function muatPairingWa() {
  const kotak = document.getElementById('waPair');
  if (!kotak) return;
  try {
    renderWaPair(await API.get('/api/gateway/wa/pairing'));
    if (!waTimer) waTimer = setInterval(() => {
      const v = document.querySelector('[data-view="setting"]');
      if (v && !v.hidden) muatPairingWa();
    }, 5000);
  } catch (e) {
    kotak.innerHTML = `<span class="hint">${esc(e.message)}</span>`;
  }
}

async function mulaiPairingWa() {
  try {
    renderWaPair(await API.post('/api/gateway/wa/start', {}));
    toast('Service gateway dijalankan — pindai QR sebelum masa pairing habis');
  } catch (e) { toast(e.message, true); }
}
async function simpanTemplate() {
  try {
    const template = [...document.querySelectorAll('#tplBox textarea')].map(t => ({
      jenis: t.dataset.jenis, konten: t.value
    }));
    await API.put('/api/setting', { template });
    toast('Template tersimpan');
  } catch (e) { toast(e.message, true); }
}

// ============================================================ MASTER TOPOLOGI (ODP)
let TOPO_ROWS = [];
async function loadTopologi() {
  try {
    const d = await API.get('/api/master/topologi');
    TOPO_ROWS = d.data || [];
    document.getElementById('tbTopologi').innerHTML = TOPO_ROWS.map((t, i) => `
      <tr><td><b>${esc(t.nama)}</b></td>
        <td>${t.titik_koordinat
          ? `<a href="https://google.com/maps/?q=${encodeURIComponent(t.titik_koordinat)}" target="_blank" rel="noopener">${esc(t.titik_koordinat)}</a>`
          : '<span class="hint">-</span>'}</td>
        <td class="t-num">${t.jumlah_port}</td>
        <td class="t-num">${t.jumlah_terpakai}</td>
        <td class="t-num">${t.sisa_port}</td>
        <td class="t-actions">
          <button class="btn sm secondary" onclick="formTopologi(${i})">Ubah</button>
          <button class="btn sm danger" onclick="hapusTopologi(${t.id})">Hapus</button>
        </td></tr>`).join('') || '<tr><td colspan="6" class="empty">Belum ada topologi ODP</td></tr>';
  } catch (e) { toast(e.message, true); }
}
function formTopologi(i) {
  const t = typeof i === 'number' ? TOPO_ROWS[i] : null;
  document.getElementById('mTopoTitle').textContent = t ? 'Ubah Topologi ODP' : 'Tambah Topologi ODP';
  document.getElementById('tpId').value = t ? t.id : '';
  document.getElementById('tpNama').value = t ? t.nama : '';
  document.getElementById('tpKoor').value = t ? (t.titik_koordinat || '') : '';
  document.getElementById('tpPort').value = t ? Number(t.jumlah_port) : 16;
  modalOpen('mTopologi');
  setTimeout(() => { petaPilih('tpPeta', cfgPetaTopologi()); petaPilihSinkron('tpPeta'); }, 60);
}
async function simpanTopologi() {
  const id = document.getElementById('tpId').value;
  const body = {
    nama: document.getElementById('tpNama').value,
    titik_koordinat: document.getElementById('tpKoor').value || null,
    jumlah_port: document.getElementById('tpPort').value || 16
  };
  try {
    if (id) await API.put(`/api/master/topologi/${id}`, body);
    else await API.post('/api/master/topologi', body);
    modalClose('mTopologi'); toast('Tersimpan'); loadTopologi(); muatOpsi();
  } catch (e) { toast(e.message, true); }
}
async function hapusTopologi(id) {
  if (!confirm('Hapus topologi ODP ini?')) return;
  try { await API.del(`/api/master/topologi/${id}`); toast('Dihapus'); loadTopologi(); muatOpsi(); }
  catch (e) { toast(e.message, true); }
}

// ============================================================ MASTER DESA
let DESA_ROWS = [];
async function loadDesa() {
  try {
    const d = await API.get('/api/master/desa');
    DESA_ROWS = d.data || [];
    document.getElementById('tbDesa').innerHTML = DESA_ROWS.map((x, i) => `
      <tr><td><b>${esc(x.nama)}</b></td>
        <td class="t-num">${Number(x.jumlah_pelanggan || 0)}</td>
        <td class="t-actions">
          <button class="btn sm secondary" onclick="formDesa(${i})">Ubah</button>
          <button class="btn sm danger" onclick="hapusDesa(${x.id})">Hapus</button>
        </td></tr>`).join('') || '<tr><td colspan="3" class="empty">Belum ada desa</td></tr>';
  } catch (e) { toast(e.message, true); }
}
function formDesa(i) {
  const x = typeof i === 'number' ? DESA_ROWS[i] : null;
  document.getElementById('mDesaTitle').textContent = x ? 'Ubah Desa' : 'Tambah Desa';
  document.getElementById('dsId').value = x ? x.id : '';
  document.getElementById('dsNama').value = x ? x.nama : '';
  modalOpen('mDesa');
}
async function simpanDesa() {
  const id = document.getElementById('dsId').value;
  const body = { nama: document.getElementById('dsNama').value };
  try {
    if (id) await API.put(`/api/master/desa/${id}`, body);
    else await API.post('/api/master/desa', body);
    modalClose('mDesa'); toast('Tersimpan'); loadDesa(); muatOpsi();
  } catch (e) { toast(e.message, true); }
}
async function hapusDesa(id) {
  if (!confirm('Hapus desa ini?')) return;
  try { await API.del(`/api/master/desa/${id}`); toast('Dihapus'); loadDesa(); muatOpsi(); }
  catch (e) { toast(e.message, true); }
}

// ============================================================ NOC — PING TEST
// Paket ICMP dikirim oleh router MikroTik terpilih lewat API RouterOS
// (/ping), sehingga hasil mencerminkan rute internet jaringan pelanggan.
const NOC_TARGET = [
  { key: 'youtube', label: 'youtube.com' },
  { key: 'facebook', label: 'facebook.com' },
  { key: 'google-dns', label: '8.8.8.8 (Google DNS)' },
  { key: 'cloudflare', label: '1.1.1.1 (Cloudflare)' },
  { key: 'tiktok', label: 'tiktok.com' },
  { key: 'mobilelegends', label: 'mobilelegends.com' }
];
let NOC_STATE = {};
async function loadNoc() {
  try {
    Object.values(NOC_STATE).forEach(s => clearInterval(s.timer));
    NOC_STATE = {};
    const d = await API.get('/api/noc/router');
    const sel = document.getElementById('nocRouter');
    sel.innerHTML = (d.data || []).map(r =>
      `<option value="${r.id}">${esc(r.nama)} (${esc(r.alamat)})</option>`).join('')
      || '<option value="">— belum ada router —</option>';
    const grid = document.getElementById('nocGrid');
    grid.innerHTML = NOC_TARGET.map(t => `
      <div class="console-pane">
        <div class="console-head"><span><span class="dot" id="nocDot-${t.key}"></span><b>${esc(t.label)}</b></span>
          <button class="btn sm ghost" id="nocBtn-${t.key}" onclick="nocToggle('${t.key}')">Jeda</button></div>
        <div class="console-body" id="nocLog-${t.key}"></div>
        <div class="console-stats" id="nocStat-${t.key}">kirim 0 | terima 0 | loss 0% | min - / avg - / max - ms</div>
      </div>`).join('');
    NOC_TARGET.forEach((t, i) => {
      NOC_STATE[t.key] = { jalan: true, kirim: 0, terima: 0, min: null, max: null, total: 0,
        timer: null };
      nocBaris(t.key, `PING ${t.label} via router terpilih — polling tiap ~2 detik`, 'warn');
      NOC_STATE[t.key].timer = setInterval(() => nocTick(t.key), 2000 + i * 200);
    });
    sel.onchange = nocBersih;
  } catch (e) { toast(e.message, true); }
}
function nocBaris(key, teks, cls) {
  const log = document.getElementById('nocLog-' + key);
  if (!log) return;
  const d = document.createElement('div');
  if (cls) d.className = cls;
  d.textContent = '[' + new Date().toTimeString().slice(0, 8) + '] ' + teks;
  log.appendChild(d);
  while (log.childNodes.length > 80) log.removeChild(log.firstChild);
  log.scrollTop = log.scrollHeight;
}
function nocStat(key) {
  const s = NOC_STATE[key];
  const loss = s.kirim ? Math.round((s.kirim - s.terima) * 100 / s.kirim) : 0;
  const avg = s.terima ? (s.total / s.terima).toFixed(1) : '-';
  const el = document.getElementById('nocStat-' + key);
  if (el) el.textContent = `kirim ${s.kirim} | terima ${s.terima} | loss ${loss}%` +
    ` | min ${s.min === null ? '-' : s.min.toFixed(1)} / avg ${avg} / max ${s.max === null ? '-' : s.max.toFixed(1)} ms`;
}
async function nocTick(key) {
  const vNoc = document.querySelector('[data-view="noc"]');
  if (!vNoc || vNoc.style.display === 'none') return;   // halaman ditinggalkan → jangan boros
  const s = NOC_STATE[key];
  const rid = document.getElementById('nocRouter').value;
  const dot = document.getElementById('nocDot-' + key);
  if (!s.jalan || !rid) { if (dot) dot.className = 'dot off'; return; }
  try {
    const r = await fetch(`/api/noc/ping?target=${key}&router=${rid}`);
    const d = await r.json();
    s.kirim++;
    if (dot) dot.className = 'dot ' + (d.ok ? 'on' : 'off');
    if (d.ok) {
      s.terima++;
      if (d.ms != null) {
        s.total += d.ms;
        if (s.min === null || d.ms < s.min) s.min = d.ms;
        if (s.max === null || d.ms > s.max) s.max = d.ms;
      }
      nocBaris(key, `64 bytes dari ${d.ip || ''}: ${d.raw || 'time=' + d.ms + 'ms'}`);
    } else {
      nocBaris(key, d.raw || 'Request timeout for icmp_seq ' + s.kirim,
        /timeout/i.test(d.raw || '') ? 'warn' : 'err');
    }
    nocStat(key);
  } catch (_) {
    if (dot) dot.className = 'dot off';
    nocBaris(key, 'gagal memanggil endpoint ping', 'err');
  }
}
function nocToggle(key) {
  const s = NOC_STATE[key];
  s.jalan = !s.jalan;
  document.getElementById('nocBtn-' + key).textContent = s.jalan ? 'Jeda' : 'Lanjut';
}
function nocSemua(nyalakan) {
  NOC_TARGET.forEach(t => {
    NOC_STATE[t.key].jalan = nyalakan;
    const b = document.getElementById('nocBtn-' + t.key);
    if (b) b.textContent = nyalakan ? 'Jeda' : 'Lanjut';
  });
}
function nocBersih() {
  NOC_TARGET.forEach(t => {
    NOC_STATE[t.key] = { ...NOC_STATE[t.key], kirim: 0, terima: 0, min: null, max: null, total: 0 };
    const log = document.getElementById('nocLog-' + t.key);
    if (log) log.innerHTML = '';
    nocStat(t.key);
  });
}

// ============================================================ KEUANGAN (KAS)
async function loadKeuangan() {
  try {
    const dari = document.getElementById('kDari').value;
    const sampai = document.getElementById('kSampai').value;
    const q = `?dari=${encodeURIComponent(dari)}&sampai=${encodeURIComponent(sampai)}`;
    const [d, lap] = await Promise.all([
      API.get('/api/keuangan/kas' + q), API.get('/api/keuangan/laporan' + q)
    ]);
    document.getElementById('kMasuk').textContent = rupiah(lap.total_masuk);
    document.getElementById('kKeluar').textContent = rupiah(lap.total_keluar);
    document.getElementById('kSaldo').textContent = rupiah(lap.saldo);
    document.getElementById('tbKas').innerHTML = (d.data || []).map(k => `
      <tr><td>${String(k.created_at).slice(0, 16)}</td>
        <td><span class="badge ${k.tipe === 'masuk' ? 'ok' : 'bad'}">${esc(k.tipe)}</span></td>
        <td>${esc(k.kategori)}</td>
        <td class="t-num">${rupiah(k.jumlah)}</td>
        <td>${esc(k.keterangan || '-')}</td>
        <td>${esc(k.nama_user || '-')}</td>
        <td class="t-actions">${k.kategori === 'pembayaran'
          ? '<span class="hint">otomatis</span>'
          : `<button class="btn sm danger" onclick="hapusKas(${k.id})">Hapus</button>`}</td></tr>`).join('')
      || '<tr><td colspan="7" class="empty">Belum ada transaksi kas</td></tr>';
  } catch (e) { toast(e.message, true); }
}
function formKas(tipe) {
  document.getElementById('kkTipe').value = tipe || 'keluar';
  document.getElementById('kkKategori').value = 'lainnya';
  document.getElementById('kkJumlah').value = '';
  document.getElementById('kkKet').value = '';
  modalOpen('mKas');
}
async function simpanKas() {
  try {
    await API.post('/api/keuangan/kas', {
      tipe: document.getElementById('kkTipe').value,
      kategori: document.getElementById('kkKategori').value,
      jumlah: document.getElementById('kkJumlah').value,
      keterangan: document.getElementById('kkKet').value || null
    });
    modalClose('mKas'); toast('Tersimpan'); loadKeuangan();
  } catch (e) { toast(e.message, true); }
}
async function hapusKas(id) {
  if (!confirm('Hapus entri kas ini?')) return;
  try { await API.del(`/api/keuangan/kas/${id}`); toast('Dihapus'); loadKeuangan(); }
  catch (e) { toast(e.message, true); }
}

// ============================================================ TIKET GANGGUAN
let TIKET_ROWS = [];
async function loadTiket() {
  try {
    const st = document.getElementById('tkStatus').value;
    const d = await API.get('/api/tiket' + (st ? `?status=${st}` : ''));
    TIKET_ROWS = d.data || [];
    const badge = (s) => ({ baru: 'bad', diproses: 'warn', selesai: 'ok', ditutup: 'mute' }[s] || 'mute');
    const pri = (p) => ({ tinggi: 'bad', sedang: 'warn', rendah: 'mute' }[p] || 'mute');
    document.getElementById('tbTiket').innerHTML = TIKET_ROWS.map(t => `
      <tr><td>${t.id}</td>
        <td><b>${esc(t.nama_pelanggan)}</b><div class="hint">${esc((t.pesan || '').slice(0, 60))}</div></td>
        <td>${esc(t.judul)}</td>
        <td><span class="badge ${pri(t.prioritas)}">${esc(t.prioritas)}</span></td>
        <td><span class="badge ${badge(t.status)}">${esc(t.status)}</span></td>
        <td>${String(t.created_at).slice(0, 16)}</td>
        <td class="t-actions">
          <button class="btn sm" onclick="formTiket(${t.id})">Proses</button>
        </td></tr>`).join('') || '<tr><td colspan="7" class="empty">Belum ada tiket</td></tr>';
  } catch (e) { toast(e.message, true); }
}
async function formTiketBaru() {
  if (!PELANGGAN_CACHE.length) await muatPelangganCache();
  document.getElementById('tkId').value = '';
  document.getElementById('tkPel').innerHTML = PELANGGAN_CACHE.map(p =>
    `<option value="${p.id}">${esc(p.nama)} (${esc(p.kode || p.id)})</option>`).join('')
    || '<option value="">— belum ada pelanggan —</option>';
  document.getElementById('tkJudul').value = '';
  document.getElementById('tkPesan').value = '';
  document.getElementById('tkPri').value = 'sedang';
  document.getElementById('tkStatusSel').style.display = 'none';
  document.getElementById('tkJawab').style.display = 'none';
  modalOpen('mTiket');
}
async function formTiket(id) {
  const t = TIKET_ROWS.find(x => Number(x.id) === Number(id));
  if (!t) return;
  document.getElementById('tkId').value = t.id;
  document.getElementById('tkPel').innerHTML = `<option value="${t.id_pelanggan}">${esc(t.nama_pelanggan)}</option>`;
  document.getElementById('tkJudul').value = t.judul;
  document.getElementById('tkPesan').value = t.pesan || '';
  document.getElementById('tkPri').value = t.prioritas;
  document.getElementById('tkStatusSel').style.display = '';
  document.getElementById('tkStatusSel').value = t.status;
  document.getElementById('tkJawab').style.display = '';
  document.getElementById('tkJawabIsi').value = t.jawaban || '';
  modalOpen('mTiket');
}
async function simpanTiket() {
  const id = document.getElementById('tkId').value;
  try {
    if (id) {
      await API.put(`/api/tiket/${id}`, {
        status: document.getElementById('tkStatusSel').value,
        jawaban: document.getElementById('tkJawabIsi').value || null
      });
      toast('Tiket diperbarui');
    } else {
      await API.post('/api/tiket', {
        id_pelanggan: document.getElementById('tkPel').value,
        judul: document.getElementById('tkJudul').value,
        pesan: document.getElementById('tkPesan').value,
        prioritas: document.getElementById('tkPri').value
      });
      toast('Tiket dibuat');
    }
    modalClose('mTiket'); loadTiket();
  } catch (e) { toast(e.message, true); }
}

// ============================================================ REMOTE ONU
// Auto-generate/update rule dst-nat MikroTik → web ONU pelanggan
// (port_remote di Setting MikroTik), dengan kunci 180 detik antar teknisi.
async function remoteOnu(id) {
  toast('Menyiapkan remote ONU…');
  try {
    const r = await API.post(`/api/pelanggan/${id}/remote-onu`, {});
    document.getElementById('roInfo').innerHTML = `
      <div class="form-grid">
        <div><div class="hint">Nama</div><b>${esc(r.nama)}</b></div>
        <div><div class="hint">Alamat</div><b>${esc(r.alamat)}</b></div>
        <div><div class="hint">IP pelanggan</div><b>${esc(r.ip_pelanggan)}</b></div>
        <div><div class="hint">Router · port remote</div><b>${esc(r.router)} · ${r.port_remote}</b></div>
        <div><div class="hint">NAT rule</div><b>${r.nat === 'update' ? 'to-addresses diupdate' : 'rule baru dibuat'}</b></div>
        <div><div class="hint">IP dari</div><b>${esc(r.via)}</b></div>
      </div>`;
    const a = document.getElementById('roBuka');
    a.href = r.link; a.textContent = `🌐 Buka ${r.link}`;
    modalOpen('mRemoteOnu');
  } catch (e) { toast(e.message, true); }
}

// cache pelanggan sederhana untuk dropdown tiket
let PELANGGAN_CACHE = [];
async function muatPelangganCache() {
  try {
    const d = await API.get('/api/pelanggan?limit=200');
    PELANGGAN_CACHE = d.data || [];
  } catch (_) { PELANGGAN_CACHE = []; }
}

// ============================================================ INIT
document.addEventListener('DOMContentLoaded', async () => {
  try { await requireLogin(['superadmin', 'master']); } catch (_) { return; }
  document.querySelectorAll('.nav a[data-page]').forEach(a => {
    a.addEventListener('click', (e) => { e.preventDefault(); go(a.dataset.page); });
  });
  const origGo = window.go;
  window.go = (page) => { origGo(page); document.getElementById('judul').textContent = JUDUL[page] || page; };
  const cur = location.hash.replace('#', '') || 'dashboard';
  window.go(cur);
  loadPelanggan && muatOpsi();
});


// ============================================================ DATA SERVER (ISP)
let TENANT_ROWS = [];

async function loadTenant() {
  try {
    const d = await API.get('/api/data-server');
    TENANT_ROWS = d.data || [];
    document.getElementById('tbTenant').innerHTML = TENANT_ROWS.map((t, i) => `
      <tr><td>${esc(t.id)}</td><td><b>${esc(t.nama_server)}</b></td>
        <td>${esc(t.nama_pemilik || '-')}</td>
        <td>${t.username ? esc(t.username) : '<span class="badge mute">tanpa login master</span>'}</td>
        <td>${esc(t.prefix_invoice || '-')}</td>
        <td class="hint">buat ${esc(t.jadwal_buat_hari)} · kirim ${esc(t.jadwal_kirim_hari)} · tempo ${esc(t.jadwal_limit_hari)} · ${esc(t.jam_kirim || '00:00')}</td>
        <td>${t.expaired_date ? esc(String(t.expaired_date).slice(0, 10)) : '-'}</td>
        <td><span class="badge ${t.status === 'Aktif' ? 'ok' : 'mute'}">${esc(t.status)}</span></td>
        <td class="t-actions">
          <button class="btn sm secondary" onclick="formTenant(${i})">Ubah</button>
          ${Number(t.id) === 1 ? '' : `<button class="btn sm danger" onclick="hapusTenant(${t.id})">Hapus</button>`}
        </td></tr>`).join('')
      || '<tr><td colspan="9" class="empty">Belum ada data server</td></tr>';
  } catch (e) { toast(e.message, true); }
}

function formTenant(i) {
  const t = typeof i === 'number' ? TENANT_ROWS[i] : null;
  document.getElementById('mTenantTitle').textContent = t ? 'Ubah Data Server' : 'Tambah Data Server';
  const isi = (id, v) => { const el = document.getElementById(id); if (el) el.value = v; };
  isi('tId', t ? t.id : '');
  isi('tNama', t ? t.nama_server : '');
  isi('tPemilik', t ? t.nama_pemilik || '' : '');
  isi('tUser', t ? t.username || '' : '');
  isi('tPass', '');
  isi('tPrefix', t ? t.prefix_invoice || '' : '');
  isi('tExp', t && t.expaired_date ? String(t.expaired_date).slice(0, 10) : '');
  isi('tWa', t ? t.nomor_whatsapp || '' : '');
  isi('tEmail', t ? t.email || '' : '');
  isi('tAlamat', t ? t.alamat || '' : '');
  isi('tBuat', t ? Number(t.jadwal_buat_hari || 1) : 1);
  isi('tKirim', t ? Number(t.jadwal_kirim_hari || 2) : 2);
  isi('tLimit', t ? Number(t.jadwal_limit_hari || 10) : 10);
  isi('tJam', t ? t.jam_kirim || '07:00' : '07:00');
  isi('tPpn', t ? Number(t.ppn_persen || 0) : 0);
  isi('tStatus', t ? t.status : 'Aktif');
  modalOpen('mTenant');
}

async function simpanTenant() {
  const id = document.getElementById('tId').value;
  const ambil = (id2) => document.getElementById(id2).value;
  const body = {
    nama_server: ambil('tNama'),
    nama_pemilik: ambil('tPemilik'),
    username: ambil('tUser'),
    prefix_invoice: ambil('tPrefix'),
    expaired_date: ambil('tExp') || null,
    nomor_whatsapp: ambil('tWa'),
    email: ambil('tEmail'),
    alamat: ambil('tAlamat'),
    jadwal_buat_hari: ambil('tBuat'),
    jadwal_kirim_hari: ambil('tKirim'),
    jadwal_limit_hari: ambil('tLimit'),
    jam_kirim: ambil('tJam'),
    ppn_persen: ambil('tPpn'),
    status: ambil('tStatus')
  };
  if (body.jam_kirim && body.jam_kirim.length === 5) body.jam_kirim = body.jam_kirim.slice(0, 5);
  const pass = ambil('tPass');
  if (pass) body.password = pass;
  try {
    if (id) await API.put(`/api/data-server/${id}`, body);
    else await API.post('/api/data-server', body);
    modalClose('mTenant'); toast('Tersimpan');
    await muatSesi();
    loadTenant();
  } catch (e) { toast(e.message, true); }
}

async function hapusTenant(id) {
  const t = TENANT_ROWS.find(x => Number(x.id) === Number(id)) || {};
  if (!confirm(`Hapus data server "${t.nama_server || id}"? Hanya tenant kosong yang bisa dihapus.`)) return;
  try {
    await API.del(`/api/data-server/${id}`);
    toast('Data server dihapus');
    await muatSesi();
    loadTenant();
  } catch (e) { toast(e.message, true); }
}

// ============================================================ GROUP AKSES
let MENU_LIST = [];
let GROUP_ROWS = [];
let GRUP_SEMUA = [];

async function loadGroup() {
  try {
    const d = await API.get('/api/group-akses');
    MENU_LIST = d.menus || Object.keys(LABEL_MENU);
    GROUP_ROWS = d.data || [];
    await muatLabelTenant();
    document.getElementById('tbGroup').innerHTML = GROUP_ROWS.map((g, i) => {
      const a = bacaAkses(g.akses);
      const buka = a === 'all' ? 'semua menu'
        : Object.keys(a).filter(k => a[k] !== false).map(k => LABEL_MENU[k] || k).join(', ') || 'tidak ada';
      return `<tr><td><b>${esc(g.nama)}</b></td>
        <td>${esc(LABEL_TENANT[g.id_data_server] || ('tenant ' + g.id_data_server))}</td>
        <td class="hint">${esc(buka)}</td>
        <td><span class="badge ${g.status === 'aktif' ? 'ok' : 'mute'}">${esc(g.status)}</span></td>
        <td class="t-actions">
          <button class="btn sm secondary" onclick="formGroup(${i})">Ubah</button>
          <button class="btn sm danger" onclick="hapusGroup(${g.id})">Hapus</button>
        </td></tr>`;
    }).join('') || '<tr><td colspan="5" class="empty">Belum ada group</td></tr>';
    await isiOpsiGrup();
  } catch (e) { toast(e.message, true); }
}

function bacaAkses(nilai) {
  let a = nilai;
  if (typeof a === 'string') { try { a = JSON.parse(a || '{}'); } catch (_) { a = {}; } }
  a = a || {};
  if (!a.menu || a.menu === 'all') return 'all';
  return a.menu || {};
}

let LABEL_TENANT = {};
async function muatLabelTenant() {
  try {
    const s = await API.get('/api/auth/servers');
    LABEL_TENANT = {};
    (s.data || []).forEach(x => { LABEL_TENANT[x.id] = x.nama_server; });
  } catch (_) {}
}

/** Isi dropdown grup (modal pengguna) + dropdown tenant (modal grup & pengguna). */
async function isiOpsiGrup() {
  let grup = { data: [] };
  try { grup = await API.get('/api/group-akses'); } catch (_) {}
  MENU_LIST = grup.menus || MENU_LIST;
  GRUP_SEMUA = grup.data || [];
  const servers = (sesi() && sesi().servers) || [];
  const pasang = (id, html, pilih) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.innerHTML = html;
    if (pilih !== undefined) el.value = pilih;
  };
  pasang('gDs', servers.map(s => `<option value="${s.id}">${esc(s.nama_server)}</option>`).join(''),
    sesi() ? sesi().ds : 1);
  saringOpsiGrup();
}

/** Opsi grup dibatasi ke tenant yang tertulis di kolom data server (kosong = semua tenant). */
function saringOpsiGrup() {
  const el = document.getElementById('uGrup');
  if (!el) return;
  const pilih = el.value;
  const batasi = daftarTenantDariForm();
  const daftar = GRUP_SEMUA.filter(g => !batasi || batasi.includes(Number(g.id_data_server)));
  el.innerHTML = '<option value="">— semua menu —</option>' + daftar.map(g =>
    `<option value="${g.id}">${esc(g.nama)} (tenant ${g.id_data_server})</option>`).join('');
  el.value = daftar.some(g => String(g.id) === pilih) ? pilih : '';
}

function daftarTenantDariForm() {
  const el = document.getElementById('uDs');
  const teks = el ? String(el.value || '').trim() : '';
  if (!teks || teks.toLowerCase() === 'all') return null;
  const ids = teks.split(',').map(s => Number(s.trim())).filter(n => Number.isInteger(n) && n > 0);
  return ids.length ? [...new Set(ids)] : null;
}

function formGroup(i) {
  const g = typeof i === 'number' ? GROUP_ROWS[i] : null;
  document.getElementById('mGroupTitle').textContent = g ? 'Ubah Group Akses' : 'Tambah Group Akses';
  document.getElementById('gId').value = g ? g.id : '';
  document.getElementById('gNama').value = g ? g.nama : '';
  document.getElementById('gStatus').value = g ? g.status : 'aktif';
  document.getElementById('gDsRow').style.display = bolehTenantLain() ? '' : 'none';
  if (g) document.getElementById('gDs').value = g.id_data_server;
  const a = g ? bacaAkses(g.akses) : 'all';
  const semua = a === 'all';
  document.getElementById('gAll').checked = semua;
  gambarMenuAkses(semua ? {} : a, semua);
  modalOpen('mGroup');
}

function toggleGroupAll() {
  const semua = document.getElementById('gAll').checked;
  document.querySelectorAll('#gMenu select').forEach(s => { s.disabled = semua; });
}

function gambarMenuAkses(grant, semua) {
  const daftar = MENU_LIST.length ? MENU_LIST : Object.keys(LABEL_MENU);
  document.getElementById('gMenu').innerHTML = daftar.map(m => {
    const g = grant[m];
    const nilai = (g === true || g === 'all') ? 'all'
      : (g === undefined || g === false) ? '' : 'lihat';
    return `<label class="chk"><span>${esc(LABEL_MENU[m] || m)}</span>
      <select data-menu="${esc(m)}" ${semua ? 'disabled' : ''}>
        <option value="">tanpa akses</option>
        <option value="all"${nilai === 'all' ? ' selected' : ''}>penuh</option>
        <option value="lihat"${nilai === 'lihat' ? ' selected' : ''}>hanya lihat</option>
      </select></label>`;
  }).join('');
}

function ambilAksesForm() {
  if (document.getElementById('gAll').checked) return { menu: 'all' };
  const menu = {};
  document.querySelectorAll('#gMenu select').forEach(s => {
    if (!s.value) return;
    menu[s.dataset.menu] = s.value === 'all' ? true : { sub_menu: [] };
  });
  return { menu };
}

async function simpanGroup() {
  const id = document.getElementById('gId').value;
  const akses = ambilAksesForm();
  if (akses.menu !== 'all' && !Object.keys(akses.menu).length) {
    toast('Pilih minimal satu menu, atau aktifkan akses penuh', true);
    return;
  }
  const body = {
    nama: document.getElementById('gNama').value,
    status: document.getElementById('gStatus').value,
    akses
  };
  if (bolehTenantLain()) body.id_data_server = document.getElementById('gDs').value || null;
  try {
    if (id) await API.put(`/api/group-akses/${id}`, body);
    else await API.post('/api/group-akses', body);
    modalClose('mGroup'); toast('Tersimpan'); loadGroup();
  } catch (e) { toast(e.message, true); }
}

async function hapusGroup(id) {
  const g = GROUP_ROWS.find(x => Number(x.id) === Number(id)) || {};
  if (!confirm(`Hapus group "${g.nama || id}"?`)) return;
  try {
    await API.del(`/api/group-akses/${id}`);
    toast('Group dihapus'); loadGroup();
  } catch (e) { toast(e.message, true); }
}

// ============================================================ PETA SEBARAN
// Padanan halaman Maps Topologi (gratisinaja): Leaflet + marker ODP/pelanggan,
// refresh tiap 30 detik, berhenti otomatis begitu halaman ditinggalkan.
let PETA_MAP = null, PETA_TIMER = null, PETA_MARKERS = [], PETA_FIT = false;

function petaInit() {
  if (PETA_MAP || typeof L === 'undefined') return;
  PETA_MAP = L.map('petaMap', { zoomControl: true }).setView([-7.062083, 106.79739], 11);
  const sat = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    { maxZoom: 19, attribution: 'Tiles &copy; Esri' });
  const osm = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    { maxZoom: 19, attribution: '&copy; OpenStreetMap contributors' });
  sat.addTo(PETA_MAP);
  L.control.layers({ 'Satelit': sat, 'Peta': osm }, {}, { position: 'topright' }).addTo(PETA_MAP);
}

/** Warna pin pelanggan — sama dengan legenda di bawah peta. */
function petaWarna(p) {
  if (p.status === 'nonaktif' || p.status === 'baru') return '#8b95a7';
  if (p.status === 'isolir') return '#e5484d';
  return p.online ? '#2e9e44' : '#e5484d';
}

function petaStatus(p) {
  if (p.status === 'isolir') return 'Isolir';
  if (p.status === 'aktif') return p.online ? 'Online' : 'Offline';
  if (p.status === 'baru') return 'Register';
  return 'Tidak aktif';
}

function petaGambar(d) {
  PETA_MARKERS.forEach(m => PETA_MAP.removeLayer(m));
  PETA_MARKERS = [];

  d.odp.filter(o => o.lat !== null).forEach(o => {
    const m = L.marker([o.lat, o.lng], {
      title: o.nama,
      icon: L.divIcon({ className: '', html: '<div class="peta-odp" style="background:#2f6fed">ODP</div>',
        iconSize: [26, 22], iconAnchor: [13, 11] })
    }).bindPopup(
      `<b>${esc(o.nama)}</b><br>Port terpakai: ${o.jumlah_terpakai}/${o.jumlah_port}` +
      (o.titik_koordinat ? `<br><span class="hint">${esc(o.titik_koordinat)}</span>` : ''));
    m.addTo(PETA_MAP); PETA_MARKERS.push(m);
  });

  d.pelanggan.filter(p => p.lat !== null).forEach(p => {
    const huruf = esc((p.nama || '?').trim().charAt(0).toUpperCase());
    const m = L.marker([p.lat, p.lng], {
      title: p.nama,
      icon: L.divIcon({ className: '',
        html: `<div class="peta-pin" style="background:${petaWarna(p)}"><i>${huruf}</i></div>`,
        iconSize: [24, 24], iconAnchor: [12, 24] })
    }).bindPopup(
      `<b>${esc(p.nama)}</b> <span class="hint">(${esc(p.kode || '-')})</span><br>` +
      `Paket: ${esc(p.nama_paket || '-')}<br>` +
      `Status: ${petaStatus(p)}<br>` +
      `Alamat: ${esc(p.alamat || '-')}` +
      (p.nama_topologi ? `<br>ODP: ${esc(p.nama_topologi)}` : '') +
      `<br><a href="https://google.com/maps/?q=${p.lat},${p.lng}" target="_blank" rel="noopener">Buka di Google Maps</a>`);
    m.addTo(PETA_MAP); PETA_MARKERS.push(m);
  });

  if (!PETA_FIT && PETA_MARKERS.length) {
    PETA_MAP.fitBounds(L.latLngBounds(PETA_MARKERS.map(m => m.getLatLng())).pad(0.2));
    PETA_FIT = true;
  }

  const j = d.jumlah || {};
  document.getElementById('petaRingkas').textContent = PETA_MARKERS.length
    ? `Titik tampil: ${PETA_MARKERS.length} · ODP ${j.odp_berkoordinat || 0}/${j.odp || 0} · ` +
      `Pelanggan ${j.pelanggan_berkoordinat || 0}/${j.pelanggan || 0}`
    : 'Belum ada titik koordinat';
  document.getElementById('petaHint').textContent = d.tanpa_koordinat > 0
    ? `${d.tanpa_koordinat} pelanggan belum punya latitude/longitude sehingga belum tampil di peta — ` +
      'isi lewat form Ubah Pelanggan (kolom Latitude/Longitude), atau petakan ke ODP berkoordinat. ' +
      'Peta dimuat ulang otomatis tiap 30 detik.'
    : 'Seluruh pelanggan sudah punya koordinat. Peta dimuat ulang otomatis tiap 30 detik.';
}

async function loadPeta() {
  if (typeof L === 'undefined') {
    document.getElementById('petaRingkas').textContent = 'Pustaka peta (Leaflet) gagal dimuat';
    return;
  }
  petaInit();
  try {
    petaGambar(await API.get('/api/peta'));
  } catch (e) {
    document.getElementById('petaRingkas').textContent = 'Gagal memuat peta';
    toast(e.message, true);
  }
  if (!PETA_TIMER) PETA_TIMER = setInterval(petaDetik, 30000);
}

/** Tiap 30 detik: berhenti sendiri bila halaman peta sudah ditinggalkan. */
function petaDetik() {
  const v = document.querySelector('[data-view="peta"]');
  if (!v || v.style.display === 'none') {
    clearInterval(PETA_TIMER); PETA_TIMER = null;
    return;
  }
  loadPeta();
}
// ============================================================ PEMILIH KOORDINAT
// Peta kecil di dalam form (modal) untuk memilih titik lokasi dengan klik,
// tanpa mengetik angka. Sekali dibuat per modal, disimpan di PETA_PILIH —
// Leaflet menolak container yang sudah pernah diinisialisasi.
const PETA_PILIH = {};
const PUSAT_BAWAAN = { lat: -7.062083, lng: 106.79739 };

/** "-7.2575, 112.7521" → {lat, lng}; null bila tidak sah. */
function koordinatDari(teks) {
  if (!teks) return null;
  const b = String(teks).split(',').map(s => s.trim());
  if (b.length !== 2) return null;
  const lat = Number(b[0]), lng = Number(b[1]);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  return { lat, lng };
}

const angkaKoord = (n, d) => (Number.isFinite(Number(n)) ? Number(n).toFixed(d) : '');

/** Pasang peta pemilih pada wadah; `cfg` = { kolom, baca, tulis, pusat }. */
function petaPilih(idPeta, cfg) {
  const box = document.getElementById(idPeta);
  if (!box || typeof L === 'undefined') return null;
  let st = PETA_PILIH[idPeta];
  if (!st) {
    const map = L.map(idPeta, { zoomControl: true })
      .setView([PUSAT_BAWAAN.lat, PUSAT_BAWAAN.lng], 11);
    const osm = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png',
      { maxZoom: 19, attribution: '&copy; OpenStreetMap contributors' });
    const sat = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
      { maxZoom: 19, attribution: 'Tiles &copy; Esri' });
    sat.addTo(map);
    L.control.layers({ 'Satelit': sat, 'Peta': osm }, {}, { position: 'topright' }).addTo(map);
    st = PETA_PILIH[idPeta] = { map, titik: null, cfg };
    map.on('click', (e) => {
      if (!st.cfg || !st.cfg.tulis) return;
      st.cfg.tulis(e.latlng.lat, e.latlng.lng);
      petaPilihSinkron(idPeta);
    });
    (cfg.kolom || []).forEach((id) => {
      const el = document.getElementById(id);
      if (el) el.addEventListener('change', () => petaPilihSinkron(idPeta));
    });
  }
  st.cfg = cfg;
  // modal barusan dibuka — Leaflet perlu dihitung ulang setelah layout selesai
  setTimeout(() => { try { st.map.invalidateSize(); } catch (_) {} }, 80);
  return st;
}

/** Sinkronkan pin & tampilan peta dengan isi form (baca → tulis bukan sebaliknya). */
function petaPilihSinkron(idPeta) {
  const st = PETA_PILIH[idPeta];
  if (!st || !st.cfg) return;
  const k = st.cfg.baca ? st.cfg.baca() : null;
  if (st.titik) { st.map.removeLayer(st.titik); st.titik = null; }
  if (k) {
    st.titik = L.marker([k.lat, k.lng], { draggable: true }).addTo(st.map);
    st.titik.on('dragend', () => {
      const p = st.titik.getLatLng();
      if (st.cfg.tulis) st.cfg.tulis(p.lat, p.lng);
      petaPilihSinkron(idPeta);
    });
    if (!st.map.getBounds().contains(L.latLng(k.lat, k.lng))) {
      st.map.setView([k.lat, k.lng], Math.max(st.map.getZoom(), 15));
    }
  } else {
    const c = st.cfg.pusat ? st.cfg.pusat() : null;
    if (c) st.map.setView([c.lat, c.lng], 13);
  }
}

/** Form pelanggan: dua kolom terpisah (fLat / fLong). */
function cfgPetaPelanggan() {
  const el = (id) => document.getElementById(id);
  return {
    kolom: ['fLat', 'fLong', 'fTopo'],
    baca: () => {
      const a = el('fLat').value, b = el('fLong').value;
      if (a === '' || b === '') return null;
      const lat = Number(a), lng = Number(b);
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
      return Math.abs(lat) > 90 || Math.abs(lng) > 180 ? null : { lat, lng };
    },
    tulis: (lat, lng) => {
      el('fLat').value = angkaKoord(lat, 6);
      el('fLong').value = angkaKoord(lng, 6);
    },
    pusat: () => {
      const id = el('fTopo').value;
      const t = TOPO_LIST.find(x => String(x.id) === String(id)) || TOPO_LIST[0];
      return (t && koordinatDari(t.titik_koordinat)) || PUSAT_BAWAAN;
    }
  };
}

/** Form topologi ODP: satu kolom "lat, long" (tpKoor). */
function cfgPetaTopologi() {
  const el = (id) => document.getElementById(id);
  return {
    kolom: ['tpKoor'],
    baca: () => koordinatDari(el('tpKoor').value),
    tulis: (lat, lng) => { el('tpKoor').value = `${angkaKoord(lat, 6)}, ${angkaKoord(lng, 6)}`; },
    pusat: () => koordinatDari(el('tpKoor').value) || PUSAT_BAWAAN
  };
}
