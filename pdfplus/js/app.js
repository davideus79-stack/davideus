import { kv, docs as docStore, persist } from './store.js';
import { getSignature, saveSignature, processSignature, loadImage, fileToDataUrl, createPad } from './signature.js';
import { FONTS, cssFamily, ensureFontsLoaded } from './fonts.js';
import { preparePrint, saveBlob, signedName, isIOS } from './export.js';
import { loadPdf } from './docs/pdf.js';
import { loadDocx } from './docs/docx.js';
import { loadXlsx } from './docs/xlsx.js';
import { myhomeUser, saveToMyHome, backToMyHome } from './myhome.js';

const $ = (s) => document.querySelector(s);
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

const state = {
  doc: null, rec: null, elements: [], sel: null, editing: null,
  zoom: 1, fit: 1, scale: 1, pageEls: [], nodes: new Map(),
  prefs: { font: 'Inter', color: '#111111', dateFmt: 'num' },
};

/* ================= UI helpers ================= */
let toastT;
function toast(msg, ms = 2600) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('is-on');
  clearTimeout(toastT);
  toastT = setTimeout(() => t.classList.remove('is-on'), ms);
}
function busy(on, text = 'Attendere…') {
  $('#busy-text').textContent = text;
  $('#busy').hidden = !on;
}
function openSheet(id) { $(id).hidden = false; }
function closeSheet(id) { $(id).hidden = true; }
document.querySelectorAll('.sheet-backdrop').forEach((b) => b.addEventListener('click', (e) => { if (e.target === b) b.hidden = true; }));

function showScreen(id) {
  document.querySelectorAll('.screen').forEach((s) => s.classList.toggle('is-active', s.id === id));
}

/* ================= Dates ================= */
const MONTHS = ['gennaio', 'febbraio', 'marzo', 'aprile', 'maggio', 'giugno', 'luglio', 'agosto', 'settembre', 'ottobre', 'novembre', 'dicembre'];
const DAYS = ['domenica', 'lunedì', 'martedì', 'mercoledì', 'giovedì', 'venerdì', 'sabato'];
const p2 = (n) => String(n).padStart(2, '0');
const DATE_FMTS = {
  num: (d) => `${p2(d.getDate())}/${p2(d.getMonth() + 1)}/${d.getFullYear()}`,
  long: (d) => `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`,
  dash: (d) => `${p2(d.getDate())}-${p2(d.getMonth() + 1)}-${d.getFullYear()}`,
  short: (d) => `${p2(d.getDate())}/${p2(d.getMonth() + 1)}/${String(d.getFullYear()).slice(2)}`,
  full: (d) => { const s = `${DAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`; return s[0].toUpperCase() + s.slice(1); },
};
const isoToday = () => { const d = new Date(); return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`; };
const isoToDate = (iso) => { const [y, m, d] = iso.split('-').map(Number); return new Date(y, m - 1, d); };
const fmtDate = (iso, k) => (DATE_FMTS[k] || DATE_FMTS.num)(isoToDate(iso));

/* ================= Home ================= */
async function refreshSigCard() {
  const sig = await getSignature();
  const prev = $('#sig-card-preview');
  prev.innerHTML = '';
  $('#sig-card').classList.toggle('is-empty', !sig);
  if (sig) {
    const img = new Image(); img.src = sig.dataUrl; img.alt = 'La tua firma';
    prev.appendChild(img);
    $('#sig-card-title').textContent = 'La tua firma';
    $('#sig-card-text').textContent = 'Salvata su questo dispositivo, pronta per ogni documento.';
    $('#btn-sig-edit').textContent = 'Modifica';
  } else {
    prev.innerHTML = '<span class="empty">✍️</span>';
    $('#sig-card-title').textContent = 'Aggiungi la tua firma';
    $('#sig-card-text').textContent = 'Basta una volta sola: poi la trovi sempre pronta.';
    $('#btn-sig-edit').textContent = 'Aggiungi';
  }
}

function relTime(ts) {
  const d = new Date(ts), now = new Date();
  const hm = `${p2(d.getHours())}:${p2(d.getMinutes())}`;
  if (d.toDateString() === now.toDateString()) return `Oggi, ${hm}`;
  const y = new Date(now); y.setDate(now.getDate() - 1);
  if (d.toDateString() === y.toDateString()) return `Ieri, ${hm}`;
  return `${d.getDate()} ${MONTHS[d.getMonth()].slice(0, 3)} ${d.getFullYear()}`;
}

async function refreshRecent() {
  let list = [];
  try { list = (await docStore.all()).sort((a, b) => b.updated - a.updated); } catch {}
  $('#recent').hidden = !list.length;
  const ul = $('#recent-list');
  ul.innerHTML = '';
  for (const r of list) {
    const li = document.createElement('li');
    li.className = 'recent-item';
    li.innerHTML = `<button class="recent-open"><span class="fmt fmt-${r.kind}">${r.kind.toUpperCase()}</span><span class="recent-meta"><span class="recent-name"></span><span class="recent-date">${relTime(r.updated)}${r.elements && r.elements.length ? ' · ' + r.elements.length + ' elementi' : ''}</span></span></button><button class="recent-del" aria-label="Rimuovi dai recenti"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18"/></svg></button>`;
    li.querySelector('.recent-name').textContent = r.name;
    li.querySelector('.recent-open').onclick = async () => openRecord(await docStore.get(r.id), false);
    li.querySelector('.recent-del').onclick = async () => { await docStore.del(r.id); refreshRecent(); };
    ul.appendChild(li);
  }
}

