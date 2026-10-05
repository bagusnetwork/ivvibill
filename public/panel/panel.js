/* ivvibill — Panel Data Server (superadmin) */
'use strict';

const JUDUL = {
  dashboard: 'Dashboard', pelanggan: 'Pelanggan', tagihan: 'Tagihan',
  pembayaran: 'Pembayaran', paket: 'Paket Layanan', voucher: 'Voucher',
  agen: 'Agen Hotspot', interface: 'Monitoring Interface', olt: 'Redaman OLT',
  issue: 'Issue PPPoE', perangkat: 'Perangkat', pengguna: 'Pengguna & Audit',
  wa: 'WhatsApp Gateway', setting: 'Pengaturan'
};

let PAKET_LIST = [], AGEN_LIST = [];

// ============================================================ DASHBOARD
async function loadDashboard() {
  try {
    const d = await API.get('/api/dashboard');
    const r = d.ringkas || {};
    document.getElementById('dashCards').innerHTML = `
      <div class="card green"><div class="label">Pelanggan aktif</div>
        <div class="value">${r.pelanggan_aktif || 0}</div>
        <div class="sub">PPPoE ${r.pppoe_aktif || 0} · Hotspot ${r.hotspot_aktif || 0}</div></div>
      <div class="card blue"><div class="label">Pemasukan bulan ini</div>
        <div class="value">${rupiah(r.pemasukan)}</div>
        <div class="sub">${r.lunas_bulan_ini || 0} tagihan lunas</div></div>
      <div class="card amber"><div class="label">Belum lunas</div>
        <div class="value">${rupiah(r.belum_lunas)}</div>
        <div class="sub">${r.jatuh_tempo || 0} lewat tempo</div></div>
      <div class="card red"><div class="label">Issue terbuka</div>
        <div class="value">${r.issue_open || 0}</div>
        <div class="sub">${r.tiket_open || 0} tiket · ${r.voucher_stok || 0} voucher</div></div>`;

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

// ============================================================ PELANGGAN
async function loadPelanggan() {
  try {
    const q = encodeURIComponent(document.getElementById('pq').value || '');
    const st = document.getElementById('pstatus').value;
    const tp = document.getElementById('ptipe').value;
    const d = await API.get(`/api/pelanggan?q=${q}&status=${st}&tipe=${tp}&limit=100`);
    document.getElementById('tbPelanggan').innerHTML = (d.data || []).map(p => `
      <tr>
        <td>${esc(p.kode)}</td>
        <td><b>${esc(p.nama)}</b></td>
        <td><span class="badge ${p.tipe === 'pppoe' ? 'info' : 'warn'}">${esc(p.tipe)}</span></td>
        <td>${esc(p.nama_paket || '-')}</td>
        <td>${esc(p.username_pppoe || '-')}</td>
        <td>${esc(p.nomor_whatsapp || '-')}</td>
        <td><span class="badge ${p.status === 'aktif' ? 'ok' : p.status === 'isolir' ? 'bad' : 'mute'}">${esc(p.status)}</span></td>
        <td>${p.tipe === 'pppoe' ? (p.pppoe_online ? '<span class="badge ok">online</span>' : '<span class="badge mute">offline</span>') : '-'}</td>
        <td class="t-actions">
          <button class="btn sm secondary" onclick='formPelanggan(${JSON.stringify(p)})'>Ubah</button>
        </td>
      </tr>`).join('') || '<tr><td colspan="9" class="empty">Belum ada pelanggan</td></tr>';
    document.getElementById('pelangganTotal').textContent = `${d.total || 0} data ditampilkan (maks 100)`;
  } catch (e) { toast(e.message, true); }
}

async function muatOpsi() {
  try {
    const [pk, ag] = await Promise.all([API.get('/api/paket'), API.get('/api/agen')]);
    PAKET_LIST = pk.data || []; AGEN_LIST = ag.data || [];
    const oPaket = PAKET_LIST.map(p => `<option value="${p.id}">${esc(p.nama_paket)} (${esc(p.jenis)})</option>`).join('');
    const oAgen = '<option value="">— tanpa agen —</option>' + AGEN_LIST.map(a => `<option value="${a.id}">${esc(a.nama)}</option>`).join('');
    ['fPaket', 'vPaket'].forEach(id => { const el = document.getElementById(id); if (el) el.innerHTML = oPaket; });
    const fA = document.getElementById('fAgen'); if (fA) fA.innerHTML = oAgen;
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
  modalOpen('mPelanggan');
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
    alamat: document.getElementById('fAlamat').value
  };
  try {
    if (id) await API.put(`/api/pelanggan/${id}`, body);
    else await API.post('/api/pelanggan', body);
    modalClose('mPelanggan'); toast('Tersimpan'); loadPelanggan();
  } catch (e) { toast(e.message, true); }
}

// ============================================================ TAGIHAN
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
    document.getElementById('tbTagihan').innerHTML = (d.data || []).map(t => `
      <tr>
        <td><b>${esc(t.nomor_invoice)}</b></td>
        <td>${esc(t.nama_pelanggan)}</td>
        <td>${esc(t.periode)}</td>
        <td class="t-num">${rupiah(t.total)}</td>
        <td>${tgl(t.jatuh_tempo)}</td>
        <td><span class="badge ${badge(t.status)}">${esc(t.status)}</span></td>
        <td class="t-actions">
          ${t.status !== 'lunas' && t.status !== 'batal'
            ? `<button class="btn sm" onclick="bayarTagihan(${t.id})">Bayar</button>
               <button class="btn sm ghost" onclick="batalTagihan(${t.id})">Batal</button>` : '-'}
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
        <td class="t-actions"><button class="btn sm secondary" onclick='formPaket(${JSON.stringify(p)})'>Ubah</button></td>
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
        <td class="t-actions"><button class="btn sm secondary" onclick='formAgen(${JSON.stringify(a)})'>Ubah</button></td>
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
          <button class="btn sm secondary" onclick='formOlt(${JSON.stringify(x)})'>Ambang</button>
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
          <button class="btn sm secondary" onclick='formPerangkat(${JSON.stringify(p)})'>Ubah</button>
        </td></tr>`).join('') || '<tr><td colspan="8" class="empty">Belum ada perangkat</td></tr>';
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
        <td>${u.last_login ? esc(String(u.last_login).slice(0, 16)) : '-'}</td>
        <td><span class="badge ${u.status === 'aktif' ? 'ok' : 'bad'}">${esc(u.status)}</span></td>
        <td class="t-actions"><button class="btn sm secondary" onclick='formPengguna(${JSON.stringify(u)})'>Ubah</button></td>
      </tr>`).join('') || '<tr><td colspan="7" class="empty">Kosong</td></tr>';

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
  modalOpen('mPengguna');
}
async function simpanPengguna() {
  const id = document.getElementById('uId').value;
  const pass = document.getElementById('uPass').value;
  try {
    if (id) {
      const body = { nama: document.getElementById('uNama').value, status: document.getElementById('uStatus').value };
      if (pass) body.password = pass;
      await API.put(`/api/pengguna/${id}`, body);
    } else {
      await API.post('/api/pengguna', {
        username: document.getElementById('uUsername').value,
        nama: document.getElementById('uNama').value,
        role: document.getElementById('uRole').value,
        id_ref: document.getElementById('uRef').value || null,
        password: pass
      });
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
async function simpanTemplate() {
  try {
    const template = [...document.querySelectorAll('#tplBox textarea')].map(t => ({
      jenis: t.dataset.jenis, konten: t.value
    }));
    await API.put('/api/setting', { template });
    toast('Template tersimpan');
  } catch (e) { toast(e.message, true); }
}

// ============================================================ INIT
document.addEventListener('DOMContentLoaded', async () => {
  try { await requireLogin(['superadmin']); } catch (_) { return; }
  document.querySelectorAll('.nav a[data-page]').forEach(a => {
    a.addEventListener('click', (e) => { e.preventDefault(); go(a.dataset.page); });
  });
  const origGo = window.go;
  window.go = (page) => { origGo(page); document.getElementById('judul').textContent = JUDUL[page] || page; };
  const cur = location.hash.replace('#', '') || 'dashboard';
  window.go(cur);
  loadPelanggan && muatOpsi();
});
