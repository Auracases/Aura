// Supabase Edge Function: list-category(url)
// Admin-gated (is_admin()). Scrapes a listing/category page's product links + images
// and asks GPT-4o-mini to return an array the admin can review + bulk-import:
//   { ok, source:'ai', items:[ { name, price, url, image } ] }
// NOTE: server fetch cannot run a page's JavaScript — JS-rendered/SPA listings may
// return nothing. The admin UI surfaces that.
//
// Secrets required: OPENAI_API_KEY  (SUPABASE_URL + SUPABASE_ANON_KEY auto-injected)
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const ANON_KEY     = Deno.env.get("SUPABASE_ANON_KEY")!;
const OPENAI_KEY   = Deno.env.get("OPENAI_API_KEY") ?? "";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "content-type": "application/json" } });

async function requireAdmin(req: Request): Promise<Response | null> {
  const jwt = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  if (!jwt) return json({ ok: false, error: "unauthorized" }, 401);
  const userClient = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${jwt}` } }, auth: { persistSession: false },
  });
  const { data, error } = await userClient.rpc("is_admin");
  if (error || data !== true) return json({ ok: false, error: "forbidden" }, 403);
  return null;
}

const abs = (u: string, base: string) => { try { return new URL(u, base).href; } catch { return u; } };

// Collect candidate anchors (href + visible text) and nearby image, compactly.
function scrapeCandidates(html: string, base: string) {
  const anchors = [...html.matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)];
  const seen = new Set<string>();
  const out: { url: string; text: string; img: string }[] = [];
  for (const a of anchors) {
    const url = abs(a[1], base);
    if (seen.has(url)) continue;
    const inner = a[2];
    const text = inner.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    const imgM = inner.match(/<img[^>]+(?:data-src|src)=["']([^"']+)["']/i);
    const img = imgM ? abs(imgM[1], base) : "";
    // keep anchors that look like product links (have text + an image, or a price hint)
    if ((text && img) || /(৳|tk|rs|\$|price)/i.test(text)) {
      seen.add(url);
      out.push({ url, text: text.slice(0, 120), img });
    }
    if (out.length >= 60) break;
  }
  return out;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const denied = await requireAdmin(req);
  if (denied) return denied;

  const body = await req.json().catch(() => ({}));
  const url = String(body.url || "").trim();
  if (!/^https?:\/\//i.test(url)) return json({ ok: false, error: "Provide a valid http(s) URL" }, 400);
  if (!OPENAI_KEY) return json({ ok: false, error: "OPENAI_API_KEY not set" }, 500);

  let html = "";
  try {
    const res = await fetch(url, { headers: { "user-agent": "Mozilla/5.0 (compatible; AuraImporter/1.0)" } });
    if (!res.ok) throw new Error("fetch " + res.status);
    html = await res.text();
  } catch (e) {
    return json({ ok: false, error: "Couldn't fetch the page: " + (e as Error).message }, 502);
  }

  const candidates = scrapeCandidates(html, url);
  if (!candidates.length) return json({ ok: true, source: "ai", items: [], note: "No product links found (the page may be JavaScript-rendered)." });

  try {
    const prompt = `From these listing-page links, return ONLY the ones that are individual products.
Return STRICT JSON: {"items":[{"name":string,"price":number|null,"url":string,"image":string}]}
- price: digits only (the visible listing price), or null if not shown.
- url + image: copy exactly from the candidate.
- Skip navigation, categories, filters, pagination, social links.

CANDIDATES (JSON):
${JSON.stringify(candidates)}`;
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${OPENAI_KEY}` },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        temperature: 0,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: "You filter scraped links down to real products. Output only valid JSON." },
          { role: "user", content: prompt },
        ],
      }),
    });
    if (!res.ok) throw new Error("OpenAI " + res.status + ": " + (await res.text()).slice(0, 300));
    const data = await res.json();
    const obj = JSON.parse(data.choices?.[0]?.message?.content || "{}");
    const items = (Array.isArray(obj.items) ? obj.items : []).map((i: any) => ({
      name: String(i.name || "").trim(),
      price: Number(i.price) || null,
      url: abs(String(i.url || ""), url),
      image: abs(String(i.image || ""), url),
    })).filter((i: any) => i.name);
    return json({ ok: true, source: "ai", items });
  } catch (e) {
    return json({ ok: false, error: (e as Error).message }, 500);
  }
});
