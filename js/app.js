/* PDF Viewer Pro — full-featured PDF viewer built on Mozilla PDF.js */
'use strict';

const APP_VERSION = '1.0.1';
const REPO = 'trendlinepros-afk/PDF-Viewer';
const RELEASES_API = `https://api.github.com/repos/${REPO}/releases/latest`;
const RELEASES_PAGE = `https://github.com/${REPO}/releases/latest`;
const VERSION_URL = `https://raw.githubusercontent.com/${REPO}/main/version.json`;

pdfjsLib.GlobalWorkerOptions.workerSrc = 'lib/pdf.worker.min.js';

/* ==================== State ==================== */
const state = {
  pdfDoc: null,
  fileName: '',
  fileSize: 0,
  originalBytes: null,     // Uint8Array copy kept for download / print fidelity
  fingerprint: '',
  currentPage: 1,
  zoom: 'page-width',      // 'auto' | 'page-fit' | 'page-width' | number
  scale: 1,                // resolved numeric scale actually in use
  rotation: 0,             // extra rotation applied by the user (0/90/180/270)
  viewMode: 'continuous',  // 'continuous' | 'single' | 'two-page'
  tool: 'select',          // 'select' | 'hand' | 'highlight' | 'draw' | 'note'
  annotations: [],         // {id, type, page, color, ...}
  search: {
    query: '',
    pageCounts: [],        // matches per page (1-based index)
    total: 0,
    current: -1,           // global match index
  },
  presenting: false,
  prePresent: null,
  baseViewports: [],       // per page {width,height} at scale 1, incl. user rotation
  renderedPages: new Map(),// pageNum -> Promise resolving when rendered
};

/* ==================== DOM refs ==================== */
const $ = (id) => document.getElementById(id);
const viewerContainer = $('viewerContainer');
const viewer = $('viewer');
const welcome = $('welcome');
const fileInput = $('fileInput');
const pageInput = $('pageInput');
const pageCount = $('pageCount');
const zoomSelect = $('zoomSelect');
const viewModeSelect = $('viewModeSelect');
const searchWrap = $('searchWrap');
const searchInput = $('searchInput');
const searchStatus = $('searchStatus');
const sidebar = $('sidebar');
const annotColor = $('annotColor');

let pageObserver = null;

/* ==================== Utilities ==================== */
function toast(msg, isError = false) {
  const el = document.createElement('div');
  el.className = 'toast' + (isError ? ' error' : '');
  el.textContent = msg;
  $('toastContainer').appendChild(el);
  setTimeout(() => el.remove(), 4000);
}

