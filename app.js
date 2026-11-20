/* =========================================================================
   Rails POS — offline-first point of sale for small clothing stores (ZA)

   File map (search for the ===== headings):
     0. Config
     1. Utilities           money, escaping, ids, dates
     2. Storage             IndexedDB, one record per product / sale
     3. State & loading
     4. Demo data
     5. Catalogue helpers   variants, prices, SKUs
     6. Cart                saved to the device on every change
     7. Checkout            sales, tax invoices over R5 000
     8. Returns             partial returns, credit notes, exchanges
     9. Stock               adjustments, deliveries, movement history
    10. Reports & cash-up
    11. Documents           receipt / credit note / Z-report text, WhatsApp, print
    12. UI helpers          modal, confirm, toast, banners, focus handling
    13. Views               sell, cart, stock, sales, reports, settings
    14. Backup / restore / CSV
    15. One tab at a time   (Web Locks)
    16. Service worker      install + "new version" prompt
    17. Events & boot

   Money is ALWAYS integer cents. Prices are VAT-inclusive.
   Places where future features plug in are marked "PLUG-IN:".
   ========================================================================= */
'use strict';

/* ===== 0. Config ======================================================== */

/** index.html?test uses a separate database so tests never touch real data. */
const TEST_MODE = new URLSearchParams(location.search).has('test');
const TEST_DEVICE = new URLSearchParams(location.search).get('test'); // ?test=b = a second test "device"
const DB_NAME = TEST_MODE ? 'rails-pos-test' + (TEST_DEVICE && TEST_DEVICE !== '1' ? '-' + TEST_DEVICE : '') : 'rails-pos';

/** Cloud sync (Supabase). The URL and the public "anon" key are meant to be
    inside the app — the database's row-level security keeps each shop's
    data private to that shop's login. Leave empty to turn cloud sync off. */
const CLOUD = {
  url: 'https://dwayjgzfewuiaayixlmb.supabase.co',
  key: 'sb_publishable_O4YjTjP8eu34O7yxGCq3aQ_jsZ0CyCw', // publishable key (safe to be public)
};
if (TEST_MODE) CLOUD.url = ''; // tests never touch the real database (they use a fake one)
/** SARS: a tax invoice for more than R5 000 must show the buyer's name and address. */
const FULL_TAX_INVOICE_OVER = 500000;

/* ===== 1. Utilities ===================================================== */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

/** Escape any user-entered text before it goes into HTML. */
function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, ch => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[ch]));
}

/** 123456 -> "R1 234.56" (SA style: space as thousands separator). */
function money(cents) {
  const neg = cents < 0;
  const abs = Math.abs(Math.round(cents));
  const rands = Math.floor(abs / 100).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  return (neg ? '-R' : 'R') + rands + '.' + String(abs % 100).padStart(2, '0');
}
const centsToPlain = cents => (cents / 100).toFixed(2);

/** Parse what a person types ("R 199,99", "199.9", "200") into cents. NaN if invalid. */
function parseMoney(str) {
  let s = String(str ?? '').trim().replace(/[R\s]/gi, '');
  if (s === '') return NaN;
  if (!s.includes('.') && /,\d{1,2}$/.test(s)) s = s.replace(',', '.'); // comma decimal
  s = s.replace(/,/g, '');
  if (!/^-?\d*(\.\d*)?$/.test(s)) return NaN;
  const n = Number(s);
  return Number.isFinite(n) ? Math.round(n * 100) : NaN;
}

const uid = (p = '') => p + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const pad = (n, w = 2) => String(n).padStart(w, '0');
const fmtDate = iso => { const d = new Date(iso); return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}`; };
const fmtTime = iso => { const d = new Date(iso); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const fmtDT = iso => `${fmtDate(iso)} ${fmtTime(iso)}`;
const fmtNo = n => pad(n, 5);
/* Document numbers. With cloud sync each device has its own series letter
   (A, B, C…), so two tills can never print the same invoice number. */
const docNo = (n, series) => (series ? series + '-' : '') + fmtNo(n);
const saleNo = s => docNo(s.number, s.series);
const retNo = r => 'CN' + docNo(r.number, r.series);
const zNo = z => docNo(z.number, z.series);
const startOfDay = (d = new Date()) => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; };
const daysAgo = iso => Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);
const splitList = s => String(s || '').split(',').map(x => x.trim()).filter(Boolean);
const sum = (arr, fn) => arr.reduce((a, x) => a + fn(x), 0);
const clone = v => JSON.parse(JSON.stringify(v));
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ===== 2. Storage =======================================================
   IndexedDB database with one record per product / sale / stock movement /
   cash-up, plus a key-value store for settings, meta (counters) and the cart.
   DB.write() applies several changes in ONE transaction, so a sale (the sale,
   its stock changes, movements and the receipt counter) is all-or-nothing.

   Cloud sync: while this device is connected (DB.tracking), every write to
   a synced store also notes its key in the "outbox" store in the SAME
   transaction. The sync engine (section 15c) sends those records to the
   cloud and removes them from the outbox once they have arrived.
   ======================================================================== */

const STORES = ['kv', 'products', 'sales', 'movements', 'cashups', 'outbox'];
const SYNC_STORES = ['products', 'sales', 'movements', 'cashups'];
const SYNC_KV = ['settings', 'auth']; // shared by all devices (meta, cart and cloud login stay per device)

/** "sales:s123" for an op that must be sent to the cloud, else null. */
function syncKey(o) {
  if (o.store === 'kv') return SYNC_KV.includes(o.key) ? `kv:${o.key}` : null;
  if (!SYNC_STORES.includes(o.store)) return null;
  return `${o.store}:${o.del ? o.key : o.value.id}`;
}

const DB = (() => {
  let dbPromise = null;

  function open() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      if (!('indexedDB' in window)) return reject(new Error('This browser cannot store data (IndexedDB missing).'));
      const req = indexedDB.open(DB_NAME, 3);
      req.onupgradeneeded = e => {
        const db = req.result;
        const tx = req.transaction;
        if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
        if (!db.objectStoreNames.contains('products')) db.createObjectStore('products', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('sales')) db.createObjectStore('sales', { keyPath: 'id' }).createIndex('date', 'date');
        if (!db.objectStoreNames.contains('movements')) db.createObjectStore('movements', { keyPath: 'id' }).createIndex('productId', 'productId');
        if (!db.objectStoreNames.contains('cashups')) db.createObjectStore('cashups', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('outbox')) db.createObjectStore('outbox', { keyPath: 'key' }); // v3: cloud sync queue
        // Version 1 kept whole arrays in kv — move them into their own stores.
        if (e.oldVersion === 1) {
          const kv = tx.objectStore('kv');
          for (const name of ['products', 'sales']) {
            kv.get(name).onsuccess = ev => {
              (ev.target.result || []).forEach(rec => tx.objectStore(name).put(rec));
              kv.delete(name);
            };
          }
        }
      };
      req.onsuccess = () => {
        const db = req.result;
        db.onversionchange = () => { db.close(); location.reload(); }; // a newer version opened elsewhere
        resolve(db);
      };
      req.onerror = () => reject(req.error);
      req.onblocked = () => toast('Close other Rails POS tabs to finish updating', true);
    });
    return dbPromise;
  }

  const request = (store, mode, fn) => open().then(db => new Promise((resolve, reject) => {
    const r = fn(db.transaction(store, mode).objectStore(store));
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  }));

  const get = (store, key) => request(store, 'readonly', s => s.get(key));
  const getAll = store => request(store, 'readonly', s => s.getAll());
  const getAllByIndex = (store, index, value) => request(store, 'readonly', s => s.index(index).getAll(value));

  /** ops: [{store, value}] put by keyPath, [{store, key, value}] put by key, [{store, key, del: true}] delete.
      opts.remote = these changes came FROM the cloud, so don't queue them to be sent back. */
  async function write(ops, clearFirst = [], opts = {}) {
    const db = await open();
    const track = api.tracking && !opts.remote ? [...new Set(ops.map(syncKey).filter(Boolean))] : [];
    const names = [...new Set([...ops.map(o => o.store), ...clearFirst, ...(track.length ? ['outbox'] : [])])];
    if (!names.length) return;
    await new Promise((resolve, reject) => {
      const tx = db.transaction(names, 'readwrite');
      clearFirst.forEach(n => tx.objectStore(n).clear());
      for (const o of ops) {
        const s = tx.objectStore(o.store);
        if (o.del) s.delete(o.key);
        else if (o.key !== undefined) s.put(clone(o.value), o.key);
        else s.put(clone(o.value));
      }
      // v = a fresh tag, so a push only clears entries that weren't changed again meanwhile
      track.forEach(key => tx.objectStore('outbox').put({ key, v: uid() }));
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
    if (track.length) api.onTracked?.();
  }

  const api = { open, get, getAll, getAllByIndex, write, tracking: false, onTracked: null };
  return api;
})();

/* Small helpers to build write ops */
const opPut = (store, value) => ({ store, value });
const opKv = (key, value) => ({ store: 'kv', key, value });

/** Write ops; on failure tell the user and re-throw so callers can roll back. */
async function persist(ops) {
  try {
    await DB.write(ops);
  } catch (err) {
    console.error(err);
    toast('Could not save! Storage may be full — make a backup now.', true);
    throw err;
  }
}

/** Replace EVERYTHING (start fresh, demo, restore) in one transaction. */
async function persistEverything(movements = []) {
  const ops = [
    opKv('settings', state.settings), opKv('meta', state.meta), opKv('cart', ui.cart),
    ...state.products.map(p => opPut('products', p)),
    ...state.sales.map(s => opPut('sales', s)),
    ...state.cashups.map(c => opPut('cashups', c)),
    ...movements.map(m => opPut('movements', m)),
  ];
  await DB.write(ops, ['products', 'sales', 'movements', 'cashups']);
}

/* ===== 3. State & loading =============================================== */

const DEFAULT_SETTINGS = {
  storeName: 'My Clothing Store',
  storeAddress: '',
  storePhone: '',
  vatRegistered: true,      // false = no VAT on receipts or in reports
  vatNumber: '',
  vatRate: 15,              // percent; prices include VAT
  receiptFooter: 'Thank you for shopping with us!\nExchanges within 7 days with receipt.',
  lowStock: 3,
  theme: 'auto',            // auto | light | dark
  lastBackupAt: null,
  // PLUG-IN: multiple branches — add storeId / branchName here and stamp it on each sale.
};
const DEFAULT_META = {
  schema: 2,
  nextReceiptNo: 1,
  nextCreditNo: 1,          // credit notes (refunds / exchanges)
  nextZNo: 1,               // cash-up (Z) reports
  lastCashupAt: null,       // the current shift started here
  float: 0,                 // cash left in the drawer at the last cash-up
  demo: false,
  installedAt: null,        // when this device was set up (starts the free trial without a cloud account)
};

/*
  Data model
  product:  { id, name, category, price, cost, created, variants: [variant] }
  variant:  { id, size, colour, sku, stock, price?, cost? }   price/cost override the product's
  sale:     { id, number, date, store, customer, items:[item], subtotal, discountType, discountValue,
              discount, total, vatRate, vat, payment, paid, tendered, change,
              creditUsed, creditChange, creditRef, returns:[ret], status }
  item:     { productId, variantId, name, size, colour, sku, qty, unitPrice, unitCost }
  ret:      { id, number, date, method (cash|card|eft|credit), items:[{idx, qty, amount, cost}], amount, vat, cost }
  movement: { id, date, productId, variantId, name, size, colour, sku, change, after, reason, ref }
  cashup:   { id, number, from, to, ...totals, expected, counted, diff, nextFloat }
*/
const state = {
  settings: { ...DEFAULT_SETTINGS },
  meta: { ...DEFAULT_META },
  products: [],
  sales: [],
  cashups: [],
};

/** UI-only state. The cart is saved too (see saveCart) so a flat phone doesn't lose it. */
const ui = {
  view: 'sell',
  category: 'All',
  lowOnly: false,
  reportRange: 'today', // see RANGES
  customFrom: '', customTo: '',
  cart: emptyCart(),
  picker: null,
  ret: null,
  confirmResolve: null,
  opener: null,
  appActive: false,
  updateReady: false,
};

function emptyCart(payment = 'cash') {
  return { lines: [], discountType: 'R', discountText: '', payment, tenderedText: '', credit: null, customer: null };
}

async function loadState() {
  const [settings, meta, cart, products, sales, cashups] = await Promise.all([
    DB.get('kv', 'settings'), DB.get('kv', 'meta'), DB.get('kv', 'cart'),
    DB.getAll('products'), DB.getAll('sales'), DB.getAll('cashups'),
  ]);
  if (!meta) {
    // A brand-new device: start empty; the first-time setup (section 14d)
    // creates the shop, or loads demo data, or joins a synced shop.
    ui.firstRun = true;
    state.settings = { ...DEFAULT_SETTINGS };
    state.meta = { ...DEFAULT_META };
    state.products = []; state.sales = []; state.cashups = [];
    return;
  }
  ui.firstRun = false;
  state.settings = { ...DEFAULT_SETTINGS, ...settings };
  state.meta = { ...DEFAULT_META, ...meta };
  if (!state.meta.installedAt) { // devices set up before licences existed: trial starts now
    state.meta.installedAt = new Date().toISOString();
    await DB.write([opKv('meta', state.meta)]);
  }
  state.products = products.sort((a, b) => (a.created || 0) - (b.created || 0) || a.name.localeCompare(b.name));
  state.sales = sales.map(normalizeSale).sort(byDate);
  state.cashups = cashups.sort((a, b) => (a.to || '').localeCompare(b.to || ''));
  restoreCart(cart);
}

/** Bring older sale records up to the current shape. */
const byDate = (a, b) => a.date.localeCompare(b.date) || a.number - b.number;

function normalizeSale(s) {
  s.returns ||= [];
  s.creditUsed ??= 0;
  s.creditChange ??= 0;
  s.paid ??= s.total - s.creditUsed;
  // Version 1 only knew "whole sale returned".
  if (s.status === 'returned' && !s.returns.length) {
    s.returns.push({
      id: uid('r'), number: 0, date: s.returnedAt || s.date, method: s.payment,
      items: s.items.map((it, idx) => ({ idx, qty: it.qty, amount: it.unitPrice * it.qty, cost: it.unitCost * it.qty })),
      amount: s.total, vat: s.vat, cost: sum(s.items, it => it.unitCost * it.qty),
    });
  }
  s.status = saleStatus(s);
  return s;
}

/* ===== 4. Demo data ===================================================== */

function loadDemoData() {
  const defs = [
    ['Classic Crew T-Shirt', 'Tops', 199, 85, ['S', 'M', 'L', 'XL'], ['White', 'Black', 'Navy']],
    ['Slim Fit Jeans', 'Bottoms', 549, 260, ['30', '32', '34', '36'], ['Indigo', 'Black']],
    ['Hooded Sweater', 'Tops', 449, 210, ['S', 'M', 'L', 'XL'], ['Grey', 'Black']],
    ['Summer Wrap Dress', 'Dresses', 399, 170, ['XS', 'S', 'M', 'L'], ['Floral', 'Red']],
    ['Chino Shorts', 'Bottoms', 299, 130, ['30', '32', '34', '36'], ['Khaki', 'Navy']],
    ['Denim Jacket', 'Outerwear', 799, 390, ['S', 'M', 'L', 'XXL'], ['Blue']],
    ['Sneaker Socks 3-Pack', 'Accessories', 89, 32, ['One Size'], ['White', 'Black']],
    ['Leather Belt', 'Accessories', 249, 95, ['M', 'L'], ['Brown', 'Black']],
  ];
  let seed = 7;
  const rand = () => (seed = (seed * 9301 + 49297) % 233280) / 233280; // deterministic

  state.settings = { ...DEFAULT_SETTINGS, storeName: 'Demo Boutique', storeAddress: '12 Long Street, Cape Town', vatNumber: '4000000000' };
  state.products = [];
  state.cashups = [];
  defs.forEach(([name, category, price, cost, sizes, colours], i) => {
    const product = { id: uid('p'), name, category, price: price * 100, cost: cost * 100, created: i, variants: [] };
    for (const colour of colours) for (const size of sizes) {
      product.variants.push({ id: uid('v'), size, colour, sku: makeSku(name, size, colour, product.variants), stock: Math.floor(rand() * 12) });
    }
    state.products.push(product);
  });
  // Example of a per-variant price: the XXL jacket costs more.
  const xxl = state.products[5].variants.find(v => v.size === 'XXL');
  xxl.price = 89900; xxl.cost = 44000;

  // A couple of weeks of sample sales so Reports has something to show.
  state.sales = [];
  const pays = ['cash', 'cash', 'card', 'card', 'eft'];
  for (let i = 0; i < 24; i++) {
    const when = new Date();
    when.setDate(when.getDate() - Math.floor(rand() * 14));
    when.setHours(9 + Math.floor(rand() * 8), Math.floor(rand() * 60));
    if (when > new Date()) when.setTime(Date.now() - 3600e3);
    const items = [];
    const n = 1 + Math.floor(rand() * 3);
    for (let j = 0; j < n; j++) {
      const p = state.products[Math.floor(rand() * state.products.length)];
      const v = p.variants[Math.floor(rand() * p.variants.length)];
      const existing = items.find(it => it.variantId === v.id);
      if (existing) existing.qty++; else items.push(saleItem(p, v, 1));
    }
    const total = sum(items, it => it.unitPrice * it.qty);
    const payment = pays[Math.floor(rand() * pays.length)];
    const tendered = payment === 'cash' ? Math.ceil(total / 10000) * 10000 : total;
    state.sales.push(normalizeSale({
      id: uid('s'), number: 0, date: when.toISOString(), store: null, customer: null, items,
      subtotal: total, discountType: 'R', discountValue: 0, discount: 0, total,
      vatRate: 15, vat: vatFromInclusive(total, 15), payment, paid: total,
      tendered, change: tendered - total, creditUsed: 0, creditChange: 0, creditRef: null, returns: [],
    }));
  }
  state.sales.sort((a, b) => a.date.localeCompare(b.date));
  state.sales.forEach((s, i) => { s.number = i + 1; });
  state.meta = {
    ...DEFAULT_META, demo: true, nextReceiptNo: state.sales.length + 1,
    lastCashupAt: startOfDay().toISOString(), float: 50000,
  };
  ui.cart = emptyCart();
}

/* ===== 5. Catalogue helpers ============================================= */

const findProduct = id => state.products.find(p => p.id === id);

function findVariant(variantId) {
  for (const product of state.products) {
    const variant = product.variants.find(v => v.id === variantId);
    if (variant) return { product, variant };
  }
  return null;
}

function findBySku(sku) {
  const s = String(sku).trim().toUpperCase();
  if (!s) return null;
  for (const product of state.products) {
    const variant = product.variants.find(v => v.sku.toUpperCase() === s);
    if (variant) return { product, variant };
  }
  return null;
}

/** A variant may override the product price/cost (e.g. XXL costs more). */
const priceOf = (p, v) => v.price ?? p.price;
const costOf = (p, v) => v.cost ?? p.cost;
const productStock = p => sum(p.variants, v => v.stock);

/** Build a readable unique SKU like "CCT-WHI-M". */
function makeSku(name, size, colour, extraVariants = []) {
  const clean = (s, n) => String(s).toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, n) || 'X';
  const words = String(name).split(/\s+/).filter(Boolean);
  const base = words.length > 1 ? words.slice(0, 3).map(w => clean(w, 1)).join('') : clean(name, 3);
  const root = `${base}-${clean(colour, 3)}-${clean(size, 4)}`;
  const taken = new Set(state.products.flatMap(p => p.variants.map(v => v.sku.toUpperCase())));
  extraVariants.forEach(v => taken.add(v.sku.toUpperCase()));
  let sku = root, i = 2;
  while (taken.has(sku)) sku = `${root}-${i++}`;
  return sku;
}

/** VAT portion of a VAT-inclusive amount, in cents. */
function vatFromInclusive(totalCents, ratePercent) {
  const r = Number(ratePercent) || 0;
  return Math.round(totalCents * r / (100 + r));
}
/** The VAT rate to charge right now (0 if the shop is not VAT registered). */
const effectiveRate = () => (state.settings.vatRegistered ? Number(state.settings.vatRate) || 0 : 0);

/** Snapshot a product+variant into a sale line (so later edits don't change history). */
function saleItem(product, variant, qty) {
  return {
    productId: product.id, variantId: variant.id, name: product.name,
    size: variant.size, colour: variant.colour, sku: variant.sku,
    qty, unitPrice: priceOf(product, variant), unitCost: costOf(product, variant),
  };
}

/** Store details are copied onto each sale so old receipts never change. */
function storeSnapshot() {
  const s = state.settings;
  return { name: s.storeName, address: s.storeAddress, phone: s.storePhone, vatRegistered: !!s.vatRegistered, vatNumber: s.vatNumber };
}

/** A stock movement record (audit trail). Call AFTER changing variant.stock. */
function movement(product, variant, change, reason, ref = '') {
  return {
    id: uid('m'), date: new Date().toISOString(), productId: product.id, variantId: variant.id,
    name: product.name, size: variant.size, colour: variant.colour, sku: variant.sku,
    change, after: variant.stock, reason, ref,
  };
}

/* ===== 6. Cart ========================================================== */

const cartQty = variantId => ui.cart.lines.find(l => l.variantId === variantId)?.qty || 0;

let cartTimer;
/** Save the cart to the device (debounced) so a dead battery doesn't lose a sale in progress. */
function saveCart(now = false) {
  clearTimeout(cartTimer);
  const run = () => DB.write([opKv('cart', ui.cart)]).catch(err => console.warn('cart save failed', err));
  if (now) return run();
  cartTimer = setTimeout(run, 250);
}

/** Put a saved cart back, dropping deleted variants and clamping to stock. */
function restoreCart(saved) {
  ui.cart = { ...emptyCart(), ...(saved || {}) };
  ui.cart.lines = ui.cart.lines
    .map(l => { const f = findVariant(l.variantId); return f ? { ...l, qty: Math.min(l.qty, f.variant.stock) } : null; })
    .filter(l => l && l.qty > 0);
  $('#discountValue').value = ui.cart.discountText || '';
  $('#tendered').value = ui.cart.tenderedText || '';
}

function addToCart(variantId, qty = 1) {
  const found = findVariant(variantId);
  if (!found) return false;
  const already = cartQty(variantId);
  if (already + qty > found.variant.stock) {
    const left = Math.max(0, found.variant.stock - already);
    toast(left ? `Only ${left} more in stock` : `${found.product.name} ${found.variant.size}/${found.variant.colour} is out of stock`, true);
    return false;
  }
  const line = ui.cart.lines.find(l => l.variantId === variantId);
  if (line) line.qty += qty; else ui.cart.lines.push({ variantId, qty });
  renderCart();
  saveCart();
  return true;
}

function setLineQty(variantId, qty) {
  const line = ui.cart.lines.find(l => l.variantId === variantId);
  const found = findVariant(variantId);
  if (!line || !found) return;
  if (qty > found.variant.stock) { toast(`Only ${found.variant.stock} in stock`, true); qty = found.variant.stock; }
  if (qty <= 0) ui.cart.lines = ui.cart.lines.filter(l => l !== line);
  else line.qty = qty;
  renderCart();
  saveCart();
}

/** Everything the cart footer and checkout need. */
function cartTotals() {
  const c = ui.cart;
  const rate = effectiveRate();
  const lines = c.lines.map(l => {
    const f = findVariant(l.variantId);
    return f && { ...l, ...f, price: priceOf(f.product, f.variant) };
  }).filter(Boolean);
  const subtotal = sum(lines, l => l.price * l.qty);
  let discount = 0;
  let pct = 0;
  if (c.discountType === '%') {
    pct = Math.min(100, Math.max(0, parseFloat(String(c.discountText).replace(',', '.')) || 0));
    discount = Math.round(subtotal * pct / 100);
  } else {
    discount = Math.min(subtotal, Math.max(0, parseMoney(c.discountText) || 0));
  }
  if (!can('discount')) { discount = 0; pct = 0; } // this user may not give discounts
  const total = subtotal - discount;
  const vat = vatFromInclusive(total, rate);
  const credit = c.credit?.amount || 0;
  const creditUsed = Math.min(credit, total);
  const creditChange = credit - creditUsed;       // credit bigger than new items: paid back in cash
  const due = total - creditUsed;
  const cash = c.payment === 'cash' && due > 0;
  const tendered = cash ? (c.tenderedText.trim() === '' ? due : parseMoney(c.tenderedText)) : due;
  const change = cash && Number.isFinite(tendered) ? tendered - due : 0;
  const count = sum(lines, l => l.qty);
  return { lines, subtotal, discount, pct, total, vat, rate, credit, creditUsed, creditChange, due, tendered, change, count, cash };
}

/* ===== 7. Checkout ====================================================== */

async function checkout() {
  if (!sellingAllowed()) return toast('Selling is paused until the subscription is renewed', true);
  const t = cartTotals();
  if (!t.lines.length) return toast(ui.cart.credit ? 'Add the exchange items first' : 'Cart is empty', true);
  for (const l of t.lines) {
    if (l.qty > l.variant.stock) return toast(`Not enough stock for ${l.product.name} ${l.variant.size}/${l.variant.colour}`, true);
  }
  if (t.cash && (!Number.isFinite(t.tendered) || t.tendered < t.due)) return toast('Cash tendered is less than the amount due', true);

  // Big sales by a VAT vendor need a full tax invoice with the buyer's details.
  if (state.settings.vatRegistered && t.total > FULL_TAX_INVOICE_OVER && !ui.cart.customer) return openCustomerForm();

  // PLUG-IN: card terminal — for payment === 'card', call the terminal SDK here
  // (e.g. Yoco / SumUp / iKhokha) and only continue once it returns "approved".
  // Store the terminal reference on the sale (sale.paymentRef).

  const number = state.meta.nextReceiptNo;
  const sale = {
    id: uid('s'),
    number,
    date: new Date().toISOString(),
    store: storeSnapshot(),
    customer: ui.cart.customer || null,
    items: t.lines.map(l => saleItem(l.product, l.variant, l.qty)),
    subtotal: t.subtotal,
    discountType: ui.cart.discountType,
    discountValue: ui.cart.discountType === '%' ? t.pct : t.discount,
    discount: t.discount,
    total: t.total,
    vatRate: t.rate,
    vat: t.vat,
    payment: t.due === 0 && t.creditUsed ? 'credit' : ui.cart.payment,
    paid: t.due,
    tendered: t.tendered,
    change: t.change,
    creditUsed: t.creditUsed,
    creditChange: t.creditChange,
    creditRef: ui.cart.credit?.label || null,
    returns: [],
    status: 'completed',
    cashier: ui.user?.name || '', // who was signed in
    ...deviceStamp(),             // which till (cloud sync): series letter + device id
  };

  const ops = [];
  t.lines.forEach(l => {
    l.variant.stock -= l.qty;
    ops.push(opPut('movements', movement(l.product, l.variant, -l.qty, 'sale', `#${saleNo(sale)}`)));
  });
  [...new Set(t.lines.map(l => l.product))].forEach(p => ops.push(opPut('products', p)));
  state.sales.push(sale);
  state.meta.nextReceiptNo += 1;
  const oldCart = ui.cart;
  ui.cart = emptyCart(oldCart.payment);
  ops.push(opPut('sales', sale), opKv('meta', state.meta), opKv('cart', ui.cart));

  try {
    await persist(ops);
  } catch {
    // Roll back in memory so screen and storage agree.
    t.lines.forEach(l => { l.variant.stock += l.qty; });
    state.sales.pop();
    state.meta.nextReceiptNo -= 1;
    ui.cart = oldCart;
    return;
  }
  $('#discountValue').value = '';
  $('#tendered').value = '';
  closeCartSheet();
  renderAll();
  showDoc(`sale:${sale.id}`, { justSold: true });
}

/** Ask for buyer details (needed on a tax invoice over R5 000). */
function openCustomerForm() {
  const c = ui.cart.customer || {};
  openModal({
    title: 'Customer details',
    body: `<p class="small muted" style="margin-top:0">Sales over ${money(FULL_TAX_INVOICE_OVER)} need a full tax invoice showing the buyer's name and address (and VAT number if they are VAT registered).</p>
      <label class="field"><span>Customer / business name</span><input class="input" id="cName" value="${esc(c.name || '')}" autofocus></label>
      <label class="field"><span>Address</span><textarea id="cAddress" rows="2" class="plain">${esc(c.address || '')}</textarea></label>
      <label class="field"><span>Customer VAT number (optional)</span><input class="input" id="cVat" value="${esc(c.vatNumber || '')}"></label>`,
    foot: `<button class="btn" data-action="close-modal">Cancel</button><button class="btn primary" data-action="customer-save">Continue to payment</button>`,
  });
}

/* ===== 8. Returns, credit notes & exchanges ============================= */

/** How many of sale.items[idx] have already been returned. */
const returnedQty = (sale, idx) => sum(sale.returns, r => sum(r.items.filter(i => i.idx === idx), i => i.qty));
const refundedTotal = sale => sum(sale.returns, r => r.amount);

function saleStatus(sale) {
  if (!sale.returns?.length) return 'completed';
  return sale.items.every((it, idx) => returnedQty(sale, idx) >= it.qty) ? 'returned' : 'partial';
}

