import { kv } from './store.js';

const KEY = 'signature';
let cached;

export async function getSignature() {
  if (cached === undefined) cached = (await kv.get(KEY)) || null;
  return cached;
}
export async function saveSignature(sig) {
  cached = sig;
  await kv.set(KEY, sig);
}

export function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

export function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result);
    fr.onerror = reject;
    fr.readAsDataURL(file);
  });
}

function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

// True when the image already has a transparent background
// (at least 10% of pixels almost fully transparent).
export function hasTransparency(p) {
  let n = 0, total = 0;
  for (let i = 3; i < p.length; i += 4 * 7) { total++; if (p[i] < 16) n++; }
  return n / total > 0.1;
}

// Turns a photo/scan of a signature into a clean transparent PNG:
// light pixels become transparent (soft edge), the rest is kept and
// optionally recoloured; then trimmed to the ink with a small margin.
export function processSignature(img, threshold = 200, ink = 'original') {
  const MAX = 1400;
  const k = Math.min(1, MAX / Math.max(img.naturalWidth, img.naturalHeight));
  const w = Math.max(1, Math.round(img.naturalWidth * k));
  const h = Math.max(1, Math.round(img.naturalHeight * k));
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const g = c.getContext('2d', { willReadFrequently: true });
  g.drawImage(img, 0, 0, w, h);
  const data = g.getImageData(0, 0, w, h);
  const p = data.data;
  const soft = 28;
  const lo = threshold - soft;
  const tint = ink === 'original' ? null : hexToRgb(ink);
  const transparent = hasTransparency(p);
  let minX = w, minY = h, maxX = -1, maxY = -1;
  for (let i = 0, px = 0; i < p.length; i += 4, px++) {
    const a0 = p[i + 3] / 255;
    if (transparent) {
      // Already a clean PNG: keep every pixel as it is, only trim (and tint if asked)
      if (p[i + 3] < 8) continue;
      if (tint) { p[i] = tint[0]; p[i + 1] = tint[1]; p[i + 2] = tint[2]; }
      const x = px % w, y = (px / w) | 0;
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
      continue;
    }
    const lum = 0.299 * p[i] + 0.587 * p[i + 1] + 0.114 * p[i + 2];
    let a;
    if (lum >= threshold) a = 0;
    else if (lum <= lo) a = 1;
    else a = (threshold - lum) / soft;
    a *= a0;
    if (a < 0.04) { p[i + 3] = 0; continue; }
    if (tint) { p[i] = tint[0]; p[i + 1] = tint[1]; p[i + 2] = tint[2]; }
    else {
      // deepen the ink a little so faint pen strokes print well
      p[i] = Math.round(p[i] * 0.75); p[i + 1] = Math.round(p[i + 1] * 0.75); p[i + 2] = Math.round(p[i + 2] * 0.8);
    }
    p[i + 3] = Math.round(a * 255);
    const x = px % w, y = (px / w) | 0;
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
  }
  if (maxX < 0) return null; // nothing found
  g.putImageData(data, 0, 0);
  const pad = Math.round(Math.max(maxX - minX, maxY - minY) * 0.03) + 2;
  minX = Math.max(0, minX - pad); minY = Math.max(0, minY - pad);
  maxX = Math.min(w - 1, maxX + pad); maxY = Math.min(h - 1, maxY + pad);
  const cw = maxX - minX + 1, ch = maxY - minY + 1;
  const out = document.createElement('canvas');
  out.width = cw; out.height = ch;
  out.getContext('2d').drawImage(c, minX, minY, cw, ch, 0, 0, cw, ch);
  return { dataUrl: out.toDataURL('image/png'), w: cw, h: ch, transparent };
}

// Finger / mouse signature pad with smooth, pressure-like strokes.
export function createPad(canvas, onChange) {
  const g = canvas.getContext('2d');
  let dpr = 1, drawing = false, last = null, lastW = 3, dirty = false;
  function resize() {
    dpr = window.devicePixelRatio || 1;
    const r = canvas.getBoundingClientRect();
    canvas.width = Math.round(r.width * dpr * 2);
    canvas.height = Math.round(r.height * dpr * 2);
    g.setTransform(dpr * 2, 0, 0, dpr * 2, 0, 0);
    g.lineCap = 'round'; g.lineJoin = 'round'; g.strokeStyle = '#111';
    dirty = false; onChange && onChange(false);
  }
  function pos(e) {
    const r = canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top, t: performance.now() };
  }
  canvas.addEventListener('pointerdown', (e) => {
    drawing = true; last = pos(e); lastW = 3;
    canvas.setPointerCapture(e.pointerId);
    g.beginPath(); g.arc(last.x, last.y, 1.4, 0, Math.PI * 2); g.fillStyle = '#111'; g.fill();
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!drawing) return;
    const pts = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
    for (const ev of pts) {
      const p = pos(ev);
      const d = Math.hypot(p.x - last.x, p.y - last.y);
      const v = d / Math.max(1, p.t - last.t);
      const wTarget = Math.max(1.4, Math.min(4.2, 4.4 - v * 1.6));
      const wNow = lastW * 0.7 + wTarget * 0.3;
      g.lineWidth = wNow;
      g.beginPath(); g.moveTo(last.x, last.y); g.lineTo(p.x, p.y); g.stroke();
      last = p; lastW = wNow;
    }
    if (!dirty) { dirty = true; onChange && onChange(true); }
  });
  const end = () => { drawing = false; };
  canvas.addEventListener('pointerup', end);
  canvas.addEventListener('pointercancel', end);
  return {
    resize,
    clear: resize,
    isDirty: () => dirty,
    toImage: () => loadImage(canvas.toDataURL('image/png')),
  };
}
