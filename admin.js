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

/* Prices in cents (set by the owner on 2026-11-21). Change them here. */
const PRICES = { monthly: 38000, device: 5000, setup: 150000, profit: 15000 }; // profit: Profit checker add-on (set 2026-11-23)
// Your details printed on invoices and receipts (trading name, contact, bank details).
// Kept only in this browser — never in the code, because the code is public.
const INVOICE_KEY = 'rails-pos-admin-invoice';
const INVOICE_DEFAULTS = { name: 'Rails POS', contact: 'WhatsApp 073 314 2884', bank: '', footer: 'Thank you for using Rails POS.' };
function invoiceDetails() {
  try { return { ...INVOICE_DEFAULTS, ...JSON.parse(localStorage.getItem(INVOICE_KEY) || '{}') }; } catch { return { ...INVOICE_DEFAULTS }; }
}

/* Billing: R380 a month for the first device, R50 for each extra device.
   Devices = the number the supplier set for the shop, or else the devices
   that synced in the last 30 days (at least 1). */
const devicesUsed = s => Math.max(1, Number(s.devices_30d ?? s.tills ?? 1) || 1);
const devicesBilled = s => Number(s.billed_devices) || devicesUsed(s);
const feeOf = s => PRICES.monthly + PRICES.device * (devicesBilled(s) - 1);

/* Profit checker add-on (v39): R150 a month on top. The shop can start a 14-day
   trial itself (once, on a paid plan); you set the trial date, turn it on (paid
   until a date, or no end) or block it. A block reaches open tills within ~20 s. */
const profitOn = s => !!s.profit_paid && !s.profit_blocked;                   // billed every month
const profitFee = s => (profitOn(s) ? PRICES.profit : 0);
/** Tick "Profit checker" on payments and invoices when the shop pays for it or has tried it. */
const profitSuggested = s => !s.profit_blocked && (!!s.profit_paid || !!s.profit_trial_until);
function profitStatusOf(s) {
  const today = isoDay(new Date());
  const left = d => Math.round((new Date(d + 'T12:00:00') - new Date(today + 'T12:00:00')) / 864e5);
  if (s.profit_blocked) return ['off', 'Blocked'];
  if (s.profit_paid && (!s.profit_until || s.profit_until >= today)) return ['paid', s.profit_until ? `On · paid until ${fmtDay(s.profit_until)}` : 'On · no end date'];
  if (s.profit_trial_until && s.profit_trial_until >= today) {
    const n = left(s.profit_trial_until);
    return [n <= 3 ? 'ending' : 'trial', `Trial until ${fmtDay(s.profit_trial_until)} (${n === 0 ? 'last day' : `${n} day${n === 1 ? '' : 's'} left`})`];
  }
  if (s.profit_paid) return ['expired', `Ended ${fmtDay(s.profit_until)}`];
  if (s.profit_trial_until) return ['expired', `Trial ended ${fmtDay(s.profit_trial_until)}`];
  return ['none', s.plan === 'paid' ? 'Off · the shop can start its free trial' : 'Off · free trial once the POS is paid'];
}
/** Whole months between two YYYY-MM-DD dates (at least 1). */
function monthsBetween(from, to) {
  const a = new Date(from + 'T12:00:00'), b = new Date(to + 'T12:00:00');
  return Math.max(1, Math.round((b - a) / (30.44 * 864e5)));
}
const addMonths = (iso, n) => { const d = new Date(iso + 'T12:00:00'); d.setMonth(d.getMonth() + n); return isoDay(d); };
const addDays = (iso, n) => { const d = new Date(iso + 'T12:00:00'); d.setDate(d.getDate() + n); return isoDay(d); };

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

const randStr = c => 'R' + (Number(c || 0) / 100).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');