/** What a return of qtyMap ({itemIdx: qty}) would refund. Discounts are shared out pro rata. */
function returnPreview(sale, qtyMap) {
  const share = sale.subtotal ? sale.total / sale.subtotal : 1;
  const items = [];
  for (const [k, q] of Object.entries(qtyMap)) {
    const idx = Number(k);
    const it = sale.items[idx];
    if (!it || !q) continue;
    items.push({ idx, qty: q, amount: Math.round(it.unitPrice * q * share), cost: it.unitCost * q });
  }
  let amount = sum(items, i => i.amount);
  // If this return completes the sale, make refunds add up to exactly the sale total.
  const completes = items.length && sale.items.every((it, idx) => returnedQty(sale, idx) + (qtyMap[idx] || 0) >= it.qty);
  if (completes) {
    const exact = sale.total - refundedTotal(sale);
    items[items.length - 1].amount += exact - amount;
    amount = exact;
  }
  return { items, amount, vat: vatFromInclusive(amount, sale.vatRate), cost: sum(items, i => i.cost) };
}

function openReturn(saleId) {
  const sale = state.sales.find(s => s.id === saleId);
  if (!sale) return;
  ui.ret = { saleId, qty: {}, method: ['cash', 'card', 'eft'].includes(sale.payment) ? sale.payment : 'cash' };
  openModal({ title: `Return / exchange · #${saleNo(sale)}`, body: '<div id="retBody"></div>', foot: '<div id="retFoot" class="foot-row"></div>' });
  renderReturn();
}

function renderReturn() {
  const sale = state.sales.find(s => s.id === ui.ret?.saleId);
  if (!sale) return;
  const pv = returnPreview(sale, ui.ret.qty);
  $('#retBody').innerHTML = `
    <p class="small muted" style="margin-top:0">Choose what is coming back. Stock is put back automatically.</p>
    ${sale.items.map((it, idx) => {
      const left = it.qty - returnedQty(sale, idx);
      const q = ui.ret.qty[idx] || 0;
      return `<div class="ret-row ${left ? '' : 'done'}">
        <div><strong>${esc(it.name)}</strong><div class="small muted">${esc(it.size)} / ${esc(it.colour)} · bought ${it.qty} · ${left ? `${left} can be returned` : 'all returned'}</div></div>
        ${left ? `<span class="stepper">
          <button data-action="ret-qty" data-idx="${idx}" data-d="-1" aria-label="Return one less ${esc(it.name)}">−</button>
          <span aria-live="polite">${q}</span>
          <button data-action="ret-qty" data-idx="${idx}" data-d="1" aria-label="Return one more ${esc(it.name)}">+</button></span>` : ''}
      </div>`;
    }).join('')}
    <div class="row gap-s" style="margin:12px 0"><button class="btn sm" data-action="ret-all">Select everything</button></div>
    <div class="small-label">Refund money by</div>
    <div class="seg" role="group" aria-label="Refund method" style="margin:4px 0 12px">
      ${['cash', 'card', 'eft'].map(m => `<button data-action="ret-method" data-m="${m}" class="${ui.ret.method === m ? 'on' : ''}" aria-pressed="${ui.ret.method === m}">${PAY_LABEL[m]}</button>`).join('')}
    </div>
    <div class="totals"><span class="grand">Refund</span><span class="grand money">${money(pv.amount)}</span>
      ${sale.vatRate ? `<span class="muted">Incl. VAT @ ${esc(sale.vatRate)}%</span><span class="muted money">${money(pv.vat)}</span>` : ''}</div>`;
  const none = !pv.items.length;
  $('#retFoot').innerHTML = `
    <button class="btn" data-action="ret-go" data-mode="exchange" ${none ? 'disabled' : ''}>Exchange (credit ${money(pv.amount)})</button>
    <button class="btn primary" data-action="ret-go" data-mode="refund" ${none ? 'disabled' : ''}>Refund ${money(pv.amount)}</button>`;
}

async function processReturn(asExchange) {
  const sale = state.sales.find(s => s.id === ui.ret?.saleId);
  if (!sale) return;
  if (asExchange && ui.cart.credit) return toast('Finish or cancel the exchange already in the cart first', true);
  const pv = returnPreview(sale, ui.ret.qty);
  if (!pv.items.length) return;
  const ret = {
    id: uid('r'), number: state.meta.nextCreditNo, date: new Date().toISOString(),
    method: asExchange ? 'credit' : ui.ret.method, ...pv,
    cashier: ui.user?.name || '', ...deviceStamp(),
  };
  const ops = [];
  const restocked = [];
  const missing = [];
  for (const ri of ret.items) {
    const it = sale.items[ri.idx];
    const f = findVariant(it.variantId);
    if (!f) { missing.push(it.name); continue; }
    f.variant.stock += ri.qty;
    restocked.push([f.variant, ri.qty]);
    ops.push(opPut('movements', movement(f.product, f.variant, ri.qty, 'return', retNo(ret))));
    if (!ops.some(o => o.store === 'products' && o.value === f.product)) ops.push(opPut('products', f.product));
  }
  sale.returns.push(ret);
  sale.status = saleStatus(sale);
  state.meta.nextCreditNo += 1;
  ops.push(opPut('sales', sale), opKv('meta', state.meta));
  try {
    await persist(ops);
  } catch {
    restocked.forEach(([v, q]) => { v.stock -= q; });
    sale.returns.pop();
    sale.status = saleStatus(sale);
    state.meta.nextCreditNo -= 1;
    return;
  }
  ui.ret = null;
  closeModal();
  if (missing.length) toast(`Not restocked (product deleted): ${missing.join(', ')}`, true);
  if (asExchange) {
    ui.cart.credit = { amount: ret.amount, saleId: sale.id, returnId: ret.id, label: retNo(ret) };
    saveCart(true);
    showView('sell');
    if (!isWide()) openCartSheet();
    toast(`Credit ${money(ret.amount)} added — now add the exchange items`);
  } else {
    renderAll();
    showDoc(`ret:${sale.id}:${ret.id}`);
  }
}

/** Cancel an exchange that was never completed: the credit becomes a cash refund. */
async function cancelCredit() {
  const cr = ui.cart.credit;
  if (!cr) return true;
  const ok = await confirmBox(`Cancel the exchange? The customer gets ${money(cr.amount)} back in cash instead.`, 'Refund cash', true);
  if (!ok) return false;
  const sale = state.sales.find(s => s.id === cr.saleId);
  const ret = sale?.returns.find(r => r.id === cr.returnId);
  if (ret) { ret.method = 'cash'; await persist([opPut('sales', sale)]); }
  ui.cart.credit = null;
  saveCart(true);
  renderAll();
  if (sale && ret) showDoc(`ret:${sale.id}:${ret.id}`);
  return true;
}

/* ===== 9. Stock ========================================================= */

/* Tapping +/- many times quickly makes ONE movement: changes are collected per
   variant and written ~0.7s after the last tap (or immediately when the app is hidden). */
const pendingAdjust = new Map();

function adjustStock(variantId, value, reason) {
  const f = findVariant(variantId);
  if (!f) return;
  const n = Math.max(0, Math.floor(Number(value)));
  if (!Number.isFinite(n)) return;
  let pend = pendingAdjust.get(variantId);
  if (!pend) { pend = { start: f.variant.stock }; pendingAdjust.set(variantId, pend); }
  pend.reason = reason;
  f.variant.stock = n;
  paintStockRow(variantId);
  renderSell();
  clearTimeout(pend.timer);
  pend.timer = setTimeout(() => flushAdjust(variantId), 700);
}

async function flushAdjust(variantId) {
  const pend = pendingAdjust.get(variantId);
  if (!pend) return;
  clearTimeout(pend.timer);
  pendingAdjust.delete(variantId);
  const f = findVariant(variantId);
  if (!f) return;
  const change = f.variant.stock - pend.start;
  if (!change) return;
  await persist([opPut('products', f.product), opPut('movements', movement(f.product, f.variant, change, pend.reason))]);
}
const flushAllAdjust = () => Promise.all([...pendingAdjust.keys()].map(flushAdjust));

/** Update one stock row in place (keeps focus while typing). */
function paintStockRow(variantId) {
  const f = findVariant(variantId);
  const input = $(`[data-stock-input="${CSS.escape(variantId)}"]`);
  if (!f || !input) return;
  if (document.activeElement !== input) input.value = f.variant.stock;
  const row = input.closest('.var-row');
  const low = state.settings.lowStock;
  row.classList.toggle('out', f.variant.stock === 0);
  row.classList.toggle('low', f.variant.stock > 0 && f.variant.stock <= low);
  const tag = row.querySelector('.state-tag');
  if (tag) tag.textContent = f.variant.stock === 0 ? ' · out' : f.variant.stock <= low ? ' · low' : '';
}

function openReceive(productId) {
  const p = findProduct(productId);
  if (!p) return;
  openModal({
    title: `Receive delivery · ${p.name}`,
    body: `<p class="small muted" style="margin-top:0">Enter how many arrived of each. Leave blank for none.</p>
      <div class="variant-grid">
        <span class="small-label">Variant (now in stock)</span><span class="small-label">Received</span>
        ${p.variants.map((v, i) => `<label for="rcv${i}">${esc(v.size)} / ${esc(v.colour)} <span class="muted">(${v.stock})</span></label>
          <input class="input" id="rcv${i}" inputmode="numeric" data-recv="${esc(v.id)}" ${i === 0 ? 'autofocus' : ''}>`).join('')}
      </div>
      <label class="field" style="margin-top:12px"><span>Supplier / invoice no. (optional)</span><input class="input" id="rcvNote"></label>`,
    foot: `<button class="btn" data-action="close-modal">Cancel</button><button class="btn primary" data-action="receive-save" data-id="${esc(p.id)}">Add to stock</button>`,
  });
}

async function saveReceive(productId) {
  const p = findProduct(productId);
  if (!p) return;
  await flushAllAdjust();
  const note = $('#rcvNote').value.trim();
  const ops = [];
  let total = 0;
  for (const input of $$('[data-recv]')) {
    const q = parseInt(input.value, 10);
    if (!q || q < 0) continue;
    const v = p.variants.find(x => x.id === input.dataset.recv);
    if (!v) continue;
    v.stock += q;
    total += q;
    ops.push(opPut('movements', movement(p, v, q, 'receive', note)));
  }
  if (!total) return toast('Enter at least one quantity', true);
  ops.push(opPut('products', p));
  await persist(ops);
  closeModal();
  renderAll();
  toast(`Received ${total} item${total === 1 ? '' : 's'}`);
}

const REASON_LABEL = { sale: 'Sold', return: 'Returned', adjust: 'Adjusted', count: 'Stock count', receive: 'Received', new: 'New product', opening: 'Opening stock' };

async function openHistory(productId) {
  const p = findProduct(productId);
  if (!p) return;
  await flushAllAdjust();
  const moves = (await DB.getAllByIndex('movements', 'productId', productId)).sort((a, b) => b.date.localeCompare(a.date));
  openModal({
    title: `Stock history · ${p.name}`,
    body: moves.length ? `<table class="list-table hist">
        <thead><tr><th>When</th><th>Variant</th><th>Why</th><th class="r">Change</th><th class="r">After</th></tr></thead>
        <tbody>${moves.slice(0, 200).map(m => `<tr>
          <td>${fmtDT(m.date)}</td><td>${esc(m.size)} / ${esc(m.colour)}</td>
          <td>${esc(REASON_LABEL[m.reason] || m.reason)}${m.ref ? ` <span class="muted">${esc(m.ref)}</span>` : ''}</td>
          <td class="r ${m.change < 0 ? 'neg' : 'pos'}">${m.change > 0 ? '+' : ''}${m.change}</td><td class="r">${m.after}</td></tr>`).join('')}</tbody></table>
        ${moves.length > 200 ? '<p class="small muted">Showing the latest 200.</p>' : ''}`
      : '<div class="empty">No stock changes recorded yet.</div>',
    foot: '<button class="btn" data-action="close-modal">Close</button>',
  });
}

/* ===== 10. Reports & cash-up ============================================ */

/** All refunds (returns) with their sale, optionally from a date. */
function allReturns(fromDate = null, toDate = null) {
  const out = [];
  for (const s of state.sales) for (const r of s.returns) {
    const d = new Date(r.date);
    if ((!fromDate || d >= fromDate) && (!toDate || d <= toDate)) out.push({ sale: s, ret: r });
  }
  return out;
}

const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
const DAY_MS = 864e5;
const fmtShort = d => d.toLocaleDateString('en-ZA', { day: 'numeric', month: 'short' });
const fmtLong = d => d.toLocaleDateString('en-ZA', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
const toDateInput = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const fromDateInput = s => { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s || ''); return m ? new Date(+m[1], +m[2] - 1, +m[3]) : null; };

/* Report periods. `to` is exclusive (midnight after the last day). */
const RANGES = [['today', 'Today'], ['yesterday', 'Yesterday'], ['7', '7 days'], ['30', '30 days'], ['month', 'This month'], ['custom', 'Custom']];

function reportRange(key = ui.reportRange) {
  const today = startOfDay();
  const tomorrow = addDays(today, 1);
  let from = today, to = tomorrow;
  if (key === 'yesterday') { from = addDays(today, -1); to = today; }
  if (key === '7') from = addDays(today, -6);
  if (key === '30') from = addDays(today, -29);
  if (key === 'month') from = new Date(today.getFullYear(), today.getMonth(), 1);
  if (key === 'custom') {
    from = startOfDay(fromDateInput(ui.customFrom) || addDays(today, -6));
    to = addDays(startOfDay(fromDateInput(ui.customTo) || today), 1);
    if (to <= from) to = addDays(from, 1);
  }
  const days = Math.round((to - from) / DAY_MS);
  const last = addDays(to, -1);
  const label = days === 1 ? fmtLong(from) : `${fmtShort(from)} – ${fmtLong(last)}`;
  return { key, from, to, days, label };
}

/** Report numbers for a period ({from, to}) or the last N days (1 = today).
    Refunds are counted on the day they happen. */
function buildReport(range) {
  if (typeof range === 'number') { const from = addDays(startOfDay(), -(range - 1)); range = { from, to: addDays(startOfDay(), 1), days: range }; }
  const { from, to } = range;
  const inRange = iso => { const d = new Date(iso); return d >= from && d < to; };
  const sales = state.sales.filter(s => inRange(s.date));
  const rets = allReturns().filter(x => inRange(x.ret.date));

  const gross = sum(sales, s => s.total);
  const refunds = sum(rets, x => x.ret.amount);
  const revenue = gross - refunds;
  const vat = sum(sales, s => s.vat) - sum(rets, x => x.ret.vat);
  const cost = sum(sales, s => sum(s.items, it => it.unitCost * it.qty)) - sum(rets, x => x.ret.cost);

  const byPayment = {};
  for (const k of ['cash', 'card', 'eft', 'credit']) byPayment[k] = { sales: 0, refunds: 0, count: 0 };
  sales.forEach(s => {
    if (s.paid) { byPayment[s.payment] ??= { sales: 0, refunds: 0, count: 0 }; byPayment[s.payment].sales += s.paid; byPayment[s.payment].count++; }
    if (s.creditUsed) byPayment.credit.sales += s.creditUsed;
    if (s.creditChange) byPayment.cash.refunds += s.creditChange;
  });
  rets.forEach(({ ret }) => { byPayment[ret.method] ??= { sales: 0, refunds: 0, count: 0 }; byPayment[ret.method].refunds += ret.amount; });

  const top = new Map();
  const add = (pid, name, qty, amount) => {
    const row = top.get(pid) || { name, qty: 0, amount: 0 };
    row.qty += qty; row.amount += amount; top.set(pid, row);
  };
  sales.forEach(s => s.items.forEach(it => add(it.productId, it.name, it.qty, it.unitPrice * it.qty)));
  rets.forEach(({ sale, ret }) => ret.items.forEach(ri => { const it = sale.items[ri.idx]; add(it.productId, it.name, -ri.qty, -ri.amount); }));

  // By category (line amounts before the sale discount; refunds subtracted)
  const cats = new Map();
  const addCat = (pid, qty, amount) => {
    const name = findProduct(pid)?.category || 'Other';
    const row = cats.get(name) || { name, qty: 0, amount: 0 };
    row.qty += qty; row.amount += amount; cats.set(name, row);
  };
  sales.forEach(s => s.items.forEach(it => addCat(it.productId, it.qty, it.unitPrice * it.qty)));
  rets.forEach(({ sale, ret }) => ret.items.forEach(ri => addCat(sale.items[ri.idx].productId, -ri.qty, -ri.amount)));

  // By cashier
  const people = new Map();
  sales.forEach(s => {
    const name = s.cashier || 'Not recorded';
    const row = people.get(name) || { name, count: 0, amount: 0 };
    row.count++; row.amount += s.total; people.set(name, row);
  });

  // Takings over time: per hour for a single day, per day otherwise
  const days = Math.round((to - from) / DAY_MS);
  let series;
  if (days <= 1) {
    const hours = Array.from({ length: 24 }, (_, h) => ({ key: h, label: `${pad(h)}:00`, short: String(h), amount: 0, count: 0 }));
    sales.forEach(s => { const h = new Date(s.date).getHours(); hours[h].amount += s.total; hours[h].count++; });
    rets.forEach(({ ret }) => { hours[new Date(ret.date).getHours()].amount -= ret.amount; });
    const used = hours.filter(h => h.count || h.amount);
    const first = Math.min(8, ...used.map(h => h.key)), last = Math.max(17, ...used.map(h => h.key));
    series = { unit: 'hour', points: hours.slice(first, last + 1) };
  } else {
    const pts = [];
    for (let d = new Date(from), i = 0; d < to && i < 400; d = addDays(d, 1), i++) {
      pts.push({ key: toDateInput(d), label: fmtLong(d), short: days <= 7 ? d.toLocaleDateString('en-ZA', { weekday: 'short' }) : String(d.getDate()), amount: 0, count: 0 });
    }
    const idx = iso => pts.findIndex(p => p.key === toDateInput(new Date(iso)));
    sales.forEach(s => { const i = idx(s.date); if (i >= 0) { pts[i].amount += s.total; pts[i].count++; } });
    rets.forEach(({ ret }) => { const i = idx(ret.date); if (i >= 0) pts[i].amount -= ret.amount; });
    series = { unit: 'day', points: pts };
  }

  const exVat = revenue - vat;
  const profit = exVat - cost;
  return {
    from, to, days, sales, rets, gross, refunds, revenue,
    count: sales.length,
    avg: sales.length ? Math.round(gross / sales.length) : 0,
    vat, exVat, cost, profit,
    margin: exVat > 0 ? Math.round(profit / exVat * 1000) / 10 : 0,
    discounts: sum(sales, s => s.discount || 0),
    items: sum(sales, s => sum(s.items, it => it.qty)),
    byPayment,
    topAll: [...top.values()].filter(r => r.qty > 0).sort((a, b) => b.qty - a.qty || b.amount - a.amount),
    top: [...top.values()].filter(r => r.qty > 0).sort((a, b) => b.qty - a.qty || b.amount - a.amount).slice(0, 5),
    categories: [...cats.values()].filter(c => c.qty || c.amount).sort((a, b) => b.amount - a.amount),
    cashiers: [...people.values()].sort((a, b) => b.amount - a.amount),
    series,
  };
}

/** Net revenue for the same-length period just before this one (for "vs previous"). */
function previousRevenue(range) {
  const len = range.to - range.from;
  const prev = buildReport({ from: new Date(range.from - len), to: range.from });
  return prev.count || prev.refunds ? prev.revenue : null;
}

/** Stock on hand with cost and retail value (for the stock report). */
function stockSummary() {
  const low = Number(state.settings.lowStock) || 0;
  const rows = [];
  for (const p of state.products) for (const v of p.variants) {
    rows.push({ product: p, variant: v, qty: v.stock, cost: costOf(p, v), price: priceOf(p, v),
      costValue: Math.max(0, v.stock) * costOf(p, v), retailValue: Math.max(0, v.stock) * priceOf(p, v),
      low: v.stock <= low });
  }
  return { rows, units: sum(rows, r => Math.max(0, r.qty)), costValue: sum(rows, r => r.costValue),
    retailValue: sum(rows, r => r.retailValue), lowCount: rows.filter(r => r.low).length };
}

/** Money movements for a shift (from the last cash-up until now) on THIS till.
    With cloud sync, other devices' sales are in the data too, but each till
    counts only its own cash drawer. */
function computeShift(fromIso, toIso) {
  const from = fromIso ? new Date(fromIso) : new Date(0);
  const to = new Date(toIso);
  const inShift = d => { const x = new Date(d); return x > from && x <= to; };
  const me = Cloud.conf?.deviceId;
  const mine = x => !me || !x.device || x.device === me;
  const sales = state.sales.filter(s => inShift(s.date) && mine(s));
  const rets = allReturns().filter(x => inShift(x.ret.date) && mine(x.ret));
  const byMethod = m => sum(sales.filter(s => s.payment === m), s => s.paid);
  const refundBy = m => sum(rets.filter(x => x.ret.method === m), x => x.ret.amount);
  const cashSales = byMethod('cash');
  const cashOut = refundBy('cash') + sum(sales, s => s.creditChange);
  const float = state.meta.float || 0;
  const gross = sum(sales, s => s.total);
  const refunds = sum(rets, x => x.ret.amount);
  return {
    from: fromIso, to: toIso, float,
    salesCount: sales.length, refundCount: rets.length,
    gross, refunds, net: gross - refunds,
    vat: sum(sales, s => s.vat) - sum(rets, x => x.ret.vat),
    cashSales, card: byMethod('card'), eft: byMethod('eft'),
    cardRefunds: refundBy('card'), eftRefunds: refundBy('eft'),
    creditUsed: sum(sales, s => s.creditUsed),
    cashOut, expected: float + cashSales - cashOut,
  };
}

function openCashup() {
  const sh = computeShift(state.meta.lastCashupAt, new Date().toISOString());
  ui.shift = sh;
  openModal({
    title: 'Cash-up (end of shift)',
    body: `
      <p class="small muted" style="margin-top:0">Since ${sh.from ? fmtDT(sh.from) : 'the first sale'} · ${sh.salesCount} sales · ${sh.refundCount} refunds</p>
      <div class="totals">
        <span>Opening float</span><span class="money">${money(sh.float)}</span>
        <span>+ Cash sales</span><span class="money">${money(sh.cashSales)}</span>
        <span>− Cash refunds</span><span class="money">${money(sh.cashOut)}</span>
        <span class="grand">Expected cash</span><span class="grand money">${money(sh.expected)}</span>
        <span class="muted">Card / EFT (not in drawer)</span><span class="muted money">${money(sh.card - sh.cardRefunds)} / ${money(sh.eft - sh.eftRefunds)}</span>
      </div>
      <label class="field" style="margin-top:14px"><span>Cash counted in the drawer (R)</span><input class="input" id="cuCounted" inputmode="decimal" autofocus></label>
      <div id="cuDiff" class="small" aria-live="polite"></div>
      <label class="field" style="margin-top:10px"><span>Float to leave in the drawer for next shift (R)</span><input class="input" id="cuFloat" inputmode="decimal" value="${centsToPlain(state.meta.float || 0)}"></label>`,
    foot: `<button class="btn" data-action="close-modal">Cancel</button><button class="btn primary" data-action="cashup-save">Close shift & print Z-report</button>`,
  });
}

function paintCashupDiff() {
  const counted = parseMoney($('#cuCounted').value);
  const el = $('#cuDiff');
  if (!Number.isFinite(counted)) { el.textContent = ''; return; }
  const diff = counted - ui.shift.expected;
  el.innerHTML = diff === 0 ? '<span class="ok-text">Balances exactly.</span>'
    : `<span class="${diff > 0 ? 'warn-text' : 'err-text'}">${diff > 0 ? 'Over' : 'Short'} by ${money(Math.abs(diff))}</span>`;
}

async function saveCashup() {
  const counted = parseMoney($('#cuCounted').value);
  const nextFloat = parseMoney($('#cuFloat').value || '0');
  if (!Number.isFinite(counted) || counted < 0) return toast('Enter the cash you counted', true);
  if (!Number.isFinite(nextFloat) || nextFloat < 0) return toast('Enter a valid float', true);
  const sh = computeShift(state.meta.lastCashupAt, new Date().toISOString());
  const z = { id: uid('z'), number: state.meta.nextZNo, ...sh, counted, diff: counted - sh.expected, nextFloat, store: storeSnapshot(),
    cashier: ui.user?.name || '', ...deviceStamp() };
  state.cashups.push(z);
  state.meta.nextZNo += 1;
  state.meta.lastCashupAt = sh.to;
  state.meta.float = nextFloat;
  await persist([opPut('cashups', z), opKv('meta', state.meta)]);
  closeModal();
  renderAll();
  showDoc(`z:${z.id}`);
}

/* ===== 11. Documents (receipts, credit notes, Z-reports) ================ */

const PAY_LABEL = { cash: 'Cash', card: 'Card', eft: 'EFT', credit: 'Exchange credit' };
const W = 32; // characters per line (fits 58mm printers & WhatsApp monospace)

function lr(left, right) {
  left = String(left); right = String(right);
  const space = W - left.length - right.length;
  if (space >= 1) return left + ' '.repeat(space) + right;
  return left + '\n' + ' '.repeat(Math.max(0, W - right.length)) + right;
}
const center = s => { s = String(s).slice(0, W); return ' '.repeat(Math.floor((W - s.length) / 2)) + s; };
const wrap = s => String(s).match(new RegExp(`.{1,${W}}(\\s|$)|.{1,${W}}`, 'g'))?.map(x => x.trimEnd()) || [''];
const LINE = '-'.repeat(W);

/** Store header block; uses the details saved on the document (old receipts never change). */
function headerLines(store, title) {
  const st = store || storeSnapshot();
  const out = [];
  wrap(st.name).forEach(l => out.push(center(l)));
  String(st.address || '').split('\n').filter(Boolean).forEach(a => wrap(a).forEach(l => out.push(center(l))));
  if (st.phone) out.push(center(`Tel ${st.phone}`));
  if (st.vatRegistered && st.vatNumber) out.push(center(`VAT No. ${st.vatNumber}`));
  out.push('');
  out.push(center(title));
  return out;
}
const footerLines = () => String(state.settings.receiptFooter || '').split('\n').flatMap(f => wrap(f).map(center));

/** Tax invoice (VAT vendor) or plain receipt. */
function receiptText(sale) {
  const st = sale.store || storeSnapshot();
  const registered = st.vatRegistered && sale.vatRate > 0;
  const out = headerLines(st, registered ? 'TAX INVOICE' : 'RECEIPT');
  out.push(center(`No. ${saleNo(sale)}`), center(fmtDT(sale.date)));
  if (sale.cashier) out.push(center('Served by ' + sale.cashier));
  if (sale.customer) {
    out.push(LINE, 'Customer: ' + sale.customer.name);
    String(sale.customer.address || '').split('\n').filter(Boolean).forEach(a => wrap(a).forEach(l => out.push(l)));
    if (sale.customer.vatNumber) out.push('Customer VAT No. ' + sale.customer.vatNumber);
  }
  out.push(LINE);
  for (const it of sale.items) {
    wrap(`${it.name} (${it.size}/${it.colour})`).forEach(l => out.push(l));
    out.push(lr(`  ${it.qty} x ${money(it.unitPrice)}`, money(it.unitPrice * it.qty)));
  }
  out.push(LINE);
  if (sale.discount) {
    out.push(lr('Subtotal', money(sale.subtotal)));
    out.push(lr(sale.discountType === '%' ? `Discount (${sale.discountValue}%)` : 'Discount', '-' + money(sale.discount)));
  }
  out.push(lr('TOTAL', money(sale.total)));
  if (registered) {
    out.push(lr(`Total excl. VAT`, money(sale.total - sale.vat)));
    out.push(lr(`VAT @ ${sale.vatRate}% (incl.)`, money(sale.vat)));
  }
  if (sale.creditUsed) out.push(lr(`Credit ${sale.creditRef || ''}`.trim(), '-' + money(sale.creditUsed)));
  if (sale.paid || !sale.creditUsed) {
    out.push(lr(`Paid: ${PAY_LABEL[sale.payment] || sale.payment}`, money(sale.payment === 'cash' ? sale.tendered : sale.paid)));
    if (sale.payment === 'cash') out.push(lr('Change', money(sale.change)));
  }
  if (sale.creditChange) out.push(lr('Credit paid out (cash)', money(sale.creditChange)));
  if (sale.returns.length) {
    out.push(LINE);
    sale.returns.forEach(r => out.push(lr(`Returned ${r.number ? retNo(r) : ''} ${fmtDate(r.date)}`, '-' + money(r.amount))));
  }
  out.push(LINE, ...footerLines());
  return out.join('\n');
}

/** Credit note (VAT vendor) or refund slip for one return. */
function creditNoteText(sale, ret) {
  const st = sale.store || storeSnapshot();
  const registered = st.vatRegistered && sale.vatRate > 0;
  const out = headerLines(st, registered ? 'CREDIT NOTE' : 'REFUND SLIP');
  out.push(center(`No. ${retNo(ret)}`), center(fmtDT(ret.date)));
  out.push(center(`For invoice ${saleNo(sale)} of ${fmtDate(sale.date)}`));
  if (sale.customer) out.push(LINE, 'Customer: ' + sale.customer.name);
  out.push(LINE);
  for (const ri of ret.items) {
    const it = sale.items[ri.idx];
    wrap(`${it.name} (${it.size}/${it.colour})`).forEach(l => out.push(l));
    out.push(lr(`  ${ri.qty} returned`, '-' + money(ri.amount)));
  }
  out.push(LINE, lr('TOTAL CREDIT', money(ret.amount)));
  if (registered) out.push(lr(`VAT @ ${sale.vatRate}% (incl.)`, money(ret.vat)));
  out.push(lr(ret.method === 'credit' ? 'Given as exchange credit' : `Refunded: ${PAY_LABEL[ret.method]}`, ret.method === 'credit' ? '' : money(ret.amount)));
  out.push(LINE, ...footerLines());
  return out.join('\n');
}