function formatBytes(bytes) {
  if (!bytes) return '';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0, n = bytes;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(n >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
}

function uid() {
  return 'a' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/* Rotation-aware normalized-coordinate transforms.
   Annotations are stored normalized (0..1) against the default-rotation view. */
function normToView(x, y, rot) {
  switch (rot) {
    case 90:  return [1 - y, x];
    case 180: return [1 - x, 1 - y];
    case 270: return [y, 1 - x];
    default:  return [x, y];
  }
}
function viewToNorm(x, y, rot) {
  switch (rot) {
    case 90:  return [y, 1 - x];
    case 180: return [1 - x, 1 - y];
    case 270: return [1 - y, x];
    default:  return [x, y];
  }
}
function normRectToView(r, rot) {
  const [x1, y1] = normToView(r.x, r.y, rot);
  const [x2, y2] = normToView(r.x + r.w, r.y + r.h, rot);
  return {
    x: Math.min(x1, x2), y: Math.min(y1, y2),
    w: Math.abs(x2 - x1), h: Math.abs(y2 - y1),
  };
}

/* ==================== Theme ==================== */
function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  localStorage.setItem('pdfviewer-theme', theme);
}
$('btnTheme').addEventListener('click', () => {
  const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  applyTheme(next);
});
applyTheme(localStorage.getItem('pdfviewer-theme') ||
  (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'));

/* ==================== File loading ==================== */
async function openFile(file) {
  if (!file) return;
  if (file.type !== 'application/pdf' && !/\.pdf$/i.test(file.name)) {
    toast('Please choose a PDF file.', true);
    return;
  }
  try {
    const buf = await file.arrayBuffer();
    await loadDocument(new Uint8Array(buf), file.name, file.size);
  } catch (err) {
    console.error(err);
    toast('Could not read that file: ' + err.message, true);
  }
}

async function loadDocument(bytes, name, size) {
  // pdf.js takes ownership of the buffer, so keep our own copy for save/print
  state.originalBytes = bytes.slice();
  const task = pdfjsLib.getDocument({ data: bytes });
  const doc = await task.promise;

  if (state.pdfDoc) { try { state.pdfDoc.destroy(); } catch (_) {} }
  state.pdfDoc = doc;
  state.fileName = name || 'document.pdf';
  state.fileSize = size || state.originalBytes.length;
  state.fingerprint = (doc.fingerprints && doc.fingerprints[0]) || doc.fingerprint || name;
  state.currentPage = 1;
  state.rotation = 0;
  state.search = { query: '', pageCounts: [], total: 0, current: -1 };
  searchInput.value = '';
  searchStatus.textContent = '';
  loadAnnotations();

  welcome.classList.add('hidden');
  pageCount.textContent = '/ ' + doc.numPages;
  pageInput.max = doc.numPages;
  $('statusDocInfo').textContent =
    `${state.fileName} — ${doc.numPages} page${doc.numPages > 1 ? 's' : ''}` +
    (state.fileSize ? ` — ${formatBytes(state.fileSize)}` : '');
  document.title = `${state.fileName} — PDF Viewer Pro`;

  await rebuildViewer();
  buildThumbnails();
  buildOutline();
  renderAnnotList();
  toast(`Opened ${state.fileName}`);
}

$('btnOpen').addEventListener('click', () => fileInput.click());
$('btnWelcomeOpen').addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', () => {
  openFile(fileInput.files[0]);
  fileInput.value = '';
});

/* drag & drop anywhere */
window.addEventListener('dragover', (e) => {
  e.preventDefault();
  document.body.classList.add('dragover');
});
window.addEventListener('dragleave', (e) => {
  if (e.relatedTarget === null) document.body.classList.remove('dragover');
});
window.addEventListener('drop', (e) => {
  e.preventDefault();
  document.body.classList.remove('dragover');
  const file = e.dataTransfer.files && e.dataTransfer.files[0];
  if (file) openFile(file);
});

/* ==================== Scale resolution ==================== */
function resolveScale(baseW, baseH) {
  const pad = 40; // viewer padding
  const availW = viewerContainer.clientWidth - pad;
  const availH = viewerContainer.clientHeight - pad;
  const cols = state.viewMode === 'two-page' ? 2 : 1;
  const wScale = availW / (baseW * cols + (cols - 1) * 16);
  const hScale = availH / baseH;
  if (state.zoom === 'page-width') return Math.max(0.1, wScale);
  if (state.zoom === 'page-fit') return Math.max(0.1, Math.min(wScale, hScale));
  if (state.zoom === 'auto') return Math.max(0.1, Math.min(wScale, 1.25));
  return Number(state.zoom) || 1;
}

/* ==================== Viewer build & render ==================== */
async function rebuildViewer() {
  const doc = state.pdfDoc;
  if (!doc) return;

  if (pageObserver) pageObserver.disconnect();
  viewer.innerHTML = '';
  state.renderedPages.clear();
  state.baseViewports = [];

  // measure page 1 to resolve fit scales (per-page sizes handled below)
  const first = await doc.getPage(1);
  const rot = (first.rotate + state.rotation) % 360;
  const base = first.getViewport({ scale: 1, rotation: rot });
  state.scale = resolveScale(base.width, base.height);
  $('statusZoom').textContent = Math.round(state.scale * 100) + '%';
  syncZoomSelect();

  viewer.classList.toggle('two-page', state.viewMode === 'two-page');

  pageObserver = new IntersectionObserver(onPageIntersect, {
    root: viewerContainer,
    rootMargin: '400px 0px',
  });

  for (let n = 1; n <= doc.numPages; n++) {
    const wrap = document.createElement('div');
    wrap.className = 'page-wrap';
    wrap.dataset.page = n;
    // placeholder size from page 1; corrected when the page is measured
    wrap.style.width = Math.floor(base.width * state.scale) + 'px';
    wrap.style.height = Math.floor(base.height * state.scale) + 'px';
    viewer.appendChild(wrap);
    attachPageInteractions(wrap, n);
    pageObserver.observe(wrap);
  }

  applyViewMode(false);
  scrollToPage(state.currentPage, true);
}

function onPageIntersect(entries) {
  for (const entry of entries) {
    if (!entry.isIntersecting) continue;
    const n = Number(entry.target.dataset.page);
    ensurePageRendered(n);
  }
}

function ensurePageRendered(n) {
  if (state.renderedPages.has(n)) return state.renderedPages.get(n);
  const p = renderPage(n).catch((err) => {
    state.renderedPages.delete(n);
    console.error('render page', n, err);
  });
  state.renderedPages.set(n, p);
  return p;
}

async function renderPage(n) {
  const doc = state.pdfDoc;
  const wrap = viewer.querySelector(`.page-wrap[data-page="${n}"]`);
  if (!doc || !wrap) return;

  const page = await doc.getPage(n);
  const rot = (page.rotate + state.rotation) % 360;
  const viewport = page.getViewport({ scale: state.scale, rotation: rot });
  const dpr = Math.min(window.devicePixelRatio || 1, 2);

  wrap.style.width = Math.floor(viewport.width) + 'px';
  wrap.style.height = Math.floor(viewport.height) + 'px';
  wrap.innerHTML = '';

  const canvas = document.createElement('canvas');
  canvas.className = 'page-canvas';
  canvas.width = Math.floor(viewport.width * dpr);
  canvas.height = Math.floor(viewport.height * dpr);
  canvas.style.width = Math.floor(viewport.width) + 'px';
  canvas.style.height = Math.floor(viewport.height) + 'px';
  wrap.appendChild(canvas);

  const ctx = canvas.getContext('2d');
  await page.render({
    canvasContext: ctx,
    viewport,
    transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : null,
  }).promise;

  // text layer (selection + search highlighting)
  const textLayer = document.createElement('div');
  textLayer.className = 'textLayer';
  textLayer.style.setProperty('--scale-factor', viewport.scale);
  wrap.appendChild(textLayer);
  try {
    const textContent = await page.getTextContent();
    await pdfjsLib.renderTextLayer({
      textContentSource: textContent,
      container: textLayer,
      viewport,
      textDivs: [],
    }).promise;
    if (state.search.query) markSearchInPage(wrap);
  } catch (err) {
    console.warn('text layer failed on page', n, err);
  }

  renderAnnotationLayer(wrap, n);
}

/* re-render everything, keeping position on the current page */
async function refreshLayout() {
  if (!state.pdfDoc) return;
  await rebuildViewer();
}

/* ==================== View modes & navigation ==================== */
function applyViewMode(refresh = true) {
  viewer.classList.toggle('two-page', state.viewMode === 'two-page');
  const wraps = viewer.querySelectorAll('.page-wrap');
  wraps.forEach((w) => {
    const n = Number(w.dataset.page);
    w.style.display =
      state.viewMode === 'single' && n !== state.currentPage ? 'none' : '';
  });
  if (refresh && state.viewMode === 'single') ensurePageRendered(state.currentPage);
}

function setCurrentPage(n, scroll = true) {
  const doc = state.pdfDoc;
  if (!doc) return;
  n = Math.max(1, Math.min(doc.numPages, n));
  const changed = n !== state.currentPage;
  state.currentPage = n;
  pageInput.value = n;
  updateThumbActive();
  if (state.viewMode === 'single') {
    applyViewMode();
    if (scroll) viewerContainer.scrollTop = 0;
  } else if (scroll && changed) {
    scrollToPage(n);
  }
}

function scrollToPage(n, instant = false) {
  const wrap = viewer.querySelector(`.page-wrap[data-page="${n}"]`);
  if (!wrap) return;
  if (state.viewMode === 'single') { applyViewMode(); return; }
  wrap.scrollIntoView({ behavior: instant ? 'instant' : 'smooth', block: 'start' });
}

/* keep page indicator in sync while scrolling */
let scrollTick = false;
viewerContainer.addEventListener('scroll', () => {
  if (state.viewMode === 'single' || scrollTick || !state.pdfDoc) return;
  scrollTick = true;
  requestAnimationFrame(() => {
    scrollTick = false;
    const mid = viewerContainer.getBoundingClientRect().top +
      viewerContainer.clientHeight * 0.4;
    let best = state.currentPage, bestDist = Infinity;
    viewer.querySelectorAll('.page-wrap').forEach((w) => {
      const r = w.getBoundingClientRect();
      if (r.bottom < viewerContainer.getBoundingClientRect().top - 50) return;
      const dist = Math.abs((r.top + r.bottom) / 2 - mid);
      if (dist < bestDist) { bestDist = dist; best = Number(w.dataset.page); }
    });
    if (best !== state.currentPage) {
      state.currentPage = best;
      pageInput.value = best;
      updateThumbActive();
    }
  });
});

$('btnPrevPage').addEventListener('click', () => setCurrentPage(state.currentPage - 1));
$('btnNextPage').addEventListener('click', () => setCurrentPage(state.currentPage + 1));
pageInput.addEventListener('change', () => setCurrentPage(Number(pageInput.value)));

viewModeSelect.addEventListener('change', async () => {
  state.viewMode = viewModeSelect.value;
  await refreshLayout();
});

/* ==================== Zoom ==================== */
const ZOOM_STEPS = [0.25, 0.33, 0.5, 0.67, 0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4];

function syncZoomSelect() {
  const val = typeof state.zoom === 'number' ? String(state.zoom) : state.zoom;
  const opt = [...zoomSelect.options].find((o) => o.value === val);
  if (opt) { zoomSelect.value = val; return; }
  let custom = zoomSelect.querySelector('option[data-custom]');
  if (!custom) {
    custom = document.createElement('option');
    custom.dataset.custom = '1';
    zoomSelect.appendChild(custom);
  }
  custom.value = val;
  custom.textContent = Math.round(state.scale * 100) + '%';
  zoomSelect.value = val;
}

async function setZoom(zoom) {
  state.zoom = zoom;
  await refreshLayout();
}

function zoomStep(dir) {
  const cur = state.scale;
  let next;
  if (dir > 0) next = ZOOM_STEPS.find((s) => s > cur + 0.001) || cur * 1.25;
  else next = [...ZOOM_STEPS].reverse().find((s) => s < cur - 0.001) || cur * 0.8;
  setZoom(Math.max(0.1, Math.min(6, Math.round(next * 100) / 100)));
}

$('btnZoomIn').addEventListener('click', () => zoomStep(1));
$('btnZoomOut').addEventListener('click', () => zoomStep(-1));
zoomSelect.addEventListener('change', () => {
  const v = zoomSelect.value;
  setZoom(['auto', 'page-fit', 'page-width'].includes(v) ? v : Number(v));
});

/* Ctrl+wheel zoom */
viewerContainer.addEventListener('wheel', (e) => {
  if (!e.ctrlKey) return;
  e.preventDefault();
  zoomStep(e.deltaY < 0 ? 1 : -1);
}, { passive: false });

/* refit on resize when using a fit mode */
let resizeTimer = null;
window.addEventListener('resize', () => {
  if (typeof state.zoom === 'number' || !state.pdfDoc) return;
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(refreshLayout, 250);
});

/* ==================== Rotation ==================== */
async function rotate(delta) {
  if (!state.pdfDoc) return;
  state.rotation = ((state.rotation + delta) % 360 + 360) % 360;
  await refreshLayout();
  buildThumbnails();
}
$('btnRotateRight').addEventListener('click', () => rotate(90));
$('btnRotateLeft').addEventListener('click', () => rotate(-90));

/* ==================== Sidebar ==================== */
$('btnSidebar').addEventListener('click', () => sidebar.classList.toggle('collapsed'));

document.querySelectorAll('.sb-tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.sb-tab').forEach((t) => t.classList.remove('active'));
    document.querySelectorAll('.sidebar-panel').forEach((p) => p.classList.remove('active'));
    tab.classList.add('active');
    $('panel-' + tab.dataset.panel).classList.add('active');
  });
});