function statusOf(s) {
  const today = isoDay(new Date());
  if (s.deactivated) return ['off', 'Deactivated · selling paused'];
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
  const counts = { paid: 0, trial: 0, attention: 0, off: 0 };
  shops.forEach(s => {
    const [k] = statusOf(s);
    if (k === 'paid' || k === 'noend') counts.paid++; else if (k === 'trial') counts.trial++; else if (k === 'off') counts.off++; else counts.attention++;
  });
  const month = shops.reduce((a, s) => a + Number(s.paid_this_month || 0), 0);
  const total = shops.reduce((a, s) => a + Number(s.paid_total || 0), 0);
  const paying = shops.filter(s => !s.deactivated && s.plan === 'paid');
  const expected = paying.reduce((a, s) => a + feeOf(s) + profitFee(s), 0);
  const withProfit = paying.filter(profitOn).length;
  $('#root').innerHTML = `
    <div class="admin-kpis">
      <div class="kpi"><div class="label">Shops</div><div class="value num">${shops.length}</div><div class="sub">${counts.paid} paying · ${counts.trial} on trial</div></div>
      <div class="kpi"><div class="label">Paid this month</div><div class="value money">${randStr(month)}</div><div class="sub">all time ${randStr(total)}</div></div>
      <div class="kpi"><div class="label">Monthly fees</div><div class="value money" data-k="expected">${randStr(expected)}</div><div class="sub">${paying.length} paying shop${paying.length === 1 ? '' : 's'}${withProfit ? ` · ${withProfit} with Profit checker` : ''}</div></div>
      <div class="kpi"><div class="label">Need attention</div><div class="value num ${counts.attention ? 'err-text' : ''}">${counts.attention}</div><div class="sub">ending, grace or expired</div></div>
      <div class="kpi"><div class="label">Deactivated</div><div class="value num">${counts.off}</div></div>
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
      : '<p class="small muted">No changes yet.</p>'}</div>
    ${invoiceDetailsCard()}`;
}

/** Your details for invoices and receipts (saved in this browser only). */
function invoiceDetailsCard() {
  const d = invoiceDetails();
  return `<div class="section-title">Your details on invoices &amp; receipts</div>
    <form class="card inv-details" id="invDetails" novalidate>
      <div class="grid-2">
        <label class="field"><span>Name on invoices</span><input name="name" class="input" maxlength="80" value="${esc(d.name)}"></label>
        <label class="field"><span>Contact</span><input name="contact" class="input" maxlength="120" value="${esc(d.contact)}"></label>
      </div>
      <label class="field"><span>Bank details for EFT (bank, account name, number, branch code)</span><textarea name="bank" class="plain" rows="3" maxlength="400">${esc(d.bank)}</textarea></label>
      <label class="field"><span>Footer line</span><input name="footer" class="input" maxlength="160" value="${esc(d.footer)}"></label>
      <p class="small muted">Saved in this browser only (the code is public, so your bank details are never put in it). Prices: ${randStr(PRICES.monthly)} a month, ${randStr(PRICES.device)} per extra device, setup ${randStr(PRICES.setup)}, Profit checker add-on ${randStr(PRICES.profit)} a month.</p>
      <button class="btn" type="submit">Save my details</button>
    </form>`;
}

let openPay = null;      // shop id whose "Record payment" form is open
const payHistory = {};  // shop id → payments (loaded when opened)

