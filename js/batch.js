// ═══════════════════════════════════════════════
//  batch.js — Multiple DOI batch processing
// ═══════════════════════════════════════════════

let batchResults = [];
let batchActiveIdx = -1;
let batchActiveDir = 'backward'; // 'backward' or 'forward'

function startBatch() {
  const raw = document.getElementById('batchDoiInput').value.trim();
  if (!raw) { setStatus('error', 'Please paste one or more DOIs (one per line).'); return; }

  const dois = raw.split(/[\n\r]+/)
    .map(l => cleanDOI(l.trim()))
    .filter(d => d.length > 5 && d.includes('/'));

  if (!dois.length) { setStatus('error', 'No valid DOIs found. Paste one DOI per line.'); return; }

  batchResults = dois.map(doi => ({
    doi, title: doi, authors: '', year: '', journal: '',
    backward: [], forward: [], status: 'pending'
  }));
  batchActiveIdx = 0;
  batchActiveDir = 'backward';

  renderBatchTabs();
  document.getElementById('batchResultsArea').innerHTML = '';
  runBatchSequential();
}

async function runBatchSequential() {
  for (let i = 0; i < batchResults.length; i++) {
    const entry = batchResults[i];
    batchActiveIdx = i;
    renderBatchTabs();

    try {
      // Metadata
      setStatus('loading', `[${i + 1}/${batchResults.length}] Fetching metadata: ${entry.doi}…`);
      const info = await fetchArticleInfo(entry.doi);
      if (info.title) {
        entry.title = info.title;
        entry.authors = info.authors;
        entry.year = info.year;
        entry.journal = info.journal;
      }
      renderBatchTabs();

      // Backward
      setStatus('loading', `[${i + 1}/${batchResults.length}] ← Backward chasing…`);
      const refs = await fetchFromAPIs(entry.doi);
      const noDoi = refs.filter(r => !r.doi).length;
      if (noDoi > 0 && noDoi <= 30) {
        await enrichRefsWithDOIs(refs);
      }
      entry.backward = refs;

      // Forward
      setStatus('loading', `[${i + 1}/${batchResults.length}] → Forward chasing…`);
      entry.forward = await fetchCitingArticles(entry.doi);

      entry.status = (entry.backward.length || entry.forward.length) ? 'done' : 'warn';
    } catch (e) {
      console.error(e);
      entry.status = 'error';
    }

    renderBatchTabs();
    if (batchActiveIdx === i) showBatchResult(i);

    if (i < batchResults.length - 1) await new Promise(r => setTimeout(r, 500));
  }

  const totalBack = batchResults.reduce((s, e) => s + e.backward.length, 0);
  const totalFwd = batchResults.reduce((s, e) => s + e.forward.length, 0);
  const doneCount = batchResults.filter(e => e.status === 'done').length;
  setStatus('success',
    `Batch complete: ${doneCount}/${batchResults.length} articles. ` +
    `← ${totalBack} backward refs · → ${totalFwd} forward citations.`
  );
}

function renderBatchTabs() {
  const container = document.getElementById('batchTabs');
  container.innerHTML = batchResults.map((entry, i) => {
    const isActive = i === batchActiveIdx;
    const statusIcon = entry.status === 'done' ? '✓'
      : entry.status === 'error' ? '✗'
      : entry.status === 'warn' ? '⚠' : '…';
    let label = entry.doi.slice(0, 20);
    if (entry.title && entry.title !== entry.doi) {
      label = entry.title.length > 30 ? entry.title.slice(0, 28) + '…' : entry.title;
    }
    if (entry.year) label += ` (${entry.year})`;
    const total = entry.backward.length + entry.forward.length;

    return `<button class="batch-tab ${isActive ? 'active' : ''} ${entry.status}"
      onclick="switchBatchTab(${i})" title="${esc(entry.title)}\n${entry.doi}">
      <span class="batch-tab-status">${statusIcon}</span>
      <span class="batch-tab-label">${esc(label)}</span>
      <span class="batch-tab-count">${total}</span>
    </button>`;
  }).join('');
  renderBatchExportBar();
}

