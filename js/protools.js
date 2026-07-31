/* PDF Viewer Pro — "Pro Tools" suite: organize, edit, redact, sign, OCR,
   forms, compare, convert, protect, read aloud. Loaded after app.js and
   shares its top-level scope (state, toast, loadDocument, …). */
'use strict';

/* ==================== Shared helpers ==================== */
function currentBytes() {
  return state.originalBytes ? state.originalBytes.slice() : null;
}

function requireDoc() {
  if (!state.pdfDoc) { toast('Open a PDF first.', true); return false; }
  return true;
}

function downloadBlob(bytes, name, type = 'application/pdf') {
  const blob = bytes instanceof Blob ? bytes : new Blob([bytes], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

async function reloadWithBytes(bytes, nameSuffix) {
  const base = (state.fileName || 'document.pdf').replace(/\.pdf$/i, '');
  await loadDocument(bytes, `${base}${nameSuffix}.pdf`, bytes.length);
}

function pickFile(accept, multiple = false) {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.multiple = multiple;
    input.onchange = () => resolve(multiple ? [...input.files] : input.files[0]);
    input.click();
  });
}

/* map a display-normalized point (x right, y down, in the page's default
   displayed orientation) to PDF user-space coordinates on a page that may
   carry its own /Rotate */
function normToPdfPoint(nx, ny, W, H, rot) {
  switch (((rot % 360) + 360) % 360) {
    case 90:  return [ny * W, nx * H];
    case 180: return [(1 - nx) * W, ny * H];
    case 270: return [(1 - ny) * W, (1 - nx) * H];
    default:  return [nx * W, (1 - ny) * H];
  }
}
function normRectToPdf(r, W, H, rot) {
  const [x1, y1] = normToPdfPoint(r.x, r.y, W, H, rot);
  const [x2, y2] = normToPdfPoint(r.x + r.w, r.y + r.h, W, H, rot);
  return { x: Math.min(x1, x2), y: Math.min(y1, y2),
           w: Math.abs(x2 - x1), h: Math.abs(y2 - y1) };
}
function hexToRgb01(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || '#ffd43b');
  const n = parseInt(m ? m[1] : 'ffd43b', 16);
  return [(n >> 16 & 255) / 255, (n >> 8 & 255) / 255, (n & 255) / 255];
}

/* ==================== Tools panel ==================== */
$('btnTools').addEventListener('click', () => $('toolsDialog').showModal());
$('btnToolsClose').addEventListener('click', () => $('toolsDialog').close());

document.querySelectorAll('#toolsDialog [data-action]').forEach((btn) => {
  btn.addEventListener('click', () => {
    $('toolsDialog').close();
    runToolAction(btn.dataset.action);
  });
});

function runToolAction(action) {
  switch (action) {
    case 'save-edits': saveWithEdits(); break;
    case 'organize': openOrganize(); break;
    case 'add-text': activatePlacementTool('text', 'Click anywhere on a page to place text'); break;
    case 'whiteout': activatePlacementTool('whiteout', 'Drag over content to white it out, then double-click the patch to type replacement text'); break;
    case 'add-image': startAddImage(); break;
    case 'sign': openSignature(); break;
    case 'redact': activatePlacementTool('redact', 'Drag over content to mark it for redaction, then run Apply Redactions'); break;
    case 'apply-redactions': applyRedactions(); break;
    case 'ocr': runOcr(); break;
    case 'forms': openForms(); break;
    case 'compare': runCompare(); break;
    case 'convert': $('convertDialog').showModal(); break;
    case 'protect': openProtect(); break;
    case 'read-aloud': toggleReadAloud(); break;
  }
}

function activatePlacementTool(tool, hint) {
  if (!requireDoc()) return;
  setTool(tool);
  toast(hint);
}

/* ==================== New annotation types ====================
   'text'     {page,x,y,size,color,text}
   'whiteout' {page,rect:{x,y,w,h},text}
   'image'    {page,rect:{x,y,w,h},dataUrl}
   'redact'   {page,rect:{x,y,w,h}}
   'signature'{page,rect:{x,y,w,h},dataUrl}
   All coordinates are display-normalized like the existing types, so they
   inherit undo/redo, persistence, and the comments panel for free. */

const PRO_TYPE_LABELS = {
  text: 'Text', whiteout: 'Whiteout', image: 'Image',
  redact: 'Redaction mark', signature: 'Signature',
};

/* placement + rect-drag handling via delegation on the viewer */
let proDrag = null;
viewerContainer.addEventListener('pointerdown', (e) => {
  const wrap = e.target.closest('.page-wrap');
  if (!wrap || e.button !== 0) return;
  const tool = state.tool;
  if (!['whiteout', 'redact'].includes(tool)) return;
  e.preventDefault();
  const b = wrap.getBoundingClientRect();
  proDrag = {
    tool, wrap, page: Number(wrap.dataset.page), b,
    x0: (e.clientX - b.left) / b.width,
    y0: (e.clientY - b.top) / b.height,
    ghost: document.createElement('div'),
  };
  proDrag.ghost.className = 'pro-ghost ' + tool;
  ensureAnnotLayer(wrap).appendChild(proDrag.ghost);
});
viewerContainer.addEventListener('pointermove', (e) => {
  if (!proDrag) return;
  const { b, ghost, x0, y0 } = proDrag;
  const x1 = Math.min(Math.max((e.clientX - b.left) / b.width, 0), 1);
  const y1 = Math.min(Math.max((e.clientY - b.top) / b.height, 0), 1);
  const r = { x: Math.min(x0, x1), y: Math.min(y0, y1),
              w: Math.abs(x1 - x0), h: Math.abs(y1 - y0) };
  proDrag.rect = r;
  ghost.style.left = r.x * 100 + '%';
  ghost.style.top = r.y * 100 + '%';
  ghost.style.width = r.w * 100 + '%';
  ghost.style.height = r.h * 100 + '%';
});
viewerContainer.addEventListener('pointerup', () => {
  if (!proDrag) return;
  const { tool, page, rect, ghost } = proDrag;
  ghost.remove();
  proDrag = null;
  if (!rect || rect.w < 0.005 || rect.h < 0.004) return;
  snapshot();
  const viewRect = unrotateRect(rect, state.rotation);
  state.annotations.push({
    id: uid(), type: tool, page, rect: viewRect,
    text: '', created: Date.now(),
  });
  saveAnnotations();
  redrawAnnotations(page);
  renderAnnotList();
});