function shopCard(s) {
  const [k, label] = statusOf(s);
  const id = esc(s.shop_id);
  const hist = payHistory[s.shop_id];
  return `<div class="card shop-card ${s.deactivated ? 'is-off' : ''}">
    <div>
      <h3>${esc(s.shop_name)}<span class="st st-${k}">${esc(label)}</span></h3>
      <div class="shop-meta">${esc(s.email)} · joined ${esc(fmtDay(String(s.created_at || '').slice(0, 10)))}</div>
      <div class="shop-meta">Paid until <strong>${esc(s.active_until ? fmtDay(s.active_until) : 'no end date')}</strong> · ${s.tills} till${s.tills === 1 ? '' : 's'} · last activity ${esc(fmtWhen(s.last_seen))}${s.online_now != null ? ` · <span class="online ${s.online_now ? 'on' : ''}" data-k="online-${id}">${s.online_now} device${s.online_now === 1 ? '' : 's'} online now</span>` : ''}</div>
      <div class="shop-meta">Fee <strong data-k="fee-${id}">${esc(randStr(feeOf(s)))}</strong> a month · billed for ${devicesBilled(s)} device${devicesBilled(s) === 1 ? '' : 's'}
        (${s.billed_devices ? 'set by you' : 'automatic'}; ${devicesUsed(s)} used in the last 30 days)
        · <button class="link" data-act="devices" data-id="${id}">Change</button></div>
      <div class="shop-meta">Payments: <strong>${esc(randStr(s.paid_total))}</strong> in total${s.last_payment ? ` · last on ${esc(fmtDay(s.last_payment))}` : ''}
        · <button class="link" data-act="history" data-id="${id}">${hist ? 'Hide history' : 'Payment history'}</button></div>
      <div class="shop-meta">Profit checker: <span class="st st-${esc(profitStatusOf(s)[0])}" data-k="profit-${id}">${esc(profitStatusOf(s)[1])}</span>
        · <button class="link" data-act="profit-edit" data-id="${id}">${openProfit === s.shop_id ? 'Close' : 'Change'}</button>
        · ${s.profit_blocked
          ? `<button class="link" data-act="profit-unblock" data-id="${id}">Unblock</button>`
          : `<button class="link danger-text" data-act="profit-block" data-id="${id}">Block now</button>`}</div>
      ${s.deactivated ? `<div class="shop-meta err-text">Deactivated${s.deactivated_reason ? `: ${esc(s.deactivated_reason)}` : ''}</div>` : ''}
    </div>
    <div class="shop-actions">
      <button class="btn sm primary" data-act="pay-open" data-id="${id}">Record payment</button>
      <button class="btn sm" data-act="inv-open" data-id="${id}">Invoice</button>
      <input type="date" data-date="${id}" aria-label="Paid until date for ${esc(s.shop_name)}" value="${esc(s.active_until || '')}">
      <button class="btn sm" data-act="set" data-id="${id}">Set date</button>
      <button class="btn sm" data-act="noend" data-id="${id}">No end date</button>
      ${s.deactivated
        ? `<button class="btn sm primary" data-act="reactivate" data-id="${id}">Reactivate</button>`
        : `<button class="btn sm danger" data-act="deactivate" data-id="${id}">Deactivate</button>`}
    </div>
    ${openPay === s.shop_id ? payForm(s) : ''}
    ${openInv === s.shop_id ? invForm(s) : ''}
    ${openProfit === s.shop_id ? profitForm(s) : ''}
    ${hist ? `<div class="pay-history">${hist.length ? `<table class="list-table"><tr><th>Paid on</th><th>Paid until</th><th>Amount</th><th>Method</th><th>Note</th><th></th></tr>
      ${hist.map((p, i) => `<tr><td>${esc(fmtDay(p.paid_on))}</td><td>${esc(p.paid_until ? fmtDay(p.paid_until) : p.months ? `+${p.months} month${p.months > 1 ? 's' : ''}` : '')}</td><td>${esc(randStr(p.amount_cents))}</td><td>${esc(p.method || '')}</td><td>${esc(p.note || '')}</td>
        <td><button class="btn sm" data-act="receipt" data-id="${id}" data-i="${i}">Receipt</button></td></tr>`).join('')}</table>`
      : '<p class="small muted">No payments recorded yet.</p>'}</div>` : ''}
  </div>`;
}

let openProfit = null; // shop id whose "Profit checker" form is open

