import { fontBytes, baselineRatio, LINE_HEIGHT } from './fonts.js';

function hexToRgb(hex) {
  const n = parseInt(hex.replace('#', ''), 16);
  return PDFLib.rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
}

export function newExportCache(doc) {
  return { doc, images: new Map(), fonts: new Map() };
}

async function embedImage(cache, dataUrl) {
  if (!cache.images.has(dataUrl)) cache.images.set(dataUrl, cache.doc.embedPng(dataUrl));
  return cache.images.get(dataUrl);
}
async function embedFont(cache, font, bold) {
  const key = font + (bold ? 'b' : '');
  if (!cache.fonts.has(key)) cache.fonts.set(key, fontBytes(font, bold).then((b) => cache.doc.embedFont(b, { subset: false })));
  return cache.fonts.get(key);
}

// Draws editor elements onto a pdf-lib page.
// map(x, y): element units (top-left origin, as seen on screen) -> PDF user space.
export async function drawElements(pdfPage, els, { map, rotation = 0, toPt = 1, cache }) {
  const rot = PDFLib.degrees(rotation);
  for (const el of els) {
    if (el.type === 'sig') {
      const img = await embedImage(cache, el.src);
      const [X, Y] = map(el.x, el.y + el.h);
      pdfPage.drawImage(img, { x: X, y: Y, width: el.w * toPt, height: el.h * toPt, rotate: rot });
    } else {
      const font = await embedFont(cache, el.font, el.bold);
      const base = baselineRatio(el.font, el.bold);
      const color = hexToRgb(el.color);
      el.text.split('\n').forEach((line, i) => {
        if (!line) return;
        const [X, Y] = map(el.x, el.y + (i * LINE_HEIGHT + base) * el.size);
        pdfPage.drawText(line, { x: X, y: Y, size: el.size * toPt, font, color, rotate: rot });
      });
    }
  }
}

// Builds a PDF from raster snapshots of Word/Excel pages, then adds the
// elements as sharp vector content on top.
// shots: [{ canvas, w, h, toPt, index, sliceY? }]
export async function rasterToPdf(shots, elements) {
  const { PDFDocument } = PDFLib;
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  const cache = newExportCache(doc);
  for (const s of shots) {
    const wPt = s.w * s.toPt, hPt = s.h * s.toPt;
    const page = doc.addPage([wPt, hPt]);
    const jpg = await doc.embedJpg(s.canvas.toDataURL('image/jpeg', 0.92));
    page.drawImage(jpg, { x: 0, y: 0, width: wPt, height: hPt });
    const offY = s.sliceY || 0;
    const els = elements.filter((e) => e.page === s.index && e.y + e.h > offY && e.y < offY + s.h);
    await drawElements(page, els, {
      map: (x, y) => [x * s.toPt, hPt - (y - offY) * s.toPt],
      toPt: s.toPt,
      cache,
    });
  }
  return doc.save();
}

// ---------- Print ----------
// Renders the final PDF to images in #print-area; the caller then calls
// window.print(). iPhone: AirPrint finds Wi-Fi printers. PC: Windows printers.
export async function preparePrint(pdfBytes) {
  const area = document.getElementById('print-area');
  area.querySelectorAll('img').forEach((i) => URL.revokeObjectURL(i.src));
  area.innerHTML = '';
  const pdf = await pdfjsLib.getDocument({ data: pdfBytes.slice(0), isEvalSupported: false }).promise;
  const MM = 25.4 / 72; // 1 pt in millimetres
  const rules = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const p = await pdf.getPage(i);
    const base = p.getViewport({ scale: 1 });
    const wmm = (base.width * MM).toFixed(2), hmm = (base.height * MM).toFixed(2);
    // ~200 dpi, capped for iOS memory
    let scale = 200 / 72;
    const max = 10e6;
    if (base.width * base.height * scale * scale > max) scale = Math.sqrt(max / (base.width * base.height));
    const v = p.getViewport({ scale });
    const c = document.createElement('canvas');
    c.width = Math.floor(v.width); c.height = Math.floor(v.height);
    const g = c.getContext('2d');
    g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height);
    await p.render({ canvasContext: g, viewport: v }).promise;
    const img = new Image();
    img.src = await new Promise((r) => c.toBlob((b) => r(URL.createObjectURL(b)), 'image/jpeg', 0.92));
    await img.decode().catch(() => {});
    // Real-size printing: each page is exactly as big as the document page
    // (in mm), with no margins and no stretching to the paper width.
    // The sheet is 0.3 mm shorter than the image to avoid a blank extra page
    // from rounding; that sliver is inside the document's own white margin.
    const sheet = document.createElement('div');
    sheet.className = 'print-sheet';
    sheet.style.cssText = `width:${wmm}mm;height:calc(${hmm}mm - 0.3mm);page:pp${i};`;
    img.style.cssText = `width:${wmm}mm;height:${hmm}mm;`;
    sheet.appendChild(img);
    area.appendChild(sheet);
    rules.push(`@page pp${i} { size: ${wmm}mm ${hmm}mm; margin: 0; }`);
    if (i === 1) rules.unshift(`@page { size: ${wmm}mm ${hmm}mm; margin: 0; }`);
  }
  pdf.destroy();
  let style = document.getElementById('print-page-style');
  if (!style) { style = document.createElement('style'); style.id = 'print-page-style'; document.head.appendChild(style); }
  style.textContent = rules.join('\n');
}

// ---------- Save / share ----------
export const isIOS = /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

export async function saveBlob(blob, filename, { noShare = false } = {}) {
  const file = new File([blob], filename, { type: blob.type });
  // iPhone: share sheet ("Salva su File", Mail, WhatsApp, Stampa…)
  if (!noShare && isIOS && navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file], title: filename }); return 'shared'; }
    catch (e) { if (e && e.name === 'AbortError') return 'cancelled'; }
  }
  // Chrome/Edge desktop: real "Save as" dialog
  if (window.showSaveFilePicker && !isIOS) {
    const ext = filename.split('.').pop();
    try {
      const handle = await window.showSaveFilePicker({
        suggestedName: filename,
        types: [{ description: ext.toUpperCase(), accept: { [blob.type]: ['.' + ext] } }],
      });
      const w = await handle.createWritable();
      await w.write(blob); await w.close();
      return 'saved';
    } catch (e) { if (e && e.name === 'AbortError') return 'cancelled'; }
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
  return 'downloaded';
}

export function signedName(name, ext) {
  const base = name.replace(/\.[^.]+$/, '');
  return `${base} - firmato.${ext}`;
}
