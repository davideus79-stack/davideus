import { textToPng } from '../fonts.js';
import { rasterToPdf } from '../export.js';
import { snapshot, NS, parseXml, serializeXml, ensureContentDefault, addRelationship, resolvePart, mainPartPath, relsPathFor, dataUrlToBase64 } from './ooxml.js';

const EMU_PER_PX = 9525;

function bodyParagraphs(xml) {
  const body = xml.getElementsByTagNameNS(NS.w, 'body')[0];
  return Array.from(body.children).filter((n) => n.namespaceURI === NS.w && n.localName === 'p');
}
function insertAtParaStart(p, node) {
  const first = p.firstElementChild;
  if (first && first.namespaceURI === NS.w && first.localName === 'pPr') first.after(node);
  else p.insertBefore(node, p.firstChild);
}

// A copy of the document where every top-level paragraph starts with a
// bookmark "_pp_<n>". docx-preview renders bookmarks as <span id>, which lets
// us know on which rendered page each paragraph starts.
//
// Pictures placed "relative to the page" (e.g. a signature saved by Pdf plus)
// are drawn by docx-preview relative to their paragraph, so they end up in the
// wrong place. We mark them with a bookmark "_pa_<n>" and move them to the
// right spot on the page after rendering (see placePageAnchors).
async function taggedCopy(bytes) {
  const zip = await JSZip.loadAsync(bytes);
  const main = await mainPartPath(zip);
  const xml = parseXml(await zip.file(main).async('string'));
  const anchors = [];
  Array.from(xml.getElementsByTagNameNS(NS.wp, 'anchor')).forEach((a) => {
    const pos = (tag) => {
      const el = Array.from(a.children).find((c) => c.localName === tag);
      if (!el || el.getAttribute('relativeFrom') !== 'page') return null;
      const off = Array.from(el.children).find((c) => c.localName === 'posOffset');
      return off ? Number(off.textContent) : null;
    };
    const x = pos('positionH'), y = pos('positionV');
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    let run = a;
    while (run && !(run.namespaceURI === NS.w && run.localName === 'r')) run = run.parentNode;
    if (!run || !run.parentNode) return;
    const i = anchors.length;
    const s = xml.createElementNS(NS.w, 'w:bookmarkStart');
    s.setAttributeNS(NS.w, 'w:id', String(900000 + i));
    s.setAttributeNS(NS.w, 'w:name', `_pa_${i}`);
    const e = xml.createElementNS(NS.w, 'w:bookmarkEnd');
    e.setAttributeNS(NS.w, 'w:id', String(900000 + i));
    run.parentNode.insertBefore(s, run);
    run.parentNode.insertBefore(e, run);
    anchors.push({ x: x / EMU_PER_PX, y: y / EMU_PER_PX });
  });
  bodyParagraphs(xml).forEach((p, i) => {
    const s = xml.createElementNS(NS.w, 'w:bookmarkStart');
    s.setAttributeNS(NS.w, 'w:id', String(800000 + i));
    s.setAttributeNS(NS.w, 'w:name', `_pp_${i}`);
    const e = xml.createElementNS(NS.w, 'w:bookmarkEnd');
    e.setAttributeNS(NS.w, 'w:id', String(800000 + i));
    insertAtParaStart(p, e);
    insertAtParaStart(p, s);
  });
  zip.file(main, serializeXml(xml));
  return { blob: await zip.generateAsync({ type: 'blob' }), anchors };
}

function placePageAnchors(host, anchors) {
  anchors.forEach((pos, i) => {
    const mark = host.querySelector(`[id="_pa_${i}"]`);
    const sec = mark && mark.closest('section.docx');
    if (!sec) return;
    // the picture is the first positioned box with an image after the bookmark
    const walker = document.createTreeWalker(sec, NodeFilter.SHOW_ELEMENT);
    walker.currentNode = mark;
    let box = null;
    while (walker.nextNode()) {
      const n = walker.currentNode;
      if (n.tagName === 'IMG') { box = n.parentElement; break; }
    }
    if (!box || box === sec) return;
    box.style.position = 'absolute';
    box.style.left = pos.x + 'px';
    box.style.top = pos.y + 'px';
    box.style.zIndex = '2';
    box.style.margin = '0';
    sec.appendChild(box);
  });
}