/* click-to-place for text / image / signature */
viewerContainer.addEventListener('click', (e) => {
  const wrap = e.target.closest('.page-wrap');
  if (!wrap) return;
  const tool = state.tool;
  if (!['text', 'image-place', 'sign-place'].includes(tool)) return;
  if (e.target.closest('.note-popup') || e.target.closest('.pro-text-edit')) return;
  const b = wrap.getBoundingClientRect();
  const page = Number(wrap.dataset.page);
  const vx = (e.clientX - b.left) / b.width;
  const vy = (e.clientY - b.top) / b.height;
  const [nx, ny] = viewToNorm(vx, vy, state.rotation);

  if (tool === 'text') {
    snapshot();
    const a = {
      id: uid(), type: 'text', page, x: nx, y: ny,
      size: 16, color: '#212529', text: '',
      created: Date.now(),
    };
    state.annotations.push(a);
    saveAnnotations();
    redrawAnnotations(page);
    renderAnnotList();
    openTextEditor(wrap, a);
  } else if (tool === 'image-place' && pendingImage) {
    snapshot();
    const aspect = pendingImage.h / pendingImage.w;
    const w = 0.3;
    const wrapAspect = b.height / b.width;
    const rect = { x: vx - w / 2, y: vy, w, h: w * aspect / wrapAspect };
    state.annotations.push({
      id: uid(), type: 'image', page, rect: unrotateRect(rect, state.rotation),
      dataUrl: pendingImage.dataUrl, created: Date.now(),
    });
    pendingImage = null;
    setTool('select');
    saveAnnotations();
    redrawAnnotations(page);
    renderAnnotList();
  } else if (tool === 'sign-place' && pendingSignature) {
    snapshot();
    const aspect = pendingSignature.h / pendingSignature.w;
    const w = 0.25;
    const wrapAspect = b.height / b.width;
    const rect = { x: vx - w / 2, y: vy - (w * aspect / wrapAspect) / 2, w, h: w * aspect / wrapAspect };
    state.annotations.push({
      id: uid(), type: 'signature', page, rect: unrotateRect(rect, state.rotation),
      dataUrl: pendingSignature.dataUrl, created: Date.now(),
    });
    pendingSignature = null;
    setTool('select');
    saveAnnotations();
    redrawAnnotations(page);
    renderAnnotList();
    toast('Signature placed. Use Tools → Save with edits to flatten it into the PDF.');
  }
});

/* rendering hook called from renderAnnotationLayer for unknown types */
function renderProAnnotation(layer, wrap, a) {
  const rot = state.rotation;
  if (a.type === 'text') {
    const [vx, vy] = normToView(a.x, a.y, rot);
    const div = document.createElement('div');
    div.className = 'pro-text';
    div.style.left = vx * 100 + '%';
    div.style.top = vy * 100 + '%';
    div.style.fontSize = (a.size * state.scale) + 'px';
    div.style.color = a.color || '#212529';
    div.textContent = a.text || '(empty — double-click to edit)';
    div.title = 'Double-click to edit; right-click to delete';
    div.addEventListener('dblclick', (e) => { e.stopPropagation(); openTextEditor(wrap, a); });
    div.addEventListener('contextmenu', (e) => { e.preventDefault(); deleteAnnotation(a.id); });
    makeDraggable(div, wrap, a);
    layer.appendChild(div);
    return true;
  }
  if (a.type === 'whiteout' || a.type === 'redact' || a.type === 'image' || a.type === 'signature') {
    const r = normRectToView(a.rect, rot);
    const div = document.createElement('div');
    div.className = 'pro-rect ' + a.type;
    div.style.left = r.x * 100 + '%';
    div.style.top = r.y * 100 + '%';
    div.style.width = r.w * 100 + '%';
    div.style.height = r.h * 100 + '%';
    if (a.type === 'whiteout') {
      div.textContent = a.text || '';
      div.style.fontSize = ((a.size || 14) * state.scale) + 'px';
      div.title = 'Whiteout — double-click to type replacement text; right-click to delete';
      div.addEventListener('dblclick', (e) => {
        e.stopPropagation();
        const text = prompt('Replacement text (leave empty for blank whiteout):', a.text || '');
        if (text === null) return;
        snapshot();
        a.text = text;
        saveAnnotations();
        redrawAnnotations(a.page);
      });
    } else if (a.type === 'redact') {
      div.title = 'Marked for redaction — right-click to remove the mark. Run Tools → Apply Redactions to make permanent.';
    } else {
      const img = document.createElement('img');
      img.src = a.dataUrl;
      img.draggable = false;
      div.appendChild(img);
      div.title = (a.type === 'signature' ? 'Signature' : 'Image') + ' — drag to move; right-click to delete';
    }
    div.addEventListener('contextmenu', (e) => { e.preventDefault(); deleteAnnotation(a.id); });
    makeDraggable(div, wrap, a);
    layer.appendChild(div);
    return true;
  }
  return false;
}