async function buildThumbnails() {
  const doc = state.pdfDoc;
  const panel = $('panel-thumbs');
  if (!doc) return;
  panel.innerHTML = '';
  for (let n = 1; n <= doc.numPages; n++) {
    const div = document.createElement('div');
    div.className = 'thumb' + (n === state.currentPage ? ' active' : '');
    div.dataset.page = n;
    const canvas = document.createElement('canvas');
    const label = document.createElement('span');
    label.textContent = n;
    div.append(canvas, label);
    div.addEventListener('click', () => setCurrentPage(n));
    panel.appendChild(div);

    const page = await doc.getPage(n);
    const rot = (page.rotate + state.rotation) % 360;
    const vp1 = page.getViewport({ scale: 1, rotation: rot });
    const scale = 150 / vp1.width;
    const vp = page.getViewport({ scale, rotation: rot });
    canvas.width = Math.floor(vp.width);
    canvas.height = Math.floor(vp.height);
    await page.render({ canvasContext: canvas.getContext('2d'), viewport: vp }).promise;
  }
}

function updateThumbActive() {
  document.querySelectorAll('#panel-thumbs .thumb').forEach((t) => {
    t.classList.toggle('active', Number(t.dataset.page) === state.currentPage);
  });
  const active = document.querySelector('#panel-thumbs .thumb.active');
  if (active) active.scrollIntoView({ block: 'nearest' });
}