/** Inline form: everything about the Profit checker add-on for one shop. */
function profitForm(s) {
  const id = esc(s.shop_id);
  const today = isoDay(new Date());
  return `<form class="pay-form" data-profit-form="${id}" novalidate>
    <label class="field"><span>Free trial until (empty = trial not started)</span><input type="date" name="trial" class="input" value="${esc(s.profit_trial_until || '')}"></label>
    <label class="check pay-note"><input type="checkbox" name="paid" ${s.profit_paid ? 'checked' : ''}><span>On (paid, ${esc(randStr(PRICES.profit))} a month)</span></label>
    <label class="field"><span>Paid until (empty = no end date)</span><input type="date" name="until" class="input" value="${esc(s.profit_until || (s.profit_paid ? '' : (s.active_until && s.active_until >= today ? s.active_until : '')))}"></label>
    <label class="check pay-note"><input type="checkbox" name="blocked" ${s.profit_blocked ? 'checked' : ''}><span>Blocked: switched off on all the shop's devices, whatever the dates say</span></label>
    <p class="small muted pay-hint">The shop's open tills pick up a change within about 20 seconds. Tip: when you record a payment, tick "Profit checker" there and it is turned on until the same date.</p>
    <div class="row gap-s"><button class="btn primary" type="submit">Save Profit checker</button><button class="btn" type="button" data-act="profit-edit" data-id="${id}">Cancel</button></div>
  </form>`;
}

async function setProfit(s, { trial = s.profit_trial_until || null, paid = !!s.profit_paid, until = s.profit_until || null, blocked = !!s.profit_blocked }, action) {
  await rpc('vendor_set_profit', { p_shop: s.shop_id, p_trial_until: trial, p_paid: paid, p_until: paid ? until : null, p_blocked: blocked, p_action: action });
}

async function saveProfit(form) {
  const s = shops.find(x => x.shop_id === form.dataset.profitForm);
  if (!s) return;
  const f = new FormData(form);
  const trial = String(f.get('trial') || '') || null;
  const until = String(f.get('until') || '') || null;
  const paid = !!f.get('paid'), blocked = !!f.get('blocked');
  if (trial && !/^\d{4}-\d{2}-\d{2}$/.test(trial)) return toast('Choose a trial date, or leave it empty', true);
  if (until && !/^\d{4}-\d{2}-\d{2}$/.test(until)) return toast('Choose a paid-until date, or leave it empty', true);
  const what = blocked ? 'blocked' : paid ? `on, ${until ? `paid until ${fmtDay(until)}` : 'no end date'}` : trial ? `trial until ${fmtDay(trial)}` : 'off';
  if (!confirm(`Profit checker for ${shopName(s.shop_id)}: ${what}?`)) return;
  await setProfit(s, { trial, paid, until, blocked }, `Profit checker: ${what}`);
  openProfit = null;
  await loadData();
  toast(`Saved. ${shopName(s.shop_id)}'s Profit checker: ${what}`);
}

/** Inline form: record a subscription payment, which may be backdated. */
/** Suggested paid-until: one month after the later of today and the current end date. */
function suggestUntil(s) {
  const today = isoDay(new Date());
  const from = s.active_until && s.active_until > today ? s.active_until : today;
  const d = new Date(from + 'T12:00:00');
  d.setMonth(d.getMonth() + 1);
  return isoDay(d);
}

/** Amount for a payment: the monthly fee × the months it covers (+ the setup fee if ticked). */
function suggestedAmount(s, until, setup, profit = false) {
  const today = isoDay(new Date());
  const from = s.active_until && s.active_until > today ? s.active_until : today;
  const months = until > from ? monthsBetween(from, until) : 1;
  return { months, profit, cents: (feeOf(s) + (profit ? PRICES.profit : 0)) * months + (setup ? PRICES.setup : 0) };
}

