// ═══════════════════════════════════════════════
//  api.js — API interactions (Crossref, OpenAlex, Semantic Scholar, OpenCitations)
// ═══════════════════════════════════════════════

// Tunables kept in one place so the detection logic is easy to lift into a backend.
const SNOWBALL_CONFIG = {
  mailto: 'snowball-tool@example.org',
  maxForwardPages: 30,    // OpenAlex cursor pages × 200  → up to 6000 citing works
  maxS2Pages: 10,         // Semantic Scholar pages × 1000 → up to 10000 items
  s2PageLimit: 1000,      // Semantic Scholar rows per page (endpoint max)
  maxResolveBatches: 20,  // OpenAlex title-resolution batches × 50 → up to 1000 DOIs
  pageDelayMs: 250,       // polite pause between paged requests
};

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Small mappers ──
function oaWorkToRef(w) {
  return {
    title: w.title || 'Untitled',
    doi: w.doi ? w.doi.replace('https://doi.org/', '') : null,
    authors: (w.authorships || []).map(a => a.author?.display_name).filter(Boolean).join(', '),
    year: w.publication_year || null,
    _src: 'openalex'
  };
}

// ── OpenAlex: fetch a work once and cache it (backward + forward reuse it) ──
const _oaWorkCache = new Map();
async function fetchOpenAlexWork(doi) {
  const key = normalizeDOI(doi);
  if (_oaWorkCache.has(key)) return _oaWorkCache.get(key);
  let work = null;
  try {
    const r = await fetch(`https://api.openalex.org/works/doi:${doi}?mailto=${SNOWBALL_CONFIG.mailto}`);
    if (r.ok) work = await r.json();
  } catch (e) {}
  _oaWorkCache.set(key, work);
  return work;
}

// ── OpenAlex: hydrate a list of OpenAlex work IDs into full refs (batches of 50) ──
async function openAlexResolveWorks(ids) {
  if (!ids || !ids.length) return [];
  const out = [];
  for (let i = 0; i < ids.length; i += 50) {
    const batch = ids.slice(i, i + 50).map(x => x.replace('https://openalex.org/', ''));
    try {
      const br = await fetch(`https://api.openalex.org/works?filter=ids.openalex:${batch.join('|')}&per_page=50&select=id,doi,title,authorships,publication_year&mailto=${SNOWBALL_CONFIG.mailto}`);
      if (br.ok) { const bd = await br.json(); out.push(...(bd.results || []).map(oaWorkToRef)); }
    } catch (e) {}
    if (i + 50 < ids.length) await sleep(SNOWBALL_CONFIG.pageDelayMs);
  }
  return out;
}

// ── OpenAlex: hydrate a list of DOIs into full refs (batches of 50, capped) ──
async function openAlexResolveByDOI(dois, maxBatches = SNOWBALL_CONFIG.maxResolveBatches) {
  const uniq = [...new Set((dois || []).map(normalizeDOI).filter(Boolean))];
  const out = [];
  for (let i = 0, b = 0; i < uniq.length && b < maxBatches; i += 50, b++) {
    const batch = uniq.slice(i, i + 50);
    try {
      const r = await fetch(`https://api.openalex.org/works?filter=doi:${batch.join('|')}&per_page=50&select=id,doi,title,authorships,publication_year&mailto=${SNOWBALL_CONFIG.mailto}`);
      if (r.ok) { const d = await r.json(); out.push(...(d.results || []).map(oaWorkToRef)); }
    } catch (e) {}
    if (i + 50 < uniq.length && b + 1 < maxBatches) await sleep(SNOWBALL_CONFIG.pageDelayMs);
  }
  return out;
}

// ── Reconstruct plain-text abstract from an OpenAlex inverted index ──
function abstractFromInverted(inv) {
  if (!inv || typeof inv !== 'object') return '';
  const positions = [];
  for (const word in inv) {
    for (const pos of inv[word]) positions.push([pos, word]);
  }
  positions.sort((a, b) => a[0] - b[0]);
  return positions.map(p => p[1]).join(' ').replace(/\s+/g, ' ').trim();
}