async function buildOutline() {
  const doc = state.pdfDoc;
  const panel = $('panel-outline');
  panel.innerHTML = '';
  let outline = null;
  try { outline = await doc.getOutline(); } catch (_) {}
  if (!outline || !outline.length) {
    panel.innerHTML = '<p class="empty-msg">No bookmarks in this document.</p>';
    return;
  }
  panel.appendChild(buildOutlineLevel(outline));
}

function buildOutlineLevel(items) {
  const frag = document.createDocumentFragment();
  for (const item of items) {
    const btn = document.createElement('button');
    btn.className = 'outline-item';
    btn.textContent = item.title || '(untitled)';
    btn.title = item.title || '';
    btn.addEventListener('click', () => navigateToDest(item.dest));
    frag.appendChild(btn);
    if (item.items && item.items.length) {
      const kids = document.createElement('div');
      kids.className = 'outline-children';
      kids.appendChild(buildOutlineLevel(item.items));
      frag.appendChild(kids);
    }
  }
  return frag;
}

async function navigateToDest(dest) {
  const doc = state.pdfDoc;
  if (!doc || !dest) return;
  try {
    const explicit = typeof dest === 'string' ? await doc.getDestination(dest) : dest;
    if (!explicit) return;
    const pageIndex = await doc.getPageIndex(explicit[0]);
    setCurrentPage(pageIndex + 1);
  } catch (err) {
    console.warn('bad destination', err);
  }
}

/* ==================== Search ==================== */
$('btnSearch').addEventListener('click', toggleSearch);
function toggleSearch(forceOpen = false) {
  const open = searchWrap.classList.contains('open');
  if (open && !forceOpen) {
    searchWrap.classList.remove('open');
    clearSearch();
  } else {
    searchWrap.classList.add('open');
    searchInput.focus();
    searchInput.select();
  }
}

let searchDebounce = null;
searchInput.addEventListener('input', () => {
  clearTimeout(searchDebounce);
  searchDebounce = setTimeout(() => runSearch(searchInput.value), 350);
});
searchInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    stepMatch(e.shiftKey ? -1 : 1);
  } else if (e.key === 'Escape') {
    toggleSearch();
    viewerContainer.focus();
  }
});
$('btnSearchNext').addEventListener('click', () => stepMatch(1));
$('btnSearchPrev').addEventListener('click', () => stepMatch(-1));

function clearSearch() {
  state.search = { query: '', pageCounts: [], total: 0, current: -1 };
  searchStatus.textContent = '';
  viewer.querySelectorAll('.textLayer mark').forEach((m) => {
    m.replaceWith(document.createTextNode(m.textContent));
  });
  viewer.querySelectorAll('.textLayer span').forEach((s) => s.normalize());
}

async function runSearch(query) {
  clearSearchMarks();
  query = query.trim();
  state.search.query = query;
  state.search.current = -1;
  if (!query || !state.pdfDoc) {
    searchStatus.textContent = '';
    return;
  }
  const doc = state.pdfDoc;
  const re = new RegExp(escapeRegExp(query), 'gi');
  const counts = [0];
  let total = 0;
  for (let n = 1; n <= doc.numPages; n++) {
    if (state.search.query !== query) return; // superseded by a newer search
    const page = await doc.getPage(n);
    const tc = await page.getTextContent();
    let c = 0;
    for (const item of tc.items) {
      const matches = item.str.match(re);
      if (matches) c += matches.length;
    }
    counts[n] = c;
    total += c;
  }
  state.search.pageCounts = counts;
  state.search.total = total;
  searchStatus.textContent = total ? `${total} found` : 'Not found';
  // mark already-rendered pages
  viewer.querySelectorAll('.page-wrap').forEach((w) => markSearchInPage(w));
  if (total) stepMatch(1);
}

function clearSearchMarks() {
  viewer.querySelectorAll('.textLayer mark').forEach((m) => {
    m.replaceWith(document.createTextNode(m.textContent));
  });
  viewer.querySelectorAll('.textLayer span').forEach((s) => s.normalize());
}

function markSearchInPage(wrap) {
  const q = state.search.query;
  if (!q) return;
  const re = new RegExp(escapeRegExp(q), 'gi');
  wrap.querySelectorAll('.textLayer span').forEach((span) => {
    if (span.querySelector('mark')) return;
    const text = span.textContent;
    if (!re.test(text)) { re.lastIndex = 0; return; }
    re.lastIndex = 0;
    const frag = document.createDocumentFragment();
    let last = 0, m;
    while ((m = re.exec(text)) !== null) {
      frag.appendChild(document.createTextNode(text.slice(last, m.index)));
      const mark = document.createElement('mark');
      mark.textContent = m[0];
      frag.appendChild(mark);
      last = m.index + m[0].length;
    }
    frag.appendChild(document.createTextNode(text.slice(last)));
    span.textContent = '';
    span.appendChild(frag);
  });
}

