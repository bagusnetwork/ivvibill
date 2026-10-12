/* ivvibill — Karyawan & Teknisi */
'use strict';
const JUDUL = { dashboard: 'Ringkasan', absen: 'Absensi', pekerjaan: 'Order Pekerjaan', tiket: 'Tiket Gangguan',
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
          <button class="btn sm secondary" onclick="formKerja(${esc(JSON.stringify(k))})">Ubah</button>
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
        <td class="t-actions"><button class="btn sm secondary" onclick="formTiket(${esc(JSON.stringify(t))})">Proses</button></td>
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
        <td class="t-actions">
          <button class="btn sm" onclick="remoteOnu(${p.id})" title="Auto-generate NAT MikroTik → web ONU">Remote ONU</button>
        </td>
      </tr>`).join('') || '<tr><td colspan="8" class="empty">Kosong</td></tr>';
  } catch (e) { toast(e.message, true); }
}

// ---------------- registrasi & remote ONU oleh teknisi (v2.2.0)
// Teknisi mencetak calon pelanggan di lapangan (status 'baru') dan membuka web
// ONU-nya. Menyalakan layanan bukan bagiannya: itu tombol Aktivasi di panel
// admin, yang juga mencetak secret PPPoE lalu mengirim WhatsApp ke warga.
let OPSI_DAFTAR = null;

async function muatOpsiDaftar() {
  try {
    if (!OPSI_DAFTAR) {
      OPSI_DAFTAR = await Promise.all([
        API.get('/api/paket'), API.get('/api/master/topologi'), API.get('/api/master/desa'),
        API.get('/api/profil-tagihan').catch(() => ({ data: [] }))
      ]);
    }
    const [pk, tp, ds, pt] = OPSI_DAFTAR;
    document.getElementById('dPaket').innerHTML = '<option value="">— belum dipilih —</option>'
      + (pk.data || []).filter(p => p.status === 'aktif').map(p =>
        `<option value="${p.id}">${esc(p.nama_paket)}${p.harga ? ' · ' + rupiah(p.harga) : ''}</option>`).join('');
    const opsi = (list, port) => '<option value="">— tanpa —</option>' + (list || []).map(x =>
      `<option value="${x.id}">${esc(x.nama)}${port ? ` (${x.jumlah_terpakai}/${x.jumlah_port} port)` : ''}</option>`).join('');
    document.getElementById('dTopo').innerHTML = opsi(tp.data, true);
    document.getElementById('dDesa').innerHTML = opsi(ds.data);
    // Golongan tagihan: profil aktif paling banyak dipakai jadi pilihan awal,
    // supaya pendaftaran lapangan tidak jatuh ke tempo hari 1 seperti dulu.
    const profil = (pt.data || []).filter(x => x.status === 'aktif');
    const el = document.getElementById('dProfil');
    el.innerHTML = '<option value="">— tanpa (jadwal default) —</option>' + profil.map(x =>
      `<option value="${x.id}">${esc(x.nama)} · tagih tgl ${x.tanggal_isolir} (${x.jumlah_pelanggan} warga)</option>`).join('');
    if (profil.length) {
      const favorit = profil.reduce((a, b) => (Number(b.jumlah_pelanggan) > Number(a.jumlah_pelanggan) ? b : a), profil[0]);
      el.value = String(favorit.id);
    }
  } catch (e) { toast('Pilihan formulir gagal dimuat: ' + e.message, true); }
}

function formDaftar() {
  ['dNama', 'dWa', 'dUser', 'dPass', 'dAlamat', 'dPort', 'dKoor', 'dLat', 'dLong']
    .forEach(id => { document.getElementById(id).value = ''; });
  document.getElementById('dTgl').value = new Date().toISOString().slice(0, 10);
  document.getElementById('dLokasi').textContent = '';
  muatOpsiDaftar();
  modalOpen('mDaftar');
}

/** Titik pasang memakai GPS ponsel — sama polanya dengan absensi. */
function ambilLokasi() {
  const el = document.getElementById('dLokasi');
  if (!navigator.geolocation) { el.textContent = 'browser ini tidak mendukung GPS'; return; }
  el.textContent = 'mencari sinyal…';
  navigator.geolocation.getCurrentPosition((p) => {
    const lat = p.coords.latitude.toFixed(6), long = p.coords.longitude.toFixed(6);
    document.getElementById('dLat').value = lat;
    document.getElementById('dLong').value = long;
    document.getElementById('dKoor').value = `${lat}, ${long}`;
    el.textContent = `akurasi ±${Math.round(p.coords.accuracy)} m`;
  }, (e) => {
    el.textContent = (e && e.code === 1 ? 'izin lokasi ditolak' : 'sinyal tidak ditemukan')
      + ' — koordinat boleh dikosongkan';
  }, { enableHighAccuracy: true, timeout: 15000, maximumAge: 30000 });
}

async function simpanDaftar() {
  const nama = document.getElementById('dNama').value.trim();
  if (nama.length < 2) { toast('Nama pelanggan wajib diisi', true); return; }
  if (document.getElementById('dUser').value.trim() && !document.getElementById('dPass').value.trim()) {
    toast('Isi password PPPoE-nya juga — secret nanti dicetak saat aktivasi.', true);
    return;
  }
  const body = {
    nama, tipe: 'pppoe',
    alamat: document.getElementById('dAlamat').value.trim() || null,
    nomor_whatsapp: document.getElementById('dWa').value.trim(),
    id_paket: document.getElementById('dPaket').value || null,
    id_profil_tagihan: document.getElementById('dProfil').value || null,
    username_pppoe: document.getElementById('dUser').value.trim() || null,
    password_pppoe: document.getElementById('dPass').value.trim() || null,
    tanggal_masuk: document.getElementById('dTgl').value || null,
    id_master_topologi: document.getElementById('dTopo').value || null,
    id_master_desa: document.getElementById('dDesa').value || null,
    port_odp: document.getElementById('dPort').value.trim() || null,
    latitude: document.getElementById('dLat').value || null,
    longitude: document.getElementById('dLong').value || null
  };
  try {
    const r = await API.post('/api/pelanggan', body);
    modalClose('mDaftar');
    OPSI_DAFTAR = null;
    toast(`${r.kode} terdaftar — status baru, menunggu aktivasi admin data server`);
    loadPelanggan();
  } catch (e) { toast(e.message, true); }
}

/** Remote ONU: tab dibuka sinkron dari klik, rule NAT diganti, lalu diarahkan. */
async function remoteOnu(id) {
  const w = tabSementara();
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
    const a = tautanRemoteOnu(r.link);
    if (!arahkanTab(w, r.link)) toast('Popup diblokir browser — tekan tombol Buka di jendela ini.', true);
    modalOpen('mRemoteOnu');
    if (a) a.focus();
  } catch (e) { tutupTab(w); toast(e.message, true); }
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

// ---------------- absensi (koordinat hanya dicatat, tidak ada penolakan)
let ABS_POS = null;

function absenLokasi() {
  const el = document.getElementById('absLokasi');
  ABS_POS = null;
  if (!navigator.geolocation) { el.textContent = 'GPS: browser ini tidak mendukung lokasi'; return; }
  el.textContent = 'GPS: mencari sinyal…';
  navigator.geolocation.getCurrentPosition(
    (p) => {
      ABS_POS = { lat: p.coords.latitude, long: p.coords.longitude, akurasi: Math.round(p.coords.accuracy) };
      el.textContent = `GPS: ${ABS_POS.lat.toFixed(6)}, ${ABS_POS.long.toFixed(6)} (±${ABS_POS.akurasi} m)`;
    },
    (e) => {
      el.textContent = (e && e.code === 1
        ? 'GPS: izin lokasi ditolak — izinkan di pengaturan browser'
        : 'GPS: sinyal tidak ditemukan') + ' — absen tetap bisa disimpan';
    },
    { enableHighAccuracy: true, timeout: 15000, maximumAge: 30000 }
  );
}

async function absen(jenis) {
  const btn = document.getElementById(jenis === 'masuk' ? 'btnMasuk' : 'btnPulang');
  btn.disabled = true;
  try {
    const body = { jenis, catatan: document.getElementById('absCatatan').value || null };
    if (ABS_POS) Object.assign(body, ABS_POS);
    const r = await API.post('/api/absen', body);
    const jamBaru = r.hari_ini ? jamAbsen(jenis === 'masuk' ? r.hari_ini.jam_masuk : r.hari_ini.jam_pulang) : '-';
    toast(`${jenis === 'masuk' ? 'Absen masuk' : 'Absen pulang'} pukul ${jamBaru}`
      + (ABS_POS ? '' : ' tanpa koordinat'));
    if (r.jarak_meter != null) toast(`Jarak titik masuk ke pulang ${r.jarak_meter} m`);
    loadAbsen();
  } catch (e) { toast(e.message, true); }
  finally { btn.disabled = false; }
}

const jamAbsen = (s) => s ? String(s).slice(11, 16) : '-';

function durasiAbsen(m) {
  if (m == null) return '-';
  const x = Number(m);
  return `${Math.floor(x / 60)} jam ${x % 60} menit`;
}

async function loadAbsen() {
  document.getElementById('absTanggal').textContent =
    new Date().toLocaleDateString('id-ID', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  absenLokasi();
  try {
    const d = await API.get('/api/absen/saya');
    const h = d.hari_ini || {};
    const adaMasuk = !!h.jam_masuk, adaPulang = !!h.jam_pulang;
    document.getElementById('btnMasuk').textContent = adaMasuk ? 'Perbarui Absen Masuk' : 'Absen Masuk';
    document.getElementById('btnPulang').textContent = adaPulang ? 'Perbarui Absen Pulang' : 'Absen Pulang';
    document.getElementById('btnPulang').disabled = !adaMasuk;
    const titik = (lat, long) => lat == null ? 'tanpa koordinat'
      : `${Number(lat).toFixed(5)}, ${Number(long).toFixed(5)}`;
    document.getElementById('absStatus').innerHTML = adaMasuk || adaPulang
      ? `<b>Masuk ${jamAbsen(h.jam_masuk)}</b> ${h.lat_masuk != null ? `· ${esc(titik(h.lat_masuk, h.long_masuk))}` : ''}`
        + `<br><b>Pulang ${jamAbsen(h.jam_pulang)}</b> ${h.lat_pulang != null ? `· ${esc(titik(h.lat_pulang, h.long_pulang))}` : ''}`
        + (h.jarak_meter != null ? `<br>Jarak titik masuk → pulang: <b>${esc(h.jarak_meter)} m</b>` : '')
      : 'Belum ada absen hari ini. Tekan <b>Absen Masuk</b> di bawah.';
    document.getElementById('tbAbsenSaya').innerHTML = (d.data || []).map(a => `
      <tr><td>${esc(String(a.tanggal).slice(0, 10))}</td>
        <td>${jamAbsen(a.jam_masuk)}${a.jam_masuk ? ` <span class="hint">${a.lat_masuk != null ? '📍' : '—'}</span>` : ''}</td>
        <td>${jamAbsen(a.jam_pulang)}${a.jam_pulang ? ` <span class="hint">${a.lat_pulang != null ? '📍' : '—'}</span>` : ''}</td>
        <td>${durasiAbsen(a.jam_masuk && a.jam_pulang
          ? Math.round((new Date(String(a.jam_pulang).replace(' ', 'T')) - new Date(String(a.jam_masuk).replace(' ', 'T'))) / 60000)
          : null)}</td>
        <td class="t-num">${a.jarak_meter != null ? esc(a.jarak_meter) + ' m' : '-'}</td>
        <td class="hint">${esc(a.catatan || '')}</td></tr>`).join('')
      || '<tr><td colspan="6" class="empty">Belum pernah absen</td></tr>';
  } catch (e) { toast(e.message, true); }
}

document.addEventListener('DOMContentLoaded', async () => {
  try { await requireLogin(['teknisi']); } catch (_) { return; }
  document.querySelectorAll('.nav a[data-page]').forEach(a =>
    a.addEventListener('click', (e) => { e.preventDefault(); go(a.dataset.page); }));
  const origGo = window.go;
  window.go = (p) => { origGo(p); document.getElementById('judul').textContent = JUDUL[p] || p; };
  window.go(halamanAwal());
});
