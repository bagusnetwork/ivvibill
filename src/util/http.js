'use strict';
// ============================================================
// Klien HTTP ringkas (fetch global Node 18+) dengan timeout,
// redirect terbatas, dan pembacaan body terstruktur.
// ============================================================

async function request(url, {
  method = 'GET',
  body = null,
  headers = {},
  timeout = 10000,
  redirects = 3
} = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(url, {
      method, body, headers,
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
