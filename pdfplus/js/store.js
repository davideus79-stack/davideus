// Tiny IndexedDB wrapper. Everything stays on this device.
const DB_NAME = 'pdfplus';
const DB_VER = 1;
let dbp;

function db() {
  if (!dbp) {
    dbp = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VER);
      req.onupgradeneeded = () => {
        const d = req.result;
        if (!d.objectStoreNames.contains('kv')) d.createObjectStore('kv');
        if (!d.objectStoreNames.contains('docs')) d.createObjectStore('docs', { keyPath: 'id' });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbp;
}

async function tx(store, mode, fn) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const t = d.transaction(store, mode);
    const s = t.objectStore(store);
    const r = fn(s);
    t.oncomplete = () => resolve(r && 'result' in r ? r.result : undefined);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

export const kv = {
  get: (k) => tx('kv', 'readonly', (s) => s.get(k)),
  set: (k, v) => tx('kv', 'readwrite', (s) => s.put(v, k)),
  del: (k) => tx('kv', 'readwrite', (s) => s.delete(k)),
};

export const docs = {
  all: () => tx('docs', 'readonly', (s) => s.getAll()),
  get: (id) => tx('docs', 'readonly', (s) => s.get(id)),
  put: (doc) => tx('docs', 'readwrite', (s) => s.put(doc)),
  del: (id) => tx('docs', 'readwrite', (s) => s.delete(id)),
};

// Ask the browser not to evict our data (signature, recent docs).
export async function persist() {
  try { if (navigator.storage && navigator.storage.persist) await navigator.storage.persist(); } catch {}
}