function zText(z) {
  const out = headerLines(z.store, `Z-REPORT No. ${zNo(z)}`);
  out.push(center('Cash-up / end of shift'));
  out.push(lr('From', z.from ? fmtDT(z.from) : 'start'), lr('To', fmtDT(z.to)), LINE);
  out.push(lr(`Sales (${z.salesCount})`, money(z.gross)));
  out.push(lr(`Refunds (${z.refundCount})`, '-' + money(z.refunds)));
  out.push(lr('Net sales', money(z.net)));
  if (z.vat) out.push(lr('VAT included', money(z.vat)));
  out.push(LINE);
  out.push(lr('Cash sales', money(z.cashSales)));
  out.push(lr('Card (net)', money(z.card - z.cardRefunds)));
  out.push(lr('EFT (net)', money(z.eft - z.eftRefunds)));
  if (z.creditUsed) out.push(lr('Exchange credit used', money(z.creditUsed)));
  out.push(LINE);
  out.push(lr('Opening float', money(z.float)));
  out.push(lr('+ Cash sales', money(z.cashSales)));
  out.push(lr('- Cash refunds', money(z.cashOut)));
  out.push(lr('Expected cash', money(z.expected)));
  out.push(lr('Counted cash', money(z.counted)));
  out.push(lr(z.diff === 0 ? 'Balanced' : z.diff > 0 ? 'OVER' : 'SHORT', money(Math.abs(z.diff))));
  out.push(lr('Float left for next shift', money(z.nextFloat)));
  return out.join('\n');
}

/** A "doc ref" names any printable document: sale:<id>, ret:<saleId>:<retId>, z:<id>. */
function resolveDoc(ref) {
  const [kind, a, b] = String(ref).split(':');
  if (kind === 'sale') { const s = state.sales.find(x => x.id === a); return s && { kind, sale: s, text: receiptText(s), title: `${s.vatRate ? 'Tax invoice' : 'Receipt'} #${saleNo(s)}` }; }
  if (kind === 'ret') {
    const s = state.sales.find(x => x.id === a); const r = s?.returns.find(x => x.id === b);
    return r && { kind, sale: s, ret: r, text: creditNoteText(s, r), title: `${s.vatRate ? 'Credit note' : 'Refund slip'} ${retNo(r)}` };
  }
  if (kind === 'z') { const z = state.cashups.find(x => x.id === a); return z && { kind, z, text: zText(z), title: `Z-report #${zNo(z)}` }; }
  return null;
}

/** "082 123 4567" -> "27821234567" for wa.me. */
function waNumber(input) {
  let d = String(input || '').replace(/\D/g, '');
  if (d.startsWith('0')) d = '27' + d.slice(1);
  return d.length >= 10 ? d : '';
}

function shareWhatsApp(ref) {
  const doc = resolveDoc(ref);
  if (!doc) return;
  const num = waNumber($('#waPhone')?.value);
  // Triple backticks make WhatsApp show the text in monospace so columns line up.
  window.open(`https://wa.me/${num}?text=${encodeURIComponent('```\n' + doc.text + '\n```')}`, '_blank', 'noopener');
}

async function copyText(text, msg = 'Copied') {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select();
    try { document.execCommand('copy'); } catch { return toast('Copy failed — select the text and copy manually', true); }
    finally { ta.remove(); }
  }
  toast(msg);
}

function printDoc(ref) {
  const doc = resolveDoc(ref);
  if (!doc) return;
  // PLUG-IN: Bluetooth / ESC-POS printer — send doc.text to the printer here
  // (Web Bluetooth or a vendor SDK) instead of the browser print dialog.
  $('#printArea').textContent = doc.text;
  setPrintMode('slip');
  window.print();
}

