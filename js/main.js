// ═══════════════════════════════════════════════
//  main.js — App init, UI wiring, extraction pipeline
// ═══════════════════════════════════════════════

let allRefs = [];
let pendingPDFFile = null;
let lastBackwardRefs = [];
let lastForwardRefs = [];
let currentArticleInfo = null;   // source paper info — used for the RIS filename
let currentSingleDir = 'backward'; // active direction in single mode

// ── DOM refs ──
const dz = document.getElementById('dropzone');
const pdfInput = document.getElementById('pdfFile');
const doiField = document.getElementById('doiInput');

// ── Events ──
dz.addEventListener('dragover', e => { e.preventDefault(); dz.classList.add('dragover'); });
dz.addEventListener('dragleave', () => dz.classList.remove('dragover'));
dz.addEventListener('drop', e => { e.preventDefault(); dz.classList.remove('dragover'); if (e.dataTransfer.files.length) setPDFFile(e.dataTransfer.files[0]); });
pdfInput.addEventListener('change', () => { if (pdfInput.files.length) setPDFFile(pdfInput.files[0]); });
doiField.addEventListener('keydown', e => { if (e.key === 'Enter') runExtraction(); });
doiField.addEventListener('input', () => { resetPreviousResults(); });
doiField.addEventListener('paste', () => { setTimeout(() => { clearPDF(); resetPreviousResults(); }, 0); });

// ── Input management ──
function setPDFFile(file) {
  if (!file || file.type !== 'application/pdf') { setStatus('error', 'Please provide a valid PDF file.'); return; }
  pendingPDFFile = file;
  document.getElementById('pdfFilename').textContent = file.name;
  resetPreviousResults();
}

function clearPDF() {
  pendingPDFFile = null;
  document.getElementById('pdfFilename').textContent = '';
  pdfInput.value = '';
}

function resetPreviousResults() {
  document.getElementById('results').innerHTML = '';
  document.getElementById('articleCard').style.display = 'none';
  document.getElementById('status').className = 'status';
  const dt = document.getElementById('directionTabs');
  if (dt) dt.style.display = 'none';
  allRefs = [];
  lastBackwardRefs = [];
  lastForwardRefs = [];
  currentArticleInfo = null;
}

// ── Direction sub-tabs (backward / forward) ──
function showDirection(dir) {
  currentSingleDir = dir;
  document.querySelectorAll('.dir-tab').forEach(t => {
    t.classList.toggle('active', t.dataset.dir === dir);
  });
  if (dir === 'backward') {
    allRefs = lastBackwardRefs;
    renderResults(lastBackwardRefs, '← Backward — Cited References');
  } else {
    allRefs = lastForwardRefs;
    renderResults(lastForwardRefs, '→ Forward — Citing Articles');
  }
}

// ═══════════════════════════════════════════════
//  Main extraction pipeline
// ═══════════════════════════════════════════════
async function runExtraction() {
  const doiRaw = doiField.value;
  let doi = cleanDOI(doiRaw);
  const hasPDF = !!pendingPDFFile;
  if (!doi && !hasPDF) { setStatus('error', 'Please provide a DOI, a PDF, or both.'); return; }

  document.getElementById('results').innerHTML = '';
  document.getElementById('articleCard').style.display = 'none';
  const dt = document.getElementById('directionTabs');
  if (dt) dt.style.display = 'none';
  let apiRefs = [], pdfRefs = [], pdfDOI = null, pdfFirstPageText = '';
  lastBackwardRefs = [];
  lastForwardRefs = [];
  currentSingleDir = 'backward';
  currentArticleInfo = { title: '', authors: '', year: '', journal: '', doi: doi || '' };

  // ── Step 1: PDF ──
  if (hasPDF) {
    setStatus('loading', 'Step 1 — Extracting references from PDF…');
    try {
      const result = await extractFromPDF(pendingPDFFile);
      pdfRefs = result.refs;
      pdfDOI = result.doi;
      pdfFirstPageText = result.firstPageText || '';
      if (!doi && pdfDOI) { doi = pdfDOI; doiField.value = doi; }
    } catch (e) { console.error(e); }
  }

  // ── Article info card ──
  if (doi) {
    setStatus('loading', 'Fetching article metadata…');
    const info = await fetchArticleInfo(doi);
    currentArticleInfo = info;
    if (info.title) showArticleCard(info);
  } else if (pdfFirstPageText) {
    const info = extractArticleInfoFromPDFText(pdfFirstPageText);
    currentArticleInfo = info;
    if (info.title) showArticleCard(info);
  }

  // ── Step 2: Backward — references cited by this article ──
  if (doi) {
    setStatus('loading', 'Step 2 — Backward: querying APIs for referenced articles…');
    apiRefs = await fetchFromAPIs(doi);
  }

  setStatus('loading', 'Cross-checking and merging backward results…');
  const merged = mergeRefSets(pdfRefs, apiRefs);

  if (merged.length) {
    const noDoi = merged.filter(r => !r.doi).length;
    if (noDoi > 0) {
      setStatus('loading', `Resolving DOIs for ${noDoi} references via Crossref…`);
      await enrichRefsWithDOIs(merged);
    }
  }
  lastBackwardRefs = merged;

  // ── Step 3: Forward — articles that cite this one ──
  let forwardRefs = [];
  if (doi) {
    setStatus('loading', 'Step 3 — Forward: searching for citing articles…');
    forwardRefs = await fetchCitingArticles(doi);
  }
  lastForwardRefs = forwardRefs;

  // ── Display results ──
  const hasBackward = lastBackwardRefs.length > 0;
  const hasForward = lastForwardRefs.length > 0;

  if (hasBackward || hasForward) {
    // Show direction tabs
    if (dt) {
      dt.style.display = 'flex';
      dt.innerHTML =
        `<button class="dir-tab active" data-dir="backward" onclick="showDirection('backward')">← Backward <span class="dir-count">${lastBackwardRefs.length}</span></button>` +
        `<button class="dir-tab" data-dir="forward" onclick="showDirection('forward')">→ Forward <span class="dir-count">${lastForwardRefs.length}</span></button>`;
    }

    // Default to backward view
    allRefs = lastBackwardRefs;
    renderResults(lastBackwardRefs, '← Backward — Cited References');

    const sources = [];
    if (pdfRefs.length) sources.push(`PDF: ${pdfRefs.length}`);
    if (apiRefs.length) sources.push(`API: ${apiRefs.length}`);
    const backDoi = lastBackwardRefs.filter(r => r.doi).length;
    setStatus('success',
      `Backward: ${lastBackwardRefs.length} refs (${backDoi} with DOI). ` +
      `Forward: ${lastForwardRefs.length} citing articles. ` +
      `<span class="source-badge">${sources.join(' · ')}</span>`);
  } else {
    setStatus('warn', 'No references found. Check the DOI or try a different PDF.');
  }
}
