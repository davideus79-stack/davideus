// Ogni minuto (pg_cron) manda le notifiche dei promemoria scaduti a tutti i dispositivi dell'utente.
import { createClient } from "npm:@supabase/supabase-js@2";
import { sendPush } from "./webpush.js";

const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

function preview(content: string): string {
  const lines = (content || "").split("\n").filter((l) => l.trim());
  const isList = /^\[( |x)\] /i.test(lines[0] || "");
  const text = isList
    ? lines.filter((l) => /^\[ \]/.test(l)).map((l) => "• " + l.replace(/^\[( |x)\] ?/i, "")).join("\n") || "Lista completata"
    : lines.join("\n");
  return text.slice(0, 180);
}

Deno.serve(async (req) => {
  const { data: secrets } = await sb.from("app_secrets").select("name,value").in("name", ["vapid", "cron_secret"]);
  const get = (n: string) => secrets?.find((s) => s.name === n)?.value;
  if (!get("cron_secret") || req.headers.get("x-cron") !== get("cron_secret")) return new Response("no", { status: 401 });
  const vapid = JSON.parse(get("vapid")!);

  // prende i promemoria scaduti e li segna subito come inviati (così non partono due volte)
  const { data: due, error } = await sb
    .from("items")
    .update({ reminded: true })
    .lte("remind_at", new Date().toISOString())
    .eq("reminded", false)
    .select("id,user_id,content,file_name,kind");
  if (error) return new Response(error.message, { status: 500 });

  let sent = 0, gone = 0;
  for (const it of due || []) {
    const { data: subs } = await sb.from("push_subs").select("id,endpoint,p256dh,auth").eq("user_id", it.user_id);
    const payload = JSON.stringify({
      title: "⏰ Promemoria",
      body: it.kind === "note" ? preview(it.content) : it.file_name,
      tag: it.id,
      url: "./",
    });
    for (const s of subs || []) {
      try {
        const r = await sendPush(s, payload, vapid);
        if (r.status === 404 || r.status === 410) { await sb.from("push_subs").delete().eq("id", s.id); gone++; }
        else if (r.ok) sent++;
        else console.log("push", r.status, await r.text());
      } catch (e) { console.log("push error", String(e)); }
    }
  }
  return new Response(JSON.stringify({ due: due?.length || 0, sent, gone }), { headers: { "Content-Type": "application/json" } });
});