async function trimRecent(max = 12) {
  const list = (await docStore.all()).sort((a, b) => b.updated - a.updated);
  for (const r of list.slice(max)) await docStore.del(r.id);
}

$('#file-input').addEventListener('change', (e) => {
  const f = e.target.files[0];
  e.target.value = '';
  if (f) openFile(f);
});
const drop = $('#drop');
['dragenter', 'dragover'].forEach((t) => window.addEventListener(t, (e) => { e.preventDefault(); if ($('#home').classList.contains('is-active')) drop.classList.add('is-over'); }));
['dragleave', 'drop'].forEach((t) => window.addEventListener(t, (e) => { e.preventDefault(); if (t === 'dragleave' && e.relatedTarget) return; drop.classList.remove('is-over'); }));
window.addEventListener('drop', (e) => {
  const f = e.dataTransfer && e.dataTransfer.files[0];
  if (f && $('#home').classList.contains('is-active')) openFile(f);
});

$('#btn-sig-edit').onclick = () => openSigSheet();
$('#btn-settings').onclick = () => openSigSheet();

/* ================= Open documents ================= */
function kindOf(name) {
  const ext = name.toLowerCase().split('.').pop();
  if (ext === 'pdf') return 'pdf';
  if (ext === 'docx') return 'docx';
  if (ext === 'xlsx' || ext === 'xlsm') return 'xlsx';
  if (ext === 'doc') return 'old-doc';
  if (ext === 'xls') return 'old-xls';
  return null;
}

async function openFile(file) {
  const kind = kindOf(file.name);
  if (kind === 'old-doc') return toast('Formato .doc vecchio: aprilo in Word e salvalo come .docx', 4500);
  if (kind === 'old-xls') return toast('Formato .xls vecchio: aprilo in Excel e salvalo come .xlsx', 4500);
  if (!kind) return toast('Formato non supportato. Usa PDF, Word (.docx) o Excel (.xlsx)', 4000);
  const bytes = await file.arrayBuffer();
  const rec = { id: uid(), name: file.name, kind, bytes, elements: [], updated: Date.now() };
  await openRecord(rec, true);
}

async function openRecord(rec, isNew) {
  if (!rec) return toast('Documento non trovato');
  busy(true, 'Apro il documento…');
  showScreen('editor');
  try {
    await ensureFontsLoaded();
    const loader = { pdf: loadPdf, docx: loadDocx, xlsx: loadXlsx }[rec.kind];
    state.doc = await loader(rec.bytes, rec.name);
  } catch (err) {
    console.error(err);
    busy(false);
    showScreen('home');
    return toast('Non riesco ad aprire questo file. È protetto o danneggiato?', 4500);
  }
  state.rec = rec;
  state.elements = (rec.elements || []).filter((e) => state.doc.pages[e.page]);
  state.sel = null; state.zoom = 1;
  if (isNew) {
    try { await docStore.put(rec); await trimRecent(); } catch (e) { console.warn('recent save failed', e); }
  }
  $('#ed-name').textContent = rec.name;
  const badge = $('#ed-badge');
  badge.textContent = rec.kind.toUpperCase();
  badge.style.background = `var(--${rec.kind})`;
  document.body.classList.remove('preview');
  $('#btn-preview').setAttribute('aria-pressed', 'false');
  buildPages();
  busy(false);
  $('#stage').scrollTo(0, 0);
}

async function closeDoc() {
  finishEdit();
  select(null);
  await saveNow();
  if (state.doc) { try { state.doc.destroy(); } catch {} }
  if (observer) observer.disconnect();
  state.doc = null; state.rec = null; state.elements = []; state.nodes.clear();
  $('#pages').innerHTML = '';
  showScreen('home');
  refreshRecent();
}
$('#btn-back').onclick = async () => {
  const fromMyHome = state.fromMyHome;
  state.fromMyHome = false;
  await closeDoc();
  if (fromMyHome) backToMyHome();
};
$('#btn-myhome').onclick = () => backToMyHome();

/* ================= Autosave ================= */
let saveT;
function scheduleSave() {
  clearTimeout(saveT);
  saveT = setTimeout(saveNow, 700);
}
async function saveNow() {
  clearTimeout(saveT);
  if (!state.rec) return;
  state.rec.elements = state.elements.map((e) => ({ ...e }));
  state.rec.updated = Date.now();
  try { await docStore.put(state.rec); } catch (e) { console.warn(e); }
}

/* ================= Pages & zoom ================= */
let observer;
const visiblePages = new Set();

function buildPages() {
  const wrap = $('#pages');
  wrap.innerHTML = '';
  state.pageEls = [];
  state.nodes.clear();
  visiblePages.clear();
  if (observer) observer.disconnect();
  observer = new IntersectionObserver((entries) => {
    for (const en of entries) {
      const i = +en.target.dataset.page;
      if (en.isIntersecting) { visiblePages.add(i); state.doc.pages[i].render(state.scale); }
      else visiblePages.delete(i);
    }
  }, { root: $('#stage'), rootMargin: '900px 300px' });

  wrap.style.gap = state.doc.kind === 'xlsx' ? '30px' : '';
  for (const page of state.doc.pages) {
    const el = document.createElement('div');
    el.className = 'page';
    el.dataset.page = page.index;
    if (page.label && state.doc.pages.length > 1) {
      const l = document.createElement('div');
      l.className = 'page-label';
      l.textContent = page.label;
      el.appendChild(l);
    }
    const content = document.createElement('div');
    content.className = 'page-content';
    const overlay = document.createElement('div');
    overlay.className = 'overlay';
    overlay.dataset.page = page.index;
    el.append(content, overlay);
    wrap.appendChild(el);
    page.mount(content);
    state.pageEls[page.index] = { el, content, overlay };
    overlay.addEventListener('click', (e) => { if (e.target === overlay) { finishEdit(); select(null); } });
    observer.observe(el);
  }
  computeFit();
  applyScale();
}

