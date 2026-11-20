/* =========================================================================
   Rails POS — supplier admin (admin.html)

   For the Rails POS supplier only: see every shop, its login email, trial or
   paid status and paid-until date, and renew subscriptions.

   Security (enforced by the database, not just this page):
   • Only logins listed in public.vendor_admins are admins (email + password;
     no authenticator app, at the owner's request — use a long, unique password).
   • Every change is written to an audit log.
   This page also keeps the login only for this browser tab (sessionStorage),
   signs out after 15 minutes without activity, and escapes all shop text.
   Keep CLOUD in step with app.js.
   ======================================================================== */
'use strict';

const CLOUD = {
  url: 'https://dwayjgzfewuiaayixlmb.supabase.co',
  key: 'sb_publishable_O4YjTjP8eu34O7yxGCq3aQ_jsZ0CyCw',
};
const TEST_MODE = new URLSearchParams(location.search).has('test');
const IDLE_MS = 15 * 60 * 1000;
const SESSION_KEY = 'rails-pos-admin-session';

const $ = (s, root = document) => root.querySelector(s);
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pad = n => String(n).padStart(2, '0');
const isoDay = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const fmtDay = s => (s ? new Date(s + 'T12:00:00').toLocaleDateString('en-ZA', { day: 'numeric', month: 'short', year: 'numeric' }) : '—');
const fmtWhen = s => (s ? new Date(s).toLocaleString('en-ZA', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : 'never');

let session = null;
try { session = JSON.parse(sessionStorage.getItem(SESSION_KEY) || 'null'); } catch { session = null; }
let shops = [];
let audit = [];
let query = '';
let idleTimer = null;

/* ----- Talking to Supabase ----- */

const doFetch = (url, opts) => (TEST_MODE && window.__cloudFetch ? window.__cloudFetch : fetch)(url, opts);

async function api(path, { method = 'GET', body, auth = true } = {}) {
  const headers = { apikey: CLOUD.key, 'Content-Type': 'application/json' };
  if (auth) headers.Authorization = 'Bearer ' + await accessToken();
  let res;
  try {
    res = await doFetch(CLOUD.url + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  } catch {
    throw new Error('No connection to the database');
  }
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!res.ok) {
    const m = String((data && (data.msg || data.message || data.error_description || data.error)) || `Error ${res.status}`);
    const e = new Error(/invalid login/i.test(m) ? 'Wrong email or password' : m);
    e.status = res.status;
    throw e;
  }
  return data;
}
const rpc = (name, args = {}) => api(`/rest/v1/rpc/${name}`, { method: 'POST', body: args });

function setSession(d) {
  session = { access: d.access_token, refresh: d.refresh_token, expiresAt: Date.now() + (d.expires_in || 3600) * 1000, email: d.user?.email || session?.email || '' };
  saveSession();
}
function saveSession() {
  try { if (session) sessionStorage.setItem(SESSION_KEY, JSON.stringify(session)); else sessionStorage.removeItem(SESSION_KEY); } catch { /* private mode */ }
}
async function accessToken() {
  if (session?.access && Date.now() < session.expiresAt - 60000) return session.access;
  if (!session?.refresh) throw new Error('Signed out');
  const d = await api('/auth/v1/token?grant_type=refresh_token', { method: 'POST', body: { refresh_token: session.refresh }, auth: false });
  setSession(d);
  return session.access;
}

async function signOut(message = '') {
  clearTimeout(idleTimer);
  if (session?.access) await api('/auth/v1/logout', { method: 'POST' }).catch(() => {});
  session = null;
  saveSession();
  shops = []; audit = [];
  showLogin(message);
}

/* ----- Screens ----- */

function toast(msg, isError = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'toast show' + (isError ? ' error' : '');
  clearTimeout(toast.t);
  toast.t = setTimeout(() => { t.className = 'toast'; }, 3200);
}
function setHeader() {
  $('#adminWho').textContent = session?.email || '';
  $('#logoutBtn').hidden = !session;
}
const setErr = m => { const e = $('#err'); if (e) e.textContent = m; };

function showLogin(message = '') {
  setHeader();
  $('#root').innerHTML = `
    <form id="loginForm" class="card admin-box" novalidate>
      <h1>Supplier admin</h1>
      <p class="small muted">Only for the Rails POS supplier. Shop logins can't use this page.</p>
      <label class="field"><span>Admin email</span><input id="aEmail" class="input" type="email" autocomplete="username" autocapitalize="none"></label>
      <label class="field"><span>Password</span><input id="aPass" class="input" type="password" autocomplete="current-password"></label>
      <p id="err" class="admin-err" role="alert">${esc(message)}</p>
      <button class="btn primary block lg" type="submit">Sign in</button>
    </form>`;
  $('#aEmail').focus();
}

function statusOf(s) {
  const today = isoDay(new Date());
  if (!s.active_until) return ['noend', 'No end date'];
  const end = new Date(s.active_until + 'T12:00:00');
  const days = Math.round((end - new Date(today + 'T12:00:00')) / 864e5);
  if (days < -7) return ['expired', 'Expired · selling paused'];
  if (days < 0) return ['grace', `Grace · ${7 + days} day${7 + days === 1 ? '' : 's'} left`];
  if (s.plan !== 'paid') return days <= 7 ? ['ending', `Trial ends in ${days} day${days === 1 ? '' : 's'}`] : ['trial', `Trial · ${days} days left`];
  return days <= 7 ? ['ending', `Ends in ${days} day${days === 1 ? '' : 's'}`] : ['paid', 'Paid'];
}

function showDashboard() {
  setHeader();
  const q = query.trim().toLowerCase();
  const list = shops.filter(s => !q || String(s.shop_name).toLowerCase().includes(q) || String(s.email).toLowerCase().includes(q));
  const counts = { paid: 0, trial: 0, attention: 0 };
  shops.forEach(s => { const [k] = statusOf(s); if (k === 'paid' || k === 'noend') counts.paid++; else if (k === 'trial') counts.trial++; else counts.attention++; });
  $('#root').innerHTML = `
    <div class="admin-kpis">
      <div class="kpi"><div class="label">Shops</div><div class="value num">${shops.length}</div></div>
      <div class="kpi"><div class="label">Paying</div><div class="value num">${counts.paid}</div></div>
      <div class="kpi"><div class="label">On trial</div><div class="value num">${counts.trial}</div></div>
      <div class="kpi"><div class="label">Need attention</div><div class="value num ${counts.attention ? 'err-text' : ''}">${counts.attention}</div><div class="sub">ending, grace or expired</div></div>
    </div>
    <div class="admin-tools">
      <input id="search" type="search" placeholder="Search shop or email…" value="${esc(query)}" aria-label="Search shops">
      <button class="btn" data-act="reload">Refresh</button>
    </div>
    <div id="shopList">${list.length ? list.map(shopCard).join('') : '<div class="empty">No shops found.</div>'}</div>
    <div class="section-title">Recent changes</div>
    <div class="card audit">${audit.length ? `<table class="list-table">${audit.map(a => `<tr>
        <td>${esc(fmtWhen(a.at))}</td><td>${esc(a.shop_name)}</td><td>${esc(a.action)}</td>
        <td>${esc(fmtDay(a.old_until))} → <strong>${esc(a.new_until ? fmtDay(a.new_until) : 'no end date')}</strong></td></tr>`).join('')}</table>`
      : '<p class="small muted">No changes yet.</p>'}</div>`;
}

function shopCard(s) {
  const [k, label] = statusOf(s);
  const id = esc(s.shop_id);
  return `<div class="card shop-card">
    <div>
      <h3>${esc(s.shop_name)}<span class="st st-${k}">${esc(label)}</span></h3>
      <div class="shop-meta">${esc(s.email)} · joined ${esc(fmtDay(String(s.created_at || '').slice(0, 10)))}</div>
      <div class="shop-meta">Paid until <strong>${esc(s.active_until ? fmtDay(s.active_until) : 'no end date')}</strong> · ${s.tills} till${s.tills === 1 ? '' : 's'} · last activity ${esc(fmtWhen(s.last_seen))}</div>
    </div>
    <div class="shop-actions">
      <button class="btn sm primary" data-act="add" data-id="${id}" data-m="1">+1 month</button>
      <button class="btn sm" data-act="add" data-id="${id}" data-m="3">+3</button>
      <button class="btn sm" data-act="add" data-id="${id}" data-m="12">+12</button>
      <input type="date" data-date="${id}" aria-label="Paid until date for ${esc(s.shop_name)}" value="${esc(s.active_until || '')}">
      <button class="btn sm" data-act="set" data-id="${id}">Set date</button>
      <button class="btn sm" data-act="noend" data-id="${id}">No end date</button>
    </div>
  </div>`;
}

async function loadData() {
  [shops, audit] = await Promise.all([rpc('vendor_list_shops'), rpc('vendor_audit_log', { p_limit: 30 })]);
  showDashboard();
}

/* ----- Flow ----- */

/** After a password sign-in (or on page load with a saved session): admins go to the shop list. */
async function continueSignIn() {
  const who = await rpc('vendor_whoami');
  if (!who?.admin) return signOut('This login is not a Rails POS admin.');
  startIdleTimer();
  return loadData();
}

function shopName(id) { return shops.find(s => s.shop_id === id)?.shop_name || 'this shop'; }

async function act(el) {
  const a = el.dataset.act;
  const id = el.dataset.id;
  try {
    if (a === 'logout') return signOut('Signed out.');
    if (a === 'reload') { await loadData(); return toast('Up to date'); }
    if (a === 'add') {
      const m = Number(el.dataset.m);
      if (!confirm(`Add ${m} month${m > 1 ? 's' : ''} to ${shopName(id)}?`)) return;
      const until = await rpc('vendor_add_months', { p_shop: id, p_months: m });
      await loadData();
      return toast(`${shopName(id)} is paid until ${fmtDay(until)}`);
    }
    if (a === 'set') {
      const v = document.querySelector(`[data-date="${CSS.escape(id)}"]`)?.value;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(v || '')) return toast('Choose a date first', true);
      if (!confirm(`Set ${shopName(id)} as paid until ${fmtDay(v)}?`)) return;
      await rpc('vendor_set_until', { p_shop: id, p_until: v, p_action: 'set date' });
      await loadData();
      return toast('Saved');
    }
    if (a === 'noend') {
      if (!confirm(`Give ${shopName(id)} NO end date (never expires)?`)) return;
      await rpc('vendor_set_until', { p_shop: id, p_until: null, p_action: 'no end date' });
      await loadData();
      return toast('Saved: no end date');
    }
  } catch (e) {
    handleError(e);
  }
}