function showDoc(ref, { justSold = false } = {}) {
  const doc = resolveDoc(ref);
  if (!doc) return;
  const s = doc.sale;
  const canReturn = doc.kind === 'sale' && s.status !== 'returned' && can('returns');
  openModal({
    title: (justSold ? 'Sale complete · ' : '') + doc.title,
    body: `
      ${justSold && s.payment === 'cash' ? `<div class="banner info"><p>Change due: <strong class="money">${money(s.change)}</strong></p></div>` : ''}
      ${justSold && s.creditChange ? `<div class="banner info"><p>Pay out unused credit in cash: <strong class="money">${money(s.creditChange)}</strong></p></div>` : ''}
      <pre class="receipt" tabindex="0" aria-label="${esc(doc.title)}">${esc(doc.text)}</pre>
      ${doc.kind === 'ret' ? `<p class="small"><button class="link" data-action="open-doc" data-doc="sale:${esc(s.id)}">View original invoice #${saleNo(s)}</button></p>` : ''}
      ${doc.kind === 'sale' && s.returns.length ? `<p class="small">${s.returns.map(r => `<button class="link" data-action="open-doc" data-doc="ret:${esc(s.id)}:${esc(r.id)}">Credit note ${retNo(r)}</button>`).join(' · ')}</p>` : ''}
      ${doc.kind !== 'z' ? `<label class="field" style="margin-top:12px"><span>Customer WhatsApp number (optional)</span>
        <input id="waPhone" class="input" type="tel" inputmode="tel" placeholder="082 123 4567"></label>` : ''}`,
    foot: `
      <button class="btn primary" data-action="doc-wa" data-doc="${esc(ref)}">WhatsApp</button>
      <button class="btn" data-action="doc-copy" data-doc="${esc(ref)}">Copy</button>
      <button class="btn" data-action="doc-print" data-doc="${esc(ref)}">Print</button>
      ${canReturn ? `<button class="btn danger" data-action="open-return" data-id="${esc(s.id)}">Return / exchange</button>` : ''}
      <button class="btn" data-action="close-modal">${justSold ? 'New sale' : 'Close'}</button>`,
  });
}

/* ===== 12. UI helpers =================================================== */

const isWide = () => window.matchMedia('(min-width: 860px)').matches;
const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])';

function openModal({ title, body, foot = '' }) {
  const m = $('#modal');
  if (m.hidden) ui.opener = document.activeElement; // to give focus back on close
  m.innerHTML = `
    <div class="modal-head"><h2 id="modalTitle" tabindex="-1">${esc(title)}</h2>
      <button class="btn ghost sm" data-action="close-modal" aria-label="Close">✕</button></div>
    <div class="modal-body">${body}</div>
    ${foot ? `<div class="modal-foot">${foot}</div>` : ''}`;
  m.hidden = false;
  $('#backdrop').hidden = false;
  updateInert();
  const target = m.querySelector('[autofocus]') || $('#modalTitle');
  setTimeout(() => target?.focus(), 30);
}

function closeModal() {
  const m = $('#modal');
  const wasOpen = !m.hidden;
  m.hidden = true;
  m.innerHTML = '';
  ui.picker = null;
  ui.ret = null;
  if (ui.confirmResolve) { ui.confirmResolve(false); ui.confirmResolve = null; }
  if (!$('#cartPanel').classList.contains('open') || isWide()) $('#backdrop').hidden = true;
  updateInert();
  if (wasOpen && ui.opener?.isConnected && !ui.opener.closest('[inert]')) ui.opener.focus();
  ui.opener = null;
}

/** Promise-based confirm dialog. */
function confirmBox(message, okLabel = 'OK', danger = false) {
  return new Promise(resolve => {
    openModal({
      title: 'Please confirm',
      body: `<p>${esc(message)}</p>`,
      foot: `<button class="btn" data-action="close-modal">Cancel</button>
             <button class="btn ${danger ? 'danger solid' : 'primary'}" data-action="confirm-ok" autofocus>${esc(okLabel)}</button>`,
    });
    ui.confirmResolve = resolve;
  });
}

let toastTimer;
function toast(msg, isError = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.setAttribute('role', isError ? 'alert' : 'status');
  t.className = 'toast show' + (isError ? ' error' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.className = 'toast'; }, isError ? 4000 : 2200);
}

function openCartSheet() {
  $('#cartPanel').classList.add('open');
  $('#backdrop').hidden = false;
  updateInert();
  setTimeout(() => $('#cartTitle').focus(), 30);
}
function closeCartSheet() {
  const wasOpen = $('#cartPanel').classList.contains('open');
  $('#cartPanel').classList.remove('open');
  if ($('#modal').hidden) $('#backdrop').hidden = true;
  updateInert();
  if (wasOpen && !isWide() && $('#modal').hidden) $('#cartBar').focus();
}

/** Keep keyboard / screen-reader focus inside whatever is on top (blocker, modal, cart sheet). */
function updateInert() {
  const tabBlocked = !$('#blocker').hidden;
  const scanning = !$('#scanner').hidden;
  const blocked = tabBlocked || !$('#signin').hidden || !$('#setup').hidden || scanning;
  const modal = !$('#modal').hidden;
  $('#signin').inert = tabBlocked;
  $('#setup').inert = tabBlocked;
  $('#scanner').inert = tabBlocked;
  const sheet = $('#cartPanel').classList.contains('open') && !isWide();
  const back = blocked || modal || sheet;
  $('.app-header').inert = back;
  $('.app-nav').inert = back;
  $('#banners').inert = back;
  $('.sell-products').inert = back;
  $('#cartBar').inert = back;
  $$('.view:not(#view-sell)').forEach(v => { v.inert = back; });
  $('#cartPanel').inert = blocked || modal || (!isWide() && !sheet);
  $('#modal').inert = blocked;
}

function backupOverdue() {
  const last = state.settings.lastBackupAt;
  if (state.meta.demo || cloudOn()) return false; // the cloud is the backup
  if (!last) return state.sales.length > 0 || state.products.length > 0;
  return daysAgo(last) >= 7;
}

function renderBanners() {
  let html = ui.user ? licenceBanner() : '';
  if (ui.updateReady) {
    html += `<div class="banner info"><p><strong>A new version is ready.</strong> Reload to start using it — your data is kept.</p>
      <button class="btn sm primary" data-action="apply-update">Reload now</button></div>`;
  }
  if (state.meta.demo) {
    html += `<div class="banner info"><p><strong>Demo data.</strong> These products and sales are samples to try things out.</p>
      ${can('settings') ? '<button class="btn sm primary" data-action="start-fresh">Start fresh</button>' : ''}</div>`;
  }
  if (cloudOn() && Cloud.status === 'signedout') {
    html += `<div class="banner"><p><strong>Cloud sync has stopped.</strong> Sign in again so this device's sales reach your other devices.</p>
      ${can('settings') ? '<button class="btn sm primary" data-action="go-settings">Sign in</button>' : ''}</div>`;
  } else if (cloudReady() && !cloudOn() && !state.meta.demo && can('settings')) {
    html += `<div class="banner info"><p><strong>Protect your shop.</strong> Turn on cloud sync so all your devices share sales and stock, and a lost or wiped device loses nothing.</p>
      <button class="btn sm primary" data-action="go-settings">Set up</button></div>`;
  }
  if (backupOverdue() && can('settings')) {
    const last = state.settings.lastBackupAt;
    html += `<div class="banner"><p><strong>Back up your data.</strong> ${last ? `Last backup ${daysAgo(last)} days ago.` : 'No backup yet.'} Your data lives only on this device.</p>
      <button class="btn sm" data-action="backup-download">Back up now</button></div>`;
  }
  $('#banners').innerHTML = html;
}

/** Set .on + aria-pressed on a group of toggle buttons. */
function setPressed(selector, isOn) {
  $$(selector).forEach(b => { const on = isOn(b); b.classList.toggle('on', on); b.setAttribute('aria-pressed', String(on)); });
}

/* ===== 13. Views ======================================================== */

function renderAll() {
  $('#storeNameLabel').textContent = state.settings.storeName || 'Rails POS';
  // Theme: no attribute = follow the device; otherwise force light/dark.
  if (state.settings.theme === 'auto') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = state.settings.theme;
  applyPermissions();
  renderBanners();
  renderSell();
  renderCart();
  if (ui.view === 'admin') renderAdmin();
  if (ui.view === 'stock') renderStock();
  if (ui.view === 'sales') renderSales();
  if (ui.view === 'reports') renderReports();
  if (ui.view === 'settings') renderSettings();
}

function showView(name) {
  if (VIEW_PERMS[name] && !can(VIEW_PERMS[name])) {
    if (ui.user) toast(`${ui.user.name} doesn't have access to ${name}`, true);
    name = 'sell';
  }
  ui.view = name;
  $$('.view').forEach(v => v.classList.toggle('active', v.id === `view-${name}`));
  $$('.app-nav button').forEach(b => {
    const on = b.dataset.view === name;
    b.classList.toggle('active', on);
    if (on) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
  });
  document.body.classList.toggle('on-sell', name === 'sell'); // tablet: makes room for the pinned cart
  closeCartSheet();
  renderAll();
  window.scrollTo(0, 0);
  if (name === 'reports' || name === 'sales') syncNow(); // show other tills' latest sales
}

/* ----- Sell ----- */

/** "R199.00" or "from R199.00" when variants have different prices. */
function priceLabel(p) {
  const prices = [...new Set(p.variants.map(v => priceOf(p, v)))];
  if (prices.length <= 1) return money(prices[0] ?? p.price);
  return 'from ' + money(Math.min(...prices));
}

function renderSell() {
  const cats = ['All', ...new Set(state.products.map(p => p.category).filter(Boolean))];
  if (!cats.includes(ui.category)) ui.category = 'All';
  $('#catChips').innerHTML = cats.map(c =>
    `<button class="chip ${c === ui.category ? 'on' : ''}" aria-pressed="${c === ui.category}" data-action="cat" data-cat="${esc(c)}">${esc(c)}</button>`).join('');

  const q = $('#sellSearch').value.trim().toLowerCase();
  const low = state.settings.lowStock;
  const list = state.products.filter(p =>
    (ui.category === 'All' || p.category === ui.category) &&
    (!q || p.name.toLowerCase().includes(q) || p.category.toLowerCase().includes(q) ||
      p.variants.some(v => v.sku.toLowerCase().includes(q) || String(v.barcode || '').includes(q))));

  $('#productGrid').innerHTML = list.length ? list.map(p => {
    const stock = productStock(p);
    const badge = stock === 0 ? '<span class="badge out">Out</span>'
      : stock <= low ? `<span class="badge low">${stock} left</span>`
      : `<span class="badge">${stock}</span>`;
    const photo = thumbHtml(p);
    return `<button class="product-card ${stock === 0 ? 'out' : ''} ${photo ? 'has-photo' : ''}" data-action="pick" data-id="${esc(p.id)}"
        aria-label="${esc(p.name)}, ${esc(priceLabel(p))}, ${stock} in stock">
        ${photo}<span class="name">${esc(p.name)}</span>
        <span class="cat">${esc(p.category)} · ${p.variants.length} option${p.variants.length === 1 ? '' : 's'}</span>
        <span class="bottom"><span class="price money">${priceLabel(p)}</span>${badge}</span>
      </button>`;
  }).join('') : `<div class="empty">${state.products.length ? 'No products match.' : 'No products yet. Add some on the Stock screen.'}</div>`;
}

function openPicker(productId) {
  const p = findProduct(productId);
  if (!p) return;
  if (p.variants.length === 1) {
    if (addToCart(p.variants[0].id, 1)) toast(`Added ${p.name}`);
    return;
  }
  const sizes = [...new Set(p.variants.map(v => v.size))];
  const colours = [...new Set(p.variants.map(v => v.colour))];
  ui.picker = { productId, size: sizes.length === 1 ? sizes[0] : null, colour: colours.length === 1 ? colours[0] : null, qty: 1 };
  openModal({ title: p.name, body: '<div id="pickerBody"></div>', foot: '<div id="pickerFoot" class="foot-row"></div>' });
  renderPicker();
}

function renderPicker() {
  const pk = ui.picker;
  const p = pk && findProduct(pk.productId);
  if (!p) return;
  const sizes = [...new Set(p.variants.map(v => v.size))];
  const colours = [...new Set(p.variants.map(v => v.colour))];
  const avail = v => v.stock - cartQty(v.id);
  const has = (size, colour) => p.variants.some(v => (!size || v.size === size) && (!colour || v.colour === colour) && avail(v) > 0);
  const chosen = p.variants.find(v => v.size === pk.size && v.colour === pk.colour);
  const left = chosen ? avail(chosen) : 0;
  if (pk.qty > left) pk.qty = Math.max(1, left);
  const price = chosen ? priceOf(p, chosen) : null;

  $('#pickerBody').innerHTML = `
    <div class="picker-head">${thumbHtml(p, 'md')}<p class="muted" style="margin:0">${esc(p.category)} · <strong class="money">${price != null ? money(price) : esc(priceLabel(p))}</strong></p></div>
    <div class="small-label" id="lblSize">Size</div>
    <div class="opt-group" role="group" aria-labelledby="lblSize">${sizes.map(s => `<button class="opt ${pk.size === s ? 'on' : ''}" aria-pressed="${pk.size === s}" data-action="pk-size" data-v="${esc(s)}" ${has(s, pk.colour) ? '' : 'disabled'}>${esc(s)}</button>`).join('')}</div>
    <div class="small-label" id="lblColour">Colour</div>
    <div class="opt-group" role="group" aria-labelledby="lblColour">${colours.map(c => `<button class="opt ${pk.colour === c ? 'on' : ''}" aria-pressed="${pk.colour === c}" data-action="pk-colour" data-v="${esc(c)}" ${has(pk.size, c) ? '' : 'disabled'}>${esc(c)}</button>`).join('')}</div>
    <div class="row gap-s">
      <span class="grow" aria-live="polite">${chosen ? `${esc(chosen.sku)} · <strong>${left}</strong> available` : '<span class="muted">Pick a size and colour</span>'}</span>
      <span class="stepper"><button data-action="pk-qty" data-d="-1" aria-label="One less">−</button><span aria-label="Quantity">${pk.qty}</span><button data-action="pk-qty" data-d="1" aria-label="One more">+</button></span>
    </div>`;
  $('#pickerFoot').innerHTML = `<button class="btn primary block lg" data-action="pk-add" ${chosen && left > 0 ? '' : 'disabled'}>
      ${chosen && left <= 0 ? 'Out of stock' : `Add to cart${price != null ? ' · ' + money(price * pk.qty) : ''}`}</button>`;
}

/** Search box Enter: exact SKU (barcode scanner) adds 1; one match opens it. */
function onSellSearchEnter() {
  const input = $('#sellSearch');
  const found = findByCode(input.value); // SKU or tag barcode (USB/Bluetooth scanners type + Enter)
  if (found) {
    if (addToCart(found.variant.id, 1)) toast(`Added ${found.product.name} ${found.variant.size}/${found.variant.colour}`);
    input.value = '';
    renderSell();
    input.focus();
    return;
  }
  const cards = $$('#productGrid [data-action="pick"]');
  if (cards.length === 1) openPicker(cards[0].dataset.id);
  else if (!cards.length) toast('No product or SKU found', true);
}

/* ----- Cart ----- */

function renderCart() {
  const t = cartTotals();
  const cr = ui.cart.credit;
  $('#cartCredit').innerHTML = cr ? `<div class="credit-bar"><span>Exchange credit <strong>${esc(cr.label)}</strong>: <strong class="money">${money(cr.amount)}</strong></span>
    <button class="btn sm ghost" data-action="cancel-credit">Cancel</button></div>` : '';
  $('#cartItems').innerHTML = t.lines.length ? t.lines.map(l => `
    <div class="cart-line">
      <div class="cl-name">${thumbHtml(l.product, 'sm')}<div><div><strong>${esc(l.product.name)}</strong></div>
        <div class="meta">${esc(l.variant.size)} / ${esc(l.variant.colour)} · ${money(l.price)} · ${l.variant.stock} in stock</div></div></div>
      <div class="lt money">${money(l.price * l.qty)}</div>
      <div><span class="stepper">
        <button data-action="line-qty" data-id="${esc(l.variantId)}" data-d="-1" aria-label="One less ${esc(l.product.name)}">−</button>
        <span>${l.qty}</span>
        <button data-action="line-qty" data-id="${esc(l.variantId)}" data-d="1" aria-label="One more ${esc(l.product.name)}">+</button></span></div>
      <div style="text-align:right"><button class="btn ghost sm" data-action="line-remove" data-id="${esc(l.variantId)}" aria-label="Remove ${esc(l.product.name)}">Remove</button></div>
    </div>`).join('') : `<div class="empty">${cr ? 'Add the items the customer is taking in exchange.' : 'Tap a product or scan a barcode to start a sale.'}</div>`;

  setPressed('[data-action="disc-type"]', b => b.dataset.type === ui.cart.discountType);
  setPressed('[data-action="pay"]', b => b.dataset.pay === ui.cart.payment);
  renderTotals(t);
}

/** Totals only — called while typing in discount/tendered so inputs keep focus. */
function renderTotals(t = cartTotals()) {
  let rows = '';
  if (t.credit && !t.lines.length) {
    rows = `<span class="grand">Credit available</span><span class="grand money">${money(t.credit)}</span>`;
    $('#cartTotals').innerHTML = rows;
    $('#cashRow').hidden = true;
    $('#quickCash').innerHTML = '';
    $('#chargeBtn').disabled = true;
    $('#chargeBtn').textContent = 'Add exchange items';
    $('#cartBarCount').textContent = 'Exchange credit';
    $('#cartBarTotal').textContent = money(t.credit);
    return;
  }
  if (t.discount) rows += `<span>Subtotal</span><span class="money">${money(t.subtotal)}</span><span>Discount</span><span class="money">-${money(t.discount)}</span>`;
  rows += `<span class="grand">Total</span><span class="grand money">${money(t.total)}</span>`;
  if (t.rate) rows += `<span class="muted">Incl. VAT @ ${esc(t.rate)}%</span><span class="muted money">${money(t.vat)}</span>`;
  if (t.credit) {
    rows += `<span>Exchange credit</span><span class="money">-${money(t.creditUsed)}</span>`;
    rows += `<span class="grand">Amount due</span><span class="grand money">${money(t.due)}</span>`;
    if (t.creditChange && t.lines.length) rows += `<span class="change">Pay out unused credit</span><span class="change money">${money(t.creditChange)}</span>`;
  }
  if (t.cash && t.lines.length) {
    if (!Number.isFinite(t.tendered)) rows += '<span class="err">Cash tendered is not a valid amount</span>';
    else if (t.change < 0) rows += `<span class="err">Short by ${money(-t.change)}</span>`;
    else rows += `<span class="change">Change</span><span class="change money">${money(t.change)}</span>`;
  }
  $('#cartTotals').innerHTML = rows;
  $('#cashRow').hidden = !(ui.cart.payment === 'cash' && t.due > 0);

  // Quick cash buttons: exact plus the next round note amounts above what's due.
  const opts = new Set();
  [5000, 10000, 20000].forEach(step => { const v = Math.ceil(t.due / step) * step; if (v > t.due) opts.add(v); });
  $('#quickCash').innerHTML = t.due ? `<button class="btn sm" data-action="cash" data-v="">Exact</button>` +
    [...opts].slice(0, 3).map(v => `<button class="btn sm" data-action="cash" data-v="${v}">${money(v).replace('.00', '')}</button>`).join('') : '';

  const paused = !sellingAllowed();
  const blocked = paused || !t.lines.length || (t.cash && (!Number.isFinite(t.tendered) || t.change < 0));
  $('#chargeBtn').disabled = blocked;
  $('#chargeBtn').textContent = paused ? 'Selling paused (subscription)' : !t.lines.length ? 'Charge'
    : t.due === 0 ? 'Complete exchange'
    : `Charge ${money(t.due)} · ${PAY_LABEL[ui.cart.payment]}`;
  $('#cartBarCount').textContent = t.count ? `${t.count} item${t.count === 1 ? '' : 's'}${t.credit ? ' · exchange' : ''}` : (t.credit ? 'Exchange credit' : 'Cart empty');
  $('#cartBarTotal').textContent = money(t.credit ? t.due : t.total);
}

/* ----- Stock ----- */

function renderStock() {
  const q = $('#stockSearch').value.trim().toLowerCase();
  const low = state.settings.lowStock;
  $('#lowToggle').setAttribute('aria-pressed', String(ui.lowOnly));
  $('#lowToggle').textContent = `Low stock (≤${low})`;
  const rate = effectiveRate();

  const cards = state.products.map(p => {
    const match = !q || p.name.toLowerCase().includes(q) || p.category.toLowerCase().includes(q);
    let variants = p.variants.filter(v => match || v.sku.toLowerCase().includes(q) || String(v.barcode || '').includes(q) || `${v.size} ${v.colour}`.toLowerCase().includes(q));
    if (ui.lowOnly) variants = variants.filter(v => v.stock <= low);
    if (!variants.length && (ui.lowOnly || !match)) return '';
    const exVat = p.price - vatFromInclusive(p.price, rate);
    const margin = exVat ? Math.round((exVat - p.cost) / exVat * 100) : 0;
    return `<div class="card">
      <div class="prod-head">
        ${thumbHtml(p, 'md')}<div class="info"><h3>${esc(p.name)}</h3>
          <div class="small muted">${esc(p.category)} · Price <strong class="money">${money(p.price)}</strong> · Cost ${money(p.cost)} · Margin ${margin}% · ${productStock(p)} in stock</div></div>
        <div class="actions">
          <button class="btn sm" data-action="receive" data-id="${esc(p.id)}">Receive</button>
          <button class="btn sm" data-action="history" data-id="${esc(p.id)}">History</button>
          <button class="btn sm" data-action="edit-product" data-id="${esc(p.id)}">Edit</button>
          <button class="btn sm" data-action="add-variant" data-id="${esc(p.id)}">+ Variant</button>
          <button class="btn sm" data-action="labels" data-id="${esc(p.id)}">Labels</button>
        </div>
      </div>
      ${variants.map(v => `
        <div class="var-row ${v.stock === 0 ? 'out' : v.stock <= low ? 'low' : ''}">
          <button class="var-label" data-action="edit-variant" data-id="${esc(v.id)}" aria-label="Edit variant ${esc(v.size)} ${esc(v.colour)}">
            <span class="label"><strong>${esc(v.size)} / ${esc(v.colour)}</strong><span class="state-tag">${v.stock === 0 ? ' · out' : v.stock <= low ? ' · low' : ''}</span></span>
            <span class="sku">${esc(v.sku)}${v.barcode ? ` · ${esc(v.barcode)}` : ''}${v.price != null ? ` · <span class="price-tag">${money(v.price)}</span>` : ''}</span>
          </button>
          <span class="stepper">
            <button data-action="stock-d" data-id="${esc(v.id)}" data-d="-1" aria-label="Decrease stock ${esc(v.size)} ${esc(v.colour)}">−</button>
            <input type="number" inputmode="numeric" min="0" value="${v.stock}" data-stock-input="${esc(v.id)}" aria-label="Stock for ${esc(p.name)} ${esc(v.size)} ${esc(v.colour)}">
            <button data-action="stock-d" data-id="${esc(v.id)}" data-d="1" aria-label="Increase stock ${esc(v.size)} ${esc(v.colour)}">+</button>
          </span>
        </div>`).join('')}
    </div>`;
  }).join('');
  $('#stockList').innerHTML = cards || `<div class="empty">${ui.lowOnly ? 'Nothing is low on stock.' : 'No products yet. Tap “+ Product”.'}</div>`;
}

function productForm(p) {
  const cats = [...new Set(state.products.map(x => x.category).filter(Boolean))];
  return `
    <label class="field"><span>Name</span><input class="input" id="fName" value="${esc(p?.name || '')}" autofocus></label>
    <label class="field"><span>Category</span><input class="input" id="fCat" list="catList" value="${esc(p?.category || '')}" placeholder="e.g. Tops">
      <datalist id="catList">${cats.map(c => `<option value="${esc(c)}">`).join('')}</datalist></label>
    <div class="grid-2">
      <label class="field"><span>Price${state.settings.vatRegistered ? ' incl. VAT' : ''} (R)</span><input class="input" id="fPrice" inputmode="decimal" value="${p ? centsToPlain(p.price) : ''}"></label>
      <label class="field"><span>Cost (R)</span><input class="input" id="fCost" inputmode="decimal" value="${p ? centsToPlain(p.cost) : ''}"></label>
    </div>
    <div class="field"><span>Photo (optional, kept small)</span>
      <div class="photo-row">
        <span id="fPhotoPrev"></span>
        <label class="btn sm" tabindex="0" role="button" data-file-trigger>
          <svg class="ico-sm" aria-hidden="true"><use href="#i-camera"/></svg>Take or choose photo
          <input type="file" id="fPhoto" accept="image/*" hidden></label>
        <button type="button" class="btn sm ghost" data-action="photo-remove">Remove</button>
      </div>
    </div>`;
}

function readProductForm() {
  const name = $('#fName').value.trim();
  const category = $('#fCat').value.trim() || 'General';
  const price = parseMoney($('#fPrice').value);
  const cost = $('#fCost').value.trim() === '' ? 0 : parseMoney($('#fCost').value);
  if (!name) { toast('Enter a product name', true); return null; }
  if (!Number.isFinite(price) || price <= 0) { toast('Enter a valid price', true); return null; }
  if (!Number.isFinite(cost) || cost < 0) { toast('Enter a valid cost', true); return null; }
  return { name, category, price, cost, photo: ui.formPhoto || null };
}

function openAddProduct() {
  ui.formPhoto = null;
  openModal({
    title: 'Add product',
    body: productForm(null) + `
      <label class="field"><span>Sizes (comma separated)</span><input class="input" id="fSizes" value="S, M, L, XL"></label>
      <label class="field"><span>Colours (comma separated)</span><input class="input" id="fColours" value="Black"></label>
      <div class="row gap-s" style="margin-bottom:8px"><label class="grow small-label" for="fAll">Starting stock per variant</label>
        <input class="input sm w-90" id="fAll" inputmode="numeric" value="0"><button class="btn sm" data-action="np-all">Set all</button></div>
      <div id="variantGrid" class="variant-grid"></div>`,
    foot: `<button class="btn" data-action="close-modal">Cancel</button><button class="btn primary" data-action="np-save">Save product</button>`,
  });
  renderVariantGrid();
  paintPhotoPreview();
}

/** Rebuild the size × colour grid in the Add product form, keeping typed values. */
function renderVariantGrid() {
  const grid = $('#variantGrid');
  if (!grid) return;
  const prev = Object.fromEntries($$('input[data-key]', grid).map(i => [i.dataset.key, i.value]));
  const sizes = splitList($('#fSizes').value);
  const colours = splitList($('#fColours').value);
  const combos = colours.flatMap(c => sizes.map(s => ({ s, c, key: `${s}|${c}` })));
  grid.innerHTML = combos.length
    ? `<span class="small-label">${combos.length} variant${combos.length === 1 ? '' : 's'}</span><span class="small-label">Stock</span>` +
      combos.map((x, i) => `<label for="vg${i}">${esc(x.s)} / ${esc(x.c)}</label><input class="input" id="vg${i}" inputmode="numeric" data-key="${esc(x.key)}" value="${esc(prev[x.key] ?? $('#fAll').value)}">`).join('')
    : '<span class="muted">Add at least one size and one colour.</span>';
}

async function saveNewProduct() {
  const base = readProductForm();
  if (!base) return;
  const sizes = splitList($('#fSizes').value);
  const colours = splitList($('#fColours').value);
  if (!sizes.length || !colours.length) return toast('Add at least one size and one colour', true);
  const stockByKey = Object.fromEntries($$('#variantGrid input[data-key]').map(i => [i.dataset.key, i.value]));
  const product = { id: uid('p'), ...base, created: Date.now(), variants: [] };
  if (!product.photo) delete product.photo;
  for (const colour of colours) for (const size of sizes) {
    product.variants.push({
      id: uid('v'), size, colour,
      sku: makeSku(base.name, size, colour, product.variants),
      stock: Math.max(0, parseInt(stockByKey[`${size}|${colour}`], 10) || 0),
    });
  }
  state.products.push(product);
  const moves = product.variants.filter(v => v.stock).map(v => opPut('movements', movement(product, v, v.stock, 'new')));
  await persist([opPut('products', product), ...moves]);
  closeModal();
  renderAll();
  toast(`Added ${product.name} (${product.variants.length} variants)`);
}

function openEditProduct(id) {
  const p = findProduct(id);
  if (!p) return;
  ui.formPhoto = photoSrc(p);
  openModal({
    title: 'Edit product',
    body: productForm(p) + '<p class="small muted">Price changes apply to new sales only. Past receipts keep the price they were sold at. Variants with their own price keep it.</p>',
    foot: `<button class="btn danger" data-action="delete-product" data-id="${esc(id)}">Delete product</button>
      <button class="btn" data-action="close-modal">Cancel</button><button class="btn primary" data-action="ep-save" data-id="${esc(id)}">Save</button>`,
  });
  paintPhotoPreview();
}

async function saveEditProduct(id) {
  const p = findProduct(id);
  const base = p && readProductForm();
  if (!base) return;
  Object.assign(p, base);
  if (!p.photo) delete p.photo;
  await persist([opPut('products', p)]);
  closeModal();
  renderAll();
  toast('Product updated');
}

/** Add or edit one variant (size, colour, SKU, optional own price/cost). */
function openVariantForm(productId, variantId = null) {
  const p = findProduct(productId);
  if (!p) return;
  const v = variantId ? p.variants.find(x => x.id === variantId) : null;
  openModal({
    title: `${v ? 'Edit' : 'Add'} variant · ${p.name}`,
    body: `
      <div class="grid-2">
        <label class="field"><span>Size</span><input class="input" id="vSize" value="${esc(v?.size || '')}" autofocus></label>
        <label class="field"><span>Colour</span><input class="input" id="vColour" value="${esc(v?.colour || '')}"></label>
      </div>
      <div class="grid-2">
        <label class="field"><span>SKU ${v ? '' : '(blank = auto)'}</span><input class="input" id="vSku" value="${esc(v?.sku || '')}"></label>
        ${v ? '' : '<label class="field"><span>Stock</span><input class="input" id="vStock" inputmode="numeric" value="0"></label>'}
      </div>
      <div class="field"><label for="vBarcode">Barcode on the tag (optional)</label>
        <div class="row gap-s">
          <input class="input grow" id="vBarcode" inputmode="numeric" autocomplete="off" value="${esc(v?.barcode || '')}" placeholder="Scan or type it">
          <button type="button" class="btn" data-action="scan" data-target="vBarcode" aria-label="Scan the barcode with the camera"><svg class="ico-sm" aria-hidden="true"><use href="#i-scan"/></svg>Scan</button>
        </div>
      </div>
      <div class="grid-2">
        <label class="field"><span>Own price (R)</span><input class="input" id="vPrice" inputmode="decimal" placeholder="${centsToPlain(p.price)}" value="${v?.price != null ? centsToPlain(v.price) : ''}"></label>
        <label class="field"><span>Own cost (R)</span><input class="input" id="vCost" inputmode="decimal" placeholder="${centsToPlain(p.cost)}" value="${v?.cost != null ? centsToPlain(v.cost) : ''}"></label>
      </div>
      <p class="small muted" style="margin-top:0">Leave price and cost blank to use the product's (${money(p.price)} / ${money(p.cost)}). Use them when e.g. XXL costs more.</p>`,
    foot: `${v ? `<button class="btn danger" data-action="delete-variant" data-id="${esc(v.id)}">Delete variant</button>` : ''}
      <button class="btn" data-action="close-modal">Cancel</button>
      <button class="btn primary" data-action="variant-save" data-pid="${esc(p.id)}" data-id="${esc(v?.id || '')}">${v ? 'Save' : 'Add variant'}</button>`,
  });
}

async function saveVariant(productId, variantId) {
  const p = findProduct(productId);
  if (!p) return;
  const v = variantId ? p.variants.find(x => x.id === variantId) : null;
  const size = $('#vSize').value.trim();
  const colour = $('#vColour').value.trim();
  if (!size || !colour) return toast('Enter a size and a colour', true);
  if (p.variants.some(x => x !== v && x.size.toLowerCase() === size.toLowerCase() && x.colour.toLowerCase() === colour.toLowerCase())) {
    return toast('That size/colour already exists', true);
  }
  let sku = $('#vSku').value.trim().toUpperCase();
  const clash = sku && findBySku(sku);
  if (clash && clash.variant !== v) return toast('That SKU is already used', true);
  const barcode = $('#vBarcode').value.trim().replace(/\s+/g, '');
  const bClash = barcode && findByCode(barcode);
  if (bClash && bClash.variant !== v) return toast(`That barcode is already on ${bClash.product.name} ${bClash.variant.size}/${bClash.variant.colour}`, true);
  const priceTxt = $('#vPrice').value.trim();
  const costTxt = $('#vCost').value.trim();
  const price = priceTxt === '' ? null : parseMoney(priceTxt);
  const cost = costTxt === '' ? null : parseMoney(costTxt);
  if (price !== null && (!Number.isFinite(price) || price <= 0)) return toast('Enter a valid price or leave it blank', true);
  if (cost !== null && (!Number.isFinite(cost) || cost < 0)) return toast('Enter a valid cost or leave it blank', true);
  const ops = [];
  if (v) {
    Object.assign(v, { size, colour, sku: sku || v.sku });
    if (price === null) delete v.price; else v.price = price;
    if (cost === null) delete v.cost; else v.cost = cost;
    if (barcode) v.barcode = barcode; else delete v.barcode;
  } else {
    const nv = { id: uid('v'), size, colour, sku: sku || makeSku(p.name, size, colour), stock: Math.max(0, parseInt($('#vStock').value, 10) || 0) };
    if (barcode) nv.barcode = barcode;
    if (price !== null) nv.price = price;
    if (cost !== null) nv.cost = cost;
    p.variants.push(nv);
    if (nv.stock) ops.push(opPut('movements', movement(p, nv, nv.stock, 'new')));
  }
  ops.push(opPut('products', p));
  await persist(ops);
  closeModal();
  renderAll();
  toast(v ? 'Variant updated' : 'Variant added');
}

async function deleteVariant(variantId) {
  const f = findVariant(variantId);
  if (!f) return;
  if (f.product.variants.length === 1) return toast('A product needs at least one variant — delete the product instead', true);
  if (!(await confirmBox(`Delete ${f.product.name} ${f.variant.size}/${f.variant.colour}? Past sales are kept.`, 'Delete', true))) return;
  f.product.variants = f.product.variants.filter(v => v !== f.variant);
  ui.cart.lines = ui.cart.lines.filter(l => l.variantId !== variantId);
  await persist([opPut('products', f.product), opKv('cart', ui.cart)]);
  renderAll();
  toast('Variant deleted');
}

async function deleteProduct(id) {
  const p = findProduct(id);
  if (!p) return;
  if (!(await confirmBox(`Delete “${p.name}” and all ${p.variants.length} variants? Past sales are kept.`, 'Delete', true))) return;
  state.products = state.products.filter(x => x !== p);
  const ids = new Set(p.variants.map(v => v.id));
  ui.cart.lines = ui.cart.lines.filter(l => !ids.has(l.variantId));
  await persist([{ store: 'products', key: p.id, del: true }, opKv('cart', ui.cart)]);
  renderAll();
  toast('Product deleted');
}

/* ----- Sales history ----- */

function renderSales() {
  const q = $('#salesSearch').value.trim().toLowerCase();
  const list = state.sales.slice().reverse().filter(s => !q ||
    saleNo(s).toLowerCase().includes(q) || String(s.number) === q ||
    s.customer?.name?.toLowerCase().includes(q) ||
    s.items.some(it => it.name.toLowerCase().includes(q) || it.sku.toLowerCase().includes(q)));
  $('#salesList').innerHTML = list.length ? list.slice(0, 300).map(saleRow).join('') +
    (list.length > 300 ? '<p class="muted small">Showing the latest 300. Export CSV for everything.</p>' : '')
    : '<div class="empty">No sales yet.</div>';
}

function saleRow(s) {
  const n = sum(s.items, it => it.qty);
  const badge = s.status === 'returned' ? '<span class="badge returned">Returned</span>'
    : s.status === 'partial' ? '<span class="badge low">Part returned</span>' : '';
  return `<button class="sale-row ${s.status}" data-action="open-doc" data-doc="sale:${esc(s.id)}">
    <span><strong>#${saleNo(s)}</strong> ${badge}</span>
    <span class="t money">${money(s.total)}</span>
    <span class="small muted">${fmtDT(s.date)} · ${n} item${n === 1 ? '' : 's'}${s.customer ? ' · ' + esc(s.customer.name) : ''}</span>
    <span class="small muted" style="text-align:right">${esc(PAY_LABEL[s.payment] || s.payment)}</span>
  </button>`;
}

/* ----- Reports ----- */

function renderReports() {
  // Cash-up card for the current shift
  const sh = computeShift(state.meta.lastCashupAt, new Date().toISOString());
  const recentZ = state.cashups.slice(-5).reverse();
  $('#cashupCard').innerHTML = `<div class="card cashup">
      <div class="row gap-s" style="flex-wrap:wrap">
        <div class="grow"><h3>Current shift</h3>
          <div class="small muted">Since ${sh.from ? fmtDT(sh.from) : 'the first sale'} · ${sh.salesCount} sales · expected cash in drawer <strong class="money" data-k="expected">${money(sh.expected)}</strong></div></div>
        <button class="btn primary" data-action="cashup">Cash up</button>
      </div>
      ${recentZ.length ? `<div class="z-list">${recentZ.map(z => `<button class="link" data-action="open-doc" data-doc="z:${esc(z.id)}">Z${zNo(z)} · ${fmtDate(z.to)} · ${z.diff === 0 ? 'balanced' : (z.diff > 0 ? 'over ' : 'short ') + money(Math.abs(z.diff))}</button>`).join('')}</div>` : ''}
    </div>`;

  // Period picker
  $('#rangeSeg').innerHTML = RANGES.map(([k, l]) => `<button data-action="range" data-range="${k}">${l}</button>`).join('');
  setPressed('[data-action="range"]', b => b.dataset.range === ui.reportRange);
  const range = reportRange();
  $('#customRange').hidden = ui.reportRange !== 'custom';
  $('#rFrom').value = toDateInput(range.from);
  $('#rTo').value = toDateInput(addDays(range.to, -1));

  const r = buildReport(range);
  const prev = previousRevenue(range);
  const methods = ['cash', 'card', 'eft', 'credit'].filter(k => k !== 'credit' || r.byPayment.credit.sales || r.byPayment.credit.refunds);
  const payTotal = Math.max(1, sum(methods, k => Math.max(0, r.byPayment[k].sales - r.byPayment[k].refunds)));
  const vatOn = r.vat !== 0 || effectiveRate() > 0;
  const pct = n => `${Math.round(n)}%`;

  // "▲ 12% vs previous 7 days"
  let trend = '';
  if (prev !== null && prev !== 0) {
    const change = (r.revenue - prev) / Math.abs(prev) * 100;
    const word = range.days === 1 ? 'previous day' : `previous ${range.days} days`;
    trend = `<div class="trend ${change >= 0 ? 'up' : 'down'}">${change >= 0 ? '▲' : '▼'} ${pct(Math.abs(change))} vs ${word}</div>`;
  } else if (prev === null && r.count) {
    trend = '<div class="trend">No sales in the period before</div>';
  }

  // Takings chart (CSS bars). Hours for one day, days otherwise.
  const pts = r.series.points;
  const maxPt = Math.max(1, ...pts.map(p => p.amount));
  const best = pts.reduce((a, p) => (p.amount > (a?.amount ?? 0) ? p : a), null);
  const every = pts.length > 20 ? 5 : pts.length > 12 ? 2 : 1;
  const chart = `<div class="chart" style="--n:${pts.length}" role="img" aria-label="Takings per ${r.series.unit}${best ? `; best ${esc(best.label)} with ${money(best.amount)}` : ''}">
    ${pts.map((p, i) => `<div class="chart-col" title="${esc(p.label)}: ${money(p.amount)} · ${p.count} sale${p.count === 1 ? '' : 's'}">
      <span class="chart-bar${p === best ? ' best' : ''}" style="height:${Math.max(0, Math.round(p.amount / maxPt * 100))}%"></span>
      <span class="chart-lbl">${i % every === 0 || p === best ? esc(p.short) : ''}</span></div>`).join('')}
  </div>
  <p class="small muted chart-note">${best ? `Best ${r.series.unit}: <strong>${esc(best.label)}</strong> · <span class="money">${money(best.amount)}</span>` : 'No sales in this period.'}</p>`;

  $('#reportBody').innerHTML = `
    <p class="small muted" style="margin:0 0 10px"><strong>${esc(range.label)}</strong> · refunds counted on the day they happen</p>
    <div class="kpis">
      <div class="kpi hero"><div class="label">Net takings${vatOn ? ' (incl. VAT)' : ''}</div><div class="value money" data-k="revenue">${money(r.revenue)}</div>
        <div class="sub">${r.refunds ? `<span class="money">${money(r.gross)}</span> sales − <span class="money neg">${money(r.refunds)}</span> refunds` : vatOn ? `VAT <span class="money">${money(r.vat)}</span>` : 'not VAT registered'}</div>${trend}</div>
      <div class="kpi"><div class="label">Gross profit</div><div class="value money ${r.profit < 0 ? 'neg' : ''}" data-k="profit">${money(r.profit)}</div>
        <div class="sub">${r.exVat > 0 ? `${r.margin}% margin · ` : ''}cost <span class="money">${money(r.cost)}</span></div></div>
      <div class="kpi"><div class="label">Sales</div><div class="value num" data-k="count">${r.count}</div><div class="sub">${r.items} items · ${r.rets.length} refund${r.rets.length === 1 ? '' : 's'}</div></div>
      <div class="kpi"><div class="label">Average sale</div><div class="value money" data-k="avg">${money(r.avg)}</div><div class="sub">${r.discounts ? `discounts given <span class="money neg">${money(r.discounts)}</span>` : 'per customer'}</div></div>
    </div>

    <div class="section-title">Takings per ${r.series.unit}</div>
    <div class="card">${chart}</div>

    <div class="report-cols">
      <div>
        <div class="section-title">By payment method</div>
        <div class="card bars">${methods.map(k => {
          const b = r.byPayment[k];
          const net = b.sales - b.refunds;
          return `<div class="bar-row"><span>${PAY_LABEL[k] === 'Exchange credit' ? 'Credit' : PAY_LABEL[k]}</span>
            <span class="bar-track" aria-hidden="true"><span class="bar-fill" style="width:${Math.round(Math.max(0, net) / payTotal * 100)}%"></span></span>
            <span class="small pay-amt"><span class="money" data-k="pay-${k}">${money(net)}${b.refunds ? ` <span class="muted">(−${money(b.refunds)})</span>` : ''}</span>
              <span class="muted pay-pct">${pct(Math.max(0, net) / payTotal * 100)}</span></span></div>`;
        }).join('')}
        <p class="small muted" style="margin:6px 0 0">Net of refunds. Cash refunds include unused exchange credit paid out.</p>
        </div>

        <div class="section-title">By category</div>
        <div class="card">${r.categories.length ? `<table class="list-table">${r.categories.map(c => `
          <tr><td>${esc(c.name)} <span class="muted small">· ${c.qty} item${c.qty === 1 ? '' : 's'}</span></td><td><span class="money">${money(c.amount)}</span></td></tr>`).join('')}</table>
          <p class="small muted" style="margin:6px 0 0">Shelf prices, before sale discounts.</p>`
          : '<div class="muted small">No sales in this period.</div>'}</div>
      </div>
      <div>
        <div class="section-title">Top sellers</div>
        <div class="card">${r.top.length ? `<table class="list-table">${r.topAll.slice(0, 8).map((t, i) => `
          <tr><td><span class="rank">${i + 1}</span>${esc(t.name)}</td><td>${t.qty} sold · <span class="money">${money(t.amount)}</span></td></tr>`).join('')}</table>`
          : '<div class="muted small">No sales in this period.</div>'}</div>

        <div class="section-title">By cashier</div>
        <div class="card">${r.cashiers.length ? `<table class="list-table">${r.cashiers.map(c => `
          <tr><td>${esc(c.name)} <span class="muted small">· ${c.count} sale${c.count === 1 ? '' : 's'}</span></td><td><span class="money">${money(c.amount)}</span></td></tr>`).join('')}</table>`
          : '<div class="muted small">No sales in this period.</div>'}</div>

        ${vatOn ? `<div class="section-title">VAT summary</div>
        <div class="card"><table class="list-table">
          <tr><td>Takings incl. VAT</td><td><span class="money">${money(r.revenue)}</span></td></tr>
          <tr><td>VAT (output tax)</td><td><span class="money">${money(r.vat)}</span></td></tr>
          <tr><td>Takings excl. VAT</td><td><span class="money">${money(r.exVat)}</span></td></tr>
        </table></div>` : ''}
      </div>
    </div>
    <div class="section-title">Recent sales</div>
    ${r.sales.length ? r.sales.slice().reverse().slice(0, 10).map(saleRow).join('') : '<div class="empty">No sales in this period.</div>'}`;
}

/* ----- A4 printed reports ----- */

const A4_REPORTS = [
  ['summary', 'Sales summary', 'Takings, profit, VAT, payments, categories, top sellers and every day in the period'],
  ['sales', 'Sales list', 'Every sale and refund in the period, with totals — for your bookkeeper'],
  ['stock', 'Stock on hand', 'Every product and size with quantity, cost value and selling value'],
  ['cashups', 'Cash-ups', 'Each Z-report in the period: expected and counted cash, over or short'],
];

function openPrintMenu() {
  const range = reportRange();
  openModal({
    title: 'Print an A4 report',
    body: `<p class="small muted" style="margin-top:0">Period: <strong>${esc(range.label)}</strong> (change it with the buttons above the report). On an iPad or phone, the print screen also lets you save as PDF or share it.</p>
      ${A4_REPORTS.map(([k, l, d], i) => `<label class="check print-opt"><input type="radio" name="a4kind" value="${k}" ${i === 0 ? 'checked' : ''}>
        <span><strong>${esc(l)}</strong><br><span class="small muted">${esc(d)}</span></span></label>`).join('')}`,
    foot: `<button class="btn" data-action="close-modal">Cancel</button><button class="btn primary" data-action="print-a4">Print</button>`,
  });
}

/** Store details + title block at the top of every A4 page set. */
function a4Header(title, subtitle) {
  const st = state.settings;
  return `<header class="a4-head">
    <div><div class="a4-store">${esc(st.storeName)}</div>
      <div class="a4-addr">${esc(st.storeAddress || '').replace(/\n/g, ' · ')}${st.storePhone ? ` · ${esc(st.storePhone)}` : ''}${effectiveRate() > 0 && st.vatNumber ? ` · VAT No. ${esc(st.vatNumber)}` : ''}</div></div>
    <div class="a4-title"><h1>${esc(title)}</h1><div>${esc(subtitle)}</div></div>
  </header>`;
}
const a4Foot = () => `<footer class="a4-foot">Printed ${esc(fmtDT(new Date().toISOString()))}${ui.user ? ` by ${esc(ui.user.name)}` : ''} · Rails POS</footer>`;
const m4 = (cents, cls = '') => `<span class="m ${cents < 0 || cls === 'neg' ? 'neg' : ''}">${money(cents)}</span>`;

function a4Summary(range) {
  const r = buildReport(range);
  const vatOn = r.vat !== 0 || effectiveRate() > 0;
  const methods = ['cash', 'card', 'eft', 'credit'].filter(k => k !== 'credit' || r.byPayment.credit.sales || r.byPayment.credit.refunds);
  const dayRows = r.series.unit === 'day'
    ? r.series.points
    : [{ label: range.label, amount: r.revenue, count: r.count }];
  return `${a4Header('Sales summary', range.label)}
    <section class="a4-kpis">
      <div><span>Net takings${vatOn ? ' (incl. VAT)' : ''}</span>${m4(r.revenue)}</div>
      <div><span>Gross profit</span>${m4(r.profit)}<small>${r.exVat > 0 ? `${r.margin}% margin` : ''}</small></div>
      <div><span>Sales</span><b>${r.count}</b><small>${r.items} items</small></div>
      <div><span>Average sale</span>${m4(r.avg)}</div>
    </section>
    <div class="a4-cols">
      <section><h2>Takings</h2><table>
        <tr><td>Sales</td><td class="r">${m4(r.gross)}</td></tr>
        <tr><td>Refunds (${r.rets.length})</td><td class="r">${m4(-r.refunds)}</td></tr>
        <tr class="tot"><td>Net takings</td><td class="r">${m4(r.revenue)}</td></tr>
        ${vatOn ? `<tr><td>VAT included</td><td class="r">${m4(r.vat)}</td></tr><tr><td>Net takings excl. VAT</td><td class="r">${m4(r.exVat)}</td></tr>` : ''}
        <tr><td>Cost of goods sold</td><td class="r">${m4(-r.cost)}</td></tr>
        <tr class="tot"><td>Gross profit</td><td class="r">${m4(r.profit)}</td></tr>
        ${r.discounts ? `<tr><td>Discounts given</td><td class="r">${m4(r.discounts)}</td></tr>` : ''}
      </table></section>
      <section><h2>Payment methods</h2><table>
        <tr><th>Method</th><th class="r">Sales</th><th class="r">Refunds</th><th class="r">Net</th></tr>
        ${methods.map(k => { const b = r.byPayment[k]; return `<tr><td>${PAY_LABEL[k]}</td><td class="r">${m4(b.sales)}</td><td class="r">${m4(-b.refunds)}</td><td class="r">${m4(b.sales - b.refunds)}</td></tr>`; }).join('')}
      </table></section>
    </div>
    <div class="a4-cols">
      <section><h2>Categories</h2><table>
        <tr><th>Category</th><th class="r">Items</th><th class="r">Amount</th></tr>
        ${r.categories.map(c => `<tr><td>${esc(c.name)}</td><td class="r">${c.qty}</td><td class="r">${m4(c.amount)}</td></tr>`).join('') || '<tr><td colspan="3">No sales</td></tr>'}
      </table></section>
      <section><h2>Top sellers</h2><table>
        <tr><th>#</th><th>Product</th><th class="r">Sold</th><th class="r">Amount</th></tr>
        ${r.topAll.slice(0, 10).map((t, i) => `<tr><td>${i + 1}</td><td>${esc(t.name)}</td><td class="r">${t.qty}</td><td class="r">${m4(t.amount)}</td></tr>`).join('') || '<tr><td colspan="4">No sales</td></tr>'}
      </table></section>
    </div>
    ${r.cashiers.length ? `<section><h2>Cashiers</h2><table>
      <tr><th>Cashier</th><th class="r">Sales</th><th class="r">Amount</th></tr>
      ${r.cashiers.map(c => `<tr><td>${esc(c.name)}</td><td class="r">${c.count}</td><td class="r">${m4(c.amount)}</td></tr>`).join('')}
    </table></section>` : ''}
    ${dayRows.length > 1 ? `<section><h2>Day by day</h2><table>
      <tr><th>Day</th><th class="r">Sales</th><th class="r">Net takings</th></tr>
      ${dayRows.map(p => `<tr><td>${esc(p.label)}</td><td class="r">${p.count}</td><td class="r">${m4(p.amount)}</td></tr>`).join('')}
      <tr class="tot"><td>Total</td><td class="r">${r.count}</td><td class="r">${m4(r.revenue)}</td></tr>
    </table></section>` : ''}
    ${a4Foot()}`;
}

function a4SalesList(range) {
  const r = buildReport(range);
  const rows = [
    ...r.sales.map(s => ({ date: s.date, doc: `#${saleNo(s)}`, who: s.cashier || '', how: PAY_LABEL[s.payment] || s.payment,
      items: sum(s.items, it => it.qty), disc: s.discount || 0, vat: s.vat, total: s.total, note: s.customer?.name || '' })),
    ...r.rets.map(({ sale, ret }) => ({ date: ret.date, doc: retNo(ret), who: ret.cashier || '', how: PAY_LABEL[ret.method] || ret.method,
      items: -sum(ret.items, ri => ri.qty), disc: 0, vat: -ret.vat, total: -ret.amount, note: `Refund on #${saleNo(sale)}` })),
  ].sort((a, b) => a.date.localeCompare(b.date));
  return `${a4Header('Sales list', range.label)}
    <table class="a4-list">
      <thead><tr><th>Date</th><th>Time</th><th>No.</th><th>Cashier</th><th>Payment</th><th class="r">Items</th><th class="r">Discount</th><th class="r">VAT</th><th class="r">Total</th><th>Note</th></tr></thead>
      <tbody>${rows.map(x => `<tr class="${x.total < 0 ? 'refund' : ''}"><td>${fmtDate(x.date)}</td><td>${fmtTime(x.date)}</td><td>${x.doc}</td><td>${esc(x.who)}</td><td>${esc(x.how)}</td>
        <td class="r">${x.items}</td><td class="r">${x.disc ? m4(x.disc) : ''}</td><td class="r">${m4(x.vat)}</td><td class="r">${m4(x.total)}</td><td>${esc(x.note)}</td></tr>`).join('')
        || '<tr><td colspan="10">No sales in this period.</td></tr>'}</tbody>
      <tfoot><tr class="tot"><td colspan="5">${r.count} sales · ${r.rets.length} refunds</td><td class="r">${r.items}</td><td class="r">${m4(r.discounts)}</td><td class="r">${m4(r.vat)}</td><td class="r">${m4(r.revenue)}</td><td></td></tr></tfoot>
    </table>
    ${a4Foot()}`;
}

function a4Stock() {
  const s = stockSummary();
  const byProduct = state.products.slice().sort((a, b) => (a.category || '').localeCompare(b.category || '') || a.name.localeCompare(b.name));
  return `${a4Header('Stock on hand', `As at ${fmtLong(new Date())}`)}
    <section class="a4-kpis">
      <div><span>Units in stock</span><b>${s.units}</b></div>
      <div><span>Value at cost</span>${m4(s.costValue)}</div>
      <div><span>Value at selling price</span>${m4(s.retailValue)}</div>
      <div><span>Low or out of stock</span><b>${s.lowCount}</b><small>at or below ${Number(state.settings.lowStock) || 0}</small></div>
    </section>
    <table class="a4-list">
      <thead><tr><th>Product</th><th>Size / colour</th><th>SKU</th><th class="r">Qty</th><th class="r">Cost</th><th class="r">Price</th><th class="r">Cost value</th><th class="r">Selling value</th></tr></thead>
      <tbody>${byProduct.map(p => p.variants.map((v, i) => {
        const row = s.rows.find(x => x.variant === v);
        return `<tr class="${row.low ? 'low' : ''} ${i === 0 ? 'first' : ''}"><td>${i === 0 ? `<b>${esc(p.name)}</b><br><small>${esc(p.category || '')}</small>` : ''}</td>
          <td>${esc(v.size)} / ${esc(v.colour)}</td><td class="sku">${esc(v.sku)}</td><td class="r">${v.stock}${row.low ? ' !' : ''}</td>
          <td class="r">${m4(row.cost)}</td><td class="r">${m4(row.price)}</td><td class="r">${m4(row.costValue)}</td><td class="r">${m4(row.retailValue)}</td></tr>`;
      }).join('')).join('') || '<tr><td colspan="8">No products yet.</td></tr>'}</tbody>
      <tfoot><tr class="tot"><td colspan="3">Total</td><td class="r">${s.units}</td><td></td><td></td><td class="r">${m4(s.costValue)}</td><td class="r">${m4(s.retailValue)}</td></tr></tfoot>
    </table>
    <p class="a4-note">! = at or below the low-stock level.</p>
    ${a4Foot()}`;
}

function a4Cashups(range) {
  const zs = state.cashups.filter(z => { const d = new Date(z.to); return d >= range.from && d < range.to; });
  return `${a4Header('Cash-ups', range.label)}
    <table class="a4-list">
      <thead><tr><th>Z no.</th><th>From</th><th>To</th><th class="r">Sales</th><th class="r">Net takings</th><th class="r">Expected cash</th><th class="r">Counted</th><th class="r">Over / short</th></tr></thead>
      <tbody>${zs.map(z => `<tr><td>Z${zNo(z)}</td><td>${z.from ? fmtDT(z.from) : '—'}</td><td>${fmtDT(z.to)}</td><td class="r">${z.salesCount}</td>
        <td class="r">${m4(z.net)}</td><td class="r">${m4(z.expected)}</td><td class="r">${m4(z.counted)}</td>
        <td class="r">${z.diff === 0 ? 'Balanced' : m4(z.diff, z.diff < 0 ? 'neg' : '')}</td></tr>`).join('')
        || '<tr><td colspan="8">No cash-ups in this period.</td></tr>'}</tbody>
      ${zs.length ? `<tfoot><tr class="tot"><td colspan="3">${zs.length} cash-up${zs.length === 1 ? '' : 's'}</td><td class="r">${sum(zs, z => z.salesCount)}</td><td class="r">${m4(sum(zs, z => z.net))}</td>
        <td class="r">${m4(sum(zs, z => z.expected))}</td><td class="r">${m4(sum(zs, z => z.counted))}</td><td class="r">${m4(sum(zs, z => z.diff))}</td></tr></tfoot>` : ''}
    </table>
    ${a4Foot()}`;
}

/** Build the chosen report into #printA4 and open the print dialog on A4 paper. */
function printA4(kind) {
  const range = reportRange();
  const html = kind === 'sales' ? a4SalesList(range) : kind === 'stock' ? a4Stock() : kind === 'cashups' ? a4Cashups(range) : a4Summary(range);
  $('#printA4').innerHTML = html;
  setPrintMode('a4');
  closeModal();
  setTimeout(() => window.print(), 50); // let the modal close first
}

/** Receipts print on the till slip; A4 reports need an A4 page size. */
function setPrintMode(mode, pageCss = '@page { size: A4 portrait; margin: 12mm 12mm 14mm; }') {
  document.body.classList.toggle('printing-a4', mode === 'a4');
  let st = $('#pageSize');
  if (!st) { st = document.createElement('style'); st.id = 'pageSize'; document.head.append(st); }
  st.textContent = mode === 'a4' ? pageCss : '';
}

/* ----- Settings ----- */

async function renderSettings() {
  const st = state.settings;
  const last = st.lastBackupAt;
  $('#settingsBody').innerHTML = `
    <div class="report-cols">
    <div>
    <div class="section-title" style="margin-top:0">Store (printed on receipts)</div>
    <div class="card">
      <label class="field"><span>Store name</span><input class="input" data-setting="storeName" value="${esc(st.storeName)}"></label>
      <label class="field"><span>Address</span><textarea class="plain" data-setting="storeAddress" rows="2">${esc(st.storeAddress)}</textarea></label>
      <label class="field"><span>Phone</span><input class="input" type="tel" data-setting="storePhone" value="${esc(st.storePhone)}"></label>
      <label class="field" style="margin-bottom:0"><span>Receipt footer</span><textarea class="plain" data-setting="receiptFooter" rows="3">${esc(st.receiptFooter)}</textarea></label>
    </div>
    <div class="section-title">VAT</div>
    <div class="card">
      <label class="check"><input type="checkbox" data-setting="vatRegistered" ${st.vatRegistered ? 'checked' : ''}>
        <span><strong>VAT registered</strong><br><span class="small muted">Turn off if your turnover is under R1 million and you're not registered. Receipts then show no VAT.</span></span></label>
      <div class="grid-2" style="margin-top:12px">
        <label class="field"><span>VAT number</span><input class="input" data-setting="vatNumber" inputmode="numeric" value="${esc(st.vatNumber)}" ${st.vatRegistered ? '' : 'disabled'}></label>
        <label class="field"><span>VAT rate (%)</span><input class="input" data-setting="vatRate" inputmode="decimal" value="${esc(st.vatRate)}" ${st.vatRegistered ? '' : 'disabled'}></label>
      </div>
      <p class="small muted" style="margin:0">VAT vendors' receipts print as a TAX INVOICE with your VAT number. Sales over ${money(FULL_TAX_INVOICE_OVER)} ask for the buyer's name and address. Refunds print a CREDIT NOTE.</p>
    </div>
    <div class="section-title">Shop floor</div>
    <div class="card">
      <div class="grid-2">
        <label class="field"><span>Low-stock threshold</span><input class="input" data-setting="lowStock" inputmode="numeric" value="${esc(st.lowStock)}"></label>
        <label class="field"><span>Appearance</span>
          <select data-setting="theme">
            ${[['auto', 'Neon (default)'], ['light', 'Light (bright sunlight)']].map(([t, l]) => `<option value="${t}" ${(st.theme === 'dark' ? 'auto' : st.theme) === t ? 'selected' : ''}>${l}</option>`).join('')}
          </select></label>
      </div>
    </div>
    </div>
    <div>
    <div class="section-title" style="margin-top:0">Subscription</div>
    <div class="card licence-card ${sellingAllowed() ? '' : 'stopped'}">
      ${(() => { const l = licence(); return `<p style="margin:0"><strong>${esc(l.text)}</strong></p>
        <p class="small muted" style="margin:6px 0 0">${cloudOn()
          ? `Shop: ${esc(Cloud.conf.shopName || '')}${Cloud.conf.licenceCheckedAt ? ` · last checked ${fmtDT(Cloud.conf.licenceCheckedAt)}` : ''}. Renewals are done by ${esc(SUPPLIER.name)}; the date updates on the next sync.`
          : `Without a shop account this device has a ${TRIAL_DAYS}-day free trial. Create your shop account under Cloud sync to subscribe (new shops get 30 days free).`}</p>`; })()}
    </div>
    <div class="section-title">Account</div>
    <div class="card">
      <p style="margin-top:0">Signed in as <strong>${esc(ui.user?.name || '—')}</strong>${ui.user?.role === 'owner' ? ' (owner)' : ''}. Your username is not case-sensitive.</p>
      <div class="row gap-s wrap">
        <button class="btn" data-action="change-pin">Change PIN</button>
        <button class="btn" data-action="lock">Lock till</button>
      </div>
    </div>
    ${cloudCardHtml()}
    <div class="section-title">Backup file</div>
    <div class="card">
      <p style="margin-top:0">${cloudOn()
        ? 'Your shop is saved in the cloud. A backup file is still a good extra copy now and then.'
        : 'Without cloud sync your data is stored <strong>only on this device</strong> — clearing the browser\'s website data or losing the device deletes it. Back up at least once a week and keep the file somewhere else (email or WhatsApp it to yourself, or save it to Files / Google Drive).'}</p>
      <p class="small ${backupOverdue() ? 'warn-text' : 'muted'}"><strong>Last backup:</strong> ${last ? `${fmtDate(last)} (${daysAgo(last)} days ago)` : 'never'}</p>
      <div class="row gap-s wrap">
        <button class="btn primary" data-action="backup-download">Download backup</button>
        <button class="btn" data-action="backup-copy">Copy backup</button>
        ${navigator.canShare ? '<button class="btn" data-action="backup-share">Share backup</button>' : ''}
      </div>
      <div class="section-title">Restore</div>
      <div class="row gap-s wrap" style="margin-bottom:8px">
        <label class="btn" tabindex="0" role="button" data-file-trigger>Restore from file<input type="file" id="restoreFile" accept="application/json,.json" hidden></label>
      </div>
      <label class="sr-only" for="restoreText">Paste backup JSON</label>
      <textarea id="restoreText" placeholder="…or paste backup JSON here"></textarea>
      <button class="btn" style="margin-top:8px" data-action="restore-paste">Restore pasted backup</button>
      <div class="section-title">Export</div>
      <button class="btn" data-action="export-csv">Export sales as CSV</button>
      <div class="section-title">Reset</div>
      <div class="row gap-s wrap">
        <button class="btn danger" data-action="start-fresh">Start fresh (delete everything)</button>
        <button class="btn" data-action="load-demo">Load demo data</button>
      </div>
      <p class="small muted" id="storageInfo">Checking storage…</p>
    </div>
    </div>
    </div>`;

  let persisted = 'unknown';
  if (navigator.storage?.persisted) persisted = (await navigator.storage.persisted()) ? 'yes' : 'not yet (install the app to the home screen)';
  let usage = '';
  if (navigator.storage?.estimate) {
    const e = await navigator.storage.estimate();
    usage = ` · using ${(e.usage / 1024).toFixed(0)} KB`;
  }
  const el = $('#storageInfo');
  if (el) el.textContent = `Persistent storage: ${persisted}${usage} · ${state.products.length} products, ${state.sales.length} sales`;
}

async function onSettingChange(input) {
  const key = input.dataset.setting;
  let value = input.type === 'checkbox' ? input.checked : input.value;
  if (key === 'vatRate') {
    value = Number(String(value).replace(',', '.'));
    if (!Number.isFinite(value) || value < 0 || value > 100) return toast('VAT rate must be 0–100', true);
  }
  if (key === 'lowStock') {
    value = parseInt(value, 10);
    if (!Number.isFinite(value) || value < 0) return toast('Threshold must be 0 or more', true);
  }
  if (key === 'vatNumber') {
    value = String(value).replace(/\s/g, '');
    if (value && !/^4\d{9}$/.test(value)) toast('Note: SA VAT numbers are 10 digits starting with 4', true);
  }
  if (key === 'storeName') value = value.trim() || 'My Clothing Store';
  state.settings[key] = value;
  await persist([opKv('settings', state.settings)]);
  $('#storeNameLabel').textContent = state.settings.storeName;
  if (key === 'theme' || key === 'vatRegistered') renderAll();
  else { renderBanners(); renderSell(); renderTotals(); }
  if (!(key === 'vatNumber' && value && !/^4\d{9}$/.test(value))) toast('Saved');
}

/* ===== 14. Backup / restore / CSV ======================================= */

async function backupJson() {
  await flushAllAdjust();
  return JSON.stringify({
    app: 'rails-pos', version: 2, exportedAt: new Date().toISOString(),
    settings: state.settings, meta: state.meta, products: state.products, sales: state.sales,
    cashups: state.cashups, movements: await DB.getAll('movements'),
  });
}

function downloadFile(name, text, type) {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

const stamp = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };

async function markBackedUp() {
  state.settings.lastBackupAt = new Date().toISOString();
  await persist([opKv('settings', state.settings)]);
  renderBanners();
  if (ui.view === 'settings') renderSettings();
}

async function backupDownload() {
  downloadFile(`rails-pos-backup-${stamp()}.json`, await backupJson(), 'application/json');
  await markBackedUp();
  toast('Backup downloaded — keep it somewhere safe');
}
async function backupCopy() {
  await copyText(await backupJson(), 'Backup copied — paste it into an email or note to yourself');
  await markBackedUp();
}
async function backupShare() {
  const file = new File([await backupJson()], `rails-pos-backup-${stamp()}.json`, { type: 'application/json' });
  if (navigator.canShare?.({ files: [file] })) {
    try { await navigator.share({ files: [file], title: 'Rails POS backup' }); await markBackedUp(); }
    catch { /* user cancelled */ }
  } else toast('Sharing files is not supported here — use Download', true);
}

async function restoreFromText(text) {
  let data;
  try { data = JSON.parse(text); } catch { return toast('That is not valid backup JSON', true); }
  if (!data || data.app !== 'rails-pos' || !Array.isArray(data.products) || !Array.isArray(data.sales)) {
    return toast('This does not look like a Rails POS backup', true);
  }
  const ok = await confirmBox(`Replace ALL data ${cloudOn() ? 'on ALL your synced devices' : 'on this device'} with the backup from ${data.exportedAt ? fmtDate(data.exportedAt) : 'unknown date'} (${data.products.length} products, ${data.sales.length} sales)?`, 'Restore', true);
  if (!ok) return;
  if (!(await cloudResetBefore())) return;
  state.settings = { ...DEFAULT_SETTINGS, ...data.settings };
  state.products = data.products;
  state.sales = data.sales.map(normalizeSale);
  state.cashups = data.cashups || [];
  state.meta = { ...DEFAULT_META, ...data.meta };
  // Never reuse a number that already exists.
  state.meta.nextReceiptNo = Math.max(state.meta.nextReceiptNo, ...state.sales.map(s => s.number + 1));
  state.meta.nextCreditNo = Math.max(state.meta.nextCreditNo, ...state.sales.flatMap(s => s.returns.map(r => r.number + 1)));
  state.meta.nextZNo = Math.max(state.meta.nextZNo, ...state.cashups.map(z => z.number + 1));
  state.sales.sort(byDate);
  ui.cart = emptyCart();
  await persistEverything(data.movements || []);
  restoreCart(ui.cart);
  renderAll();
  toast('Backup restored');
  await cloudResetAfter();
}

function exportCsv() {
  // Prefix text that could be read as a spreadsheet formula (CSV injection).
  const cell = v => {
    let s = String(v ?? '');
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const num = centsToPlain;
  const head = ['type', 'doc_no', 'invoice_no', 'date', 'time', 'payment', 'sku', 'product', 'size', 'colour', 'qty',
    'unit_price', 'line_total', 'unit_cost', 'doc_total', 'doc_vat', 'vat_rate', 'customer'];
  const rows = [head.join(',')];
  for (const s of state.sales) {
    for (const it of s.items) {
      rows.push(['sale', saleNo(s), saleNo(s), fmtDate(s.date), fmtTime(s.date), s.payment,
        cell(it.sku), cell(it.name), cell(it.size), cell(it.colour), it.qty,
        num(it.unitPrice), num(it.unitPrice * it.qty), num(it.unitCost), num(s.total), num(s.vat), s.vatRate, cell(s.customer?.name)].join(','));
    }
    for (const r of s.returns) for (const ri of r.items) {
      const it = s.items[ri.idx];
      rows.push(['refund', retNo(r), saleNo(s), fmtDate(r.date), fmtTime(r.date), r.method,
        cell(it.sku), cell(it.name), cell(it.size), cell(it.colour), -ri.qty,
        num(it.unitPrice), num(-ri.amount), num(it.unitCost), num(-r.amount), num(-r.vat), s.vatRate, cell(s.customer?.name)].join(','));
    }
  }
  downloadFile(`rails-pos-sales-${stamp()}.csv`, '﻿' + rows.join('\r\n'), 'text/csv');
  toast(`Exported ${state.sales.length} sales`);
}

async function startFresh() {
  const ok = await confirmBox(state.meta.demo
    ? 'Remove all demo products and sales and start with an empty shop?'
    : `Delete ALL products, sales and cash-ups ${cloudOn() ? 'on ALL your synced devices and in the cloud' : 'on this device'}? Make a backup first — this cannot be undone.`, 'Start fresh', true);
  if (!ok) return;
  if (!(await cloudResetBefore())) return;
  const keep = state.meta.demo ? { ...DEFAULT_SETTINGS } : { ...state.settings };
  state.settings = keep;
  state.products = [];
  state.sales = [];
  state.cashups = [];
  state.meta = { ...DEFAULT_META };
  ui.cart = emptyCart();
  await persistEverything();
  restoreCart(ui.cart);
  renderAll();
  toast('Fresh start — add your first product on the Stock screen');
  await cloudResetAfter();
}

async function loadDemo() {
  if (cloudOn()) return toast('Demo data is off while cloud sync is on — it would replace your real shop on every device', true);
  if (!(await confirmBox('Replace everything on this device with demo data?', 'Load demo', true))) return;
  loadDemoData();
  await persistEverything();
  restoreCart(ui.cart);
  renderAll();
  toast('Demo data loaded');
}

/* ===== 14b. Sign-in ======================================================
   The till is covered by a sign-in screen until a username and a 4-digit
   PIN are entered. Usernames are not case-sensitive ("Amish" = "amish").

   Accounts are kept in IndexedDB (kv 'auth'), apart from the shop data, so
   Start fresh, Restore and Load demo never touch them, and backups never
   contain them. PINs are stored only as PBKDF2 hashes.

   Staying signed in lasts for this browser tab (sessionStorage): a reload or
   an update keeps you in; closing the app or tapping Lock asks again.

   Honest limit: this keeps staff and customers out of the till. It is NOT
   licence protection — the code runs on the customer's device.
   PLUG-IN: licence check / cloud accounts — verify the account with a
   server in checkLogin() when online, and cache the result for offline use.
   ======================================================================== */

const PIN_ITERATIONS = 100000;
const SESSION_KEY = DB_NAME + '-signed-in';
const MAX_TRIES = 5;          // wrong PINs in a row before a pause
const LOCKOUT_MS = 30 * 1000; // length of that pause
/* What a user may do. Selling is always allowed. [key, label, description] */
const PERMISSIONS = [
  ['discount', 'Give discounts', 'Type a discount in the cart'],
  ['returns', 'Refunds and exchanges', 'Return items on a sale'],
  ['sales', 'Sales history', 'See past sales and reprint receipts'],
  ['stock', 'Stock', 'Add and edit products, change stock, receive deliveries'],
  ['reports', 'Reports and cash-up', 'See takings and profit, do the cash-up'],
  ['settings', 'Settings and backups', 'Store details, VAT, backup, restore, start fresh'],
  ['admin', 'Admin', 'Add, change and delete users and what they may do'],
];
const ALL_PERMS = PERMISSIONS.map(p => p[0]);
/* Roles are presets that tick the boxes; any change to the boxes makes it "Custom". */
const ROLES = {
  owner: { label: 'Owner', perms: ALL_PERMS },
  manager: { label: 'Manager', perms: ALL_PERMS.filter(p => p !== 'admin') },
  cashier: { label: 'Cashier', perms: ['sales'] },
  custom: { label: 'Custom', perms: null },
};
/* Which permission each screen needs (Sell needs none). */
const VIEW_PERMS = { stock: 'stock', sales: 'sales', reports: 'reports', settings: 'settings', admin: 'admin' };

// There is no built-in account: a new device runs the first-time setup
// (section 14d), where the shop owner chooses their own name and PIN.
const DUMMY_SALT = 'DTcSYbvG4OYR8B5sHx9K0Q=='; // only used to hash a wrong username (equal timing)
const signinState = { failures: 0, lockedUntil: 0 };

/** Does the signed-in user have this permission? */
const can = perm => !!ui.user?.perms?.includes(perm);
const roleOf = perms => Object.keys(ROLES).find(r => ROLES[r].perms && ROLES[r].perms.length === perms.length && ROLES[r].perms.every(p => perms.includes(p))) || 'custom';

const normUser = s => String(s ?? '').trim().toLowerCase();
const toB64 = buf => btoa(String.fromCharCode(...new Uint8Array(buf)));
const fromB64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));