function makeDraggable(el, wrap, a) {
  el.addEventListener('pointerdown', (e) => {
    if (state.tool !== 'select' || e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const b = wrap.getBoundingClientRect();
    const startX = e.clientX, startY = e.clientY;
    let last = { x: e.clientX, y: e.clientY };
    let moved = false, snapped = false;
    const onMove = (ev) => {
      if (!snapped && (Math.abs(ev.clientX - startX) > 3 || Math.abs(ev.clientY - startY) > 3)) {
        snapshot();
        snapped = true;
      }
      if (!snapped) return;
      moved = true;
      const dxv = (ev.clientX - last.x) / b.width;
      const dyv = (ev.clientY - last.y) / b.height;
      // rotate the display-space delta back into stored (default-view) space
      const [dnx, dny] = (() => {
        switch (state.rotation) {
          case 90:  return [dyv, -dxv];
          case 180: return [-dxv, -dyv];
          case 270: return [-dyv, dxv];
          default:  return [dxv, dyv];
        }
      })();
      if (a.rect) { a.rect.x += dnx; a.rect.y += dny; }
      else { a.x += dnx; a.y += dny; }
      last = { x: ev.clientX, y: ev.clientY };
      redrawAnnotations(a.page);
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      if (moved) { saveAnnotations(); renderAnnotList(); }
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  });
}

function openTextEditor(wrap, a) {
  document.querySelectorAll('.pro-text-edit').forEach((p) => p.remove());
  const layer = ensureAnnotLayer(wrap);
  const [vx, vy] = normToView(a.x, a.y, state.rotation);
  const box = document.createElement('div');
  box.className = 'note-popup pro-text-edit';
  box.style.left = `min(${vx * 100}%, calc(100% - 230px))`;
  box.style.top = `calc(${vy * 100}% + 10px)`;
  const ta = document.createElement('textarea');
  ta.value = a.text || '';
  ta.placeholder = 'Type text…';
  const row = document.createElement('div');
  row.className = 'note-actions';
  const size = document.createElement('select');
  [10, 12, 14, 16, 20, 24, 32, 48].forEach((s) => {
    const o = document.createElement('option');
    o.value = s; o.textContent = s + 'pt';
    if (s === (a.size || 16)) o.selected = true;
    size.appendChild(o);
  });
  const color = document.createElement('input');
  color.type = 'color';
  color.value = a.color || '#212529';
  const done = document.createElement('button');
  done.textContent = 'Done';
  const del = document.createElement('button');
  del.className = 'del';
  del.textContent = 'Delete';
  row.append(size, color, del, done);
  box.append(ta, row);
  layer.appendChild(box);
  ta.focus();

  let snapped = false;
  const apply = () => {
    if (!snapped) { snapshot(); snapped = true; }
    a.text = ta.value;
    a.size = Number(size.value);
    a.color = color.value;
    saveAnnotations();
  };
  ta.addEventListener('input', apply);
  size.addEventListener('change', () => { apply(); redrawAnnotations(a.page); });
  color.addEventListener('change', () => { apply(); redrawAnnotations(a.page); });
  done.addEventListener('click', () => {
    box.remove();
    if (!(a.text || '').trim()) deleteAnnotation(a.id);
    else redrawAnnotations(a.page);
    setTool('select');
  });
  del.addEventListener('click', () => { box.remove(); deleteAnnotation(a.id); });
}

/* ==================== Add image ==================== */
let pendingImage = null;
let pendingSignature = null;

async function startAddImage() {
  if (!requireDoc()) return;
  const file = await pickFile('image/png,image/jpeg');
  if (!file) return;
  const dataUrl = await downscaleImage(file, 1600);
  const dim = await imageSize(dataUrl);
  pendingImage = { dataUrl, ...dim };
  setTool('image-place');
  toast('Click on a page to place the image');
}

function imageSize(dataUrl) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve({ w: img.naturalWidth, h: img.naturalHeight });
    img.src = dataUrl;
  });
}

async function downscaleImage(file, maxDim) {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = url; });
    const scale = Math.min(1, maxDim / Math.max(img.naturalWidth, img.naturalHeight));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(img.naturalWidth * scale);
    canvas.height = Math.round(img.naturalHeight * scale);
    canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
    return file.type === 'image/png' && scale === 1
      ? canvas.toDataURL('image/png')
      : canvas.toDataURL(file.type === 'image/png' ? 'image/png' : 'image/jpeg', 0.88);
  } finally {
    URL.revokeObjectURL(url);
  }
}

/* ==================== Signature ==================== */
function openSignature() {
  if (!requireDoc()) return;
  const dlg = $('signDialog');
  const canvas = $('signCanvas');
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.lineWidth = 2.5;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.strokeStyle = '#1a2b6d';
  let drawing = false, drew = false;
  canvas.onpointerdown = (e) => {
    drawing = true;
    const r = canvas.getBoundingClientRect();
    ctx.beginPath();
    ctx.moveTo((e.clientX - r.left) * canvas.width / r.width, (e.clientY - r.top) * canvas.height / r.height);
    canvas.setPointerCapture(e.pointerId);
  };
  canvas.onpointermove = (e) => {
    if (!drawing) return;
    const r = canvas.getBoundingClientRect();
    ctx.lineTo((e.clientX - r.left) * canvas.width / r.width, (e.clientY - r.top) * canvas.height / r.height);
    ctx.stroke();
    drew = true;
  };
  canvas.onpointerup = () => { drawing = false; };

  $('btnSignClear').onclick = () => { ctx.clearRect(0, 0, canvas.width, canvas.height); drew = false; };
  $('btnSignType').onclick = () => {
    const name = $('signTypeInput').value.trim();
    if (!name) { toast('Type your name first.', true); return; }
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.save();
    ctx.fillStyle = '#1a2b6d';
    ctx.font = 'italic 64px "Segoe Script", "Brush Script MT", cursive';
    ctx.textBaseline = 'middle';
    ctx.fillText(name, 24, canvas.height / 2, canvas.width - 48);
    ctx.restore();
    drew = true;
  };
  $('btnSignPlace').onclick = () => {
    if (!drew) { toast('Draw or type a signature first.', true); return; }
    // trim to content bounds
    const { data, width, height } = ctx.getImageData(0, 0, canvas.width, canvas.height);
    let minX = width, minY = height, maxX = 0, maxY = 0;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        if (data[(y * width + x) * 4 + 3] > 10) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }
    if (maxX <= minX) { toast('Signature is empty.', true); return; }
    const pad = 8;
    const out = document.createElement('canvas');
    out.width = maxX - minX + pad * 2;
    out.height = maxY - minY + pad * 2;
    out.getContext('2d').drawImage(canvas, minX - pad, minY - pad, out.width, out.height, 0, 0, out.width, out.height);
    pendingSignature = { dataUrl: out.toDataURL('image/png'), w: out.width, h: out.height };
    dlg.close();
    setTool('sign-place');
    toast('Click on the page where the signature should go');
  };
  $('btnSignCancel').onclick = () => dlg.close();
  dlg.showModal();
}