// ── Fetch abstracts (via OpenAlex) for refs that carry a DOI but no abstract ──
// Called lazily at RIS export time so the main snowballing stays fast. Sets
// r.abstract to '' when none is found, so a ref is never queried twice.
async function fetchAbstractsForRefs(refs) {
  const need = refs.filter(r => r.doi && r.abstract == null);
  if (!need.length) return;
  const dois = [...new Set(need.map(r => normalizeDOI(r.doi)).filter(Boolean))];
  const map = new Map();
  for (let i = 0, b = 0; i < dois.length && b < SNOWBALL_CONFIG.maxResolveBatches; i += 50, b++) {
    const batch = dois.slice(i, i + 50);
    try {
      const r = await fetch(`https://api.openalex.org/works?filter=doi:${batch.join('|')}&per_page=50&select=doi,abstract_inverted_index&mailto=${SNOWBALL_CONFIG.mailto}`);
      if (r.ok) {
        const d = await r.json();
        for (const w of (d.results || [])) {
          const nd = normalizeDOI(w.doi);
          if (nd) map.set(nd, abstractFromInverted(w.abstract_inverted_index));
        }
      }
    } catch (e) {}
    if (i + 50 < dois.length) await sleep(SNOWBALL_CONFIG.pageDelayMs);
  }
  for (const r of refs) {
    if (r.doi && r.abstract == null) r.abstract = map.get(normalizeDOI(r.doi)) || '';
  }
}

// ── Fill in real titles/authors/years for refs that only have a DOI ──
// Crossref reference lists and OpenCitations frequently give a DOI but no title;
// without this those refs are unusable (and used to collapse into one "Untitled").
async function resolveTitlesForDOIs(refs) {
  const need = refs.filter(r => r.doi && isPlaceholderTitle(r.title));
  if (!need.length) return refs;
  const resolved = await openAlexResolveByDOI(need.map(r => r.doi));
  const map = new Map(resolved.map(w => [normalizeDOI(w.doi), w]));
  for (const r of need) {
    const w = map.get(normalizeDOI(r.doi));
    if (!w) continue;
    if (!isPlaceholderTitle(w.title)) r.title = w.title;
    if ((w.authors || '').length > (r.authors || '').length) r.authors = w.authors;
    if (!r.year && w.year) r.year = w.year;
  }
  return refs;
}

// ── Semantic Scholar: paginated references / citations endpoint ──
// The nested `?fields=references.*` form is silently capped; the dedicated
// /references and /citations endpoints page through the full list.
async function s2PagedList(doi, kind /* 'references' | 'citations' */) {
  const paperKey = kind === 'citations' ? 'citingPaper' : 'citedPaper';
  const out = [];
  let offset = 0;
  const limit = SNOWBALL_CONFIG.s2PageLimit;
  for (let page = 0; page < SNOWBALL_CONFIG.maxS2Pages; page++) {
    const url = `https://api.semanticscholar.org/graph/v1/paper/DOI:${doi}/${kind}?fields=title,externalIds,authors,year&offset=${offset}&limit=${limit}`;
    let d;
    try {
      let r = await fetch(url);
      if (r.status === 429) { await sleep(2500); r = await fetch(url); }
      if (!r.ok) break;
      d = await r.json();
    } catch (e) { break; }
    const data = d.data || [];
    for (const row of data) {
      const p = row[paperKey];
      if (!p || !p.title) continue;
      out.push({
        title: p.title,
        doi: p.externalIds?.DOI || null,
        authors: (p.authors || []).map(a => a.name).filter(Boolean).join(', '),
        year: p.year || null,
        _src: 's2'
      });
    }
    if (d.next == null || data.length < limit) break;
    offset = d.next;
    await sleep(SNOWBALL_CONFIG.pageDelayMs);
  }
  return out;
}

// ── OpenAlex: all works that cite oaId, via cursor pagination (no fixed cap) ──
async function fetchOpenAlexCiting(oaId) {
  const out = [];
  let cursor = '*';
  for (let page = 0; page < SNOWBALL_CONFIG.maxForwardPages && cursor; page++) {
    let d;
    try {
      const url = `https://api.openalex.org/works?filter=cites:${oaId}&per_page=200&cursor=${encodeURIComponent(cursor)}&select=id,doi,title,authorships,publication_year&mailto=${SNOWBALL_CONFIG.mailto}`;
      const r = await fetch(url);
      if (!r.ok) break;
      d = await r.json();
    } catch (e) { break; }
    const results = d.results || [];
    out.push(...results.map(oaWorkToRef));
    cursor = d.meta?.next_cursor || null;
    if (!results.length) break;
    if (cursor) await sleep(SNOWBALL_CONFIG.pageDelayMs);
  }
  return out;
}