// The page grows with its real content (the section is a flex column), so
// offsetHeight is enough. scrollHeight also counts floating boxes that stick
// out of the page (logos, text boxes in headers): on iPhone/Safari that made
// some pages much longer than A4, with the footer left halfway down.
function fullHeight(sec) {
  return Math.ceil(sec.offsetHeight);
}

async function settleLayout(root) {
  const imgs = Array.from(root.querySelectorAll('img'));
  const timeout = new Promise((r) => setTimeout(r, 4000));
  await Promise.race([
    Promise.all([
      document.fonts ? document.fonts.ready : null,
      ...imgs.map((img) => (img.decode ? img.decode() : Promise.resolve()).catch(() => {})),
    ]),
    timeout,
  ]);
  // rAF is paused in background tabs: never wait on it alone.
  await new Promise((r) => { requestAnimationFrame(() => requestAnimationFrame(r)); setTimeout(r, 100); });
}

// Each page keeps the exact paper size of the document (e.g. A4).
// If the text wraps a little differently here than in Word (iPhone) and the
// page would come out a bit longer, the body is shrunk slightly to fit.
// Only when it is much longer (a document without page breaks) the page grows.
function fitToPaper(sec) {
  const paper = parseFloat(getComputedStyle(sec).minHeight) || 0;
  if (!paper) return;
  const natural = sec.offsetHeight;
  if (natural > paper + 1) {
    const art = sec.querySelector(':scope > article');
    const extra = natural - paper;
    if (!art || extra > paper * 0.2) return;
    const ah = art.offsetHeight;
    art.style.zoom = String(Math.max(0.75, (ah - extra - 2) / ah));
  }
  if (sec.offsetHeight <= paper + 1) sec.style.height = paper + 'px';
}

export async function loadDocx(bytes, name) {
  const sandbox = document.getElementById('render-sandbox');
  const host = document.createElement('div');
  const styleHost = document.createElement('div');
  styleHost.className = 'docx-styles';
  sandbox.appendChild(host);
  document.body.appendChild(styleHost);

  let blob, anchors = [];
  try { ({ blob, anchors } = await taggedCopy(bytes)); } catch { blob = new Blob([bytes]); }
  await docx.renderAsync(blob, host, styleHost, {
    className: 'docx',
    inWrapper: false,
    breakPages: true,
    ignoreLastRenderedPageBreak: false,
    ignoreWidth: false,
    ignoreHeight: false,
    renderHeaders: true,
    renderFooters: true,
    renderFootnotes: true,
    renderEndnotes: true,
    useBase64URL: true,
    experimental: true,
  });

  const sections = Array.from(host.querySelectorAll('section.docx'));
  if (!sections.length) throw new Error('Documento Word vuoto o non leggibile');
  try { placePageAnchors(host, anchors); } catch (e) { console.warn('anchors', e); }
  // Images and fonts load after renderAsync resolves and make the content
  // taller: measure only once they are ready, or the page bottom gets cut.
  await settleLayout(host);
  sections.forEach(fitToPaper);
  let lastPara = 0;
  const pages = sections.map((sec, index) => {
    const w = sec.offsetWidth;
    let h = fullHeight(sec);
    const ids = Array.from(sec.querySelectorAll('span[id^="_pp_"]')).map((s) => +s.id.slice(4)).filter(Number.isFinite);
    const firstPara = ids.length ? Math.min(...ids) : null;
    const anchorPara = firstPara ?? lastPara;
    if (ids.length) lastPara = Math.max(...ids);
    return {
      index, w, h, toPt: 0.75, section: sec, anchorPara, exact: firstPara !== null,
      mount(content) {
        this._content = content;
        content.style.width = w + 'px';
        content.appendChild(sec);
        h = this.h = Math.max(h, fullHeight(sec));
        content.style.height = h + 'px';
      },
      render(scale) { this._content && (this._content.style.transform = `scale(${scale})`); },
    };
  });

  return {
    kind: 'docx',
    name,
    bytes,
    unit: 'px',
    pages,
    destroy() { host.remove(); styleHost.remove(); },
    exportOriginal: (els) => exportDocx(bytes, pages, els),
    async exportPdf(els) {
      const shots = [];
      for (const p of pages) shots.push({ canvas: await snapshot(p.section, { width: p.w, height: p.h }), w: p.w, h: p.h, toPt: 0.75, index: p.index });
      return rasterToPdf(shots, els);
    },
  };
}

