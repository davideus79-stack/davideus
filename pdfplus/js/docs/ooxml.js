// Shared helpers for editing Office Open XML packages (docx/xlsx) with JSZip.
export const NS = {
  w: 'http://schemas.openxmlformats.org/wordprocessingml/2006/main',
  wp: 'http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing',
  a: 'http://schemas.openxmlformats.org/drawingml/2006/main',
  pic: 'http://schemas.openxmlformats.org/drawingml/2006/picture',
  r: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships',
  rel: 'http://schemas.openxmlformats.org/package/2006/relationships',
  ct: 'http://schemas.openxmlformats.org/package/2006/content-types',
  xdr: 'http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing',
  s: 'http://schemas.openxmlformats.org/spreadsheetml/2006/main',
};

export const parseXml = (s) => new DOMParser().parseFromString(s, 'application/xml');
export const serializeXml = (d) => {
  const out = new XMLSerializer().serializeToString(d);
  return out.startsWith('<?xml') ? out : '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' + out;
};

export function dataUrlToBase64(u) { return u.slice(u.indexOf(',') + 1); }

// "xl/worksheets/sheet1.xml" -> "xl/worksheets/_rels/sheet1.xml.rels"
export function relsPathFor(part) {
  const i = part.lastIndexOf('/');
  return `${part.slice(0, i + 1)}_rels/${part.slice(i + 1)}.rels`;
}

// Resolve a relationship Target relative to the part that owns it.
export function resolvePart(fromPart, target) {
  if (target.startsWith('/')) return target.slice(1);
  const parts = fromPart.split('/').slice(0, -1);
  for (const seg of target.split('/')) {
    if (seg === '..') parts.pop();
    else if (seg !== '.') parts.push(seg);
  }
  return parts.join('/');
}

export async function mainPartPath(zip) {
  const rels = parseXml(await zip.file('_rels/.rels').async('string'));
  for (const r of rels.getElementsByTagNameNS(NS.rel, 'Relationship')) {
    if (/\/officeDocument$/.test(r.getAttribute('Type'))) return resolvePart('', r.getAttribute('Target'));
  }
  throw new Error('Documento non valido');
}

export function addRelationship(relsDoc, type, target) {
  const root = relsDoc.documentElement;
  const used = new Set(Array.from(root.getElementsByTagNameNS(NS.rel, 'Relationship')).map((r) => r.getAttribute('Id')));
  let i = 1, id;
  do { id = `rIdPP${i++}`; } while (used.has(id));
  const rel = relsDoc.createElementNS(NS.rel, 'Relationship');
  rel.setAttribute('Id', id);
  rel.setAttribute('Type', type);
  rel.setAttribute('Target', target);
  root.appendChild(rel);
  return id;
}

export async function ensureContentDefault(zip, ext, type) {
  const ct = parseXml(await zip.file('[Content_Types].xml').async('string'));
  const has = Array.from(ct.getElementsByTagNameNS(NS.ct, 'Default')).some((d) => (d.getAttribute('Extension') || '').toLowerCase() === ext);
  if (has) return;
  const d = ct.createElementNS(NS.ct, 'Default');
  d.setAttribute('Extension', ext);
  d.setAttribute('ContentType', type);
  ct.documentElement.insertBefore(d, ct.documentElement.firstChild);
  zip.file('[Content_Types].xml', serializeXml(ct));
}

export async function ensureContentOverride(zip, partName, type) {
  const ct = parseXml(await zip.file('[Content_Types].xml').async('string'));
  const name = '/' + partName;
  const has = Array.from(ct.getElementsByTagNameNS(NS.ct, 'Override')).some((o) => o.getAttribute('PartName') === name);
  if (has) return;
  const o = ct.createElementNS(NS.ct, 'Override');
  o.setAttribute('PartName', name);
  o.setAttribute('ContentType', type);
  ct.documentElement.appendChild(o);
  zip.file('[Content_Types].xml', serializeXml(ct));
}

// Rasterise a rendered page (docx section / xlsx grid) at ~200 dpi.
// The node is cloned into a visible, untransformed host behind the app so
// html2canvas sees it exactly at its natural size.
export async function snapshot(node, { width, height, y = 0, scale = 2 }) {
  const host = document.createElement('div');
  host.style.cssText = `position:fixed;left:0;top:0;z-index:-1;pointer-events:none;width:${node.offsetWidth || width}px;background:#fff;`;
  const clone = node.cloneNode(true);
  // cloneNode does not copy canvas pixels
  const src = node.querySelectorAll('canvas'), dst = clone.querySelectorAll('canvas');
  src.forEach((c, i) => { dst[i].width = c.width; dst[i].height = c.height; dst[i].getContext('2d').drawImage(c, 0, 0); });
  host.appendChild(clone);
  document.body.appendChild(host);
  try {
    return await html2canvas(clone, {
      backgroundColor: '#ffffff', scale, logging: false, useCORS: true,
      x: 0, y, width, height, windowWidth: Math.max(window.innerWidth, width + 20), scrollX: 0, scrollY: 0,
    });
  } finally { host.remove(); }
}