function computeFit() {
  if (!state.doc) return;
  const avail = $('#stage').clientWidth - 32;
  const maxW = Math.max(...state.doc.pages.map((p) => p.w));
  const target = Math.min(avail, 880);
  state.fit = state.doc.kind === 'xlsx' ? Math.max(0.45, Math.min(1, avail / maxW)) : target / maxW;
}

let renderT;
function applyScale(keepCenter = false) {
  if (!state.doc) return;
  const stage = $('#stage');
  const cx = keepCenter ? (stage.scrollLeft + stage.clientWidth / 2) / Math.max(1, stage.scrollWidth) : 0;
  const cy = keepCenter ? (stage.scrollTop + stage.clientHeight / 2) / Math.max(1, stage.scrollHeight) : 0;
  const s = state.scale = state.fit * state.zoom;
  for (const page of state.doc.pages) {
    const pe = state.pageEls[page.index];
    pe.el.style.width = page.w * s + 'px';
    pe.el.style.height = page.h * s + 'px';
    if (state.doc.kind !== 'pdf') page.render(s);
  }
  if (state.doc.kind === 'pdf') {
    clearTimeout(renderT);
    renderT = setTimeout(() => visiblePages.forEach((i) => state.doc.pages[i].render(state.scale)), 120);
  }
  state.elements.forEach(drawEl);
  $('#zoom-fit').textContent = Math.round(state.zoom * 100) + '%';
  if (keepCenter) {
    stage.scrollLeft = cx * stage.scrollWidth - stage.clientWidth / 2;
    stage.scrollTop = cy * stage.scrollHeight - stage.clientHeight / 2;
  }
}
function setZoom(z) {
  state.zoom = clamp(z, 0.4, 4);
  applyScale(true);
}
$('#zoom-in').onclick = () => setZoom(state.zoom * 1.25);
$('#zoom-out').onclick = () => setZoom(state.zoom / 1.25);
$('#zoom-fit').onclick = () => setZoom(1);
$('#stage').addEventListener('wheel', (e) => {
  if (!e.ctrlKey) return;
  e.preventDefault();
  setZoom(state.zoom * Math.exp(-e.deltaY * 0.0045));
}, { passive: false });
// iOS Safari pinch on the page area
let gz0 = 1;
$('#stage').addEventListener('gesturestart', (e) => { e.preventDefault(); gz0 = state.zoom; });
$('#stage').addEventListener('gesturechange', (e) => {
  e.preventDefault();
  if (state.gesture) return; // pinching an element
  setZoom(gz0 * e.scale);
});
$('#stage').addEventListener('click', (e) => { if (e.target.id === 'stage' || e.target.id === 'pages') { finishEdit(); select(null); } });
let resizeT;
window.addEventListener('resize', () => {
  clearTimeout(resizeT);
  resizeT = setTimeout(() => { computeFit(); applyScale(); }, 150);
});

/* ================= Elements ================= */
function findEl(id) { return state.elements.find((e) => e.id === id); }
function pageOf(el) { return state.doc.pages[el.page]; }

function drawEl(el) {
  const pe = state.pageEls[el.page];
  if (!pe) return;
  const s = state.scale;
  let n = state.nodes.get(el.id);
  if (!n) {
    n = document.createElement('div');
    n.className = 'el';
    n.dataset.id = el.id;
    if (el.type === 'sig') {
      const img = new Image(); img.alt = 'Firma'; img.draggable = false;
      n.appendChild(img);
    } else {
      const sp = document.createElement('span');
      sp.className = 'el-text';
      n.appendChild(sp);
    }
    const h = document.createElement('div');
    h.className = 'handle';
    h.setAttribute('aria-hidden', 'true');
    n.appendChild(h);
    bindElement(n);
    state.nodes.set(el.id, n);
  }
  if (n.parentNode !== pe.overlay) pe.overlay.appendChild(n);
  n.style.left = el.x * s + 'px';
  n.style.top = el.y * s + 'px';
  if (el.type === 'sig') {
    n.style.width = el.w * s + 'px';
    n.style.height = el.h * s + 'px';
    const img = n.firstChild;
    if (img.getAttribute('src') !== el.src) img.src = el.src;
  } else {
    const sp = n.firstChild;
    sp.style.fontFamily = cssFamily(el.font);
    sp.style.fontSize = el.size * s + 'px';
    sp.style.fontWeight = el.bold ? 700 : 400;
    sp.style.color = el.color;
    if (state.editing !== el.id && sp.textContent !== el.text) sp.textContent = el.text;
    const r = sp.getBoundingClientRect();
    if (r.width) { el.w = r.width / s; el.h = r.height / s; }
  }
  n.classList.toggle('is-sel', el.id === state.sel);
}

function removeEl(id) {
  const n = state.nodes.get(id);
  if (n) n.remove();
  state.nodes.delete(id);
  state.elements = state.elements.filter((e) => e.id !== id);
  if (state.sel === id) select(null);
  scheduleSave();
}

function select(id) {
  const prev = state.sel;
  state.sel = id;
  if (prev && state.nodes.get(prev)) state.nodes.get(prev).classList.remove('is-sel');
  if (id && state.nodes.get(id)) state.nodes.get(id).classList.add('is-sel');
  updateProps();
}