async function exportDocx(bytes, pages, elements) {
  const zip = await JSZip.loadAsync(bytes);
  const main = await mainPartPath(zip);
  const xml = parseXml(await zip.file(main).async('string'));
  const root = xml.documentElement;
  for (const [p, uri] of [['wp', NS.wp], ['a', NS.a], ['pic', NS.pic], ['r', NS.r]]) {
    if (!root.lookupNamespaceURI(p)) root.setAttributeNS('http://www.w3.org/2000/xmlns/', `xmlns:${p}`, uri);
  }
  const relsPath = relsPathFor(main);
  const rels = zip.file(relsPath) ? parseXml(await zip.file(relsPath).async('string')) : parseXml(`<Relationships xmlns="${NS.rel}"/>`);
  const paras = bodyParagraphs(xml);
  const dir = main.slice(0, main.lastIndexOf('/') + 1);
  const stamp = Date.now().toString(36);

  let n = 0;
  for (const el of elements) {
    const page = pages[el.page];
    if (!page) continue;
    let para = paras[Math.min(page.anchorPara, paras.length - 1)];
    if (!para) {
      const body = xml.getElementsByTagNameNS(NS.w, 'body')[0];
      para = xml.createElementNS(NS.w, 'w:p');
      body.insertBefore(para, body.firstChild);
    }
    const png = el.type === 'sig' ? el.src : await textToPng(el, 5);
    n++;
    const media = `media/pdfplus_${stamp}_${n}.png`;
    zip.file(dir + media, dataUrlToBase64(png), { base64: true });
    const rId = addRelationship(rels, 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/image', media);
    const id = 70000 + n;
    const cx = Math.round(el.w * EMU_PER_PX), cy = Math.round(el.h * EMU_PER_PX);
    const x = Math.round(el.x * EMU_PER_PX), y = Math.round(el.y * EMU_PER_PX);
    const frag = parseXml(`<w:r xmlns:w="${NS.w}" xmlns:wp="${NS.wp}" xmlns:a="${NS.a}" xmlns:pic="${NS.pic}" xmlns:r="${NS.r}"><w:drawing><wp:anchor distT="0" distB="0" distL="0" distR="0" simplePos="0" relativeHeight="${251660000 + n}" behindDoc="0" locked="0" layoutInCell="1" allowOverlap="1"><wp:simplePos x="0" y="0"/><wp:positionH relativeFrom="page"><wp:posOffset>${x}</wp:posOffset></wp:positionH><wp:positionV relativeFrom="page"><wp:posOffset>${y}</wp:posOffset></wp:positionV><wp:extent cx="${cx}" cy="${cy}"/><wp:effectExtent l="0" t="0" r="0" b="0"/><wp:wrapNone/><wp:docPr id="${id}" name="PdfPlus ${n}"/><wp:cNvGraphicFramePr><a:graphicFrameLocks noChangeAspect="1"/></wp:cNvGraphicFramePr><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:nvPicPr><pic:cNvPr id="${id}" name="pdfplus_${n}.png"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="${rId}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:anchor></w:drawing></w:r>`);
    insertAtParaStart(para, xml.importNode(frag.documentElement, true));
  }

  zip.file(main, serializeXml(xml));
  zip.file(relsPath, serializeXml(rels));
  await ensureContentDefault(zip, 'png', 'image/png');
  return zip.generateAsync({ type: 'blob', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', compression: 'DEFLATE' });
}