async function hashPin(pin, saltB64) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(pin), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: fromB64(saltB64), iterations: PIN_ITERATIONS }, key, 256);
  return toB64(bits);
}

/** The accounts record ({users: []} on a device that hasn't been set up yet). */
async function loadAuth() {
  const auth = (await DB.get('kv', 'auth')) || { users: [] };
  auth.users ||= [];
  let changed = false;
  // Accounts from the first sign-in version had no id or permissions.
  for (const u of auth.users) {
    if (!u.id) { u.id = 'u-' + normUser(u.name || u.username); changed = true; }
    if (!Array.isArray(u.perms)) { u.perms = [...(ROLES[u.role] || ROLES.cashier).perms]; changed = true; }
    if ('username' in u) { delete u.username; changed = true; }
  }
  if (changed) await DB.write([opKv('auth', auth)]);
  return auth;
}
async function saveAuth(auth) { await DB.write([opKv('auth', auth)]); }
const adminCount = users => users.filter(u => u.perms.includes('admin')).length;

/** Returns the matching user, or null. The username is the user's name, in any capitals. */
async function checkLogin(username, pin) {
  const auth = await loadAuth();
  const user = auth.users.find(u => normUser(u.name) === normUser(username));
  // Hash even for an unknown name, so both kinds of mistake take equally long.
  const hash = await hashPin(pin, user?.salt || DUMMY_SALT);
  return user && hash === user.hash ? user : null;
}

function readSession() { try { return sessionStorage.getItem(SESSION_KEY); } catch { return null; } }
function writeSession(userId) {
  try { if (userId) sessionStorage.setItem(SESSION_KEY, userId); else sessionStorage.removeItem(SESSION_KEY); } catch { /* private mode */ }
}
function setUser(u) {
  ui.user = u ? { id: u.id, name: u.name, role: u.role, perms: [...u.perms] } : null;
  $('#userLabel').textContent = u ? u.name : '';
  $('#lockBtn').hidden = !u;
  $('#lockBtn').setAttribute('aria-label', u ? `Lock the till (signed in as ${u.name})` : 'Lock');
  applyPermissions();
}

/** Show only the screens and controls the signed-in user may use. */
function applyPermissions() {
  $$('.app-nav [data-perm]').forEach(b => { b.hidden = !can(b.dataset.perm); });
  $('#discountRow').hidden = !can('discount');
  if (VIEW_PERMS[ui.view] && !can(VIEW_PERMS[ui.view])) showView('sell');
}

/** Still signed in from earlier in this tab (e.g. after a reload)? */
async function resumeSession() {
  const id = readSession();
  if (!id) return false;
  const user = (await loadAuth()).users.find(u => u.id === id);
  if (user) setUser(user);
  return !!user;
}

function showSignIn(message = '') {
  setUser(null);
  $('#siError').textContent = message;
  $('#siPin').value = '';
  $('#signin').hidden = false;
  updateInert();
  ($('#siUser').value ? $('#siPin') : $('#siUser')).focus();
}

async function submitSignIn() {
  const err = $('#siError');
  const wait = Math.ceil((signinState.lockedUntil - Date.now()) / 1000);
  if (wait > 0) { err.textContent = `Too many wrong tries. Try again in ${wait} seconds.`; return; }
  const username = $('#siUser').value;
  const pin = $('#siPin').value.trim();
  if (!normUser(username)) { err.textContent = 'Enter your username'; $('#siUser').focus(); return; }
  if (!/^\d{4}$/.test(pin)) { err.textContent = 'Your PIN is 4 digits'; $('#siPin').focus(); return; }

  $('#siGo').disabled = true;
  let user = null;
  try { user = await checkLogin(username, pin); }
  catch (e) { console.error(e); err.textContent = 'Could not check the PIN: ' + e.message; return; }
  finally { $('#siGo').disabled = false; }

  if (!user) {
    signinState.failures += 1;
    if (signinState.failures >= MAX_TRIES) {
      signinState.failures = 0;
      signinState.lockedUntil = Date.now() + LOCKOUT_MS;
      err.textContent = `Too many wrong tries. Try again in ${LOCKOUT_MS / 1000} seconds.`;
    } else {
      err.textContent = 'Wrong username or PIN';
    }
    $('#siPin').value = '';
    $('#siPin').focus();
    return;
  }
  signinState.failures = 0;
  writeSession(user.id);
  setUser(user);
  $('#siPin').value = '';
  err.textContent = '';
  $('#signin').hidden = true;
  updateInert();
  if (ui.appActive) renderAll();
  if (isWide()) $('#sellSearch').focus();
}

/** Lock button: save anything pending, then cover the till again. */
async function lockTill() {
  if (ui.appActive) { await flushAllAdjust(); await saveCart(true); }
  if (ui.scan) closeScanner();
  closeModal();
  closeCartSheet();
  writeSession(null);
  showSignIn();
}

function openChangePin() {
  openModal({
    title: 'Change PIN',
    body: `
      <label class="field"><span>Current PIN</span><input id="pinOld" class="input pin-input" type="password" inputmode="numeric" maxlength="4" autocomplete="current-password"></label>
      <label class="field"><span>New PIN (4 digits)</span><input id="pinNew" class="input pin-input" type="password" inputmode="numeric" maxlength="4" autocomplete="new-password"></label>
      <label class="field"><span>New PIN again</span><input id="pinNew2" class="input pin-input" type="password" inputmode="numeric" maxlength="4" autocomplete="new-password"></label>`,
    foot: `<button class="btn" data-action="close-modal">Cancel</button><button class="btn primary" data-action="pin-save">Change PIN</button>`,
  });
}

async function saveNewPin() {
  const oldPin = $('#pinOld').value.trim(), newPin = $('#pinNew').value.trim(), again = $('#pinNew2').value.trim();
  if (!ui.user) return;
  if (!/^\d{4}$/.test(newPin)) return toast('The new PIN must be exactly 4 digits', true);
  if (newPin !== again) return toast('The two new PINs are not the same', true);
  if (!(await checkLogin(ui.user.name, oldPin))) return toast('The current PIN is wrong', true);
  const auth = await loadAuth();
  const user = auth.users.find(u => u.id === ui.user.id);
  await setPin(user, newPin);
  await saveAuth(auth);
  closeModal();
  toast('PIN changed');
}

async function setPin(user, pin) {
  user.salt = toB64(crypto.getRandomValues(new Uint8Array(16)));
  user.hash = await hashPin(pin, user.salt);
}

/* ----- Admin: users and what they may do ----- */

async function renderAdmin() {
  const auth = await loadAuth();
  const label = p => PERMISSIONS.find(x => x[0] === p)?.[1];
  $('#userList').innerHTML = auth.users.map(u => {
    const me = u.id === ui.user?.id;
    return `<div class="card user-card">
      <div class="user-head">
        <div><h3>${esc(u.name)}${me ? ' <span class="small muted">(you)</span>' : ''}</h3>
          <span class="role-tag">${esc(ROLES[u.role]?.label || 'Custom')}</span></div>
        <div class="row gap-s wrap">
          <button class="btn sm" data-action="user-edit" data-id="${esc(u.id)}">Edit</button>
          ${me ? '' : `<button class="btn sm danger" data-action="user-delete" data-id="${esc(u.id)}">Delete</button>`}
        </div>
      </div>
      <p class="small muted" style="margin:8px 0 0">Can: ${['Sell', ...ALL_PERMS.filter(p => u.perms.includes(p)).map(label)].map(esc).join(' · ')}</p>
    </div>`;
  }).join('');
}

function openUserForm(id = null) {
  loadAuth().then(auth => {
    const u = id ? auth.users.find(x => x.id === id) : null;
    if (id && !u) return toast('That user no longer exists', true);
    const perms = u ? u.perms : ROLES.cashier.perms;
    const role = u ? roleOf(u.perms) : 'cashier';
    openModal({
      title: u ? `Edit ${u.name}` : 'Add user',
      body: `
        <label class="field"><span>Username</span><input id="uName" class="input" maxlength="30" autocomplete="off" autocapitalize="words" value="${esc(u?.name || '')}"></label>
        <p class="small muted" style="margin:-4px 0 12px">They type this to sign in. Capitals don't matter.</p>
        <label class="field"><span>Role</span><select id="uRole">
          ${Object.entries(ROLES).map(([k, r]) => `<option value="${k}" ${k === role ? 'selected' : ''}>${r.label}</option>`).join('')}
        </select></label>
        <div class="section-title" style="margin-top:4px">May use</div>
        <label class="check"><input type="checkbox" checked disabled><span><strong>Sell</strong><br><span class="small muted">Always allowed</span></span></label>
        ${PERMISSIONS.map(([k, l, d]) => `<label class="check"><input type="checkbox" data-perm="${k}" ${perms.includes(k) ? 'checked' : ''}>
          <span><strong>${esc(l)}</strong><br><span class="small muted">${esc(d)}</span></span></label>`).join('')}
        <div class="grid-2" style="margin-top:12px">
          <label class="field"><span>${u ? 'New PIN (blank = keep)' : 'PIN (4 digits)'}</span><input id="uPin" class="input pin-input" type="password" inputmode="numeric" maxlength="4" autocomplete="new-password"></label>
          <label class="field"><span>PIN again</span><input id="uPin2" class="input pin-input" type="password" inputmode="numeric" maxlength="4" autocomplete="new-password"></label>
        </div>`,
      foot: `<button class="btn" data-action="close-modal">Cancel</button><button class="btn primary" data-action="user-save" data-id="${esc(id || '')}">${u ? 'Save' : 'Add user'}</button>`,
    });
  });
}