// ── Batch-wide export bar: one RIS with every backward ref, one with every forward ──
function renderBatchExportBar() {
  const bar = document.getElementById('batchExportBar');
  if (!bar) return;
  if (!batchResults.length) { bar.innerHTML = ''; bar.style.display = 'none'; return; }
  const totalBack = batchResults.reduce((s, e) => s + e.backward.length, 0);
  const totalFwd = batchResults.reduce((s, e) => s + e.forward.length, 0);
  bar.style.display = 'flex';
  bar.innerHTML =
    `<span class="batch-export-label">Export all ${batchResults.length} papers:</span>` +
    `<button class="btn-sm" onclick="exportAllBackwardRIS()">⬇ Backward RIS (${totalBack})</button>` +
    `<button class="btn-sm" onclick="exportAllForwardRIS()">⬇ Forward RIS (${totalFwd})</button>` +
    `<button class="btn-sm" onclick="exportAllBatchCSV()">⬇ All CSV</button>`;
}

function switchBatchTab(idx) {
  batchActiveIdx = idx;
  batchActiveDir = 'backward';
  renderBatchTabs();
  showBatchResult(idx);
}

function switchBatchDir(dir) {
  batchActiveDir = dir;
  showBatchResult(batchActiveIdx);
}

function showBatchResult(idx) {
  const entry = batchResults[idx];
  if (!entry) return;
  selectionEnabled = false; // no per-ref checkboxes in batch mode
  const area = document.getElementById('batchResultsArea');
  const dir = batchActiveDir;
  const refs = dir === 'backward' ? entry.backward : entry.forward;

  // Article card
  let html = `<div class="article-card">
    <div class="article-card-label">Article ${idx + 1}/${batchResults.length}</div>
    <div class="article-card-title">${esc(entry.title)}</div>
    <div class="article-card-meta">`;
  const meta = [];
  if (entry.authors) meta.push(esc(entry.authors));
  if (entry.year) meta.push(entry.year);
  if (entry.journal) meta.push('<em>' + esc(entry.journal) + '</em>');
  meta.push('<a href="https://doi.org/' + esc(entry.doi) + '" target="_blank">' + esc(entry.doi) + '</a>');
  html += meta.join(' · ') + '</div></div>';

  // Direction sub-tabs
  html += `<div class="dir-tabs" style="margin-bottom:1rem">
    <button class="dir-tab ${dir === 'backward' ? 'active' : ''}" data-dir="backward" onclick="switchBatchDir('backward')">
      ← Backward <span class="dir-count">${entry.backward.length}</span>
    </button>
    <button class="dir-tab ${dir === 'forward' ? 'active' : ''}" data-dir="forward" onclick="switchBatchDir('forward')">
      → Forward <span class="dir-count">${entry.forward.length}</span>
    </button>
  </div>`;

  if (!refs.length) {
    html += '<div class="no-results">' +
      (entry.status === 'pending' ? 'Processing…' : `No ${dir} results for this article.`) + '</div>';
    area.innerHTML = html;
    return;
  }

  allRefs = refs;
  const heading = dir === 'backward' ? '← Cited References' : '→ Citing Articles';

  html += `<div class="results">
    <div class="results-header"><h2>${heading}</h2><span class="badge">${refs.length} ref${refs.length > 1 ? 's' : ''}</span></div>
    <div class="toolbar">
      <input type="text" class="search-box" id="searchBox" placeholder="Filter…" oninput="filterRefs()">
      <button class="btn-sm" onclick="exportBatchRIS()">⬇ RIS</button>
      <button class="btn-sm" onclick="exportBatchCSV()">⬇ CSV</button>
      <button class="btn-sm" onclick="copyAll()">⎘ DOIs</button>
    </div>
    <ul class="ref-list" id="refList"></ul></div>`;

  area.innerHTML = html;
  renderList(refs);
}

