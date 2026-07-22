// ═══════════════════════════════════════════════
//  utils.js — Shared utilities
// ═══════════════════════════════════════════════

function cleanDOI(r) {
  let d = r.trim();
  d = d.replace(/^https?:\/\/(dx\.)?doi\.org\//i, '');
  d = d.replace(/^doi:\s*/i, '');
  return d;
}

function esc(s) {
  return s ? s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;') : '';
}

function setStatus(t, m) {
  // Target the right status div depending on active mode
  const batchPanel = document.getElementById('panelBatch');
  const isBatch = batchPanel && batchPanel.classList.contains('active');
  const e = document.getElementById(isBatch ? 'batchStatus' : 'status');
  e.className = 'status ' + t;
  e.innerHTML = (t === 'loading' ? '<div class="spinner"></div>' : '') + `<span>${m}</span>`;
}

function showToast(m) {
  const t = document.getElementById('toast');
  t.textContent = m;
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 2200);
}

function normalizeForDedup(s) {
  return (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

// Canonical DOI for equality checks: lowercase, no resolver prefix, no trailing punctuation.
function normalizeDOI(doi) {
  if (!doi) return '';
  return cleanDOI(String(doi)).toLowerCase().replace(/[.,;:)\]}'"]+$/, '');
}

const REF_PLACEHOLDER_TITLE = /^(?:untitled|n\/?a|unknown(?:\s+title)?)?$/i;
function isPlaceholderTitle(t) {
  return REF_PLACEHOLDER_TITLE.test(String(t || '').trim());
}

// Dice bigram similarity
function stringSimilarity(a, b) {
  if (!a || !b) return 0;
  if (a === b) return 1;
  const bigrams = s => {
    const bg = new Set();
    for (let i = 0; i < s.length - 1; i++) bg.add(s.slice(i, i + 2));
    return bg;
  };
  const aBg = bigrams(a), bBg = bigrams(b);
  let inter = 0;
  for (const bg of aBg) if (bBg.has(bg)) inter++;
  return (2 * inter) / (aBg.size + bBg.size);
}

// ── Order-independent union / dedup across one or more reference groups ──
// Strategy: a DOI is the strongest identity signal, so refs are first keyed on
// their normalized DOI (exact) — this NEVER collapses two distinct DOIs and
// NEVER collapses several DOI-less placeholder titles into one. Only refs that
// genuinely lack a DOI fall back to fuzzy title matching. When the same paper
// appears in several sources, the richer metadata (real title, longer author
// list, a year) is merged into the kept copy.
//
//   groups          — array of ref arrays (e.g. [crossref, openalex, s2])
//   titleThreshold  — Dice similarity above which two DOI-less titles are "same"
//                     (lower it for noisy PDF-extracted titles).
function unionRefs(groups, titleThreshold = 0.82) {
  if (!Array.isArray(groups)) groups = [groups];
  const out = [];
  const byDOI = new Map();      // normDOI -> kept ref
  const doiRefs = [];           // kept refs that carry a DOI (for cross matching)
  const noDoiNorms = [];        // normalized titles of kept DOI-less refs

  const mergeInto = (target, extra) => {
    if (isPlaceholderTitle(target.title) && !isPlaceholderTitle(extra.title)) target.title = extra.title;
    if ((extra.authors || '').length > (target.authors || '').length) target.authors = extra.authors;
    if (!target.year && extra.year) target.year = extra.year;
    if (extra._src && target._src !== extra._src) {
      const seen = String(target._src || '').split('+');
      if (!seen.includes(extra._src)) target._src = target._src ? target._src + '+' + extra._src : extra._src;
    }
  };

  // Pass 1 — everything with a DOI (identity = DOI).
  for (const group of groups) {
    for (const r of (group || [])) {
      const nd = normalizeDOI(r.doi);
      if (!nd) continue;
      const ex = byDOI.get(nd);
      if (ex) { mergeInto(ex, r); continue; }
      const ref = { ...r, doi: nd };
      byDOI.set(nd, ref); doiRefs.push(ref); out.push(ref);
    }
  }
  const doiNorms = doiRefs.map(r => isPlaceholderTitle(r.title) ? '' : normalizeForDedup(r.title));

  // Pass 2 — DOI-less refs, matched fuzzily against DOI'd refs then each other.
  for (const group of groups) {
    for (const r of (group || [])) {
      if (normalizeDOI(r.doi)) continue;          // already handled in pass 1
      if (isPlaceholderTitle(r.title)) continue;  // unidentifiable, cannot dedup safely
      const norm = normalizeForDedup(r.title);
      if (norm.length < 8) { out.push(r); continue; } // too short to fuzzy-match; keep as-is

      let matched = null;
      for (let i = 0; i < doiNorms.length; i++) {
        if (doiNorms[i] && stringSimilarity(norm, doiNorms[i]) > titleThreshold) { matched = doiRefs[i]; break; }
      }
      if (matched) { mergeInto(matched, r); continue; }   // same paper, keep the DOI'd copy

      let dup = false;
      for (const s of noDoiNorms) { if (stringSimilarity(norm, s) > titleThreshold) { dup = true; break; } }
      if (dup) continue;
      noDoiNorms.push(norm); out.push(r);
    }
  }
  return out;
}

// Back-compat wrapper: dedup a single group of refs.
function deduplicateRefs(refs) {
  return unionRefs([refs]);
}

// Pull cited/citing DOIs out of an OpenCitations index v2 payload.
//   which = 'cited'  -> targets of references() (backward)
//   which = 'citing' -> sources of citations()  (forward)
function extractDOIsFromOpenCitations(rows, which) {
  const dois = [];
  const seen = new Set();
  for (const row of (rows || [])) {
    const field = row && row[which];
    if (!field) continue;
    const m = /doi:(\S+)/i.exec(field);
    if (!m) continue;
    const d = normalizeDOI(m[1]);
    if (d && !seen.has(d)) { seen.add(d); dois.push(d); }
  }
  return dois;
}
