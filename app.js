(() => {
  "use strict";

  const cfg = window.MYHOME_CONFIG;
  const sb = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseKey, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
  });
  const BUCKET = "files";

  // Da quale dispositivo arriva ogni nota o file (si vede sulle schede).
  const UA = navigator.userAgent;
  const DEVICE = /iPhone/.test(UA) ? "iPhone" : /iPad/.test(UA) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1) ? "iPad" : /Android/.test(UA) ? "telefono" : "PC";
  const IS_MOBILE = DEVICE !== "PC";
  // Sul telefono: il tasto "Salva" apre il menu dell'iPhone (Salva immagine, Salva su File, Apri in Word…)
  let CAN_SHARE_FILES = false;
  try { CAN_SHARE_FILES = IS_MOBILE && !!navigator.canShare && navigator.canShare({ files: [new File(["x"], "x.txt", { type: "text/plain" })] }); } catch (e) {}

  const $ = (id) => document.getElementById(id);
  const state = { folders: [], folder: null, blobs: new Map(), user: null, items: [], filter: "all", channel: null, urls: new Map(), editing: null, signup: false };

  // ---------- Utilità ----------
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  function toast(msg) {
    const t = $("toast");
    t.textContent = msg;
    t.classList.add("show");
    clearTimeout(toast._t);
    toast._t = setTimeout(() => t.classList.remove("show"), msg.length > 60 ? 6000 : 2600);
  }

  function fmtSize(b) {
    if (!b && b !== 0) return "";
    if (b < 1024) return b + " B";
    if (b < 1024 * 1024) return (b / 1024).toFixed(0) + " KB";
    return (b / 1024 / 1024).toFixed(1).replace(".", ",") + " MB";
  }

  function fmtDate(iso) {
    const d = new Date(iso);
    const now = new Date();
    const diff = (now - d) / 1000;
    if (diff < 60) return "adesso";
    if (diff < 3600) return Math.floor(diff / 60) + " min fa";
    const sameDay = d.toDateString() === now.toDateString();
    const time = d.toLocaleTimeString("it-IT", { hour: "2-digit", minute: "2-digit" });
    if (sameDay) return "oggi, " + time;
    const y = new Date(now); y.setDate(now.getDate() - 1);
    if (d.toDateString() === y.toDateString()) return "ieri, " + time;
    return d.toLocaleDateString("it-IT", { day: "numeric", month: "short", year: d.getFullYear() === now.getFullYear() ? undefined : "numeric" }) + ", " + time;
  }

  function category(item) {
    if (item.kind === "note") return "note";
    const m = item.mime_type || "";
    if (m.startsWith("image/") || m.startsWith("video/")) return "media";
    return "doc";
  }

  function fileStyle(item) {
    const name = (item.file_name || "").toLowerCase();
    const ext = name.includes(".") ? name.split(".").pop() : "";
    const m = item.mime_type || "";
    if (m === "application/pdf" || ext === "pdf") return { label: "PDF", color: "#ef4444" };
    if (["doc", "docx", "odt", "rtf", "pages"].includes(ext)) return { label: "WORD", color: "#2563eb" };
    if (["xls", "xlsx", "csv", "ods", "numbers"].includes(ext)) return { label: "EXCEL", color: "#16a34a" };
    if (["ppt", "pptx", "key", "odp"].includes(ext)) return { label: "PPT", color: "#ea580c" };
    if (["zip", "rar", "7z"].includes(ext)) return { label: "ZIP", color: "#64748b" };
    if (m.startsWith("audio/")) return { label: "AUDIO", color: "#db2777" };
    if (m.startsWith("text/") || ext === "txt") return { label: "TXT", color: "#475569" };
    return { label: (ext || "FILE").slice(0, 5).toUpperCase(), color: "#7c3aed" };
  }

  // Colori dei riquadri per lo stile "Vivace"
  const TILE = ["#3b7ff5", "#f39a1f", "#34b36a", "#8b5cf6", "#ef4444", "#f97316"];
  function tileColor(item) {
    if (item.kind === "file" && category(item) === "doc") return fileStyle(item).color;
    let h = 0;
    for (const c of item.id) h = (h * 31 + c.charCodeAt(0)) >>> 0;
    return TILE[h % TILE.length];
  }

  const ICONS = {
    open: '<svg viewBox="0 0 24 24"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/></svg>',
    down: '<svg viewBox="0 0 24 24"><path d="M12 4v12m0 0-4.5-4.5M12 16l4.5-4.5M4 20h16"/></svg>',
    copy: '<svg viewBox="0 0 24 24"><rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/></svg>',
    edit: '<svg viewBox="0 0 24 24"><path d="M4 20h4L19 9l-4-4L4 16v4Z"/></svg>',
    save: '<svg viewBox="0 0 24 24"><path d="m5 12 5 5L20 7"/></svg>',
    del: '<svg viewBox="0 0 24 24"><path d="M4 7h16M10 11v6m4-6v6M6 7l1 13h10l1-13M9 7V4h6v3"/></svg>',
    share: '<svg viewBox="0 0 24 24"><path d="M12 3v12m0-12L8 7m4-4 4 4M5 12v7a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-7"/></svg>',
    folder: '<svg viewBox="0 0 24 24"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z"/></svg>',
    plus: '<svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>',
    back: '<svg viewBox="0 0 24 24"><path d="M15 18l-6-6 6-6"/></svg>',
    play: '<svg viewBox="0 0 24 24"><path d="M7 4v16l13-8Z"/></svg>',
  };

  // ---------- Link temporanei ai file ----------
  async function signedUrl(path, download) {
    const key = path + (download ? "|d" : "");
    const hit = state.urls.get(key);
    if (hit && hit.exp > Date.now()) return hit.url;
    const opts = download ? { download: typeof download === "string" ? download : true } : undefined;
    const { data, error } = await sb.storage.from(BUCKET).createSignedUrl(path, 3600, opts);
    if (error) throw error;
    state.urls.set(key, { url: data.signedUrl, exp: Date.now() + 50 * 60 * 1000 });
    return data.signedUrl;
  }

  async function prefetchThumbs(items) {
    const paths = items
      .filter((i) => i.kind === "file" && category(i) === "media" && !state.urls.has(i.file_path))
      .map((i) => i.file_path);
    if (!paths.length) return;
    const { data } = await sb.storage.from(BUCKET).createSignedUrls(paths, 3600);
    (data || []).forEach((r) => {
      if (r.signedUrl) state.urls.set(r.path, { url: r.signedUrl, exp: Date.now() + 50 * 60 * 1000 });
    });
  }

  // ---------- Accesso ----------
  function setAuthMode(signup) {
    state.signup = signup;
    $("auth-submit").textContent = signup ? "Crea account" : "Entra";
    $("auth-password").autocomplete = signup ? "new-password" : "current-password";
    $("auth-toggle").innerHTML = signup ? "Hai già un account? <b>Entra</b>" : "Non hai un account? <b>Registrati</b>";
    authMsg("");
    if (typeof updateFaceIdUi === "function") updateFaceIdUi();
  }

  function authMsg(text, kind) {
    const el = $("auth-msg");
    el.textContent = text;
    el.className = "auth-msg" + (kind ? " " + kind : "");
  }

  function translateError(err) {
    const m = (err && err.message) || String(err);
    if (/Invalid login credentials/i.test(m)) return "Email o password non corretti.";
    if (/Email not confirmed/i.test(m)) return "Conferma prima la tua email: controlla la posta.";
    if (/already registered/i.test(m)) return "Questa email è già registrata. Prova a entrare.";
    if (/Password should be/i.test(m)) return "La password deve avere almeno 6 caratteri.";
    if (/rate limit/i.test(m)) return "Troppi tentativi, riprova tra qualche minuto.";
    if (/maximum allowed size|Payload too large|exceeded/i.test(m)) return "File troppo grande (massimo 50 MB).";
    if (/Failed to fetch|NetworkError/i.test(m)) return "Nessuna connessione. Riprova.";
    return m;
  }

  $("auth-toggle").addEventListener("click", () => setAuthMode(!state.signup));

  $("auth-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const email = $("auth-email").value.trim();
    const password = $("auth-password").value;
    const btn = $("auth-submit");
    btn.disabled = true;
    authMsg(state.signup ? "Creo il tuo account…" : "Accesso in corso…");
    try {
      if (state.signup) {
        const { data, error } = await sb.auth.signUp({
          email, password,
          options: { emailRedirectTo: location.origin + location.pathname },
        });
        if (error) throw error;
        if (!data.session) {
          authMsg("Fatto! Apri l'email che ti abbiamo mandato per confermare, poi torna qui ed entra.", "ok");
          setTimeout(() => { setAuthMode(false); authMsg("Dopo aver confermato l'email, entra qui.", "ok"); }, 4000);
        }
      } else {
        state.justLoggedIn = true;
        const { error } = await sb.auth.signInWithPassword({ email, password });
        if (error) throw error;
        state.lastPassword = password; // serve solo se attivi subito il Face ID dal menu
      }
    } catch (err) {
      authMsg(translateError(err), "error");
    } finally {
      btn.disabled = false;
    }
  });

  sb.auth.onAuthStateChange((_event, session) => {
    const user = session ? session.user : null;
    if (user && (!state.user || state.user.id !== user.id)) {
      state.user = user;
      showApp();
    } else if (!user && state.user) {
      state.user = null;
      showAuth();
    } else if (!user) {
      showAuth();
    }
  });

  function showAuth() {
    if (state.channel) { sb.removeChannel(state.channel); state.channel = null; }
    state.items = [];
    state.folders = [];
    state.folder = null;
    state.urls.clear();
    $("app").classList.add("hidden");
    $("auth").classList.remove("hidden");
    $("auth-password").value = "";
    authMsg("");
    updateFaceIdUi();
  }

  async function showApp() {
    $("auth").classList.add("hidden");
    $("app").classList.remove("hidden");
    $("menu-user").textContent = state.user.email;
    const t = state.user.user_metadata && state.user.user_metadata.theme;
    if (t) applyTheme(t);
    updateFaceIdUi();
    if (!state.justLoggedIn) showLock(); // appena entrato con la password non serve chiedere anche il Face ID
    else if (lock.supported && !fidGet() && state.lastPassword) openSetup(); // propone subito il Face ID
    state.justLoggedIn = false;
    await loadItems();
    subscribe();
  }

  // ---------- Dati ----------
  async function loadItems() {
    const { data, error } = await sb.from("items").select("*").order("created_at", { ascending: false }).limit(1000);
    if (error) { toast(translateError(error)); return; }
    state.items = data || [];
    const fr = await sb.from("folders").select("*").order("name");
    if (!fr.error) state.folders = fr.data || [];
    if (state.folder && !state.folders.some((f) => f.id === state.folder)) state.folder = null;
    await prefetchThumbs(state.items);
    render();
  }

  function subscribe() {
    if (state.channel) sb.removeChannel(state.channel);
    state.channel = sb
      .channel("items-live")
      .on("postgres_changes", { event: "*", schema: "public", table: "items" }, async (p) => {
        if (p.eventType === "INSERT") {
          if (p.new.user_id !== state.user.id || state.items.some((i) => i.id === p.new.id)) return;
          state.items.unshift(p.new);
          if (p.new.source && p.new.source !== DEVICE) {
            toast(`Arrivato ${fromLabel(p.new.source)}: ${p.new.kind === "note" ? "una nota" : p.new.file_name}`);
            if (navigator.vibrate) navigator.vibrate(30);
          }
          await prefetchThumbs([p.new]);
          render(p.new.id);
        } else if (p.eventType === "UPDATE") {
          if (state.editing === p.new.id) return;
          state.items = state.items.map((i) => (i.id === p.new.id ? p.new : i));
          render();
        } else if (p.eventType === "DELETE") {
          const before = state.items.length;
          state.items = state.items.filter((i) => i.id !== p.old.id);
          if (state.items.length !== before) render();
        }
      })
      .on("postgres_changes", { event: "*", schema: "public", table: "folders" }, (p) => {
        if (p.eventType === "INSERT") {
          if (p.new.user_id !== state.user.id || state.folders.some((f) => f.id === p.new.id)) return;
          state.folders.push(p.new);
        } else if (p.eventType === "UPDATE") {
          state.folders = state.folders.map((f) => (f.id === p.new.id ? p.new : f));
        } else if (p.eventType === "DELETE") {
          state.folders = state.folders.filter((f) => f.id !== p.old.id);
          state.items = state.items.map((i) => (i.folder_id === p.old.id ? { ...i, folder_id: null } : i));
          if (state.folder === p.old.id) state.folder = null;
        }
        sortFolders();
        render();
      })
      .subscribe((status) => {
        const live = document.querySelector(".live");
        const ok = status === "SUBSCRIBED";
        live.classList.toggle("off", !ok);
        $("live-text").textContent = ok ? "Sincronizzato" : "Riconnessione…";
      });
  }

  // Quando torni sull'app (dal telefono in tasca o da un'altra finestra) ricarica subito.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && state.user) { loadItems(); subscribe(); }
  });
  window.addEventListener("online", () => { if (state.user) { loadItems(); subscribe(); } });

  // ---------- Note ----------
  const noteInput = $("note-input");
  noteInput.addEventListener("input", () => {
    $("note-save").disabled = !noteInput.value.trim();
    noteInput.style.height = "auto";
    noteInput.style.height = Math.min(noteInput.scrollHeight, 320) + "px";
  });
  noteInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); saveNote(); }
  });
  $("note-save").addEventListener("click", saveNote);

  async function saveNote() {
    const text = noteInput.value.trim();
    if (!text) return;
    $("note-save").disabled = true;
    const { data, error } = await sb.from("items").insert({ kind: "note", content: text, source: DEVICE, folder_id: state.folder }).select().single();
    if (error) { toast(translateError(error)); $("note-save").disabled = false; return; }
    noteInput.value = "";
    noteInput.style.height = "auto";
    if (!state.items.some((i) => i.id === data.id)) state.items.unshift(data);
    render(data.id);
    toast("Nota salvata");
  }

  // ---------- File ----------
  $("file-input").addEventListener("change", (e) => {
    uploadFiles([...e.target.files]);
    e.target.value = "";
  });

  async function uploadFiles(files) {
    for (const file of files) await uploadOne(file);
  }

  async function uploadOne(file) {
    if (file.size > cfg.maxFileBytes) {
      toast(`"${file.name}" è troppo grande (massimo 50 MB).`);
      return;
    }
    const row = document.createElement("div");
    row.className = "upload-row";
    row.innerHTML = `<div class="spinner"></div><div class="name">${esc(file.name)}</div><div class="muted">${fmtSize(file.size)}</div>`;
    $("uploads").appendChild(row);
    try {
      const ext = file.name.includes(".") ? "." + file.name.split(".").pop().toLowerCase().replace(/[^a-z0-9]/g, "") : "";
      const path = `${state.user.id}/${crypto.randomUUID()}${ext}`;
      const { error: upErr } = await sb.storage.from(BUCKET).upload(path, file, {
        contentType: file.type || "application/octet-stream",
        upsert: false,
      });
      if (upErr) throw upErr;
      const { data, error } = await sb
        .from("items")
        .insert({ kind: "file", file_path: path, file_name: file.name, mime_type: file.type || null, size_bytes: file.size, source: DEVICE, folder_id: state.folder })
        .select()
        .single();
      if (error) { await sb.storage.from(BUCKET).remove([path]); throw error; }
      if (!state.items.some((i) => i.id === data.id)) state.items.unshift(data);
      await prefetchThumbs([data]);
      render(data.id);
      toast("Caricato: " + file.name);
    } catch (err) {
      toast(translateError(err));
    } finally {
      row.remove();
    }
  }

  // Trascina e rilascia (dal PC)
  let dragDepth = 0;
  window.addEventListener("dragenter", (e) => {
    if (!state.user || !e.dataTransfer || ![...e.dataTransfer.types].includes("Files")) return;
    dragDepth++; $("dropzone").classList.remove("hidden");
  });
  window.addEventListener("dragleave", () => { dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) $("dropzone").classList.add("hidden"); });
  window.addEventListener("dragover", (e) => e.preventDefault());
  window.addEventListener("drop", (e) => {
    e.preventDefault(); dragDepth = 0; $("dropzone").classList.add("hidden");
    if (state.user && e.dataTransfer.files.length) uploadFiles([...e.dataTransfer.files]);
  });

  // Incolla un'immagine o un file (Ctrl+V sul PC)
  window.addEventListener("paste", (e) => {
    if (!state.user) return;
    const files = [...(e.clipboardData?.files || [])];
    if (files.length) { e.preventDefault(); uploadFiles(files); }
  });

  // ---------- Elenco ----------
  document.querySelectorAll(".tab").forEach((t) =>
    t.addEventListener("click", () => {
      document.querySelectorAll(".tab").forEach((x) => x.classList.remove("active"));
      t.classList.add("active");
      state.filter = t.dataset.filter;
      render();
    })
  );

  function render(freshId) {
    renderFolders();
    const list = $("list");
    const items = state.items.filter((i) =>
      (state.filter === "all" || category(i) === state.filter) && (!state.folder || i.folder_id === state.folder));
    $("empty").classList.toggle("hidden", items.length > 0);
    $("empty-folder").classList.toggle("hidden", !state.folder);
    list.innerHTML = items.map((i) => cardHtml(i, i.id === freshId)).join("");
  }

  function fromLabel(src) { return src === "PC" ? "dal PC" : src === "iPhone" ? "dall'iPhone" : src === "iPad" ? "dall'iPad" : "dal " + src; }

  function cardHtml(item, fresh) {
    const fold = !state.folder && item.folder_id && state.folders.find((f) => f.id === item.folder_id);
    const meta = fmtDate(item.created_at) + (item.source ? ` · <span class="src">${esc(fromLabel(item.source))}</span>` : "")
      + (fold ? ` · <span class="in-folder" style="--fc:${fold.color || "#6366f1"}">${ICONS.folder}${esc(fold.name)}</span>` : "");
    if (item.kind === "note") {
      const editing = state.editing === item.id;
      return `<article class="card${fresh ? " fresh" : ""}" data-id="${item.id}" data-cat="note" style="--tile:${tileColor(item)}">
        <div class="card-body">
          <p class="note-text" ${editing ? 'contenteditable="true"' : ""}>${esc(item.content)}</p>
          <div class="meta">${meta}</div>
        </div>
        <div class="card-actions">
          <button class="act" data-act="copy">${ICONS.copy}Copia</button>
          <button class="act" data-act="${editing ? "save" : "edit"}">${editing ? ICONS.save + "Fatto" : ICONS.edit + "Modifica"}</button>
          <button class="act icon" data-act="move" aria-label="Sposta in una cartella" title="Sposta in una cartella">${ICONS.folder}</button>
          <button class="act del" data-act="delete" aria-label="Cancella">${ICONS.del}</button>
        </div>
      </article>`;
    }
    const cat = category(item);
    const url = state.urls.get(item.file_path)?.url;
    let thumb;
    if (cat === "media" && url && (item.mime_type || "").startsWith("image/")) {
      thumb = `<img src="${esc(url)}" alt="" loading="lazy">`;
    } else if (cat === "media" && url) {
      thumb = `<video src="${esc(url)}#t=0.5" muted playsinline preload="metadata"></video><span class="play">${ICONS.play}</span>`;
    } else {
      const s = fileStyle(item);
      thumb = `<div class="file-badge" style="background:${s.color}">${s.label}</div>`;
    }
    const canView = cat === "media" || item.mime_type === "application/pdf";
    return `<article class="card${fresh ? " fresh" : ""}" data-id="${item.id}" data-cat="${cat}" style="--tile:${tileColor(item)}">
      <div class="card-thumb${url && cat === "media" ? "" : " doc"}" data-act="${canView ? "view" : "download"}">${thumb}</div>
      <div class="card-body">
        <div class="file-name">${esc(item.file_name)}</div>
        <div class="meta">${fmtSize(item.size_bytes)} · ${meta}</div>
      </div>
      <div class="card-actions">
        ${canView ? `<button class="act" data-act="view">${ICONS.open}Apri</button>` : ""}
        ${CAN_SHARE_FILES
          ? `<button class="act" data-act="share">${ICONS.share}${state.blobs.has(item.id) ? "Tocca per salvare" : "Salva"}</button>`
          : `<button class="act" data-act="download">${ICONS.down}Scarica</button>`}
        <button class="act icon" data-act="move" aria-label="Sposta in una cartella" title="Sposta in una cartella">${ICONS.folder}</button>
        <button class="act del" data-act="delete" aria-label="Cancella">${ICONS.del}</button>
      </div>
    </article>`;
  }

  $("list").addEventListener("click", async (e) => {
    const btn = e.target.closest("[data-act]");
    if (!btn) return;
    const card = btn.closest(".card");
    const item = state.items.find((i) => i.id === card.dataset.id);
    if (!item) return;
    const act = btn.dataset.act;
    try {
      if (act === "copy") {
        await navigator.clipboard.writeText(item.content || "");
        toast("Copiato");
      } else if (act === "edit") {
        state.editing = item.id;
        render();
        const p = document.querySelector(`.card[data-id="${item.id}"] .note-text`);
        p.focus();
        document.getSelection().selectAllChildren(p);
        document.getSelection().collapseToEnd();
      } else if (act === "save") {
        const p = card.querySelector(".note-text");
        const text = p.innerText.trim();
        state.editing = null;
        if (text && text !== item.content) {
          const { data, error } = await sb.from("items").update({ content: text }).eq("id", item.id).select().single();
          if (error) throw error;
          state.items = state.items.map((i) => (i.id === item.id ? data : i));
          toast("Nota aggiornata");
        }
        render();
      } else if (act === "view") {
        openViewer(item);
      } else if (act === "move") {
        openMove(item);
      } else if (act === "share") {
        await shareFile(item, btn);
      } else if (act === "download") {
        const url = await signedUrl(item.file_path, item.file_name);
        const a = document.createElement("a");
        a.href = url; a.download = item.file_name; a.rel = "noopener";
        document.body.appendChild(a); a.click(); a.remove();
      } else if (act === "delete") {
        const what = item.kind === "note" ? "questa nota" : `"${item.file_name}"`;
        if (!confirm(`Vuoi cancellare ${what}? Non si potrà recuperare.`)) return;
        await deleteItems([item]);
        toast("Cancellato");
      }
    } catch (err) {
      toast(translateError(err));
    }
  });

  // ---------- Cartelle ----------
  const FOLDER_COLORS = ["#3b82f6", "#f59e0b", "#10b981", "#8b5cf6", "#ef4444", "#ec4899", "#14b8a6", "#64748b"];
  const sortFolders = () => state.folders.sort((a, b) => a.name.localeCompare(b.name, "it", { sensitivity: "base" }));

  function renderFolders() {
    const cur = state.folders.find((f) => f.id === state.folder);
    $("note-input").placeholder = cur ? `Scrivi una nota in "${cur.name}"…` : "Scrivi una nota…";
    $("folder-bar").classList.toggle("hidden", !!cur);
    $("folder-head").classList.toggle("hidden", !cur);
    if (cur) {
      $("folder-title").textContent = cur.name;
      $("folder-head").style.setProperty("--fc", cur.color || "#6366f1");
      $("folder-count").textContent = countLabel(state.items.filter((i) => i.folder_id === cur.id).length);
      return;
    }
    $("folder-bar").innerHTML = state.folders.map((f) => {
      const n = state.items.filter((i) => i.folder_id === f.id).length;
      return `<button class="folder-chip" data-folder="${f.id}" style="--fc:${f.color || "#6366f1"}">
        <span class="fico">${ICONS.folder}</span><span class="fname">${esc(f.name)}</span><span class="fnum">${n}</span></button>`;
    }).join("") + `<button class="folder-chip add" data-folder-new="1"><span class="fico">${ICONS.plus}</span><span class="fname">Nuova cartella</span></button>`;
  }
  const countLabel = (n) => (n === 1 ? "1 elemento" : n + " elementi");

  $("folder-bar").addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    if (b.dataset.folderNew) return openFolderName(null);
    state.folder = b.dataset.folder;
    render();
    window.scrollTo({ top: 0, behavior: "smooth" });
  });
  $("folder-back").addEventListener("click", () => { state.folder = null; render(); });
  $("folder-rename").addEventListener("click", () => openFolderName(state.folders.find((f) => f.id === state.folder)));
  $("folder-delete").addEventListener("click", async () => {
    const f = state.folders.find((x) => x.id === state.folder);
    if (!f) return;
    if (!confirm(`Vuoi eliminare la cartella "${f.name}"? Il suo contenuto non viene cancellato: torna in "Tutte".`)) return;
    const { error } = await sb.from("folders").delete().eq("id", f.id);
    if (error) return toast(translateError(error));
    state.folders = state.folders.filter((x) => x.id !== f.id);
    state.items = state.items.map((i) => (i.folder_id === f.id ? { ...i, folder_id: null } : i));
    state.folder = null;
    render();
    toast("Cartella eliminata");
  });

  // Finestra per creare o rinominare una cartella
  let editingFolder = null;
  function openFolderName(folder) {
    editingFolder = folder;
    $("fn-title").textContent = folder ? "Rinomina cartella" : "Nuova cartella";
    $("fn-save").textContent = folder ? "Salva" : "Crea";
    $("fn-input").value = folder ? folder.name : "";
    const color = (folder && folder.color) || FOLDER_COLORS[state.folders.length % FOLDER_COLORS.length];
    $("fn-colors").innerHTML = FOLDER_COLORS.map((c) =>
      `<button type="button" class="fn-color${c === color ? " on" : ""}" data-color="${c}" style="--fc:${c}" aria-label="Colore"></button>`).join("");
    $("fn-dlg").showModal();
    setTimeout(() => $("fn-input").focus(), 50);
  }
  $("fn-colors").addEventListener("click", (e) => {
    const b = e.target.closest("[data-color]");
    if (!b) return;
    $("fn-colors").querySelectorAll(".fn-color").forEach((x) => x.classList.toggle("on", x === b));
  });
  $("fn-cancel").addEventListener("click", () => $("fn-dlg").close());
  $("fn-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const name = $("fn-input").value.trim().slice(0, 60);
    if (!name) return;
    const color = ($("fn-colors").querySelector(".on") || {}).dataset?.color || FOLDER_COLORS[0];
    if (editingFolder) {
      const { data, error } = await sb.from("folders").update({ name, color }).eq("id", editingFolder.id).select().single();
      if (error) return toast(translateError(error));
      state.folders = state.folders.map((f) => (f.id === data.id ? data : f));
    } else {
      const { data, error } = await sb.from("folders").insert({ name, color }).select().single();
      if (error) return toast(translateError(error));
      if (!state.folders.some((f) => f.id === data.id)) state.folders.push(data);
      state.folder = data.id; // entra subito nella cartella nuova
      if (state.moving) { await moveTo(state.moving, data.id); state.moving = null; }
    }
    sortFolders();
    $("fn-dlg").close();
    render();
  });

  // Finestra "Sposta in…"
  function openMove(item) {
    state.moving = item;
    const opts = [{ id: "", name: "Nessuna cartella", color: "#94a3b8" }, ...state.folders];
    $("mv-list").innerHTML = opts.map((f) => `<button type="button" class="mv-opt${(item.folder_id || "") === f.id ? " on" : ""}" data-to="${f.id}" style="--fc:${f.color || "#6366f1"}">
      <span class="fico">${ICONS.folder}</span><span>${esc(f.name)}</span></button>`).join("")
      + `<button type="button" class="mv-opt add" data-to-new="1"><span class="fico">${ICONS.plus}</span><span>Nuova cartella…</span></button>`;
    $("mv-dlg").showModal();
  }
  $("mv-cancel").addEventListener("click", () => { state.moving = null; $("mv-dlg").close(); });
  $("mv-list").addEventListener("click", async (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    $("mv-dlg").close();
    if (b.dataset.toNew) return openFolderName(null); // dopo la creazione l'elemento viene spostato lì
    await moveTo(state.moving, b.dataset.to || null);
    state.moving = null;
  });
  async function moveTo(item, folderId) {
    const { data, error } = await sb.from("items").update({ folder_id: folderId }).eq("id", item.id).select().single();
    if (error) return toast(translateError(error));
    state.items = state.items.map((i) => (i.id === item.id ? data : i));
    render();
    const f = state.folders.find((x) => x.id === folderId);
    toast(f ? `Spostato in "${f.name}"` : "Tolto dalla cartella");
  }

  // Prepara il file e apre il menu Condividi dell'iPhone, da cui si salva in Foto o in File.
  async function shareFile(item, btn) {
    let file = state.blobs.get(item.id);
    if (!file) {
      btn.innerHTML = '<span class="spinner"></span>Preparo…';
      const res = await fetch(await signedUrl(item.file_path));
      if (!res.ok) throw new Error("download");
      const blob = await res.blob();
      file = new File([blob], item.file_name, { type: item.mime_type || blob.type || "application/octet-stream" });
      state.blobs.set(item.id, file);
    }
    try {
      await navigator.share({ files: [file] });
      btn.innerHTML = ICONS.share + "Salva";
    } catch (e) {
      if (e && e.name === "NotAllowedError") {
        // L'iPhone vuole un secondo tocco dopo aver scaricato il file.
        btn.innerHTML = ICONS.share + "Tocca per salvare";
        toast("Pronto! Tocca di nuovo per salvarlo sull'iPhone");
      } else if (!e || e.name !== "AbortError") {
        btn.innerHTML = ICONS.share + "Salva";
        throw e;
      } else {
        btn.innerHTML = ICONS.share + "Salva";
      }
    }
  }

  async function deleteItems(items) {
    const paths = items.filter((i) => i.file_path).map((i) => i.file_path);
    for (let k = 0; k < paths.length; k += 100) {
      const { error } = await sb.storage.from(BUCKET).remove(paths.slice(k, k + 100));
      if (error) throw error;
    }
    const ids = items.map((i) => i.id);
    for (let k = 0; k < ids.length; k += 200) {
      const { error } = await sb.from("items").delete().in("id", ids.slice(k, k + 200));
      if (error) throw error;
    }
    const gone = new Set(ids);
    state.items = state.items.filter((i) => !gone.has(i.id));
    render();
  }

  // ---------- Visualizzatore ----------
  async function openViewer(item) {
    const dlg = $("viewer");
    const body = $("viewer-body");
    $("viewer-title").textContent = item.file_name;
    body.innerHTML = '<div class="spinner"></div>';
    dlg.showModal();
    const [url, dl] = await Promise.all([signedUrl(item.file_path), signedUrl(item.file_path, item.file_name)]);
    $("viewer-download").href = dl;
    const m = item.mime_type || "";
    if (m.startsWith("image/")) body.innerHTML = `<img src="${esc(url)}" alt="">`;
    else if (m.startsWith("video/")) body.innerHTML = `<video src="${esc(url)}" controls autoplay playsinline></video>`;
    else body.innerHTML = `<iframe src="${esc(url)}" title="${esc(item.file_name)}"></iframe>`;
  }
  $("viewer-close").addEventListener("click", () => $("viewer").close());
  $("viewer").addEventListener("close", () => { $("viewer-body").innerHTML = ""; });

  // ---------- Menu ----------
  $("menu-btn").addEventListener("click", (e) => { e.stopPropagation(); $("menu").classList.toggle("hidden"); });
  document.addEventListener("click", (e) => { if (!e.target.closest("#menu")) $("menu").classList.add("hidden"); });
  $("logout").addEventListener("click", async () => { $("menu").classList.add("hidden"); await sb.auth.signOut(); });
  $("delete-all").addEventListener("click", async () => {
    $("menu").classList.add("hidden");
    if (!state.items.length) { toast("Non c'è niente da cancellare"); return; }
    if (!confirm(`Vuoi cancellare TUTTO (${state.items.length} elementi)? Non si potrà recuperare.`)) return;
    try { await deleteItems(state.items.slice()); toast("Tutto cancellato"); }
    catch (err) { toast(translateError(err)); }
  });

  // ---------- Stile grafico ----------
  const THEMES = ["aurora", "notte", "carta", "tramonto", "oceano", "vivace", "pastello", "pop", "oro"];
  const THEME_COLORS = { aurora: "#6366f1", notte: "#05060a", carta: "#f6f1e7", tramonto: "#fb7185", oceano: "#0ea5e9", vivace: "#3b7ff5", pastello: "#fbf7f4", pop: "#fff6e0", oro: "#0e0d0b" };

  function applyTheme(name) {
    if (!THEMES.includes(name)) name = "aurora";
    if (name === "aurora") delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = name;
    document.querySelector('meta[name="theme-color"]').setAttribute("content", THEME_COLORS[name]);
    document.querySelectorAll("[data-theme-pick]").forEach((b) => b.classList.toggle("active", b.dataset.themePick === name));
    try { localStorage.setItem("myhome-theme", name); } catch (e) {}
  }

  document.querySelectorAll("[data-theme-pick]").forEach((b) =>
    b.addEventListener("click", async (e) => {
      e.stopPropagation();
      const name = b.dataset.themePick;
      applyTheme(name);
      // Ricorda lo stile sul tuo account, così è uguale su telefono e PC.
      if (state.user) sb.auth.updateUser({ data: { theme: name } }).catch(() => {});
    })
  );

  let savedTheme = "aurora";
  try { savedTheme = localStorage.getItem("myhome-theme") || "aurora"; } catch (e) {}
  applyTheme(savedTheme);

  // ---------- Face ID ----------
  // Con il Face ID (o l'impronta / Windows Hello sul PC) si entra senza scrivere la password
  // e l'app si blocca quando non la usi. La password viene cifrata con una chiave che solo
  // il Face ID di questo dispositivo può sbloccare, e non lascia mai il dispositivo.
  const FID_KEY = "myhome-faceid";
  const lock = { supported: false, hiddenAt: 0, open: false, pendingCred: null };
  const LOCK_AFTER_MS = 10 * 1000; // si blocca ogni volta che esci dall'app (dopo 10 secondi)
  const enc = new TextEncoder(), dec = new TextDecoder();
  const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const unb64 = (str) => Uint8Array.from(atob(str.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
  const isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  const bioName = isIOS ? "Face ID" : "impronta / Windows Hello";
  const bioShort = isIOS ? "Face ID" : "impronta";

  function fidGet() { try { return JSON.parse(localStorage.getItem(FID_KEY) || "null"); } catch (e) { return null; } }
  function fidSet(v) { try { v ? localStorage.setItem(FID_KEY, JSON.stringify(v)) : localStorage.removeItem(FID_KEY); } catch (e) {} }
  try { Object.keys(localStorage).filter((k) => k.startsWith("myhome-lock-")).forEach((k) => localStorage.removeItem(k)); } catch (e) {}

  async function checkLockSupport() {
    try {
      lock.supported = !!(window.PublicKeyCredential && (await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable()));
    } catch (e) { lock.supported = false; }
    updateFaceIdUi();
  }

  function updateFaceIdUi() {
    const f = fidGet();
    const btn = $("lock-toggle");
    btn.classList.toggle("hidden", !lock.supported || !state.user);
    btn.textContent = f ? `Disattiva ${bioName}` : `Attiva ${bioName}`;
    $("lock-unlock").querySelector("span").textContent = `Sblocca con ${bioShort}`;
    const loginBtn = $("auth-faceid");
    const canLogin = lock.supported && f && f.ct && !state.signup;
    loginBtn.classList.toggle("hidden", !canLogin);
    $("auth-submit").classList.toggle("primary", !canLogin);
    $("auth-submit").classList.toggle("soft", !!canLogin);
    $("auth-submit").textContent = state.signup ? "Crea account" : canLogin ? "Entra con la password" : "Entra";
    if (canLogin) loginBtn.querySelector("span").textContent = `Entra con ${bioShort}`;
  }

  async function createCred() {
    const cred = await navigator.credentials.create({
      publicKey: {
        challenge: crypto.getRandomValues(new Uint8Array(32)),
        rp: { name: "MyHome", id: location.hostname },
        user: { id: crypto.getRandomValues(new Uint8Array(16)), name: state.user.email, displayName: "MyHome · " + state.user.email },
        pubKeyCredParams: [{ type: "public-key", alg: -7 }, { type: "public-key", alg: -257 }],
        authenticatorSelection: { authenticatorAttachment: "platform", userVerification: "required", residentKey: "preferred" },
        extensions: { prf: {} },
        timeout: 60000,
      },
    });
    const ext = cred.getClientExtensionResults ? cred.getClientExtensionResults() : {};
    return { id: b64(cred.rawId), prf: !!(ext.prf && ext.prf.enabled) };
  }

  // Chiede il Face ID; se il dispositivo lo permette restituisce anche una chiave segreta.
  async function faceIdCheck(credId, salt) {
    const opts = {
      challenge: crypto.getRandomValues(new Uint8Array(32)),
      rpId: location.hostname,
      allowCredentials: [{ type: "public-key", id: unb64(credId), transports: ["internal", "hybrid"] }],
      userVerification: "required",
      timeout: 60000,
    };
    if (salt) opts.extensions = { prf: { eval: { first: unb64(salt) } } };
    const res = await navigator.credentials.get({ publicKey: opts });
    const ext = res.getClientExtensionResults ? res.getClientExtensionResults() : {};
    const first = ext.prf && ext.prf.results && ext.prf.results.first;
    if (!first) return null;
    return crypto.subtle.importKey("raw", new Uint8Array(first).slice(0, 32), "AES-GCM", false, ["encrypt", "decrypt"]);
  }

  // ----- Attivazione (dal menu) -----
  function openSetup() {
    lock.pendingCred = null;
    $("fid-password").value = state.lastPassword || "";
    $("fid-msg").textContent = "";
    $("fid-msg").className = "auth-msg";
    $("fid-go").querySelector("span").textContent = `Attiva ${bioShort}`;
    $("fid-title").textContent = `Entra con ${bioShort}`;
    $("fid-dlg").showModal();
    if (!state.lastPassword) setTimeout(() => $("fid-password").focus(), 50);
  }

  function setupMsg(t, kind) { const el = $("fid-msg"); el.textContent = t; el.className = "auth-msg" + (kind ? " " + kind : ""); }

  $("fid-cancel").addEventListener("click", () => $("fid-dlg").close());
  $("fid-go").addEventListener("click", async () => {
    const pw = $("fid-password").value;
    if (pw.length < 6) { setupMsg("Scrivi la password con cui sei entrato.", "error"); return; }
    try {
      // Primo tocco: l'iPhone crea la chiave Face ID per questa app.
      if (!lock.pendingCred) {
        lock.pendingCred = await createCred();
        lock.pendingCred.salt = b64(crypto.getRandomValues(new Uint8Array(32)));
        $("fid-go").querySelector("span").textContent = `Conferma con ${bioShort}`;
        setupMsg(`Ancora un tocco per confermare con ${bioShort}.`, "ok");
        return;
      }
      // Secondo tocco: Face ID, poi cifro la password con la chiave che ne esce.
      const c = lock.pendingCred;
      const key = await faceIdCheck(c.id, c.salt);
      setupMsg("Controllo la password…");
      const { error } = await sb.auth.signInWithPassword({ email: state.user.email, password: pw });
      if (error) { setupMsg("La password non è corretta. Riprova.", "error"); return; }
      const rec = { credId: c.id, salt: c.salt, email: state.user.email };
      if (key) {
        const iv = crypto.getRandomValues(new Uint8Array(12));
        rec.iv = b64(iv);
        rec.ct = b64(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, enc.encode(pw)));
      }
      fidSet(rec);
      state.lastPassword = null;
      $("fid-dlg").close();
      toast(key ? `Fatto! D'ora in poi entri con ${bioShort}` : `Fatto! L'app si apre con ${bioShort}`);
    } catch (e) {
      lock.pendingCred = null;
      $("fid-go").querySelector("span").textContent = `Attiva ${bioShort}`;
      setupMsg(e && e.name === "NotAllowedError"
        ? (isIOS ? "Annullato. Se si ripete, controlla che il Portachiavi iCloud sia attivo (Impostazioni › il tuo nome › iCloud › Password)." : "Annullato. Riprova.")
        : "Non riesco ad attivarlo qui (" + ((e && e.name) || "errore") + ").", "error");
    }
    updateFaceIdUi();
  });

  $("lock-toggle").addEventListener("click", () => {
    $("menu").classList.add("hidden");
    if (fidGet()) { fidSet(null); toast(`${bioName} disattivato`); updateFaceIdUi(); }
    else openSetup();
  });

  // ----- Accesso con Face ID dalla schermata di login -----
  $("auth-faceid").addEventListener("click", async () => {
    const f = fidGet();
    if (!f) return;
    try {
      const key = await faceIdCheck(f.credId, f.salt);
      if (!key) throw new Error("nokey");
      authMsg("Accesso in corso…");
      const pw = dec.decode(await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(f.iv) }, key, unb64(f.ct)));
      state.justLoggedIn = true;
      const { error } = await sb.auth.signInWithPassword({ email: f.email, password: pw });
      if (error) {
        if (/Invalid login/i.test(error.message)) { fidSet(null); updateFaceIdUi(); authMsg("La password è cambiata: entra con la password e riattiva il Face ID dal menu.", "error"); }
        else authMsg(translateError(error), "error");
      }
    } catch (e) {
      authMsg(e && e.name === "NotAllowedError" ? "Annullato. Riprova o usa la password." : "Accesso con Face ID non riuscito. Usa la password.", "error");
    }
  });

  // ----- Blocco quando riapri l'app -----
  function showLock() {
    const f = fidGet();
    if (!f || lock.open) return; // se il Face ID è stato attivato, il dispositivo lo supporta
    lock.open = true;
    $("lock-msg").textContent = "";
    $("lock").classList.remove("hidden");
    tryUnlock(true);
  }

  async function tryUnlock(auto) {
    const f = fidGet();
    try {
      await faceIdCheck(f.credId, null);
      lock.open = false;
      $("lock").classList.add("hidden");
    } catch (e) {
      if (!auto) { const el = $("lock-msg"); el.className = "auth-msg error"; el.textContent = "Non riconosciuto. Riprova."; }
    }
  }

  $("lock-unlock").addEventListener("click", () => tryUnlock(false));
  $("lock-logout").addEventListener("click", async () => {
    lock.open = false;
    $("lock").classList.add("hidden");
    await sb.auth.signOut();
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") lock.hiddenAt = Date.now();
    else if (state.user && lock.hiddenAt && Date.now() - lock.hiddenAt > LOCK_AFTER_MS) showLock();
  });
  // iPhone: quando l'app torna dalla memoria senza ricaricarsi
  window.addEventListener("pageshow", (e) => { if (e.persisted && state.user) showLock(); });

  // ---------- Avvio ----------
  setInterval(() => { if (state.user && !state.editing) render(); }, 60 * 1000); // aggiorna "x min fa"
  checkLockSupport();
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
})();
