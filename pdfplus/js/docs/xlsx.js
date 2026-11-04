import { textToPng } from '../fonts.js';
import { rasterToPdf } from '../export.js';
import { snapshot, NS, parseXml, serializeXml, ensureContentDefault, ensureContentOverride, addRelationship, resolvePart, mainPartPath, relsPathFor, dataUrlToBase64 } from './ooxml.js';

const EMU_PER_PX = 9525;
const MAX_ROWS = 600, MAX_COLS = 60, PAD_ROWS = 15, PAD_COLS = 3;
const DEF_COL = 64, DEF_ROW = 20;

function esc(s) { return String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c])); }

function buildSheet(ws) {
  const ref = ws['!ref'] || 'A1:A1';
  const range = XLSX.utils.decode_range(ref);
  const lastRow = Math.min(range.e.r, MAX_ROWS - 1);
  const lastCol = Math.min(range.e.c, MAX_COLS - 1);
  const nRows = lastRow + 1 + PAD_ROWS;
  const nCols = lastCol + 1 + PAD_COLS;
  const colsInfo = ws['!cols'] || [];
  const rowsInfo = ws['!rows'] || [];
  const colW = [], rowH = [];
  for (let c = 0; c < nCols; c++) {
    const ci = colsInfo[c];
    colW.push(ci ? (ci.hidden ? 0 : Math.round(ci.wpx || (ci.wch ? ci.wch * 7 + 5 : DEF_COL))) : DEF_COL);
  }
  for (let r = 0; r < nRows; r++) {
    const ri = rowsInfo[r];
    rowH.push(ri ? (ri.hidden ? 0 : Math.round(ri.hpx || (ri.hpt ? ri.hpt * 4 / 3 : DEF_ROW))) : DEF_ROW);
  }
  const colX = [0], rowY = [0];
  colW.forEach((w, i) => colX.push(colX[i] + w));
  rowH.forEach((h, i) => rowY.push(rowY[i] + h));
  const W = colX[nCols], H = rowY[nRows];

  const grid = document.createElement('div');
  grid.className = 'xgrid';
  grid.style.cssText = `position:relative;width:${W}px;height:${H}px;`;
  // gridlines on a canvas (cheap even for big sheets)
  const lines = document.createElement('canvas');
  lines.width = W; lines.height = H;
  lines.style.cssText = 'position:absolute;left:0;top:0;';
  const g = lines.getContext('2d');
  g.fillStyle = '#fff'; g.fillRect(0, 0, W, H);
  g.strokeStyle = '#e2e2e2'; g.lineWidth = 1; g.beginPath();
  colX.forEach((x) => { g.moveTo(x - 0.5, 0); g.lineTo(x - 0.5, H); });
  rowY.forEach((y) => { g.moveTo(0, y - 0.5); g.lineTo(W, y - 0.5); });
  g.stroke();
  grid.appendChild(lines);

  const merges = ws['!merges'] || [];
  const mergeAt = new Map();
  for (const m of merges) mergeAt.set(m.s.r + ':' + m.s.c, m);

  let html = '';
  for (let r = 0; r <= lastRow; r++) {
    for (let c = 0; c <= lastCol; c++) {
      const cell = ws[XLSX.utils.encode_cell({ r, c })];
      if (!cell || (cell.v == null && !cell.w)) continue;
      const m = mergeAt.get(r + ':' + c);
      const r2 = m ? Math.min(m.e.r, nRows - 1) : r, c2 = m ? Math.min(m.e.c, nCols - 1) : c;
      const left = colX[c], top = rowY[r], w = colX[c2 + 1] - left, h = rowY[r2 + 1] - top;
      if (!w || !h) continue;
      const text = cell.w != null ? cell.w : String(cell.v);
      const cls = 'xcell' + (cell.t === 'n' ? ' num' : '') + (cell.s && cell.s.font && cell.s.font.bold ? ' b' : '');
      let bg = '';
      const fg = cell.s && cell.s.fgColor && cell.s.fgColor.rgb;
      if (fg && cell.s.patternType === 'solid' && /^[0-9A-F]{6}$/i.test(fg.slice(-6)) && fg.slice(-6).toUpperCase() !== 'FFFFFF') bg = `background:#${fg.slice(-6)};`;
      html += `<div class="${cls}" style="position:absolute;left:${left}px;top:${top}px;width:${w}px;height:${h}px;${bg}${m ? 'justify-content:center;' : ''}">${esc(text)}</div>`;
    }
  }
  grid.insertAdjacentHTML('beforeend', html);
  const usedH = rowY[lastRow + 1];
  return { grid, W, H, colX, rowY, usedH };
}