// ── OpenCitations: DOI-only citing/cited stubs (resolved to metadata later) ──
async function fetchOpenCitations(doi, kind /* 'references' | 'citations' */) {
  try {
    const r = await fetch(`https://api.opencitations.net/index/v2/${kind}/doi:${doi}`);
    if (!r.ok) return [];
    const rows = await r.json();
    const which = kind === 'citations' ? 'citing' : 'cited';
    return extractDOIsFromOpenCitations(rows, which)
      .map(d => ({ title: 'Untitled', doi: d, authors: '', year: null, _src: 'opencitations' }));
  } catch (e) { return []; }
}

// ═══════════════════════════════════════════════
//  BACKWARD — references cited by this article
// ═══════════════════════════════════════════════
async function fetchFromAPIs(doi) {
  let crRefs = [], oaRefs = [], s2Refs = [], ocRefs = [];

  // 1) Crossref reference[] — kept even when DOI-only / title-less (resolved below)
  try {
    const r = await fetch(`https://api.crossref.org/works/${encodeURIComponent(doi)}?mailto=${SNOWBALL_CONFIG.mailto}`);
    if (r.ok) {
      const d = await r.json(), items = d.message?.reference || [];
      if (items.length) crRefs = items.map(x => {
        let title = x['article-title'] || '';
        let authors = x.author || '';
        let year = x.year || null;
        if (!title && x.unstructured) {
          const parsed = parseUnstructuredRef(x.unstructured);
          title = parsed.title || x.unstructured;
          if (!authors) authors = parsed.authors;
          if (!year) year = parsed.year;
        }
        return { title: title || 'Untitled', doi: x.DOI || null, authors, year, _src: 'crossref' };
      });
    }
  } catch (e) {}

  // 2) OpenAlex referenced_works — always carries real titles
  try {
    const work = await fetchOpenAlexWork(doi);
    oaRefs = await openAlexResolveWorks(work?.referenced_works);
  } catch (e) {}

  // 3) Semantic Scholar — full paginated reference list
  try { s2Refs = await s2PagedList(doi, 'references'); } catch (e) {}

  // 4) OpenCitations — extra cited DOIs some indexes miss
  try { ocRefs = await fetchOpenCitations(doi, 'references'); } catch (e) {}

  // DOI-keyed union: richest source first, others enrich/supplement.
  const merged = unionRefs([oaRefs, s2Refs, crRefs, ocRefs]);
  await resolveTitlesForDOIs(merged);
  return merged;
}

// ── Article metadata for the info card ──
async function fetchArticleInfo(doi) {
  try {
    const r = await fetch(`https://api.crossref.org/works/${encodeURIComponent(doi)}?mailto=${SNOWBALL_CONFIG.mailto}`);
    if (r.ok) {
      const d = await r.json(), msg = d.message;
      return {
        title: (msg.title || [])[0] || '',
        authors: (msg.author || []).map(a => [a.given, a.family].filter(Boolean).join(' ')).join(', '),
        year: msg.published?.['date-parts']?.[0]?.[0] || (msg['published-print'] || msg['published-online'])?.['date-parts']?.[0]?.[0] || '',
        journal: (msg['container-title'] || [])[0] || '',
        doi
      };
    }
  } catch (e) {}
  try {
    const d = await fetchOpenAlexWork(doi);
    if (d) return {
      title: d.title || '',
      authors: (d.authorships || []).map(a => a.author?.display_name).filter(Boolean).join(', '),
      year: d.publication_year || '',
      journal: d.primary_location?.source?.display_name || '',
      doi
    };
  } catch (e) {}
  return { title: '', authors: '', year: '', journal: '', doi };
}

// ═══════════════════════════════════════════════
//  FORWARD — articles that cite this one
// ═══════════════════════════════════════════════
async function fetchCitingArticles(doi) {
  let oaCiting = [], s2Citing = [], ocCiting = [];

  // 1) OpenAlex — cursor-paged, no artificial cap
  try {
    const work = await fetchOpenAlexWork(doi);
    const oaId = work?.id?.replace('https://openalex.org/', '');
    if (oaId) oaCiting = await fetchOpenAlexCiting(oaId);
  } catch (e) {}

  // 2) Semantic Scholar — full paginated citation list
  try { s2Citing = await s2PagedList(doi, 'citations'); } catch (e) {}

  // 3) OpenCitations — extra citing DOIs
  try { ocCiting = await fetchOpenCitations(doi, 'citations'); } catch (e) {}

  const merged = unionRefs([oaCiting, s2Citing, ocCiting]);
  await resolveTitlesForDOIs(merged);
  return merged;
}