// Where to drop a new element: centre of the visible part of the page
// that occupies the middle of the screen.
function dropTarget() {
  const stage = $('#stage').getBoundingClientRect();
  const midY = stage.top + stage.height * 0.42;
  const midX = stage.left + stage.width / 2;
  let best = null, bestD = Infinity;
  for (const page of state.doc.pages) {
    const r = state.pageEls[page.index].el.getBoundingClientRect();
    const d = midY < r.top ? r.top - midY : midY > r.bottom ? midY - r.bottom : 0;
    if (d < bestD) { bestD = d; best = { page, r }; }
  }
  const { page, r } = best;
  const s = state.scale;
  const visTop = Math.max(r.top, stage.top), visBot = Math.min(r.bottom, stage.bottom - 90);
  const visL = Math.max(r.left, stage.left), visR = Math.min(r.right, stage.right);
  const y = ((visTop + visBot) / 2 - r.top) / s;
  const x = ((visL + visR) / 2 - r.left) / s;
  return { page, x: clamp(x, 0, page.w), y: clamp(y, 0, page.h) };
}

function placeNew(el, t) {
  el.x = clamp(t.x - el.w / 2, 0, Math.max(0, t.page.w - el.w));
  el.y = clamp(t.y - el.h / 2, 0, Math.max(0, t.page.h - el.h));
  // don't drop a new item exactly on top of another one: move it below
  const gap = 8 / t.page.toPt;
  for (let i = 0; i < 20; i++) {
    const hit = state.elements.find((o) => o !== el && o.page === el.page &&
      el.x < o.x + o.w && o.x < el.x + el.w && el.y < o.y + o.h && o.y < el.y + el.h);
    if (!hit) break;
    el.y = hit.y + hit.h + gap;
  }
  el.y = clamp(el.y, 0, Math.max(0, t.page.h - el.h));
}

const SIG_DEFAULT_CM = 7;
let pendingSig = false;
async function addSignature() {
  const sig = await getSignature();
  if (!sig) { pendingSig = true; openSigSheet(); return; }
  const t = dropTarget();
  const pg = t.page;
  // default width: 7 cm (72 pt per inch, 2.54 cm per inch), never wider than 60% of the page
  const w = Math.min((SIG_DEFAULT_CM / 2.54 * 72) / pg.toPt, pg.w * 0.6);
  const el = { id: uid(), type: 'sig', page: pg.index, w, h: w * sig.h / sig.w, src: sig.dataUrl, src0: sig.dataUrl, tint: 'original' };
  placeNew(el, t);
  state.elements.push(el);
  drawEl(el); select(el.id); scheduleSave();
}
function addTextEl(type) {
  const t = dropTarget();
  const pg = t.page;
  const isDate = type === 'date';
  const iso = isoToday();
  const el = {
    id: uid(), type, page: pg.index, x: 0, y: 0, w: 0, h: 0,
    text: isDate ? fmtDate(iso, state.prefs.dateFmt) : 'Scrivi qui',
    font: state.prefs.font, size: (isDate ? 12 : 14) / pg.toPt, color: state.prefs.color, bold: false,
    dateFmt: state.prefs.dateFmt, dateValue: iso,
  };
  state.elements.push(el);
  drawEl(el); // measures w/h
  placeNew(el, t);
  drawEl(el); select(el.id); scheduleSave();
  if (!isDate) startEdit(el);
}
$('#add-sig').onclick = addSignature;
$('#add-date').onclick = () => addTextEl('date');
$('#add-text').onclick = () => addTextEl('text');

/* ----- gestures: drag, corner resize, two-finger pinch ----- */
function bindElement(n) {
  const pointers = new Map();
  let g = null, lastTap = 0;

  n.addEventListener('pointerdown', (e) => {
    const el = findEl(n.dataset.id);
    if (!el || state.editing === el.id) return;
    e.preventDefault(); e.stopPropagation();
    if (state.editing) finishEdit();
    const wasSel = state.sel === el.id;
    select(el.id);
    n.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const base = { x0: el.x, y0: el.y, w0: el.w, h0: el.h, size0: el.size, moved: false, wasSel };
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      g = { ...base, mode: 'pinch', d0: Math.hypot(a.x - b.x, a.y - b.y) || 1 };
      state.gesture = true;
    } else {
      g = { ...base, mode: e.target.classList.contains('handle') ? 'resize' : 'drag', sx: e.clientX, sy: e.clientY };
    }
    n.classList.add('is-dragging');
  });

  n.addEventListener('pointermove', (e) => {
    if (!g || !pointers.has(e.pointerId)) return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const el = findEl(n.dataset.id);
    if (!el) return;
    const s = state.scale, pg = pageOf(el);
    if (g.mode === 'pinch' && pointers.size >= 2) {
      const [a, b] = [...pointers.values()];
      resizeBy(el, g, Math.hypot(a.x - b.x, a.y - b.y) / g.d0);
      g.moved = true;
    } else if (g.mode === 'drag') {
      const dx = e.clientX - g.sx, dy = e.clientY - g.sy;
      if (!g.moved && Math.hypot(dx, dy) < 3) return;
      g.moved = true;
      el.x = clamp(g.x0 + dx / s, -el.w * 0.6, pg.w - el.w * 0.4);
      el.y = clamp(g.y0 + dy / s, -el.h * 0.6, pg.h - el.h * 0.4);
    } else if (g.mode === 'resize') {
      const dx = e.clientX - g.sx, dy = e.clientY - g.sy;
      const W = g.w0 * s, H = g.h0 * s;
      resizeBy(el, g, (W + dx + H + dy) / (W + H));
      g.moved = true;
    }
    drawEl(el);
    if (g.mode !== 'drag') updateSizeLabel(el);
  });

  const end = (e) => {
    if (!pointers.has(e.pointerId)) return;
    pointers.delete(e.pointerId);
    const el = findEl(n.dataset.id);
    if (pointers.size === 1 && g && g.mode === 'pinch' && el) {
      // back to dragging with the remaining finger
      const [p] = [...pointers.values()];
      g = { x0: el.x, y0: el.y, w0: el.w, h0: el.h, size0: el.size, mode: 'drag', sx: p.x, sy: p.y, moved: true };
      return;
    }
    if (pointers.size) return;
    n.classList.remove('is-dragging');
    state.gesture = false;
    if (!el || !g) { g = null; return; }
    if (g.mode === 'drag' && g.moved) maybeMoveToOtherPage(el, n, e);
    // keep it inside the page once released
    const pg = pageOf(el);
    el.x = clamp(el.x, 0, Math.max(0, pg.w - el.w));
    el.y = clamp(el.y, 0, Math.max(0, pg.h - el.h));
    drawEl(el);
    if (!g.moved && el.type !== 'sig') {
      const now = Date.now();
      if (g.wasSel && now - lastTap < 400) startEdit(el);
      lastTap = now;
    }
    if (g.moved) scheduleSave();
    g = null;
  };
  n.addEventListener('pointerup', end);
  n.addEventListener('pointercancel', end);
  n.addEventListener('dblclick', () => { const el = findEl(n.dataset.id); if (el && el.type !== 'sig') startEdit(el); });
}