/* ==================== Flatten & save (the real "editing" output) ==================== */
async function buildEditedPdf({ includeRedactMarks = false } = {}) {
  const { PDFDocument, StandardFonts, rgb, degrees } = PDFLib;
  const src = await PDFDocument.load(currentBytes(), { ignoreEncryption: true });
  const font = await src.embedFont(StandardFonts.Helvetica);
  const pages = src.getPages();
  const imageCache = new Map();

  const embedDataUrl = async (dataUrl) => {
    if (imageCache.has(dataUrl)) return imageCache.get(dataUrl);
    const bytes = Uint8Array.from(atob(dataUrl.split(',')[1]), (c) => c.charCodeAt(0));
    const img = dataUrl.startsWith('data:image/png')
      ? await src.embedPng(bytes) : await src.embedJpg(bytes);
    imageCache.set(dataUrl, img);
    return img;
  };

  for (const a of state.annotations) {
    const page = pages[a.page - 1];
    if (!page) continue;
    const W = page.getWidth(), H = page.getHeight();
    const rot = page.getRotation().angle || 0;
    const textRot = degrees(rot);

    if (a.type === 'highlight') {
      const [r, g, b] = hexToRgb01(a.color);
      for (const nr of a.rects) {
        const rect = normRectToPdf(nr, W, H, rot);
        page.drawRectangle({ x: rect.x, y: rect.y, width: rect.w, height: rect.h,
          color: rgb(r, g, b), opacity: 0.35 });
      }
    } else if (a.type === 'draw') {
      const [r, g, b] = hexToRgb01(a.color);
      const pts = a.points.map(([nx, ny]) => normToPdfPoint(nx, ny, W, H, rot));
      for (let i = 1; i < pts.length; i++) {
        page.drawLine({
          start: { x: pts[i - 1][0], y: pts[i - 1][1] },
          end: { x: pts[i][0], y: pts[i][1] },
          thickness: Math.max(1, (a.width || 2) * (rot % 180 ? H / 800 : W / 800) * 1.6),
          color: rgb(r, g, b), lineCap: 1,
        });
      }
    } else if (a.type === 'whiteout') {
      const rect = normRectToPdf(a.rect, W, H, rot);
      page.drawRectangle({ x: rect.x, y: rect.y, width: rect.w, height: rect.h, color: rgb(1, 1, 1) });
      if (a.text) {
        const size = (a.size || 14) * (W / 612);
        page.drawText(a.text, {
          x: rect.x + 2, y: rect.y + rect.h - size,
          size, font, color: rgb(0.13, 0.14, 0.16),
          maxWidth: Math.max(20, rect.w - 4), lineHeight: size * 1.25,
          rotate: textRot,
        });
      }
    } else if (a.type === 'text') {
      if (!(a.text || '').trim()) continue;
      const [x, y] = normToPdfPoint(a.x, a.y, W, H, rot);
      const [r, g, b] = hexToRgb01(a.color || '#212529');
      const size = (a.size || 16) * (W / 612);
      page.drawText(a.text, {
        x, y: y - size, size, font, color: rgb(r, g, b),
        maxWidth: W * 0.9, lineHeight: size * 1.25, rotate: textRot,
      });
    } else if (a.type === 'image' || a.type === 'signature') {
      const rect = normRectToPdf(a.rect, W, H, rot);
      const img = await embedDataUrl(a.dataUrl);
      page.drawImage(img, { x: rect.x, y: rect.y, width: rect.w, height: rect.h, rotate: degrees(0) });
    } else if (a.type === 'redact' && includeRedactMarks) {
      const rect = normRectToPdf(a.rect, W, H, rot);
      page.drawRectangle({ x: rect.x, y: rect.y, width: rect.w, height: rect.h, color: rgb(0, 0, 0) });
    }
    // sticky notes stay app-side (they have no fixed print size); listed in Comments
  }
  return src.save({ useObjectStreams: true });
}

async function saveWithEdits() {
  if (!requireDoc()) return;
  const pending = state.annotations.filter((a) => a.type === 'redact').length;
  if (pending) {
    toast(`${pending} redaction mark(s) pending — run Apply Redactions first, or they will be skipped.`, true);
  }
  toast('Building edited PDF…');
  try {
    const bytes = await buildEditedPdf();
    const base = (state.fileName || 'document.pdf').replace(/\.pdf$/i, '');
    downloadBlob(bytes, `${base}-edited.pdf`);
    toast('Saved with all edits flattened in.');
  } catch (err) {
    console.error(err);
    toast('Save failed: ' + err.message, true);
  }
}

/* ==================== Redaction (permanent) ==================== */
async function applyRedactions() {
  if (!requireDoc()) return;
  const marks = state.annotations.filter((a) => a.type === 'redact');
  if (!marks.length) { toast('No redaction marks. Use Tools → Mark for Redaction first.', true); return; }
  if (!confirm(`Permanently redact ${marks.length} area(s)? Affected pages are converted to images so the content underneath is truly removed. This cannot be undone in the output file.`)) return;

  toast('Applying redactions…');
  try {
    const { PDFDocument, rgb } = PDFLib;
    const src = await PDFDocument.load(currentBytes(), { ignoreEncryption: true });
    const byPage = new Map();
    marks.forEach((m) => {
      if (!byPage.has(m.page)) byPage.set(m.page, []);
      byPage.get(m.page).push(m.rect);
    });

    for (const [pageNum, rects] of byPage) {
      const page = await state.pdfDoc.getPage(pageNum);
      const rot = (page.rotate) % 360;
      const vp = page.getViewport({ scale: 2.2, rotation: rot });
      const canvas = document.createElement('canvas');
      canvas.width = Math.floor(vp.width);
      canvas.height = Math.floor(vp.height);
      const ctx = canvas.getContext('2d');
      await page.render({ canvasContext: ctx, viewport: vp }).promise;
      ctx.fillStyle = '#000';
      for (const nr of rects) {
        ctx.fillRect(nr.x * canvas.width, nr.y * canvas.height,
          nr.w * canvas.width, nr.h * canvas.height);
      }
      const pngBytes = Uint8Array.from(
        atob(canvas.toDataURL('image/png').split(',')[1]), (c) => c.charCodeAt(0));
      const img = await src.embedPng(pngBytes);
      const old = src.getPage(pageNum - 1);
      const W = old.getWidth(), H = old.getHeight();
      src.removePage(pageNum - 1);
      const fresh = src.insertPage(pageNum - 1, [W, H]);
      fresh.drawRectangle({ x: 0, y: 0, width: W, height: H, color: rgb(1, 1, 1) });
      // the raster is in display orientation; counter-rotate page sizes if needed
      if ((old.getRotation().angle || 0) % 180 !== 0) {
        fresh.setSize(H, W);
        fresh.drawImage(img, { x: 0, y: 0, width: H, height: W });
      } else {
        fresh.drawImage(img, { x: 0, y: 0, width: W, height: H });
      }
    }

    const bytes = await src.save({ useObjectStreams: true });
    // drop the marks + any annotations on redacted pages (they were burned/removed)
    snapshot();
    state.annotations = state.annotations.filter((a) => a.type !== 'redact');
    saveAnnotations();
    await reloadWithBytes(new Uint8Array(bytes), '-redacted');
    toast('Redactions applied permanently. Review, then save or download.');
  } catch (err) {
    console.error(err);
    toast('Redaction failed: ' + err.message, true);
  }
}

/* ==================== Organize pages ==================== */
let orgState = null;