// ── Per-paper RIS (current tab + current direction), named after the source ──
async function exportBatchRIS() {
  const entry = batchResults[batchActiveIdx];
  if (!entry) return;
  const refs = batchActiveDir === 'backward' ? entry.backward : entry.forward;
  if (!refs.length) { showToast('No references to export'); return; }
  setStatus('loading', `Fetching abstracts for ${refs.length} references…`);
  await fetchAbstractsForRefs(refs);
  const filename = exportFilenameBase(entry, batchActiveDir) + '.ris';
  downloadRIS(refs, filename);
  setStatus('success', `RIS: ${refs.length} reference${refs.length > 1 ? 's' : ''} exported → ${filename}`);
  showToast(`RIS: ${refs.length} exported → ${filename}`);
}

// ── Per-paper CSV (current tab + current direction), named after the source ──
async function exportBatchCSV() {
  const entry = batchResults[batchActiveIdx];
  if (!entry) return;
  const refs = batchActiveDir === 'backward' ? entry.backward : entry.forward;
  if (!refs.length) { showToast('No references to export'); return; }
  setStatus('loading', `Fetching abstracts for ${refs.length} references…`);
  await fetchAbstractsForRefs(refs);
  const filename = exportFilenameBase(entry, batchActiveDir) + '.csv';
  downloadCSV(refs, filename);
  setStatus('success', `CSV: ${refs.length} reference${refs.length > 1 ? 's' : ''} exported → ${filename}`);
  showToast(`CSV: ${refs.length} exported → ${filename}`);
}

// ── Bulk RIS: every backward (or forward) ref across all batched papers ──
// Kept un-deduplicated: a ref cited by N source papers appears N times.
function exportAllBackwardRIS() { return exportAllDirectionRIS('backward'); }
function exportAllForwardRIS() { return exportAllDirectionRIS('forward'); }

async function exportAllDirectionRIS(dir) {
  const refs = [];
  for (const e of batchResults) {
    const arr = dir === 'backward' ? e.backward : e.forward;
    refs.push(...arr);
  }
  if (!refs.length) { showToast(`No ${dir} references to export`); return; }
  setStatus('loading', `Fetching abstracts for ${refs.length} ${dir} references…`);
  await fetchAbstractsForRefs(refs);
  downloadRIS(refs, `all_${dir}_snowball.ris`);
  setStatus('success',
    `RIS: ${refs.length} ${dir} reference${refs.length > 1 ? 's' : ''} exported from ${batchResults.length} papers → all_${dir}_snowball.ris`);
  showToast(`RIS: ${refs.length} ${dir} refs exported`);
}

async function exportAllBatchCSV() {
  const all = [];
  for (const e of batchResults) { all.push(...e.backward, ...e.forward); }
  setStatus('loading', `Fetching abstracts for ${all.length} references…`);
  await fetchAbstractsForRefs(all);
  const h = 'Direction,Source_DOI,Source_Title,Ref_Number,Ref_Title,Ref_DOI,Ref_Authors,Ref_Year,Ref_Abstract';
  const rows = [];
  const ab = r => csvCell(String(r.abstract || '').replace(/\s+/g, ' ').trim());
  for (const entry of batchResults) {
    entry.backward.forEach((r, i) => {
      rows.push(`"backward",${csvCell(entry.doi)},${csvCell(entry.title || '')},${i + 1},${csvCell(r.title || '')},${csvCell(r.doi || '')},${csvCell(r.authors || '')},${csvCell(r.year || '')},${ab(r)}`);
    });
    entry.forward.forEach((r, i) => {
      rows.push(`"forward",${csvCell(entry.doi)},${csvCell(entry.title || '')},${i + 1},${csvCell(r.title || '')},${csvCell(r.doi || '')},${csvCell(r.authors || '')},${csvCell(r.year || '')},${ab(r)}`);
    });
  }
  const b = new Blob(['\ufeff' + h + '\n' + rows.join('\n')], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(b);
  a.download = 'citations_batch_snowball.csv';
  a.click();
  const totalBack = batchResults.reduce((s, e) => s + e.backward.length, 0);
  const totalFwd = batchResults.reduce((s, e) => s + e.forward.length, 0);
  setStatus('success', `CSV: ← ${totalBack} + → ${totalFwd} refs (with abstracts) from ${batchResults.length} papers.`);
  showToast(`CSV: ← ${totalBack} backward + → ${totalFwd} forward from ${batchResults.length} articles`);
}
