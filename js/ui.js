// ═══════════════════════════════════════════════
//  ui.js — Rendering, filtering, export
// ═══════════════════════════════════════════════

// Selection (single-article mode only): each rendered ref gets a checkbox whose
// state is stored on the ref object as `_sel`. Off in batch mode.
let selectionEnabled = false;
let _refIdSeq = 0;

function showArticleCard(info) {
  const card = document.getElementById('articleCard');
  document.getElementById('articleTitle').textContent = info.title || 'Unknown title';
  let metaParts = [];
  if (info.authors) metaParts.push(esc(info.authors));
  if (info.year) metaParts.push(info.year);
  if (info.journal) metaParts.push('<em>' + esc(info.journal) + '</em>');
  if (info.doi) metaParts.push('<a href="https://doi.org/' + esc(info.doi) + '" target="_blank" rel="noopener">' + esc(info.doi) + '</a>');
  document.getElementById('articleMeta').innerHTML = metaParts.join(' · ');
  card.style.display = 'block';
}

function renderResults(refs, title) {
  const heading = title || 'Cited References';
  selectionEnabled = true;

  // Compute year range for the slider
  const years = refs.map(r => parseInt(r.year)).filter(y => y > 1900 && y < 2100);
  const minYear = years.length ? Math.min(...years) : 1950;
  const maxYear = years.length ? Math.max(...years) : new Date().getFullYear();

  document.getElementById('results').innerHTML = `<div class="results">
    <div class="results-header">
      <h2>${heading}</h2>
      <span class="badge" id="refBadge">${refs.length} ref${refs.length > 1 ? 's' : ''}</span>
    </div>
    <div class="toolbar">
      <input type="text" class="search-box" id="searchBox" placeholder="Search title, author, DOI…" oninput="filterRefs()">
    </div>
    <div class="filters-row">
      <div class="filter-group">
        <label class="filter-label">Author</label>
        <input type="text" class="filter-input" id="authorFilter" placeholder="e.g. Smith" oninput="filterRefs()">
      </div>
      <div class="filter-group">
        <label class="filter-label">Year from</label>
        <input type="number" class="filter-input filter-year" id="yearFrom" value="${minYear}" min="1900" max="2099" onchange="filterRefs()">
      </div>
      <div class="filter-group">
        <label class="filter-label">to</label>
        <input type="number" class="filter-input filter-year" id="yearTo" value="${maxYear}" min="1900" max="2099" onchange="filterRefs()">
      </div>
      <div class="filter-group filter-actions">
        <button class="btn-sm" onclick="resetFilters()">Reset</button>
        <button class="btn-sm" onclick="exportRIS()">⬇ RIS</button>
        <button class="btn-sm" onclick="exportCSV()">⬇ CSV</button>
        <button class="btn-sm" onclick="copyAll()">⎘ DOIs</button>
      </div>
    </div>
    <div class="sel-bar">
      <span class="sel-hint">☑ Tick the papers to include in the RIS export</span>
      <button class="btn-sm" onclick="selectAllRefs(true)">Select all</button>
      <button class="btn-sm" onclick="selectAllRefs(false)">Select none</button>
      <span class="sel-info" id="selInfo"></span>
    </div>
    <ul class="ref-list" id="refList"></ul></div>`;
  renderList(refs);
  updateSelInfo();
}

// ── Filtering ──
function getFilteredRefs() {
  const q = (document.getElementById('searchBox')?.value || '').toLowerCase();
  const authorQ = (document.getElementById('authorFilter')?.value || '').toLowerCase();
  const yearFrom = parseInt(document.getElementById('yearFrom')?.value) || 0;
  const yearTo = parseInt(document.getElementById('yearTo')?.value) || 9999;

  return allRefs.filter(r => {
    // Text search (title, doi, authors, year)
    if (q) {
      const match = (r.title || '').toLowerCase().includes(q) ||
        (r.doi || '').toLowerCase().includes(q) ||
        (r.authors || '').toLowerCase().includes(q) ||
        (r.year || '').toString().includes(q);
      if (!match) return false;
    }
    // Author filter
    if (authorQ) {
      if (!(r.authors || '').toLowerCase().includes(authorQ)) return false;
    }
    // Year range
    const y = parseInt(r.year);
    if (y && (y < yearFrom || y > yearTo)) return false;
    // If no year and year filter is active, keep the ref (don't hide unknowns)
    return true;
  });
}

