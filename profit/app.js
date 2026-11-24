/* app.js — screen only. All maths is in calculations.js. */
(function () {
  const PC = window.ProfitCheck;
  const R = PC.formatRand;
  const $ = id => document.getElementById(id);
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  /* Inside Rails POS (Reports → Profit checker) this page runs in a frame and the till
     gives it its sales, refunds, cost prices and stock (HOST.tillCsv()). The till's file
     is fresh every time and is never stored here; uploaded files add to it as usual.
     The copy that ships with Rails POS sets window.PC_REQUIRE_HOST, so it only opens
     from the till while the shop has the add-on (HOST.allowed()). */
  const HOST = (() => { try { return window.parent !== window ? window.parent.RailsProfitHost || null : null; } catch (e) { return null; } })();
  const TILL_ID = 'till';
  if (window.PC_REQUIRE_HOST && !(HOST && HOST.allowed())) {
    document.body.innerHTML = `<main class="shell locked-page"><h1>Profit checker</h1>
      <p>Open it from <strong>Rails POS → Reports → Profit checker</strong>. It's a paid add-on with a 14-day free trial.</p></main>`;
    return;
  }
  if (HOST) {
    document.documentElement.classList.add('in-till');
    try { const t = HOST.theme && HOST.theme(); if (t === 'dark' || t === 'light') document.documentElement.dataset.theme = t; } catch (e) {}
  }
  const store = {
    get(k, fallback) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : fallback; } catch (e) { return fallback; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch (e) { return false; } },
    del(k) { try { localStorage.removeItem(k); } catch (e) {} },
  };

  const FILE_LABELS = { sales: 'Sales', returns: 'Returns', stock: 'Stock', products: 'Products (cost prices)', ads: 'Ads' };
  // Every file (or PDF/Excel table) you've loaded: { id, type, name, text, addedAt }. Files ADD UP:
  // month 1 + month 2 are merged, and duplicates are skipped (PC.mergeSources).
  let sources = [];
  let lastReport = [];     // what each source added, from the last merge
  let pending = [];        // files we couldn't recognise: { name, text, parsed }
  let importNotes = [];    // problems found while reading PDF/Excel files (shown with the warnings)
  let data = null;
  let fromSaved = null;    // { savedAt, sample } when data came from this browser's memory
  let isSample = false;    // true while the sample data is on screen
  let range = store.get('pc-range', { key: 'last30', custom: null });
  let channel = store.get('pc-channel', 'all');
  let sort = store.get('pc-sort', { key: 'netSales', dir: -1 });
  let lastRes = null;
  let tillExtras = null;   // inside Rails POS: what only the till knows (till-insights.js)

  /** Your saved column matches apply to your own files; the sample data always uses the defaults. */
  function useColumns(sample) {
    PC.resetColumns();
    if (!sample) PC.applyColumnOverrides(store.get('pc-columns', {}));
  }

  /* =================== Loading files =================== */

  function showFileStatus(errors = []) {
    $('file-status').innerHTML = PC.FILE_TYPES.filter(t => sources.some(s => s.type === t)).map(t => {
      const n = sources.filter(s => s.type === t).length;
      return `<li class="ok">${FILE_LABELS[t]} · ${n} file${n === 1 ? '' : 's'}</li>`;
    }).join('') + errors.map(e => `<li class="err">${esc(e)}</li>`).join('');
  }

  const hasSales = () => sources.some(s => s.type === 'sales');
  const newId = () => 's' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

  /**
   * Adds one CSV text as a source. An exact copy of a file already loaded is skipped.
   * quiet: an unrecognised extra table from a PDF/Excel file that also had a recognised one —
   * it waits in "Match columns" without popping that screen open.
   */
  function addText(name, text, opts = {}) {
    const parsed = PC.parseCSV(text);
    const type = opts.type || PC.detectFileType(parsed.headers);
    if (!type) { pending.push({ name, text, parsed, quiet: !!opts.quiet }); return null; }
    const same = sources.find(s => s.text === text);
    if (same) { importNotes.push(`"${name}" is the same as "${same.name}", which is already loaded, so it was skipped.`); return null; }
    const src = { id: newId(), type, name, text, addedAt: new Date().toISOString() };
    sources.push(src);
    return src;
  }

  /**
   * After adding files: merge everything, then explain what each NEW file did.
   * A new file that adds nothing (all duplicates) or is overruled by a more detailed file is dropped again.
   */
  function settleNewSources(newOnes) {
    if (!newOnes.length) return;
    const rep = new Map(PC.mergeSources(sources).report.map(r => [r.id, r]));
    const drop = new Set();
    for (const s of newOnes) {
      const r = rep.get(s.id); if (!r) continue;
      const what = FILE_LABELS[s.type].toLowerCase();
      if (r.skipped) { importNotes.push(`"${s.name}" wasn't used: it ${r.skipped}.`); drop.add(s.id); }
      else if (r.rows && !r.added && !r.updated) { importNotes.push(`"${s.name}" was already loaded (all ${r.rows} ${what} rows are duplicates), so it was skipped.`); drop.add(s.id); }
      else loadNotes.push(`"${s.name}": ${r.added.toLocaleString('en')} ${what} row${r.added === 1 ? '' : 's'} added`
        + (r.updated ? `, ${r.updated} updated` : '') + (r.dupes ? `, ${r.dupes} duplicate${r.dupes === 1 ? '' : 's'} skipped` : '') + '.');
    }
    // Older files that a new, more detailed one now overrules stay listed (so you can remove them), but aren't used
    for (const s of sources) {
      const r = rep.get(s.id);
      if (r && r.skipped && !newOnes.includes(s)) importNotes.push(`"${s.name}" is no longer used: it ${r.skipped}. You can remove it under Files.`);
    }
    sources = sources.filter(s => !drop.has(s.id));
  }
  let loadNotes = [];      // "file X: 24 sales rows added" (shown as a toast and in the file status)

  async function loadFiles(fileList) {
    // Switching from sample data to your own files: start clean and use your column matches
    if (isSample) { sources = []; isSample = false; }
    useColumns(false);
    importNotes = []; pending = []; loadNotes = [];
    const before = new Set(sources.map(s => s.id));
    const errors = [];
    let ocrUsed = false;
    for (const file of [...fileList]) {
      if (!window.PCImport || !PCImport.isSpecial(file)) { addText(file.name, await file.text()); continue; }
      // PDF or Excel: turn each table into CSV text first (see importers.js)
      try {
        const tables = await PCImport.read(file, msg => toast(msg, 120000));
        if (!tables.length) errors.push(`No table found in "${file.name}"`);
        if (tables.length === 1 && tables[0].note) { errors.push(`"${file.name}": ${tables[0].note}`); continue; }
        const anyKnown = tables.some(t => t.type || PC.detectFileType(PC.parseCSV(t.csv).headers));
        for (const t of tables) {
          const name = t.label ? `${file.name} · ${t.label}` : file.name;
          // t.type is set when the PDF is a report we know (e.g. Rails POS "Stock on hand")
          addText(name, t.csv, { quiet: anyKnown, type: t.type || undefined }); ocrUsed = ocrUsed || t.ocr;
          for (const issue of t.issues || []) importNotes.push(`"${name}" may not have been read correctly: ${issue}. Check it against the original${t.ocr ? ', or save it as a PDF with real text (see README)' : ''}.`);
        }
      } catch (err) {
        errors.push(`Couldn't read "${file.name}": ${err.message || err}`);
      }
    }
    settleNewSources(sources.filter(s => !before.has(s.id)));
    const added = loadNotes.length ? loadNotes.join(' ') : (importNotes[0] || 'Nothing new was added.');
    toast((ocrUsed ? 'Read with OCR — check a few numbers. ' : '') + added, ocrUsed || loadNotes.length > 1 ? 7000 : 4000);
    fromSaved = null;
    const loud = pending.filter(p => !p.quiet);
    showFileStatus(errors.concat(loadNotes, importNotes,
      loud.map(p => `Couldn't recognise "${p.name}" — match its columns`),
      pending.filter(p => p.quiet).map(p => `Not used: "${p.name}" (open Match columns if you need it)`)));
    if (loud.length) openMapping();
    else if (hasSales()) run();
    else {
      if (sources.length) remember(false);     // keep e.g. a stock file until the sales file arrives
      if (!errors.length) showFileStatus(loadNotes.concat(importNotes, ['Add a sales file to see results.']));
    }
  }

  for (const id of ['files', 'files-top', 'files-more']) {
    $(id).addEventListener('change', async e => {
      const list = [...e.target.files]; e.target.value = '';
      await loadFiles(list);
      if ($('files-dlg').open) openFiles();
    });
  }
  const dz = $('dropzone');
  ['dragenter', 'dragover'].forEach(ev => dz.addEventListener(ev, e => { e.preventDefault(); dz.classList.add('drag'); }));
  ['dragleave', 'drop'].forEach(ev => dz.addEventListener(ev, e => { e.preventDefault(); dz.classList.remove('drag'); }));
  dz.addEventListener('drop', e => loadFiles(e.dataTransfer.files));

  $('use-sample').addEventListener('click', () => {
    useColumns(true);
    isSample = true;
    importNotes = []; loadNotes = []; sources = [];
    for (const k of Object.keys(FILE_LABELS)) if (window.SAMPLE_CSV[k]) addText(`sample-${k}.csv`, window.SAMPLE_CSV[k]);
    fromSaved = null;
    run({ sample: true });
  });

  /** Remember the loaded files in this browser so there's no re-upload next time. */
  function remember(sample) {
    // The till's own file is never stored: it comes fresh from Rails POS each time
    const ok = store.set('pc-data', { v: 2, savedAt: new Date().toISOString(), sample: !!sample, sources: sources.filter(s => s.id !== TILL_ID) });
    if (!ok) toast('Files too big to remember on this device — you\'ll need to load them again next time');
  }

  /** Merge all sources (your column matches apply while reading them), then do the maths on the merged table. */
  function buildData() {
    useColumns(isSample);
    const merged = PC.mergeSources(sources);
    lastReport = merged.report;
    PC.resetColumns();               // the merged table uses the default column names
    const d = PC.buildDataset(merged.raw);
    useColumns(isSample);
    return d;
  }

  function run(opts = {}) {
    data = buildData();
    if (!data.lastDate) { showFileStatus(['No dated rows found in the sales file. Try "Match columns".']); return; }
    if (!opts.fromStorage) remember(opts.sample);
    $('load').hidden = true;
    $('results').hidden = false;
    $('appbar-actions').hidden = false;
    $('from').min = $('to').min = data.firstDate;
    $('from').max = $('to').max = data.lastDate;
    if (range.key === 'custom' && !(range.custom && range.custom.start >= data.firstDate && range.custom.end <= data.lastDate)) range = { key: 'last30', custom: null };
    if (channel !== 'all' && !data.channels.includes(channel)) channel = 'all';
    $('channel').innerHTML = `<option value="all">All channels</option>` + data.channels.map(c => `<option>${esc(c)}</option>`).join('');
    $('channel-wrap').hidden = data.channels.length < 2;
    renderDataChip(opts);
    render();
    window.scrollTo({ top: 0 });
  }

  function renderDataChip(opts) {
    const files = sources.length;
    const tillOn = sources.some(s => s.id === TILL_ID), more = files - (tillOn ? 1 : 0);
    const label = isSample ? 'Sample data'
      : tillOn ? `Till data${more ? ` + ${more} file${more === 1 ? '' : 's'}` : ''}`
      : `${files} file${files === 1 ? '' : 's'}`;
    // No one-tap "Clear" here on purpose: files are removed one by one under Files, or everything with Reset (type YES)
    $('data-chip').innerHTML = `<button type="button" id="open-files" class="chip-link" title="See, add or remove your files">${esc(label)}</button> · ${PC.getPeriod('all', data).range}`;
    $('open-files').addEventListener('click', openFiles);
  }

  /* =================== Your files =================== */
  const fmtDay = iso => (iso ? new Date(iso + 'T00:00:00').toLocaleDateString('en-ZA', { day: 'numeric', month: 'short', year: 'numeric' }) : '');
  function openFiles() {
    const rep = new Map(lastReport.map(r => [r.id, r]));
    $('files-body').innerHTML = sources.length ? `<table class="files-table"><thead><tr><th>File</th><th>Kind</th><th>Dates</th><th class="r">Used</th><th class="r">Duplicates</th><th></th></tr></thead><tbody>
      ${sources.map(s => {
        const r = rep.get(s.id) || {};
        const used = r.skipped ? `<span class="muted-note">Not used: ${esc(r.skipped)}</span>` : (r.added || 0).toLocaleString('en') + (r.updated ? ` (+${r.updated} updated)` : '');
        return `<tr><td class="fname">${esc(s.name)}</td><td>${FILE_LABELS[s.type]}</td><td>${r.from ? `${fmtDay(r.from)} – ${fmtDay(r.to)}` : '–'}</td>
          <td class="r" data-label="Rows used">${used}</td><td class="r" data-label="Duplicates skipped">${r.dupes ? r.dupes.toLocaleString('en') : '0'}</td>
          <td class="r">${isSample || s.id === TILL_ID ? '' : `<button type="button" class="btn btn-ghost btn-sm" data-remove="${esc(s.id)}">Remove</button>`}</td></tr>`;
      }).join('')}</tbody></table>`
      : '<p class="be-note">No files loaded.</p>';
    $('files-body').querySelectorAll('[data-remove]').forEach(b => b.addEventListener('click', () => {
      const s = sources.find(x => x.id === b.dataset.remove);
      if (!s || !confirm(`Remove "${s.name}"? Its rows are taken out of the answers. The file on your computer is not touched.`)) return;
      sources = sources.filter(x => x !== s);
      // Last sales file gone: keep the other files (e.g. stock) remembered and go back to the start screen
      if (!hasSales()) { remember(isSample); location.reload(); return; }
      run(); openFiles(); toast(`Removed "${s.name}"`);
    }));
    if (!$('files-dlg').open) $('files-dlg').showModal();
  }

  /* =================== Range + channel =================== */

  const chipKeys = Object.keys(PC.PERIODS).filter(k => k !== 'custom');
  $('chips').innerHTML = chipKeys.map(k => `<button type="button" class="chip" data-key="${k}">${PC.PERIODS[k].label}</button>`).join('');
  $('chips').addEventListener('click', e => {
    const b = e.target.closest('.chip'); if (!b) return;
    range = { key: b.dataset.key, custom: null };
    store.set('pc-range', range); render();
  });
  for (const id of ['from', 'to']) {
    $(id).addEventListener('change', () => {
      if (!$('from').value || !$('to').value) return;
      range = { key: 'custom', custom: { start: $('from').value, end: $('to').value } };
      store.set('pc-range', range); render();
    });
  }
  $('channel').addEventListener('change', e => { channel = e.target.value; store.set('pc-channel', channel); render(); });

  const opts = () => ({ key: range.key, custom: range.custom, channel });

  /* =================== Main render =================== */

  const ICON = { losers: '📉', returns: '↩️', fees: '💸', stock: '📦', weekday: '📅', event: '🛍️', slow: '🐢', ads: '📣',
    sizes: '👕', age: '⏳', missed: '🚫', discounts: '🏷️', reasons: '🔁', team: '🕑', clients: '⭐' };
  const TAG = { losers: 'Profit', returns: 'Returns', fees: 'Fees', stock: 'Stock', weekday: 'Promotions', event: 'Sales event', slow: 'Slow stock', ads: 'Ads',
    sizes: 'Sizes', age: 'Stock age', missed: 'Missed sales', discounts: 'Discounts', reasons: 'Why things come back', team: 'Staff & busy hours', clients: 'Clients' };
  const TONE = { bad: 'Needs attention', warn: 'Watch', good: 'Good', info: 'Info' };

  function findingHTML(f) {
    return `<li class="finding ${f.tone}">
      <span class="icon" aria-hidden="true">${ICON[f.id]}</span>
      <span class="tag">${TAG[f.id]} · ${TONE[f.tone]}</span>
      <p class="headline">${esc(f.headline)}</p>
      ${f.detail ? `<p class="detail">${esc(f.detail)}</p>` : ''}
      ${f.items ? `<ul>${f.items.map(i => `<li>${esc(i)}</li>`).join('')}</ul>` : ''}
      ${f.action ? `<p class="action"><b>What to do:</b> ${esc(f.action)}</p>` : ''}
    </li>`;
  }

  /* =================== From your till (inside Rails POS only) =================== */
  const tillChannelOk = () => channel === 'all' || channel === 'Shop';
  /** Only the till's own data loaded (no Takealot/Amazon/other files). */
  const tillOnly = () => sources.length > 0 && sources.every(s => s.id === TILL_ID);

  function renderTill(res) {
    const wrap = $('till-wrap');
    if (!wrap) return;
    const t = tillExtras && window.PCTill && tillChannelOk()
      ? PCTill.build(tillExtras, res.period, { grossProfit: res.totals.profit, netSales: res.totals.netSales, margin: res.totals.margin, fixedCosts: HOST && HOST.fixedCosts ? HOST.fixedCosts() : null })
      : null;
    wrap.hidden = !t;
    if (!t) return;
    $('findings-till').innerHTML = t.findings.map(findingHTML).join('');
    $('net-card').innerHTML = netCardHTML(t.net, res.period);
  }

  function netCardHTML(n, p) {
    const canEdit = !!(HOST && HOST.canSetFixedCosts && HOST.canSetFixedCosts());
    const row = (label, v, cls = '') => `<div class="net-row ${cls}"><span>${label}</span><b class="${v < 0 ? 'neg' : ''}">${R(v)}</b></div>`;
    return `<div class="card-head"><h3>Real profit</h3><p>${esc(p.range)} · after petty cash and running costs</p></div>
      ${row('Profit on sales', n.gross)}
      ${row(`Petty cash paid out`, -n.petty)}
      ${n.monthly != null ? row(`Running costs (${R(n.monthly)} a month × ${p.days} days)`, -n.fixed) : ''}
      ${row('Real profit', n.net, 'total')}
      ${n.pettyByCat.length ? `<p class="net-note">Petty cash: ${n.pettyByCat.slice(0, 4).map(([c, v]) => `${esc(c)} ${R(v)}`).join(' · ')}</p>` : ''}
      ${n.monthly == null
        ? `<p class="net-note">Add your monthly running costs (rent, wages, electricity, Rails POS…) to see your real profit and the sales you need to break even.</p>`
        : n.breakEven != null
          ? `<p class="net-note">To cover your running costs you need about <b>${R(n.breakEven)}</b> in sales a month (excl. VAT) at your ${PC.pct(n.margin)} margin. You're on track for <b>${R(n.salesPerMonth)}</b>${n.salesPerMonth >= n.breakEven ? ' ✅' : ' ⚠️'}.</p>`
          : ''}
      ${canEdit ? `<form class="net-form" id="net-form">
          <label for="net-fixed">Monthly running costs (R)</label>
          <div class="net-form-row"><input id="net-fixed" inputmode="numeric" placeholder="e.g. 18000" value="${n.monthly != null ? n.monthly : ''}">
          <button class="btn btn-sm" type="submit">Save</button></div>
          <p class="net-note">Saved in Rails POS Settings, for all your devices.</p>
        </form>` : (n.monthly == null ? '<p class="net-note">The owner can add them here.</p>' : '')}`;
  }

  document.addEventListener('submit', async e => {
    if (e.target.id !== 'net-form') return;
    e.preventDefault();
    const txt = $('net-fixed').value.replace(/[R\s,]/gi, '');
    const n = txt === '' ? null : Number(txt);
    if (n !== null && !(Number.isFinite(n) && n >= 0)) return toast('Enter the amount in rand, e.g. 18000');
    try { await HOST.setFixedCosts(n); } catch (err) { return toast('Couldn\'t save it'); }
    toast(n === null ? 'Running costs cleared' : `Saved: ${R(n)} a month`);
    if (lastRes) renderTill(lastRes);
  });

  function render() {
    const res = PC.buildFindings(data, opts());
    lastRes = res;
    const p = res.period;

    document.querySelectorAll('.chip').forEach(c => c.setAttribute('aria-pressed', String(c.dataset.key === p.key)));
    $('from').value = p.start; $('to').value = p.end;
    document.querySelector('.custom-range').classList.toggle('active', p.key === 'custom');
    $('channel').value = channel;
    $('channel-wrap').classList.toggle('active', channel !== 'all');
    const chText = channel === 'all' ? (data.channels.length > 1 ? 'All channels' : '') : channel;
    $('period-range').textContent = `${p.label} · ${p.range} (${p.days} days)${chText ? ' · ' + chText : ''}`;
    $('print-range').textContent = $('period-range').textContent;

    renderKpis(res);
    // From the till, refunds are already in its file: "no returns file" would only confuse
    const warns = sources.some(s => s.id === TILL_ID) ? data.warnings.filter(w => !/^No returns file loaded/.test(w)) : data.warnings;
    $('warnings').innerHTML = importNotes.concat(warns).map(w => `<p>⚠️ ${esc(w)}</p>`).join('');

    // Till-only shops have no marketplace fees, so the "no fees" answer is just noise there
    $('findings').innerHTML = res.findings.filter(f => !f.extra && !(f.id === 'fees' && tillOnly() && !res.totals.fees)).map(findingHTML).join('');
    const extras = res.findings.filter(f => f.extra);
    $('findings-extra').innerHTML = extras.map(findingHTML).join('');
    $('extra-wrap').hidden = !extras.length;
    renderTill(res);

    const wa = PC.buildWhatsAppText(data);
    $('wa-preview').textContent = wa;
    $('open-wa').href = 'https://wa.me/?text=' + encodeURIComponent(wa);

    const rows = res.rows.filter(r => r.units || r.returnedUnits);
    barChart($('chart-sales'), rows, r => r.netSales,
      r => `<b>${esc(r.name)}</b><br>Net sales ${R(r.netSales)}<br>${r.units} sold · ${r.returnedUnits} returned<br><i>Tap for details</i>`);
    barChart($('chart-profit'), rows, r => r.profit,
      r => `<b>${esc(r.name)}</b><br>Profit ${R(r.profit)} (${PC.pct(r.margin)} margin)<br>Fees ${R(r.fees)} · Stock ${R(r.stockCost)}${r.adSpend ? ` · Ads ${R(r.adSpend)}` : ''}<br><i>Tap for details</i>`);
    weekdayChart($('chart-weekday'), res);
    renderTable(res);
    if (drawerSku) openDrawer(drawerSku);
  }

  /* KPI tiles with "vs previous period" arrows */
  function delta(cur, prev, upIsGood, days) {
    if (!prev || !Number.isFinite(prev) || prev === 0) return '';
    const ch = cur / prev - 1;
    if (Math.abs(ch) < 0.005) return `<span class="delta flat">● same as previous ${days} days</span>`;
    const up = ch > 0;
    const cls = up ? (upIsGood ? 'up-good' : 'up-bad') : (upIsGood ? 'down-bad' : 'down-good');
    return `<span class="delta ${cls}">${up ? '▲' : '▼'} ${Math.abs(ch * 100).toFixed(0)}%</span> vs previous ${days} days`;
  }

  function renderKpis(res) {
    const t = res.totals, pv = res.prev, d = res.period.days;
    const feeShare = t.netSales > 0 ? t.fees / t.netSales : 0;
    const showFees = !(tillOnly() && !t.fees);    // a till-only shop has no selling fees: the tile would always say R0
    $('kpis').classList.toggle('three', !showFees);
    $('kpis').innerHTML = `
      <div class="kpi has-spark">
        <div class="label">Net sales</div>
        <div class="value">${R(t.netSales)}</div>
        <div class="sub">${delta(t.netSales, pv && pv.netSales, true, d) || `${t.units.toLocaleString('en')} units sold`}</div>
        ${sparkline(res.daily.map(x => x.netSales), 'spark')}
      </div>
      <div class="kpi">
        <div class="label">Profit</div>
        <div class="value${t.profit < 0 ? ' neg' : ''}">${R(t.profit)}</div>
        <div class="sub">${PC.pct(t.margin)} margin${t.adSpend ? ` · after ${R(t.adSpend)} ads` : ''}</div>
        <div class="sub">${delta(t.profit, pv && pv.profit, true, d)}</div>
      </div>
      ${showFees ? `<div class="kpi">
        <div class="label">Fees</div>
        <div class="value">${R(t.fees)}</div>
        <div class="sub">${PC.pct(feeShare)} of sales</div>
        <div class="sub">${delta(t.fees, pv && pv.fees, false, d)}</div>
      </div>` : ''}
      <div class="kpi">
        <div class="label">Returns cost</div>
        <div class="value">${R(t.returnCost)}</div>
        <div class="sub">${t.returnedUnits.toLocaleString('en')} unit${t.returnedUnits === 1 ? '' : 's'} back · ${R(t.refunds)} refunded</div>
        <div class="sub">${delta(t.returnCost, pv && pv.returnCost, false, d)}</div>
      </div>`;
    const sp = document.querySelector('.kpi .spark');
    if (sp) attachTip(sp, e => {
      const i = indexAt(sp, e, res.daily.length);
      return `<b>${res.daily[i].label}</b><br>Net sales ${R(res.daily[i].netSales)}`;
    });
  }

  const indexAt = (el, e, n) => {
    const box = el.getBoundingClientRect();
    return Math.max(0, Math.min(n - 1, Math.round((e.clientX - box.left) / box.width * (n - 1))));
  };

  /** Small area chart. cls = 'spark' (KPI tile) or 'trend' (drawer). */
  function sparkline(vals, cls) {
    if (vals.length < 2) return '';
    const max = Math.max(...vals, 1), min = Math.min(0, ...vals);
    const x = i => (i / (vals.length - 1)) * 100;
    const y = v => 38 - ((v - min) / (max - min || 1)) * 34;
    const line = vals.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(2)},${y(v).toFixed(2)}`).join('');
    return `<svg class="${cls}" viewBox="0 0 100 40" preserveAspectRatio="none" aria-hidden="true">
      <path class="area" d="${line}L100,40L0,40Z"></path><path class="line" d="${line}"></path></svg>`;
  }

  /** Horizontal bars, sorted biggest first. Handles negatives with a zero line. Tap opens the product. */
  function barChart(el, rows, value, tipHtml) {
    const sorted = [...rows].sort((a, b) => value(b) - value(a));
    const max = Math.max(0, ...sorted.map(value));
    const min = Math.min(0, ...sorted.map(value));
    const span = max - min || 1;
    const zero = (-min / span) * 100;
    el.innerHTML = `<div class="bars">${sorted.map((r, i) => {
      const v = value(r), w = Math.abs(v) / span * 100, neg = v < 0;
      return `<div class="bar-row" data-i="${i}" role="button" tabindex="0" aria-label="${esc(r.name)}: ${R(v)}. Open details">
        <span class="name" title="${esc(r.name)}">${esc(r.name)}</span>
        <div class="bar-track">
          ${min < 0 ? `<span class="zero-line" style="left:${zero}%"></span>` : ''}
          <span class="bar${neg ? ' neg' : ''}" style="left:${neg ? zero - w : zero}%;width:${w}%"></span>
        </div>
        <span class="val${neg ? ' neg' : ''}">${R(v)}</span>
      </div>`;
    }).join('')}</div>`;
    el.querySelectorAll('.bar-row').forEach(n => {
      const r = sorted[n.dataset.i];
      attachTip(n, () => tipHtml(r), true);
      n.addEventListener('click', () => openDrawer(r.sku));
      n.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openDrawer(r.sku); } });
    });
  }

  function weekdayChart(el, res) {
    const order = [1, 2, 3, 4, 5, 6, 0].map(i => res.weekdays[i]);   // Monday first
    const max = Math.max(...order.map(w => w.avgSales)) || 1;
    const best = res.weekdayBasis.best;
    const compact = n => n >= 1000 ? `R${(n / 1000).toFixed(1)}k` : R(n);
    el.innerHTML = `<div class="week">
      <div class="cols">${order.map((w, i) => `
        <div class="col${w.index === best ? ' best' : ''}" data-i="${i}">
          <span class="colval">${compact(w.avgSales)}</span>
          <span class="colbar" style="height:${(w.avgSales / max) * 82}%"></span>
        </div>`).join('')}</div>
      <div class="names">${order.map(w => `<span class="${w.index === best ? 'best' : ''}">${w.short}</span>`).join('')}</div>
    </div>`;
    const b = res.weekdayBasis;
    $('weekday-note').textContent = `Average sales per day · ${b.allData ? 'all data (range too short)' : 'chosen range'} · darkest = best for profit`;
    el.querySelectorAll('.col').forEach(n => attachTip(n, () => {
      const w = order[n.dataset.i];
      return `<b>${w.name}s</b> (${w.days} in range)<br>Avg sales ${R(w.avgSales)}<br>Avg profit ${R(w.avgProfit)} before returns and ads`;
    }));
  }

  /* =================== Product table =================== */

  const daysText = d => (d === null ? '–' : Number.isFinite(d) ? Math.floor(d) : '∞');
  const COLS = [
    { key: 'name', label: 'Product', fmt: r => esc(r.name), dir: 1 },
    { key: 'units', label: 'Sold', fmt: r => r.units.toLocaleString('en') },
    { key: 'returnRate', label: 'Returned', fmt: r => r.returnRate >= 0.08 ? `<span class="pill warn">${PC.pct(r.returnRate)}</span>` : PC.pct(r.returnRate) },
    { key: 'netSales', label: 'Net sales', fmt: r => R(r.netSales) },
    { key: 'fees', label: 'Fees', fmt: r => R(r.fees) },
    { key: 'adSpend', label: 'Ads', fmt: r => (r.adSpend ? R(r.adSpend) : '–') },
    { key: 'profit', label: 'Profit', fmt: r => `<span class="${r.profit < 0 ? 'neg' : ''}">${R(r.profit)}</span>` },
    { key: 'margin', label: 'Margin', fmt: r => `<span class="${r.margin < 0 ? 'neg' : ''}">${PC.pct(r.margin)}</span>` },
    { key: 'price', label: 'Avg price', fmt: r => (r.price ? R(r.price) : '–') },
    { key: 'breakEven', label: 'Break-even', fmt: r => !Number.isFinite(r.breakEven) || r.breakEven === null ? '–'
        : r.breakEven > r.price ? `<span class="pill bad">${R(Math.ceil(r.breakEven))}</span>` : R(Math.ceil(r.breakEven)) },
    { key: 'daysLeft', label: 'Days of stock', fmt: r => `<span class="${r.daysLeft !== null && r.daysLeft < PC.CONFIG.RUN_OUT_WARNING_DAYS ? 'low' : ''}">${daysText(r.daysLeft)}</span>` },
    { key: 'sendUnits', label: 'Send', fmt: r => (r.sendUnits ? `<b>${r.sendUnits}</b>` : r.sendUnits === null ? '–' : '0') },
  ];

  function renderTable(res) {
    const val = (r, k) => { const v = r[k]; return v === null || v === undefined ? -Infinity : v; };
    const rows = [...res.table].sort((a, b) => {
      if (sort.key === 'name') return sort.dir * a.name.localeCompare(b.name);
      return sort.dir * (val(a, sort.key) - val(b, sort.key));
    });
    $('ptable').innerHTML = `<thead><tr>${COLS.map(c =>
      `<th data-key="${c.key}" ${c.key === sort.key ? `aria-sort="${sort.dir > 0 ? 'ascending' : 'descending'}"` : ''} scope="col">${c.label}</th>`).join('')}</tr></thead>
      <tbody>${rows.map(r => `<tr data-sku="${esc(r.sku)}" tabindex="0">${COLS.map(c => `<td>${c.fmt(r)}</td>`).join('')}</tr>`).join('')}</tbody>`;
  }
  $('ptable').addEventListener('click', e => {
    const th = e.target.closest('th');
    if (th) {
      const k = th.dataset.key;
      sort = { key: k, dir: sort.key === k ? -sort.dir : (COLS.find(c => c.key === k).dir || -1) };
      store.set('pc-sort', sort); renderTable(lastRes); return;
    }
    const tr = e.target.closest('tbody tr');
    if (tr) openDrawer(tr.dataset.sku);
  });
  $('ptable').addEventListener('keydown', e => {
    const tr = e.target.closest('tbody tr');
    if (tr && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); openDrawer(tr.dataset.sku); }
  });

  $('download-csv').addEventListener('click', () => {
    const csv = PC.tableToCSV(lastRes.table, lastRes.period);
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    a.download = `profit-check-${lastRes.period.start}-to-${lastRes.period.end}${channel !== 'all' ? '-' + channel.replace(/\W+/g, '-').toLowerCase() : ''}.csv`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  });

  /* =================== Product drawer =================== */

  let drawerSku = null, lastFocus = null;

  function openDrawer(sku) {
    const d = PC.productDetail(data, opts(), sku);
    if (!d.product) return;
    if (!drawerSku) lastFocus = document.activeElement;
    drawerSku = sku;
    const r = d.row, e = d.econ, s = d.stock, ev = PC.CONFIG.EVENT;
    $('d-sub').textContent = [sku, d.product.category, channel === 'all' ? '' : channel, d.period.range].filter(Boolean).join(' · ');
    $('d-title').textContent = d.product.name;

    let html = '';
    if (r) {
      html += `<div class="mini-kpis">
        <div><span>Net sales</span><b>${R(r.netSales)}</b></div>
        <div><span>Profit</span><b class="${r.profit < 0 ? 'neg' : ''}">${R(r.profit)}</b></div>
        <div><span>Margin</span><b class="${r.margin < 0 ? 'neg' : ''}">${PC.pct(r.margin)}</b></div>
        <div><span>Returned</span><b>${PC.pct(r.returnRate)}</b></div>
      </div>`;
    } else {
      html += `<div class="card"><p>No sales of this product in this period${channel !== 'all' ? ' on ' + esc(channel) : ''}.</p></div>`;
    }

    // Size by size (inside Rails POS only)
    const sz = tillExtras && window.PCTill && tillChannelOk() ? PCTill.sizesFor(tillExtras, d.period, sku) : [];
    if (sz.length > 1 || (sz.length === 1 && (sz[0].size || sz[0].colour))) {
      // Only the columns that say something for this product
      const cols = [['Sold', v => v.sold, true], ['Back', v => v.back || '', sz.some(v => v.back)], ['In stock', v => v.stock, true],
        ['Sold out', v => (v.outDays ? `${v.outDays} d` : ''), sz.some(v => v.outDays)], ['Oldest', v => (v.age ? `${v.age.oldest} d` : ''), sz.some(v => v.age)]]
        .filter(c => c[2]);
      html += `<div class="card"><div class="card-head"><h3>Size by size</h3><p>Sold in this period, and what's on the rail now${cols.some(c => c[0] === 'Oldest') ? ' (oldest = days since its oldest delivery still on the rail)' : ''}</p></div>
        <div class="size-wrap"><table class="size-table"><thead><tr><th>Size / colour</th>${cols.map(c => `<th class="r">${c[0]}</th>`).join('')}</tr></thead><tbody>
        ${sz.map(v => `<tr class="${v.stock === 0 && v.sold ? 'warn-row' : ''}"><td>${esc([v.size, v.colour].filter(Boolean).join(' / ') || 'One size')}</td>
          ${cols.map(c => `<td class="r">${c[1](v)}</td>`).join('')}</tr>`).join('')}
        </tbody></table></div></div>`;
    }

    // Trend
    const units = d.daily.map(x => x.units);
    html += `<div class="card"><div class="card-head"><h3>Units sold per day</h3><p>Peak ${Math.max(0, ...units)} a day · ${units.reduce((a, b) => a + b, 0)} in total</p></div>
      <div id="d-trend">${sparkline(units, 'trend')}</div>
      <div class="trend-axis"><span>${d.daily[0].label}</span><span>${d.daily[d.daily.length - 1].label}</span></div></div>`;

    // Price calculator
    if (e) {
      const lo = Math.max(1, Math.floor(Math.min(e.cost || e.price, e.breakEven || e.price, e.price) * 0.8));
      const hi = Math.ceil(Math.max(e.price * 1.6, Number.isFinite(e.breakEven) ? e.breakEven * 1.25 : 0));
      html += `<div class="card"><div class="card-head"><h3>Try a different price</h3>
          <p>Uses this product's own fees, return rate and ads for the period</p></div>
        <div class="slider-row">
          <input type="range" id="d-price" min="${lo}" max="${hi}" step="1" value="${Math.round(e.price)}" aria-label="Selling price">
          <input type="number" class="price-input" id="d-price-num" min="1" step="1" value="${Math.round(e.price)}" aria-label="Selling price in rand">
        </div>
        <div class="quick-prices">
          <button type="button" class="btn btn-sm" data-p="${Math.round(e.price)}">Now ${R(e.price)}</button>
          ${Number.isFinite(e.breakEven) ? `<button type="button" class="btn btn-sm" data-p="${Math.ceil(e.breakEven)}">Break-even ${R(Math.ceil(e.breakEven))}</button>` : ''}
          <button type="button" class="btn btn-sm" data-p="${Math.round(e.price * 1.1)}">+10%</button>
          <button type="button" class="btn btn-sm" data-p="${Math.round(e.price * 0.9)}">−10%</button>
        </div>
        <div class="what-if" id="d-whatif"></div>
        <table class="breakdown" id="d-breakdown"></table>
        <p class="be-note">${Number.isFinite(e.breakEven)
          ? `Break-even price: <b>${R(Math.ceil(e.breakEven))}</b>${e.breakEven > e.price ? ' — higher than you charge now.' : '.'}`
          : 'Fees and returns are too high to break even at any price.'} Assumes you sell the same number of units; a higher price usually sells fewer.</p>
      </div>`;
    }

    // Stock
    if (s) {
      html += `<div class="card"><div class="card-head"><h3>Stock</h3><p>All channels, based on the last ${PC.CONFIG.RUN_RATE_DAYS} days</p></div>
        <div class="stock-grid">
          <div><span>On hand</span><b>${s.onHand}</b></div>
          <div><span>Days left</span><b class="${s.daysLeft < PC.CONFIG.RUN_OUT_WARNING_DAYS ? 'neg' : ''}">${daysText(s.daysLeft)}</b></div>
          <div><span>Send now</span><b>${s.sendUnits}</b></div>
          <div><span>On the way</span><b>${s.inbound}</b></div>
          <div><span>Sells per day</span><b>${s.perDay.toFixed(1)}</b></div>
          <div><span>Stock value</span><b>${R(s.stockValue)}</b></div>
        </div>
        ${ev && s.eventNeed ? `<p class="be-note">${esc(ev.name)}: expect to need about <b>${s.eventNeed}</b> units by ${ev.end.slice(8)} ${['', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][+ev.end.slice(5, 7)]}${s.eventShort ? ` — <b>short by ${s.eventShort}</b>` : ' — you have enough'}.</p>` : ''}
        ${s.daysLeft > PC.CONFIG.SLOW_STOCK_DAYS ? `<p class="be-note">Slow stock: about ${R(s.excessValue)} is tied up beyond ${PC.CONFIG.TARGET_COVER_DAYS} days of sales.</p>` : ''}
      </div>`;
    }

    // Returns
    if (r && r.returnedUnits) {
      const reasons = Object.entries(r.reasons).sort((a, b) => b[1] - a[1]);
      const top = reasons[0][1];
      html += `<div class="card"><div class="card-head"><h3>Why it comes back</h3><p>${r.returnedUnits} returned · ${r.resellableUnits} could be resold · cost you ${R(r.returnCost)}</p></div>
        ${reasons.map(([why, n]) => `<div class="reason-row"><span>${esc(why)}</span><div class="bar-track"><span class="bar" style="width:${n / top * 100}%"></span></div><b>${n}</b></div>`).join('')}
      </div>`;
    }

    // Ads
    if (r && r.adSpend) {
      html += `<div class="card"><div class="card-head"><h3>Sponsored ads</h3></div>
        <div class="stock-grid">
          <div><span>Spent</span><b>${R(r.adSpend)}</b></div>
          <div><span>Back per R1</span><b>${R(r.roas, 2)}</b></div>
          <div><span>Ads ${r.adProfit < 0 ? 'lost' : 'made'}</span><b class="${r.adProfit < 0 ? 'neg' : ''}">${R(Math.abs(r.adProfit))}</b></div>
        </div></div>`;
    }

    $('d-body').innerHTML = html;
    if (e) wirePrice(e, r);
    const tr = $('d-trend').querySelector('svg');
    if (tr) attachTip(tr, ev2 => { const i = indexAt(tr, ev2, d.daily.length); return `<b>${d.daily[i].label}</b><br>${d.daily[i].units} sold`; });

    $('drawer').classList.add('open');
    $('drawer').setAttribute('aria-hidden', 'false');
    $('scrim').hidden = false;
    $('d-close').focus({ preventScroll: true });
  }

  function wirePrice(e, row) {
    const slider = $('d-price'), box = $('d-price-num');
    const update = P => {
      P = Math.max(1, Number(P) || e.price);
      slider.value = P; box.value = P;
      const unit = e.profitAt(P), margin = e.marginAt(P), period = unit * row.units;
      $('d-whatif').innerHTML = `
        <div><span>Profit per unit</span><b class="${unit < 0 ? 'neg' : 'pos'}">${R(unit, 2)}</b></div>
        <div><span>Margin</span><b class="${margin < 0 ? 'neg' : ''}">${PC.pct(margin)}</b></div>
        <div><span>For ${row.units} units</span><b class="${period < 0 ? 'neg' : 'pos'}">${R(period)}</b></div>`;
      const line = (label, v) => `<tr><td>${label}</td><td>${R(v, 2)}</td></tr>`;
      $('d-breakdown').innerHTML =
        line('Selling price', P) +
        line(`Refunds (${PC.pct(e.returnRate)} come back)`, -P * e.returnRate) +
        line('Success / commission fees', -P * (e.feePct - e.returnRate * (row.refunds > 0 ? row.sfBack / row.refunds : e.feePct))) +
        line('Fulfilment / courier fee', -e.ffPerUnit) +
        line('Stock cost', -e.cost * (1 - e.returnRate * e.resellShare)) +
        (e.adPerUnit ? line('Ads', -e.adPerUnit) : '') +
        `<tr class="total"><td>Profit per unit sold</td><td class="${unit < 0 ? 'neg' : ''}">${R(unit, 2)}</td></tr>`;
    };
    slider.addEventListener('input', () => update(slider.value));
    box.addEventListener('input', () => update(box.value));
    $('d-body').querySelectorAll('[data-p]').forEach(b => b.addEventListener('click', () => update(b.dataset.p)));
    update(Math.round(e.price));
  }

  function closeDrawer() {
    if (!drawerSku) return;
    drawerSku = null;
    $('drawer').classList.remove('open');
    $('drawer').setAttribute('aria-hidden', 'true');
    $('scrim').hidden = true;
    if (lastFocus) lastFocus.focus({ preventScroll: true });
  }
  $('d-close').addEventListener('click', closeDrawer);
  $('scrim').addEventListener('click', closeDrawer);
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeDrawer(); });

  /* =================== Column matching =================== */

  let mapEntries = [];   // { name, parsed, text, type }

  function openMapping() {
    useColumns(isSample);
    mapEntries = [
      ...sources.map(s => ({ name: s.name, parsed: PC.parseCSV(s.text), text: s.text, type: s.type, srcId: s.id })),
      ...pending.map(p => ({ name: p.name, parsed: p.parsed, text: p.text, type: '', pending: true })),
    ];
    if (!mapEntries.length) { toast('Load some files first'); return; }
    renderMapping();
    $('mapping').showModal();
  }

  function renderMapping() {
    $('mapping-body').innerHTML = mapEntries.map((m, i) => {
      const headers = m.parsed.headers;
      const typeSel = `<select data-i="${i}" class="map-type" aria-label="What is in this file">
        <option value="">— What is in this file? —</option>
        ${PC.FILE_TYPES.map(t => `<option value="${t}" ${m.type === t ? 'selected' : ''}>${FILE_LABELS[t]}</option>`).join('')}
      </select>`;
      let fields = '';
      if (m.type) {
        const cols = PC.columnsFor(m.type, headers, true, m.parsed.records), req = PC.CONFIG.REQUIRED[m.type];
        fields = `<div class="map-grid">${Object.keys(cols).map(f => {
          const cur = cols[f] || '';
          const isReq = req.includes(f);
          return `<label class="${isReq ? 'req' : ''}"><span>${PC.FIELD_LABELS[f] || f}</span>
            <select data-i="${i}" data-field="${f}" data-auto="${esc(cur)}" class="${isReq && !cur ? 'missing' : ''}">
              <option value="">— not in my file —</option>
              ${headers.map(h => `<option value="${esc(h)}" ${h === cur ? 'selected' : ''}>${esc(h)}</option>`).join('')}
            </select></label>`;
        }).join('')}</div>`;
      }
      return `<div class="map-file${m.type ? '' : ' unknown'}">
        <div class="map-file-head"><div><b>${esc(m.name)}</b><br><small>${m.parsed.records.length.toLocaleString('en')} rows · ${headers.length} columns</small></div>${typeSel}</div>
        ${fields || '<p class="be-note">Pick what this file contains to match its columns.</p>'}
      </div>`;
    }).join('');
    $('mapping-body').querySelectorAll('.map-type').forEach(s => s.addEventListener('change', () => {
      mapEntries[s.dataset.i].type = s.value; renderMapping();
    }));
    $('mapping-body').querySelectorAll('select[data-field]').forEach(s => s.addEventListener('change', () => {
      s.classList.toggle('missing', PC.CONFIG.REQUIRED[mapEntries[s.dataset.i].type].includes(s.dataset.field) && !s.value);
    }));
  }

  $('mapping-save').addEventListener('click', e => {
    if ($('mapping-body').querySelector('select.missing')) {
      e.preventDefault(); toast('Pick a column for each field marked *'); return;
    }
    const overrides = store.get('pc-columns', {});
    for (const [i, m] of mapEntries.entries()) {
      if (!m.type) continue;
      overrides[m.type] = overrides[m.type] || {};
      $('mapping-body').querySelectorAll(`select[data-i="${i}"][data-field]`).forEach(s => { if (s.value !== s.dataset.auto) overrides[m.type][s.dataset.field] = s.value || null; });   // only what you changed
    }
    store.set('pc-columns', overrides);
    if (isSample && mapEntries.some(m => m.pending && m.type)) { sources = []; isSample = false; }
    useColumns(isSample);
    importNotes = []; loadNotes = [];
    // Loaded files keep their place (their kind may have changed); newly matched files are added
    for (const m of mapEntries) if (m.srcId && m.type) { const s = sources.find(x => x.id === m.srcId); if (s) s.type = m.type; }
    const before = new Set(sources.map(s => s.id));
    for (const m of mapEntries) if (m.pending && m.type) addText(m.name, m.text, { type: m.type });
    settleNewSources(sources.filter(s => !before.has(s.id)));
    pending = mapEntries.filter(m => m.pending && !m.type).map(m => ({ name: m.name, text: m.text, parsed: m.parsed }));
    showFileStatus(loadNotes.concat(importNotes, pending.map(p => `"${p.name}" still not matched`)));
    if (loadNotes.length) toast(loadNotes.join(' '), 5000);
    if (hasSales()) run();
  });
  $('mapping-reset').addEventListener('click', () => {
    if (!confirm('Forget your column matches and go back to the default column names?')) return;
    store.del('pc-columns'); location.reload();
  });
  $('open-mapping').addEventListener('click', openMapping);

  /* =================== Reset everything =================== */
  // Deletes every pc-* setting and saved file on this device plus the offline cache, then reloads blank.
  // The user has to type YES (capitals) first.
  document.querySelectorAll('.open-reset').forEach(b => b.addEventListener('click', () => {
    $('reset-confirm').value = ''; $('reset-go').disabled = true;
    $('reset-dlg').showModal(); $('reset-confirm').focus();
  }));
  $('reset-confirm').addEventListener('input', e => { $('reset-go').disabled = e.target.value.trim() !== 'YES'; });
  $('reset-confirm').addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); if (!$('reset-go').disabled) $('reset-go').click(); }
  });
  $('reset-go').addEventListener('click', async () => {
    if ($('reset-confirm').value.trim() !== 'YES') return;
    $('reset-go').disabled = true; $('reset-go').textContent = 'Resetting…';
    try {
      for (const k of Object.keys(localStorage)) if (k.startsWith('pc-')) localStorage.removeItem(k);
      // Only this app's keys: inside Rails POS the till's own sign-in lives in the same storage
      for (const k of Object.keys(sessionStorage)) if (k.startsWith('pc-')) sessionStorage.removeItem(k);
    } catch (e) {}
    try { if (window.caches) for (const k of await caches.keys()) if (k.startsWith('profit-check')) await caches.delete(k); } catch (e) {}
    try { sessionStorage.setItem('pc-was-reset', '1'); } catch (e) {}
    location.replace(location.pathname);
  });

  /* =================== Tooltip =================== */
  const tip = document.createElement('div');
  tip.className = 'tip'; document.body.appendChild(tip);
  const touch = matchMedia('(hover: none)').matches;
  function attachTip(node, html, clickOpens) {
    const show = e => {
      tip.innerHTML = html(e);
      tip.classList.add('show');
      const w = tip.offsetWidth, h = tip.offsetHeight;
      tip.style.left = Math.min(window.innerWidth - w - 8, Math.max(8, e.clientX + 14)) + 'px';
      tip.style.top = (e.clientY - h - 14 < 8 ? e.clientY + 18 : e.clientY - h - 14) + 'px';
    };
    node.addEventListener('mousemove', show);
    if (!clickOpens) node.addEventListener('click', show);
    node.addEventListener('mouseleave', () => tip.classList.remove('show'));
    if (touch && clickOpens) node.addEventListener('click', () => tip.classList.remove('show'));
  }
  document.addEventListener('scroll', () => tip.classList.remove('show'), { passive: true });

  /* =================== WhatsApp, print, toast =================== */
  $('copy-wa').addEventListener('click', async () => {
    const text = $('wa-preview').textContent;
    try { await navigator.clipboard.writeText(text); }
    catch (e) {                              // older browsers / file:// fallback
      const ta = document.createElement('textarea');
      ta.value = text; document.body.appendChild(ta); ta.select();
      document.execCommand('copy'); ta.remove();
    }
    toast('Copied. Paste it into WhatsApp');
  });
  $('print').addEventListener('click', () => { closeDrawer(); window.print(); });

  function toast(msg, ms = 2600) {
    const t = $('toast'); t.textContent = msg; t.classList.add('show');
    clearTimeout(toast.h); toast.h = setTimeout(() => t.classList.remove('show'), ms);
  }

  /* =================== Start-up =================== */
  // Install-on-phone support only works when the app is served over http(s), not opened as a file.
  // (Not inside Rails POS: the till's own service worker keeps this copy offline.)
  if (!HOST && !window.PC_REQUIRE_HOST && 'serviceWorker' in navigator && /^https?:$/.test(location.protocol)) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }

  const saved = store.get('pc-data', null);
  // v2 keeps every file ("sources"); the older format kept one file per kind ("files")
  let savedSources = saved && (saved.sources
    || Object.entries(saved.files || {}).map(([type, text]) => ({ id: newId(), type, name: `${FILE_LABELS[type] || type} file`, text, addedAt: saved.savedAt })));
  (async () => {
  if (HOST) {
    // Inside Rails POS: no sample data; the till's file first, then any files uploaded here before
    $('use-sample').hidden = true;
    const kept = saved && !saved.sample ? (savedSources || []).filter(s => s.id !== TILL_ID) : [];
    let till = null;
    try { till = HOST.tillData ? await HOST.tillData() : HOST.tillCsv(); } catch (e) { till = null; }
    tillExtras = till && till.extras ? till.extras : null;
    const tillType = till && till.text ? PC.detectFileType(PC.parseCSV(till.text).headers) : null;
    savedSources = (tillType ? [{ id: TILL_ID, type: tillType, name: till.name, text: till.text, addedAt: new Date().toISOString() }] : []).concat(kept);
    if (!tillType) showFileStatus(['No till sales yet. Make a few sales in Rails POS, or add files here.']);
  }
  if (savedSources && savedSources.some(s => s.type === 'sales')) {
    if (HOST) { isSample = false; sources = savedSources; fromSaved = null; run({ fromStorage: true }); } else {
    isSample = !!saved.sample;
    sources = savedSources;
    fromSaved = saved;
    run({ fromStorage: true });
    }
  } else {
    useColumns(false);
    // Files kept without a sales file (e.g. only stock so far): keep them and say so
    if (savedSources && savedSources.length && !saved.sample) {
      sources = savedSources;
      showFileStatus(['Add a sales file to see results. Already loaded: ' + sources.map(s => `"${s.name}"`).join(', ') + '.']);
    }
  }
  try {
    if (sessionStorage.getItem('pc-was-reset')) { sessionStorage.removeItem('pc-was-reset'); toast('Everything was reset. Rails Profit checker is back to its defaults.', 4000); }
  } catch (e) {}
  })();
})();
