/* ==========================================================================
   calculations.js — ALL the maths for Rails Profit checker lives in this one file.
   app.js only draws what this file returns. tests.html checks this file.

   TO USE YOUR REAL EXPORTS: either use the "Match columns" screen in the app
   (saved in your browser), or change the right-hand side of CONFIG.COLUMNS
   below to the exact header text in your CSV (matching ignores upper/lower
   case and extra spaces). Set a column to null if your file doesn't have it —
   the fallbacks noted next to each one kick in.

   HOW PROFIT IS WORKED OUT (per product, for the chosen period and channel):
     Net sales  = sales revenue − refunds on returns
     Fees       = success/referral/payment fees + fulfilment/courier fees
                  − success fees given back on returns
     Stock cost = cost price × units sold − cost price × returned units that could be resold
     Ads        = Sponsored Ads spend
     Profit     = Net sales − Fees − Stock cost − Ads
   Return cost (the "money returns actually cost you") =
       fulfilment fees paid on units that came back  (you never get these back)
     + cost price of returned units that could NOT be resold (written off)
   All fee amounts are VAT-inclusive, as they appear on a statement.

   PER-UNIT VIEW (break-even price, used by the price slider):
     With r = return rate, s = share of returns that can be resold,
     f = fee % of price, fb = fee % given back on a refund,
     ff = fulfilment fee per unit, ad = ad spend per unit sold:
     profit per unit at price P = P(1 − r) − P(f − r·fb) − ff − cost(1 − r·s) − ad
     break-even price           = (ff + cost(1 − r·s) + ad) ÷ ((1 − r) − (f − r·fb))
   ========================================================================== */

const CONFIG = {
  COLUMNS: {
    // One row per product. Needed for cost price (profit can't be worked out without it).
    products: {
      sku: 'sku',
      name: 'product_name',
      cost: 'cost_price',                 // what one unit costs you, rand
      category: 'category',               // optional
      successFeePct: 'success_fee_pct',   // optional: used only if sales file has no success fee column
      fulfilmentFee: 'fulfilment_fee',    // optional: rand per unit incl. VAT, same fallback use
    },
    // One row per product per day (or per order — either works).
    sales: {
      date: 'date',
      sku: 'sku',
      name: 'product_name',
      units: 'units_sold',
      channel: 'channel',                 // optional: else DEFAULT_CHANNEL
      price: 'selling_price',             // optional: used if revenue column is missing
      revenue: 'revenue',
      successFee: 'success_fee',          // optional: else revenue × success_fee_pct × (1 + VAT)
      fulfilmentFee: 'fulfilment_fee',    // optional: else units × product fulfilment_fee
      // Optional extras, so ONE till export can carry everything (Rails POS "Export for Rails Profit checker"):
      unitCost: 'cost_price',             // cost per unit → used when there's no products file
      category: 'category',               // product category
      stockNow: 'stock_on_hand',          // current stock → used when there's no stock file (latest line wins)
      // Lines with NEGATIVE units are refunds: they're counted as returns (put back in stock = resellable).
    },
    // One row per return.
    returns: {
      date: 'date',
      sku: 'sku',
      name: 'product_name',
      units: 'units_returned',
      channel: 'channel',                 // optional: else DEFAULT_CHANNEL
      reason: 'reason',                   // optional
      resellable: 'resellable',           // optional: Yes/No. Missing = treated as NOT resellable
      refund: 'refund_amount',            // optional: else units × average selling price
      successFeeReversed: 'success_fee_reversed', // optional: else refund × success_fee_pct × (1 + VAT)
    },
    // One row per product: stock right now (shared by all channels).
    stock: {
      sku: 'sku',
      name: 'product_name',
      onHand: 'stock_on_hand',
      inbound: 'stock_inbound',           // optional: stock on its way to the warehouse
      cost: 'cost_price',                 // optional: cost per unit → used when there's no products file
      category: 'category',               // optional
      variant: 'variant',                 // optional: size / colour, shown next to the name
    },
    // Optional: Sponsored Ads, one row per product per day.
    ads: {
      date: 'date',
      sku: 'sku',
      name: 'product_name',
      spend: 'ad_spend',
      adSales: 'ad_sales',                // optional: sales the ad platform credits to ads
    },
  },

  // Which fields must be matched for each file (used by the "Match columns" screen)
  REQUIRED: {
    sales: ['date'],                  // plus units or revenue. No SKU column? the product name is used, else one "All sales" product
    returns: ['date', 'sku'],
    stock: ['sku', 'onHand'],
    products: ['sku', 'cost'],
    ads: ['date', 'sku', 'spend'],
  },

  VAT_RATE: 0.15,
  DEFAULT_CHANNEL: 'Takealot',
  ADS_CHANNEL: 'Takealot',      // ads count against this channel when filtering
  RUN_OUT_WARNING_DAYS: 14,     // flag items that run out sooner than this
  LOW_STOCK_UNITS: 3,           // with no per-product sales: "low" = this many units or fewer
  RUN_RATE_DAYS: 28,            // "how fast is it selling" looks at this many recent days
  TARGET_COVER_DAYS: 35,        // "how many to send" aims for this many days of stock
  SLOW_STOCK_DAYS: 90,          // more stock than this many days of sales = slow stock
  BEST_DAY_MIN_LIFT: 0.10,      // best weekday must beat an average day by 10% to count
  // Upcoming sales event. Items are checked against a sales jump of `multiplier`× during it.
  // Update the dates each year. Set to null to hide the check.
  EVENT: { name: 'Black Friday weekend', start: '2026-11-27', end: '2026-11-30', multiplier: 2.5 },
  RESELLABLE_YES: ['yes', 'y', 'true', '1', 'resellable', 'resaleable', 'sellable', 'saleable', 'good', 'new',
                   'as new', 'a grade', 'grade a', 'restocked', 'returned to stock', 'back in stock'],
  CURRENCY: 'R',
};

/** Friendly names for the "Match columns" screen. */
const FIELD_LABELS = {
  date: 'Date', sku: 'SKU / product code', name: 'Product name', units: 'Units',
  channel: 'Sales channel', price: 'Selling price', revenue: 'Revenue (sales value)',
  successFee: 'Success / commission fee', fulfilmentFee: 'Fulfilment / courier fee',
  reason: 'Return reason', resellable: 'Resellable (Yes/No)', refund: 'Refund amount',
  successFeeReversed: 'Success fee given back', onHand: 'Stock on hand', inbound: 'Stock on the way',
  cost: 'Cost price per unit', category: 'Category', successFeePct: 'Success fee %',
  spend: 'Ad spend', adSales: 'Sales from ads', unitCost: 'Cost price per unit', stockNow: 'Stock on hand now', variant: 'Size / colour',
};
const FILE_TYPES = ['sales', 'returns', 'stock', 'products', 'ads'];

/* --------------------------------------------------------------------------
   OTHER NAMES THE SAME COLUMN MIGHT HAVE in real exports. If a file doesn't use
   the name in CONFIG.COLUMNS, these are tried in order. They cover common
   Takealot Seller Portal, Amazon Seller Central, Shopify/WooCommerce and
   spreadsheet wording. They are best guesses, not official Takealot headers.
   Matching ignores case, spaces vs _ - . /, and anything in brackets, so
   "Success Fee (incl. VAT)" matches "success fee".
   Add your own names to the end of a list if a file still isn't recognised.
   -------------------------------------------------------------------------- */