async function stepMatch(dir) {
  const s = state.search;
  if (!s.total) return;
  s.current = ((s.current + dir) % s.total + s.total) % s.total;

  // find which page this global match index falls on
  let acc = 0, page = 1, localIdx = 0;
  for (let n = 1; n < s.pageCounts.length; n++) {
    if (s.current < acc + (s.pageCounts[n] || 0)) {
      page = n;
      localIdx = s.current - acc;
      break;
    }
    acc += s.pageCounts[n] || 0;
  }

  setCurrentPage(page);
  await ensurePageRendered(page);
  // allow the smooth scroll & render to settle before highlighting
  setTimeout(() => {
    viewer.querySelectorAll('.textLayer mark.current')
      .forEach((m) => m.classList.remove('current'));
    const wrap = viewer.querySelector(`.page-wrap[data-page="${page}"]`);
    if (!wrap) return;
    const marks = wrap.querySelectorAll('.textLayer mark');
    const mark = marks[localIdx];
    if (mark) {
      mark.classList.add('current');
      mark.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
    searchStatus.textContent = `${s.current + 1} of ${s.total}`;
  }, 120);
}

/* ==================== Tools ==================== */
function setTool(tool) {
  state.tool = tool;
  document.querySelectorAll('.tool-btn').forEach((b) => {
    b.classList.toggle('active', b.dataset.tool === tool);
  });
  viewerContainer.className = viewerContainer.className
    .replace(/\btool-\w+\b/g, '').trim();
  viewerContainer.classList.add('tool-' + tool);
  viewerContainer.classList.toggle('hand-tool', tool === 'hand');
}
document.querySelectorAll('.tool-btn').forEach((b) => {
  b.addEventListener('click', () => setTool(b.dataset.tool));
});
setTool('select');

/* hand tool panning */
let pan = null;
viewerContainer.addEventListener('pointerdown', (e) => {
  if (state.tool !== 'hand' || e.button !== 0) return;
  pan = { x: e.clientX, y: e.clientY,
          sl: viewerContainer.scrollLeft, st: viewerContainer.scrollTop };
  viewerContainer.classList.add('panning');
  viewerContainer.setPointerCapture(e.pointerId);
});
viewerContainer.addEventListener('pointermove', (e) => {
  if (!pan) return;
  viewerContainer.scrollLeft = pan.sl - (e.clientX - pan.x);
  viewerContainer.scrollTop = pan.st - (e.clientY - pan.y);
});
viewerContainer.addEventListener('pointerup', () => {
  pan = null;
  viewerContainer.classList.remove('panning');
});

/* highlight tool: capture text selection on mouseup */
viewerContainer.addEventListener('mouseup', () => {
  if (state.tool !== 'highlight') return;
  setTimeout(captureHighlight, 10);
});

function captureHighlight() {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || !sel.rangeCount) return;
  const range = sel.getRangeAt(0);
  const rects = [...range.getClientRects()].filter((r) => r.width > 1 && r.height > 1);
  if (!rects.length) return;

  const byPage = new Map();
  for (const r of rects) {
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    for (const wrap of viewer.querySelectorAll('.page-wrap')) {
      const b = wrap.getBoundingClientRect();
      if (cx >= b.left && cx <= b.right && cy >= b.top && cy <= b.bottom) {
        const n = Number(wrap.dataset.page);
        if (!byPage.has(n)) byPage.set(n, []);
        // normalize against current view, then undo user rotation for storage
        const vx = (r.left - b.left) / b.width;
        const vy = (r.top - b.top) / b.height;
        const vr = { x: vx, y: vy, w: r.width / b.width, h: r.height / b.height };
        byPage.get(n).push(unrotateRect(vr, state.rotation));
        break;
      }
    }
  }
  if (!byPage.size) return;
  for (const [page, pageRects] of byPage) {
    state.annotations.push({
      id: uid(), type: 'highlight', page,
      color: annotColor.value, rects: pageRects,
      created: Date.now(),
    });
  }
  sel.removeAllRanges();
  saveAnnotations();
  byPage.forEach((_, page) => redrawAnnotations(page));
  renderAnnotList();
}

function unrotateRect(r, rot) {
  const [x1, y1] = viewToNorm(r.x, r.y, rot);
  const [x2, y2] = viewToNorm(r.x + r.w, r.y + r.h, rot);
  return {
    x: Math.min(x1, x2), y: Math.min(y1, y2),
    w: Math.abs(x2 - x1), h: Math.abs(y2 - y1),
  };
}

/* draw + note tools are wired per page wrapper */
function attachPageInteractions(wrap, pageNum) {
  let stroke = null;
  let polyline = null;

  wrap.addEventListener('pointerdown', (e) => {
    if (state.tool === 'draw' && e.button === 0) {
      e.preventDefault();
      const b = wrap.getBoundingClientRect();
      stroke = {
        id: uid(), type: 'draw', page: pageNum,
        color: annotColor.value,
        width: 2 / state.scale,
        points: [],
        created: Date.now(),
      };
      addDrawPoint(e, b, stroke);
      const svg = ensureAnnotSvg(wrap);
      polyline = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
      polyline.setAttribute('fill', 'none');
      polyline.setAttribute('stroke', stroke.color);
      polyline.setAttribute('stroke-width', 2);
      polyline.setAttribute('stroke-linecap', 'round');
      polyline.setAttribute('stroke-linejoin', 'round');
      svg.appendChild(polyline);
      wrap.setPointerCapture(e.pointerId);
    }
  });

  wrap.addEventListener('pointermove', (e) => {
    if (!stroke) return;
    const b = wrap.getBoundingClientRect();
    addDrawPoint(e, b, stroke);
    polyline.setAttribute('points', stroke.points
      .map(([nx, ny]) => {
        const [vx, vy] = normToView(nx, ny, state.rotation);
        return `${vx * b.width},${vy * b.height}`;
      }).join(' '));
  });

  wrap.addEventListener('pointerup', () => {
    if (!stroke) return;
    if (stroke.points.length > 1) {
      state.annotations.push(stroke);
      saveAnnotations();
      renderAnnotList();
    }
    if (polyline) polyline.remove();
    redrawAnnotations(pageNum);
    stroke = null;
    polyline = null;
  });

  wrap.addEventListener('click', (e) => {
    if (state.tool !== 'note') return;
    if (e.target.closest('.note-icon') || e.target.closest('.note-popup')) return;
    const b = wrap.getBoundingClientRect();
    const vx = (e.clientX - b.left) / b.width;
    const vy = (e.clientY - b.top) / b.height;
    const [nx, ny] = viewToNorm(vx, vy, state.rotation);
    const note = {
      id: uid(), type: 'note', page: pageNum,
      color: annotColor.value, x: nx, y: ny, text: '',
      created: Date.now(),
    };
    state.annotations.push(note);
    saveAnnotations();
    redrawAnnotations(pageNum);
    renderAnnotList();
    openNotePopup(wrap, note);
  });
}