function payForm(s) {
  const id = esc(s.shop_id);
  const today = isoDay(new Date());
  const until = suggestUntil(s);
  const sug = suggestedAmount(s, until, false, profitSuggested(s));
  return `<form class="pay-form" data-pay-form="${id}" novalidate>
    <label class="field"><span>Paid on (can be in the past)</span><input type="date" name="paid_on" class="input" value="${today}" max="${today}"></label>
    <label class="field"><span>Paid until (you choose)</span><input type="date" name="paid_until" class="input" value="${until}" min="${today}"></label>
    <label class="field"><span>Amount (R)</span><input name="amount" class="input" inputmode="decimal" value="${(sug.cents / 100).toFixed(2)}"></label>
    <label class="field"><span>Method</span><select name="method"><option>EFT</option><option>Cash</option><option>Card</option><option>Other</option></select></label>
    <label class="check pay-note"><input type="checkbox" name="setup"><span>Includes the once-off setup fee (${esc(randStr(PRICES.setup))}, with 1 hour training)</span></label>
    <label class="check pay-note"><input type="checkbox" name="profit" ${profitSuggested(s) ? 'checked' : ''} ${s.profit_blocked ? 'disabled' : ''}><span>Includes the Profit checker add-on (${esc(randStr(PRICES.profit))} a month): turns it on until the same date${s.profit_blocked ? ' (blocked: unblock it first)' : ''}</span></label>
    <label class="field pay-note"><span>Note (optional)</span><input name="note" class="input" maxlength="200" placeholder="e.g. invoice number"></label>
    <p class="small muted pay-hint" data-pay-hint>${payHint(s, sug)}</p>
    <div class="row gap-s"><button class="btn primary" type="submit">Save payment</button><button class="btn" type="button" data-act="pay-close">Cancel</button></div>
  </form>`;
}

const payHint = (s, sug) => {
  const monthly = feeOf(s) + (sug.profit ? PRICES.profit : 0);
  return `Suggested: ${sug.months} month${sug.months === 1 ? '' : 's'} × ${randStr(monthly)}${sug.profit ? ` (incl. Profit checker ${randStr(PRICES.profit)})` : ''}${sug.cents > monthly * sug.months ? ` + setup ${randStr(PRICES.setup)}` : ''} = <strong>${randStr(sug.cents)}</strong>. The shop can sell up to and including the “Paid until” date.`;
};

/** Keep the suggested amount in step with the dates (until the amount is typed by hand). */
function onPayFormChange(form, target) {
  const s = shops.find(x => x.shop_id === form.dataset.payForm);
  if (!s) return;
  if (target.name === 'amount') { form.dataset.typed = '1'; return; }
  const f = new FormData(form);
  const until = String(f.get('paid_until') || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(until)) return;
  const sug = suggestedAmount(s, until, !!f.get('setup'), !!f.get('profit'));
  if (!form.dataset.typed) form.querySelector('[name="amount"]').value = (sug.cents / 100).toFixed(2);
  form.querySelector('[data-pay-hint]').innerHTML = payHint(s, sug);
}

/* ----- Invoices and receipts (A4, printed from this page) ----- */

let openInv = null; // shop id whose "Invoice" form is open

function invForm(s) {
  const id = esc(s.shop_id);
  const firstPaid = !Number(s.paid_total);
  return `<form class="pay-form" data-inv-form="${id}" novalidate>
    <label class="field"><span>Months</span><select name="months">${[1, 2, 3, 6, 12].map(m => `<option value="${m}">${m} month${m > 1 ? 's' : ''}</option>`).join('')}</select></label>
    <label class="field"><span>Due date</span><input type="date" name="due" class="input" value="${esc(s.active_until && s.active_until > isoDay(new Date()) ? s.active_until : isoDay(new Date()))}"></label>
    <label class="check pay-note"><input type="checkbox" name="setup" ${firstPaid ? 'checked' : ''}><span>Add the once-off setup fee (${esc(randStr(PRICES.setup))}, with 1 hour training)</span></label>
    <label class="check pay-note"><input type="checkbox" name="profit" ${profitSuggested(s) ? 'checked' : ''}><span>Add the Profit checker add-on (${esc(randStr(PRICES.profit))} a month)</span></label>
    <p class="small muted pay-hint">${devicesBilled(s)} device${devicesBilled(s) === 1 ? '' : 's'} · ${esc(randStr(feeOf(s)))} a month. The period starts the day after the current paid-until date (or today).</p>
    <div class="row gap-s"><button class="btn primary" type="submit">Print invoice</button><button class="btn" type="button" data-act="inv-close">Cancel</button></div>
  </form>`;
}