async function openOrganize() {
  if (!requireDoc()) return;
  const doc = state.pdfDoc;
  orgState = { order: [], rotations: {}, deleted: new Set(), inserts: [] };
  for (let i = 1; i <= doc.numPages; i++) orgState.order.push(i);
  const grid = $('orgGrid');
  grid.innerHTML = '';
  $('organizeDialog').showModal();
  for (let n = 1; n <= doc.numPages; n++) {
    const card = document.createElement('div');
    card.className = 'org-card';
    card.dataset.page = n;
    card.draggable = true;
    const canvas = document.createElement('canvas');
    const label = document.createElement('div');
    label.className = 'org-label';
    label.textContent = 'Page ' + n;
    const row = document.createElement('div');
    row.className = 'org-actions';
    const rotBtn = document.createElement('button');
    rotBtn.textContent = '⟳';
    rotBtn.title = 'Rotate 90°';
    const delBtn = document.createElement('button');
    delBtn.textContent = '✕';
    delBtn.title = 'Delete page';
    const selBox = document.createElement('input');
    selBox.type = 'checkbox';
    selBox.title = 'Select for extraction';
    row.append(selBox, rotBtn, delBtn);
    card.append(canvas, label, row);
    grid.appendChild(card);

    rotBtn.addEventListener('click', () => {
      orgState.rotations[n] = ((orgState.rotations[n] || 0) + 90) % 360;
      canvas.style.transform = `rotate(${orgState.rotations[n]}deg)`;
    });
    delBtn.addEventListener('click', () => {
      if (orgState.deleted.has(n)) orgState.deleted.delete(n);
      else orgState.deleted.add(n);
      card.classList.toggle('deleted', orgState.deleted.has(n));
    });
    card.addEventListener('dragstart', (e) => e.dataTransfer.setData('text/plain', n));
    card.addEventListener('dragover', (e) => e.preventDefault());
    card.addEventListener('drop', (e) => {
      e.preventDefault();
      const from = Number(e.dataTransfer.getData('text/plain'));
      const to = n;
      const order = orgState.order;
      const fi = order.indexOf(from), ti = order.indexOf(to);
      if (fi === -1 || ti === -1 || fi === ti) return;
      order.splice(ti, 0, order.splice(fi, 1)[0]);
      // re-flow DOM to match
      const cards = new Map([...grid.children].map((c) => [Number(c.dataset.page), c]));
      order.forEach((p) => grid.appendChild(cards.get(p)));
    });

    const page = await doc.getPage(n);
    const vp1 = page.getViewport({ scale: 1 });
    const scale = 130 / vp1.width;
    const vp = page.getViewport({ scale });
    canvas.width = Math.floor(vp.width);
    canvas.height = Math.floor(vp.height);
    await page.render({ canvasContext: canvas.getContext('2d'), viewport: vp }).promise;
  }
}

$('btnOrgApply').addEventListener('click', async () => {
  const kept = orgState.order.filter((p) => !orgState.deleted.has(p));
  if (!kept.length) { toast('Cannot delete every page.', true); return; }
  toast('Rebuilding document…');
  try {
    const { PDFDocument, degrees } = PDFLib;
    const src = await PDFDocument.load(currentBytes(), { ignoreEncryption: true });
    const out = await PDFDocument.create();
    const copied = await out.copyPages(src, kept.map((p) => p - 1));
    copied.forEach((pg, i) => {
      const extra = orgState.rotations[kept[i]] || 0;
      if (extra) pg.setRotation(degrees(((pg.getRotation().angle || 0) + extra) % 360));
      out.addPage(pg);
    });
    const bytes = await out.save({ useObjectStreams: true });
    $('organizeDialog').close();
    await reloadWithBytes(new Uint8Array(bytes), '-organized');
    toast('Pages updated. Download to keep the new file.');
  } catch (err) {
    console.error(err);
    toast('Organize failed: ' + err.message, true);
  }
});

$('btnOrgExtract').addEventListener('click', async () => {
  const selected = [...$('orgGrid').querySelectorAll('.org-card')]
    .filter((c) => c.querySelector('input[type=checkbox]').checked)
    .map((c) => Number(c.dataset.page));
  if (!selected.length) { toast('Tick the pages to extract first.', true); return; }
  try {
    const { PDFDocument } = PDFLib;
    const src = await PDFDocument.load(currentBytes(), { ignoreEncryption: true });
    const out = await PDFDocument.create();
    (await out.copyPages(src, selected.map((p) => p - 1))).forEach((p) => out.addPage(p));
    const bytes = await out.save();
    const base = (state.fileName || 'document.pdf').replace(/\.pdf$/i, '');
    downloadBlob(bytes, `${base}-pages-${selected.join(',')}.pdf`);
    toast(`Extracted ${selected.length} page(s).`);
  } catch (err) {
    toast('Extract failed: ' + err.message, true);
  }
});

$('btnOrgInsert').addEventListener('click', async () => {
  const file = await pickFile('application/pdf,.pdf');
  if (!file) return;
  try {
    const { PDFDocument } = PDFLib;
    const src = await PDFDocument.load(currentBytes(), { ignoreEncryption: true });
    const add = await PDFDocument.load(new Uint8Array(await file.arrayBuffer()), { ignoreEncryption: true });
    (await src.copyPages(add, add.getPageIndices())).forEach((p) => src.addPage(p));
    const bytes = await src.save({ useObjectStreams: true });
    $('organizeDialog').close();
    await reloadWithBytes(new Uint8Array(bytes), '-merged');
    toast(`Appended ${add.getPageCount()} page(s) from ${file.name}.`);
  } catch (err) {
    toast('Insert failed: ' + err.message, true);
  }
});

$('btnOrgClose').addEventListener('click', () => $('organizeDialog').close());

