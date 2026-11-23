/* ==========================================================================
   importers.js — turns PDF and Excel files into CSV text, so the rest of the
   app treats them exactly like a CSV. No profit maths here.

   - Excel (.xlsx/.xls/.ods): every sheet becomes a table. Title rows above the
     real header row are skipped.
   - PDF with real text (most system reports, "Save as PDF" in Chrome/Edge):
     the words and their positions are read and rebuilt into rows and columns.
   - PDF without text (scans, photos, "Microsoft Print to PDF"): each page is
     read with OCR (text recognition) in your browser, then rebuilt the same way.
     OCR can misread a character, so check the numbers it gives you.

   Nothing is uploaded anywhere. The reading libraries are downloaded from a
   CDN the first time you open a PDF or Excel file (OCR also downloads about
   15 MB of English language data once), so that first time needs internet.
   ========================================================================== */
(function () {
  const LIBS = {
    pdf: 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js',
    pdfWorker: 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js',
    ocr: 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js',
    xlsx: 'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js',
  };
  const MIN_TEXT_ITEMS = 5;       // fewer text pieces than this on a page = treat it as a picture and OCR it
  const OCR = {
    scale: 3,          // render pages 3× for OCR (small print reads better)
    threshold: 170,    // pixels darker than this become black, the rest white (drops faint table lines, sharpens coloured text)
    psm: '6',          // Tesseract "one block of text" mode: tested best on till reports (mode 11 missed single digits)
  };

  const debug = { pages: {} };
  const loaded = {};
  function loadScript(url) {
    return loaded[url] || (loaded[url] = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = url; s.onload = resolve;
      s.onerror = () => { delete loaded[url]; reject(new Error('could not download the PDF/Excel reader. Check your internet connection and try again.')); };
      document.head.appendChild(s);
    }));
  }

  async function loadPdfJs() {
    await loadScript(LIBS.pdf);
    if (!pdfjsLib.GlobalWorkerOptions.workerSrc) {
      // A worker from another site can't be started directly, so wrap it in a local blob.
      try {
        const code = await (await fetch(LIBS.pdfWorker)).text();
        pdfjsLib.GlobalWorkerOptions.workerSrc = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }));
      } catch (e) { pdfjsLib.GlobalWorkerOptions.workerSrc = LIBS.pdfWorker; }
    }
  }

  /* ---------------------------- Words → tables ---------------------------- */

  const median = a => { const s = [...a].sort((x, y) => x - y); return s.length ? s[s.length >> 1] : 0; };
  const DATE_RX = /^(?:(?:mon|tue|wed|thu|fri|sat|sun)[a-z]*\.?,?\s+)?(\d{4}[-/]\d{1,2}[-/]\d{1,2}|\d{1,2}[-/]\d{1,2}[-/]\d{2,4}|\d{1,2}[\s-][A-Za-z]{3,9}[\s,-]+\d{4})/i;

  /** OCR often reads 0 as O and 1 as l or I inside numbers. Fix that only in cells that are clearly numbers. */
  function fixOcrNumber(s) {
    if (!/^[-−R(]*\s?[\dOoIl|S ,.]+\)?%?$/.test(s)) return s;
    const core = s.replace(/^[-−R(]+/, '').replace(/[\s,.)%]/g, '');
    if (core.length < 2 || !/\d/.test(core)) return s;      // needs at least one real digit ("RO.00" yes, "Il" no)
    return s.replace(/[Oo]/g, '0').replace(/[Il|]/g, '1').replace(/S/g, '5').replace('−', '-');
  }

  /**
   * words = [{ str, x0, x1, y0, y1 }] in page units, y going down.
   * Returns [{ header: [...], rows: [[...]], generatedHeader }] — every table-looking block on the page.
   * Steps: words → lines (same height) → cells (words close together) → runs of lines with
   * 2+ cells → columns (cells that overlap sideways) → header + rows, dropping total lines.
   */
  function wordsToTables(words) {
    // (a lone "!" is Rails POS's low-stock mark next to a quantity)
    words = words.filter(w => w.str && w.str.trim() && !/^[|_—–\-=.·:~'"`,!]+$/.test(w.str.trim()));
    if (!words.length) return [];
    const H = median(words.map(w => w.y1 - w.y0)) || 10;

    // 1. Lines
    const lines = [];
    for (const w of [...words].sort((a, b) => (a.y0 + a.y1) - (b.y0 + b.y1))) {
      const cy = (w.y0 + w.y1) / 2, last = lines[lines.length - 1];
      if (last && Math.abs(last.cy - cy) < H * 0.55) { last.words.push(w); last.cy += (cy - last.cy) / last.words.length; }
      else lines.push({ cy, words: [w] });
    }

    // 2. Cells: words closer than ~0.8 × text height belong together ("R1 247.00", "Summer Wrap Dress")
    for (const line of lines) {
      line.cells = [];
      for (const w of line.words.sort((a, b) => a.x0 - b.x0)) {
        const c = line.cells[line.cells.length - 1];
        if (c && w.x0 - c.x1 < H * 0.8) { c.text += ' ' + w.str.trim(); c.x1 = Math.max(c.x1, w.x1); }
        else line.cells.push({ text: w.str.trim(), x0: w.x0, x1: w.x1 });
      }
    }

    // 3. Runs of lines that look like table rows
    const gaps = lines.slice(1).map((l, i) => l.cy - lines[i].cy);
    const rowGap = median(gaps) || H * 2;
    const runs = [];
    let run = [];
    lines.forEach((line, i) => {
      const brokeGap = i > 0 && line.cy - lines[i - 1].cy > rowGap * 1.8;
      if (line.cells.length < 2) {
        // A single piece of text between two table rows is a caption (e.g. the category printed
        // under a product name). Skip it without ending the table.
        const next = lines[i + 1];
        if (run.length && !brokeGap && next && next.cells.length >= 2 && next.cy - line.cy <= rowGap * 1.8) return;
        if (run.length >= 2) runs.push(run);
        run = [];
        return;
      }
      if (brokeGap) { if (run.length >= 2) runs.push(run); run = []; }
      run.push(line);
    });
    if (run.length >= 2) runs.push(run);

    const tables = [];
    for (let r of runs) {
      // Drop section titles above the table ("CATEGORIES   TOP SELLERS") — far fewer cells than the rows
      const maxCells = Math.max(...r.map(l => l.cells.length));
      while (r.length > 2 && r[0].cells.length < maxCells * 0.6) r = r.slice(1);

      // 4. Columns: cluster cells of the most common row shape by sideways overlap
      const counts = {};
      r.forEach(l => { counts[l.cells.length] = (counts[l.cells.length] || 0) + 1; });
      const typical = +Object.entries(counts).sort((a, b) => b[1] - a[1] || b[0] - a[0])[0][0];
      const spans = r.filter(l => l.cells.length === typical).flatMap(l => l.cells).sort((a, b) => a.x0 - b.x0);
      const cols = [];
      for (const c of spans) {
        const last = cols[cols.length - 1];
        if (last && c.x0 <= last.x1 + H * 0.2) last.x1 = Math.max(last.x1, c.x1);
        else cols.push({ x0: c.x0, x1: c.x1 });
      }
      const overlap = (c, col) => Math.min(c.x1, col.x1) - Math.max(c.x0, col.x0);
      const place = c => {
        let best = -1, bestOv = 0;
        cols.forEach((col, i) => { const ov = overlap(c, col); if (ov > bestOv) { bestOv = ov; best = i; } });
        return best;
      };
      // Cells (usually header words) that sit over an empty column become columns of their own
      for (const l of r) for (const c of l.cells) if (place(c) < 0) cols.push({ x0: c.x0, x1: c.x1 });
      cols.sort((a, b) => a.x0 - b.x0);

      const grid = r.map(l => {
        const row = cols.map(() => '');
        for (const c of l.cells) {
          let i = place(c);
          if (i < 0) i = cols.reduce((bi, col, j) => Math.abs((col.x0 + col.x1) / 2 - (c.x0 + c.x1) / 2) < Math.abs((cols[bi].x0 + cols[bi].x1) / 2 - (c.x0 + c.x1) / 2) ? j : bi, 0);
          row[i] = row[i] ? row[i] + ' ' + c.text : c.text;
        }
        return row;
      });

      // 5. Header: the first line, if it has no numbers in it
      let header, rows, filledDown = false;
      if (!grid[0].some(v => /\d/.test(v.replace(/^#$/, ''))) && grid[0].filter(Boolean).length >= 2) {
        header = grid[0].map((h, i) => h || `Column ${i + 1}`); rows = grid.slice(1);
      } else {
        header = cols.map((_, i) => `Column ${i + 1}`); rows = grid;
      }
      header = header.map((h, i) => (header.indexOf(h) !== i ? `${h} ${i + 1}` : h));   // no duplicate names

      // Grouped reports print a product's name only on its first row ("Leather Belt", then
      // its other sizes below with the name left blank). Fill the name down into those rows.
      const blanks = rows.filter(x => !x[0] && x.some(Boolean)).length;
      const textish = rows.filter(x => x[0] && !/^[\d\s.,R%#:/-]+$/.test(x[0])).length;
      if (rows.length && blanks >= rows.length * 0.2 && textish >= (rows.length - blanks) * 0.7) {
        let last = '';
        rows = rows.map(x => { if (x[0]) last = x[0]; else if (last && x.some(Boolean) && !/\btotals?\b/i.test(x.join(' '))) x = [last, ...x.slice(1)]; return x; });
        filledDown = true;
      }

      // 6. Drop total lines: where a column is mostly dates, rows without a date there are totals/notes
      // (the last dropped line is kept as `totals`, to check what was read against the PDF's own totals)
      let totals = null;
      const dateCol = header.findIndex((_, i) => rows.length >= 2 && rows.filter(x => DATE_RX.test(x[i])).length >= rows.length * 0.7);
      if (dateCol >= 0) {
        const dropped = rows.filter(x => !DATE_RX.test(x[dateCol]));
        // the totals line is the dropped line with the most numbers in it (not a "Printed by…" footer)
        const nums = x => x.filter(v => Number.isFinite(window.ProfitCheck.toNumber(v))).length;
        totals = dropped.reduce((best, x) => (nums(x) >= (best ? nums(best) : 1) ? x : best), null);
        rows = rows.filter(x => DATE_RX.test(x[dateCol]));
      } else {
        // No date column: the table ends at its "Total" line; anything after it is a footer
        const ti = rows.findIndex((x, i) => i >= 1 && /^(grand\s+)?totals?\b/i.test(x.find(Boolean) || ''));
        if (ti >= 1) { totals = rows[ti]; rows = rows.slice(0, ti); }
      }
      if (rows.length < 2) continue;     // a one-line block is a heading or a single figure, not a table

      // Remove columns with no header and no values
      const keep = header.map((h, i) => !/^Column \d+$/.test(h) || rows.some(x => x[i]));
      tables.push({
        header: header.filter((_, i) => keep[i]),
        rows: rows.map(x => x.filter((_, i) => keep[i])),
        totals: totals && totals.filter((_, i) => keep[i]),
        generatedHeader: header.every(h => /^Column \d+$/.test(h)), filledDown,
      });
    }
    return tables;
  }

  const csvCell = v => (/[",\n;]/.test(v) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
  function tableToCSVText(t) {
    return [t.header, ...t.rows].map(r => r.map(csvCell).join(',')).join('\n') + '\n';
  }

  /**
   * Compares what was read with the table's own totals line ("24 sales · 56 · R22 844.00").
   * Returns plain-English problems, e.g. 'Total adds up to R20 550.00 but the file says R22 844.00'.
   */
  function checkTotals(t) {
    if (!t.totals) return [];
    const toNum = window.ProfitCheck.toNumber;
    const issues = [];
    const count = t.totals.join(' ').match(/^\s*(\d+)\s+(sales|orders|transactions|invoices|rows|lines|items)\b/i);
    if (count && +count[1] !== t.rows.length) issues.push(`found ${t.rows.length} ${count[2]} but the file says ${count[1]}`);
    t.header.forEach((h, i) => {
      const want = toNum(t.totals[i]);
      if (!Number.isFinite(want) || (i === 0 && count)) return;
      const vals = t.rows.map(r => toNum(r[i]));
      const numeric = vals.filter(Number.isFinite).length;
      if (numeric < t.rows.length * 0.5) return;
      const got = vals.reduce((s, v) => s + (Number.isFinite(v) ? v : 0), 0);
      if (Math.abs(got - want) > 0.5) {
        const blanks = t.rows.length - numeric;
        issues.push(`${h} adds up to ${got.toFixed(2)} but the file says ${t.totals[i]}` + (blanks ? ` (${blanks} value${blanks > 1 ? 's' : ''} couldn't be read)` : ''));
      }
    });
    return issues;
  }

  /** Tables that carry on across pages get joined (same header, or page 2 has no header of its own). */
  function joinPages(tables) {
    const out = [];
    for (const t of tables) {
      const prev = out[out.length - 1];
      const sameHeader = prev && prev.header.join('|') === t.header.join('|') && !t.generatedHeader;
      const continued = prev && t.generatedHeader && t.page === prev.lastPage + 1 && t.header.length === prev.header.length;
      if (prev && (sameHeader || continued)) {
        // A product continued from the previous page has no name on its first rows: carry it over
        let carry = prev.rows.length ? prev.rows[prev.rows.length - 1][0] : '';
        const fill = prev.filledDown || t.filledDown;
        for (const r of t.rows) { if (!r[0] && fill && carry) r[0] = carry; else if (r[0]) carry = r[0]; }
        prev.rows.push(...t.rows); prev.lastPage = t.page; prev.totals = t.totals || prev.totals;
      }
      else out.push({ ...t, rows: [...t.rows], lastPage: t.page });
    }
    return out;
  }

  /* --------------------------------- PDF ---------------------------------- */

  async function ocrWordsFrom(data) {
    if (data.words && data.words.length) return data.words;
    const words = [];
    for (const b of data.blocks || []) for (const p of b.paragraphs || []) for (const l of p.lines || []) words.push(...(l.words || []));
    return words;
  }

  async function readPdf(file, progress) {
    progress('Opening PDF…');
    await loadPdfJs();
    const doc = await pdfjsLib.getDocument({ data: await file.arrayBuffer() }).promise;
    const tables = [];
    debug.pages = {};
    let ocr = null, usedOcr = false;
    try {
      for (let n = 1; n <= doc.numPages; n++) {
        const page = await doc.getPage(n);
        const vp = page.getViewport({ scale: 1 });
        const tc = await page.getTextContent();
        let words = tc.items.filter(i => i.str && i.str.trim()).map(i => {
          const [x, y] = vp.convertToViewportPoint(i.transform[4], i.transform[5]);
          const h = Math.hypot(i.transform[2], i.transform[3]) || i.height || 10;
          return { str: i.str, x0: x, x1: x + i.width, y0: y - h, y1: y };
        });
        if (words.length < MIN_TEXT_ITEMS) {
          usedOcr = true;
          if (!ocr) {
            progress('This PDF is a picture of the page, so it needs reading with OCR. Downloading the reader (first time only)…');
            await loadScript(LIBS.ocr);
            ocr = await Tesseract.createWorker('eng', 1, {
              logger: m => { if (m.status === 'recognizing text') progress(`Reading page ${n} of ${doc.numPages} with OCR… ${Math.round(m.progress * 100)}%`); },
            });
            await ocr.setParameters({ tessedit_pageseg_mode: OCR.psm, user_defined_dpi: '300' });
          }
          progress(`Reading page ${n} of ${doc.numPages} with OCR…`);
          const v = page.getViewport({ scale: OCR.scale });
          const canvas = document.createElement('canvas');
          canvas.width = Math.ceil(v.width); canvas.height = Math.ceil(v.height);
          const ctx = canvas.getContext('2d', { willReadFrequently: true });
          ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
          await page.render({ canvasContext: ctx, viewport: v }).promise;
          if (OCR.threshold) {
            // Black-and-white copy: coloured numbers turn solid black, faint grid lines disappear
            const img = ctx.getImageData(0, 0, canvas.width, canvas.height), px = img.data;
            for (let k = 0; k < px.length; k += 4) {
              const lum = 0.299 * px[k] + 0.587 * px[k + 1] + 0.114 * px[k + 2];
              px[k] = px[k + 1] = px[k + 2] = lum < OCR.threshold ? 0 : 255;
            }
            ctx.putImageData(img, 0, 0);
          }
          const { data } = await ocr.recognize(canvas, {}, { blocks: true });
          words = (await ocrWordsFrom(data)).map(w => ({
            str: fixOcrNumber(w.text), x0: w.bbox.x0 / OCR.scale, x1: w.bbox.x1 / OCR.scale, y0: w.bbox.y0 / OCR.scale, y1: w.bbox.y1 / OCR.scale,
          }));
        } else progress(`Reading page ${n} of ${doc.numPages}…`);
        debug.pages[n] = words;   // for troubleshooting: PCImport.debug.pages[1] = the words found on page 1
        for (const t of wordsToTables(words)) tables.push({ ...t, page: n });
      }
    } finally {
      if (ocr) await ocr.terminate();
    }
    let joined = joinPages(tables);
    // A known report (Rails POS print-outs): keep only its main table and say what it is
    const report = knownReport(Object.values(debug.pages).flat());
    if (report) {
      if (!report.type) return [{ note: report.note, csv: '', ocr: usedOcr }];
      const main = joined.filter(t => report.pick(t.header.map(h => h.toLowerCase())));
      if (main.length) joined = main.map(t => ({ ...(report.repair ? report.repair(t) : t), type: report.type }));
    }
    return joined.map((t, i, all) => ({
      label: all.length > 1 ? `table ${i + 1} (page ${t.page}${t.lastPage > t.page ? '–' + t.lastPage : ''}, ${t.rows.length} rows)` : '',
      csv: tableToCSVText(t), ocr: usedOcr, issues: checkTotals(t), type: t.type || null, report: report && report.title,
    }));
  }

  /* ------------------------- Known reports (by title) ------------------------
     Rails POS A4 print-outs say which report they are at the top. When we see that,
     we know which table holds the data and what kind it is, so nothing has to be
     matched by hand and the report's other boxes and tables are left out.
     ------------------------------------------------------------------------- */
  const has = (hs, ...names) => names.every(n => hs.some(h => h === n || h.startsWith(n + ' ')));
  const KNOWN_REPORTS = [
    { title: 'stock on hand', type: 'stock', pick: hs => has(hs, 'sku') && hs.some(h => /^(qty|quantity|stock)\b/.test(h)), repair: repairStockList },
    { title: 'sales list', type: 'sales', pick: hs => has(hs, 'date') },
    { title: 'sales summary', type: 'sales', pick: hs => has(hs, 'day') },
    { title: 'reorder list', note: 'a reorder list (what to buy)' },
    { title: 'cash-ups', note: 'a cash-up report' },
    { title: 'staff sales', note: 'a staff sales report' },
    { title: 'best sellers', note: 'a best-sellers ranking with no dates' },
  ];
  /**
   * Rails POS "Stock on hand": every row also prints Cost and Cost value (= Qty × Cost), so a
   * misread quantity can be put right (OCR reads the low-stock mark "2 !" as "21", for example).
   * Two sizes whose codes were misread into the same code are kept apart by adding the size.
   */
  function repairStockList(t) {
    const H = t.header.map(h => h.toLowerCase());
    const qi = H.findIndex(h => /^(qty|quantity)\b/.test(h)), ci = H.indexOf('cost'), vi = H.indexOf('cost value');
    const si = H.indexOf('sku'), zi = H.findIndex(h => h.startsWith('size'));
    const num = v => window.ProfitCheck.toNumber(v);
    let fixed = 0;
    const seen = new Set();
    const rows = t.rows.map(r => {
      r = [...r];
      if (qi >= 0 && ci >= 0 && vi >= 0) {
        const q = num(r[qi]), c = num(r[ci]), v = num(r[vi]);
        const fromValue = c > 0 && Number.isFinite(v) ? v / c : NaN;
        if (Number.isFinite(fromValue) && Math.abs(fromValue - Math.round(fromValue)) < 0.01 && Math.round(fromValue) !== q) {
          r[qi] = String(Math.round(fromValue)); fixed++;
        }
      }
      if (si >= 0 && r[si]) {
        if (seen.has(r[si].toUpperCase()) && zi >= 0 && r[zi]) r[si] = `${r[si]} (${r[zi]})`;
        seen.add(r[si].toUpperCase());
      }
      return r;
    });
    return { ...t, rows, repaired: fixed };
  }

  function knownReport(words) {
    const text = words.map(w => w.str).join(' ').toLowerCase().replace(/\s+/g, ' ');
    if (!/rails\s?pos/.test(text)) return null;
    const r = KNOWN_REPORTS.find(k => text.includes(k.title));
    if (!r) return null;
    if (!r.type) return { ...r, note: `This is a Rails POS ${r.note}, which Rails Profit checker doesn't use. Load the Sales list, Sales summary or Stock on hand report instead, or better: Reports → Export for Profit checker.` };
    return r;
  }

  /* -------------------------------- Excel --------------------------------- */

  async function readExcel(file, progress) {
    progress('Opening spreadsheet…');
    await loadScript(LIBS.xlsx);
    const wb = XLSX.read(await file.arrayBuffer(), { type: 'array', cellDates: true });
    const out = [];
    for (const name of wb.SheetNames) {
      const grid = XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, raw: false, dateNF: 'yyyy-mm-dd', defval: '', blankrows: false })
        .map(r => r.map(v => String(v).trim()));
      if (!grid.length) continue;
      // Header = first row that fills most of the columns (skips report titles above the table)
      const filled = r => r.filter(Boolean).length;
      const widest = Math.max(...grid.map(filled));
      const h = grid.findIndex(r => filled(r) >= Math.max(2, widest * 0.6));
      if (h < 0 || h === grid.length - 1) continue;
      const header = grid[h].map((v, i) => v || `Column ${i + 1}`);
      const rows = grid.slice(h + 1).filter(r => filled(r) > 0);
      out.push({ label: wb.SheetNames.length > 1 ? `sheet "${name}"` : '', csv: tableToCSVText({ header, rows }) });
    }
    return out;
  }

  /** file → [{ label, csv, ocr? }]. Throws with a readable message if it can't. */
  async function read(file, progress = () => {}) {
    if (/\.pdf$/i.test(file.name) || file.type === 'application/pdf') return readPdf(file, progress);
    if (/\.(xlsx|xlsm|xlsb|xls|ods)$/i.test(file.name)) return readExcel(file, progress);
    return [{ label: '', csv: await file.text() }];
  }
  const isSpecial = file => /\.(pdf|xlsx|xlsm|xlsb|xls|ods)$/i.test(file.name) || file.type === 'application/pdf';

  window.PCImport = { read, isSpecial, wordsToTables, tableToCSVText, joinPages, fixOcrNumber, checkTotals, OCR, debug };
})();