function resizeBy(el, g, f) {
  const pg = pageOf(el);
  if (el.type === 'sig') {
    const w = clamp(g.w0 * f, 12 / pg.toPt, pg.w);
    el.w = w; el.h = w * g.h0 / g.w0;
  } else {
    el.size = clamp(g.size0 * f, 5 / pg.toPt, 160 / pg.toPt);
  }
}

function maybeMoveToOtherPage(el, n, e) {
  const hit = document.elementsFromPoint(e.clientX, e.clientY).find((x) => x.classList && x.classList.contains('overlay'));
  if (!hit) return;
  const target = +hit.dataset.page;
  if (target === el.page) return;
  const s = state.scale;
  const nr = n.getBoundingClientRect(), or = hit.getBoundingClientRect();
  el.page = target;
  el.x = (nr.left - or.left) / s;
  el.y = (nr.top - or.top) / s;
}

/* ----- inline text editing ----- */
function startEdit(el) {
  const n = state.nodes.get(el.id);
  if (!n) return;
  state.editing = el.id;
  const sp = n.firstChild;
  try { sp.contentEditable = 'plaintext-only'; } catch { sp.contentEditable = 'true'; }
  if (sp.contentEditable !== 'plaintext-only') sp.contentEditable = 'true';
  sp.focus();
  const range = document.createRange();
  range.selectNodeContents(sp);
  const sel = window.getSelection();
  sel.removeAllRanges(); sel.addRange(range);
  sp.oninput = () => { el.text = sp.innerText.replace(/\n$/, ''); drawEl(el); };
  sp.onblur = () => finishEdit();
  sp.onkeydown = (e) => { if (e.key === 'Escape' || (e.key === 'Enter' && (e.metaKey || e.ctrlKey))) { e.preventDefault(); sp.blur(); } };
}
function finishEdit() {
  const id = state.editing;
  if (!id) return;
  state.editing = null;
  const el = findEl(id), n = state.nodes.get(id);
  if (!el || !n) return;
  const sp = n.firstChild;
  sp.contentEditable = 'false';
  sp.oninput = sp.onblur = sp.onkeydown = null;
  el.text = sp.innerText.replace(/\n$/, '');
  if (!el.text.trim()) { removeEl(id); return; }
  sp.textContent = el.text;
  drawEl(el);
  scheduleSave();
}

/* ----- keyboard (PC) ----- */
document.addEventListener('keydown', (e) => {
  if (!state.doc || state.editing || !$('#editor').classList.contains('is-active')) return;
  if (e.target.matches('input, textarea, [contenteditable="true"], [contenteditable="plaintext-only"]')) return;
  const el = state.sel && findEl(state.sel);
  if (!el) return;
  if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); removeEl(el.id); return; }
  if (e.key === 'Enter' && el.type !== 'sig') { e.preventDefault(); startEdit(el); return; }
  if (e.key === 'Escape') { select(null); return; }
  const step = (e.shiftKey ? 10 : 1) / pageOf(el).toPt;
  const mv = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key];
  if (mv) { e.preventDefault(); el.x += mv[0]; el.y += mv[1]; drawEl(el); scheduleSave(); }
});

/* ================= Properties panel ================= */
const TEXT_COLORS = ['#111111', '#1a3a9c', '#c62828', '#2e7d32', '#6b6b73'];
const SIG_COLORS = ['original', '#111111', '#1a3a9c'];