const ALIASES = {
  products: {
    sku: ['seller sku', 'merchant sku', 'your sku', 'sku code', 'product code', 'item code', 'variant sku', 'offer id', 'tsin', 'plid', 'barcode'],
    name: ['product title', 'title', 'product', 'item name', 'description', 'product description'],
    cost: ['cost', 'unit cost', 'cost per unit', 'cost per item', 'cost price incl vat', 'landed cost', 'purchase price', 'buy price', 'cogs'],
    category: ['product category', 'department', 'type', 'product type'],
    successFeePct: ['success fee percentage', 'success fee rate', 'commission rate', 'commission percentage', 'referral fee percentage'],
    fulfilmentFee: ['fulfilment fee per unit', 'fulfillment fee', 'fba fee', 'courier fee'],
  },
  sales: {
    date: ['order date', 'sale date', 'date of sale', 'day', 'order placed', 'created at', 'created', 'purchase date', 'transaction date', 'date created', 'shipped date', 'paid at'],
    sku: ['seller sku', 'merchant sku', 'your sku', 'sku code', 'product code', 'item code', 'lineitem sku', 'variant sku', 'offer id', 'tsin', 'plid'],
    name: ['product title', 'title', 'product', 'item name', 'lineitem name', 'product description', 'description'],
    units: ['qty', 'quantity', 'units', 'qty sold', 'quantity sold', 'units ordered', 'quantity purchased', 'lineitem quantity', 'item quantity', 'number of items', 'items', 'item count', 'no of items', 'sold'],
    channel: ['sales channel', 'marketplace', 'platform', 'source', 'store'],
    price: ['unit price', 'price', 'item price', 'lineitem price', 'price per unit'],
    // (money columns first: in a till report "Sales" is often a count of sales and "Net takings" the money)
    revenue: ['net takings', 'takings', 'net sales amount', 'total', 'sales', 'gross sales', 'total sales', 'sale amount', 'sales amount', 'order total', 'line total', 'item total', 'total selling price', 'product sales', 'amount'],
    successFee: ['success fee amount', 'commission', 'commission fee', 'referral fee', 'selling fee', 'marketplace fee', 'payment fee', 'transaction fee'],
    fulfilmentFee: ['fulfillment fee', 'fulfilment fee amount', 'fba fee', 'fba fees', 'courier fee', 'shipping fee', 'delivery fee', 'courier collection fee'],
    unitCost: ['unit cost', 'cost per unit', 'cost per item', 'cost', 'unit cost price'],
    category: ['product category', 'department'],
    stockNow: ['stock now', 'stock', 'soh', 'in stock', 'qty on hand', 'stock at takealot'],
  },
  returns: {
    date: ['return date', 'date returned', 'returned date', 'date of return', 'return requested', 'return created', 'created at', 'order date'],
    sku: ['seller sku', 'merchant sku', 'your sku', 'sku code', 'product code', 'item code', 'offer id', 'tsin', 'plid'],
    name: ['product title', 'title', 'product', 'item name', 'description'],
    units: ['returned units', 'qty returned', 'quantity returned', 'returned quantity', 'return qty', 'return quantity', 'units returned qty'],
    channel: ['sales channel', 'marketplace', 'platform', 'source', 'store'],
    reason: ['return reason', 'reason for return', 'customer reason', 'return reason description'],
    resellable: ['resaleable', 'sellable', 'saleable', 'condition', 'stock condition', 'can resell', 'restocked', 'disposition'],
    refund: ['refund', 'refunded', 'refund value', 'refunded amount', 'amount refunded', 'refund total', 'credit amount'],
    successFeeReversed: ['success fee refund', 'success fee refunded', 'success fee credit', 'commission refund', 'commission reversed', 'fee refund', 'referral fee refund'],
  },
  stock: {
    sku: ['seller sku', 'merchant sku', 'your sku', 'sku code', 'product code', 'item code', 'variant sku', 'offer id', 'tsin', 'plid'],
    name: ['product title', 'title', 'product', 'item name', 'description'],
    // (plain "Qty" / "Quantity" also counts: a file with a quantity but NO date is a stock list,
    //  e.g. Rails POS "Stock on hand"; dated files are checked as sales first)
    onHand: ['soh', 'stock', 'stock on hand qty', 'qty on hand', 'quantity on hand', 'on hand', 'stock at takealot', 'stock in warehouse', 'warehouse stock', 'available stock', 'stock available', 'available', 'fulfillable quantity', 'afn fulfillable quantity', 'inventory', 'inventory quantity', 'total stock', 'in stock', 'qty in stock', 'qty', 'quantity', 'units'],
    inbound: ['inbound', 'stock in transit', 'in transit', 'on the way', 'incoming', 'inbound quantity', 'stock on order', 'on order', 'afn inbound shipped quantity'],
    cost: ['cost', 'unit cost', 'cost per unit', 'cost per item', 'cost price incl vat', 'landed cost', 'purchase price', 'buy price'],
    category: ['product category', 'department'],
    variant: ['size / colour', 'size colour', 'size and colour', 'size', 'colour', 'color', 'option'],
  },
  ads: {
    date: ['day', 'report date', 'start date'],
    sku: ['seller sku', 'merchant sku', 'advertised sku', 'your sku', 'product code', 'offer id', 'tsin', 'plid'],
    name: ['product title', 'title', 'product', 'advertised product', 'item name', 'campaign name', 'campaign'],
    spend: ['spend', 'ad cost', 'ads spend', 'amount spent', 'total spend', 'cost of ads', 'advertising spend'],
    adSales: ['attributed sales', 'sales from ads', 'ad revenue', 'revenue', 'sales', '7 day total sales', '14 day total sales', 'total sales'],
  },
};
// Very general names, tried last and only once the file type is known (too vague to spot a file type with).
const LAST_RESORT = {
  returns: { units: ['qty', 'quantity', 'units'], resellable: ['status'] },
  products: { name: ['name'] },
  stock: { name: ['name'] },
};

const DEFAULT_COLUMNS = JSON.parse(JSON.stringify(CONFIG.COLUMNS));
let OVERRIDDEN = {};   // type → { field: true } for fields picked on the "Match columns" screen

/** Back to the column names written above (the sample data uses these). */
function resetColumns() {
  for (const type of Object.keys(DEFAULT_COLUMNS)) CONFIG.COLUMNS[type] = { ...DEFAULT_COLUMNS[type] };
  OVERRIDDEN = {};
}

/** Swap in column names chosen on the "Match columns" screen. overrides = { sales: { units: 'Qty' }, ... } */
function applyColumnOverrides(overrides) {
  for (const type of Object.keys(overrides || {})) {
    if (!CONFIG.COLUMNS[type]) continue;
    for (const [field, col] of Object.entries(overrides[type])) {
      if (!(field in CONFIG.COLUMNS[type])) continue;
      CONFIG.COLUMNS[type][field] = col || null;
      (OVERRIDDEN[type] = OVERRIDDEN[type] || {})[field] = true;
    }
  }
}

/* --------------------------------------------------------------------------
   1. Reading CSV text
   -------------------------------------------------------------------------- */

/** Turns CSV text into an array of rows (arrays of strings). Handles quotes, commas or semicolons. */
function parseCSVRows(text) {
  const rows = [];
  let row = [], field = '', inQuotes = false;
  text = text.replace(/^﻿/, '');
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') inQuotes = false;
      else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ',' || c === ';') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some(f => f.trim() !== '')) rows.push(row);
      row = [];
    } else field += c;
  }
  row.push(field);
  if (row.some(f => f.trim() !== '')) rows.push(row);
  return rows;
}

const normHeader = h => String(h).trim().toLowerCase().replace(/\s+/g, ' ');

/** CSV text → { headers, records } where each record maps header → value. */
function parseCSV(text) {
  const rows = parseCSVRows(text);
  if (!rows.length) return { headers: [], records: [] };
  const headers = rows[0].map(normHeader);
  const records = rows.slice(1).map(r => {
    const o = {};
    headers.forEach((h, i) => { o[h] = (r[i] ?? '').trim(); });
    return o;
  });
  return { headers, records };
}