export async function loadXlsx(bytes, name) {
  const wb = XLSX.read(new Uint8Array(bytes), { type: 'array', cellStyles: true });
  const pages = wb.SheetNames.map((sheetName, index) => {
    const s = buildSheet(wb.Sheets[sheetName]);
    return {
      index, w: s.W, h: s.H, toPt: 0.75, label: sheetName, sheet: s,
      mount(content) {
        this._content = content;
        content.style.width = s.W + 'px';
        content.style.height = s.H + 'px';
        content.appendChild(s.grid);
      },
      render(scale) { this._content && (this._content.style.transform = `scale(${scale})`); },
    };
  });
  return {
    kind: 'xlsx',
    name,
    bytes,
    unit: 'px',
    pages,
    destroy() {},
    exportOriginal: (els) => exportXlsx(bytes, pages, els),
    async exportPdf(els) {
      const shots = [];
      for (const p of pages) {
        const mine = els.filter((e) => e.page === p.index);
        const needH = Math.max(p.sheet.usedH, ...mine.map((e) => e.y + e.h + 10));
        const sliceW = Math.max(p.w, 794);
        const sliceH = Math.round(sliceW * 1.4142);
        for (let y = 0; y < needH; y += sliceH) {
          const h = Math.min(sliceH, p.h - y);
          const shot = await snapshot(p.sheet.grid, { width: p.w, height: h, y, scale: 2 });
          // place onto a full-size page canvas (white padding right/bottom)
          const c = document.createElement('canvas');
          c.width = Math.round(sliceW * 2); c.height = Math.round(sliceH * 2);
          const g = c.getContext('2d');
          g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height);
          g.drawImage(shot, 0, 0);
          shots.push({ canvas: c, w: sliceW, h: sliceH, toPt: 0.75, index: p.index, sliceY: y });
        }
      }
      if (!shots.length) {
        const c = document.createElement('canvas'); c.width = 1588; c.height = 2246;
        const g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height);
        shots.push({ canvas: c, w: 794, h: 1123, toPt: 0.75, index: 0 });
      }
      return rasterToPdf(shots, els);
    },
  };
}

function locate(stops, v) {
  // index i with stops[i] <= v < stops[i+1], skipping zero-size tracks
  let i = 0;
  while (i < stops.length - 2 && stops[i + 1] <= v) i++;
  return { i, off: Math.max(0, v - stops[i]) };
}

const DRAWING_AFTER = ['legacyDrawing', 'legacyDrawingHF', 'drawingHF', 'picture', 'oleObjects', 'controls', 'webPublishItems', 'tableParts', 'extLst'];

