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
const DB_NAME = TEST_MODE ? 'rails-pos-test' : 'rails-pos';
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

   PLUG-IN: cloud sync — after a successful DB.write(), copy the ops into an
   "outbox" store and push them to a server when navigator.onLine is true.
   ======================================================================== */

const STORES = ['kv', 'products', 'sales', 'movements', 'cashups'];

const DB = (() => {
  let dbPromise = null;

  function open() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      if (!('indexedDB' in window)) return reject(new Error('This browser cannot store data (IndexedDB missing).'));
      const req = indexedDB.open(DB_NAME, 2);
      req.onupgradeneeded = e => {
        const db = req.result;
        const tx = req.transaction;
        if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
        if (!db.objectStoreNames.contains('products')) db.createObjectStore('products', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('sales')) db.createObjectStore('sales', { keyPath: 'id' }).createIndex('date', 'date');
        if (!db.objectStoreNames.contains('movements')) db.createObjectStore('movements', { keyPath: 'id' }).createIndex('productId', 'productId');
        if (!db.objectStoreNames.contains('cashups')) db.createObjectStore('cashups', { keyPath: 'id' });
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

  /** ops: [{store, value}] put by keyPath, [{store, key, value}] put by key, [{store, key, del: true}] delete. */
  async function write(ops, clearFirst = []) {
    const db = await open();
    const names = [...new Set([...ops.map(o => o.store), ...clearFirst])];
    if (!names.length) return;
    return new Promise((resolve, reject) => {
      const tx = db.transaction(names, 'readwrite');
      clearFirst.forEach(n => tx.objectStore(n).clear());
      for (const o of ops) {
        const s = tx.objectStore(o.store);
        if (o.del) s.delete(o.key);
        else if (o.key !== undefined) s.put(clone(o.value), o.key);
        else s.put(clone(o.value));
      }
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  }

  return { open, get, getAll, getAllByIndex, write };
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
  reportDays: 1,
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
    // First run: load demo data so the app isn't empty.
    loadDemoData();
    await persistEverything();
    return;
  }
  state.settings = { ...DEFAULT_SETTINGS, ...settings };
  state.meta = { ...DEFAULT_META, ...meta };
  state.products = products.sort((a, b) => (a.created || 0) - (b.created || 0) || a.name.localeCompare(b.name));
  state.sales = sales.map(normalizeSale).sort((a, b) => a.number - b.number || a.date.localeCompare(b.date));
  state.cashups = cashups.sort((a, b) => a.number - b.number);
  restoreCart(cart);
}

/** Bring older sale records up to the current shape. */
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
    // PLUG-IN: user accounts — add cashierId here.
  };

  const ops = [];
  t.lines.forEach(l => {
    l.variant.stock -= l.qty;
    ops.push(opPut('movements', movement(l.product, l.variant, -l.qty, 'sale', `#${fmtNo(number)}`)));
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
  openModal({ title: `Return / exchange · #${fmtNo(sale.number)}`, body: '<div id="retBody"></div>', foot: '<div id="retFoot" class="foot-row"></div>' });
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
    ops.push(opPut('movements', movement(f.product, f.variant, ri.qty, 'return', `CN${fmtNo(ret.number)}`)));
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
    ui.cart.credit = { amount: ret.amount, saleId: sale.id, returnId: ret.id, label: `CN${fmtNo(ret.number)}` };
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

const REASON_LABEL = { sale: 'Sold', return: 'Returned', adjust: 'Adjusted', count: 'Stock count', receive: 'Received', new: 'New product' };

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

/** Report numbers for the last N days (1 = today). Refunds are counted on the day they happen. */
function buildReport(days) {
  const from = startOfDay();
  from.setDate(from.getDate() - (days - 1));
  const sales = state.sales.filter(s => new Date(s.date) >= from);
  const rets = allReturns(from);

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

  return {
    from, sales, rets, gross, refunds, revenue,
    count: sales.length,
    avg: sales.length ? Math.round(gross / sales.length) : 0,
    vat, exVat: revenue - vat, cost, profit: revenue - vat - cost,
    items: sum(sales, s => sum(s.items, it => it.qty)),
    byPayment,
    top: [...top.values()].filter(r => r.qty > 0).sort((a, b) => b.qty - a.qty || b.amount - a.amount).slice(0, 5),
  };
}

/** Money movements for a shift (from the last cash-up until now). */
function computeShift(fromIso, toIso) {
  const from = fromIso ? new Date(fromIso) : new Date(0);
  const to = new Date(toIso);
  const inShift = d => { const x = new Date(d); return x > from && x <= to; };
  const sales = state.sales.filter(s => inShift(s.date));
  const rets = allReturns().filter(x => inShift(x.ret.date));
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
  const z = { id: uid('z'), number: state.meta.nextZNo, ...sh, counted, diff: counted - sh.expected, nextFloat, store: storeSnapshot() };
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
  out.push(center(`No. ${fmtNo(sale.number)}`), center(fmtDT(sale.date)));
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
    sale.returns.forEach(r => out.push(lr(`Returned ${r.number ? 'CN' + fmtNo(r.number) : ''} ${fmtDate(r.date)}`, '-' + money(r.amount))));
  }
  out.push(LINE, ...footerLines());
  return out.join('\n');
}

/** Credit note (VAT vendor) or refund slip for one return. */
function creditNoteText(sale, ret) {
  const st = sale.store || storeSnapshot();
  const registered = st.vatRegistered && sale.vatRate > 0;
  const out = headerLines(st, registered ? 'CREDIT NOTE' : 'REFUND SLIP');
  out.push(center(`No. CN${fmtNo(ret.number)}`), center(fmtDT(ret.date)));
  out.push(center(`For invoice ${fmtNo(sale.number)} of ${fmtDate(sale.date)}`));
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
  const out = headerLines(z.store, `Z-REPORT No. ${fmtNo(z.number)}`);
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
  if (kind === 'sale') { const s = state.sales.find(x => x.id === a); return s && { kind, sale: s, text: receiptText(s), title: `${s.vatRate ? 'Tax invoice' : 'Receipt'} #${fmtNo(s.number)}` }; }
  if (kind === 'ret') {
    const s = state.sales.find(x => x.id === a); const r = s?.returns.find(x => x.id === b);
    return r && { kind, sale: s, ret: r, text: creditNoteText(s, r), title: `${s.vatRate ? 'Credit note' : 'Refund slip'} CN${fmtNo(r.number)}` };
  }
  if (kind === 'z') { const z = state.cashups.find(x => x.id === a); return z && { kind, z, text: zText(z), title: `Z-report #${fmtNo(z.number)}` }; }
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
  window.print();
}

function showDoc(ref, { justSold = false } = {}) {
  const doc = resolveDoc(ref);
  if (!doc) return;
  const s = doc.sale;
  const canReturn = doc.kind === 'sale' && s.status !== 'returned';
  openModal({
    title: (justSold ? 'Sale complete · ' : '') + doc.title,
    body: `
      ${justSold && s.payment === 'cash' ? `<div class="banner info"><p>Change due: <strong class="money">${money(s.change)}</strong></p></div>` : ''}
      ${justSold && s.creditChange ? `<div class="banner info"><p>Pay out unused credit in cash: <strong class="money">${money(s.creditChange)}</strong></p></div>` : ''}
      <pre class="receipt" tabindex="0" aria-label="${esc(doc.title)}">${esc(doc.text)}</pre>
      ${doc.kind === 'ret' ? `<p class="small"><button class="link" data-action="open-doc" data-doc="sale:${esc(s.id)}">View original invoice #${fmtNo(s.number)}</button></p>` : ''}
      ${doc.kind === 'sale' && s.returns.length ? `<p class="small">${s.returns.map(r => `<button class="link" data-action="open-doc" data-doc="ret:${esc(s.id)}:${esc(r.id)}">Credit note CN${fmtNo(r.number)}</button>`).join(' · ')}</p>` : ''}
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
  const blocked = !$('#blocker').hidden;
  const modal = !$('#modal').hidden;
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
  if (state.meta.demo) return false;
  if (!last) return state.sales.length > 0 || state.products.length > 0;
  return daysAgo(last) >= 7;
}

function renderBanners() {
  let html = '';
  if (ui.updateReady) {
    html += `<div class="banner info"><p><strong>A new version is ready.</strong> Reload to start using it — your data is kept.</p>
      <button class="btn sm primary" data-action="apply-update">Reload now</button></div>`;
  }
  if (state.meta.demo) {
    html += `<div class="banner info"><p><strong>Demo data.</strong> These products and sales are samples to try things out.</p>
      <button class="btn sm primary" data-action="start-fresh">Start fresh</button></div>`;
  }
  if (backupOverdue()) {
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
  renderBanners();
  renderSell();
  renderCart();
  if (ui.view === 'stock') renderStock();
  if (ui.view === 'sales') renderSales();
  if (ui.view === 'reports') renderReports();
  if (ui.view === 'settings') renderSettings();
}

function showView(name) {
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
      p.variants.some(v => v.sku.toLowerCase().includes(q))));

  $('#productGrid').innerHTML = list.length ? list.map(p => {
    const stock = productStock(p);
    const badge = stock === 0 ? '<span class="badge out">Out</span>'
      : stock <= low ? `<span class="badge low">${stock} left</span>`
      : `<span class="badge">${stock}</span>`;
    return `<button class="product-card ${stock === 0 ? 'out' : ''}" data-action="pick" data-id="${esc(p.id)}"
        aria-label="${esc(p.name)}, ${esc(priceLabel(p))}, ${stock} in stock">
        <span class="name">${esc(p.name)}</span>
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
    <p class="muted" style="margin:0 0 12px">${esc(p.category)} · <strong class="money">${price != null ? money(price) : esc(priceLabel(p))}</strong></p>
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
  const found = findBySku(input.value);
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
      <div><div><strong>${esc(l.product.name)}</strong></div>
        <div class="meta">${esc(l.variant.size)} / ${esc(l.variant.colour)} · ${money(l.price)} · ${l.variant.stock} in stock</div></div>
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

  const blocked = !t.lines.length || (t.cash && (!Number.isFinite(t.tendered) || t.change < 0));
  $('#chargeBtn').disabled = blocked;
  $('#chargeBtn').textContent = !t.lines.length ? 'Charge'
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
    let variants = p.variants.filter(v => match || v.sku.toLowerCase().includes(q) || `${v.size} ${v.colour}`.toLowerCase().includes(q));
    if (ui.lowOnly) variants = variants.filter(v => v.stock <= low);
    if (!variants.length && (ui.lowOnly || !match)) return '';
    const exVat = p.price - vatFromInclusive(p.price, rate);
    const margin = exVat ? Math.round((exVat - p.cost) / exVat * 100) : 0;
    return `<div class="card">
      <div class="prod-head">
        <div class="info"><h3>${esc(p.name)}</h3>
          <div class="small muted">${esc(p.category)} · Price <strong class="money">${money(p.price)}</strong> · Cost ${money(p.cost)} · Margin ${margin}% · ${productStock(p)} in stock</div></div>
        <div class="actions">
          <button class="btn sm" data-action="receive" data-id="${esc(p.id)}">Receive</button>
          <button class="btn sm" data-action="history" data-id="${esc(p.id)}">History</button>
          <button class="btn sm" data-action="edit-product" data-id="${esc(p.id)}">Edit</button>
          <button class="btn sm" data-action="add-variant" data-id="${esc(p.id)}">+ Variant</button>
        </div>
      </div>
      ${variants.map(v => `
        <div class="var-row ${v.stock === 0 ? 'out' : v.stock <= low ? 'low' : ''}">
          <button class="var-label" data-action="edit-variant" data-id="${esc(v.id)}" aria-label="Edit variant ${esc(v.size)} ${esc(v.colour)}">
            <span class="label"><strong>${esc(v.size)} / ${esc(v.colour)}</strong><span class="state-tag">${v.stock === 0 ? ' · out' : v.stock <= low ? ' · low' : ''}</span></span>
            <span class="sku">${esc(v.sku)}${v.price != null ? ` · <span class="price-tag">${money(v.price)}</span>` : ''}</span>
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
  return { name, category, price, cost };
}

function openAddProduct() {
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
  openModal({
    title: 'Edit product',
    body: productForm(p) + '<p class="small muted">Price changes apply to new sales only. Past receipts keep the price they were sold at. Variants with their own price keep it.</p>',
    foot: `<button class="btn danger" data-action="delete-product" data-id="${esc(id)}">Delete product</button>
      <button class="btn" data-action="close-modal">Cancel</button><button class="btn primary" data-action="ep-save" data-id="${esc(id)}">Save</button>`,
  });
}

async function saveEditProduct(id) {
  const p = findProduct(id);
  const base = p && readProductForm();
  if (!base) return;
  Object.assign(p, base);
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
  } else {
    const nv = { id: uid('v'), size, colour, sku: sku || makeSku(p.name, size, colour), stock: Math.max(0, parseInt($('#vStock').value, 10) || 0) };
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
    fmtNo(s.number).includes(q) || String(s.number) === q ||
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
    <span><strong>#${fmtNo(s.number)}</strong> ${badge}</span>
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
      ${recentZ.length ? `<div class="z-list">${recentZ.map(z => `<button class="link" data-action="open-doc" data-doc="z:${esc(z.id)}">Z${fmtNo(z.number)} · ${fmtDate(z.to)} · ${z.diff === 0 ? 'balanced' : (z.diff > 0 ? 'over ' : 'short ') + money(Math.abs(z.diff))}</button>`).join('')}</div>` : ''}
    </div>`;

  setPressed('[data-action="range"]', b => Number(b.dataset.days) === ui.reportDays);
  const r = buildReport(ui.reportDays);
  const label = ui.reportDays === 1 ? 'Today' : `Last ${ui.reportDays} days`;
  const methods = ['cash', 'card', 'eft', 'credit'].filter(k => k !== 'credit' || r.byPayment.credit.sales || r.byPayment.credit.refunds);
  const maxPay = Math.max(1, ...methods.map(k => r.byPayment[k].sales));
  const vatOn = r.vat !== 0 || effectiveRate() > 0;
  $('#reportBody').innerHTML = `
    <p class="small muted" style="margin:0 0 10px">${label} · from ${fmtDate(r.from.toISOString())} · refunds counted on the day they happen</p>
    <div class="kpis">
      <div class="kpi"><div class="label">Net revenue${vatOn ? ' (incl. VAT)' : ''}</div><div class="value money" data-k="revenue">${money(r.revenue)}</div>
        <div class="sub">${r.refunds ? `${money(r.gross)} sales − ${money(r.refunds)} refunds` : vatOn ? `VAT ${money(r.vat)}` : 'not VAT registered'}</div></div>
      <div class="kpi"><div class="label">Sales</div><div class="value num" data-k="count">${r.count}</div><div class="sub">${r.items} items · ${r.rets.length} refund${r.rets.length === 1 ? '' : 's'}</div></div>
      <div class="kpi"><div class="label">Average basket</div><div class="value money" data-k="avg">${money(r.avg)}</div><div class="sub">per sale</div></div>
      <div class="kpi"><div class="label">Gross profit</div><div class="value money" data-k="profit">${money(r.profit)}</div><div class="sub">${vatOn ? `ex VAT ${money(r.exVat)}` : `revenue ${money(r.revenue)}`} − cost ${money(r.cost)}</div></div>
    </div>
    <div class="report-cols">
      <div>
        <div class="section-title">By payment method</div>
        <div class="card bars">${methods.map(k => {
          const b = r.byPayment[k];
          return `<div class="bar-row"><span>${PAY_LABEL[k] === 'Exchange credit' ? 'Credit' : PAY_LABEL[k]}</span>
            <span class="bar-track" aria-hidden="true"><span class="bar-fill" style="width:${Math.round(b.sales / maxPay * 100)}%"></span></span>
            <span class="money small" data-k="pay-${k}">${money(b.sales - b.refunds)}${b.refunds ? ` <span class="muted">(−${money(b.refunds)})</span>` : ''}</span></div>`;
        }).join('')}
        <p class="small muted" style="margin:6px 0 0">Net of refunds. Cash refunds include unused exchange credit paid out.</p>
        </div>
      </div>
      <div>
        <div class="section-title">Top 5 sellers</div>
        <div class="card">${r.top.length ? `<table class="list-table">${r.top.map((t, i) => `
          <tr><td>${i + 1}. ${esc(t.name)}</td><td>${t.qty} sold · <span class="money">${money(t.amount)}</span></td></tr>`).join('')}</table>`
          : '<div class="muted small">No sales in this period.</div>'}</div>
      </div>
    </div>
    <div class="section-title">Recent sales</div>
    ${r.sales.length ? r.sales.slice().reverse().slice(0, 10).map(saleRow).join('') : '<div class="empty">No sales in this period.</div>'}`;
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
            ${['auto', 'light', 'dark'].map(t => `<option value="${t}" ${st.theme === t ? 'selected' : ''}>${t === 'auto' ? 'Match device' : t[0].toUpperCase() + t.slice(1)}</option>`).join('')}
          </select></label>
      </div>
    </div>
    </div>
    <div>
    <div class="section-title" style="margin-top:0">Data safety</div>
    <div class="card">
      <p style="margin-top:0">Your data is stored <strong>only on this device</strong>. Back up at least once a week and keep the file somewhere else (email it to yourself, Google Drive, WhatsApp to yourself).</p>
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
  const ok = await confirmBox(`Replace ALL data on this device with the backup from ${data.exportedAt ? fmtDate(data.exportedAt) : 'unknown date'} (${data.products.length} products, ${data.sales.length} sales)?`, 'Restore', true);
  if (!ok) return;
  state.settings = { ...DEFAULT_SETTINGS, ...data.settings };
  state.products = data.products;
  state.sales = data.sales.map(normalizeSale);
  state.cashups = data.cashups || [];
  state.meta = { ...DEFAULT_META, ...data.meta };
  // Never reuse a number that already exists.
  state.meta.nextReceiptNo = Math.max(state.meta.nextReceiptNo, ...state.sales.map(s => s.number + 1));
  state.meta.nextCreditNo = Math.max(state.meta.nextCreditNo, ...state.sales.flatMap(s => s.returns.map(r => r.number + 1)));
  state.meta.nextZNo = Math.max(state.meta.nextZNo, ...state.cashups.map(z => z.number + 1));
  ui.cart = emptyCart();
  await persistEverything(data.movements || []);
  restoreCart(ui.cart);
  renderAll();
  toast('Backup restored');
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
      rows.push(['sale', fmtNo(s.number), fmtNo(s.number), fmtDate(s.date), fmtTime(s.date), s.payment,
        cell(it.sku), cell(it.name), cell(it.size), cell(it.colour), it.qty,
        num(it.unitPrice), num(it.unitPrice * it.qty), num(it.unitCost), num(s.total), num(s.vat), s.vatRate, cell(s.customer?.name)].join(','));
    }
    for (const r of s.returns) for (const ri of r.items) {
      const it = s.items[ri.idx];
      rows.push(['refund', 'CN' + fmtNo(r.number), fmtNo(s.number), fmtDate(r.date), fmtTime(r.date), r.method,
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
    : 'Delete ALL products, sales and cash-ups on this device? Make a backup first — this cannot be undone.', 'Start fresh', true);
  if (!ok) return;
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
}

async function loadDemo() {
  if (!(await confirmBox('Replace everything on this device with demo data?', 'Load demo', true))) return;
  loadDemoData();
  await persistEverything();
  restoreCart(ui.cart);
  renderAll();
  toast('Demo data loaded');
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
  await startApp();
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
  range: el => { ui.reportDays = Number(el.dataset.days); renderReports(); },
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
};

function bindEvents() {
  document.addEventListener('click', e => {
    const el = e.target.closest('[data-action]');
    if (!el || el.disabled || el.closest('[inert]')) return;
    const fn = actions[el.dataset.action];
    if (fn) { e.preventDefault(); fn(el, e); }
  });

  $('#sellSearch').addEventListener('input', renderSell);
  $('#sellSearch').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); onSellSearchEnter(); } });
  $('#stockSearch').addEventListener('input', renderStock);
  $('#salesSearch').addEventListener('input', renderSales);
  $('#discountValue').addEventListener('input', e => { ui.cart.discountText = e.target.value; renderTotals(); saveCart(); });
  $('#tendered').addEventListener('input', e => { ui.cart.tenderedText = e.target.value; renderTotals(); saveCart(); });

  document.addEventListener('change', e => {
    const t = e.target;
    if (t.dataset.stockInput) adjustStock(t.dataset.stockInput, t.value === '' ? 0 : t.value, 'count');
    if (t.dataset.setting) onSettingChange(t);
    if (t.id === 'restoreFile' && t.files[0]) { t.files[0].text().then(restoreFromText); t.value = ''; }
  });

  document.addEventListener('input', e => {
    if (e.target.id === 'fSizes' || e.target.id === 'fColours') renderVariantGrid();
    if (e.target.id === 'cuCounted') paintCashupDiff();
  });

  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && $('#blocker').hidden) { if (!$('#modal').hidden) closeModal(); else closeCartSheet(); }
    if (e.key === 'Enter' && !$('#modal').hidden && e.target.tagName === 'INPUT') {
      // Enter in a modal form presses its primary button
      const primary = $('#modal .modal-foot .btn.primary');
      if (primary && !primary.disabled) { e.preventDefault(); primary.click(); }
    }
    // Keyboard access for the "Restore from file" label-button
    if ((e.key === 'Enter' || e.key === ' ') && e.target.matches?.('[data-file-trigger]')) { e.preventDefault(); $('#restoreFile').click(); }
    // Keep Tab inside the modal / sheet (backup for browsers without `inert`)
    if (e.key === 'Tab') {
      const box = !$('#blocker').hidden ? $('#blocker') : !$('#modal').hidden ? $('#modal')
        : ($('#cartPanel').classList.contains('open') && !isWide()) ? $('#cartPanel') : null;
      if (!box) return;
      const items = $$(FOCUSABLE, box).filter(x => x.offsetParent !== null);
      if (!items.length) return;
      const first = items[0], last = items[items.length - 1];
      if (e.shiftKey && (document.activeElement === first || !box.contains(document.activeElement))) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && (document.activeElement === last || !box.contains(document.activeElement))) { e.preventDefault(); first.focus(); }
    }
  });

  // Online / offline indicator
  const net = () => {
    const on = navigator.onLine;
    const el = $('#netStatus');
    el.textContent = on ? 'Online' : 'Offline';
    el.classList.toggle('offline', !on);
    el.title = on ? 'Connected' : 'No internet — everything still works and is saved on this device';
  };
  window.addEventListener('online', net);
  window.addEventListener('offline', net);
  net();

  // Save anything pending when the app is hidden or closed (phone locked, app switched).
  const flush = () => { if (ui.appActive) { flushAllAdjust(); saveCart(true); } };
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flush(); });
  window.addEventListener('pagehide', flush);

  window.matchMedia('(min-width: 860px)').addEventListener('change', () => { closeCartSheet(); updateInert(); });

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
  await startApp();
}

// Handle for tests / debugging in the console.
window.__pos = { state, ui, DB, actions, buildReport, computeShift, receiptText, creditNoteText, zText, cartTotals, flushAllAdjust };

boot();