/* ==================== OCR ==================== */
async function runOcr() {
  if (!requireDoc()) return;
  const doc = state.pdfDoc;
  const dlg = $('ocrDialog');
  const status = $('ocrStatus');
  dlg.showModal();
  status.textContent = 'Loading OCR engine…';
  try {
    const useIpc = !!(window.electronAPI && window.electronAPI.ocrImage);
    let worker = null;
    if (!useIpc) {
      worker = await Tesseract.createWorker('eng', 1, {
        workerPath: 'lib/tesseract/worker.min.js',
        corePath: 'lib/tesseract',
        langPath: 'lib/tesseract',
        gzip: true,
      });
    }

    const { PDFDocument, StandardFonts, rgb } = PDFLib;
    const src = await PDFDocument.load(currentBytes(), { ignoreEncryption: true });
    const font = await src.embedFont(StandardFonts.Helvetica);
    let fullText = '';
    let wordsTotal = 0;

    for (let n = 1; n <= doc.numPages; n++) {
      status.textContent = `Recognizing page ${n} of ${doc.numPages}…`;
      const page = await doc.getPage(n);
      const vp = page.getViewport({ scale: 2, rotation: page.rotate % 360 });
      const canvas = document.createElement('canvas');
      canvas.width = Math.floor(vp.width);
      canvas.height = Math.floor(vp.height);
      await page.render({ canvasContext: canvas.getContext('2d'), viewport: vp }).promise;
      const dataUrl = canvas.toDataURL('image/png');

      let words, pageText;
      if (useIpc) {
        const res = await window.electronAPI.ocrImage(dataUrl);
        if (res.error) throw new Error(res.error);
        words = res.words || [];
        pageText = res.text || '';
      } else {
        const res = await worker.recognize(dataUrl);
        words = (res.data.words || []).map((w) => ({
          text: w.text, bbox: w.bbox, confidence: w.confidence,
        }));
        pageText = res.data.text || '';
      }
      fullText += `\n\n[Page ${n}]\n` + pageText.trim();

      const pdfPage = src.getPage(n - 1);
      const W = pdfPage.getWidth(), H = pdfPage.getHeight();
      const rot = pdfPage.getRotation().angle || 0;
      for (const w of words) {
        if (!w.text || !w.text.trim() || (w.confidence || 0) < 35) continue;
        const nx = w.bbox.x0 / canvas.width;
        const ny = w.bbox.y1 / canvas.height;
        const nh = (w.bbox.y1 - w.bbox.y0) / canvas.height;
        const [x, y] = normToPdfPoint(nx, ny, W, H, rot);
        const size = Math.max(4, nh * (rot % 180 ? W : H) * 0.85);
        try {
          pdfPage.drawText(w.text.replace(/[^\x20-\x7E]/g, ''), {
            x, y, size, font, color: rgb(0, 0, 0), opacity: 0,
          });
          wordsTotal++;
        } catch (_) { /* skip unencodable words */ }
      }
    }
    if (worker) await worker.terminate();

    if (!wordsTotal) {
      status.textContent = 'No recognizable text found — the document may already be text-based or too low-resolution.';
      return;
    }
    status.textContent = `Recognized ${wordsTotal} words. Building searchable PDF…`;
    const bytes = await src.save({ useObjectStreams: true });
    const base = (state.fileName || 'document.pdf').replace(/\.pdf$/i, '');
    downloadBlob(bytes, `${base}-searchable.pdf`);
    downloadBlob(new Blob([fullText.trim()], { type: 'text/plain' }), `${base}-ocr.txt`);
    status.textContent =
      `Done — recognized ${wordsTotal} words across ${doc.numPages} page(s). ` +
      'Downloaded a searchable PDF (invisible text layer) and a plain-text transcript.';
  } catch (err) {
    console.error(err);
    status.textContent = 'OCR failed: ' + err.message;
  }
}
$('btnOcrClose').addEventListener('click', () => $('ocrDialog').close());

/* ==================== Forms ==================== */
async function openForms() {
  if (!requireDoc()) return;
  const list = $('formsList');
  list.innerHTML = '';
  try {
    const { PDFDocument } = PDFLib;
    const doc = await PDFDocument.load(currentBytes(), { ignoreEncryption: true });
    const fields = doc.getForm().getFields();
    if (!fields.length) {
      list.innerHTML = '<p class="empty-msg">This document has no fillable form fields.</p>';
      $('btnFormsSave').style.display = 'none';
    } else {
      $('btnFormsSave').style.display = '';
      for (const f of fields) {
        const row = document.createElement('div');
        row.className = 'form-row';
        const label = document.createElement('label');
        label.textContent = f.getName();
        row.appendChild(label);
        const type = f.constructor.name;
        let input;
        if (type === 'PDFCheckBox') {
          input = document.createElement('input');
          input.type = 'checkbox';
          input.checked = f.isChecked();
        } else if (type === 'PDFDropdown' || type === 'PDFOptionList') {
          input = document.createElement('select');
          f.getOptions().forEach((o) => {
            const opt = document.createElement('option');
            opt.value = o; opt.textContent = o;
            input.appendChild(opt);
          });
          const sel = f.getSelected();
          if (sel && sel[0]) input.value = sel[0];
        } else if (type === 'PDFRadioGroup') {
          input = document.createElement('select');
          f.getOptions().forEach((o) => {
            const opt = document.createElement('option');
            opt.value = o; opt.textContent = o;
            input.appendChild(opt);
          });
          if (f.getSelected()) input.value = f.getSelected();
        } else {
          input = document.createElement('input');
          input.type = 'text';
          try { input.value = f.getText() || ''; } catch (_) {}
        }
        input.dataset.field = f.getName();
        input.dataset.type = type;
        row.appendChild(input);
        list.appendChild(row);
      }
    }
  } catch (err) {
    list.innerHTML = '<p class="empty-msg">Could not read form fields: ' + err.message + '</p>';
  }
  $('formsDialog').showModal();
}

$('btnFormsSave').addEventListener('click', async () => {
  try {
    const { PDFDocument } = PDFLib;
    const doc = await PDFDocument.load(currentBytes(), { ignoreEncryption: true });
    const form = doc.getForm();
    for (const input of $('formsList').querySelectorAll('[data-field]')) {
      const name = input.dataset.field, type = input.dataset.type;
      try {
        if (type === 'PDFCheckBox') {
          const f = form.getCheckBox(name);
          input.checked ? f.check() : f.uncheck();
        } else if (type === 'PDFDropdown') {
          form.getDropdown(name).select(input.value);
        } else if (type === 'PDFOptionList') {
          form.getOptionList(name).select(input.value);
        } else if (type === 'PDFRadioGroup') {
          form.getRadioGroup(name).select(input.value);
        } else {
          form.getTextField(name).setText(input.value);
        }
      } catch (err) { console.warn('field', name, err); }
    }
    const bytes = await doc.save({ useObjectStreams: true });
    $('formsDialog').close();
    await reloadWithBytes(new Uint8Array(bytes), '-filled');
    toast('Form filled. Download to keep the file.');
  } catch (err) {
    toast('Form save failed: ' + err.message, true);
  }
});
$('btnFormsClose').addEventListener('click', () => $('formsDialog').close());