// ── DOI resolution for refs that still lack a DOI (title → Crossref search) ──
async function enrichRefsWithDOIs(refs, onProgress) {
  const toResolve = refs.filter(r => !r.doi);
  const bs = 3; // process 3 at a time with delays to avoid Crossref 429
  for (let i = 0; i < toResolve.length; i += bs) {
    await Promise.all(toResolve.slice(i, i + bs).map(r => resolveOneDOI(r)));
    if (typeof onProgress === 'function') onProgress(refs);
    else { const list = document.getElementById('refList'); if (list) renderList(refs); }
    if (i + bs < toResolve.length) await sleep(800);
  }
}

async function resolveOneDOI(ref) {
  try {
    let query = ref.title.slice(0, 120);
    const firstAuthor = (ref.authors || '').split(',')[0].trim();
    if (firstAuthor && firstAuthor.length > 2) query = firstAuthor + ' ' + query;
    const url = `https://api.crossref.org/works?query.bibliographic=${encodeURIComponent(query)}&rows=5&select=DOI,title,author,published-print,published-online&mailto=${SNOWBALL_CONFIG.mailto}`;
    const r = await fetch(url);
    if (r.status === 429) {
      await sleep(2000);
      const retry = await fetch(url);
      if (!retry.ok) return;
      const d = await retry.json(); return matchAndEnrich(ref, d, firstAuthor);
    }
    if (!r.ok) return;
    const d = await r.json();
    matchAndEnrich(ref, d, firstAuthor);
  } catch (e) {}
}

function matchAndEnrich(ref, d, firstAuthor) {
  const items = d.message?.items || []; if (!items.length) return;
  const refNorm = normalizeForDedup(ref.title); let best = null, bestS = 0;
  for (const item of items) {
    const iNorm = normalizeForDedup(item.title?.[0] || '');
    let sc = stringSimilarity(refNorm, iNorm);
    if (ref.year) {
      const dp = item['published-print'] || item['published-online'];
      if (String(dp?.['date-parts']?.[0]?.[0]) === ref.year) sc += 0.1;
    }
    if (firstAuthor && item.author?.length) {
      if (normalizeForDedup(firstAuthor).includes(normalizeForDedup(item.author[0].family || ''))) sc += 0.1;
    }
    if (sc > bestS) { bestS = sc; best = item; }
  }
  if (best && bestS > 0.55) {
    ref.doi = best.DOI;
    if ((!ref.authors || ref.authors.length < 3) && best.author)
      ref.authors = best.author.map(a => [a.family, a.given].filter(Boolean).join(', ')).join('; ');
    if (best.title?.[0] && bestS > 0.65) ref.title = best.title[0];
    if (!ref.year) {
      const dp = best['published-print'] || best['published-online'];
      if (dp?.['date-parts']?.[0]?.[0]) ref.year = String(dp['date-parts'][0][0]);
    }
  }
}

// ── Parse unstructured citation string from Crossref ──
// Format typically: "Authors (Year) Title. Journal vol:pages" or "Authors. Title. Journal year;vol:pages"
function parseUnstructuredRef(raw) {
  const clean = raw.replace(/\s+/g, ' ').trim();
  let authors = '', title = '', year = null;

  // Extract year
  const yearParenMatch = clean.match(/\((\d{4})\)/);
  const yearPlainMatch = clean.match(/(?:[\s,])(\d{4})(?=[;:,.\s]|$)/);
  year = yearParenMatch ? yearParenMatch[1] : yearPlainMatch ? yearPlainMatch[1] : null;

  // Try Vancouver format: "Authors (year) Title. Journal..."
  if (year) {
    const yearParen = clean.indexOf('(' + year + ')');
    const yearIdx = yearParen >= 0 ? yearParen : clean.indexOf(year);
    authors = clean.slice(0, yearIdx).trim().replace(/[,()\s]+$/, '');
    const afterYearStart = yearParen >= 0 ? yearParen + year.length + 2 : yearIdx + year.length;
    const afterYear = clean.slice(afterYearStart).replace(/^[).:\s]+/, '').trim();
    // Title: up to first period followed by a capital letter (journal name) or end
    const titleMatch = afterYear.match(/^(.+?)\.(?:\s+[A-Z]|\s*$)/);
    title = titleMatch ? titleMatch[1] : afterYear.split(/\.\s/)[0];
  } else {
    // No year: split on periods
    const parts = clean.split(/\.\s+/);
    if (parts.length >= 2) { authors = parts[0]; title = parts[1]; }
    else title = clean;
  }

  title = (title || '').trim().replace(/^["'“]+|["'”]+$/g, '');
  authors = (authors || '').trim();
  return { title, authors, year };
}
