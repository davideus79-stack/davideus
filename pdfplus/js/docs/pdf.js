import { drawElements, newExportCache } from '../export.js';

pdfjsLib.GlobalWorkerOptions.workerSrc = 'vendor/pdf.worker.min.js';

const MAX_CANVAS_PX = 12e6; // stay under iOS Safari canvas limits

export async function loadPdf(bytes, name) {
  const pdf = await pdfjsLib.getDocument({ data: new Uint8Array(bytes.slice(0)), isEvalSupported: false }).promise;
  const pages = [];
  for (let i = 0; i < pdf.numPages; i++) {
    const p = await pdf.getPage(i + 1);
    const vp = p.getViewport({ scale: 1 });
    pages.push(makePage(p, vp, i));
  }
  return {
    kind: 'pdf',
    name,
    bytes,
    unit: 'pt',
    pages,
    destroy() { pdf.destroy(); },
    async exportOriginal(elements) {
      return new Blob([await exportPdf(bytes, pages, elements)], { type: 'application/pdf' });
    },
    async exportPdf(elements) {
      return exportPdf(bytes, pages, elements);
    },
  };
}

function makePage(p, vp, index) {
  let task = null, renderedScale = 0, canvas = null;
  return {
    index,
    w: vp.width,
    h: vp.height,
    toPt: 1,
    viewport: vp,
    mount(content) {
      canvas = document.createElement('canvas');
      canvas.className = 'pdf-canvas';
      content.style.position = 'absolute';
      content.style.inset = '0';
      content.appendChild(canvas);
      renderedScale = 0;
    },
    async render(scale) {
      if (!canvas) return;
      let dpr = Math.min(3, window.devicePixelRatio || 1);
      const area = vp.width * vp.height * scale * scale * dpr * dpr;
      if (area > MAX_CANVAS_PX) dpr *= Math.sqrt(MAX_CANVAS_PX / area);
      const target = scale * dpr;
      if (Math.abs(target - renderedScale) < 0.01) return;
      if (task) { try { task.cancel(); } catch {} }
      const v = p.getViewport({ scale: target });
      const c = document.createElement('canvas');
      c.width = Math.floor(v.width); c.height = Math.floor(v.height);
      task = p.render({ canvasContext: c.getContext('2d'), viewport: v });
      try {
        await task.promise;
        canvas.width = c.width; canvas.height = c.height;
        canvas.getContext('2d').drawImage(c, 0, 0);
        renderedScale = target;
      } catch (e) {
        if (e && e.name !== 'RenderingCancelledException') console.warn(e);
      } finally { task = null; }
    },
  };
}

async function exportPdf(bytes, pages, elements) {
  const { PDFDocument } = PDFLib;
  const doc = await PDFDocument.load(bytes, { ignoreEncryption: true });
  doc.registerFontkit(fontkit);
  const cache = newExportCache(doc);
  const pdfPages = doc.getPages();
  for (const page of pages) {
    const els = elements.filter((e) => e.page === page.index);
    if (!els.length) continue;
    const vp = page.viewport;
    await drawElements(pdfPages[page.index], els, {
      map: (x, y) => vp.convertToPdfPoint(x, y),
      rotation: vp.rotation || 0,
      toPt: 1,
      cache,
    });
  }
  return doc.save();
}
