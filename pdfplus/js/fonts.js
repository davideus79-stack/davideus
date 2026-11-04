// Font catalogue + text layout helpers shared by the editor and all exporters.
export const FONTS = [
  { id: 'Inter', label: 'Moderno', file: 'Inter' },
  { id: 'Lora', label: 'Elegante', file: 'Lora' },
  { id: 'Playfair', label: 'Classico', file: 'Playfair' },
  { id: 'DancingScript', label: 'Corsivo', file: 'DancingScript' },
  { id: 'Caveat', label: 'A mano', file: 'Caveat' },
  { id: 'CourierPrime', label: 'Macchina', file: 'CourierPrime' },
];

export const LINE_HEIGHT = 1.2;

export function cssFamily(id) {
  return `"${id}", system-ui, sans-serif`;
}

export async function ensureFontsLoaded() {
  const loads = [];
  for (const f of FONTS) for (const w of [400, 700]) loads.push(document.fonts.load(`${w} 40px "${f.id}"`));
  try { await Promise.all(loads); } catch {}
}

// Baseline position of the first line, as a fraction of font size,
// for a block with line-height LINE_HEIGHT. Measured from the real DOM so
// exports match what the user sees.
const baseCache = new Map();
export function baselineRatio(font, bold) {
  const key = font + (bold ? 'b' : '');
  if (baseCache.has(key)) return baseCache.get(key);
  const box = document.createElement('div');
  box.style.cssText = `position:absolute;left:-9999px;top:0;font-family:${cssFamily(font)};font-size:100px;line-height:${LINE_HEIGHT};font-weight:${bold ? 700 : 400};white-space:pre;`;
  const marker = document.createElement('span');
  marker.style.cssText = 'display:inline-block;width:1px;height:0;vertical-align:baseline;';
  box.append('Hg', marker);
  document.body.appendChild(box);
  const ratio = (marker.getBoundingClientRect().top - box.getBoundingClientRect().top) / 100;
  box.remove();
  const val = Number.isFinite(ratio) && ratio > 0 ? ratio : 0.95;
  baseCache.set(key, val);
  return val;
}

const bytesCache = new Map();
export async function fontBytes(font, bold) {
  const f = FONTS.find((x) => x.id === font) || FONTS[0];
  const url = `fonts/${f.file}-${bold ? 700 : 400}.ttf`;
  if (!bytesCache.has(url)) bytesCache.set(url, fetch(url).then((r) => r.arrayBuffer()));
  return bytesCache.get(url);
}

// Render a text element to a transparent PNG (for Word/Excel, where the
// chosen font may not be installed on the reader's computer).
export async function textToPng(el, pxPerUnit = 4) {
  await document.fonts.load(`${el.bold ? 700 : 400} 40px "${el.font}"`);
  const size = el.size * pxPerUnit;
  const lines = el.text.split('\n');
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.ceil(el.w * pxPerUnit));
  c.height = Math.max(1, Math.ceil(el.h * pxPerUnit));
  const g = c.getContext('2d');
  g.fillStyle = el.color;
  g.textBaseline = 'alphabetic';
  g.font = `${el.bold ? 700 : 400} ${size}px ${cssFamily(el.font)}`;
  const base = baselineRatio(el.font, el.bold);
  lines.forEach((line, i) => g.fillText(line, 0, (i * LINE_HEIGHT + base) * size));
  return c.toDataURL('image/png');
}
