// ═══════════════════════════════════════════════
//  merge.js — Cross-check & merge PDF + API ref sets
// ═══════════════════════════════════════════════

// PDF-extracted titles are noisy (hyphenation, column bleed, OCR-ish spacing),
// so DOI-less PDF refs are matched against the API set with a looser title
// threshold than the API-vs-API union uses. Refs that carry a DOI still match
// exactly on DOI regardless of title noise.
function mergeRefSets(pdfRefs, apiRefs) {
  if (!pdfRefs.length) return deduplicateRefs(apiRefs);
  if (!apiRefs.length) return deduplicateRefs(pdfRefs);
  // API first → its richer metadata is kept; PDF-only refs are appended/enriched.
  return unionRefs([apiRefs, pdfRefs], 0.6);
}