async function saveUser(id) {
  const auth = await loadAuth();
  const name = $('#uName').value.trim().replace(/\s+/g, ' ');
  const pin = $('#uPin').value.trim(), pin2 = $('#uPin2').value.trim();
  const perms = $$('#modal [data-perm]').filter(c => c.checked).map(c => c.dataset.perm);
  if (!name) return toast('Enter a username', true);
  if (auth.users.some(u => u.id !== id && normUser(u.name) === normUser(name))) return toast(`There is already a user called ${name}`, true);
  if (!id || pin || pin2) {
    if (!/^\d{4}$/.test(pin)) return toast('The PIN must be exactly 4 digits', true);
    if (pin !== pin2) return toast('The two PINs are not the same', true);
  }

  const user = id ? auth.users.find(u => u.id === id) : { id: uid('u-') };
  if (!user) return toast('That user no longer exists', true);
  const before = { ...user };
  Object.assign(user, { name, perms, role: roleOf(perms) });
  const users = id ? auth.users : [...auth.users, user];
  if (!adminCount(users)) {
    Object.assign(user, before);
    return toast('At least one user must keep Admin access', true);
  }
  if (pin) await setPin(user, pin);
  if (!id) auth.users.push(user);
  await saveAuth(auth);
  closeModal();
  toast(id ? `${name} saved` : `${name} added`);
  if (user.id === ui.user?.id) setUser(user); // own name or access changed
  if (ui.view === 'admin') renderAdmin();
}

async function deleteUser(id) {
  const auth = await loadAuth();
  const user = auth.users.find(u => u.id === id);
  if (!user) return;
  if (id === ui.user?.id) return toast("You can't delete yourself while signed in", true);
  const rest = auth.users.filter(u => u.id !== id);
  if (!adminCount(rest)) return toast('At least one user must keep Admin access', true);
  if (!(await confirmBox(`Delete ${user.name}? They will no longer be able to sign in. Their past sales keep their name.`, 'Delete user', true))) return;
  auth.users = rest;
  await saveAuth(auth);
  toast(`${user.name} deleted`);
  renderAdmin();
}

/** Role picked → tick its boxes. Box changed → show the matching role (or Custom). */
function onUserFormChange(t) {
  if (t.id === 'uRole' && ROLES[t.value].perms) {
    $$('#modal [data-perm]').forEach(c => { c.checked = ROLES[t.value].perms.includes(c.dataset.perm); });
  }
  if (t.dataset.perm) {
    $('#uRole').value = roleOf($$('#modal [data-perm]').filter(c => c.checked).map(c => c.dataset.perm));
  }
}

/* ===== 14c. Cloud sync (Supabase) ========================================
   Every device keeps its full copy in IndexedDB (works offline) and swaps
   changes with the shop's cloud copy:

   push  send the records listed in the outbox (they are upserted by id)
   pull  ask for every cloud change after the last one seen (records.seq)
         and merge it in. A change still waiting in our outbox wins.

   Stock: two tills can sell the same shirt at the same moment, so stock is
   never copied between devices. Each device works it out as the sum of all
   stock movements (sales -1, returns +1, deliveries, counts…), and the
   movements themselves are what sync. Opening stock gets a movement when a
   shop is first uploaded, so the sum always matches.

   Receipt numbers: each device gets a letter (A, B…) printed before its own
   numbers, so tax invoice numbers are unique across tills.

   Start fresh / Restore on a synced device empties the cloud copy and bumps
   the shop's "generation"; other devices see that and download it again.
   ======================================================================== */

const Cloud = {
  conf: null,      // kv 'cloud' — this device only: login tokens, shop, till letter, lastSeq
  busy: false,
  again: false,
  status: 'off',   // off | ok | syncing | offline | error | signedout
  message: '',
  pending: 0,      // changes waiting in the outbox
  timer: null,
  soon: null,
};
const SYNC_EVERY_MS = 20000;
const PULL_OVERLAP = 100; // re-read the last few changes in case two saves crossed
const cloudReady = () => !!(CLOUD.url && CLOUD.key);
const cloudOn = () => cloudReady() && !!Cloud.conf?.shopId;
const deviceLetter = n => { let s = ''; for (let x = Math.max(1, n); x > 0; x = Math.floor((x - 1) / 26)) s = String.fromCharCode(65 + ((x - 1) % 26)) + s; return s; };
function deviceStamp() { return Cloud.conf?.deviceCode ? { series: Cloud.conf.deviceCode, device: Cloud.conf.deviceId } : {}; }
const saveCloudConf = () => DB.write([opKv('cloud', Cloud.conf)]);
const countOutbox = async () => (await DB.getAll('outbox')).length;

/** JSON with sorted keys, to compare records whatever order the database returns them in. */
function stableStr(v) {
  return JSON.stringify(v, (k, val) => (val && typeof val === 'object' && !Array.isArray(val)
    ? Object.keys(val).sort().reduce((o, key) => { o[key] = val[key]; return o; }, {}) : val));
}

/* ----- Talking to Supabase (plain REST, no library) ----- */

const cloudFetch = (url, opts) => (TEST_MODE && window.__cloudFetch ? window.__cloudFetch : fetch)(url, opts);

async function cloudApi(path, { method = 'GET', body, headers = {}, auth = true } = {}) {
  // apikey = the project's public key (old "anon" JWT or new "sb_publishable_…"); the
  // Authorization header is only sent once signed in.
  const h = { apikey: CLOUD.key, 'Content-Type': 'application/json', ...headers };
  if (auth) h.Authorization = 'Bearer ' + await accessToken();
  let res;
  try {
    res = await cloudFetch(CLOUD.url.replace(/\/$/, '') + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
  } catch {
    const e = new Error('No connection to the cloud'); e.offline = true; throw e;
  }
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!res.ok) { const e = new Error(cloudErrorText(data, res.status)); e.status = res.status; throw e; }
  return data;
}

function cloudErrorText(d, status) {
  const m = String((d && (d.msg || d.message || d.error_description || d.error)) || `Cloud error ${status}`);
  if (/invalid login/i.test(m)) return 'Wrong email or password';
  if (/not confirmed/i.test(m)) return 'Confirm your email first (check your inbox), then sign in';
  if (/already registered|already exists/i.test(m)) return 'That email already has an account — tap Sign in';
  if (/relation .* does not exist|could not find the table/i.test(m)) return 'The cloud database is not set up yet (run supabase-setup.sql)';
  return m;
}

function setSession(d) {
  Object.assign(Cloud.conf, {
    access: d.access_token, refresh: d.refresh_token,
    expiresAt: Date.now() + (d.expires_in || 3600) * 1000,
    email: d.user?.email || Cloud.conf.email, userId: d.user?.id || Cloud.conf.userId,
  });
}

/** A valid access token, refreshing it when it is about to expire (they last an hour). */
async function accessToken() {
  const c = Cloud.conf;
  if (c?.access && Date.now() < c.expiresAt - 60000) return c.access;
  const signedOut = () => { const e = new Error('Signed out of the cloud — sign in again in Settings'); e.signedOut = true; return e; };
  if (!c?.refresh) throw signedOut();
  let d;
  try {
    d = await cloudApi('/auth/v1/token?grant_type=refresh_token', { method: 'POST', body: { refresh_token: c.refresh }, auth: false });
  } catch (e) {
    if (e.status === 400 || e.status === 401) throw signedOut();
    throw e;
  }
  setSession(d);
  await saveCloudConf();
  return c.access;
}

/** Sign in (or create the shop login). Returns 'ok', or 'confirm' when Supabase wants the email confirmed first. */
async function cloudSignIn(email, password, create) {
  Cloud.conf = { ...(Cloud.conf || {}), email };
  Cloud.conf.deviceId ||= uid('d');
  const d = create
    ? await cloudApi('/auth/v1/signup', { method: 'POST', body: { email, password }, auth: false })
    : await cloudApi('/auth/v1/token?grant_type=password', { method: 'POST', body: { email, password }, auth: false });
  if (!d?.access_token) { await saveCloudConf(); return 'confirm'; }
  setSession(d);
  await saveCloudConf();
  return 'ok';
}

/* ----- Push / pull / merge ----- */

/** Send everything in the outbox (300 at a time). */
async function pushOutbox() {
  for (;;) {
    const box = (await DB.getAll('outbox')).slice(0, 300);
    if (!box.length) break;
    const rows = [];
    for (const o of box) {
      const i = o.key.indexOf(':');
      const kind = o.key.slice(0, i), id = o.key.slice(i + 1);
      const data = await DB.get(kind, id);
      rows.push({ shop_id: Cloud.conf.shopId, kind, id, data: data ?? null, deleted: data === undefined, device: Cloud.conf.deviceId });
    }
    await cloudApi('/rest/v1/records?on_conflict=shop_id,kind,id', {
      method: 'POST', body: rows, headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
    });
    // Remove what was sent — unless it was changed again while we were sending.
    const db = await DB.open();
    await new Promise((resolve, reject) => {
      const tx = db.transaction('outbox', 'readwrite');
      const s = tx.objectStore('outbox');
      box.forEach(o => { s.get(o.key).onsuccess = e => { if (e.target.result?.v === o.v) s.delete(o.key); }; });
      tx.oncomplete = resolve; tx.onerror = () => reject(tx.error);
    });
  }
  Cloud.pending = 0;
}

/** All cloud changes after seq, oldest first. */
async function fetchChanges(after) {
  const rows = [];
  let seq = after;
  for (;;) {
    const page = await cloudApi(`/rest/v1/records?select=kind,id,data,deleted,seq&shop_id=eq.${encodeURIComponent(Cloud.conf.shopId)}&seq=gt.${seq}&order=seq.asc&limit=1000`);
    rows.push(...page);
    if (page.length < 1000) break;
    seq = page[page.length - 1].seq;
  }
  return rows;
}

/** Stock of these products = sum of their movements (see the note at the top of this section). */
async function recomputeStock(productIds) {
  const ops = [];
  for (const pid of productIds) {
    const p = findProduct(pid);
    if (!p) continue;
    const sums = new Map();
    (await DB.getAllByIndex('movements', 'productId', pid)).forEach(m => sums.set(m.variantId, (sums.get(m.variantId) || 0) + m.change));
    let changed = false;
    p.variants.forEach(v => { const s = sums.get(v.id) || 0; if (v.stock !== s) { v.stock = s; changed = true; } });
    if (changed) ops.push(opPut('products', p));
  }
  if (ops.length) await DB.write(ops, [], { remote: true });
  return ops.length > 0;
}

/** Merge cloud rows into this device. Returns true if anything changed. */
async function applyRemote(rows) {
  const pending = new Set((await DB.getAll('outbox')).map(o => o.key));
  const latest = new Map();
  rows.forEach(r => latest.set(`${r.kind}:${r.id}`, r));
  const order = { kv: 0, products: 1, cashups: 2, sales: 3, movements: 4 };
  const list = [...latest.values()].sort((a, b) => order[a.kind] - order[b.kind]);
  const ops = [];
  const restock = new Set();
  let changed = false, authChanged = false;

  for (const r of list) {
    const key = `${r.kind}:${r.id}`;
    if (r.kind === 'movements') {
      // Movements never change: add the ones we don't have yet.
      if (r.deleted || !r.data || await DB.get('movements', r.id)) continue;
      ops.push(opPut('movements', r.data));
      restock.add(r.data.productId);
      changed = true;
      continue;
    }
    if (pending.has(key)) continue; // our own newer change is waiting to be sent

    if (r.kind === 'kv') {
      if (!SYNC_KV.includes(r.id) || r.deleted || !r.data) continue;
      const local = r.id === 'settings' ? state.settings : await DB.get('kv', r.id);
      if (stableStr(local) === stableStr(r.data)) continue;
      ops.push(opKv(r.id, r.data));
      if (r.id === 'settings') state.settings = { ...DEFAULT_SETTINGS, ...r.data };
      else authChanged = true;
      changed = true;
      continue;
    }

    const arr = r.kind === 'products' ? state.products : r.kind === 'sales' ? state.sales : state.cashups;
    if (!arr || !SYNC_STORES.includes(r.kind)) continue;
    const i = arr.findIndex(x => x.id === r.id);
    if (r.deleted || !r.data) {
      if (i >= 0) { arr.splice(i, 1); ops.push({ store: r.kind, key: r.id, del: true }); changed = true; }
      continue;
    }
    let incoming = clone(r.data);
    if (r.kind === 'products') {
      // Keep our own stock figures; they're recalculated from movements below.
      const old = i >= 0 ? arr[i] : null;
      incoming.variants.forEach(v => { v.stock = old?.variants.find(x => x.id === v.id)?.stock ?? 0; });
      restock.add(incoming.id);
    }
    if (i >= 0 && stableStr(arr[i]) === stableStr(incoming)) continue;
    if (r.kind === 'sales') incoming = normalizeSale(incoming);
    if (i >= 0) arr[i] = incoming; else arr.push(incoming);
    ops.push(opPut(r.kind, incoming));
    changed = true;
  }

  if (ops.length) await DB.write(ops, [], { remote: true });
  if (restock.size && await recomputeStock([...restock])) changed = true;
  if (changed) {
    state.sales.sort(byDate);
    state.cashups.sort((a, b) => (a.to || '').localeCompare(b.to || ''));
  }
  if (authChanged) await refreshCurrentUser();
  return changed;
}

/** Replace this device's shop data with the cloud copy (joining, or after another device reset the shop). */
async function fullDownload() {
  const rows = await fetchChanges(0); // fetch everything BEFORE touching local data
  const latest = new Map();
  rows.forEach(r => latest.set(`${r.kind}:${r.id}`, r));
  const ops = [];
  for (const r of latest.values()) {
    if (r.deleted || r.data == null) continue;
    if (r.kind === 'kv') { if (SYNC_KV.includes(r.id)) ops.push(opKv(r.id, r.data)); }
    else if (SYNC_STORES.includes(r.kind)) ops.push(opPut(r.kind, r.data));
  }
  await DB.write(ops, [...SYNC_STORES, 'outbox'], { remote: true });
  Cloud.conf.lastSeq = rows.length ? rows[rows.length - 1].seq : 0;
  DB.tracking = true;
  await saveCloudConf();
  await loadState();
  await recomputeStock(state.products.map(p => p.id));
  await refreshCurrentUser();
  renderAll();
}

/** Make sure every variant's stock equals the sum of its movements (adds "Opening stock" movements). */
async function addOpeningMovements() {
  const sums = new Map();
  (await DB.getAll('movements')).forEach(m => sums.set(m.variantId, (sums.get(m.variantId) || 0) + m.change));
  const ops = [];
  for (const p of state.products) for (const v of p.variants) {
    const diff = v.stock - (sums.get(v.id) || 0);
    if (diff) ops.push(opPut('movements', { ...movement(p, v, diff, 'opening'), ref: 'Stock when cloud sync started' }));
  }
  if (ops.length) await DB.write(ops);
}

/** Queue every record on this device to be sent (first upload, or after a reset). */
async function enqueueAll() {
  const keys = [];
  for (const s of SYNC_STORES) (await DB.getAll(s)).forEach(r => keys.push(`${s}:${r.id}`));
  for (const k of SYNC_KV) if (await DB.get('kv', k)) keys.push(`kv:${k}`);
  const db = await DB.open();
  await new Promise((resolve, reject) => {
    const tx = db.transaction('outbox', 'readwrite');
    keys.forEach(key => tx.objectStore('outbox').put({ key, v: uid() }));
    tx.oncomplete = resolve; tx.onerror = () => reject(tx.error);
  });
  Cloud.pending = keys.length;
}

/** One sync round: check for a reset, send our changes, fetch everyone else's. */
async function syncNow() {
  if (!cloudOn() || !ui.appActive) return;
  if (Cloud.busy) { Cloud.again = true; return; }
  if (!navigator.onLine) { Cloud.pending = await countOutbox(); setCloudStatus('offline'); return; }
  Cloud.busy = true;
  setCloudStatus('syncing');
  try {
    const [shop] = await cloudApi(`/rest/v1/shops?select=id,name,generation,active_until&id=eq.${encodeURIComponent(Cloud.conf.shopId)}`);
    if (!shop) throw new Error('This shop was not found in the cloud. Sign in with the shop\'s email.');
    Cloud.conf.shopName = shop.name;
    // Subscription: remember the paid-until date (works offline until the next check)
    const until = shop.active_until ?? null;
    if (until !== Cloud.conf.activeUntil) { Cloud.conf.activeUntil = until; Cloud.licenceChanged = true; }
    Cloud.conf.licenceCheckedAt = new Date().toISOString();
    await flushAllAdjust();
    if (shop.generation !== Cloud.conf.generation) {
      // Another device started fresh or restored a backup: take its data.
      Cloud.conf.generation = shop.generation;
      await fullDownload();
      toast('Shop data was replaced from another device');
    } else {
      await pushOutbox();
      const rows = await fetchChanges(Math.max(0, (Cloud.conf.lastSeq || 0) - PULL_OVERLAP));
      if (rows.length) {
        if (await applyRemote(rows)) renderAfterSync();
        Cloud.conf.lastSeq = Math.max(Cloud.conf.lastSeq || 0, rows[rows.length - 1].seq);
      }
    }
    Cloud.conf.lastSyncAt = new Date().toISOString();
    await saveCloudConf();
    setCloudStatus('ok');
    if (Cloud.licenceChanged) { Cloud.licenceChanged = false; renderAfterSync(); }
  } catch (e) {
    console.warn('Sync failed:', e);
    setCloudStatus(e.offline ? 'offline' : e.signedOut ? 'signedout' : 'error', e.message);
  } finally {
    Cloud.busy = false;
    Cloud.pending = await countOutbox();
    renderCloudStatus();
    if (Cloud.again) { Cloud.again = false; scheduleSync(300); }
  }
}

function scheduleSync(ms = 1500) {
  clearTimeout(Cloud.soon);
  Cloud.soon = setTimeout(syncNow, ms);
}

/** Redraw after other devices' changes arrive — but don't wipe out a form someone is typing in. */
function renderAfterSync() {
  const typing = document.activeElement?.closest?.('#view-settings, #view-stock, #view-admin');
  if (typing) { renderBanners(); renderSell(); renderCart(); }
  else renderAll();
}

/** After users change on another device: refresh our signed-in user (or lock if they were deleted). */
async function refreshCurrentUser() {
  if (!ui.user) return;
  const u = (await loadAuth()).users.find(x => x.id === ui.user.id);
  if (!u) { toast('Your user was removed on another device', true); await lockTill(); return; }
  setUser(u);
}

/** Called from startApp. */
async function startCloud() {
  Cloud.conf = (await DB.get('kv', 'cloud')) || null;
  DB.tracking = cloudOn();
  DB.onTracked = () => { Cloud.pending++; renderCloudStatus(); scheduleSync(); };
  Cloud.pending = cloudOn() ? await countOutbox() : 0;
  setCloudStatus(cloudOn() ? 'ok' : 'off');
  if (!Cloud.timer) Cloud.timer = setInterval(() => { if (document.visibilityState === 'visible') syncNow(); }, SYNC_EVERY_MS);
  scheduleSync(300);
}

/* ----- Connecting, joining, disconnecting ----- */

async function cloudAuthFromForm(create) {
  const email = $('#cEmail').value.trim();
  const password = $('#cPass').value;
  if (!/^\S+@\S+\.\S+$/.test(email)) return toast('Enter the shop email address', true);
  if (password.length < 6) return toast('The password needs at least 6 characters', true);
  if (!navigator.onLine) return toast('You need internet to sign in', true);
  const btns = $$('[data-action="cloud-signin"], [data-action="cloud-signup"]');
  btns.forEach(b => { b.disabled = true; });
  try {
    const r = await cloudSignIn(email, password, create);
    $('#cPass').value = '';
    if (r === 'confirm') {
      openModal({
        title: 'Check your email',
        body: `<p style="margin-top:0">We sent a confirmation link to <strong>${esc(email)}</strong>. Open it, then come back here and tap <strong>Sign in</strong>.</p>`,
        foot: '<button class="btn primary" data-action="close-modal">OK</button>',
      });
      return;
    }
    if (cloudOn()) { toast('Signed in'); setCloudStatus('ok'); renderSettings(); syncNow(); return; }
    const shops = await cloudApi('/rest/v1/shops?select=id,name,generation,active_until&order=created_at.asc');
    if (shops.length) openJoinShop(shops[0]); else openCreateShop();
  } catch (e) {
    toast(e.message, true);
  } finally {
    btns.forEach(b => { b.disabled = false; });
  }
}

function openCreateShop() {
  const demo = state.meta.demo;
  openModal({
    title: 'Create your shop in the cloud',
    body: `<p style="margin-top:0">No shop is linked to <strong>${esc(Cloud.conf.email)}</strong> yet. This device becomes till <strong>A</strong>; its receipts are numbered A-00001, A-00002…</p>
      ${demo
        ? '<div class="banner info"><p>This device still has the <strong>demo data</strong>. Start empty to set up your real shop.</p></div>'
        : `<p>This device has <strong>${state.products.length} products</strong> and <strong>${state.sales.length} sales</strong>. Upload them so every device starts with them.</p>`}`,
    foot: `<button class="btn" data-action="close-modal">Cancel</button>
      <button class="btn ${demo ? '' : 'primary'}" data-action="cloud-create" data-mode="upload">Upload ${demo ? 'demo data' : "this device's data"}</button>
      <button class="btn ${demo ? 'primary' : ''}" data-action="cloud-create" data-mode="empty">Start with an empty shop</button>`,
  });
}

async function createCloudShop(mode) {
  closeModal();
  try {
    if (mode === 'empty') {
      const theme = state.settings.theme;
      if (state.meta.demo) state.settings = { ...DEFAULT_SETTINGS, theme };
      state.products = []; state.sales = []; state.cashups = [];
      state.meta = { ...DEFAULT_META };
      ui.cart = emptyCart();
      await persistEverything();
      restoreCart(ui.cart);
    }
    const [shop] = await cloudApi('/rest/v1/shops', { method: 'POST', body: { name: state.settings.storeName }, headers: { Prefer: 'return=representation' } });
    const n = await cloudApi('/rest/v1/rpc/claim_device', { method: 'POST', body: { p_shop: shop.id } });
    Object.assign(Cloud.conf, { shopId: shop.id, shopName: shop.name, generation: shop.generation, activeUntil: shop.active_until ?? null, deviceCode: deviceLetter(n), lastSeq: 0 });
    state.meta.demo = false;
    await DB.write([opKv('meta', state.meta)]);
    await saveCloudConf();
    DB.tracking = true;
    await addOpeningMovements();
    await enqueueAll();
    renderAll();
    toast('Shop created — uploading…');
    await syncNow();
    if (Cloud.status === 'ok') toast('Your shop is in the cloud');
  } catch (e) {
    toast(e.message, true);
  }
}

function openJoinShop(shop) {
  ui.joinShop = shop;
  openModal({
    title: `Join ${shop.name}`,
    body: `<p style="margin-top:0">This device will download <strong>${esc(shop.name)}</strong> from the cloud and then stay in sync with your other devices. It gets its own till letter for receipt numbers.</p>
      <div class="banner"><p><strong>Everything on this device is replaced</strong> by the shop's data${state.meta.demo ? ' (it only has demo data now)' : ` — the ${state.products.length} products and ${state.sales.length} sales here will be removed. Download a backup first if you need them`}.</p></div>`,
    foot: `<button class="btn" data-action="close-modal">Cancel</button><button class="btn primary" data-action="cloud-join">Join and download</button>`,
  });
}

async function joinCloudShop() {
  const shop = ui.joinShop;
  if (!shop) return;
  closeModal();
  const before = { ...Cloud.conf };
  try {
    toast('Downloading your shop…');
    const n = await cloudApi('/rest/v1/rpc/claim_device', { method: 'POST', body: { p_shop: shop.id } });
    Object.assign(Cloud.conf, { shopId: shop.id, shopName: shop.name, generation: shop.generation, activeUntil: shop.active_until ?? null, deviceCode: deviceLetter(n), lastSeq: 0 });
    // A new till: its own number series, and its own cash drawer starts now.
    state.meta = { ...state.meta, nextReceiptNo: 1, nextCreditNo: 1, nextZNo: 1, lastCashupAt: new Date().toISOString(), float: 0, demo: false };
    await DB.write([opKv('meta', state.meta)]);
    await fullDownload();
    setCloudStatus('ok');
    toast(`Joined ${shop.name} — this is till ${Cloud.conf.deviceCode}`);
  } catch (e) {
    Cloud.conf = before;
    DB.tracking = false;
    await saveCloudConf();
    toast(e.message, true);
  }
}

async function disconnectCloud() {
  const n = await countOutbox();
  if (!(await confirmBox(`Stop syncing this device? Its data stays here, but new sales won't reach your other devices${n ? `, and ${n} change${n === 1 ? '' : 's'} not sent yet will stay only on this device` : ''}.`, 'Disconnect', true))) return;
  if (Cloud.conf?.access && navigator.onLine) await cloudApi('/auth/v1/logout', { method: 'POST' }).catch(() => {});
  // Keep the till letter so receipt numbers stay unique.
  Cloud.conf = { deviceId: Cloud.conf?.deviceId, deviceCode: Cloud.conf?.deviceCode, email: Cloud.conf?.email };
  DB.tracking = false;
  await DB.write([opKv('cloud', Cloud.conf)], ['outbox']);
  setCloudStatus('off');
  renderAll();
  toast('This device is no longer synced');
}

/** Start fresh / Restore on a synced device: empty the cloud copy first (needs internet). */
async function cloudResetBefore() {
  if (!cloudOn()) return true;
  if (!navigator.onLine) { toast('Cloud sync is on — connect to the internet first, so all devices get the change', true); return false; }
  try {
    const g = await cloudApi('/rest/v1/rpc/reset_shop', { method: 'POST', body: { p_shop: Cloud.conf.shopId } });
    Object.assign(Cloud.conf, { generation: g, lastSeq: 0 });
    await saveCloudConf();
    return true;
  } catch (e) {
    toast(e.message, true);
    return false;
  }
}
/** …then upload this device's new data. */
async function cloudResetAfter() {
  if (!cloudOn()) return;
  await DB.write([], ['outbox'], { remote: true });
  await addOpeningMovements();
  await enqueueAll();
  await syncNow();
}

/* ----- Status in the header ----- */

function setCloudStatus(status, message = '') {
  const was = Cloud.status;
  Cloud.status = status;
  Cloud.message = message;
  renderCloudStatus();
  if ((was === 'signedout') !== (status === 'signedout') && ui.appActive) renderBanners();
}

function renderCloudStatus() {
  const el = $('#netStatus');
  if (!el) return;
  const online = navigator.onLine;
  const p = Cloud.pending;
  let text, cls = '', title;
  if (!cloudOn()) {
    text = online ? 'Online' : 'Offline';
    cls = online ? '' : 'offline';
    title = online
      ? (cloudReady() ? 'Not synced: this device keeps its own data. Turn on cloud sync in Settings.' : 'Connected to the internet')
      : 'No internet — everything still works and is saved on this device';
    if (cloudReady()) { text = 'Not synced'; cls = 'offline'; }
  } else if (Cloud.status === 'syncing') {
    text = 'Syncing…'; title = 'Swapping changes with your other devices';
  } else if (!online || Cloud.status === 'offline') {
    text = p ? `Offline · ${p} waiting` : 'Offline'; cls = 'offline';
    title = 'No internet — sales are saved here and sent when the connection is back';
  } else if (Cloud.status === 'signedout') {
    text = 'Sign in to sync'; cls = 'err'; title = Cloud.message;
  } else if (Cloud.status === 'error') {
    text = 'Sync problem'; cls = 'err'; title = Cloud.message || 'Could not sync';
  } else {
    text = p ? 'Saving…' : 'Synced';
    title = Cloud.conf.lastSyncAt ? `Last synced ${fmtDT(Cloud.conf.lastSyncAt)}` : 'Synced';
  }
  el.textContent = text;
  el.className = 'net ' + cls;
  el.title = title;
  el.setAttribute('aria-label', `${text}. ${title}`);
  if (ui.view === 'settings' && document.getElementById('cloudStatusLine')) $('#cloudStatusLine').innerHTML = cloudStatusLine();
}

function cloudStatusLine() {
  const c = Cloud.conf;
  const last = c?.lastSyncAt ? `last synced ${fmtDT(c.lastSyncAt)}` : 'not synced yet';
  const state_ = { ok: 'Synced', syncing: 'Syncing…', offline: 'Offline', error: 'Problem', signedout: 'Signed out' }[Cloud.status] || '';
  return `<strong>${state_}</strong> · ${last}${Cloud.pending ? ` · ${Cloud.pending} change${Cloud.pending === 1 ? '' : 's'} waiting to send` : ''}${Cloud.message && Cloud.status !== 'ok' ? `<br><span class="err-text">${esc(Cloud.message)}</span>` : ''}`;
}

/** The "Cloud sync & backup" card in Settings. */
function cloudCardHtml() {
  const title = '<div class="section-title">Cloud sync &amp; backup</div>';
  if (!cloudReady()) {
    return `${title}<div class="card"><p class="small muted" style="margin:0">Cloud sync isn't set up in this copy of the app yet. Until it is, data stays only on this device — back up weekly.</p></div>`;
  }
  const c = Cloud.conf || {};
  const form = `
    <label class="field"><span>Shop email</span><input id="cEmail" class="input" type="email" autocomplete="username" autocapitalize="none" value="${esc(c.email || '')}"></label>
    <label class="field"><span>Shop password</span><input id="cPass" class="input" type="password" autocomplete="current-password"></label>`;
  if (cloudOn()) {
    return `${title}<div class="card cloud-card on">
      <p style="margin-top:0"><strong>${esc(c.shopName || 'Your shop')}</strong> · ${esc(c.email || '')}</p>
      <p class="small muted">This device is <strong>till ${esc(c.deviceCode)}</strong> (receipts ${esc(c.deviceCode)}-00001…). Sales, stock, products, settings and users are shared by all devices of the shop and kept safe online. Each till cashes up its own drawer.</p>
      <p class="small" id="cloudStatusLine">${cloudStatusLine()}</p>
      ${Cloud.status === 'signedout' ? `${form}<div class="row gap-s wrap" style="margin-bottom:10px"><button class="btn primary" data-action="cloud-signin">Sign in again</button></div>` : ''}
      <div class="row gap-s wrap">
        <button class="btn primary" data-action="cloud-sync">Sync now</button>
        <button class="btn" data-action="cloud-disconnect">Disconnect this device</button>
      </div>
    </div>`;
  }
  return `${title}<div class="card cloud-card">
    <p style="margin-top:0"><strong>Keep every device in step, and never lose your data.</strong> Sales, stock, products and settings are saved online and shared between your phone, iPad and PC. A new or wiped device simply signs in to get everything back.</p>
    ${form}
    <div class="row gap-s wrap">
      <button class="btn primary" data-action="cloud-signin">Sign in</button>
      <button class="btn" data-action="cloud-signup">Create shop account</button>
    </div>
    <p class="small muted" style="margin-bottom:0">Use the same shop email and password on every device. It is separate from the 4-digit staff PINs, and only needs entering once per device.</p>
  </div>`;
}

