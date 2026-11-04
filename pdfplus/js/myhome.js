// Collegamento con MyHome: stesso account, stessi file.
// Pdf plus vive dentro MyHome (cartella pdfplus/), quindi usa lo stesso accesso.

const cfg = window.MYHOME_CONFIG;
let sb = null;
try {
  if (cfg && window.supabase) {
    sb = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseKey, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
    });
  }
} catch (e) { sb = null; }

const UA = navigator.userAgent;
const DEVICE = /iPhone/.test(UA) ? 'iPhone'
  : /iPad/.test(UA) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1) ? 'iPad'
  : /Android/.test(UA) ? 'telefono' : 'PC';

// Chi è entrato in MyHome su questo dispositivo (null se nessuno)
export async function myhomeUser() {
  if (!sb) return null;
  try {
    const { data } = await sb.auth.getSession();
    return data && data.session ? data.session.user : null;
  } catch (e) { return null; }
}

// Mette il file firmato in MyHome (nella stessa cartella del file di partenza, se c'era)
export async function saveToMyHome(blob, filename, folderId) {
  const user = await myhomeUser();
  if (!user) throw new Error('Entra prima in MyHome');
  if (cfg.maxFileBytes && blob.size > cfg.maxFileBytes) throw new Error('File troppo grande per MyHome (massimo 50 MB)');
  const ext = filename.includes('.') ? '.' + filename.split('.').pop().toLowerCase().replace(/[^a-z0-9]/g, '') : '';
  const path = `${user.id}/${crypto.randomUUID()}${ext}`;
  const type = blob.type || 'application/octet-stream';
  const up = await sb.storage.from('files').upload(path, blob, { contentType: type, upsert: false });
  if (up.error) throw up.error;
  const { error } = await sb.from('items').insert({
    kind: 'file', file_path: path, file_name: filename, mime_type: type,
    size_bytes: blob.size, source: DEVICE, folder_id: folderId || null,
  });
  if (error) { await sb.storage.from('files').remove([path]); throw error; }
}

// Tornando a MyHome non serve rifare il Face ID, a meno che tu sia uscito dall'app per più di 10 secondi.
const FLAG = 'myhome-pdfplus';
let hiddenAt = 0;
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') hiddenAt = Date.now();
  else if (hiddenAt && Date.now() - hiddenAt > 10000) { try { sessionStorage.removeItem(FLAG); } catch (e) {} }
});

export function backToMyHome() {
  const root = new URL('../', location.href).href;
  if (history.length > 1 && document.referrer && document.referrer.startsWith(root) && !document.referrer.includes('/pdfplus/')) {
    history.back();
  } else {
    location.href = root;
  }
}
