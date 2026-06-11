// Supabase Edge Function: import-product(url)
// Admin-gated (is_admin()). Fetches a product page server-side and returns fields
// to prefill the admin product editor:
//   { ok, source:'jsonld'|'ai', product:{ name, description, price, original_price, images[] } }
// Strategy: try JSON-LD Product schema first (free + exact); else send cleaned,
// truncated HTML to OpenAI GPT-4o-mini with a strict JSON instruction.
//
// Secrets required (supabase secrets set ...): OPENAI_API_KEY
// SUPABASE_URL + SUPABASE_ANON_KEY are injected automatically.
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

// Reject anyone who isn't the logged-in admin. Runs is_admin() AS the caller.
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

function absolutize(u: string, base: string): string {
  try { return new URL(u, base).href; } catch { return u; }
}

// Pull <script type="application/ld+json"> blocks and find a Product node.
function fromJsonLd(html: string, base: string) {
  const blocks = [...html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)];
  for (const b of blocks) {
    let parsed: any;
    try { parsed = JSON.parse(b[1].trim()); } catch { continue; }
    const nodes = Array.isArray(parsed) ? parsed : (parsed["@graph"] || [parsed]);
    for (const n of nodes) {
      const type = n && n["@type"];
      const isProduct = type === "Product" || (Array.isArray(type) && type.includes("Product"));
      if (!isProduct) continue;
      const offers = Array.isArray(n.offers) ? n.offers[0] : n.offers || {};
      const price = Number(offers.price ?? offers.lowPrice ?? n.price ?? 0) || null;
      const original = Number(offers.highPrice ?? n.original_price ?? 0) || null;
      let images: string[] = [];
      if (typeof n.image === "string") images = [n.image];
      else if (Array.isArray(n.image)) images = n.image.map((x: any) => (typeof x === "string" ? x : x?.url)).filter(Boolean);
      else if (n.image?.url) images = [n.image.url];
      return {
        name: String(n.name || "").trim(),
        description: String(n.description || "").trim(),
        price, original_price: original && original > (price || 0) ? original : null,
        images: images.map((u) => absolutize(u, base)).slice(0, 8),
      };
    }
  }
  return null;
}

function cleanHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<\/(p|div|li|h[1-6]|br)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, 12000);
}

function imageCandidates(html: string, base: string): string[] {
  const out = new Set<string>();
  const og = html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i);
  if (og) out.add(absolutize(og[1], base));
  for (const m of html.matchAll(/<img[^>]+src=["']([^"']+)["']/gi)) {
    const u = m[1];
    if (/\.(jpe?g|png|webp|avif)(\?|$)/i.test(u) && !/sprite|icon|logo|pixel|blank/i.test(u)) out.add(absolutize(u, base));
    if (out.size >= 12) break;
  }
  return [...out];
}

async function fromAI(html: string, base: string) {
  if (!OPENAI_KEY) throw new Error("OPENAI_API_KEY not set");
  const text = cleanHtml(html);
  const candidates = imageCandidates(html, base);
  const prompt = `Extract the single product on this e-commerce page. Return STRICT JSON:
{"name": string, "description": string (clean, no HTML, keep useful detail; Markdown ok),
 "price": number|null (the current selling price, digits only),
 "original_price": number|null (the struck-through/was price if any, else null),
 "images": string[] (choose the product photos from the CANDIDATES list only)}

CANDIDATES:
${candidates.map((u) => "- " + u).join("\n") || "(none)"}

PAGE TEXT:
${text}`;
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${OPENAI_KEY}` },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      temperature: 0,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: "You extract structured product data from messy HTML. Output only valid JSON matching the requested schema." },
        { role: "user", content: prompt },
      ],
    }),
  });
  if (!res.ok) throw new Error("OpenAI " + res.status + ": " + (await res.text()).slice(0, 300));
  const data = await res.json();
  const obj = JSON.parse(data.choices?.[0]?.message?.content || "{}");
  let images: string[] = Array.isArray(obj.images) ? obj.images : [];
  if (!images.length) images = candidates.slice(0, 3);
  return {
    name: String(obj.name || "").trim(),
    description: String(obj.description || "").trim(),
    price: Number(obj.price) || null,
    original_price: Number(obj.original_price) || null,
    images: images.map((u) => absolutize(u, base)).slice(0, 8),
  };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const denied = await requireAdmin(req);
  if (denied) return denied;

  const body = await req.json().catch(() => ({}));
  const url = String(body.url || "").trim();
  if (!/^https?:\/\//i.test(url)) return json({ ok: false, error: "Provide a valid http(s) URL" }, 400);

  let html = "";
  try {
    const res = await fetch(url, { headers: { "user-agent": "Mozilla/5.0 (compatible; AuraImporter/1.0)" } });
    if (!res.ok) throw new Error("fetch " + res.status);
    html = await res.text();
  } catch (e) {
    return json({ ok: false, error: "Couldn't fetch the page: " + (e as Error).message }, 502);
  }

  try {
    const jsonld = fromJsonLd(html, url);
    if (jsonld && jsonld.name && jsonld.price) return json({ ok: true, source: "jsonld", product: jsonld });
    const ai = await fromAI(html, url);
    if (!ai.name) return json({ ok: false, error: "Could not extract a product (JS-rendered page?)." }, 422);
    return json({ ok: true, source: "ai", product: ai });
  } catch (e) {
    return json({ ok: false, error: (e as Error).message }, 500);
  }
});