async function exportXlsx(bytes, pages, elements) {
  const zip = await JSZip.loadAsync(bytes);
  const wbPath = await mainPartPath(zip);
  const wbXml = parseXml(await zip.file(wbPath).async('string'));
  const wbRels = parseXml(await zip.file(relsPathFor(wbPath)).async('string'));
  const relTarget = new Map(Array.from(wbRels.getElementsByTagNameNS(NS.rel, 'Relationship')).map((r) => [r.getAttribute('Id'), r.getAttribute('Target')]));
  const sheetEls = Array.from(wbXml.getElementsByTagNameNS(NS.s, 'sheet'));
  const stamp = Date.now().toString(36);
  let n = 0;

  for (const page of pages) {
    const els = elements.filter((e) => e.page === page.index);
    if (!els.length) continue;
    const sh = sheetEls[page.index];
    if (!sh) continue;
    const rid = sh.getAttributeNS(NS.r, 'id') || sh.getAttribute('r:id');
    const sheetPath = resolvePart(wbPath, relTarget.get(rid));
    const sheetXml = parseXml(await zip.file(sheetPath).async('string'));
    const sheetRelsPath = relsPathFor(sheetPath);
    const sheetRels = zip.file(sheetRelsPath) ? parseXml(await zip.file(sheetRelsPath).async('string')) : parseXml(`<Relationships xmlns="${NS.rel}"/>`);

    // Find or create the sheet's drawing part
    let drawingPath, drawingXml;
    const existing = sheetXml.getElementsByTagNameNS(NS.s, 'drawing')[0];
    if (existing) {
      const drId = existing.getAttributeNS(NS.r, 'id');
      const rel = Array.from(sheetRels.getElementsByTagNameNS(NS.rel, 'Relationship')).find((r) => r.getAttribute('Id') === drId);
      drawingPath = resolvePart(sheetPath, rel.getAttribute('Target'));
      drawingXml = parseXml(await zip.file(drawingPath).async('string'));
    } else {
      drawingPath = `xl/drawings/drawing_pp_${stamp}_${page.index}.xml`;
      drawingXml = parseXml(`<xdr:wsDr xmlns:xdr="${NS.xdr}" xmlns:a="${NS.a}" xmlns:r="${NS.r}"/>`);
      const target = '../drawings/' + drawingPath.split('/').pop();
      const drId = addRelationship(sheetRels, 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing', target);
      const root = sheetXml.documentElement;
      if (!root.lookupNamespaceURI('r')) root.setAttributeNS('http://www.w3.org/2000/xmlns/', 'xmlns:r', NS.r);
      const d = sheetXml.createElementNS(NS.s, root.prefix ? root.prefix + ':drawing' : 'drawing');
      d.setAttributeNS(NS.r, 'r:id', drId);
      const before = Array.from(root.children).find((c) => DRAWING_AFTER.includes(c.localName));
      root.insertBefore(d, before || null);
      await ensureContentOverride(zip, drawingPath, 'application/vnd.openxmlformats-officedocument.drawing+xml');
    }
    const drRelsPath = relsPathFor(drawingPath);
    const drRels = zip.file(drRelsPath) ? parseXml(await zip.file(drRelsPath).async('string')) : parseXml(`<Relationships xmlns="${NS.rel}"/>`);
    const wsDr = drawingXml.documentElement;
    if (!wsDr.lookupNamespaceURI('a')) wsDr.setAttributeNS('http://www.w3.org/2000/xmlns/', 'xmlns:a', NS.a);
    if (!wsDr.lookupNamespaceURI('r')) wsDr.setAttributeNS('http://www.w3.org/2000/xmlns/', 'xmlns:r', NS.r);

    for (const el of els) {
      const png = el.type === 'sig' ? el.src : await textToPng(el, 5);
      n++;
      const mediaPath = `xl/media/pdfplus_${stamp}_${n}.png`;
      zip.file(mediaPath, dataUrlToBase64(png), { base64: true });
      const rId = addRelationship(drRels, 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/image', '../media/' + mediaPath.split('/').pop());
      const col = locate(page.sheet.colX, el.x), row = locate(page.sheet.rowY, el.y);
      const cx = Math.round(el.w * EMU_PER_PX), cy = Math.round(el.h * EMU_PER_PX);
      const id = 5000 + n;
      const frag = parseXml(`<xdr:oneCellAnchor xmlns:xdr="${NS.xdr}" xmlns:a="${NS.a}" xmlns:r="${NS.r}"><xdr:from><xdr:col>${col.i}</xdr:col><xdr:colOff>${Math.round(col.off * EMU_PER_PX)}</xdr:colOff><xdr:row>${row.i}</xdr:row><xdr:rowOff>${Math.round(row.off * EMU_PER_PX)}</xdr:rowOff></xdr:from><xdr:ext cx="${cx}" cy="${cy}"/><xdr:pic><xdr:nvPicPr><xdr:cNvPr id="${id}" name="PdfPlus ${n}"/><xdr:cNvPicPr><a:picLocks noChangeAspect="1"/></xdr:cNvPicPr></xdr:nvPicPr><xdr:blipFill><a:blip r:embed="${rId}"/><a:stretch><a:fillRect/></a:stretch></xdr:blipFill><xdr:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></xdr:spPr></xdr:pic><xdr:clientData/></xdr:oneCellAnchor>`);
      wsDr.appendChild(drawingXml.importNode(frag.documentElement, true));
    }

    zip.file(sheetPath, serializeXml(sheetXml));
    zip.file(sheetRelsPath, serializeXml(sheetRels));
    zip.file(drawingPath, serializeXml(drawingXml));
    zip.file(drRelsPath, serializeXml(drRels));
  }
  await ensureContentDefault(zip, 'png', 'image/png');
  return zip.generateAsync({ type: 'blob', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', compression: 'DEFLATE' });
}