function addDrawPoint(e, bounds, stroke) {
  const vx = (e.clientX - bounds.left) / bounds.width;
  const vy = (e.clientY - bounds.top) / bounds.height;
  stroke.points.push(viewToNorm(vx, vy, state.rotation));
}

/* ==================== Annotation rendering ==================== */
function ensureAnnotLayer(wrap) {
  let layer = wrap.querySelector('.annotLayer');
  if (!layer) {
    layer = document.createElement('div');
    layer.className = 'annotLayer';
    wrap.appendChild(layer);
  }
  return layer;
}

function ensureAnnotSvg(wrap) {
  const layer = ensureAnnotLayer(wrap);
  let svg = layer.querySelector('svg');
  if (!svg) {
    svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    layer.appendChild(svg);
  }
  return svg;
}

function renderAnnotationLayer(wrap, pageNum) {
  const layer = ensureAnnotLayer(wrap);
  layer.innerHTML = '';
  const svg = ensureAnnotSvg(wrap);
  const b = { width: wrap.clientWidth, height: wrap.clientHeight };

  for (const a of state.annotations.filter((a) => a.page === pageNum)) {
    if (a.type === 'highlight') {
      for (const nr of a.rects) {
        const r = normRectToView(nr, state.rotation);
        const div = document.createElement('div');
        div.className = 'annot-highlight';
        div.style.left = r.x * 100 + '%';
        div.style.top = r.y * 100 + '%';
        div.style.width = r.w * 100 + '%';
        div.style.height = r.h * 100 + '%';
        div.style.background = a.color;
        div.title = 'Highlight — double-click to remove';
        div.addEventListener('dblclick', () => deleteAnnotation(a.id));
        layer.appendChild(div);
      }
    } else if (a.type === 'draw') {
      const poly = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
      poly.setAttribute('fill', 'none');
      poly.setAttribute('stroke', a.color);
      poly.setAttribute('stroke-width', Math.max(1.2, a.width * state.scale));
      poly.setAttribute('stroke-linecap', 'round');
      poly.setAttribute('stroke-linejoin', 'round');
      poly.style.pointerEvents = 'stroke';
      poly.style.cursor = 'pointer';
      poly.setAttribute('points', a.points.map(([nx, ny]) => {
        const [vx, vy] = normToView(nx, ny, state.rotation);
        return `${vx * b.width},${vy * b.height}`;
      }).join(' '));
      const title = document.createElementNS('http://www.w3.org/2000/svg', 'title');
      title.textContent = 'Drawing — double-click to remove';
      poly.appendChild(title);
      poly.addEventListener('dblclick', () => deleteAnnotation(a.id));
      svg.appendChild(poly);
    } else if (a.type === 'note') {
      const [vx, vy] = normToView(a.x, a.y, state.rotation);
      const icon = document.createElement('div');
      icon.className = 'note-icon';
      icon.style.left = vx * 100 + '%';
      icon.style.top = vy * 100 + '%';
      icon.innerHTML =
        `<svg viewBox="0 0 24 24"><path d="M4 3h16a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1h-7l-5 5v-5H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z" fill="${a.color}" stroke="rgba(0,0,0,.35)"/></svg>`;
      icon.title = a.text || 'Note';
      icon.addEventListener('click', (e) => {
        e.stopPropagation();
        openNotePopup(wrap, a);
      });
      layer.appendChild(icon);
    }
  }
}

function redrawAnnotations(pageNum) {
  const wrap = viewer.querySelector(`.page-wrap[data-page="${pageNum}"]`);
  if (wrap && wrap.querySelector('.page-canvas')) {
    renderAnnotationLayer(wrap, pageNum);
  }
}

function openNotePopup(wrap, note) {
  document.querySelectorAll('.note-popup').forEach((p) => p.remove());
  const layer = ensureAnnotLayer(wrap);
  const [vx, vy] = normToView(note.x, note.y, state.rotation);
  const popup = document.createElement('div');
  popup.className = 'note-popup';
  popup.style.left = `min(${vx * 100}%, calc(100% - 210px))`;
  popup.style.top = `calc(${vy * 100}% + 26px)`;

  const ta = document.createElement('textarea');
  ta.placeholder = 'Type your note…';
  ta.value = note.text || '';
  const actions = document.createElement('div');
  actions.className = 'note-actions';
  const del = document.createElement('button');
  del.className = 'del';
  del.textContent = 'Delete';
  const close = document.createElement('button');
  close.textContent = 'Close';
  actions.append(del, close);
  popup.append(ta, actions);
  layer.appendChild(popup);
  ta.focus();

  ta.addEventListener('input', () => {
    note.text = ta.value;
    saveAnnotations();
    renderAnnotList();
  });
  close.addEventListener('click', () => popup.remove());
  del.addEventListener('click', () => {
    popup.remove();
    deleteAnnotation(note.id);
  });
}

function deleteAnnotation(id) {
  const idx = state.annotations.findIndex((a) => a.id === id);
  if (idx === -1) return;
  const [a] = state.annotations.splice(idx, 1);
  saveAnnotations();
  redrawAnnotations(a.page);
  renderAnnotList();
}