function filterRefs() {
  const filtered = getFilteredRefs();
  renderList(filtered);
  // Update badge
  const badge = document.getElementById('refBadge');
  if (badge) {
    if (filtered.length === allRefs.length) {
      badge.textContent = `${allRefs.length} ref${allRefs.length > 1 ? 's' : ''}`;
    } else {
      badge.textContent = `${filtered.length} / ${allRefs.length}`;
    }
  }
}

function resetFilters() {
  const sb = document.getElementById('searchBox'); if (sb) sb.value = '';
  const af = document.getElementById('authorFilter'); if (af) af.value = '';
  // Reset year range to data bounds
  const years = allRefs.map(r => parseInt(r.year)).filter(y => y > 1900 && y < 2100);
  const yf = document.getElementById('yearFrom');
  const yt = document.getElementById('yearTo');
  if (yf && years.length) yf.value = Math.min(...years);
  if (yt && years.length) yt.value = Math.max(...years);
  filterRefs();
}

// ── Selection (single-article mode) ──
function getSelectedRefs() {
  return allRefs.filter(r => r._sel !== false);
}

function toggleRefSel(cb) {
  const id = +cb.dataset.id;
  const r = allRefs.find(x => x._id === id);
  if (r) r._sel = cb.checked;
  updateSelInfo();
}

// Select / deselect all refs currently visible under the active filter.
function selectAllRefs(val) {
  const visible = getFilteredRefs();
  visible.forEach(r => { r._sel = val; });
  renderList(visible);
  updateSelInfo();
}

function updateSelInfo() {
  const el = document.getElementById('selInfo');
  if (!el) return;
  const n = allRefs.filter(r => r._sel !== false).length;
  el.textContent = `${n} of ${allRefs.length} selected`;
}

// ── Render list ──
function renderList(refs) {
  const l = document.getElementById('refList');
  if (!l) return; // DOM element may not exist if user switched views
  if (!refs.length) { l.innerHTML = '<li class="no-results">No results found.</li>'; return; }
  l.innerHTML = refs.map((r, i) => {
    if (r._id == null) r._id = ++_refIdSeq;
    const doiHtml = r.doi
      ? `<span class="ref-doi"><a href="https://doi.org/${esc(r.doi)}" target="_blank" rel="noopener">${esc(r.doi)}</a></span>`
      : '<span class="ref-doi" style="color:var(--text-dim);font-family:var(--mono);font-size:.75rem">no DOI</span>';
    const coins = buildCOinS(r);
    const check = selectionEnabled
      ? `<input type="checkbox" class="ref-check" data-id="${r._id}" ${r._sel !== false ? 'checked' : ''} onchange="toggleRefSel(this)" title="Include in RIS export">`
      : '';
    return `<li class="ref-item">${check}<span class="ref-num">${i + 1}</span><div class="ref-body">
      ${coins}
      <div class="ref-title">${esc(r.title)}</div><div class="ref-meta">
      ${r.year ? `<span class="ref-year">${r.year}</span>` : ''}
      ${r.authors ? `<span class="ref-authors">${esc(r.authors)}</span>` : ''}
      ${doiHtml}
      </div></div></li>`;
  }).join('');
  try { document.dispatchEvent(new Event('ZoteroItemUpdated', { bubbles: true, cancelable: true })); } catch(e) {}
}