/* ===== 14c-2. Licence / subscription ====================================
   • A device that isn't connected to a shop account has a 14-day free trial
     from the day it was set up (meta.installedAt).
   • A connected device follows its shop's active_until date in the cloud
     (a new shop gets 30 days; null = no end date). Only the supplier can
     change that date (the database blocks shops from editing it).
   • Ending soon (≤ 7 days) → reminder banner. Past the date → 7 days' grace
     with a warning, then selling is paused: Charge is disabled, everything
     else (reports, backups, settings, renewing) keeps working.
   The date is checked on every sync and remembered, so it works offline.
   PLUG-IN: online payments — link the "Renew" button to a payment page
   (e.g. PayFast / Yoco link) that updates active_until via a webhook.
   ======================================================================== */

const TRIAL_DAYS = 14;
const GRACE_DAYS = 7;
const SUPPLIER = { name: 'Rails POS', whatsapp: '' }; // e.g. '27821234567' to show a WhatsApp "Renew" button

function licence() {
  const today = startOfDay();
  const daysTo = d => Math.round((startOfDay(d) - today) / DAY_MS);
  if (cloudOn()) {
    const until = Cloud.conf.activeUntil;
    if (until == null) return { state: 'active', text: 'Active, no end date' };
    const end = fromDateInput(until);
    if (!end) return { state: 'active', text: 'Active' };
    const left = daysTo(end); // 0 = last paid day is today
    const endTxt = fmtLong(end);
    if (left > 7) return { state: 'active', end, left, text: `Active until ${endTxt}` };
    if (left >= 0) return { state: 'ending', end, left, text: `Ends ${left === 0 ? 'today' : `in ${left} day${left === 1 ? '' : 's'}`} (${endTxt})` };
    const grace = GRACE_DAYS + left; // days of grace left
    if (grace > 0) return { state: 'grace', end, left: grace, text: `Ended ${endTxt}. Selling pauses in ${grace} day${grace === 1 ? '' : 's'}` };
    return { state: 'expired', end, text: `Ended ${endTxt}` };
  }
  const start = state.meta.installedAt ? new Date(state.meta.installedAt) : new Date();
  const end = addDays(startOfDay(start), TRIAL_DAYS);
  const left = daysTo(end);
  if (left > 0) return { state: 'trial', end, left, text: `Free trial: ${left} day${left === 1 ? '' : 's'} left` };
  return { state: 'trial-over', end, text: 'Free trial ended' };
}
const sellingAllowed = () => !['expired', 'trial-over'].includes(licence().state);

/** Banner shown on every screen when the subscription needs attention. */
function licenceBanner() {
  const l = licence();
  const renew = SUPPLIER.whatsapp
    ? `<a class="btn sm primary" href="https://wa.me/${esc(SUPPLIER.whatsapp)}?text=${encodeURIComponent(`Hi, I'd like to renew Rails POS for ${state.settings.storeName}`)}" target="_blank" rel="noopener">Renew on WhatsApp</a>` : '';
  const connect = !cloudOn() && cloudReady() && can('settings') ? '<button class="btn sm primary" data-action="go-settings">Connect shop account</button>' : '';
  const check = cloudOn() ? '<button class="btn sm" data-action="cloud-sync">Check again</button>' : '';
  if (l.state === 'expired' || l.state === 'trial-over') {
    return `<div class="banner licence-stop"><p><strong>Selling is paused.</strong> ${l.state === 'trial-over'
      ? 'The free trial on this device has ended. Connect your shop account (Settings → Cloud sync) to carry on.'
      : `Your Rails POS subscription ended on ${fmtLong(l.end)}. Contact ${esc(SUPPLIER.name)} to renew.`} Your data is safe: reports, backups and settings still work.</p>${connect}${renew}${check}</div>`;
  }
  if (l.state === 'grace') {
    return `<div class="banner licence-warn"><p><strong>Subscription ended.</strong> ${esc(l.text)}. Contact ${esc(SUPPLIER.name)} to renew.</p>${renew}${check}</div>`;
  }
  if (l.state === 'ending') {
    return `<div class="banner"><p><strong>Subscription ${l.left === 0 ? 'ends today' : `ends in ${l.left} day${l.left === 1 ? '' : 's'}`}.</strong> Renew to keep selling without interruption.</p>${renew}</div>`;
  }
  if (l.state === 'trial' && !state.meta.demo && l.left <= 7) {
    return `<div class="banner"><p><strong>${esc(l.text)}.</strong> Create your shop account to keep selling after the trial.</p>${connect}</div>`;
  }
  return '';
}

/* ===== 14d. First-time setup ============================================
   A device with no user accounts shows this instead of the sign-in screen:
     welcome  → Set up my shop / Try it with demo data / My shop already uses Rails POS
     new|demo → shop name + owner name + PIN (twice)
     owner    → device has shop data but no logins (e.g. upgraded): name + PIN only
     cloud    → shop email + password → join → download the shop and its staff logins
   ======================================================================== */

function showSetup(step = 'welcome') {
  ui.setupStep = step;
  $('#setup').hidden = false;
  renderSetup();
  updateInert();
}
function hideSetup() {
  $('#setup').hidden = true;
  updateInert();
}

function renderSetup() {
  const s = ui.setupStep;
  const head = (title, sub) => `<img src="icon-192.png" alt="" width="64" height="64"><h1 id="setupTitle">${title}</h1><p class="muted">${sub}</p>`;
  const back = '<button type="button" class="btn ghost block" data-action="setup-back">Back</button>';
  const err = '<p id="setupErr" class="err-text small" role="alert"></p>';
  const pinFields = `
    <div class="grid-2">
      <label class="field"><span>PIN (4 digits)</span><input id="suPin" class="input pin-input" type="password" inputmode="numeric" maxlength="4" autocomplete="new-password"></label>
      <label class="field"><span>PIN again</span><input id="suPin2" class="input pin-input" type="password" inputmode="numeric" maxlength="4" autocomplete="new-password"></label>
    </div>`;
  let html = '';
  if (s === 'welcome') {
    html = `${head('Welcome to Rails POS', 'The till for clothing shops. Works with no internet.')}
      <div class="setup-choices">
        <button type="button" class="btn primary block lg" data-action="setup-go" data-step="new">Set up my shop</button>
        <button type="button" class="btn block lg" data-action="setup-go" data-step="demo">Try it with demo data</button>
        ${cloudReady() ? '<button type="button" class="btn block lg" data-action="setup-go" data-step="cloud">My shop already uses Rails POS</button>' : ''}
      </div>
      <p class="small muted" style="margin:12px 0 0">Everything is saved on this device. You can turn on cloud sync later in Settings.</p>`;
  } else if (s === 'new' || s === 'demo') {
    html = `${head(s === 'new' ? 'Set up your shop' : 'Try Rails POS', s === 'new' ? 'You can add the address, VAT number and more in Settings later.' : 'Sample products and sales, so you can try everything. Start fresh from Settings when you are ready.')}
      <label class="field"><span>Shop name</span><input id="suShop" class="input" maxlength="40" value="${s === 'demo' ? 'Demo Boutique' : ''}" autocomplete="organization"></label>
      <label class="field"><span>Your name (your username)</span><input id="suName" class="input" maxlength="30" autocomplete="username" autocapitalize="words"></label>
      ${pinFields}${err}
      <button id="setupGo" class="btn primary block lg" type="submit">${s === 'new' ? 'Start selling' : 'Start the demo'}</button>${back}`;
  } else if (s === 'owner') {
    html = `${head('Create your owner login', 'This device has shop data but nobody can sign in yet. Choose the owner\'s name and PIN.')}
      <label class="field"><span>Your name (your username)</span><input id="suName" class="input" maxlength="30" autocomplete="username" autocapitalize="words"></label>
      ${pinFields}${err}
      <button id="setupGo" class="btn primary block lg" type="submit">Create login</button>`;
  } else if (s === 'cloud') {
    html = `${head('Sign in to your shop', 'Use the shop email and password from cloud sync. Everything downloads to this device.')}
      <label class="field"><span>Shop email</span><input id="suEmail" class="input" type="email" autocomplete="username" autocapitalize="none" value="${esc(Cloud.conf?.email || '')}"></label>
      <label class="field"><span>Shop password</span><input id="suPass" class="input" type="password" autocomplete="current-password"></label>
      ${err}
      <button id="setupGo" class="btn primary block lg" type="submit">Sign in</button>${back}`;
  } else if (s === 'join') {
    html = `${head(`Join ${esc(ui.setupShop?.name || 'your shop')}`, 'This device downloads the shop\'s products, sales, settings and staff logins, then stays in sync.')}
      ${err}
      <button id="setupGo" class="btn primary block lg" type="submit">Join and download</button>${back}`;
  }
  $('#setupForm').innerHTML = html;
  setTimeout(() => ($('#setupForm input') || $('#setupGo') || $('#setupForm button'))?.focus(), 30);
}

const setupError = msg => { const e = $('#setupErr'); if (e) e.textContent = msg; };

async function onSetupSubmit() {
  const s = ui.setupStep;
  const go = $('#setupGo');
  if (go?.disabled) return;
  if (go) go.disabled = true;
  try {
    if (s === 'new' || s === 'demo' || s === 'owner') await finishSetup(s);
    else if (s === 'cloud') await setupCloudSignIn();
    else if (s === 'join') await setupJoin();
  } finally {
    if ($('#setupGo')) $('#setupGo').disabled = false;
  }
}

async function finishSetup(mode) {
  const shop = mode === 'owner' ? null : $('#suShop').value.trim().replace(/\s+/g, ' ');
  const name = $('#suName').value.trim().replace(/\s+/g, ' ');
  const pin = $('#suPin').value.trim(), pin2 = $('#suPin2').value.trim();
  if (mode !== 'owner' && !shop) return setupError('Enter the shop name');
  if (!name) return setupError('Enter your name. It is your username for signing in');
  if (!/^\d{4}$/.test(pin)) return setupError('Choose a 4-digit PIN');
  if (pin !== pin2) return setupError('The two PINs are not the same');

  const user = { id: uid('u-'), name, role: 'owner', perms: [...ALL_PERMS] };
  await setPin(user, pin);
  if (mode === 'demo') {
    loadDemoData();
    state.settings.storeName = shop;
  } else if (mode === 'new') {
    const theme = state.settings.theme;
    state.settings = { ...DEFAULT_SETTINGS, storeName: shop, theme };
    state.products = []; state.sales = []; state.cashups = [];
    state.meta = { ...DEFAULT_META };
    ui.cart = emptyCart();
  }
  if (mode !== 'owner') {
    state.meta.installedAt = new Date().toISOString();
    await persistEverything();
    restoreCart(ui.cart);
  }
  await saveAuth({ users: [user] });
  ui.firstRun = false;
  writeSession(user.id);
  setUser(user);
  hideSetup();
  renderAll();
  toast(mode === 'new' ? `Welcome, ${name}! Add your products on the Stock screen.` : mode === 'demo' ? 'Demo ready. Try a sale!' : `Welcome, ${name}`);
}

async function setupCloudSignIn() {
  const email = $('#suEmail').value.trim();
  const password = $('#suPass').value;
  if (!/^\S+@\S+\.\S+$/.test(email)) return setupError('Enter the shop email address');
  if (!password) return setupError('Enter the shop password');
  if (!navigator.onLine) return setupError('You need internet to sign in');
  try {
    const r = await cloudSignIn(email, password, false);
    if (r === 'confirm') return setupError('Confirm the shop email first (check the inbox), then sign in');
    const shops = await cloudApi('/rest/v1/shops?select=id,name,generation,active_until&order=created_at.asc');
    if (!shops.length) return setupError('No shop is linked to this email yet. Go back, set up your shop, then turn on cloud sync in Settings.');
    ui.setupShop = shops[0];
    ui.setupStep = 'join';
    renderSetup();
  } catch (e) {
    setupError(e.message);
  }
}

async function setupJoin() {
  ui.joinShop = ui.setupShop;
  await joinCloudShop();
  if (!cloudOn()) return setupError('Could not download the shop. Check the internet and try again.');
  ui.firstRun = false;
  if ((await loadAuth()).users.length) { hideSetup(); showSignIn(); }
  else { ui.setupStep = 'owner'; renderSetup(); } // a cloud shop without logins (older version)
}

/** On boot / takeover: setup if nobody can sign in yet, otherwise the sign-in screen. */
async function showEntryScreen(signedIn) {
  let users = [];
  try { users = (await loadAuth()).users; } catch (err) { console.error(err); }
  if (!users.length) showSetup(ui.firstRun ? 'welcome' : 'owner');
  else if (!signedIn) showSignIn();
}

/* ===== 14e. Barcodes, camera scanner & product photos ===================
   Camera scanning: phones/browsers with a built-in BarcodeDetector (Android
   Chrome) use it; everything else (iPhone, iPad) uses the small reader below.

   The reader: take ~16 horizontal lines across the middle of the camera
   picture, turn each into light/dark "runs" (widths of bars and spaces),
   and try to read EAN-13 / UPC-A / EAN-8 (clothing-tag barcodes) or Code 128
   (printed SKU labels) from them, in both directions. A result only counts
   when its check digit is right AND two lines agree, so misreads are rare.
   ======================================================================== */

const Barcode = (() => {
  // EAN digit widths (space, bar, space, bar) in modules; G = mirror image.
  const EAN_L = ['3211', '2221', '2122', '1411', '1132', '1231', '1114', '1312', '1213', '3112'].map(s => [...s].map(Number));
  const EAN_G = EAN_L.map(w => w.slice().reverse());
  const EAN_FIRST = ['LLLLLL', 'LLGLGG', 'LLGGLG', 'LLGGGL', 'LGLLGG', 'LGGLLG', 'LGGGLL', 'LGLGLG', 'LGLGGL', 'LGGLGL'];
  // Code 128 symbol widths (bar, space, bar, space, bar, space), values 0–105; 106 = stop.
  const C128 = ('212222 222122 222221 121223 121322 131222 122213 122312 132212 221213 221312 231212 112232 122132 122231 113222 ' +
    '123122 123221 223211 221132 221231 213212 223112 312131 311222 321122 321221 312212 322112 322211 212123 212321 232121 ' +
    '111323 131123 131321 112313 132113 132311 211313 231113 231311 112133 112331 132131 113123 113321 133121 313121 211331 ' +
    '231131 213113 213311 213131 311123 311321 331121 312113 312311 332111 314111 221411 431111 111224 111422 121124 121421 ' +
    '141122 141221 112214 112412 122114 122411 142112 142211 241211 221114 413111 241112 134111 111242 121142 121241 114212 ' +
    '124112 124211 411212 421112 421211 212141 214121 412121 111143 111341 131141 114113 114311 411113 411311 113141 114131 ' +
    '311141 411131 211412 211214 211232 2331112').split(' ').map(s => [...s].map(Number));
  const C128_DATA = C128.slice(0, 106);

  /** How far a group of runs is from a width pattern, after scaling to `modules`.
      Blur and ink spread make bars look wider and gaps narrower by the same
      amount, so the main measure is bar+gap pairs ("edge to similar edge"),
      which that cancels out of. Single widths only break ties (e.g. EAN 1 vs 7). */
  function dist(runs, pattern, modules) {
    let total = 0;
    for (const r of runs) total += r;
    const k = modules / total;
    let pair = 0, raw = 0;
    for (let i = 0; i < pattern.length; i++) {
      raw += Math.abs(runs[i] * k - pattern[i]);
      if (i + 1 < pattern.length) pair += Math.abs((runs[i] + runs[i + 1]) * k - (pattern[i] + pattern[i + 1]));
    }
    return pair <= 1.4 && raw <= 3.2 ? pair + 0.35 * raw : Infinity;
  }
  function best(runs, table, modules) {
    let bi = -1, bd = Infinity, second = Infinity;
    for (let i = 0; i < table.length; i++) {
      const d = dist(runs, table[i], modules);
      if (d < bd) { second = bd; bd = d; bi = i; } else if (d < second) second = d;
    }
    return bd < Infinity ? [bi, bd] : [-1, Infinity];
  }
  const sumOf = a => a.reduce((x, y) => x + y, 0);
  function eanCheckOk(digits) {
    const n = digits.length;
    let s = 0;
    for (let i = 0; i < n - 1; i++) s += digits[i] * ((n - 1 - i) % 2 ? 3 : 1);
    return (10 - (s % 10)) % 10 === digits[n - 1];
  }

  /** EAN-13 (incl. UPC-A with a leading 0) or EAN-8 starting at run i (a bar). */
  function decodeEAN(runs, i) {
    for (const [count, half, modules] of [[59, 6, 95], [43, 4, 67]]) {
      if (i + count > runs.length) continue;
      const seg = runs.slice(i, i + count);
      const m = sumOf(seg) / modules;
      if (i > 0 && runs[i - 1] < 3 * m) continue; // needs a light margin before it
      const mid = 3 + half * 4;
      const guards = [0, 1, 2, mid, mid + 1, mid + 2, mid + 3, mid + 4, count - 3, count - 2, count - 1];
      if (!guards.every(k => seg[k] > 0.35 * m && seg[k] < 2 * m)) continue;
      const out = [];
      let parity = '', ok = true;
      for (let d = 0; d < half && ok; d++) {
        const r = seg.slice(3 + d * 4, 7 + d * 4);
        const [l, dl] = best(r, EAN_L, 7);
        const [g, dg] = half === 6 ? best(r, EAN_G, 7) : [-1, Infinity];
        if (l >= 0 && dl <= dg) { out.push(l); parity += 'L'; }
        else if (g >= 0) { out.push(g); parity += 'G'; }
        else ok = false;
      }
      for (let d = 0; d < half && ok; d++) {
        const [v] = best(seg.slice(mid + 5 + d * 4, mid + 9 + d * 4), EAN_L, 7);
        if (v < 0) ok = false; else out.push(v);
      }
      if (!ok) continue;
      let digits = out;
      if (half === 6) {
        const first = EAN_FIRST.indexOf(parity);
        if (first < 0) continue;
        digits = [first, ...out];
      } else if (parity !== 'LLLL') continue;
      if (eanCheckOk(digits)) return digits.join('');
    }
    return null;
  }

  /** Code 128 starting at run i (a bar). */
  function decode128(runs, i) {
    if (i + 6 > runs.length) return null;
    const [start] = best(runs.slice(i, i + 6), C128_DATA, 11);
    if (start < 103) return null;
    const m = sumOf(runs.slice(i, i + 6)) / 11;
    if (i > 0 && runs[i - 1] < 4 * m) return null;
    const vals = [start];
    let k = i + 6;
    for (;;) {
      if (k + 7 <= runs.length && dist(runs.slice(k, k + 7), C128[106], 13) < Infinity) break; // stop pattern
      if (k + 6 > runs.length || vals.length > 60) return null;
      const [v] = best(runs.slice(k, k + 6), C128_DATA, 11);
      if (v < 0 || v >= 103) return null;
      vals.push(v);
      k += 6;
    }
    if (vals.length < 3) return null;
    const check = vals.pop();
    let s = vals[0];
    for (let j = 1; j < vals.length; j++) s += vals[j] * j;
    if (s % 103 !== check) return null;
    return text128(vals);
  }

  function text128(vals) {
    let set = vals[0] === 103 ? 'A' : vals[0] === 104 ? 'B' : 'C';
    let out = '', shift = false;
    for (let j = 1; j < vals.length; j++) {
      const v = vals[j];
      const cur = shift ? (set === 'A' ? 'B' : 'A') : set;
      shift = false;
      if (cur === 'C' && v < 100) { out += String(v).padStart(2, '0'); continue; }
      if (cur !== 'C' && v < 96) { out += String.fromCharCode(cur === 'A' && v >= 64 ? v - 64 : v + 32); continue; }
      if (v === 98 && cur !== 'C') shift = true;
      else if (v === 99) set = 'C';
      else if (v === 100 && cur !== 'B') set = 'B';
      else if (v === 101 && cur !== 'A') set = 'A';
      // 96, 97, 102 (FNC codes) and FNC4 are ignored
    }
    return out;
  }

  /** One scan line (grey values) → light/dark runs.
      Finds the brightness peaks (gaps) and dips (bars), ignoring wiggles smaller
      than a share of the local contrast, and puts each edge half-way between a
      peak and the next dip (to a fraction of a pixel). This keeps thin gaps
      that blur has made faint, which a plain dark/light cut-off would lose. */
  function lineRuns(px) {
    const w = px.length;
    const R = Math.max(10, Math.round(w / 48));
    const sm = new Float32Array(w);
    for (let x = 0; x < w; x++) sm[x] = (px[Math.max(0, x - 1)] + 2 * px[x] + px[Math.min(w - 1, x + 1)]) / 4;
    // Minimum swing that counts, from the local contrast (no swings at all on plain areas)
    const need = new Float32Array(w);
    for (let x = 0; x < w; x++) {
      let lo = 255, hi = 0;
      for (let j = Math.max(0, x - R), e = Math.min(w - 1, x + R); j <= e; j++) { const v = sm[j]; if (v < lo) lo = v; if (v > hi) hi = v; }
      const range = hi - lo;
      need[x] = range < 24 ? 1e9 : Math.max(8, 0.2 * range);
    }
    // Peaks and dips, with hysteresis
    const ext = [];
    let mode = 0, ex = 0, ev = sm[0], lo = sm[0], loX = 0, hi = sm[0], hiX = 0;
    for (let x = 1; x < w; x++) {
      const v = sm[x], d = need[x];
      if (mode === 0) {
        if (v > hi) { hi = v; hiX = x; }
        if (v < lo) { lo = v; loX = x; }
        if (hi - v > d) { ext.push({ x: hiX, v: hi, light: true }); mode = -1; ex = x; ev = v; }
        else if (v - lo > d) { ext.push({ x: loX, v: lo, light: false }); mode = 1; ex = x; ev = v; }
      } else if (mode === 1) {
        if (v > ev) { ev = v; ex = x; } else if (ev - v > d) { ext.push({ x: ex, v: ev, light: true }); mode = -1; ev = v; ex = x; }
      } else if (v < ev) { ev = v; ex = x; } else if (v - ev > d) { ext.push({ x: ex, v: ev, light: false }); mode = 1; ev = v; ex = x; }
    }
    if (mode !== 0) ext.push({ x: ex, v: ev, light: mode === 1 });
    if (ext.length < 2) return { runs: [w], isDark: [0] };
    // Edges half-way (in brightness) between neighbouring peak and dip
    const edges = [];
    for (let k = 0; k + 1 < ext.length; k++) {
      const a = ext[k], b = ext[k + 1], mid = (a.v + b.v) / 2;
      let e = (a.x + b.x) / 2;
      for (let x = a.x + 1; x <= b.x; x++) {
        if ((sm[x - 1] - mid) * (sm[x] - mid) <= 0 && sm[x] !== sm[x - 1]) { e = x - 1 + (mid - sm[x - 1]) / (sm[x] - sm[x - 1]); break; }
      }
      edges.push(e);
    }
    const runs = [], isDark = [];
    let prev = 0;
    for (let k = 0; k < ext.length; k++) {
      const end = k < edges.length ? edges[k] : w;
      runs.push(Math.max(0.01, end - prev));
      isDark.push(ext[k].light ? 0 : 1);
      prev = end;
    }
    return { runs, isDark };
  }

  function decodeRuns(runs, isDark) {
    for (let i = 0; i < runs.length; i++) {
      if (!isDark[i]) continue;
      const code = decodeEAN(runs, i) || decode128(runs, i);
      if (code) return code;
    }
    return null;
  }

  /** All codes read from horizontal lines across a picture (one entry per line that read). */
  function decodeImageData(img, lines = 16) {
    const { width: w, height: h, data } = img;
    const found = [];
    const px = new Uint8Array(w);
    for (let n = 0; n < lines; n++) {
      const y = Math.min(h - 3, Math.max(2, Math.round(h * (0.1 + 0.8 * n / Math.max(1, lines - 1)))));
      // Average 5 rows: bars are vertical, so this removes camera noise without blurring them.
      for (let x = 0; x < w; x++) {
        let s = 0;
        for (let dy = -2; dy <= 2; dy++) { const o = ((y + dy) * w + x) * 4; s += data[o] * 77 + data[o + 1] * 150 + data[o + 2] * 29; }
        px[x] = (s / 5) >> 8;
      }
      const { runs, isDark } = lineRuns(px);
      const code = decodeRuns(runs, isDark) || decodeRuns(runs.slice().reverse(), isDark.slice().reverse());
      if (code) found.push(code);
    }
    return found;
  }

  /* Encoders: bar/space widths starting with a bar (for tests, and later for printing labels). */
  function encodeEAN13(twelve) {
    const d = [...String(twelve)].map(Number);
    let s = 0;
    d.forEach((x, i) => { s += x * ((12 - i) % 2 ? 3 : 1); });
    d.push((10 - (s % 10)) % 10);
    const par = EAN_FIRST[d[0]];
    const widths = [1, 1, 1];
    for (let i = 1; i <= 6; i++) widths.push(...(par[i - 1] === 'L' ? EAN_L : EAN_G)[d[i]]);
    widths.push(1, 1, 1, 1, 1);
    for (let i = 7; i <= 12; i++) widths.push(...EAN_L[d[i]]);
    widths.push(1, 1, 1);
    return { text: d.join(''), widths };
  }
  function encode128(text) {
    const vals = [104, ...[...String(text)].map(c => c.charCodeAt(0) - 32)];
    let s = vals[0];
    for (let j = 1; j < vals.length; j++) s += vals[j] * j;
    vals.push(s % 103, 106);
    return { text: String(text), widths: vals.flatMap(v => C128[v]) };
  }

  return { decodeImageData, encodeEAN13, encode128, C128, lineRuns, decodeRuns };
})();

/** Find a variant by SKU or by its own barcode (UPC-A and EAN-13 forms both match). */
function findByCode(code) {
  const s = String(code ?? '').trim().toUpperCase();
  if (!s) return null;
  const alt = /^\d{12}$/.test(s) ? '0' + s : /^0\d{12}$/.test(s) ? s.slice(1) : null;
  for (const product of state.products) for (const variant of product.variants) {
    if (variant.sku.toUpperCase() === s) return { product, variant };
    const b = String(variant.barcode || '').toUpperCase();
    if (b && (b === s || b === alt)) return { product, variant };
  }
  return null;
}

/* ----- Camera scanner ----- */

let barcodeDetector = null; // null = not checked yet, false = not available
async function getBarcodeDetector() {
  if (barcodeDetector !== null) return barcodeDetector;
  barcodeDetector = false;
  if ('BarcodeDetector' in window) {
    try {
      const have = await window.BarcodeDetector.getSupportedFormats();
      const formats = ['ean_13', 'ean_8', 'upc_a', 'code_128'].filter(f => have.includes(f));
      if (formats.length) barcodeDetector = new window.BarcodeDetector({ formats });
    } catch { /* use our own reader */ }
  }
  return barcodeDetector;
}

/** target: 'sell' (add to cart) or the id of an input to fill (e.g. 'vBarcode'). */
async function openScanner(target) {
  if (!navigator.mediaDevices?.getUserMedia) return toast('The camera is not available in this browser', true);
  ui.scan = { target, hits: new Map(), canvas: document.createElement('canvas') };
  $('#scanHint').textContent = 'Starting the camera…';
  $('#scanner').hidden = false;
  updateInert();
  $('#scanner [data-action="scan-close"]').focus();
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: false, video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
    });
    if (!ui.scan) { stream.getTracks().forEach(t => t.stop()); return; } // closed meanwhile
    ui.scan.stream = stream;
    const v = $('#scanVideo');
    v.srcObject = stream;
    await v.play();
    ui.scan.detector = await getBarcodeDetector();
    $('#scanHint').textContent = 'Hold the barcode flat inside the frame, about 10–20 cm away.';
    scanTick();
  } catch (e) {
    $('#scanHint').textContent = e.name === 'NotAllowedError'
      ? 'Camera permission was refused. Allow the camera for this site in the browser settings, then try again.'
      : `Could not start the camera (${e.message}).`;
  }
}

function closeScanner() {
  const sc = ui.scan;
  ui.scan = null;
  sc?.stream?.getTracks().forEach(t => t.stop());
  const v = $('#scanVideo');
  v.pause?.();
  v.srcObject = null;
  $('#scanner').hidden = true;
  updateInert();
}

