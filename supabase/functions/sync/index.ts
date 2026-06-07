// Supabase Edge Function: sync(source, force)
// - Auth: a valid admin JWT (Authorization: Bearer) OR the cron secret header.
// - Reads sync_sources[source]; runs only if due (unless force).
// - gsm   -> fetch master JSON  -> rpc sync_master_models (INSERT-only)
// - sheet -> fetch Apps Script  -> rpc sync_sheet_avail   (UPDATE flags, override-aware)
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { parseMaster, parseSheet, isDue } from "./transform.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const CRON_SECRET  = Deno.env.get("CRON_SECRET") ?? "";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-cron-secret, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS"
};

Deno.serve(async (req) => {
  if(req.method === "OPTIONS") return new Response("ok", { headers: cors });

  const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

  // --- auth: cron secret OR a valid logged-in user ---
  const cronOk = CRON_SECRET && req.headers.get("x-cron-secret") === CRON_SECRET;
  let userOk = false;
  if(!cronOk){
    const jwt = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
    if(jwt){ const { data } = await admin.auth.getUser(jwt); userOk = !!data?.user; }
  }
  if(!cronOk && !userOk) return new Response(JSON.stringify({ ok:false, error:"unauthorized" }), { status:401, headers:{...cors,"content-type":"application/json"} });

  const body = await req.json().catch(() => ({}));
  const source = String(body.source || "");
  const force  = !!body.force;
  if(source !== "gsm" && source !== "sheet")
    return new Response(JSON.stringify({ ok:false, error:"bad source" }), { status:400, headers:{...cors,"content-type":"application/json"} });

  const { data: src, error: srcErr } = await admin.from("sync_sources").select("*").eq("key", source).single();
  if(srcErr || !src) return new Response(JSON.stringify({ ok:false, error:"source not configured" }), { status:404, headers:{...cors,"content-type":"application/json"} });

  if(!isDue(src, force, Date.now()))
    return new Response(JSON.stringify({ ok:true, skipped:true, reason:"not due" }), { headers:{...cors,"content-type":"application/json"} });

  let status = "", affected = 0;
  try{
    const res = await fetch(src.source_url);
    if(!res.ok) throw new Error("fetch " + res.status);
    const list = await res.json();
    if(source === "gsm"){
      const models = parseMaster(list);
      const { data, error } = await admin.rpc("sync_master_models", { p_models: models });
      if(error) throw error;
      affected = data ?? 0; status = `inserted ${affected} new models`;
    } else {
      const rows = parseSheet(list);
      const { data, error } = await admin.rpc("sync_sheet_avail", { p_rows: rows });
      if(error) throw error;
      affected = data ?? 0; status = `updated/inserted ${affected} avail rows`;
    }
  }catch(e){
    status = "ERROR: " + (e?.message ?? String(e));
  }
  await admin.from("sync_sources").update({ last_run_at: new Date().toISOString(), last_status: status, updated_at: new Date().toISOString() }).eq("key", source);

  const ok = !status.startsWith("ERROR");
  return new Response(JSON.stringify({ ok, source, affected, status }), { status: ok?200:500, headers:{...cors,"content-type":"application/json"} });
});