function docHead(title, no, dateIso) {
  const d = invoiceDetails();
  return `<header class="inv-head">
      <div><div class="inv-brand">${esc(d.name)}</div><div class="inv-small">${esc(d.contact)}</div></div>
      <div class="inv-title"><h1>${esc(title)}</h1><div>No. <b>${esc(no)}</b></div><div>Date: ${esc(fmtDay(dateIso))}</div></div>
    </header>`;
}
function docFoot(extra = '') {
  const d = invoiceDetails();
  return `${d.bank ? `<section class="inv-bank"><h2>Banking details (EFT)</h2><pre>${esc(d.bank)}</pre></section>` : ''}
    ${extra}
    <p class="inv-small">Not registered for VAT — no VAT is charged. Subscription terms: Rails POS app → Settings → Terms.</p>
    <p class="inv-foot">${esc(d.footer)}</p>`;
}
function billTo(s) {
  return `<section class="inv-to"><h2>Bill to</h2><b>${esc(s.shop_name)}</b><br>${esc(s.email || '')}</section>`;
}

function printInvoice(form) {
  const s = shops.find(x => x.shop_id === form.dataset.invForm);
  if (!s) return;
  const f = new FormData(form);
  const months = Math.max(1, Math.min(12, Number(f.get('months')) || 1));
  const due = String(f.get('due') || isoDay(new Date()));
  const today = isoDay(new Date());
  const start = s.active_until && s.active_until >= today ? addDays(s.active_until, 1) : today;
  const end = addDays(addMonths(start, months), -1);
  const dev = devicesBilled(s);
  const lines = [[`Rails POS subscription — ${months} month${months > 1 ? 's' : ''} (${fmtDay(start)} to ${fmtDay(end)})`, months, PRICES.monthly]];
  if (dev > 1) lines.push([`Extra device${dev > 2 ? 's' : ''} (${dev - 1}) — ${months} month${months > 1 ? 's' : ''}`, months * (dev - 1), PRICES.device]);
  if (f.get('profit')) lines.push([`Profit checker add-on — ${months} month${months > 1 ? 's' : ''}`, months, PRICES.profit]);
  if (f.get('setup')) lines.push(['Once-off setup: shop, staff logins and stock loaded, plus 1 hour training', 1, PRICES.setup]);
  const total = lines.reduce((a, [, q, p]) => a + q * p, 0);
  const no = `INV-${today.replace(/-/g, '')}-${String(s.shop_id).replace(/[^a-z0-9]/gi, '').slice(0, 4).toUpperCase()}`;
  printDoc(`${docHead('INVOICE', no, today)}
    ${billTo(s)}
    <table class="inv-lines"><tr><th>Description</th><th class="r">Qty</th><th class="r">Price</th><th class="r">Amount</th></tr>
      ${lines.map(([d, q, p]) => `<tr><td>${esc(d)}</td><td class="r">${q}</td><td class="r">${esc(randStr(p))}</td><td class="r">${esc(randStr(q * p))}</td></tr>`).join('')}
      <tr class="tot"><td colspan="3">Total due</td><td class="r">${esc(randStr(total))}</td></tr></table>
    <p><b>Please pay by ${esc(fmtDay(due))}.</b> Use <b>${esc(no)}</b> as the payment reference.</p>
    ${docFoot()}`);
}