// ── COinS (ContextObjects in Spans) for Zotero ──
function buildCOinS(ref) {
  const params = [
    'url_ver=Z39.88-2004',
    'url_ctx_fmt=info:ofi/fmt:kev:mtx:ctx',
    'rft_val_fmt=info:ofi/fmt:kev:mtx:journal',
    'rft.genre=article'
  ];
  if (ref.title) params.push('rft.atitle=' + encodeURIComponent(ref.title));
  if (ref.year) params.push('rft.date=' + encodeURIComponent(ref.year));
  if (ref.doi) params.push('rft_id=info:doi/' + encodeURIComponent(ref.doi));
  if (ref.authors) {
    const authorList = ref.authors.split(/;\s*|\s*,\s*(?=[A-Z])/);
    if (authorList.length > 0) {
      const first = authorList[0].trim();
      const parts = first.split(/,\s*/);
      if (parts.length >= 2) {
        params.push('rft.aulast=' + encodeURIComponent(parts[0].trim()));
        params.push('rft.aufirst=' + encodeURIComponent(parts[1].trim()));
      } else {
        params.push('rft.au=' + encodeURIComponent(first));
      }
      for (let i = 1; i < authorList.length; i++) {
        const a = authorList[i].trim();
        if (a.length > 1) params.push('rft.au=' + encodeURIComponent(a));
      }
    }
  }
  return `<span class="Z3988" title="${esc(params.join('&amp;'))}"></span>`;
}

// ── Exports (operate on filtered results) ──
function exportCSV() {
  const filtered = getFilteredRefs();
  const h = 'Number,Title,DOI,Authors,Year';
  const rows = filtered.map((r, i) =>
    `${i + 1},"${(r.title || '').replace(/"/g, '""')}","${r.doi || ''}","${(r.authors || '').replace(/"/g, '""')}","${r.year || ''}"`
  );
  const b = new Blob(['\ufeff' + h + '\n' + rows.join('\n')], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(b);
  a.download = 'references_snowball.csv';
  a.click();
  showToast(`CSV: ${filtered.length} references exported`);
}

// ── Shared RIS builder / downloader (used by single + batch exports) ──
function buildRIS(refs) {
  return refs.map(r => {
    const lines = ['TY  - JOUR'];
    if (r.title) lines.push('T1  - ' + r.title);
    if (r.authors) {
      const auths = r.authors.split(/;\s*/);
      for (const a of auths) {
        const trimmed = a.trim();
        if (trimmed.length > 1) lines.push('AU  - ' + trimmed);
      }
    }
    if (r.year) lines.push('PY  - ' + r.year);
    if (r.abstract) lines.push('AB  - ' + String(r.abstract).replace(/\r?\n/g, ' ').trim());
    if (r.doi) {
      lines.push('DO  - ' + r.doi);
      lines.push('UR  - https://doi.org/' + r.doi);
    }
    lines.push('ER  - ');
    return lines.join('\r\n');
  }).join('\r\n');
}

function downloadRIS(refs, filename) {
  const b = new Blob([buildRIS(refs)], { type: 'application/x-research-info-systems' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(b);
  a.download = filename;
  a.click();
}

// ── Filename helpers: "Author_Year_direction" from the source paper's info ──
function sanitizeFilePart(s) {
  // NFD splits accented letters into base + combining mark; the ASCII filter drops the marks.
  return String(s || '').normalize('NFD').replace(/[^A-Za-z0-9]/g, '') || 'NA';
}

function firstAuthorSurname(authors) {
  if (!authors) return 'Unknown';
  const first = authors.split(/[;,]/)[0].trim();
  const parts = first.split(/\s+/);
  return parts[parts.length - 1] || first;
}

function risFilenameBase(info, dir) {
  const author = sanitizeFilePart(firstAuthorSurname(info && info.authors));
  const year = (info && info.year) ? sanitizeFilePart(info.year) : 'nd';
  return `${author}_${year}_${dir}`;
}

// ── Single-article RIS export: only the ticked refs, named after the source ──
async function exportRIS() {
  const refs = getSelectedRefs();
  if (!refs.length) { showToast('No references selected'); return; }
  setStatus('loading', `Fetching abstracts for ${refs.length} references…`);
  await fetchAbstractsForRefs(refs);
  const filename = risFilenameBase(currentArticleInfo, currentSingleDir) + '.ris';
  downloadRIS(refs, filename);
  setStatus('success', `RIS: ${refs.length} reference${refs.length > 1 ? 's' : ''} exported → ${filename}`);
  showToast(`RIS: ${refs.length} exported → ${filename}`);
}

function copyAll() {
  const filtered = getFilteredRefs();
  const d = filtered.filter(r => r.doi).map(r => r.doi).join('\n');
  navigator.clipboard.writeText(d).then(() =>
    showToast(`${filtered.filter(r => r.doi).length} DOIs copied`)
  );
}