function buildFontStrip() {
  const strip = $('#font-strip');
  strip.innerHTML = '';
  for (const f of FONTS) {
    const b = document.createElement('button');
    b.className = 'font-chip';
    b.dataset.font = f.id;
    b.style.fontFamily = cssFamily(f.id);
    b.textContent = f.label;
    b.setAttribute('role', 'option');
    b.onclick = () => {
      const el = findEl(state.sel);
      if (!el || el.type === 'sig') return;
      el.font = f.id; state.prefs.font = f.id; savePrefs();
      drawEl(el); updateProps(); scheduleSave();
    };
    strip.appendChild(b);
  }
}
function buildDateStrip() {
  const strip = $('#date-strip');
  strip.innerHTML = '';
  const iso = isoToday();
  for (const k of Object.keys(DATE_FMTS)) {
    const b = document.createElement('button');
    b.className = 'chip';
    b.dataset.fmt = k;
    b.textContent = fmtDate(iso, k);
    b.onclick = () => {
      const el = findEl(state.sel);
      if (!el) return;
      el.dateFmt = k; el.text = fmtDate(el.dateValue || iso, k);
      state.prefs.dateFmt = k; savePrefs();
      drawEl(el); updateProps(); scheduleSave();
    };
    strip.appendChild(b);
  }
  // pick another day
  const other = document.createElement('label');
  other.className = 'chip';
  other.style.cssText = 'display:inline-flex;align-items:center;gap:6px;cursor:pointer;position:relative;';
  other.innerHTML = '📅 Altro giorno<input type="date" style="position:absolute;inset:0;opacity:0;cursor:pointer">';
  const inp = other.querySelector('input');
  inp.onchange = () => {
    const el = findEl(state.sel);
    if (!el || !inp.value) return;
    el.dateValue = inp.value; el.text = fmtDate(inp.value, el.dateFmt);
    drawEl(el); scheduleSave();
  };
  strip.appendChild(other);
}

function updateSizeLabel(el) {
  const pg = pageOf(el);
  $('#size-val').textContent = el.type === 'sig'
    ? (el.w * pg.toPt / 72 * 2.54).toFixed(1).replace('.', ',') + ' cm'
    : Math.round(el.size * pg.toPt) + ' pt';
}

function updateProps() {
  const el = state.sel && findEl(state.sel);
  const panel = $('#props');
  document.body.classList.toggle('has-props', !!el);
  if (!el) { panel.hidden = true; return; }
  panel.hidden = false;
  const isSig = el.type === 'sig';
  $('#props-text').hidden = isSig;
  $('#props-date').hidden = el.type !== 'date';
  $('#btn-bold').hidden = isSig;
  $('#btn-edit-text').hidden = isSig;
  $('#btn-bold').setAttribute('aria-pressed', String(!!el.bold));
  document.querySelectorAll('.font-chip').forEach((c) => c.classList.toggle('is-on', c.dataset.font === el.font));
  document.querySelectorAll('#date-strip .chip[data-fmt]').forEach((c) => c.classList.toggle('is-on', c.dataset.fmt === el.dateFmt));
  updateSizeLabel(el);
  const sw = $('#swatches');
  sw.innerHTML = '';
  const colors = isSig ? SIG_COLORS : TEXT_COLORS;
  for (const c of colors) {
    const b = document.createElement('button');
    b.className = 'swatch';
    b.setAttribute('aria-label', c === 'original' ? 'Colore originale' : 'Colore ' + c);
    b.style.background = c === 'original' ? 'conic-gradient(#222 0 50%, #2a4a9a 0)' : c;
    const cur = isSig ? (el.tint || 'original') : el.color;
    b.classList.toggle('is-on', cur === c);
    b.onclick = async () => {
      if (isSig) { el.tint = c; el.src = c === 'original' ? el.src0 : await tintPng(el.src0, c); }
      else { el.color = c; state.prefs.color = c; savePrefs(); }
      drawEl(el); updateProps(); scheduleSave();
    };
    sw.appendChild(b);
  }
}

function stepSize(f) {
  const el = findEl(state.sel);
  if (!el) return;
  const g = { w0: el.w, h0: el.h, size0: el.size };
  const cx = el.x + el.w / 2, cy = el.y + el.h / 2;
  resizeBy(el, g, f);
  drawEl(el);
  el.x = cx - el.w / 2; el.y = cy - el.h / 2;
  drawEl(el); updateSizeLabel(el); scheduleSave();
}
$('#size-up').onclick = () => stepSize(1.1);
$('#size-down').onclick = () => stepSize(1 / 1.1);
$('#btn-bold').onclick = () => {
  const el = findEl(state.sel);
  if (!el || el.type === 'sig') return;
  el.bold = !el.bold; drawEl(el); updateProps(); scheduleSave();
};
$('#btn-edit-text').onclick = () => { const el = findEl(state.sel); if (el) startEdit(el); };
$('#btn-del').onclick = () => { if (state.sel) removeEl(state.sel); };
$('#btn-dup').onclick = () => {
  const el = findEl(state.sel);
  if (!el) return;
  const pg = pageOf(el);
  const c = { ...el, id: uid(), x: Math.min(el.x + 14 / pg.toPt, pg.w - el.w), y: Math.min(el.y + 14 / pg.toPt, pg.h - el.h) };
  state.elements.push(c); drawEl(c); select(c.id); scheduleSave();
};
// keep the editor's focus behaviour sane: tapping the panel must not blur-edit away the selection
$('#props').addEventListener('pointerdown', (e) => { if (!e.target.closest('input')) e.preventDefault(); });

