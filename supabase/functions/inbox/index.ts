// Riceve foto, file e testi dal Comando Rapido "Manda a MyHome" (tasto Condividi dell'iPhone).
// Il codice personale nell'indirizzo (?t=...) dice a quale account vanno.
import { createClient } from "npm:@supabase/supabase-js@2";

const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const MAX = 50 * 1024 * 1024;
const EXT: Record<string, string> = {
  "image/jpeg": ".jpg", "image/png": ".png", "image/heic": ".heic", "image/heif": ".heif", "image/gif": ".gif", "image/webp": ".webp",
  "video/quicktime": ".mov", "video/mp4": ".mp4", "application/pdf": ".pdf", "text/plain": ".txt",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": ".docx",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": ".xlsx",
  "application/msword": ".doc", "application/vnd.ms-excel": ".xls",
};
const MIME: Record<string, string> = Object.fromEntries(Object.entries(EXT).map(([m, e]) => [e, m]));
const say = (msg: string, status = 200) => new Response(msg, { status, headers: { "Content-Type": "text/plain; charset=utf-8" } });

Deno.serve(async (req) => {
  if (req.method !== "POST") return say("MyHome: per mandare file usa il comando rapido \"Manda a MyHome\".", 405);
  const url = new URL(req.url);
  const token = url.searchParams.get("t") || req.headers.get("x-token") || "";
  if (token.length < 32) return say("Codice mancante: copia di nuovo l'indirizzo dall'app MyHome.", 401);
  const { data: tok } = await sb.from("inbox_tokens").select("user_id").eq("token", token).maybeSingle();
  if (!tok) return say("Codice non valido: copia di nuovo l'indirizzo dall'app MyHome.", 401);
  const uid = tok.user_id as string;

  const files: File[] = [];
  const texts: string[] = [];
  const ct = req.headers.get("content-type") || "";
  if (ct.includes("multipart/form-data") || ct.includes("application/x-www-form-urlencoded")) {
    const fd = await req.formData();
    for (const [, v] of fd.entries()) {
      if (typeof v === "string") { if (v.trim()) texts.push(v); } else files.push(v);
    }
  } else if (ct.startsWith("text/")) {
    texts.push(await req.text());
  } else if (ct.includes("application/json")) {
    const j = await req.json().catch(() => ({}));
    const t = j.text || j.url || j.content;
    if (t) texts.push(String(t));
  } else {
    const b = await req.blob();
    if (b.size) files.push(new File([b], url.searchParams.get("name") || "", { type: ct || "application/octet-stream" }));
  }

  let n = 0;
  const stamp = new Date().toLocaleString("it-IT", { timeZone: "Europe/Rome", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }).replace(/[/:]/g, ".").replace(", ", " ");
  for (const f of files) {
    if (!f.size) continue;
    if (f.size > MAX) return say(`"${f.name || "file"}" è troppo grande (massimo 50 MB).`, 413);
    let type = f.type || "application/octet-stream";
    let name = (f.name || "").trim();
    const hasExt = /\.[a-z0-9]{2,5}$/i.test(name);
    if (!hasExt) {
      const ext = EXT[type] || "";
      const base = !name || /^(file|image|photo|video|media)$/i.test(name)
        ? (type.startsWith("image/") ? "Foto " : type.startsWith("video/") ? "Video " : "File ") + stamp + (n ? ` (${n + 1})` : "")
        : name;
      name = base + ext;
    } else if (type === "application/octet-stream") {
      type = MIME[name.slice(name.lastIndexOf(".")).toLowerCase()] || type;
    }
    // un testo semplice condiviso (non un file .txt vero) diventa una nota
    if (type.startsWith("text/plain") && !hasExt && f.size < 20000) { texts.push(await f.text()); continue; }
    const ext = name.includes(".") ? "." + name.split(".").pop()!.toLowerCase().replace(/[^a-z0-9]/g, "") : "";
    const path = `${uid}/${crypto.randomUUID()}${ext}`;
    const up = await sb.storage.from("files").upload(path, f, { contentType: type, upsert: false });
    if (up.error) return say("Errore nel caricamento: " + up.error.message, 500);
    const ins = await sb.from("items").insert({ user_id: uid, kind: "file", file_path: path, file_name: name, mime_type: type, size_bytes: f.size, source: "iPhone" });
    if (ins.error) { await sb.storage.from("files").remove([path]); return say("Errore: " + ins.error.message, 500); }
    n++;
  }
  for (const t of texts) {
    const content = t.trim().slice(0, 20000);
    if (!content) continue;
    const ins = await sb.from("items").insert({ user_id: uid, kind: "note", content, source: "iPhone" });
    if (ins.error) return say("Errore: " + ins.error.message, 500);
    n++;
  }
  if (!n) return say("Non è arrivato niente: prova a condividere di nuovo.", 400);
  return say(n === 1 ? "Arrivato su MyHome ✓" : `Arrivati su MyHome: ${n} ✓`);
});