/* ==================== Compare ==================== */
async function runCompare() {
  if (!requireDoc()) return;
  const file = await pickFile('application/pdf,.pdf');
  if (!file) return;
  toast('Comparing documents…');
  try {
    const other = await pdfjsLib.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
    const pageText = async (doc, n) => {
      const tc = await (await doc.getPage(n)).getTextContent();
      return tc.items.map((i) => i.str).join(' ').replace(/\s+/g, ' ').trim();
    };
    const maxPages = Math.max(state.pdfDoc.numPages, other.numPages);
    const out = $('compareBody');
    out.innerHTML = '';
    let changedPages = 0;
    for (let n = 1; n <= maxPages; n++) {
      const a = n <= state.pdfDoc.numPages ? await pageText(state.pdfDoc, n) : '';
      const b = n <= other.numPages ? await pageText(other, n) : '';
      if (a === b) continue;
      changedPages++;
      const sec = document.createElement('div');
      sec.className = 'cmp-page';
      const h = document.createElement('h3');
      h.textContent = `Page ${n}`;
      sec.appendChild(h);
      const body = document.createElement('div');
      body.className = 'cmp-diff';
      for (const part of Diff.diffWords(a, b)) {
        const span = document.createElement(part.added ? 'ins' : part.removed ? 'del' : 'span');
        span.textContent = part.value;
        body.appendChild(span);
      }
      sec.appendChild(body);
      out.appendChild(sec);
    }
    $('compareSummary').textContent = changedPages
      ? `${changedPages} page(s) differ between "${state.fileName}" and "${file.name}". Deletions are struck out, additions are highlighted.`
      : `No text differences found between "${state.fileName}" and "${file.name}".`;
    other.destroy();
    $('compareDialog').showModal();
  } catch (err) {
    toast('Compare failed: ' + err.message, true);
  }
}
$('btnCompareClose').addEventListener('click', () => $('compareDialog').close());

/* ==================== Convert / export ==================== */
$('btnConvertClose').addEventListener('click', () => $('convertDialog').close());

document.querySelectorAll('#convertDialog [data-convert]').forEach((btn) => {
  btn.addEventListener('click', () => runConvert(btn.dataset.convert));
});