const tintCache = new Map();
async function tintPng(src, color) {
  const key = src.length + ':' + src.slice(-40) + color;
  if (tintCache.has(key)) return tintCache.get(key);
  const img = await loadImage(src);
  const c = document.createElement('canvas');
  c.width = img.naturalWidth; c.height = img.naturalHeight;
  const g = c.getContext('2d');
  g.drawImage(img, 0, 0);
  g.globalCompositeOperation = 'source-in';
  g.fillStyle = color; g.fillRect(0, 0, c.width, c.height);
  const out = c.toDataURL('image/png');
  tintCache.set(key, out);
  return out;
}

/* ================= Preview ================= */
$('#btn-preview').onclick = () => {
  finishEdit(); select(null);
  const on = document.body.classList.toggle('preview');
  $('#btn-preview').setAttribute('aria-pressed', String(on));
  toast(on ? 'Anteprima: così apparirà il documento' : 'Modifica attiva', 1800);
};

/* ================= Save & print ================= */
function readySheet({ title, sub, go, onGo, alt, onAlt }) {
  $('#ready-title').textContent = title;
  $('#ready-sub').textContent = sub;
  $('#ready-go').textContent = go;
  $('#ready-go').onclick = () => { closeSheet('#ready-sheet'); onGo(); };
  $('#ready-alt').hidden = !alt;
  if (alt) { $('#ready-alt').textContent = alt; $('#ready-alt').onclick = () => { closeSheet('#ready-sheet'); onAlt(); }; }
  $('#ready-cancel').onclick = () => closeSheet('#ready-sheet');
  openSheet('#ready-sheet');
}

async function shareFile(blob, filename) {
  const file = new File([blob], filename, { type: blob.type });
  try { await navigator.share({ files: [file], title: filename }); }
  catch (e) { if (!e || e.name !== 'AbortError') { await saveBlob(blob, filename, { noShare: true }); } }
}

async function exportAndSave(asPdf) {
  closeSheet('#save-sheet');
  finishEdit(); select(null);
  const kind = state.doc.kind;
  busy(true, 'Preparo il file…');
  let blob, filename;
  try {
    if (asPdf || kind === 'pdf') {
      const bytes = await state.doc.exportPdf(state.elements);
      blob = new Blob([bytes], { type: 'application/pdf' });
      filename = signedName(state.rec.name, 'pdf');
    } else {
      blob = await state.doc.exportOriginal(state.elements);
      filename = signedName(state.rec.name, kind);
    }
  } catch (err) {
    console.error(err);
    busy(false);
    return toast('Qualcosa è andato storto durante il salvataggio', 4000);
  }
  busy(false);
  if (await myhomeUser()) {
    const folderId = state.rec && state.rec.myhome ? state.rec.myhome.folderId : null;
    const canShare = isIOS && navigator.canShare && navigator.canShare({ files: [new File([blob], filename, { type: blob.type })] });
    return readySheet({
      title: 'Documento pronto',
      sub: `${filename} — mettilo in MyHome (lo ritrovi subito anche sull'altro dispositivo) oppure salvalo qui.`,
      go: 'Salva in MyHome',
      onGo: async () => {
        busy(true, 'Lo metto in MyHome…');
        try { await saveToMyHome(blob, filename, folderId); busy(false); toast('Salvato in MyHome ✓', 3000); }
        catch (err) { console.error(err); busy(false); toast(err && err.message && err.message.startsWith('File troppo') ? err.message : 'Non riesco a salvarlo in MyHome: controlla la connessione', 4500); }
      },
      alt: canShare ? 'Condividi o salva sull’iPhone' : isIOS ? 'Salva sull’iPhone' : 'Salva sul PC',
      onAlt: async () => {
        if (canShare) return shareFile(blob, filename);
        const r = await saveBlob(blob, filename);
        if (r === 'saved' || r === 'downloaded') toast(r === 'saved' ? 'Salvato ✓' : 'Scaricato nella cartella Download ✓');
      },
    });
  }
  if (isIOS && navigator.canShare && navigator.canShare({ files: [new File([blob], filename, { type: blob.type })] })) {
    readySheet({
      title: 'Documento pronto',
      sub: `${filename} — scegli “Salva su File”, Mail, WhatsApp o Stampa.`,
      go: 'Condividi o salva',
      onGo: () => shareFile(blob, filename),
    });
  } else {
    const r = await saveBlob(blob, filename);
    if (r === 'saved' || r === 'downloaded') toast(r === 'saved' ? 'Salvato ✓' : 'Scaricato nella cartella Download ✓');
  }
}

$('#btn-save').onclick = () => {
  finishEdit(); select(null);
  const kind = state.doc.kind;
  if (kind === 'pdf') return exportAndSave(true);
  $('#save-orig-badge').className = `fmt fmt-${kind}`;
  $('#save-orig-badge').textContent = kind.toUpperCase();
  $('#save-orig-label').textContent = kind === 'docx' ? 'Documento Word' : 'Foglio Excel';
  $('#save-orig-sub').textContent = 'Stesso formato del file originale, ancora modificabile';
  openSheet('#save-sheet');
};
$('#save-orig').onclick = () => exportAndSave(false);
$('#save-pdf').onclick = () => exportAndSave(true);
$('#save-cancel').onclick = () => closeSheet('#save-sheet');

$('#btn-print').onclick = async () => {
  finishEdit(); select(null);
  busy(true, 'Preparo la stampa…');
  let bytes;
  try {
    bytes = await state.doc.exportPdf(state.elements);
    await preparePrint(bytes);
  } catch (err) {
    console.error(err);
    busy(false);
    return toast('Non riesco a preparare la stampa', 4000);
  }
  busy(false);
  if (isIOS) {
    const blob = new Blob([bytes], { type: 'application/pdf' });
    const filename = signedName(state.rec.name, 'pdf');
    readySheet({
      title: 'Pronto per la stampa',
      sub: 'L’iPhone cerca da solo le stampanti Wi-Fi (AirPrint) sulla tua rete.',
      go: 'Stampa',
      onGo: () => window.print(),
      alt: 'Altre opzioni (condividi)',
      onAlt: () => shareFile(blob, filename),
    });
  } else {
    window.print();
  }
};