/* annotations sidebar */
function renderAnnotList() {
  const panel = $('panel-annots');
  panel.innerHTML = '';
  if (!state.annotations.length) {
    panel.innerHTML = '<p class="empty-msg">No comments yet.</p>';
    return;
  }
  const labels = { highlight: 'Highlight', draw: 'Drawing', note: 'Note' };
  const sorted = [...state.annotations].sort((a, b) =>
    a.page - b.page || a.created - b.created);
  for (const a of sorted) {
    const item = document.createElement('div');
    item.className = 'annot-item';
    const swatch = document.createElement('div');
    swatch.className = 'swatch';
    swatch.style.background = a.color;
    const body = document.createElement('div');
    body.className = 'annot-body';
    const meta = document.createElement('div');
    meta.className = 'annot-meta';
    meta.textContent = `${labels[a.type]} — page ${a.page}`;
    body.appendChild(meta);
    if (a.type === 'note') {
      const text = document.createElement('div');
      text.className = 'annot-text';
      text.textContent = a.text || '(empty note)';
      body.appendChild(text);
    }
    const del = document.createElement('button');
    del.className = 'annot-del';
    del.title = 'Delete';
    del.textContent = '✕';
    del.addEventListener('click', (e) => {
      e.stopPropagation();
      deleteAnnotation(a.id);
    });
    item.append(swatch, body, del);
    item.addEventListener('click', () => setCurrentPage(a.page));
    panel.appendChild(item);
  }
}

/* persistence */
function annotKey() { return 'pdfviewer-annots-' + state.fingerprint; }
function saveAnnotations() {
  try {
    localStorage.setItem(annotKey(), JSON.stringify(state.annotations));
  } catch (err) {
    console.warn('annotation save failed', err);
  }
}
function loadAnnotations() {
  try {
    state.annotations = JSON.parse(localStorage.getItem(annotKey())) || [];
  } catch (_) {
    state.annotations = [];
  }
}

/* ==================== Download & Print ==================== */
$('btnDownload').addEventListener('click', downloadPdf);
function downloadPdf() {
  if (!state.originalBytes) { toast('Open a PDF first.', true); return; }
  const blob = new Blob([state.originalBytes], { type: 'application/pdf' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = state.fileName || 'document.pdf';
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

$('btnPrint').addEventListener('click', printPdf);
async function printPdf() {
  const doc = state.pdfDoc;
  if (!doc) { toast('Open a PDF first.', true); return; }
  toast('Preparing pages for printing…');
  const container = $('printContainer');
  container.innerHTML = '';
  try {
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n);
      const vp1 = page.getViewport({ scale: 1 });
      const scale = Math.min(2, 1500 / vp1.width); // ~150dpi cap
      const vp = page.getViewport({ scale });
      const canvas = document.createElement('canvas');
      canvas.width = Math.floor(vp.width);
      canvas.height = Math.floor(vp.height);
      await page.render({ canvasContext: canvas.getContext('2d'), viewport: vp }).promise;
      const img = document.createElement('img');
      img.src = canvas.toDataURL('image/png');
      container.appendChild(img);
    }
    await new Promise((r) => setTimeout(r, 100));
    window.print();
  } catch (err) {
    console.error(err);
    toast('Printing failed: ' + err.message, true);
  } finally {
    setTimeout(() => { container.innerHTML = ''; }, 1000);
  }
}

/* ==================== Document properties ==================== */
$('btnProps').addEventListener('click', showProperties);
$('btnPropsClose').addEventListener('click', () => $('propsDialog').close());

async function showProperties() {
  const doc = state.pdfDoc;
  if (!doc) { toast('Open a PDF first.', true); return; }
  $('propsTable').innerHTML = '<tr><td>Loading…</td><td></td></tr>';
  $('propsDialog').showModal();
  let info = {};
  try {
    const md = await doc.getMetadata();
    info = md.info || {};
  } catch (_) {}
  const fmtDate = (d) => {
    if (!d) return '—';
    // PDF dates look like D:20240131123045+00'00'
    const m = /^D:(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?/.exec(d);
    if (!m) return d;
    return `${m[1]}-${m[2] || '01'}-${m[3] || '01'}` +
      (m[4] ? ` ${m[4]}:${m[5] || '00'}` : '');
  };
  const rows = [
    ['File name', state.fileName],
    ['File size', formatBytes(state.fileSize)],
    ['Title', info.Title || '—'],
    ['Author', info.Author || '—'],
    ['Subject', info.Subject || '—'],
    ['Keywords', info.Keywords || '—'],
    ['Created', fmtDate(info.CreationDate)],
    ['Modified', fmtDate(info.ModDate)],
    ['Application', info.Creator || '—'],
    ['PDF producer', info.Producer || '—'],
    ['PDF version', info.PDFFormatVersion || '—'],
    ['Page count', doc.numPages],
  ];
  $('propsTable').innerHTML = rows
    .map(([k, v]) => `<tr><td>${k}</td><td></td></tr>`).join('');
  // fill values via textContent to avoid HTML injection from metadata
  [...$('propsTable').querySelectorAll('tr')].forEach((tr, i) => {
    tr.children[1].textContent = String(rows[i][1]);
  });
}

/* ==================== Presentation mode ==================== */
$('btnPresent').addEventListener('click', enterPresentation);

async function enterPresentation() {
  if (!state.pdfDoc) { toast('Open a PDF first.', true); return; }
  state.prePresent = { zoom: state.zoom, viewMode: state.viewMode };
  state.presenting = true;
  document.body.classList.add('presenting');
  state.zoom = 'page-fit';
  state.viewMode = 'single';
  viewModeSelect.value = 'single';
  try { await viewerContainer.requestFullscreen(); } catch (_) {}
  await refreshLayout();
  viewerContainer.focus();
}

document.addEventListener('fullscreenchange', async () => {
  if (!document.fullscreenElement && state.presenting) {
    state.presenting = false;
    document.body.classList.remove('presenting');
    state.zoom = state.prePresent.zoom;
    state.viewMode = state.prePresent.viewMode;
    viewModeSelect.value = state.viewMode;
    syncZoomSelect();
    await refreshLayout();
  }
});

/* ==================== Check for updates ==================== */
$('versionLabel').textContent = 'v' + APP_VERSION;
$('btnUpdate').addEventListener('click', checkForUpdates);
$('btnUpdateClose').addEventListener('click', () => $('updateDialog').close());

function compareVersions(a, b) {
  const pa = a.split('.').map(Number), pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d;
  }
  return 0;
}

/* newest published version: GitHub release tag first, version.json as fallback */
async function fetchLatestVersion(signal) {
  try {
    const res = await fetch(RELEASES_API, { cache: 'no-store', signal });
    if (res.ok) {
      const data = await res.json();
      const v = String(data.tag_name || data.name || '').replace(/^v/i, '').trim();
      if (v) return v;
    }
  } catch (err) {
    if (signal.aborted) throw err;
  }
  const res = await fetch(VERSION_URL + '?t=' + Date.now(), { cache: 'no-store', signal });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const data = await res.json();
  const v = String(data.version || '').trim();
  if (!v) throw new Error('Malformed version manifest');
  return v;
}

async function checkForUpdates() {
  // Desktop app: the native auto-updater downloads the update and offers a
  // "Close and reopen now" / "I'll do it on my own" choice via system dialogs.
  if (window.electronAPI && window.electronAPI.checkUpdates) {
    const btn = $('btnUpdate');
    btn.classList.add('checking');
    let result = null;
    try {
      result = await window.electronAPI.checkUpdates();
    } catch (_) {}
    btn.classList.remove('checking');
    if (result && (result.status === 'uptodate' || result.status === 'downloaded')) {
      return;
    }
    // 'unpackaged' or updater error → fall back to the web-based check below
  }
  await checkForUpdatesWeb();
}

async function checkForUpdatesWeb() {
  const btn = $('btnUpdate');
  const msg = $('updateMessage');
  btn.classList.add('checking');
  msg.textContent = 'Checking for updates…';
  $('updateDialog').showModal();
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(new Error('timed out')), 10000);
  try {
    const latest = await fetchLatestVersion(abort.signal);
    if (compareVersions(latest, APP_VERSION) > 0) {
      msg.textContent =
        `A new version (v${latest}) is available — you are on v${APP_VERSION}. `;
      const link = document.createElement('a');
      link.href = RELEASES_PAGE;
      link.target = '_blank';
      link.rel = 'noopener';
      link.textContent = 'Download the latest installer';
      msg.appendChild(link);
    } else {
      msg.textContent = `You're up to date! v${APP_VERSION} is the latest version.`;
    }
  } catch (err) {
    msg.textContent =
      `Could not reach the update server (${err.message}). ` +
      `You are currently on v${APP_VERSION}. Please try again later.`;
  } finally {
    clearTimeout(timer);
    btn.classList.remove('checking');
  }
}

