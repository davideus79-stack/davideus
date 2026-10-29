// Notifiche dei promemoria.
// - ogni minuto pg_cron la chiama (header x-cron) e manda i promemoria scaduti
// - dall'app: { test: true } con il login dell'utente manda una notifica di prova dopo 5 secondi
// - ?ack=... : il telefono conferma di averla ricevuta (serve per capire se arrivano)
import { createClient } from "npm:@supabase/supabase-js@2";
import { sendPush } from "./webpush.js";

const URL_BASE = Deno.env.get("SUPABASE_URL")!;
const sb = createClient(URL_BASE, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};
const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { ...CORS, "Content-Type": "application/json" } });

function preview(content: string): string {
  const lines = (content || "").split("\n").filter((l) => l.trim());
  const isList = /^\[( |x)\] /i.test(lines[0] || "");
  const text = isList
    ? lines.filter((l) => /^\[ \]/.test(l)).map((l) => "• " + l.replace(/^\[( |x)\] ?/i, "")).join("\n") || "Lista completata"
    : lines.join("\n");
  return text.slice(0, 180);
}

async function pushToUser(userId: string, msg: { title: string; body: string; tag: string }, vapid: any) {
  const { data: subs } = await sb.from("push_subs").select("id,endpoint,p256dh,auth,device").eq("user_id", userId);
  const payload = JSON.stringify({ ...msg, url: "./", ack: `${URL_BASE}/functions/v1/remind?ack=${encodeURIComponent(msg.tag)}` });
  const results: { device: string | null; status: number }[] = [];
  for (const s of subs || []) {
    try {
      const r = await sendPush(s, payload, vapid);
      results.push({ device: s.device, status: r.status });
      if (r.status === 404 || r.status === 410) await sb.from("push_subs").delete().eq("id", s.id);
      else if (!r.ok) console.log("push", r.status, await r.text());
    } catch (e) {
      results.push({ device: s.device, status: 0 });
      console.log("push error", String(e));
    }
  }
  return results;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  const url = new URL(req.url);

  const ack = url.searchParams.get("ack");
  if (ack) {
    await sb.from("push_acks").insert({ tag: ack.slice(0, 80), ua: (req.headers.get("user-agent") || "").slice(0, 200) });
    return new Response(null, { status: 204, headers: CORS });
  }

  const { data: secrets } = await sb.from("app_secrets").select("name,value").in("name", ["vapid", "cron_secret"]);
  const get = (n: string) => secrets?.find((s) => s.name === n)?.value;
  const vapid = JSON.parse(get("vapid")!);

  // Notifica di prova chiesta dall'app
  const body = req.method === "POST" ? await req.json().catch(() => ({})) : {};
  if (body && body.test) {
    const jwt = (req.headers.get("authorization") || "").replace(/^Bearer /i, "");
    const { data: u } = await sb.auth.getUser(jwt);
    if (!u?.user) return json({ error: "login" }, 401);
    await new Promise((r) => setTimeout(r, 5000)); // il tempo di chiudere l'app
    const results = await pushToUser(u.user.id, { title: "⏰ Prova MyHome", body: "Se leggi questo, le notifiche funzionano!", tag: "test-" + Date.now() }, vapid);
    return json({ results });
  }

  if (!get("cron_secret") || req.headers.get("x-cron") !== get("cron_secret")) return new Response("no", { status: 401 });

  // prende i promemoria scaduti e li segna subito come inviati (così non partono due volte)
  const { data: due, error } = await sb
    .from("items")
    .update({ reminded: true })
    .lte("remind_at", new Date().toISOString())
    .eq("reminded", false)
    .select("id,user_id,content,file_name,kind");
  if (error) return new Response(error.message, { status: 500 });

  let sent = 0;
  for (const it of due || []) {
    const r = await pushToUser(it.user_id, { title: "⏰ Promemoria", body: it.kind === "note" ? preview(it.content) : it.file_name, tag: it.id }, vapid);
    sent += r.filter((x) => x.status >= 200 && x.status < 300).length;
  }
  return json({ due: due?.length || 0, sent });
});
