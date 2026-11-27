// Shared helpers for the web pages
const API = '/api';

function getSession() {
  try { return JSON.parse(localStorage.getItem('p14session')) || null; } catch { return null; }
}
function setSession(s) {
  try { localStorage.setItem('p14session', JSON.stringify(s)); } catch { /* ignore */ }
}
function logout() {
  try { localStorage.removeItem('p14session'); } catch { /* ignore */ }
  location.href = '/';
}

// Redirects to login if not logged in as the expected role
function requireSession(role) {
  const s = getSession();
  if (!s || !s.token || (role && s.user.role !== role)) { location.href = '/'; return null; }
  const who = document.getElementById('who');
  if (who) who.textContent = `${s.user.name} (${s.user.role})`;
  return s;
}

async function api(path, { method = 'GET', body, form } = {}) {
  const s = getSession();
  const headers = {};
  if (s?.token) headers.Authorization = `Bearer ${s.token}`;
  let payload;
  if (form) payload = form;
  else if (body !== undefined) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
  const res = await fetch(API + path, { method, headers, body: payload });
  let data = {};
  try { data = await res.json(); } catch { /* empty body */ }
  if (res.status === 401 && s) { alert('Your session has expired. Please log in again.'); logout(); }
  return { status: res.status, ok: res.ok, data };
}

function fmt(d) {
  if (!d) return '—';
  return new Date(d).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'medium' });
}
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function badge(text) { return `<span class="badge b-${esc(text)}">${esc(text)}</span>`; }
function showMsg(el, kind, text) { el.className = `msg ${kind}`; el.textContent = text; el.classList.remove('hidden'); }
