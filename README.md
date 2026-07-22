# Snowball — Backward-Forward Snowballing

A client-side web tool for **backward and forward snowballing** in systematic reviews. Given a DOI, a PDF, or both, it extracts referenced articles (backward) and citing articles (forward) with titles, authors, years, and clickable DOIs.

**No account, no API key, no server — just open and go.**

## Features

- **Backward snowballing** — extracts all references cited by an article, pooling Crossref, OpenAlex, Semantic Scholar and OpenCitations
- **Forward snowballing** — finds all articles that cite the input article (via OpenAlex, Semantic Scholar & OpenCitations), with full pagination (no fixed result cap)
- **DOI-keyed union** — every source is queried in full, then merged on normalized DOI first (title similarity only as a fallback for DOI-less refs), so distinct papers are never collapsed and DOI-only references are never lost
- **Automatic title resolution** — references that a source deposits as a bare DOI (very common in Crossref/OpenCitations) are hydrated to full metadata via OpenAlex, instead of being discarded
- **PDF extraction** — parses reference sections directly from PDFs using pdf.js, with support for:
  - Two-column layouts (auto-detected)
  - APA author-year format
  - Vancouver numbered format
  - Hyphenation and line-break healing
- **Cross-check & merge** — when both DOI and PDF are provided, the tool merges both reference sets, filling gaps from each source
- **DOI resolution** — references without a DOI are automatically looked up via the Crossref bibliographic search API
- **Batch processing** — paste multiple DOIs and process them all sequentially, with per-article tabs and combined export. Download **all backward references in one `.ris`** and **all forward citations in another** in a single click, instead of paper by paper.
- **Advanced filters** — filter results by text search, author name, and year range
- **Selective export (single mode)** — tick the papers to include, then export only the checked ones. The file is named `Author_Year_direction.ris` (e.g. `Smith_2020_backward.ris`) after the source paper.
- **Export** — RIS (Zotero/Mendeley/EndNote compatible, now including **abstracts**), CSV, or copy all DOIs to clipboard.
- **Zotero integration** — embedded COinS metadata for direct multi-item import via the Zotero browser connector
- **Article info card** — displays metadata (title, authors, journal, year) of the article being analyzed
- **Zero setup** — everything runs client-side in the browser. No data is sent to any server other than the public APIs listed below.

## How it works

```
┌──────────┐     ┌──────────────────┐
│  DOI     │────▶│  Crossref        │
│  input   │     │  OpenAlex        │──┐
└──────────┘     │  Semantic Scholar│  │   (each queried in full,
                 │  OpenCitations   │  │    paginated end-to-end)
                 └──────────────────┘  │
                                       ▼
┌──────────┐     ┌──────────────┐  ┌───────────────┐     ┌──────────┐
│  PDF     │────▶│  pdf.js      │──▶│  DOI-keyed    │────▶│ Results  │
│  upload  │     │  ref parser  │  │  union + title │     │ + enrich │
└──────────┘     └──────────────┘  │  resolution    │     └──────────┘
                                   └───────────────┘
                         Backward: ← articles cited by the input
                         Forward:  → articles that cite the input
```

## Usage

### Option 1 — Open directly

Open `index.html` in any modern browser. No server needed.

### Option 2 — Local server (recommended for development)

```bash
cd snowball
python3 -m http.server 8080
# then open http://localhost:8080
```

### Option 3 — GitHub Pages

Push to a GitHub repository and enable GitHub Pages on the `main` branch.

## Project structure

```
snowball/
├── index.html       # HTML shell, CSS, footer
├── js/
│   ├── utils.js     # Shared utilities (DOI cleaning, string similarity, dedup)
│   ├── api.js       # API interactions (Crossref, OpenAlex, Semantic Scholar) + forward snowballing
│   ├── pdf.js       # PDF text extraction & reference section parsing
│   ├── merge.js     # Cross-check & merge logic (PDF refs + API refs)
│   ├── ui.js        # Rendering (results list, filters, CSV/RIS export, COinS, article card)
│   ├── main.js      # App initialization, UI wiring, single-article extraction pipeline
│   └── batch.js     # Batch DOI processing with per-article tabs
├── LICENSE          # MIT
├── .gitignore
└── README.md
```