async function scanTick() {
  const sc = ui.scan;
  if (!sc) return;
  const v = $('#scanVideo');
  if (v.readyState >= 2 && v.videoWidth) {
    let codes = [];
    if (sc.detector) { try { codes = (await sc.detector.detect(v)).map(b => b.rawValue); } catch { /* fall back */ } }
    if (!codes.length) {
      // Middle half of the picture, at most 1280 px wide
      const scale = Math.min(1, 1280 / v.videoWidth);
      const c = sc.canvas;
      c.width = Math.round(v.videoWidth * scale);
      c.height = Math.round(v.videoHeight * 0.5 * scale);
      const ctx = c.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(v, 0, v.videoHeight * 0.25, v.videoWidth, v.videoHeight * 0.5, 0, 0, c.width, c.height);
      codes = Barcode.decodeImageData(ctx.getImageData(0, 0, c.width, c.height));
    }
    for (const code of codes) {
      const n = (sc.hits.get(code) || 0) + 1;
      sc.hits.set(code, n);
      if (n >= (sc.detector ? 1 : 2)) { onScanned(code, sc.target); return; }
    }
  }
  if (ui.scan === sc) setTimeout(scanTick, 60);
}

function onScanned(code, target) {
  closeScanner();
  navigator.vibrate?.(60);
  if (target === 'sell') {
    const f = findByCode(code);
    if (f) {
      if (addToCart(f.variant.id, 1)) toast(`Added ${f.product.name} ${f.variant.size}/${f.variant.colour}`);
    } else {
      $('#sellSearch').value = code;
      renderSell();
      toast(`No product has barcode ${code}. Add it under Stock → tap the size → Barcode.`, true);
    }
    return;
  }
  const input = document.getElementById(target);
  if (input) {
    input.value = code;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    toast(`Barcode read: ${code}`);
  }
}

/* ----- Product photos (small: 160 × 160 JPEG, about 8 KB) ----- */

const PHOTO_PX = 160;

/** Only our own small data-URL pictures are shown (data can arrive from other devices). */
const photoSrc = p => (typeof p?.photo === 'string' && /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(p.photo) ? p.photo : null);
const thumbHtml = (p, cls = '') => { const s = photoSrc(p); return s ? `<img class="thumb ${cls}" src="${s}" alt="" loading="lazy">` : ''; };

/** Any picture file → small square JPEG data URL (centre-cropped). */
async function resizePhoto(file) {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = () => reject(new Error('That file is not a picture'));
      i.src = url;
    });
    const side = Math.min(img.naturalWidth, img.naturalHeight);
    const c = document.createElement('canvas');
    c.width = c.height = PHOTO_PX;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, PHOTO_PX, PHOTO_PX);
    ctx.drawImage(img, (img.naturalWidth - side) / 2, (img.naturalHeight - side) / 2, side, side, 0, 0, PHOTO_PX, PHOTO_PX);
    return c.toDataURL('image/jpeg', 0.72);
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Photo picked in the product form: shrink it and show the preview. */
async function onPhotoPicked(input) {
  const file = input.files?.[0];
  input.value = '';
  if (!file) return;
  try {
    ui.formPhoto = await resizePhoto(file);
    paintPhotoPreview();
  } catch (e) {
    toast(e.message, true);
  }
}
function paintPhotoPreview() {
  const box = $('#fPhotoPrev');
  if (!box) return;
  box.innerHTML = ui.formPhoto ? thumbHtml({ photo: ui.formPhoto }, 'lg') : '<span class="thumb lg empty-thumb" aria-hidden="true"><svg class="ico-sm"><use href="#i-camera"/></svg></span>';
  const rm = $('[data-action="photo-remove"]');
  if (rm) rm.hidden = !ui.formPhoto;
}

/* ----- Barcode labels (A4 sticker sheets or plain paper) -----
   Each label: shop name, product, size/colour, price, a Code 128 barcode of
   the SKU (which the camera scanner and USB scanners read) and the SKU text.
   Sizes in mm. "Start at label no." lets a half-used sheet be used up. */

const LABEL_SHEETS = {
  a4_24: { name: '24 per sheet · 70 × 37 mm (3 × 8)', cols: 3, rows: 8, w: 70, h: 37, top: 0.5, left: 0, gapX: 0, gapY: 0 },
  a4_21: { name: '21 per sheet · 63.5 × 38.1 mm (3 × 7)', cols: 3, rows: 7, w: 63.5, h: 38.1, top: 15.15, left: 7.2, gapX: 2.5, gapY: 0 },
  a4_40: { name: '40 per sheet · 52.5 × 29.7 mm (4 × 10)', cols: 4, rows: 10, w: 52.5, h: 29.7, top: 0, left: 0, gapX: 0, gapY: 0 },
  plain: { name: 'Plain A4 paper, cut out (3 × 8)', cols: 3, rows: 8, w: 66, h: 34, top: 12, left: 6, gapX: 0, gapY: 0, cut: true },
};

/** Code 128 barcode as an SVG that stretches to fit its box (empty if the text can't be encoded). */
function barcodeSvg(text) {
  if (!/^[\x20-\x7e]{1,40}$/.test(text)) return '';
  const { widths } = Barcode.encode128(text);
  const total = widths.reduce((a, b) => a + b, 0) + 20; // + quiet zones
  let x = 10, rects = '';
  widths.forEach((w, i) => { if (i % 2 === 0) rects += `<rect x="${x}" y="0" width="${w}" height="40"/>`; x += w; });
  return `<svg class="lbl-bc" viewBox="0 0 ${total} 40" preserveAspectRatio="none" shape-rendering="crispEdges" aria-hidden="true">${rects}</svg>`;
}

function openLabels(productId = null) {
  const p = productId ? findProduct(productId) : null;
  if (productId && !p) return;
  ui.labels = { productId: p?.id || null, sheet: ui.labelSheet || 'a4_24', start: 1, price: true, shop: true, qty: {} };
  (p ? [p] : state.products).forEach(x => x.variants.forEach(v => { ui.labels.qty[v.id] = p ? Math.max(0, v.stock) : 0; }));
  openModal({ title: p ? `Labels · ${p.name}` : 'Print barcode labels', body: '<div id="labelsBody"></div>', foot: '<div id="labelsFoot" class="foot-row"></div>' });
  renderLabels();
}

function renderLabels() {
  const L = ui.labels;
  const products = L.productId ? [findProduct(L.productId)].filter(Boolean) : state.products;
  $('#labelsBody').innerHTML = `
    <label class="field"><span>Label sheet</span><select id="lbSheet">${Object.entries(LABEL_SHEETS).map(([k, s]) =>
      `<option value="${k}" ${k === L.sheet ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}</select></label>
    <div class="grid-2">
      <label class="field"><span>Start at label no.</span><input id="lbStart" class="input" inputmode="numeric" value="${L.start}"></label>
      <div class="field"><span>Show on the label</span>
        <label class="check"><input type="checkbox" id="lbPrice" ${L.price ? 'checked' : ''}><span>Price</span></label>
        <label class="check" style="margin-top:6px"><input type="checkbox" id="lbShop" ${L.shop ? 'checked' : ''}><span>Shop name</span></label></div>
    </div>
    <div class="row gap-s wrap" style="margin-bottom:10px">
      <button class="btn sm" data-action="lb-fill" data-mode="stock">Quantity = stock</button>
      <button class="btn sm" data-action="lb-fill" data-mode="one">1 of each</button>
      <button class="btn sm" data-action="lb-fill" data-mode="none">Clear</button>
    </div>
    <div class="lb-list">${products.length ? products.map(p => `<div class="lb-prod"><div class="lb-pname">${thumbHtml(p, 'sm')}<strong>${esc(p.name)}</strong></div>
      ${p.variants.map(v => `<label class="lb-row"><span class="grow">${esc(v.size)} / ${esc(v.colour)} <span class="muted small">${esc(v.sku)} · ${v.stock} in stock</span></span>
        <input class="input sm lb-qty" inputmode="numeric" data-lbq="${esc(v.id)}" value="${L.qty[v.id] || 0}" aria-label="Labels for ${esc(p.name)} ${esc(v.size)} ${esc(v.colour)}"></label>`).join('')}</div>`).join('')
      : '<div class="empty">No products yet.</div>'}</div>
    <p class="small muted" style="margin-bottom:0">In the print window choose <strong>A4</strong>, scale <strong>100% / Actual size</strong> and margins <strong>None</strong> so the labels line up with the sheet.</p>`;
  $('#labelsFoot').innerHTML = `<span class="grow small" id="lbCount"></span>
    <button class="btn" data-action="close-modal">Cancel</button>
    <button class="btn primary" data-action="lb-print">Print labels</button>`;
  paintLabelCount();
}

function paintLabelCount() {
  const L = ui.labels;
  if (!L || !$('#lbCount')) return;
  const s = LABEL_SHEETS[L.sheet];
  const total = sum(Object.values(L.qty), n => n);
  const sheets = total ? Math.ceil((total + L.start - 1) / (s.cols * s.rows)) : 0;
  $('#lbCount').textContent = `${total} label${total === 1 ? '' : 's'} · ${sheets} sheet${sheets === 1 ? '' : 's'}`;
  $('[data-action="lb-print"]').disabled = !total;
}

function onLabelsChange(t) {
  const L = ui.labels;
  if (!L) return;
  if (t.dataset.lbq !== undefined) L.qty[t.dataset.lbq] = Math.max(0, Math.min(999, parseInt(t.value, 10) || 0));
  if (t.id === 'lbSheet') { L.sheet = t.value; ui.labelSheet = t.value; }
  if (t.id === 'lbStart') { const per = LABEL_SHEETS[L.sheet].cols * LABEL_SHEETS[L.sheet].rows; L.start = Math.max(1, Math.min(per, parseInt(t.value, 10) || 1)); }
  if (t.id === 'lbPrice') L.price = t.checked;
  if (t.id === 'lbShop') L.shop = t.checked;
  paintLabelCount();
}

function fillLabels(mode) {
  const L = ui.labels;
  const products = L.productId ? [findProduct(L.productId)].filter(Boolean) : state.products;
  products.forEach(p => p.variants.forEach(v => { L.qty[v.id] = mode === 'stock' ? Math.max(0, v.stock) : mode === 'one' ? 1 : 0; }));
  renderLabels();
}

function printLabels() {
  const L = ui.labels;
  if (!L) return;
  const s = LABEL_SHEETS[L.sheet];
  const per = s.cols * s.rows;
  const items = [];
  for (const p of state.products) for (const v of p.variants) for (let i = 0; i < (L.qty[v.id] || 0); i++) items.push({ p, v });
  if (!items.length) return toast('Choose how many labels to print', true);
  const cells = [...Array(L.start - 1).fill(null), ...items];
  const pages = [];
  for (let i = 0; i < cells.length; i += per) pages.push(cells.slice(i, i + per));
  const small = s.h < 32 ? ' small' : '';
  $('#printA4').innerHTML = pages.map(page => `<div class="lbl-sheet">${page.map((it, i) => {
    if (!it) return '';
    const left = s.left + (i % s.cols) * (s.w + s.gapX);
    const top = s.top + Math.floor(i / s.cols) * (s.h + s.gapY);
    return `<div class="lbl${s.cut ? ' cut' : ''}${small}" style="left:${left}mm;top:${top}mm;width:${s.w}mm;height:${s.h}mm">
      ${L.shop ? `<div class="lbl-shop">${esc(state.settings.storeName)}</div>` : ''}
      <div class="lbl-name">${esc(it.p.name)}</div>
      <div class="lbl-var">${esc(it.v.size)} / ${esc(it.v.colour)}${L.price ? `<span class="lbl-price">${money(priceOf(it.p, it.v))}</span>` : ''}</div>
      ${barcodeSvg(it.v.sku)}
      <div class="lbl-sku">${esc(it.v.sku)}</div>
    </div>`;
  }).join('')}</div>`).join('');
  setPrintMode('a4', '@page { size: A4 portrait; margin: 0; }');
  closeModal();
  toast(`${items.length} label${items.length === 1 ? '' : 's'} ready to print`);
  setTimeout(() => window.print(), 50);
}

/* ===== 15. One tab at a time ============================================
   Each tab keeps the data in memory, so two open tabs could overwrite each
   other's work. A Web Lock makes sure only one tab is "active"; any other
   tab shows a screen offering to take over (the old tab then pauses).
   ======================================================================== */

const LOCK_NAME = DB_NAME + '-active-tab';
const channel = 'BroadcastChannel' in window ? new BroadcastChannel(DB_NAME) : null;
let releaseLock = null;

/** Resolves true once this tab holds the lock (false if ifAvailable and it is taken). */
function acquireTabLock(ifAvailable) {
  if (!navigator.locks) return Promise.resolve(true); // very old browsers: no protection
  return new Promise(resolve => {
    navigator.locks.request(LOCK_NAME, { ifAvailable }, lock => {
      if (!lock) { resolve(false); return; }
      resolve(true);
      return new Promise(release => { releaseLock = release; }); // hold until released
    }).catch(() => resolve(true));
  });
}

function showBlocker(msg) {
  $('#blockerMsg').textContent = msg;
  $('#blocker').hidden = false;
  updateInert();
  $('#blocker button').focus();
}
function hideBlocker() {
  $('#blocker').hidden = true;
  updateInert();
}

/** Another tab asked to take over: save everything, pause, let go of the lock. */
async function pauseThisTab() {
  if (!ui.appActive) return;
  ui.appActive = false;
  await flushAllAdjust();
  await saveCart(true);
  if (ui.scan) closeScanner();
  closeModal();
  closeCartSheet();
  showBlocker('Rails POS was opened in another tab or window, so this one is paused.');
  releaseLock?.();
  releaseLock = null;
}

async function takeOver() {
  $('#blockerMsg').textContent = 'Switching…';
  channel?.postMessage({ type: 'takeover' });
  await acquireTabLock(false);
  let signedIn = !!ui.user;
  if (!signedIn) { try { signedIn = await resumeSession(); } catch (err) { console.error(err); } }
  await startApp();
  await showEntryScreen(signedIn); // each tab must sign in for itself
}

/* ===== 16. Service worker =============================================== */

async function registerServiceWorker() {
  if (TEST_MODE || !('serviceWorker' in navigator) || !location.protocol.startsWith('http')) return;
  try {
    const reg = await navigator.serviceWorker.register('./sw.js');
    const ready = () => { ui.updateReady = true; renderBanners(); };
    if (reg.waiting && navigator.serviceWorker.controller) ready();
    reg.addEventListener('updatefound', () => {
      const w = reg.installing;
      w?.addEventListener('statechange', () => { if (w.state === 'installed' && navigator.serviceWorker.controller) ready(); });
    });
    // Reload only when the user pressed "Reload now" (not on the very first install).
    navigator.serviceWorker.addEventListener('controllerchange', () => { if (ui.applyingUpdate) location.reload(); });
    // Check for a new version whenever the app comes back to the foreground.
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') reg.update().catch(() => {}); });
    ui.swReg = reg;
  } catch (err) {
    console.warn('SW registration failed', err);
  }
}

async function applyUpdate() {
  await flushAllAdjust();
  await saveCart(true);
  const w = ui.swReg?.waiting;
  if (!w) return location.reload();
  ui.applyingUpdate = true;
  w.postMessage({ type: 'SKIP_WAITING' });
}

/* ===== 17. Events & boot ================================================ */

/** All clicks go through here. Elements declare data-action="name". */
const actions = {
  nav: el => showView(el.dataset.view),
  cat: el => { ui.category = el.dataset.cat; renderSell(); },
  pick: el => openPicker(el.dataset.id),
  'pk-size': el => { ui.picker.size = ui.picker.size === el.dataset.v ? null : el.dataset.v; renderPicker(); },
  'pk-colour': el => { ui.picker.colour = ui.picker.colour === el.dataset.v ? null : el.dataset.v; renderPicker(); },
  'pk-qty': el => { ui.picker.qty = Math.max(1, ui.picker.qty + Number(el.dataset.d)); renderPicker(); },
  'pk-add': () => {
    const pk = ui.picker; const p = findProduct(pk.productId);
    const v = p.variants.find(x => x.size === pk.size && x.colour === pk.colour);
    if (v && addToCart(v.id, pk.qty)) { toast(`Added ${pk.qty} × ${p.name} ${v.size}/${v.colour}`); closeModal(); }
  },
  'line-qty': el => setLineQty(el.dataset.id, cartQty(el.dataset.id) + Number(el.dataset.d)),
  'line-remove': el => setLineQty(el.dataset.id, 0),
  'clear-cart': async () => {
    if (ui.cart.credit && !(await cancelCredit())) return;
    ui.cart = emptyCart(ui.cart.payment);
    $('#discountValue').value = ''; $('#tendered').value = '';
    renderCart(); saveCart(true);
  },
  'cancel-credit': () => cancelCredit(),
  'disc-type': el => { ui.cart.discountType = el.dataset.type; renderCart(); saveCart(); },
  pay: el => { ui.cart.payment = el.dataset.pay; renderCart(); saveCart(); },
  cash: el => {
    $('#tendered').value = el.dataset.v ? centsToPlain(Number(el.dataset.v)) : '';
    ui.cart.tenderedText = $('#tendered').value; renderTotals(); saveCart();
  },
  checkout: () => checkout(),
  'customer-save': () => {
    const name = $('#cName').value.trim();
    const address = $('#cAddress').value.trim();
    if (!name || !address) return toast('Name and address are required on a full tax invoice', true);
    ui.cart.customer = { name, address, vatNumber: $('#cVat').value.trim() };
    saveCart();
    closeModal();
    checkout();
  },
  'open-cart': () => openCartSheet(),
  'close-cart': () => closeCartSheet(),
  backdrop: () => { if (!$('#modal').hidden) closeModal(); else closeCartSheet(); },
  'close-modal': () => closeModal(),
  'confirm-ok': () => { const r = ui.confirmResolve; ui.confirmResolve = null; closeModal(); r?.(true); },
  'open-doc': el => showDoc(el.dataset.doc),
  'doc-wa': el => shareWhatsApp(el.dataset.doc),
  'doc-copy': el => copyText(resolveDoc(el.dataset.doc)?.text || '', 'Copied'),
  'doc-print': el => printDoc(el.dataset.doc),
  'open-return': el => openReturn(el.dataset.id),
  'ret-qty': el => {
    const sale = state.sales.find(s => s.id === ui.ret.saleId);
    const idx = Number(el.dataset.idx);
    const max = sale.items[idx].qty - returnedQty(sale, idx);
    ui.ret.qty[idx] = Math.min(max, Math.max(0, (ui.ret.qty[idx] || 0) + Number(el.dataset.d)));
    renderReturn();
  },
  'ret-all': () => {
    const sale = state.sales.find(s => s.id === ui.ret.saleId);
    sale.items.forEach((it, idx) => { ui.ret.qty[idx] = it.qty - returnedQty(sale, idx); });
    renderReturn();
  },
  'ret-method': el => { ui.ret.method = el.dataset.m; renderReturn(); },
  'ret-go': el => processReturn(el.dataset.mode === 'exchange'),
  'toggle-low': () => { ui.lowOnly = !ui.lowOnly; renderStock(); },
  'add-product': () => openAddProduct(),
  'np-all': () => { $$('#variantGrid input[data-key]').forEach(i => { i.value = $('#fAll').value; }); },
  'np-save': () => saveNewProduct(),
  'edit-product': el => openEditProduct(el.dataset.id),
  'ep-save': el => saveEditProduct(el.dataset.id),
  'add-variant': el => openVariantForm(el.dataset.id),
  'edit-variant': el => { const f = findVariant(el.dataset.id); if (f) openVariantForm(f.product.id, f.variant.id); },
  'variant-save': el => saveVariant(el.dataset.pid, el.dataset.id || null),
  'delete-variant': el => deleteVariant(el.dataset.id),
  'delete-product': el => deleteProduct(el.dataset.id),
  'stock-d': el => { const f = findVariant(el.dataset.id); if (f) adjustStock(el.dataset.id, f.variant.stock + Number(el.dataset.d), 'adjust'); },
  receive: el => openReceive(el.dataset.id),
  'receive-save': el => saveReceive(el.dataset.id),
  history: el => openHistory(el.dataset.id),
  range: el => { ui.reportRange = el.dataset.range; renderReports(); },
  'print-menu': () => openPrintMenu(),
  'print-a4': () => printA4($('#modal input[name="a4kind"]:checked')?.value || 'summary'),
  cashup: () => openCashup(),
  'cashup-save': () => saveCashup(),
  'backup-download': () => backupDownload(),
  'backup-copy': () => backupCopy(),
  'backup-share': () => backupShare(),
  'restore-paste': () => restoreFromText($('#restoreText').value),
  'export-csv': () => exportCsv(),
  'start-fresh': () => startFresh(),
  'load-demo': () => loadDemo(),
  'apply-update': () => applyUpdate(),
  takeover: () => takeOver(),
  lock: () => lockTill(),
  'change-pin': () => openChangePin(),
  'pin-save': () => saveNewPin(),
  'user-add': () => openUserForm(),
  'user-edit': el => openUserForm(el.dataset.id),
  'user-save': el => saveUser(el.dataset.id || null),
  'user-delete': el => deleteUser(el.dataset.id),
  'cloud-signin': () => cloudAuthFromForm(false),
  'cloud-signup': () => cloudAuthFromForm(true),
  'cloud-sync': () => syncNow(),
  'cloud-disconnect': () => disconnectCloud(),
  'cloud-create': el => createCloudShop(el.dataset.mode),
  'cloud-join': () => joinCloudShop(),
  'go-settings': () => showView('settings'),
  scan: el => openScanner(el.dataset.target),
  'scan-close': () => closeScanner(),
  'photo-remove': () => { ui.formPhoto = null; paintPhotoPreview(); },
  'setup-go': el => { ui.setupStep = el.dataset.step; renderSetup(); },
  'setup-back': () => { ui.setupStep = 'welcome'; renderSetup(); },
  labels: el => openLabels(el.dataset.id || null),
  'lb-fill': el => fillLabels(el.dataset.mode),
  'lb-print': () => printLabels(),
};

/* Actions that need a permission. Buttons are hidden too, but this is the real check. */
const ACTION_PERMS = {
  'open-return': 'returns', 'ret-qty': 'returns', 'ret-all': 'returns', 'ret-method': 'returns', 'ret-go': 'returns',
  'toggle-low': 'stock', 'add-product': 'stock', 'np-all': 'stock', 'np-save': 'stock', 'edit-product': 'stock', 'ep-save': 'stock',
  'add-variant': 'stock', 'edit-variant': 'stock', 'variant-save': 'stock', 'delete-variant': 'stock', 'delete-product': 'stock',
  'stock-d': 'stock', receive: 'stock', 'receive-save': 'stock', history: 'stock',
  range: 'reports', cashup: 'reports', 'cashup-save': 'reports', 'print-menu': 'reports', 'print-a4': 'reports',
  'backup-download': 'settings', 'backup-copy': 'settings', 'backup-share': 'settings', 'restore-paste': 'settings',
  'export-csv': 'settings', 'start-fresh': 'settings', 'load-demo': 'settings',
  'user-add': 'admin', 'user-edit': 'admin', 'user-save': 'admin', 'user-delete': 'admin',
  'cloud-signin': 'settings', 'cloud-signup': 'settings', 'cloud-disconnect': 'settings', 'cloud-create': 'settings', 'cloud-join': 'settings',
  'go-settings': 'settings',
  labels: 'stock', 'lb-fill': 'stock', 'lb-print': 'stock',
};
function allowed(perm) {
  if (!perm || can(perm)) return true;
  toast(`${ui.user?.name || 'This user'} doesn't have access to that`, true);
  return false;
}

function bindEvents() {
  document.addEventListener('click', e => {
    const el = e.target.closest('[data-action]');
    if (!el || el.disabled || el.closest('[inert]')) return;
    const fn = actions[el.dataset.action];
    if (!fn) return;
    e.preventDefault();
    if (allowed(ACTION_PERMS[el.dataset.action])) fn(el, e);
  });

  $('#signinForm').addEventListener('submit', e => { e.preventDefault(); submitSignIn(); });
  $('#setupForm').addEventListener('submit', e => { e.preventDefault(); onSetupSubmit(); });
  // PIN boxes accept digits only
  document.addEventListener('input', e => {
    if (e.target.classList?.contains('pin-input')) e.target.value = e.target.value.replace(/\D/g, '').slice(0, 4);
  });
  $('#sellSearch').addEventListener('input', renderSell);
  $('#sellSearch').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); onSellSearchEnter(); } });
  $('#stockSearch').addEventListener('input', renderStock);
  $('#salesSearch').addEventListener('input', renderSales);
  $('#discountValue').addEventListener('input', e => { ui.cart.discountText = e.target.value; renderTotals(); saveCart(); });
  $('#tendered').addEventListener('input', e => { ui.cart.tenderedText = e.target.value; renderTotals(); saveCart(); });

  document.addEventListener('change', e => {
    const t = e.target;
    if (t.dataset.stockInput && allowed('stock')) adjustStock(t.dataset.stockInput, t.value === '' ? 0 : t.value, 'count');
    if (t.dataset.setting && allowed('settings')) onSettingChange(t);
    if (t.id === 'restoreFile' && t.files[0] && allowed('settings')) { t.files[0].text().then(restoreFromText); t.value = ''; }
    if (t.id === 'uRole' || (t.dataset.perm && t.closest('#modal'))) onUserFormChange(t);
    if (t.id === 'fPhoto') onPhotoPicked(t);
    if (t.closest?.('#labelsBody')) onLabelsChange(t);
    if ((t.id === 'rFrom' || t.id === 'rTo') && t.value) {
      ui.customFrom = $('#rFrom').value; ui.customTo = $('#rTo').value;
      renderReports();
    }
  });

  document.addEventListener('input', e => {
    if (e.target.id === 'fSizes' || e.target.id === 'fColours') renderVariantGrid();
    if (e.target.id === 'cuCounted') paintCashupDiff();
    if (e.target.dataset?.lbq !== undefined) onLabelsChange(e.target); // label counts update as you type
  });

  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && $('#blocker').hidden) {
      if (!$('#scanner').hidden) closeScanner();
      else if (!$('#modal').hidden) closeModal();
      else closeCartSheet();
    }
    if (e.key === 'Enter' && !$('#modal').hidden && e.target.tagName === 'INPUT') {
      // Enter in a modal form presses its primary button
      const primary = $('#modal .modal-foot .btn.primary');
      if (primary && !primary.disabled) { e.preventDefault(); primary.click(); }
    }
    // Keyboard access for the "Restore from file" label-button
    if ((e.key === 'Enter' || e.key === ' ') && e.target.matches?.('[data-file-trigger]')) { e.preventDefault(); e.target.querySelector('input[type="file"]')?.click(); }
    // Keep Tab inside the modal / sheet (backup for browsers without `inert`)
    if (e.key === 'Tab') {
      const box = !$('#blocker').hidden ? $('#blocker') : !$('#scanner').hidden ? $('#scanner') : !$('#setup').hidden ? $('#setup')
        : !$('#signin').hidden ? $('#signin') : !$('#modal').hidden ? $('#modal')
        : ($('#cartPanel').classList.contains('open') && !isWide()) ? $('#cartPanel') : null;
      if (!box) return;
      const items = $$(FOCUSABLE, box).filter(x => x.offsetParent !== null);
      if (!items.length) return;
      const first = items[0], last = items[items.length - 1];
      if (e.shiftKey && (document.activeElement === first || !box.contains(document.activeElement))) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && (document.activeElement === last || !box.contains(document.activeElement))) { e.preventDefault(); first.focus(); }
    }
  });

  // Header pill: online / offline, or the cloud sync status
  window.addEventListener('online', () => { renderCloudStatus(); syncNow(); });
  window.addEventListener('offline', () => renderCloudStatus());
  $('#netStatus').addEventListener('click', () => {
    if (!ui.user || !$('#blocker').hidden) return;
    if (cloudOn() && Cloud.status !== 'signedout') syncNow();
    else if (cloudReady() && can('settings')) showView('settings');
  });
  renderCloudStatus();

  // Save anything pending when the app is hidden or closed (phone locked, app switched).
  const flush = () => { if (ui.appActive) { flushAllAdjust(); saveCart(true); } };
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flush(); else syncNow(); });
  window.addEventListener('pagehide', flush);

  window.matchMedia('(min-width: 860px)').addEventListener('change', () => { closeCartSheet(); updateInert(); });
  window.addEventListener('afterprint', () => setPrintMode('slip'));

  channel?.addEventListener('message', e => { if (e.data?.type === 'takeover') pauseThisTab(); });
}

async function startApp() {
  try {
    await loadState();
  } catch (err) {
    console.error(err);
    showBlocker('Could not open the data on this device: ' + err.message);
    return;
  }
  ui.appActive = true;
  hideBlocker();
  try { await startCloud(); } catch (err) { console.error(err); }
  renderAll();
  if (isWide()) $('#sellSearch').focus();
}

async function boot() {
  bindEvents();
  updateInert();
  registerServiceWorker();
  // Ask the browser not to evict our data when space is low.
  if (navigator.storage?.persist) navigator.storage.persist().catch(() => {});
  if (!(await acquireTabLock(true))) {
    showBlocker('Rails POS is already open in another tab or window.');
    return;
  }
  let signedIn = false;
  try { signedIn = await resumeSession(); } catch (err) { console.error(err); }
  await startApp();
  await showEntryScreen(signedIn);
}

// Handle for tests / debugging in the console.
window.__pos = { state, ui, DB, actions, buildReport, computeShift, receiptText, creditNoteText, zText, cartTotals, flushAllAdjust, checkLogin,
  Cloud, CLOUD, syncNow, applyRemote, Barcode, findByCode, resizePhoto, licence, sellingAllowed };

boot();