/* ================= Signature sheet ================= */
let sigImg = null, sigResult = null, sigInk = 'original', sigTab = 'upload', pad = null;

async function openSigSheet() {
  sigImg = null; sigResult = null;
  const cur = await getSignature();
  const prev = $('#sig-preview');
  $('#sig-tune').hidden = true;
  if (cur) { prev.src = cur.dataUrl; prev.hidden = false; $('#sig-drop-hint').hidden = true; }
  else { prev.hidden = true; prev.removeAttribute('src'); $('#sig-drop-hint').hidden = false; }
  $('#sig-sheet-sub').textContent = cur
    ? 'Questa è la firma salvata. Puoi sostituirla quando vuoi.'
    : 'Caricala una sola volta: resterà salvata su questo dispositivo.';
  $('#sig-save').disabled = true;
  setSigTab('upload');
  openSheet('#sig-sheet');
}

function setSigTab(t) {
  sigTab = t;
  $('#tab-upload').classList.toggle('is-on', t === 'upload');
  $('#tab-draw').classList.toggle('is-on', t === 'draw');
  $('#tab-upload').setAttribute('aria-selected', String(t === 'upload'));
  $('#tab-draw').setAttribute('aria-selected', String(t === 'draw'));
  $('#pane-upload').hidden = t !== 'upload';
  $('#pane-draw').hidden = t !== 'draw';
  if (t === 'draw') {
    if (!pad) pad = createPad($('#sig-pad'), (dirty) => { if (sigTab === 'draw') $('#sig-save').disabled = !dirty; });
    requestAnimationFrame(() => pad.resize());
    $('#sig-save').disabled = true;
  } else {
    $('#sig-save').disabled = !sigResult;
  }
}
$('#tab-upload').onclick = () => setSigTab('upload');
$('#tab-draw').onclick = () => setSigTab('draw');
$('#pad-clear').onclick = () => pad && pad.clear();

function reprocessSig() {
  if (!sigImg) return;
  sigResult = processSignature(sigImg, +$('#sig-threshold').value, sigInk);
  const prev = $('#sig-preview');
  if (sigResult) { prev.src = sigResult.dataUrl; prev.hidden = false; $('#sig-drop-hint').hidden = true; }
  // already-transparent PNGs need no background cleanup
  document.querySelector('#sig-tune .slider-row').hidden = !!(sigResult && sigResult.transparent);
  $('#sig-save').disabled = !sigResult;
}
$('#sig-input').addEventListener('change', async (e) => {
  const f = e.target.files[0];
  e.target.value = '';
  if (!f) return;
  try {
    sigImg = await loadImage(await fileToDataUrl(f));
  } catch { return toast('Immagine non leggibile'); }
  $('#sig-tune').hidden = false;
  reprocessSig();
  if (!sigResult) toast('Non trovo la firma: prova ad alzare “Pulizia sfondo”');
});
let thrRaf;
$('#sig-threshold').addEventListener('input', () => { cancelAnimationFrame(thrRaf); thrRaf = requestAnimationFrame(reprocessSig); });
$('#ink-opts').addEventListener('click', (e) => {
  const b = e.target.closest('.ink');
  if (!b) return;
  sigInk = b.dataset.ink;
  document.querySelectorAll('.ink').forEach((x) => x.classList.toggle('is-on', x === b));
  reprocessSig();
});
$('#sig-cancel').onclick = () => { pendingSig = false; closeSheet('#sig-sheet'); };
$('#sig-save').onclick = async () => {
  let res = sigResult;
  if (sigTab === 'draw') res = processSignature(await pad.toImage(), 250, 'original');
  if (!res) return toast('Firma vuota');
  await saveSignature(res);
  closeSheet('#sig-sheet');
  await refreshSigCard();
  toast('Firma salvata ✓');
  if (pendingSig) { pendingSig = false; if (state.doc) addSignature(); }
};

/* ================= Prefs & boot ================= */
async function savePrefs() { try { await kv.set('prefs', state.prefs); } catch {} }

async function boot() {
  buildFontStrip();
  buildDateStrip();
  try { Object.assign(state.prefs, (await kv.get('prefs')) || {}); } catch {}
  await refreshSigCard();
  await refreshRecent();
  persist();
  const onboarded = await kv.get('onboarded').catch(() => true);
  if (!onboarded && !(await getSignature())) {
    await kv.set('onboarded', true);
    setTimeout(openSigSheet, 400);
  }
  // File mandato da MyHome (tasto "Firma")
  const openId = new URLSearchParams(location.search).get('open');
  if (openId) {
    history.replaceState(null, '', location.pathname);
    const rec = await docStore.get(openId).catch(() => null);
    if (rec) { state.fromMyHome = true; await openRecord(rec, false); await trimRecent().catch(() => {}); }
  }
  // Opened via "Open with" / share target on desktop (File Handling API)
  if ('launchQueue' in window) {
    window.launchQueue.setConsumer(async (params) => {
      if (params.files && params.files.length) openFile(await params.files[0].getFile());
    });
  }
}
boot();

// Local testing hook (never active on the published site)
if (location.hostname === '127.0.0.1') window.__pp = { state };