## Known limitations

- **PDF parsing is heuristic-based** and may not work perfectly on all reference formats. Heavily stylized or scanned PDFs will perform poorly. Two-column detection works well for standard academic layouts (Springer, Elsevier, IEEE, etc.) but edge cases exist.
- **API coverage depends on the publisher.** Some publishers deposit complete reference lists in Crossref, others deposit partial or no reference metadata. OpenAlex and Semantic Scholar complement each other but neither is 100% complete.
- **Occasional false positives from incorrect DOIs in source metadata.** Some publishers deposit truncated or erroneous DOIs in their Crossref reference lists. For example, a DOI missing its last digits may resolve to a completely unrelated article in the same journal volume. These errors originate from the publisher's metadata deposit, not from this tool. If you spot an obviously unrelated reference (e.g., a paper on agricultural contamination appearing in a firefighter study), it is likely caused by such a metadata error.
- **Crossref rate limiting.** The DOI enrichment step queries Crossref's bibliographic search for each reference without a DOI. For articles with many references, this may trigger rate limits (HTTP 429). The tool uses the Crossref polite pool (`mailto` parameter) and retries with backoff, but very large batches may experience delays.
- **Forward snowballing completeness.** The number of citing articles depends on what OpenAlex, Semantic Scholar and OpenCitations have indexed. Very recent articles (< 1 week old) may not yet appear. Coverage varies by discipline. Extremely highly cited papers are bounded by safety caps (`SNOWBALL_CONFIG.maxForwardPages` / `maxS2Pages` in `js/api.js`) — raise these if you need the full set for a paper with tens of thousands of citations.

## Third-party APIs & data

This tool queries the following external APIs at runtime. No API keys are required.

| Service | Data license | Attribution | Terms |
|---------|-------------|-------------|-------|
| [Crossref REST API](https://www.crossref.org/documentation/retrieve-metadata/rest-api/) | Public metadata | Not required | [Etiquette & rate limits](https://github.com/CrossRef/rest-api-doc#etiquette). Uses `mailto` for polite pool. |
| [OpenAlex API](https://docs.openalex.org/) | [CC0](https://creativecommons.org/publicdomain/zero/1.0/) | Appreciated but not required | [Terms of Service](https://openalex.org/OpenAlex_termsofservice.pdf). Free, 100k requests/day. |
| [Semantic Scholar API](https://www.semanticscholar.org/product/api) | [API License Agreement](https://www.semanticscholar.org/product/api/license) | **Required for public display** | Non-commercial research/educational use. 100 req / 5 min without API key. |
| [OpenCitations Index API v2](https://opencitations.net/index/api/v2) | [CC0](https://creativecommons.org/publicdomain/zero/1.0/) | Appreciated but not required | Open citation data. No key required; returns DOIs which are then hydrated via OpenAlex. |

**Privacy note:** All processing is client-side. PDFs are never uploaded to any server. The only network requests are to the APIs listed above, using the article's DOI and reference metadata as query parameters.

### Semantic Scholar attribution

As required by the Semantic Scholar API License Agreement:

> Data source: [Semantic Scholar API](https://www.semanticscholar.org/?utm_source=api)

If you use this tool to produce results for a scientific publication, please also cite:
> Kinney, R. et al. "The Semantic Scholar Open Data Platform." *ArXiv*, abs/2301.10140, 2023.

## Dependencies

- [pdf.js](https://mozilla.github.io/pdf.js/) v3.11 (loaded from CDN) — client-side PDF text extraction
- [DM Mono](https://fonts.google.com/specimen/DM+Mono) + [Source Serif 4](https://fonts.google.com/specimen/Source+Serif+4) (Google Fonts)

## Author

**Dr Adolphe Béquet**  
Chargé de recherche au [LESCOT](https://lescot.univ-gustave-eiffel.fr/) — Université Gustave Eiffel

## License

[MIT](LICENSE)