function printReceipt(id, i) {
  const s = shops.find(x => x.shop_id === id);
  const p = payHistory[id]?.[i];
  if (!s || !p) return;
  const no = p.id != null ? `RP-${String(p.id).padStart(6, '0')}` : `RP-${String(p.paid_on).replace(/-/g, '')}`;
  printDoc(`${docHead('PAYMENT RECEIPT', no, p.paid_on)}
    <section class="inv-to"><h2>Received from</h2><b>${esc(s.shop_name)}</b><br>${esc(s.email || '')}</section>
    <table class="inv-lines">
      <tr><td>Amount received</td><td class="r"><b>${esc(randStr(p.amount_cents))}</b></td></tr>
      <tr><td>Date paid</td><td class="r">${esc(fmtDay(p.paid_on))}</td></tr>
      <tr><td>Payment method</td><td class="r">${esc(p.method || '')}</td></tr>
      <tr><td>For</td><td class="r">Rails POS subscription${p.paid_until ? `, paid until ${esc(fmtDay(p.paid_until))}` : ''}</td></tr>
      ${p.note ? `<tr><td>Note</td><td class="r">${esc(p.note)}</td></tr>` : ''}
    </table>
    <p class="inv-paid">PAID — thank you</p>
    ${docFoot()}`);
}

/** Put a document in the print area and open the print window (choose a printer or "Save as PDF"). */
function printDoc(html) {
  let area = $('#printDoc');
  if (!area) { area = document.createElement('div'); area.id = 'printDoc'; area.className = 'print-a4 inv'; document.body.append(area); }
  area.innerHTML = html;
  document.body.classList.add('printing-a4');
  const done = () => { document.body.classList.remove('printing-a4'); removeEventListener('afterprint', done); };
  addEventListener('afterprint', done);
  window.print();
}

