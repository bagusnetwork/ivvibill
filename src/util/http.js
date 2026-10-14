'use strict';
// ============================================================
// Klien HTTP ringkas (fetch global Node 18+) dengan timeout,
// redirect terbatas, dan pembacaan body terstruktur.
// ============================================================

/**
 * Token sesi → header autentikasi.
 * Pengiriman token dulu hilang sama sekali: pemanggil mengirim { token } padahal
 * request() hanya mengenal headers, jadi seluruh GET data ke WebFig OLT datang
 * tanpa kredensial dan dibalas halaman kosong. Nilai polos dianggap pola
 * X-Token (HSGQ/VSOL); driver yang mengembalikan cookie atau bearer menandai
 * nilainya dengan prefiks COOKIE:/BEARER: supaya tidak perlu header khusus
 * di setiap brand.
 */
function terapkanToken(h, token) {
  const t = String(token).replace(/[\r\n]/g, '');
  if (!t) return;
  if (t.startsWith('COOKIE:')) h.Cookie = t.slice(7);
  else if (t.startsWith('BEARER:')) h.Authorization = `Bearer ${t.slice(7)}`;
  else h['X-Token'] = t;
}

async function request(url, {
  method = 'GET',
  body = null,
  headers = {},
  timeout = 10000,
  redirects = 3,
  token = null
} = {}) {
  const h = { ...headers };
  if (token) terapkanToken(h, token);
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(url, {
      method, body, headers: h,
      redirect: redirects > 0 ? 'follow' : 'manual',
      signal: ctrl.signal
    });
    const text = await res.text();
    let parsed = text;
    try { parsed = JSON.parse(text); } catch (_) { /* bukan JSON */ }
    return {
      status: res.status,
      headers: Object.fromEntries(res.headers.entries()),
      body: parsed,
      text
    };
  } finally {
    clearTimeout(t);
  }
}

function get(url, opts = {}) { return request(url, { ...opts, method: 'GET' }); }
function post(url, body, opts = {}) { return request(url, { ...opts, method: 'POST', body }); }
function getJson(url, opts = {}) {
  return get(url, { ...opts, headers: { Accept: 'application/json', ...(opts.headers || {}) } });
}
function postJson(url, data, opts = {}) {
  return post(url, JSON.stringify(data), {
    ...opts,
    headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...(opts.headers || {}) }
  });
}

module.exports = { request, get, post, getJson, postJson };