function handleError(e) {
  if (/Signed out|JWT|expired/i.test(e.message) || e.status === 401) return signOut('Please sign in again.');
  toast(e.message, true);
}

/* Sign out after 15 minutes without activity. */
function startIdleTimer() {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => signOut('Signed out after 15 minutes without activity.'), IDLE_MS);
}

/* ----- Events ----- */

document.addEventListener('submit', async e => {
  e.preventDefault();
  const btn = e.target.querySelector('button[type="submit"]');
  if (btn) btn.disabled = true;
  try {
    if (e.target.id === 'loginForm') {
      const email = $('#aEmail').value.trim();
      const password = $('#aPass').value;
      if (!email || !password) return setErr('Enter the admin email and password');
      const d = await api('/auth/v1/token?grant_type=password', { method: 'POST', body: { email, password }, auth: false });
      setSession(d);
      await continueSignIn();
    }
  } catch (err) {
    if ($('#err')) setErr(err.message); else handleError(err);
  } finally {
    if (btn?.isConnected) btn.disabled = false;
  }
});
document.addEventListener('click', e => {
  const el = e.target.closest('[data-act]');
  if (el) { e.preventDefault(); act(el); }
});
document.addEventListener('input', e => {
  if (e.target.id === 'search') {
    query = e.target.value;
    const pos = e.target.selectionStart;
    showDashboard();
    const s = $('#search'); s.focus(); s.setSelectionRange(pos, pos);
  }
});
['click', 'keydown', 'touchstart'].forEach(ev => document.addEventListener(ev, () => { if (session && shops.length) startIdleTimer(); }, { passive: true }));

// Start: resume a session from this tab, or ask to sign in.
if (session) continueSignIn().catch(() => signOut());
else showLogin();
window.__admin = { get session() { return session; }, get shops() { return shops; } };