async function savePayment(form) {
  const id = form.dataset.payForm;
  const f = new FormData(form);
  const paidOn = String(f.get('paid_on') || '');
  const until = String(f.get('paid_until') || '');
  const amountTxt = String(f.get('amount') || '').replace(/[R\s]/gi, '').replace(',', '.');
  const amount = Math.round(Number(amountTxt) * 100);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(paidOn)) return toast('Choose the date it was paid', true);
  if (paidOn > isoDay(new Date())) return toast('The payment date can\'t be in the future', true);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(until)) return toast('Choose the paid-until date', true);
  if (until < paidOn) return toast('Paid until must be on or after the payment date', true);
  if (!amountTxt || !Number.isFinite(amount) || amount < 0) return toast('Enter the amount paid', true);
  let note = String(f.get('note') || '').trim();
  if (f.get('setup') && !/setup/i.test(note)) note = (note ? note + ' · ' : '') + 'incl. setup fee';
  const withProfit = !!f.get('profit');
  if (withProfit && !/profit/i.test(note)) note = (note ? note + ' · ' : '') + 'incl. Profit checker';
  f.set('note', note);
  if (!confirm(`Record ${randStr(amount)} paid on ${fmtDay(paidOn)}, paid until ${fmtDay(until)}, for ${shopName(id)}?${withProfit ? `\n\nThe Profit checker add-on is turned on until ${fmtDay(until)} too.` : ''}`)) return;
  await rpc('vendor_record_payment_until', {
    p_shop: id, p_paid_on: paidOn, p_until: until, p_amount_cents: amount,
    p_method: String(f.get('method') || ''), p_note: String(f.get('note') || '').trim(),
  });
  const s = shops.find(x => x.shop_id === id);
  if (withProfit && s) await setProfit(s, { paid: true, until, blocked: false }, `Profit checker: paid until ${fmtDay(until)}`);
  openPay = null;
  if (payHistory[id]) payHistory[id] = await rpc('vendor_shop_payments', { p_shop: id });
  await loadData();
  toast(`Payment saved. ${shopName(id)} is paid until ${fmtDay(until)}`);
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
    if (a === 'pay-open') { openPay = openPay === id ? null : id; openInv = null; showDashboard(); return document.querySelector('[name="amount"]')?.focus(); }
    if (a === 'pay-close') { openPay = null; return showDashboard(); }
    if (a === 'inv-open') { openInv = openInv === id ? null : id; openPay = null; return showDashboard(); }
    if (a === 'inv-close') { openInv = null; return showDashboard(); }
    if (a === 'receipt') return printReceipt(id, Number(el.dataset.i));
    if (a === 'profit-edit') { openProfit = openProfit === id ? null : id; openPay = openInv = null; return showDashboard(); }
    if (a === 'profit-block' || a === 'profit-unblock') {
      const s = shops.find(x => x.shop_id === id);
      const block = a === 'profit-block';
      if (!confirm(block
        ? `Block the Profit checker for ${shopName(id)} now?\n\nIt closes on their devices within about 20 seconds, whatever the trial or paid dates say. You can unblock any time.`
        : `Unblock the Profit checker for ${shopName(id)}? It works again if their trial or paid date is still running.`)) return;
      await setProfit(s, { blocked: block }, block ? 'Profit checker: blocked' : 'Profit checker: unblocked');
      await loadData();
      return toast(block ? `Profit checker blocked for ${shopName(id)}` : `Profit checker unblocked for ${shopName(id)}`);
    }
    if (a === 'devices') {
      const s = shops.find(x => x.shop_id === id);
      const v = prompt(`How many devices should ${shopName(id)} be billed for?\n\n${devicesUsed(s)} used in the last 30 days. Leave empty to count automatically.\n(${randStr(PRICES.monthly)} a month for the first device, ${randStr(PRICES.device)} for each extra one.)`, s.billed_devices ? String(s.billed_devices) : '');
      if (v === null) return;
      const n = v.trim() === '' ? null : parseInt(v, 10);
      if (n !== null && !(n >= 1 && n <= 50)) return toast('Enter 1 to 50, or leave it empty', true);
      await rpc('vendor_set_devices', { p_shop: id, p_devices: n });
      await loadData();
      return toast(n ? `${shopName(id)}: billed for ${n} device${n > 1 ? 's' : ''}` : `${shopName(id)}: devices counted automatically`);
    }
    if (a === 'history') {
      if (payHistory[id]) delete payHistory[id];
      else payHistory[id] = await rpc('vendor_shop_payments', { p_shop: id });
      return showDashboard();
    }
    if (a === 'deactivate') {
      const reason = prompt(`Deactivate ${shopName(id)}?\n\nSelling pauses on all their devices (their data is kept, and you can reactivate any time).\n\nReason (optional, they will see it):`, '');
      if (reason === null) return;
      await rpc('vendor_set_active', { p_shop: id, p_active: false, p_reason: reason.trim() });
      await loadData();
      return toast(`${shopName(id)} deactivated. Their devices pause selling at the next sync.`);
    }
    if (a === 'reactivate') {
      if (!confirm(`Reactivate ${shopName(id)}? Selling works again at their next sync.`)) return;
      await rpc('vendor_set_active', { p_shop: id, p_active: true, p_reason: '' });
      await loadData();
      return toast(`${shopName(id)} reactivated`);
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
    if (e.target.dataset.payForm) await savePayment(e.target);
    if (e.target.dataset.invForm) printInvoice(e.target);
    if (e.target.dataset.profitForm) await saveProfit(e.target);
    if (e.target.id === 'invDetails') {
      const f = new FormData(e.target);
      const d = Object.fromEntries(['name', 'contact', 'bank', 'footer'].map(k => [k, String(f.get(k) || '').trim()]));
      try { localStorage.setItem(INVOICE_KEY, JSON.stringify(d)); toast('Saved in this browser'); } catch { toast('Could not save in this browser', true); }
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
  const pf = e.target.closest?.('[data-pay-form]');
  if (pf) return onPayFormChange(pf, e.target);
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
