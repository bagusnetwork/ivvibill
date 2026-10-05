/* ============================================================
   ivvibill — helper bersama (API client, auth, UI utils)
   ============================================================ */
'use strict';

const API = {
  async req(method, url, body, isForm) {
    const opt = { method, headers: {} };
    if (body !== undefined && body !== null) {
      if (isForm) { opt.body = body; }
      else {
        opt.headers['Content-Type'] = 'application/json';
        opt.body = JSON.stringify(body);
      }
    }
    const r = await fetch(url, opt);
    let data = null;
    try { data = await r.json(); } catch (_) {}
    if (r.status === 401 && !url.includes('/auth/login')) {
      sessionStorage.removeItem('ivvi_user');
      location.href = (document.body.dataset.app || '/panel') + '/?expired=1';
      throw new Error('Sesi berakhir');
    }
    if (!r.ok) throw new Error((data && data.error) || `HTTP ${r.status}`);
    return data;
  },
  get: (u) => API.req('GET', u),
  post: (u, b, f) => API.req('POST', u, b, f),
  put: (u, b) => API.req('PUT', u, b),
  del: (u) => API.req('DELETE', u)
};

function toast(msg, err) {
  let box = document.getElementById('toast');
  if (!box) { box = document.createElement('div'); box.id = 'toast'; document.body.appendChild(box); }
  const el = document.createElement('div');
  el.className = 'toast-item' + (err ? ' err' : '');
  el.textContent = msg;
  box.appendChild(el);
  setTimeout(() => el.remove(), 4200);
}
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g,
  c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const rupiah = (n) => 'Rp ' + Number(n || 0).toLocaleString('id-ID');
const tgl = (s) => s ? String(s).slice(0, 10) : '-';

async function requireLogin(roles) {
  try {
    const r = await API.get('/api/auth/me');
    const u = r.user;
    if (roles && roles.length && !roles.includes(u.role)) {
      location.href = '/panel/';
      throw new Error('Akses ditolak');
    }
    sessionStorage.setItem('ivvi_user', JSON.stringify(u));
    const el = document.getElementById('who');
    if (el) el.textContent = `${u.nama} · ${u.role}`;
    return u;
  } catch (e) {
    showLogin();
    throw e;
  }
}

function showLogin() {
  const app = document.body.dataset.app || '/panel';
  document.getElementById('layout').style.display = 'none';
  const lw = document.createElement('div');
  lw.className = 'login-wrap';
  const judul = { '/panel': 'Panel Data Server', '/agen': 'Agen Hotspot', '/teknisi': 'Karyawan & Teknisi', '/pelanggan': 'Area Pelanggan' }[app] || 'ivvibill';
  lw.innerHTML = `
    <div class="login-card">
      <div class="brand-row"><div class="mark">iV</div>
        <div><h1>ivvibill</h1><div class="sub">${judul}</div></div></div>
      <form id="lf">
        <div class="form-row"><label>Username</label>
          <input name="username" autocomplete="username" required autofocus></div>
        <div class="form-row"><label>Password</label>
          <input name="password" type="password" autocomplete="current-password" required></div>
        <button class="btn" style="width:100%;justify-content:center" type="submit">Masuk</button>
      </form>
      <p class="hint mt" style="text-align:center">Belum punya akun? Hubungi admin / teknisi Anda.</p>
    </div>`;
  document.body.appendChild(lw);
  lw.querySelector('#lf').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    try {
      const r = await API.post('/api/auth/login', {
        username: f.get('username'), password: f.get('password')
      });
      sessionStorage.setItem('ivvi_user', JSON.stringify(r.user));
      location.reload();
    } catch (err) { toast(err.message, true); }
  });
}

async function logout() {
  try { await API.post('/api/auth/logout', {}); } catch (_) {}
  sessionStorage.removeItem('ivvi_user');
  location.href = (document.body.dataset.app || '/panel') + '/';
}

function modalOpen(id) { document.getElementById(id).classList.add('open'); }
function modalClose(id) { document.getElementById(id).classList.remove('open'); }

function bindNav() {
  const app = document.body.dataset.app || '';
  document.querySelectorAll('.nav a[data-page]').forEach(a => {
    a.addEventListener('click', (e) => {
      e.preventDefault();
      go(a.dataset.page);
    });
  });
  const cur = location.hash.replace('#', '') || 'dashboard';
  go(cur);
}
function go(page) {
  document.querySelectorAll('.nav a[data-page]').forEach(a =>
    a.classList.toggle('active', a.dataset.page === page));
  document.querySelectorAll('[data-view]').forEach(v =>
    v.style.display = v.dataset.view === page ? '' : 'none');
  location.hash = page;
  document.querySelectorAll('[data-view="' + page + '"]').forEach(v => {
    if (v.dataset.onload && typeof window[v.dataset.onload] === 'function') window[v.dataset.onload]();
  });
  const sb = document.querySelector('.sidebar');
  if (sb) sb.classList.remove('open');
}