/** Looser version of a header for matching: "Success Fee (incl. VAT)" → "success fee", "units_sold" → "units sold". */
const looseHeader = h => normHeader(h).replace(/\([^)]*\)|\[[^\]]*\]/g, ' ').replace(/[_\-./#:*]+/g, ' ').replace(/\s+/g, ' ').trim();

/**
 * Which of this file's headers holds each field of a file type?
 * Order tried: your "Match columns" choice (used as-is), the CONFIG.COLUMNS name,
 * then ALIASES, then (if lastResort) LAST_RESORT. Each header is used at most once.
 * Returns { field: header-as-in-file or null }.
 */
function columnsFor(type, headers, lastResort = true, records = null) {
  const byLoose = new Map();
  for (const h of headers) if (!byLoose.has(looseHeader(h))) byLoose.set(looseHeader(h), h);
  const used = new Set(), out = {};
  // With the file's rows at hand, a guessed column must also LOOK right (see fitsField)
  const fits = (f, h) => !records || fitsField(f, records, h);
  const pick = (names, f, check) => {
    for (const n of names) {
      const h = n && byLoose.get(looseHeader(n));
      if (h && !used.has(h) && (!check || fits(f, h))) return h;
    }
    return null;
  };
  const fields = Object.keys(CONFIG.COLUMNS[type]);
  // Your own choices and exact config names first, so an alias can't steal their column
  for (const f of fields) {
    out[f] = pick([CONFIG.COLUMNS[type][f]], f, !OVERRIDDEN[type]?.[f]);   // your own choice is never second-guessed
    if (out[f]) used.add(out[f]);
  }
  for (const f of fields) {
    // A "not in my file" choice stays empty. A column you picked that this file doesn't have
    // (e.g. month 2 was exported with other headings) falls back to the usual names.
    if (out[f] || (OVERRIDDEN[type]?.[f] && CONFIG.COLUMNS[type][f] === null)) continue;
    out[f] = pick(ALIASES[type]?.[f] || [], f, true) || (lastResort ? pick(LAST_RESORT[type]?.[f] || [], f, true) : null);
    if (out[f]) used.add(out[f]);
  }
  return out;
}

// What each field should contain, so a guess can be checked against the actual values
const NUMBER_FIELDS = new Set(['units', 'price', 'revenue', 'successFee', 'fulfilmentFee', 'unitCost', 'stockNow', 'refund',
  'successFeeReversed', 'onHand', 'inbound', 'cost', 'successFeePct', 'spend', 'adSales']);
const TEXT_FIELDS = new Set(['name', 'category', 'channel', 'reason']);
/**
 * Does column `h` look right for field `f`? Checks up to 200 filled-in values:
 * dates must mostly read as dates, amounts/quantities mostly as numbers, and names
 * must not be mostly plain numbers. Empty columns pass (nothing to judge).
 */
function fitsField(f, records, h) {
  const vals = [];
  for (const r of records) { const v = r[h]; if (v !== undefined && String(v).trim() !== '') vals.push(String(v).trim()); if (vals.length >= 200) break; }
  if (!vals.length) return true;
  const share = test => vals.filter(test).length / vals.length;
  if (f === 'date') return share(v => !!toISODate(v)) >= 0.6;
  if (NUMBER_FIELDS.has(f)) return share(v => Number.isFinite(toNumber(v))) >= 0.6;
  if (TEXT_FIELDS.has(f)) return share(v => /^[\s\dR.,%()+\-−#]+$/.test(v)) < 0.8;
  return true;
}

/** Works out which kind of file this is from its headers (so upload order doesn't matter). */
function detectFileType(headers) {
  // Dated files (sales, returns, ads) must also have a date column, so a totals table can't pass as sales
  const found = (type, ...fields) => {
    const c = columnsFor(type, headers, false);
    return fields.some(f => c[f]) && (!('date' in c) || !!c.date);
  };
  if (found('returns', 'units', 'reason', 'refund', 'successFeeReversed')) return 'returns';
  if (found('ads', 'spend')) return 'ads';
  if (found('stock', 'onHand') && !found('sales', 'units')) return 'stock';   // a dated sales file may carry a stock column too
  if (found('sales', 'units', 'revenue')) return 'sales';
  if (found('products', 'cost')) return 'products';
  return null;
}

/** Which required columns of a file type are missing from these headers? */
function missingColumns(type, headers) {
  const c = columnsFor(type, headers);
  return CONFIG.REQUIRED[type].filter(f => !c[f]);
}

/** "R 1 234,50" / "1,234.50" / "-12" → number. Empty → NaN. */
function toNumber(v) {
  if (v === undefined || v === null) return NaN;
  let s = String(v).replace(/[R\s ]/gi, '');
  // Marks before or after the number ("1 !" = low stock in Rails POS, "12 units") are ignored;
  // anything in the middle ("24 sales · 0 refunds") still makes it not-a-number.
  s = s.replace(/^[^\d\-−(.]+/, '').replace(/[^\d.)%]+$/, '').replace('−', '-');
  if (s === '') return NaN;
  // "1.234,50" or "1234,50" (comma decimal) → "1234.50"
  if (/,\d{1,2}$/.test(s) && !/\.\d{1,2}$/.test(s)) s = s.replace(/\./g, '').replace(',', '.');
  else s = s.replace(/,/g, '');
  return Number(s);
}

/** "2026-11-22", "22/11/2026" or "2026/11/22" → "2026-11-22" (string keeps it timezone-safe). */
function toISODate(v) {
  const s = String(v || '').trim().replace(/^(?:mon|tue|wed|thu|fri|sat|sun)[a-z]*\.?,?\s+(?=\d)/i, '');   // drop a leading weekday: "Sun, 25 Oct 2026"
  let m = s.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  m = s.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})/);     // SA style: day first
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  m = s.match(/^(\d{1,2})[\s-]([A-Za-z]{3})[A-Za-z]*[\s,-]+(\d{4})/);   // "22 Nov 2026", "22-Nov-2026"
  const mon = m && 'janfebmaraprmayjunjulaugsepoctnovdec'.indexOf(m[2].toLowerCase()) / 3 + 1;
  if (mon >= 1 && Number.isInteger(mon)) return `${m[3]}-${String(mon).padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  return null;
}

/* --------------------------------------------------------------------------
   2. Turning raw CSV records into clean, typed data
   -------------------------------------------------------------------------- */

const ALL_SALES = 'ALL-SALES';   // product code used when a sales file has no product column
const get = (rec, col) => (col ? rec[normHeader(col)] : undefined);
const num = (rec, col) => toNumber(get(rec, col));
const or0 = n => (Number.isFinite(n) ? n : 0);

/**
 * rawFiles = { products, sales, returns, stock, ads } — each { headers, records }, any may be missing.
 * Returns clean data plus a list of warnings to show the user.
 */
function buildDataset(rawFiles) {
  const VAT = CONFIG.VAT_RATE;
  // The actual header in each file for every field (see columnsFor)
  const C = {};
  for (const type of FILE_TYPES) C[type] = rawFiles[type] ? columnsFor(type, rawFiles[type].headers, true, rawFiles[type].records) : {};
  const warnings = [];
  const products = new Map();   // sku → product info

  const ensure = (sku, name) => {
    if (!products.has(sku)) products.set(sku, { sku, name: name || sku, cost: NaN, successFeePct: NaN, fulfilmentFee: NaN });
    const p = products.get(sku);
    if (name && p.name === sku) p.name = name;
    return p;
  };

  for (const r of rawFiles.products?.records || []) {
    const sku = get(r, C.products.sku); if (!sku) continue;
    const p = ensure(sku, get(r, C.products.name));
    p.cost = num(r, C.products.cost);
    p.category = get(r, C.products.category) || '';
    p.successFeePct = num(r, C.products.successFeePct);
    p.fulfilmentFee = num(r, C.products.fulfilmentFee);
  }

  const sales = [];
  let noProductCol = false, costFromSales = false, costFromStock = false;
  const refundLines = [], latestStock = new Map();
  for (const r of rawFiles.sales?.records || []) {
    // No SKU column: use the product name; no name either (e.g. a till's list of sales): one "All sales" product
    let sku = get(r, C.sales.sku) || get(r, C.sales.name);
    const date = toISODate(get(r, C.sales.date));
    if (!sku) { sku = ALL_SALES; noProductCol = true; }
    if (!sku || !date) continue;
    const p = ensure(sku, get(r, C.sales.name) || (sku === ALL_SALES ? 'All sales' : ''));
    const units = or0(num(r, C.sales.units));
    let revenue = num(r, C.sales.revenue);
    if (!Number.isFinite(revenue)) revenue = units * or0(num(r, C.sales.price));
    let successFee = num(r, C.sales.successFee);
    if (!Number.isFinite(successFee)) successFee = revenue * or0(p.successFeePct) / 100 * (1 + VAT);
    let fulfilmentFee = num(r, C.sales.fulfilmentFee);
    if (!Number.isFinite(fulfilmentFee)) fulfilmentFee = units * or0(p.fulfilmentFee);
    const channel = get(r, C.sales.channel) || CONFIG.DEFAULT_CHANNEL;
    // Extras from an all-in-one till export
    const unitCost = num(r, C.sales.unitCost);
    if (Number.isFinite(unitCost) && !rawFiles.products) { p.cost = unitCost; costFromSales = true; }
    if (!p.category && get(r, C.sales.category)) p.category = get(r, C.sales.category);
    const stockNow = num(r, C.sales.stockNow);
    if (Number.isFinite(stockNow) && (!latestStock.has(sku) || latestStock.get(sku).date <= date)) latestStock.set(sku, { date, onHand: stockNow });
    if (units < 0) {
      // A refund line: count it as a return (a till puts refunded items back in stock)
      refundLines.push({ date, sku, channel, units: -units, refund: -revenue, sfBack: Math.max(0, -successFee), resellable: true, reason: 'Refunded at the till' });
      continue;
    }
    sales.push({ date, sku, channel, units, revenue, successFee, fulfilmentFee });
  }

  // Average selling price and fulfilment fee per unit, per product (used for fallbacks)
  const agg = new Map();
  for (const s of sales) {
    const a = agg.get(s.sku) || { units: 0, revenue: 0, ff: 0 };
    a.units += s.units; a.revenue += s.revenue; a.ff += s.fulfilmentFee;
    agg.set(s.sku, a);
  }
  for (const p of products.values()) {
    const a = agg.get(p.sku);
    p.avgPrice = a && a.units ? a.revenue / a.units : 0;
    p.ffPerUnit = a && a.units ? a.ff / a.units : or0(p.fulfilmentFee);
  }

  const returns = [];
  for (const r of rawFiles.returns?.records || []) {
    const sku = get(r, C.returns.sku), date = toISODate(get(r, C.returns.date));
    if (!sku || !date) continue;
    const p = ensure(sku, get(r, C.returns.name));
    const units = or0(num(r, C.returns.units)) || 1;
    let refund = num(r, C.returns.refund);
    if (!Number.isFinite(refund)) refund = units * p.avgPrice;
    let sfBack = num(r, C.returns.successFeeReversed);
    if (!Number.isFinite(sfBack)) sfBack = refund * or0(p.successFeePct) / 100 * (1 + VAT);
    const resellable = CONFIG.RESELLABLE_YES.includes(String(get(r, C.returns.resellable) || '').toLowerCase());
    const channel = get(r, C.returns.channel) || CONFIG.DEFAULT_CHANNEL;
    returns.push({ date, sku, channel, units, refund, sfBack, resellable, reason: get(r, C.returns.reason) || 'Not given' });
  }
  // Refund lines from the sales file count as returns, unless a separate returns file was loaded (no double counting)
  if (!rawFiles.returns) returns.push(...refundLines);

  const ads = [];
  for (const r of rawFiles.ads?.records || []) {
    const sku = get(r, C.ads.sku), date = toISODate(get(r, C.ads.date));
    if (!sku || !date) continue;
    ensure(sku, get(r, C.ads.name));
    ads.push({ date, sku, channel: CONFIG.ADS_CHANNEL, spend: or0(num(r, C.ads.spend)), adSales: or0(num(r, C.ads.adSales)) });
  }

  const stock = new Map();
  const salesSkus = new Set(sales.map(s => s.sku));
  const salesByName = new Map();      // product name (lower case) → sku, for products that sold
  for (const sku of salesSkus) { const p = products.get(sku); if (p && p.name) salesByName.set(p.name.trim().toLowerCase(), sku); }
  for (const r of rawFiles.stock?.records || []) {
    let sku = get(r, C.stock.sku) || get(r, C.stock.name); if (!sku) continue;
    const name = get(r, C.stock.name);
    // A stock list per size/colour (e.g. Rails POS "Stock on hand") whose codes don't match the sales file:
    // add it to the sold product with the same name, so stock and sales line up
    const byName = !salesSkus.has(sku) && name && salesByName.get(name.trim().toLowerCase());
    if (byName) sku = byName;
    const p = ensure(sku, name);
    const onHand = or0(num(r, C.stock.onHand)), cost = num(r, C.stock.cost);
    if (Number.isFinite(cost) && !rawFiles.products && !Number.isFinite(p.cost)) { p.cost = cost; costFromStock = true; }
    if (!p.category && get(r, C.stock.category)) p.category = get(r, C.stock.category);
    if (!byName && get(r, C.stock.variant)) p.variant = get(r, C.stock.variant);
    const prev = byName ? stock.get(sku) : null;    // sizes of one product add up
    stock.set(sku, { onHand: onHand + (prev ? prev.onHand : 0), inbound: or0(num(r, C.stock.inbound)) + (prev ? prev.inbound : 0) });
  }
  if (!rawFiles.stock) for (const [sku, s] of latestStock) stock.set(sku, { onHand: s.onHand, inbound: 0 });
  const salesHaveProducts = sales.some(s => s.sku !== ALL_SALES);

  // Cost warnings only matter for products that actually sold (and only when sales name the products)
  const noCost = [...salesSkus].filter(sku => sku !== ALL_SALES).map(sku => products.get(sku)).filter(p => !Number.isFinite(p.cost));
  if (salesHaveProducts) {
    if (!rawFiles.products && !costFromSales && !costFromStock) warnings.push('No products file (cost prices), so "profit" below is sales minus fees only.');
    else if (noCost.length) warnings.push(`${noCost.length} product(s) have no cost price, so their profit is overstated: ${noCost.map(p => p.name).join(', ')}.`);
  }
  if (rawFiles.sales && !C.sales.units) warnings.push('The sales file has no units column, so units sold show as 0. Money amounts are still counted.');
  if (noProductCol) warnings.push(`The sales file has no product column, so all sales are counted as one product ("All sales")${rawFiles.stock ? ' and stock can\'t be matched to sales' : ''}, and profit can't take off what the stock cost you. For answers per product, load a sales file with one line per product sold (Rails POS: Reports → Export for Profit checker).`);
  if (!sales.length) warnings.push('No sales rows found. Use "Match columns" to point the app at your column names.');
  if (!rawFiles.returns && !refundLines.length) warnings.push('No returns file loaded, so returns are counted as zero.');
  if (!rawFiles.stock && !latestStock.size) warnings.push('No stock file loaded, so run-out dates and reorder amounts can\'t be worked out.');

  const channels = [...new Set(sales.map(s => s.channel))].sort((a, b) =>
    sales.filter(s => s.channel === b).length - sales.filter(s => s.channel === a).length);

  const allDates = sales.map(s => s.date).concat(returns.map(r => r.date)).sort();
  return {
    products, sales, returns, ads, stock, warnings, channels, salesHaveProducts,
    firstDate: allDates[0] || null,
    lastDate: allDates[allDates.length - 1] || null,
  };
}

/* --------------------------------------------------------------------------
   2b. Several files of the same kind (month 1, month 2, a re-upload …)

   Every file you load is kept as a "source". Before the maths runs, all sources
   of one kind are merged into one table with the default column names:
   - Dated files (sales, returns, ads): a row counts once. A row is a duplicate
     when an earlier file already has the same date, product, units and amount.
     Identical rows inside ONE file are all kept (two R449 sales on one day are real);
     only the copies a later file repeats are dropped.
   - Two dated files with DIFFERENT detail that cover the same days (e.g. a till's
     daily takings summary and its full sales list) would count the same sales twice,
     so only the more detailed one is used.
   - Stock and products are a snapshot: per SKU, the latest file wins.
   -------------------------------------------------------------------------- */
const DEDUPE_FIELDS = {
  sales: ['date', 'sku', 'name', 'units', 'revenue', 'price'],
  returns: ['date', 'sku', 'name', 'units', 'refund'],
  ads: ['date', 'sku', 'name', 'spend', 'adSales'],
};
// Fields that describe a dated file's level of detail ("shape")
const SHAPE_FIELDS = ['sku', 'name', 'units', 'revenue', 'price', 'refund', 'spend'];

/** One file → its mapped fields, rows rewritten with the default column names, and its date range. */
function sourceInfo(type, text) {
  const parsed = parseCSV(text);
  const cols = columnsFor(type, parsed.headers, true, parsed.records);
  const fields = Object.keys(cols).filter(f => cols[f]);
  const recs = parsed.records.map(r => {
    const o = {};
    for (const f of fields) o[normHeader(DEFAULT_COLUMNS[type][f])] = r[cols[f]] ?? '';
    return o;
  });
  let from = null, to = null;
  if (cols.date) for (const r of parsed.records) {
    const d = toISODate(r[cols.date]); if (!d) continue;
    if (!from || d < from) from = d;
    if (!to || d > to) to = d;
  }
  return { fields, recs, from, to };
}

/** The "same row?" key: date + product + quantities/amounts, numbers rounded to cents. */
function rowKey(type, rec) {
  return DEDUPE_FIELDS[type].map(f => {
    const v = rec[normHeader(DEFAULT_COLUMNS[type][f])];
    if (v === undefined) return '';
    if (f === 'date') return toISODate(v) || '';
    const n = toNumber(v);
    return Number.isFinite(n) ? n.toFixed(2) : String(v).trim().toLowerCase().replace(/\s+/g, ' ');
  }).join('|');
}

/**
 * sources = [{ id, name, type, text }] in the order they were added.
 * Returns { raw: { type: { headers, records } }, report: [{ id, name, type, rows, added, dupes, updated, skipped, from, to }] }.
 * `raw` uses the DEFAULT column names, so build it with resetColumns() in effect.
 */
function mergeSources(sources) {
  const infos = sources.map(s => sourceInfo(s.type, s.text));
  const report = sources.map((s, i) => ({ id: s.id, name: s.name, type: s.type, rows: infos[i].recs.length,
    added: 0, dupes: 0, updated: 0, skipped: '', from: infos[i].from, to: infos[i].to }));
  const raw = {};
  for (const type of FILE_TYPES) {
    const idx = sources.map((_, i) => i).filter(i => sources[i].type === type);
    if (!idx.length) continue;
    let used = idx;
    if (DEDUPE_FIELDS[type]) {
      // Different detail covering the same days: keep the more detailed file
      const shape = i => SHAPE_FIELDS.filter(f => infos[i].fields.includes(f)).join(',');
      const score = i => infos[i].fields.length * 1e6 + infos[i].recs.length;
      const overlap = (a, b) => a.from && b.from && a.from <= b.to && b.from <= a.to;
      used = [];
      for (const i of [...idx].sort((a, b) => score(b) - score(a) || a - b)) {
        const clash = used.find(j => shape(j) !== shape(i) && overlap(infos[i], infos[j]));
        if (clash !== undefined) report[i].skipped = `covers the same days as "${sources[clash].name}", which has more detail`;
        else used.push(i);
      }
      used.sort((a, b) => a - b);
    }
    const present = new Set(used.flatMap(i => infos[i].fields));
    const headers = Object.keys(DEFAULT_COLUMNS[type]).filter(f => present.has(f)).map(f => normHeader(DEFAULT_COLUMNS[type][f]));
    let records = [];
    if (DEDUPE_FIELDS[type]) {
      const seen = new Map();          // row key → how many copies are already in
      for (const i of used) {
        const mine = new Map();
        for (const rec of infos[i].recs) {
          const k = rowKey(type, rec), n = mine.get(k) || 0;
          mine.set(k, n + 1);
          if (n < (seen.get(k) || 0)) { report[i].dupes++; continue; }
          records.push(rec); report[i].added++;
        }
        for (const [k, n] of mine) seen.set(k, Math.max(seen.get(k) || 0, n));
      }
    } else {
      const skuCol = normHeader(DEFAULT_COLUMNS[type].sku), bySku = new Map();
      for (const i of used) for (const rec of infos[i].recs) {
        const sku = String(rec[skuCol] || '').trim(); if (!sku) continue;
        const prev = bySku.get(sku);
        if (prev && JSON.stringify(prev) === JSON.stringify(rec)) report[i].dupes++;
        else if (prev) report[i].updated++;
        else report[i].added++;
        bySku.set(sku, rec);
      }
      records = [...bySku.values()];
    }
    raw[type] = { headers, records };
  }
  return { raw, report };
}

/** Same dataset, only one sales channel. Stock is shared, so it is never filtered. */
function filterChannel(data, channel) {
  if (!channel || channel === 'all') return data;
  return {
    ...data,
    sales: data.sales.filter(s => s.channel === channel),
    returns: data.returns.filter(r => r.channel === channel),
    ads: data.ads.filter(a => a.channel === channel),
  };
}

/* --------------------------------------------------------------------------
   3. Dates and periods. "Today" = the latest date in YOUR data, not the
      computer's clock, so an old export still makes sense.
   -------------------------------------------------------------------------- */

const MS_DAY = 86400000;
const parseISO = s => new Date(s + 'T00:00:00Z');
const toISO = d => d.toISOString().slice(0, 10);
const addDays = (iso, n) => toISO(new Date(parseISO(iso).getTime() + n * MS_DAY));
const daysBetween = (a, b) => Math.round((parseISO(b) - parseISO(a)) / MS_DAY) + 1; // inclusive
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const shortDate = iso => { const d = parseISO(iso); return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`; };

const PERIODS = {
  last7:     { label: 'Last 7 days' },
  last30:    { label: 'Last 30 days' },
  thisMonth: { label: 'This month' },
  lastMonth: { label: 'Last month' },
  all:       { label: 'All data' },
  custom:    { label: 'Custom range' },
};

/**
 * Returns { start, end, label, phrase, range, days } for a period key.
 * key 'custom' uses custom = { start: 'YYYY-MM-DD', end: 'YYYY-MM-DD' } (picked on the page).
 * phrase reads in a sentence: "in the last 30 days".
 */
function getPeriod(key, data, custom) {
  const end = data.lastDate;
  let start, phrase, last = end;
  const d = parseISO(end);
  if (key === 'custom' && custom && custom.start && custom.end) {
    start = custom.start < custom.end ? custom.start : custom.end;
    last = custom.start < custom.end ? custom.end : custom.start;
    if (last > end) last = end;
    phrase = `from ${shortDate(start)} to ${shortDate(last)}`;
  }
  else if (key === 'last7') { start = addDays(end, -6); phrase = 'in the last 7 days'; }
  else if (key === 'thisMonth') { start = toISO(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1))); phrase = 'this month'; }
  else if (key === 'lastMonth') {
    start = toISO(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, 1)));
    last = toISO(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 0)));
    phrase = 'last month';
  }
  else if (key === 'all') { start = data.firstDate; phrase = 'across all your data'; }
  else { start = addDays(end, -29); phrase = 'in the last 30 days'; key = 'last30'; }
  if (start < data.firstDate) start = data.firstDate;
  if (start > last) start = last;
  return {
    key, start, end: last, phrase,
    label: PERIODS[key].label,
    range: `${shortDate(start)} – ${shortDate(last)} ${parseISO(last).getUTCFullYear()}`,
    days: daysBetween(start, last),
  };
}

const inPeriod = (date, p) => date >= p.start && date <= p.end;

/* --------------------------------------------------------------------------
   4. Per-product numbers for a period (see the formulas at the top)
   -------------------------------------------------------------------------- */

function productSummary(data, period) {
  const rows = new Map();
  const row = sku => {
    if (!rows.has(sku)) {
      const p = data.products.get(sku);
      rows.set(sku, {
        sku, name: p.name, cost: or0(p.cost),
        units: 0, gross: 0, refunds: 0, successFees: 0, fulfilmentFees: 0, sfBack: 0,
        stockCost: 0, returnedUnits: 0, resellableUnits: 0, writtenOffUnits: 0, returnCost: 0,
        adSpend: 0, adSales: 0, reasons: {},
      });
    }
    return rows.get(sku);
  };
  for (const s of data.sales) {
    if (!inPeriod(s.date, period)) continue;
    const r = row(s.sku);
    r.units += s.units; r.gross += s.revenue;
    r.successFees += s.successFee; r.fulfilmentFees += s.fulfilmentFee;
    r.stockCost += s.units * r.cost;
  }
  for (const x of data.returns) {
    if (!inPeriod(x.date, period)) continue;
    const r = row(x.sku), p = data.products.get(x.sku);
    r.refunds += x.refund; r.sfBack += x.sfBack; r.returnedUnits += x.units;
    if (x.resellable) { r.stockCost -= x.units * r.cost; r.resellableUnits += x.units; }   // back on the shelf
    else r.writtenOffUnits += x.units;
    r.returnCost += x.units * p.ffPerUnit + (x.resellable ? 0 : x.units * r.cost);
    r.reasons[x.reason] = (r.reasons[x.reason] || 0) + x.units;
  }
  for (const a of data.ads) {
    if (!inPeriod(a.date, period)) continue;
    const r = row(a.sku);
    r.adSpend += a.spend; r.adSales += a.adSales;
  }
  for (const r of rows.values()) {
    r.netSales = r.gross - r.refunds;
    r.fees = r.successFees + r.fulfilmentFees - r.sfBack;
    r.profit = r.netSales - r.fees - r.stockCost - r.adSpend;
    r.margin = r.netSales > 0 ? r.profit / r.netSales : 0;
    r.feeShare = r.netSales > 0 ? r.fees / r.netSales : 0;
    r.netUnits = r.units - r.returnedUnits;
    r.returnRate = r.units > 0 ? r.returnedUnits / r.units : 0;
    r.roas = r.adSpend > 0 ? r.adSales / r.adSpend : 0;
    // What the ads earned after fees and stock cost, minus what they cost
    const marginBeforeAds = r.netSales > 0 ? (r.profit + r.adSpend) / r.netSales : 0;
    r.adProfit = r.adSales * marginBeforeAds - r.adSpend;
  }
  return [...rows.values()];
}

function totals(rows) {
  const t = { gross: 0, refunds: 0, netSales: 0, fees: 0, successFees: 0, fulfilmentFees: 0, sfBack: 0, profit: 0,
    returnCost: 0, returnedUnits: 0, units: 0, adSpend: 0, adSales: 0 };
  for (const r of rows) for (const k in t) t[k] += r[k];
  t.margin = t.netSales > 0 ? t.profit / t.netSales : 0;
  return t;
}

/* --------------------------------------------------------------------------
   5. Price slider maths — profit per unit at any price, and break-even price.
      Uses this product's own return rate, fees and ads for the period.
   -------------------------------------------------------------------------- */

function unitEconomics(row, product) {
  if (!row || row.units <= 0) return null;
  const price = row.gross / row.units;
  const r = Math.min(row.returnedUnits / row.units, 0.9);
  const s = row.returnedUnits > 0 ? row.resellableUnits / row.returnedUnits : 0;
  const f = row.gross > 0 ? row.successFees / row.gross : 0;
  const fb = row.refunds > 0 ? row.sfBack / row.refunds : f;
  const ff = row.fulfilmentFees / row.units;
  const ad = row.adSpend / row.units;
  const cost = or0(product && product.cost);
  const fixed = ff + cost * (1 - r * s) + ad;           // costs that don't change with price
  const keep = (1 - r) - (f - r * fb);                   // share of the price you keep
  const profitAt = P => P * keep - fixed;
  return {
    price, cost, returnRate: r, resellShare: s, feePct: f, ffPerUnit: ff, adPerUnit: ad,
    profitAt,
    marginAt: P => (P * (1 - r) > 0 ? profitAt(P) / (P * (1 - r)) : 0),
    breakEven: keep > 0 ? fixed / keep : Infinity,
    profitPerUnit: profitAt(price),
  };
}

/* --------------------------------------------------------------------------
   6. Weekdays — uses the chosen range if it is at least WEEKDAY_MIN_DAYS long,
      otherwise ALL data (one week is too little to see a pattern).
      Averages per calendar day, so a range with 27 Sundays and 26 Saturdays
      is still a fair fight. Profit here is before returns and ads.
   -------------------------------------------------------------------------- */

const WEEKDAY_MIN_DAYS = 28;

function weekdayStats(data, start = data.firstDate, end = data.lastDate) {
  const out = WEEKDAYS.map((name, i) => ({ name, short: name.slice(0, 3), index: i, days: 0, sales: 0, profit: 0 }));
  if (!start) return out;
  for (let d = start; d <= end; d = addDays(d, 1)) out[parseISO(d).getUTCDay()].days++;
  for (const s of data.sales) {
    if (s.date < start || s.date > end) continue;
    const w = out[parseISO(s.date).getUTCDay()];
    const cost = or0(data.products.get(s.sku).cost);
    w.sales += s.revenue;
    w.profit += s.revenue - s.successFee - s.fulfilmentFee - s.units * cost;
  }
  for (const w of out) { w.avgSales = w.days ? w.sales / w.days : 0; w.avgProfit = w.days ? w.profit / w.days : 0; }
  return out;
}

/** Net sales (and units) per day for trend lines. Pass sku for one product. */
function dailySeries(data, period, sku) {
  const byDay = new Map();
  for (let d = period.start; d <= period.end; d = addDays(d, 1)) byDay.set(d, { netSales: 0, units: 0 });
  for (const s of data.sales) if (byDay.has(s.date) && (!sku || s.sku === sku)) { const x = byDay.get(s.date); x.netSales += s.revenue; x.units += s.units; }
  for (const r of data.returns) if (byDay.has(r.date) && (!sku || r.sku === sku)) byDay.get(r.date).netSales -= r.refund;
  return [...byDay].map(([date, v]) => ({ date, label: shortDate(date), ...v }));
}

/* --------------------------------------------------------------------------
   7. Stock plan — run-out, how many to send, slow stock, sales-event check.
      Uses ALL channels (stock is shared) and the last RUN_RATE_DAYS days.
   -------------------------------------------------------------------------- */

function stockPlan(data) {
  const from = addDays(data.lastDate, -(CONFIG.RUN_RATE_DAYS - 1));
  const units = new Map();
  for (const s of data.sales) if (s.date >= from) units.set(s.sku, (units.get(s.sku) || 0) + s.units);
  const ev = CONFIG.EVENT && CONFIG.EVENT.end > data.lastDate ? CONFIG.EVENT : null;
  const list = [];
  for (const [sku, st] of data.stock) {
    const p = data.products.get(sku);
    const perDay = (units.get(sku) || 0) / CONFIG.RUN_RATE_DAYS;
    const daysLeft = perDay > 0 ? st.onHand / perDay : Infinity;
    const sendUnits = Math.max(0, Math.ceil(perDay * CONFIG.TARGET_COVER_DAYS - st.onHand - st.inbound));
    const stockValue = st.onHand * or0(p.cost);
    const excessUnits = Math.max(0, st.onHand - perDay * CONFIG.TARGET_COVER_DAYS);
    let eventShort = 0, eventNeed = 0;
    if (ev) {
      const start = ev.start > data.lastDate ? ev.start : addDays(data.lastDate, 1);
      const normalDays = daysBetween(addDays(data.lastDate, 1), start) - 1;
      const eventDays = daysBetween(start, ev.end);
      eventNeed = Math.ceil(perDay * normalDays + perDay * ev.multiplier * eventDays);
      eventShort = Math.max(0, eventNeed - st.onHand - st.inbound);
    }
    list.push({ sku, name: p.name, onHand: st.onHand, inbound: st.inbound, perDay, daysLeft, sendUnits,
      stockValue, excessUnits, excessValue: excessUnits * or0(p.cost), eventNeed, eventShort });
  }
  return list.sort((a, b) => a.daysLeft - b.daysLeft);
}

/* --------------------------------------------------------------------------
   8. Formatting helpers
   -------------------------------------------------------------------------- */

/** 1234.5 → "R1,235". Negative → "−R1,235". */
function formatRand(n, decimals = 0) {
  const sign = n < 0 ? '−' : '';
  const s = Math.abs(n).toFixed(decimals).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${sign}${CONFIG.CURRENCY}${s}`;
}
const pct = (x, d = 0) => `${(x * 100).toFixed(d)}%`.replace('-', '−');
/** ["a","b","c"] → "a, b and c" */
const joinNames = list => list.length <= 1 ? (list[0] || '') : `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}`;
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const topReason = r => {
  const e = Object.entries(r.reasons).sort((a, b) => b[1] - a[1])[0];
  return e ? { reason: e[0], share: e[1] / r.returnedUnits } : null;
};
const fmtDays = d => (Number.isFinite(d) ? `${Math.floor(d)} days` : 'no recent sales');

/* --------------------------------------------------------------------------
   9. The findings. The first five are the main answers; the rest go under
      "Also worth knowing". Each = { id, tone, headline, detail, action, items, extra }
      tone: 'bad' | 'warn' | 'good' | 'info'
      opts = { key, custom, channel }
   -------------------------------------------------------------------------- */

function buildFindings(fullData, opts = {}) {
  const data = filterChannel(fullData, opts.channel);
  const period = getPeriod(opts.key, fullData, opts.custom);
  const rows = productSummary(data, period);
  const t = totals(rows);
  const plan = fullData.stock.size ? stockPlan(fullData) : [];
  const planBySku = new Map(plan.map(s => [s.sku, s]));
  const econ = new Map(rows.map(r => [r.sku, unitEconomics(r, fullData.products.get(r.sku))]));
  const f = [];

  // Same-length period just before this one, for the "vs previous" arrows (null if no data that far back)
  const prevStart = addDays(period.start, -period.days), prevEnd = addDays(period.start, -1);
  const prev = prevStart >= fullData.firstDate ? totals(productSummary(data, { start: prevStart, end: prevEnd })) : null;

  // 1 — Loss-makers
  const losers = rows.filter(r => r.profit < 0).sort((a, b) => a.profit - b.profit);
  if (losers.length) {
    const lossTotal = losers.reduce((s, r) => s + r.profit, 0);
    const worst = losers[0], e = econ.get(worst.sku);
    f.push({
      id: 'losers', tone: 'bad',
      headline: `${plural(losers.length, 'product', 'products')} lost you money ${period.phrase}: ${joinNames(losers.map(r => r.name))} — ${formatRand(-lossTotal)} in total.`,
      items: losers.map(r => {
        const be = econ.get(r.sku);
        return `${r.name}: ${formatRand(r.profit)} on ${formatRand(r.netSales)} of sales${be && Number.isFinite(be.breakEven) ? ` — breaks even at ${formatRand(Math.ceil(be.breakEven))} (now ${formatRand(be.price)})` : ''}`;
      }),
      action: e && Number.isFinite(e.breakEven)
        ? `Tap ${worst.name} in the table to try a new price. It needs at least ${formatRand(Math.ceil(e.breakEven))} to stop losing money, or a lower cost or fewer returns.`
        : 'Check the cost price and return rate on these.',
    });
  } else {
    const thin = rows.filter(r => r.netSales > 0).sort((a, b) => a.margin - b.margin)[0];
    f.push({
      id: 'losers', tone: 'good',
      headline: `No product lost money ${period.phrase}.`,
      detail: thin ? `Thinnest margin: ${thin.name} at ${pct(thin.margin)} (${formatRand(thin.profit)} profit).` : '',
      action: thin && thin.margin < 0.08 ? `Keep an eye on ${thin.name} — one bad batch of returns would tip it into a loss.` : '',
    });
  }

  // 2 — Returns
  const culprits = rows.filter(r => r.returnedUnits > 0).sort((a, b) => b.returnCost - a.returnCost);
  if (culprits.length) {
    const c = culprits[0], why = topReason(c);
    f.push({
      id: 'returns', tone: t.returnCost > t.profit * 0.15 ? 'bad' : 'warn',
      headline: `Returns cost you ${formatRand(t.returnCost)} ${period.phrase} — biggest culprit: ${c.name} (${formatRand(c.returnCost)}).`,
      detail: `${plural(t.returnedUnits, 'unit', 'units')} came back and ${formatRand(t.refunds)} was refunded. The ${formatRand(t.returnCost)} is fulfilment fees paid for nothing plus stock that couldn't be resold.`
        + (why ? ` ${c.name}: ${c.returnedUnits} returned (${pct(c.returnRate)} of sales), mostly "${why.reason}" (${pct(why.share)}).` : ''),
      action: why && /defect|damag/i.test(why.reason)
        ? `"${why.reason}" is a supplier or packaging problem — raise it with your supplier before reordering.`
        : `Check the listing photos and description for ${c.name} — "${why ? why.reason : 'returns'}" usually means expectations don't match.`,
    });
  } else {
    f.push({ id: 'returns', tone: 'good', headline: `No returns ${period.phrase}.`, detail: '', action: '' });
  }

  // 3 — Fees
  const feeRows = rows.filter(r => r.netSales > 0).sort((a, b) => b.feeShare - a.feeShare);
  const share = t.netSales > 0 ? t.fees / t.netSales : 0;
  if (feeRows.length && t.fees < 0.005) {
    // e.g. till (in-store) sales: no marketplace fees at all
    f.push({ id: 'fees', tone: 'good', headline: `No selling fees ${period.phrase} — every rand of these sales is yours before stock cost.`,
      detail: 'Your files have no marketplace, commission or courier fees (normal for in-store till sales).', action: '' });
  } else if (feeRows.length) {
    const h = feeRows[0];
    const mostlyFulfil = h.fulfilmentFees > h.successFees;
    f.push({
      id: 'fees', tone: share > 0.25 ? 'warn' : 'info',
      headline: `Fees took ${formatRand(t.fees)} (${pct(share)} of sales) — highest on ${h.name} (${pct(h.feeShare)} of its sales).`,
      detail: `Success/commission fees ${formatRand(t.successFees - t.sfBack)}, fulfilment/courier fees ${formatRand(t.fulfilmentFees)}, incl. VAT.`,
      action: mostlyFulfil
        ? `On ${h.name} it's mostly the fulfilment fee (size tier). A higher price or a bundle spreads that fixed fee over more rand.`
        : `On ${h.name} it's mostly the success fee, which is set by category — price is your lever.`,
    });
  } else {
    f.push({ id: 'fees', tone: 'info', headline: `No sales ${period.phrase}, so no fees.`, detail: '', action: '' });
  }

  // 4 — Stock running out (always the latest stock file and all channels, not the period)
  if (plan.length && !fullData.salesHaveProducts) {
    // Stock list but sales without products: can't work out days left, so describe the stock itself
    const units = plan.reduce((a, s) => a + Math.max(0, s.onHand), 0);
    const value = plan.reduce((a, s) => a + s.stockValue, 0);
    const out = plan.filter(s => s.onHand <= 0), low = plan.filter(s => s.onHand > 0 && s.onHand <= CONFIG.LOW_STOCK_UNITS);
    // sizes share a name, so show the size/colour (or the code)
    const nm = s => { const v = fullData.products.get(s.sku)?.variant; return s.name && s.name !== s.sku ? `${s.name} (${v || s.sku})` : s.sku; };
    f.push({
      id: 'stock', tone: out.length ? 'warn' : 'info',
      headline: `${units.toLocaleString('en')} units in stock${value > 0 ? `, worth ${formatRand(value)} at cost` : ''}. ${plural(out.length, 'line is', 'lines are')} out of stock and ${low.length} ${low.length === 1 ? 'is' : 'are'} low (${CONFIG.LOW_STOCK_UNITS} or fewer).`,
      items: out.concat(low).slice(0, 12).map(s => `${nm(s)}: ${s.onHand <= 0 ? 'out of stock' : `${s.onHand} left`}`),
      action: 'Your sales file has no products, so it can\'t say how fast each one sells or when it runs out. For that, load sales with one line per product (Rails POS: Reports → Export for Profit checker).',
    });
  } else if (plan.length) {
    const soon = plan.filter(s => s.daysLeft < CONFIG.RUN_OUT_WARNING_DAYS);
    const label = s => s.onHand <= 0 ? `${s.name} (out of stock)` : `${s.name} (${Math.floor(s.daysLeft)} days)`;
    if (soon.length) {
      f.push({
        id: 'stock', tone: 'bad',
        headline: `${soon.length === 1 ? 'This item runs' : 'These items run'} out in under ${CONFIG.RUN_OUT_WARNING_DAYS} days: ${joinNames(soon.map(label))}.`,
        items: soon.map(s => `${s.name}: ${s.onHand} left, selling ~${s.perDay.toFixed(1)}/day${s.inbound ? `, ${s.inbound} on the way` : ''} → send ${s.sendUnits} units`),
        action: `Send the amounts above — that covers about ${CONFIG.TARGET_COVER_DAYS} days of sales. Allow for the warehouse to receive it.`,
      });
    } else {
      const next = plan.find(s => Number.isFinite(s.daysLeft));
      f.push({
        id: 'stock', tone: 'good',
        headline: `Nothing runs out in the next ${CONFIG.RUN_OUT_WARNING_DAYS} days.`,
        detail: next ? `Lowest cover: ${next.name}, about ${Math.floor(next.daysLeft)} days left.` : '', action: '',
      });
    }
  } else {
    f.push({ id: 'stock', tone: 'info', headline: 'Load a stock file to see what\'s about to run out.', detail: '', action: '' });
  }

  // 5 — Best weekday to promote
  const wdAll = period.days < WEEKDAY_MIN_DAYS;
  const wdStart = wdAll ? fullData.firstDate : period.start, wdEnd = wdAll ? fullData.lastDate : period.end;
  const wd = weekdayStats(data, wdStart, wdEnd);
  const avg = wd.reduce((s, w) => s + w.avgProfit, 0) / 7;
  const sorted = [...wd].sort((a, b) => b.avgProfit - a.avgProfit);
  const best = sorted[0], worstDay = sorted[6];
  const lift = avg > 0 ? best.avgProfit / avg - 1 : 0;
  const weeks = Math.floor(daysBetween(wdStart, wdEnd) / 7);
  if (lift >= CONFIG.BEST_DAY_MIN_LIFT) {
    const dayBefore = WEEKDAYS[(best.index + 6) % 7];
    f.push({
      id: 'weekday', tone: 'good',
      headline: `Your best day to promote is ${best.name}.`,
      detail: `An average ${best.name} brings ${formatRand(best.avgProfit)} profit — ${pct(lift)} more than a typical day. Weakest: ${worstDay.name}. Based on ${weeks} weeks${wdAll ? ' (all data — the chosen range is too short to judge weekdays)' : ''}.`,
      action: `Set deals and ads to go live ${dayBefore} evening so they run all of ${best.name}.`,
    });
  } else {
    f.push({
      id: 'weekday', tone: 'info',
      headline: 'No single day stands out for promotions.',
      detail: `${best.name} is best, but only ${pct(lift)} above a typical day (based on ${weeks} weeks).`,
      action: 'Payday weeks and events will matter more than the weekday.',
    });
  }

  // ---- Also worth knowing ----

  // 6 — Upcoming sales event (Black Friday)
  const ev = CONFIG.EVENT && CONFIG.EVENT.end > fullData.lastDate ? CONFIG.EVENT : null;
  if (ev && plan.length && fullData.salesHaveProducts) {
    const short = plan.filter(s => s.eventShort > 0).sort((a, b) => b.eventShort - a.eventShort);
    const when = `${shortDate(ev.start)}–${shortDate(ev.end)}`;
    f.push(short.length ? {
      id: 'event', tone: 'bad', extra: true,
      headline: `${ev.name} (${when}): ${plural(short.length, 'item', 'items')} will sell out if sales jump ${ev.multiplier}×.`,
      items: short.map(s => `${s.name}: need ~${s.eventNeed}, have ${s.onHand}${s.inbound ? ` + ${s.inbound} on the way` : ''} → short ${s.eventShort}`),
      action: 'Book deliveries for the shortfalls now — warehouses get slow just before big sales days.',
    } : {
      id: 'event', tone: 'good', extra: true,
      headline: `${ev.name} (${when}): your stock can handle a ${ev.multiplier}× jump in sales.`,
      detail: '', action: '',
    });
  }

  // 7 — Slow stock (cash tied up) — needs sales per product, otherwise everything would look "slow"
  if (plan.length && fullData.salesHaveProducts) {
    const slow = plan.filter(s => s.daysLeft > CONFIG.SLOW_STOCK_DAYS && s.onHand > 0).sort((a, b) => b.excessValue - a.excessValue);
    if (slow.length) {
      const tied = slow.reduce((s, x) => s + x.excessValue, 0);
      f.push({
        id: 'slow', tone: 'warn', extra: true,
        headline: `${formatRand(tied)} is tied up in slow stock: ${joinNames(slow.slice(0, 3).map(s => `${s.name} (${fmtDays(s.daysLeft)} of stock)`))}${slow.length > 3 ? ` and ${slow.length - 3} more` : ''}.`,
        detail: `That's the cost of stock beyond ${CONFIG.TARGET_COVER_DAYS} days of sales. Large slow stock can also attract storage fees.`,
        action: `Don't reorder these yet. Consider a promotion on ${slow[0].name}, or pull some stock back.`,
      });
    }
  }

  // 8 — Ads
  if (t.adSpend > 0) {
    const adRows = rows.filter(r => r.adSpend > 0).sort((a, b) => a.adProfit - b.adProfit);
    const losing = adRows.filter(r => r.adProfit < 0);
    const w = adRows[0];
    f.push({
      id: 'ads', tone: losing.length ? 'warn' : 'good', extra: true,
      headline: `Ads cost ${formatRand(t.adSpend)} and brought in ${formatRand(t.adSales)} of sales (${formatRand(t.adSales / t.adSpend, 2)} back per R1)${losing.length ? ` — ads on ${joinNames(losing.map(r => r.name))} lost money` : ''}.`,
      items: adRows.map(r => `${r.name}: spent ${formatRand(r.adSpend)}, ${formatRand(r.roas, 2)} back per R1 → ${r.adProfit < 0 ? 'lost' : 'made'} ${formatRand(Math.abs(r.adProfit))} after fees and stock cost`),
      action: losing.length
        ? `Cut bids or pause ads on ${w.name}. At ${formatRand(w.roas, 2)} per R1 the sales don't cover the fees and stock cost.`
        : 'Your ads pay for themselves. Consider raising budget on the best one.',
    });
  }

  // Product table (one row per product with everything in it)
  const table = rows.map(r => {
    const s = planBySku.get(r.sku), e = econ.get(r.sku);
    return { ...r, daysLeft: s ? s.daysLeft : null, sendUnits: s ? s.sendUnits : null, onHand: s ? s.onHand : null,
      breakEven: e ? e.breakEven : null, price: e ? e.price : null };
  });

  return {
    period, rows, table, totals: t, prev, findings: f, weekdays: wd, plan, econ,
    weekdayBasis: { weeks, allData: wdAll, best: best.index },
    daily: dailySeries(data, period),
    channel: opts.channel || 'all',
  };
}

/** Everything the product detail panel needs for one product. */
function productDetail(fullData, opts, sku) {
  const res = buildFindings(fullData, opts);
  const data = filterChannel(fullData, opts.channel);
  const row = res.rows.find(r => r.sku === sku);
  return {
    product: fullData.products.get(sku), row, econ: res.econ.get(sku),
    stock: res.plan.find(s => s.sku === sku) || null,
    daily: dailySeries(data, res.period, sku), period: res.period,
  };
}

/* --------------------------------------------------------------------------
   10. Weekly WhatsApp message — always the last 7 days, all channels
   -------------------------------------------------------------------------- */

function buildWhatsAppText(data) {
  const { period, totals: t, findings } = buildFindings(data, { key: 'last7' });
  const by = id => findings.find(x => x.id === id);
  const short = s => s.replace(/ in the last 7 days/, '');
  const lines = [
    `*Rails Profit checker — ${period.range}*`,
    `Sales ${formatRand(t.netSales)} · Profit ${formatRand(t.profit)} (${pct(t.margin)})`,
    '',
    `${by('losers').tone === 'bad' ? '🔴' : '✅'} ${short(by('losers').headline)}`,
    `↩️ ${short(by('returns').headline)}`,
    `💸 ${short(by('fees').headline)}`,
    `📦 ${by('stock').headline}`,
    `📅 ${by('weekday').headline}`,
  ];
  if (by('event') && by('event').tone === 'bad') lines.push(`🛍️ ${by('event').headline}`);
  const todo = by('stock').tone === 'bad' ? 'Restock the items above' : by('losers').action;
  if (todo) lines.push('', `👉 To do: ${todo}`);
  return lines.join('\n');
}

/* --------------------------------------------------------------------------
   11. CSV export of the product table (for your accountant)
   -------------------------------------------------------------------------- */

function tableToCSV(table, period) {
  const cols = [
    ['Product', r => r.name], ['SKU', r => r.sku], ['Units sold', r => r.units], ['Units returned', r => r.returnedUnits],
    ['Net sales', r => r.netSales.toFixed(2)], ['Fees', r => r.fees.toFixed(2)], ['Stock cost', r => r.stockCost.toFixed(2)],
    ['Ad spend', r => r.adSpend.toFixed(2)], ['Profit', r => r.profit.toFixed(2)], ['Margin %', r => (r.margin * 100).toFixed(1)],
    ['Avg price', r => (r.price ?? 0).toFixed(2)], ['Break-even price', r => (Number.isFinite(r.breakEven) ? r.breakEven.toFixed(2) : '')],
    ['Stock on hand', r => r.onHand ?? ''], ['Days of stock', r => (Number.isFinite(r.daysLeft) ? Math.floor(r.daysLeft) : '')],
    ['Units to send', r => r.sendUnits ?? ''],
  ];
  const q = v => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : v);
  return [`# Rails Profit checker ${period.start} to ${period.end}`, cols.map(c => c[0]).join(','),
    ...table.map(r => cols.map(c => q(c[1](r))).join(','))].join('\n');
}

/* Exposed for app.js and tests.html */
window.ProfitCheck = {
  CONFIG, PERIODS, FIELD_LABELS, FILE_TYPES, parseCSV, parseCSVRows, detectFileType, missingColumns, applyColumnOverrides, resetColumns, columnsFor, ALIASES, mergeSources,
  toNumber, toISODate, buildDataset, filterChannel, getPeriod, productSummary, totals, unitEconomics, stockPlan,
  weekdayStats, buildFindings, productDetail, buildWhatsAppText, tableToCSV, formatRand, pct, addDays, daysBetween,
};