/* ==================== Keyboard shortcuts ==================== */
$('btnShortcutsClose').addEventListener('click', () => $('shortcutsDialog').close());

window.addEventListener('keydown', (e) => {
  const inField = /^(input|textarea|select)$/i.test(e.target.tagName);

  if (e.ctrlKey || e.metaKey) {
    switch (e.key.toLowerCase()) {
      case 'o': e.preventDefault(); fileInput.click(); return;
      case 's': e.preventDefault(); downloadPdf(); return;
      case 'p': e.preventDefault(); printPdf(); return;
      case 'f': e.preventDefault(); toggleSearch(true); return;
      case '=': case '+': e.preventDefault(); zoomStep(1); return;
      case '-': e.preventDefault(); zoomStep(-1); return;
      case '0': e.preventDefault(); setZoom('page-width'); return;
      case 'i': e.preventDefault(); showProperties(); return;
    }
    return;
  }

  if (inField) return;

  switch (e.key) {
    case 'ArrowLeft': case 'PageUp':
      e.preventDefault(); setCurrentPage(state.currentPage - 1); break;
    case 'ArrowRight': case 'PageDown':
      e.preventDefault(); setCurrentPage(state.currentPage + 1); break;
    case 'Home':
      e.preventDefault(); setCurrentPage(1); break;
    case 'End':
      e.preventDefault(); setCurrentPage(state.pdfDoc ? state.pdfDoc.numPages : 1); break;
    case 'F4':
      e.preventDefault(); sidebar.classList.toggle('collapsed'); break;
    case 'F5':
      e.preventDefault(); enterPresentation(); break;
    case 'r': rotate(90); break;
    case 'R': rotate(-90); break;
    case 'v': setTool('select'); break;
    case 'h': setTool('hand'); break;
    case 'H': setTool('highlight'); break;
    case 'd': setTool('draw'); break;
    case 'n': setTool('note'); break;
    case '?': $('shortcutsDialog').showModal(); break;
    case 'Escape':
      if (searchWrap.classList.contains('open')) toggleSearch();
      break;
  }
});

/* ==================== Electron desktop integration ==================== */
if (window.electronAPI) {
  // files opened via Windows file association / "Open with" arrive from the main process
  window.electronAPI.onOpenFile((payload) => {
    const bytes = payload.data instanceof Uint8Array
      ? payload.data
      : new Uint8Array(payload.data);
    loadDocument(bytes, payload.name, bytes.length)
      .catch((err) => toast('Could not open file: ' + err.message, true));
  });

  window.electronAPI.onMenu((action) => {
    switch (action) {
      case 'open': fileInput.click(); break;
      case 'save': downloadPdf(); break;
      case 'print': printPdf(); break;
      case 'properties': showProperties(); break;
      case 'find': toggleSearch(true); break;
      case 'zoom-in': zoomStep(1); break;
      case 'zoom-out': zoomStep(-1); break;
      case 'theme': $('btnTheme').click(); break;
      case 'present': enterPresentation(); break;
      case 'shortcuts': $('shortcutsDialog').showModal(); break;
      case 'update': checkForUpdates(); break;
    }
  });
}