async function runConvert(kind) {
  const base = (state.fileName || 'document.pdf').replace(/\.pdf$/i, '');
  try {
    if (kind === 'to-text') {
      if (!requireDoc()) return;
      const { text } = await extractDocumentText(Infinity);
      downloadBlob(new Blob([text.trim()], { type: 'text/plain' }), base + '.txt');
      toast('Exported plain text.');
    } else if (kind === 'to-word') {
      if (!requireDoc()) return;
      toast('Building Word document…');
      const doc = state.pdfDoc;
      const paras = [];
      for (let n = 1; n <= doc.numPages; n++) {
        const tc = await (await doc.getPage(n)).getTextContent();
        let line = '', lastY = null;
        for (const item of tc.items) {
          const y = item.transform[5];
          if (lastY !== null && Math.abs(y - lastY) > 2) {
            if (line.trim()) paras.push(line.trim());
            line = '';
          }
          line += item.str + (item.hasEOL ? '' : ' ');
          lastY = y;
        }
        if (line.trim()) paras.push(line.trim());
        if (n < doc.numPages) paras.push('\f');
      }
      downloadBlob(await buildDocx(paras), base + '.docx',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
      toast('Exported Word document.');
    } else if (kind === 'to-images') {
      if (!requireDoc()) return;
      toast('Rendering pages to images…');
      const zip = new JSZip();
      const doc = state.pdfDoc;
      for (let n = 1; n <= doc.numPages; n++) {
        const page = await doc.getPage(n);
        const vp = page.getViewport({ scale: 2, rotation: page.rotate % 360 });
        const canvas = document.createElement('canvas');
        canvas.width = Math.floor(vp.width);
        canvas.height = Math.floor(vp.height);
        await page.render({ canvasContext: canvas.getContext('2d'), viewport: vp }).promise;
        zip.file(`page-${String(n).padStart(3, '0')}.png`,
          canvas.toDataURL('image/png').split(',')[1], { base64: true });
      }
      downloadBlob(await zip.generateAsync({ type: 'blob' }), base + '-images.zip', 'application/zip');
      toast('Exported page images (.zip).');
    } else if (kind === 'from-images') {
      const files = await pickFile('image/png,image/jpeg', true);
      if (!files || !files.length) return;
      toast('Building PDF from images…');
      const { PDFDocument } = PDFLib;
      const out = await PDFDocument.create();
      for (const f of files) {
        const bytes = new Uint8Array(await f.arrayBuffer());
        const img = f.type === 'image/png' ? await out.embedPng(bytes) : await out.embedJpg(bytes);
        const page = out.addPage([img.width, img.height]);
        page.drawImage(img, { x: 0, y: 0, width: img.width, height: img.height });
      }
      const bytes = await out.save();
      $('convertDialog').close();
      await loadDocument(new Uint8Array(bytes), 'images.pdf', bytes.length);
      toast(`Created a PDF from ${files.length} image(s). Download to keep it.`);
    } else if (kind === 'from-word') {
      const file = await pickFile('.docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document');
      if (!file) return;
      toast('Converting Word document…');
      const result = await mammoth.extractRawText({ arrayBuffer: await file.arrayBuffer() });
      const bytes = await textToPdf(result.value);
      $('convertDialog').close();
      await loadDocument(new Uint8Array(bytes), file.name.replace(/\.docx$/i, '') + '.pdf', bytes.length);
      toast('Converted (text layout). Download to keep it.');
    } else if (kind === 'merge') {
      const files = await pickFile('application/pdf,.pdf', true);
      if (!files || files.length < 2) { toast('Pick two or more PDFs.', true); return; }
      toast('Merging…');
      const { PDFDocument } = PDFLib;
      const out = await PDFDocument.create();
      for (const f of files) {
        const doc = await PDFDocument.load(new Uint8Array(await f.arrayBuffer()), { ignoreEncryption: true });
        (await out.copyPages(doc, doc.getPageIndices())).forEach((p) => out.addPage(p));
      }
      const bytes = await out.save({ useObjectStreams: true });
      $('convertDialog').close();
      await loadDocument(new Uint8Array(bytes), 'merged.pdf', bytes.length);
      toast(`Merged ${files.length} PDFs. Download to keep the file.`);
    }
  } catch (err) {
    console.error(err);
    toast('Conversion failed: ' + err.message, true);
  }
}

/* minimal .docx builder (a docx is a zip of XML) */
async function buildDocx(paragraphs) {
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '');
  const body = paragraphs.map((p) => p === '\f'
    ? '<w:p><w:r><w:br w:type="page"/></w:r></w:p>'
    : `<w:p><w:r><w:t xml:space="preserve">${esc(p)}</w:t></w:r></w:p>`).join('');
  const zip = new JSZip();
  zip.file('[Content_Types].xml',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
  zip.file('_rels/.rels',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
  zip.file('word/document.xml',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
    `<w:body>${body}</w:body></w:document>`);
  return zip.generateAsync({ type: 'blob' });
}

async function textToPdf(text) {
  const { PDFDocument, StandardFonts, rgb } = PDFLib;
  const out = await PDFDocument.create();
  const font = await out.embedFont(StandardFonts.Helvetica);
  const size = 11, lineH = size * 1.45, margin = 56;
  const pageW = 612, pageH = 792;
  const maxW = pageW - margin * 2;
  let page = out.addPage([pageW, pageH]);
  let y = pageH - margin;
  const sanitize = (s) => s.replace(/[^\x20-\x7E]/g, '?');
  for (const rawLine of text.split(/\n/)) {
    const words = sanitize(rawLine).split(/\s+/);
    let line = '';
    const flush = () => {
      if (y < margin) { page = out.addPage([pageW, pageH]); y = pageH - margin; }
      if (line) page.drawText(line, { x: margin, y, size, font, color: rgb(0.1, 0.1, 0.12) });
      y -= lineH;
      line = '';
    };
    for (const w of words) {
      const test = line ? line + ' ' + w : w;
      if (font.widthOfTextAtSize(test, size) > maxW && line) flush();
      line = line ? line + ' ' + w : w;
    }
    flush();
  }
  return out.save();
}

/* ==================== Protect (password) ==================== */
function openProtect() {
  if (!requireDoc()) return;
  $('protectPass').value = '';
  $('protectPass2').value = '';
  $('protectDialog').showModal();
}
$('btnProtectClose').addEventListener('click', () => $('protectDialog').close());
$('btnProtectApply').addEventListener('click', async () => {
  const p1 = $('protectPass').value, p2 = $('protectPass2').value;
  if (!p1) { toast('Enter a password.', true); return; }
  if (p1 !== p2) { toast('Passwords do not match.', true); return; }
  toast('Encrypting…');
  try {
    const { PDFDocument } = PDFLib;
    const doc = await PDFDocument.load(currentBytes(), { ignoreEncryption: true });
    await doc.encrypt({ userPassword: p1, ownerPassword: p1 });
    const bytes = await doc.save({ useObjectStreams: false });
    const base = (state.fileName || 'document.pdf').replace(/\.pdf$/i, '');
    downloadBlob(bytes, `${base}-protected.pdf`);
    $('protectDialog').close();
    toast('Password-protected copy downloaded.');
  } catch (err) {
    console.error(err);
    toast('Encryption failed: ' + err.message, true);
  }
});

/* ==================== Read aloud ==================== */
let readingUtterance = null;
async function toggleReadAloud() {
  if (!requireDoc()) return;
  if (readingUtterance) {
    speechSynthesis.cancel();
    readingUtterance = null;
    toast('Stopped reading.');
    return;
  }
  const page = await state.pdfDoc.getPage(state.currentPage);
  const tc = await page.getTextContent();
  const text = tc.items.map((i) => i.str).join(' ').replace(/\s+/g, ' ').trim();
  if (!text) { toast('No readable text on this page.', true); return; }
  readingUtterance = new SpeechSynthesisUtterance(text);
  readingUtterance.onend = () => { readingUtterance = null; };
  speechSynthesis.speak(readingUtterance);
  toast(`Reading page ${state.currentPage} aloud — open Tools → Read Aloud again to stop.`);
}

/* ==================== Print overlay (include edits when printing) ==================== */
function drawAnnotsForPrint(ctx, pageNum, canvasW, canvasH) {
  for (const a of state.annotations.filter((x) => x.page === pageNum)) {
    if (a.type === 'highlight') {
      ctx.save();
      ctx.globalAlpha = 0.35;
      ctx.fillStyle = a.color;
      for (const r of a.rects) ctx.fillRect(r.x * canvasW, r.y * canvasH, r.w * canvasW, r.h * canvasH);
      ctx.restore();
    } else if (a.type === 'draw') {
      ctx.save();
      ctx.strokeStyle = a.color;
      ctx.lineWidth = Math.max(1.5, (a.width || 2) * canvasW / 900);
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.beginPath();
      a.points.forEach(([nx, ny], i) => {
        const x = nx * canvasW, y = ny * canvasH;
        i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
      });
      ctx.stroke();
      ctx.restore();
    } else if (a.type === 'whiteout') {
      const r = a.rect;
      ctx.fillStyle = '#fff';
      ctx.fillRect(r.x * canvasW, r.y * canvasH, r.w * canvasW, r.h * canvasH);
      if (a.text) {
        ctx.fillStyle = '#212529';
        const size = (a.size || 14) * canvasW / 750;
        ctx.font = `${size}px Helvetica, Arial, sans-serif`;
        ctx.textBaseline = 'top';
        ctx.fillText(a.text, r.x * canvasW + 2, r.y * canvasH + 2);
      }
    } else if (a.type === 'text') {
      if (!(a.text || '').trim()) continue;
      ctx.fillStyle = a.color || '#212529';
      const size = (a.size || 16) * canvasW / 750;
      ctx.font = `${size}px Helvetica, Arial, sans-serif`;
      ctx.textBaseline = 'top';
      a.text.split('\n').forEach((line, i) => {
        ctx.fillText(line, a.x * canvasW, a.y * canvasH + i * size * 1.25);
      });
    } else if (a.type === 'redact') {
      const r = a.rect;
      ctx.fillStyle = '#000';
      ctx.fillRect(r.x * canvasW, r.y * canvasH, r.w * canvasW, r.h * canvasH);
    }
    // image/signature overlays need async image loading; printPdf handles them
  }
}

async function drawImageAnnotsForPrint(ctx, pageNum, canvasW, canvasH) {
  const imgs = state.annotations.filter((a) =>
    a.page === pageNum && (a.type === 'image' || a.type === 'signature'));
  for (const a of imgs) {
    await new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        const r = a.rect;
        ctx.drawImage(img, r.x * canvasW, r.y * canvasH, r.w * canvasW, r.h * canvasH);
        resolve();
      };
      img.onerror = resolve;
      img.src = a.dataUrl;
    });
  }
}
