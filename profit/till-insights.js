/* till-insights.js — "From your till": answers that need what only Rails POS knows.
   Used only when this app runs inside Rails POS (Reports → Profit checker), which hands
   over `extras` (see profitExtras() in Rails POS app.js):
     variants: [{ code, product, category, size, colour, stock, cost, price, received: [{date, qty}], out: [{from, to|null}] }]
     lines:    [{ date (ISO date-time), code, product, size, colour, qty (<0 = refund), net, discount, cost, staff, customer, sale, reason, faulty }]
     expenses: [{ date, amount, category }]   clients: { id: name }   today: 'YYYY-MM-DD'
   Money is in rand excluding VAT. Pure functions: no screen code here (app.js draws it). */
(function () {
  const DAY = 864e5;
  const pad = n => String(n).padStart(2, '0');
  const localDay = iso => { const d = new Date(iso); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
  const dayNum = ymd => Date.UTC(+ymd.slice(0, 4), +ymd.slice(5, 7) - 1, +ymd.slice(8, 10)) / DAY;
  const daysBetween = (a, b) => dayNum(b) - dayNum(a);
  const addDay = (ymd, n) => { const d = new Date((dayNum(ymd) + n) * DAY); return d.toISOString().slice(0, 10); };
  const R = n => (window.ProfitCheck ? window.ProfitCheck.formatRand(n) : 'R' + Math.round(n).toLocaleString('en'));   // same money style as the rest of the page
  const plural = (n, one, many = one + 's') => `${n} ${n === 1 ? one : many}`;
  const vkey = (code, size, colour) => `${code}|${size}|${colour}`;
  const vname = v => `${v.product} · ${[v.size, v.colour].filter(Boolean).join(' / ') || 'one size'}`;

  /** The lines inside the period (inclusive dates). */
  function inPeriod(x, p) {
    return x.lines.filter(l => { const d = localDay(l.date); return d >= p.start && d <= p.end; });
  }

  /** Days a variant was sold out inside the period. */
  function outDaysIn(v, p) {
    let n = 0;
    const endExcl = addDay(p.end, 1);
    for (const s of v.out || []) {
      const from = s.from > p.start ? s.from : p.start;
      const to = (s.to || endExcl) < endExcl ? (s.to || endExcl) : endExcl;
      if (to > from) n += daysBetween(from, to);
    }
    return n;
  }

  /** Per size/colour: sold and refunded in the period, plus stock, sold-out days and age. */
  function variantRows(x, p) {
    const lines = inPeriod(x, p);
    const sold = new Map(), back = new Map(), net = new Map();
    for (const l of lines) {
      const k = vkey(l.code, l.size, l.colour);
      if (l.qty > 0) { sold.set(k, (sold.get(k) || 0) + l.qty); net.set(k, (net.get(k) || 0) + l.net); }
      else back.set(k, (back.get(k) || 0) - l.qty);
    }
    return x.variants.map(v => {
      const k = vkey(v.code, v.size, v.colour);
      const s = sold.get(k) || 0;
      return { ...v, key: k, sold: s, back: back.get(k) || 0, avgNet: s ? net.get(k) / s : v.price / 1.15,
        outDays: outDaysIn(v, p), age: stockAge(v, x.today) };
    });
  }

  /** How old the stock on the rail is, first in first out: the newest deliveries cover what's left. */
  function stockAge(v, today) {
    if (!v.stock || !v.received || !v.received.length) return null;
    const rec = v.received.slice().sort((a, b) => (a.date < b.date ? 1 : -1));
    let left = v.stock, oldest = 0, over90 = 0;
    for (const r of rec) {
      if (left <= 0) break;
      const take = Math.min(r.qty, left);
      const days = Math.max(0, daysBetween(r.date, today));
      oldest = Math.max(oldest, days);
      if (days > 90) over90 += take;
      left -= take;
    }
    if (left > 0) {                         // more on the rail than the recorded deliveries: as old as the oldest one
      const days = Math.max(0, daysBetween(rec[rec.length - 1].date, today));
      oldest = Math.max(oldest, days);
      if (days > 90) over90 += left;
    }
    return { oldest, over90 };
  }

  /* ---------------- the findings ---------------- */

  function sizesFinding(rows, p) {
    const judgeSlow = p.days >= 28;   // "not moving" needs about a month of sales, or a quiet fortnight looks like a problem
    const byProduct = new Map();
    for (const r of rows) { if (!byProduct.has(r.code)) byProduct.set(r.code, []); byProduct.get(r.code).push(r); }
    const reorder = [], stuck = [];
    for (const list of byProduct.values()) {
      if (list.length < 2) continue;
      const total = list.reduce((a, r) => a + r.sold, 0);
      for (const r of list) {
        if (r.stock === 0 && r.sold >= 2) reorder.push(r);
        else if (judgeSlow && r.stock >= 3 && r.sold === 0 && total >= 3) stuck.push(r);
      }
    }
    reorder.sort((a, b) => b.sold - a.sold);
    stuck.sort((a, b) => b.stock * b.cost - a.stock * a.cost);
    if (!reorder.length && !stuck.length) {
      return judgeSlow
        ? { id: 'sizes', tone: 'good', headline: 'Your sizes are in step with what sells.', detail: 'No size that sells is sold out, and no size sits while the others sell.' }
        : { id: 'sizes', tone: 'good', headline: 'No size that sells is sold out.', detail: 'Choose 30 days or more to also see which sizes aren’t moving.' };
    }
    return {
      id: 'sizes', tone: 'warn',
      headline: reorder.length
        ? `${plural(reorder.length, 'size')} that sell${reorder.length === 1 ? 's' : ''} ${reorder.length === 1 ? 'is' : 'are'} sold out${stuck.length ? `, and ${plural(stuck.length, 'size')} ${stuck.length === 1 ? 'isn’t' : 'aren’t'} moving` : ''}.`
        : `${plural(stuck.length, 'size')} ${stuck.length === 1 ? 'isn’t' : 'aren’t'} selling while the other sizes do.`,
      items: reorder.slice(0, 5).map(r => `Reorder ${vname(r)}: sold ${r.sold}, none left`)
        .concat(stuck.slice(0, 3).map(r => `${vname(r)}: ${r.stock} in stock, none sold`)),
      action: reorder.length ? 'Reorder the sold-out sizes first; next time buy fewer of the sizes that sit.' : 'Buy fewer of these sizes next time, or swap them with your supplier.',
    };
  }

  function ageFinding(rows) {
    const known = rows.filter(r => r.age);
    if (!known.length) return null;
    const old = known.filter(r => r.age.over90 > 0).map(r => ({ ...r, value: r.age.over90 * r.cost }))
      .sort((a, b) => b.value - a.value);
    if (!old.length) return { id: 'age', tone: 'good', headline: 'All your stock arrived in the last 90 days.', detail: 'Based on the deliveries recorded in the till (first in, first out).' };
    const value = old.reduce((a, r) => a + r.value, 0), units = old.reduce((a, r) => a + r.age.over90, 0);
    return {
      id: 'age', tone: 'warn',
      headline: `${R(value)} of stock (${plural(units, 'item')}) has been on the rail for over 90 days.`,
      detail: 'Right now, at cost price. Worked out from the deliveries recorded in the till, oldest sold first.',
      items: old.slice(0, 5).map(r => `${vname(r)}: ${r.age.over90} for ${r.age.oldest} days (${R(r.value)} at cost)${r.sold ? '' : ', none sold this period'}`),
      action: 'Mark these down, move them to the front, or bundle them, before the season changes. The cash is better in stock that sells.',
    };
  }

  function missedFinding(rows, p) {
    const list = [];
    for (const r of rows) {
      if (!r.outDays) continue;
      const inStock = Math.max(1, p.days - r.outDays);
      const rate = r.sold / inStock;                          // sales per day while it was on the rail
      const missed = rate * r.outDays;
      if (missed >= 0.5) list.push({ ...r, missed, value: missed * r.avgNet });
    }
    if (!list.length) return rows.some(r => r.out && r.out.length) ? { id: 'missed', tone: 'good', headline: 'No size that sells was sold out for long in this period.' } : null;
    list.sort((a, b) => b.value - a.value);
    const n = Math.round(list.reduce((a, r) => a + r.missed, 0)), value = list.reduce((a, r) => a + r.value, 0);
    return {
      id: 'missed', tone: 'bad',
      headline: `You probably missed about ${plural(Math.max(1, n), 'sale')} (${R(value)}) because sizes were sold out.`,
      detail: 'An estimate: how fast each size sold while it was in stock, times the days it was sold out.',
      items: list.slice(0, 5).map(r => `${vname(r)}: sold out ${plural(r.outDays, 'day')}, about ${plural(Math.max(1, Math.round(r.missed)), 'sale')} (${R(r.value)})`),
      action: 'Reorder these earlier: when a size gets down to its last one or two, not when it hits zero.',
    };
  }

  function discountFinding(lines) {
    const sold = lines.filter(l => l.qty > 0);
    const disc = sold.reduce((a, l) => a + (l.discount || 0), 0);
    const before = sold.reduce((a, l) => a + l.net + (l.discount || 0), 0);
    if (!sold.length) return null;
    if (disc < 1) return { id: 'discounts', tone: 'good', headline: 'No discounts were given in this period.' };
    const share = before > 0 ? disc / before : 0;
    const by = new Map();
    for (const l of sold) {
      if (!(l.discount > 0)) continue;
      const k = l.staff || 'Unknown';
      const b = by.get(k) || { amount: 0, sales: new Set() };
      b.amount += l.discount; b.sales.add(l.sale); by.set(k, b);
    }
    const staff = [...by.entries()].filter(([n]) => n !== 'Unknown').sort((a, b) => b[1].amount - a[1].amount);
    return {
      id: 'discounts', tone: share > 0.1 ? 'warn' : 'info',
      headline: `Discounts cost you ${R(disc)}: ${(share * 100).toFixed(share < 0.1 ? 1 : 0)}% of your sales before discounts.`,
      detail: 'Excluding VAT. Every rand of discount comes straight off your profit.',
      items: staff.slice(0, 5).map(([name, b]) => `${name}: ${R(b.amount)} on ${plural(b.sales.size, 'sale')}`),
      action: share > 0.1 ? 'Agree a discount limit with your staff (for example 10%), and ask them to note why.' : '',
    };
  }

  function reasonsFinding(lines) {
    const back = lines.filter(l => l.qty < 0);
    if (!back.length) return null;
    const why = back.filter(l => l.reason);
    if (!why.length) return { id: 'reasons', tone: 'info', headline: `${plural(back.reduce((a, l) => a - l.qty, 0), 'item')} came back, but no reasons were chosen.`, action: 'When you refund or exchange in Rails POS, tap why it came back. Next time this shows what to fix.' };
    const by = new Map();
    for (const l of why) {
      const b = by.get(l.reason) || { units: 0, what: new Map() };
      b.units -= l.qty;
      const k = `${l.product}${l.size ? `, size ${l.size}` : ''}`;
      b.what.set(k, (b.what.get(k) || 0) - l.qty);
      by.set(l.reason, b);
    }
    const list = [...by.entries()].sort((a, b) => b[1].units - a[1].units);
    const faultyCost = why.filter(l => l.faulty).reduce((a, l) => a - l.qty * l.cost, 0);
    const top = list[0];
    const most = b => [...b.what.entries()].sort((a, c) => c[1] - a[1])[0][0];
    return {
      id: 'reasons', tone: faultyCost > 0 || /size|fit/i.test(top[0]) ? 'warn' : 'info',
      headline: `Most returns were for “${top[0]}” (${plural(top[1].units, 'item')}).`,
      items: list.map(([r, b]) => `${r}: ${plural(b.units, 'item')}, mostly ${most(b)}`)
        .concat(faultyCost > 0 ? [`Faulty items written off: ${R(faultyCost)} at cost`] : []),
      action: /size|fit/i.test(top[0]) ? 'Add the fit to the label or a size tip at the till (for example "runs small, take one size up").'
        : faultyCost > 0 ? 'Claim faulty items back from your supplier where you can.' : '',
    };
  }

  function teamFinding(lines) {
    const sold = lines.filter(l => l.qty > 0);
    if (!sold.length) return null;
    const staff = new Map(), hours = new Array(24).fill(0);
    for (const l of sold) {
      const k = l.staff || 'Unknown';
      const b = staff.get(k) || { net: 0, sales: new Set() };
      b.net += l.net; b.sales.add(l.sale); staff.set(k, b);
      hours[new Date(l.date).getHours()] += l.net;
    }
    // Busiest two-hour stretch
    let best = 0, bestAt = 0;
    for (let h = 0; h < 23; h++) { const v = hours[h] + hours[h + 1]; if (v > best || (v === best && hours[h] > hours[bestAt])) { best = v; bestAt = h; } }   // a tie starts at the busier hour
    const total = hours.reduce((a, b) => a + b, 0);
    const list = [...staff.entries()].filter(([n]) => n !== 'Unknown').sort((a, b) => b[1].net - a[1].net);
    return {
      id: 'team', tone: 'info',
      headline: `Your busiest time is ${pad(bestAt)}:00–${pad(bestAt + 2)}:00, with ${total > 0 ? Math.round(best / total * 100) : 0}% of sales.`,
      detail: 'Have your best people on the floor then, and do deliveries and stock counts in the quiet hours.',
      items: list.slice(0, 6).map(([name, b]) => `${name}: ${R(b.net)} from ${plural(b.sales.size, 'sale')} (average ${R(b.net / b.sales.size)})`),
    };
  }

  function clientsFinding(x, lines, p) {
    const sold = lines.filter(l => l.qty > 0);
    const total = sold.reduce((a, l) => a + l.net, 0);
    const known = sold.filter(l => l.customer);
    if (!total || !known.length) return null;
    // Visits per client up to the end of the period (all history), to spot the regulars
    const visits = new Map();
    for (const l of x.lines) {
      if (!l.customer || l.qty <= 0 || localDay(l.date) > p.end) continue;
      if (!visits.has(l.customer)) visits.set(l.customer, new Set());
      visits.get(l.customer).add(l.sale);
    }
    const inPer = new Map();
    for (const l of known) inPer.set(l.customer, (inPer.get(l.customer) || 0) + l.net);
    const knownNet = known.reduce((a, l) => a + l.net, 0);
    const regulars = [...inPer.keys()].filter(c => (visits.get(c) || new Set()).size >= 2).length;
    const top = [...inPer.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3);
    return {
      id: 'clients', tone: 'info',
      headline: `Clients you know by name brought in ${Math.round(knownNet / total * 100)}% of sales; ${plural(regulars, 'of them has', 'of them have')} bought more than once.`,
      detail: `${plural(inPer.size, 'client')} bought in this period.`,
      items: top.map(([id, net]) => `${(x.clients && x.clients[id]) || 'Client'}: ${R(net)} (${plural((visits.get(id) || new Set()).size, 'visit')} so far)`),
      action: 'Add more buyers as clients at the till, and send your regulars a WhatsApp when new stock arrives.',
    };
  }

  /** Profit after petty cash and the shop's monthly running costs. */
  function netProfit(x, p, ctx) {
    const exp = x.expenses.filter(e => { const d = localDay(e.date); return d >= p.start && d <= p.end; });
    const petty = exp.reduce((a, e) => a + e.amount, 0);
    const monthly = Number.isFinite(ctx.fixedCosts) ? ctx.fixedCosts : null;
    const fixed = monthly == null ? 0 : monthly * p.days / 30.44;
    const net = ctx.grossProfit - petty - fixed;
    const byCat = new Map();
    for (const e of exp) byCat.set(e.category, (byCat.get(e.category) || 0) + e.amount);
    // Sales needed in a month to cover running costs and petty cash at this margin
    const pettyMonth = p.days > 0 ? petty * 30.44 / p.days : 0;
    const breakEven = monthly != null && ctx.margin > 0 ? (monthly + pettyMonth) / ctx.margin : null;
    return { gross: ctx.grossProfit, petty, fixed, monthly, net, breakEven, margin: ctx.margin,
      salesPerMonth: p.days > 0 ? ctx.netSales * 30.44 / p.days : 0,
      pettyByCat: [...byCat.entries()].sort((a, b) => b[1] - a[1]) };
  }

  /** Everything for the "From your till" section. */
  function build(x, p, ctx) {
    if (!x || !Array.isArray(x.lines)) return null;
    const rows = variantRows(x, p);
    const lines = inPeriod(x, p);
    return {
      net: netProfit(x, p, ctx),
      findings: [sizesFinding(rows, p), missedFinding(rows, p), ageFinding(rows), discountFinding(lines),
        reasonsFinding(lines), teamFinding(lines), clientsFinding(x, lines, p)].filter(Boolean),
    };
  }

  /** Size-by-size table for one product (the product panel). */
  function sizesFor(x, p, code) {
    if (!x || !Array.isArray(x.variants)) return [];
    return variantRows(x, p).filter(r => r.code === code);
  }

  window.PCTill = { build, sizesFor, stockAge, outDaysIn, _localDay: localDay };
})();
