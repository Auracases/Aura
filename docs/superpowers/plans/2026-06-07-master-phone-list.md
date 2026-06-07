# Master Phone List + Layered Availability — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make storefront autocomplete cover nearly every phone sold in Bangladesh, with 2D/3D availability as a separate layer updated by two scheduled syncs (GSM master ~monthly, availability sheet ~3×/week) plus manual admin overrides.

**Architecture:** One seeded `phones` table holds the master model list; `avail_2d`/`avail_3d` are the availability layer; `manual_override` pins admin edits. A single Supabase Edge Function `sync(source, force)` is fired daily by `pg_cron`, self-gating on a per-source `frequency_days`. Two security-definer RPCs do the actual writes: `sync_master_models` (INSERT-only) and `sync_sheet_avail` (UPDATE flags where not overridden). The master list ships as `data/phones-master.json`, pulled by the GSM sync over jsDelivr.

**Tech Stack:** Vanilla JS storefront/admin (build-less), Supabase (Postgres + RLS + RPC + Storage + Edge Functions/Deno), `pg_cron`+`pg_net`, Node for the offline generator script. No test framework — verification is `node --check`, small Node logic tests, `curl` against Supabase REST, and explicit manual browser/SQL checks (per CLAUDE.md: no build/lint/test tooling).

**Contract reminder:** `norm(s)` = `lowercase` then strip to `[a-z0-9]`. Must be byte-identical in storefront JS, admin JS, the generator, the Edge Function, and the SQL `norm()` function. `search_key = norm(model_name)` is the unique identity/join key.

---

## File Structure

- Modify: `supabase-schema.sql` — SQL `norm()`, new `phones` columns, `sync_sources` table + RLS + seed, two sync RPCs.
- Modify: `config.js` — rename `LEGACY_PHONES_URL` → `AVAIL_SHEET_URL`; note source URLs now live in `sync_sources`.
- Create: `scripts/build-phones-master.mjs` — offline Node generator: raw dataset → filtered/normalized/deduped `phones-master.json`.
- Create: `data/local-brands-supplement.json` — hand-authored Symphony/Walton/itel models GSMArena under-covers.
- Create: `data/phones-master.json` — generated master list (committed).
- Create: `scripts/__tests__/build-phones-master.test.mjs` — Node test for the generator's pure transforms.
- Create: `supabase/functions/sync/index.ts` — the Edge Function.
- Create: `supabase/functions/sync/transform.ts` — pure parse/map functions (imported by the function and the test).
- Create: `supabase/functions/sync/transform.test.mjs` — Node test of the pure transforms.
- Modify: `admin.html` — replace one-time Import with a Sync panel (two sources: toggle, frequency, Run now, last-run/status); phones tab Save sets `manual_override`, adds override badge + "Release to sheet".
- Modify: `index.html` — verification only (no code change expected); confirm search over the seeded table.
- Modify: `SETUP-supabase.md` — deployment runbook (extensions, migration, function deploy, secrets, cron, first sync).

---

## Task 1: Schema — norm(), phones columns, sync_sources, sync RPCs

**Files:**
- Modify: `supabase-schema.sql` (append a new section before `-- ---------- STORAGE BUCKETS ----------`)

- [ ] **Step 1: Add the SQL `norm()` function**

Append to `supabase-schema.sql`:

```sql
-- ---------- SYNC: master list + availability layer ----------

-- Canonical normalizer — must match norm() in the JS and the generator:
-- lowercase, then strip everything that isn't a-z or 0-9.
create or replace function public.norm(s text)
returns text language sql immutable as $$
  select regexp_replace(lower(coalesce(s,'')), '[^a-z0-9]', '', 'g');
$$;
```

- [ ] **Step 2: Add the new `phones` columns**

```sql
alter table public.phones add column if not exists manual_override boolean default false;
alter table public.phones add column if not exists updated_at      timestamptz default now();
-- on_sheet = this model appears in the availability sheet feed (set by the sheet
-- sync). Lets admin show the small sheet list separately from the big GSM master.
alter table public.phones add column if not exists on_sheet        boolean default false;
```

> **Deploy ordering note:** there is intentionally NO backfill of `on_sheet` in
> this re-runnable schema (it would wrongly flag GSM rows on a re-run). Instead,
> Task 8 runs the **sheet sync before the GSM sync**, so the current 556 rows get
> `on_sheet=true` first; GSM then adds the rest as `on_sheet=false`.

- [ ] **Step 3: Add `sync_sources` table, RLS, seed**

```sql
create table if not exists public.sync_sources (
  key            text primary key,         -- 'gsm' | 'sheet'
  label          text default '',
  enabled        boolean default true,       -- auto on/off toggle
  frequency_days int     default 1,          -- gsm ~21, sheet ~3
  source_url     text    default '',
  last_run_at    timestamptz,
  last_status    text    default '',
  updated_at     timestamptz default now()
);

-- Seed both sources. Replace OWNER/REPO with the public GitHub repo, and
-- PASTE_APPS_SCRIPT_URL with the availability sheet's Apps Script /exec URL.
insert into public.sync_sources (key,label,enabled,frequency_days,source_url) values
  ('gsm',  'GSM master model list', true, 21, 'https://cdn.jsdelivr.net/gh/OWNER/REPO@main/data/phones-master.json'),
  ('sheet','Availability sheet',    true, 3,  'PASTE_APPS_SCRIPT_URL')
on conflict (key) do nothing;

alter table public.sync_sources enable row level security;
drop policy if exists "admin all sync_sources" on public.sync_sources;
create policy "admin all sync_sources" on public.sync_sources
  for all to authenticated using (true) with check (true);
-- No anon policy: the public cannot read sync config.
```

- [ ] **Step 4: Add the two sync RPCs**

```sql
-- INSERT-only master models. p_models: [{ "brand": "...", "model": "..." }, ...]
-- Never touches availability flags. Returns rows inserted.
create or replace function public.sync_master_models(p_models jsonb)
returns int language plpgsql security definer set search_path = public as $$
declare n int;
begin
  insert into public.phones (brand, model_name, search_key)
  select coalesce(m->>'brand',''), m->>'model', public.norm(m->>'model')
  from jsonb_array_elements(coalesce(p_models,'[]'::jsonb)) as m
  where coalesce(m->>'model','') <> '' and public.norm(m->>'model') <> ''
  on conflict (search_key) do nothing;
  get diagnostics n = row_count;
  return n;
end $$;

-- Upsert availability from the sheet. p_rows: [{brand, model, avail_2d, avail_3d}].
-- INSERTs missing models (on_sheet=true); on conflict, always marks on_sheet=true
-- and fills brand, but only overwrites the avail flags when manual_override = false
-- (admin-pinned rows keep their flags). Returns rows affected.
create or replace function public.sync_sheet_avail(p_rows jsonb)
returns int language plpgsql security definer set search_path = public as $$
declare n int;
begin
  insert into public.phones (brand, model_name, search_key, avail_2d, avail_3d, on_sheet, updated_at)
  select coalesce(r->>'brand',''), r->>'model', public.norm(r->>'model'),
         coalesce((r->>'avail_2d')::boolean,false),
         coalesce((r->>'avail_3d')::boolean,false), true, now()
  from jsonb_array_elements(coalesce(p_rows,'[]'::jsonb)) as r
  where coalesce(r->>'model','') <> '' and public.norm(r->>'model') <> ''
  on conflict (search_key) do update
    set avail_2d   = case when phones.manual_override then phones.avail_2d else excluded.avail_2d end,
        avail_3d   = case when phones.manual_override then phones.avail_3d else excluded.avail_3d end,
        on_sheet   = true,
        brand      = case when phones.brand = '' then excluded.brand else phones.brand end,
        updated_at = now();
  get diagnostics n = row_count;
  return n;
end $$;

-- Only the service role (used by the Edge Function) calls these. Lock out anon/authenticated.
revoke all on function public.sync_master_models(jsonb) from anon, authenticated;
revoke all on function public.sync_sheet_avail(jsonb)   from anon, authenticated;
```

- [ ] **Step 5: Verify the SQL parses (paste into Supabase SQL Editor and Run)**

This is a manual check — the file is the contract, applied by the owner in Step of Task 8. For now, confirm no syntax error locally by eye and that every statement uses `if not exists`/`or replace`/`on conflict` (re-runnable). Expected: file remains idempotent.

- [ ] **Step 6: Commit**

```bash
git add supabase-schema.sql
git commit -m "feat: schema for master-list sync (norm, columns, sync_sources, sync RPCs)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: config.js — rename availability sheet URL

**Files:**
- Modify: `config.js:24-27`

- [ ] **Step 1: Rename and re-comment**

Replace the `ONE-TIME MIGRATION` block:

```js
  /* ---- 3) AVAILABILITY SHEET ----
     The Google Apps Script endpoint that serves the 2D/3D availability
     list as JSON. The browser no longer fetches this directly — it is
     stored in sync_sources.source_url and pulled server-side by the
     `sync` Edge Function. Kept here for reference/setup only. */
  AVAIL_SHEET_URL: "https://script.google.com/macros/s/AKfycbybV45O71NzZc10ObuWHXdjzJDaqfN-T92WnZQrRqUOlhTCStVMVvrPcdbHE2jQq6zQ/exec",
```

- [ ] **Step 2: Verify no remaining references to the old name**

Run: `grep -rn "LEGACY_PHONES_URL" .`
Expected: only matches inside `docs/` (the spec) — none in `config.js`, `admin.html`, `index.html`. (Task 5 removes the admin reference; if run out of order, this grep may still show admin.html — that's fine, Task 5 fixes it.)

- [ ] **Step 3: Syntax check**

Run: `node --check config.js`
Expected: no output (pass).

- [ ] **Step 4: Commit**

```bash
git add config.js
git commit -m "refactor: rename LEGACY_PHONES_URL to AVAIL_SHEET_URL

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Master-list generator + generated JSON

**Files:**
- Create: `data/local-brands-supplement.json`
- Create: `scripts/build-phones-master.mjs`
- Create: `scripts/__tests__/build-phones-master.test.mjs`
- Create: `data/phones-master.json` (generated)

- [ ] **Step 1: Write the local-brands supplement (hand-authored)**

GSMArena under-covers Symphony/Walton/itel. Seed a starter supplement (extend as needed). Create `data/local-brands-supplement.json`:

```json
[
  { "brand": "Symphony", "model": "Symphony Z60" },
  { "brand": "Symphony", "model": "Symphony Z55" },
  { "brand": "Symphony", "model": "Symphony Z35" },
  { "brand": "Symphony", "model": "Symphony G100" },
  { "brand": "Walton", "model": "Walton Primo R10" },
  { "brand": "Walton", "model": "Walton Primo H10" },
  { "brand": "Walton", "model": "Walton Primo G10" },
  { "brand": "itel", "model": "itel A70" },
  { "brand": "itel", "model": "itel P55" },
  { "brand": "itel", "model": "itel S24" }
]
```

(At execution, expand this list from current Symphony/Walton/itel catalogs — these 10 are a non-empty starting point so the pipeline is testable.)

- [ ] **Step 2: Write the failing test for the generator's pure transforms**

Create `scripts/__tests__/build-phones-master.test.mjs`:

```js
import assert from "node:assert";
import { norm, normalizeRows } from "../build-phones-master.mjs";

// norm matches the JS/SQL contract
assert.equal(norm("Redmi Note-12"), "redminote12");
assert.equal(norm("  iPhone 15 Pro "), "iphone15pro");

// normalizeRows: filters non-allowed brands, drops old years, dedupes by search_key,
// keeps {brand, model}, sorted by model.
const raw = [
  { brand: "Samsung", model: "Galaxy A15", year: 2024 },
  { brand: "Samsung", model: "galaxy a15", year: 2024 },   // dup by search_key
  { brand: "Nokia",   model: "Nokia 3310", year: 2000 },    // too old -> dropped
  { brand: "Foobar",  model: "Weird X1",  year: 2024 },     // brand not allowed -> dropped
  { brand: "Xiaomi",  model: "Redmi Note 13", year: 2023 }
];
const out = normalizeRows(raw, { minYear: 2018 });
assert.deepEqual(out, [
  { brand: "Samsung", model: "Galaxy A15" },
  { brand: "Xiaomi",  model: "Redmi Note 13" }
]);

console.log("build-phones-master transforms: PASS");
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `node scripts/__tests__/build-phones-master.test.mjs`
Expected: FAIL — `Cannot find module ../build-phones-master.mjs` (not created yet).

- [ ] **Step 4: Write the generator**

Create `scripts/build-phones-master.mjs`:

```js
// Offline generator: raw GSMArena-derived dataset -> data/phones-master.json
// Usage: node scripts/build-phones-master.mjs <raw.json|raw.csv>
// raw rows need at least: brand, model. Optional: year (number or "2023").
import fs from "node:fs";
import path from "node:path";

export function norm(s){ return String(s||"").toLowerCase().replace(/[^a-z0-9]/g,""); }

// Brands big in Bangladesh (lowercased norm of brand for matching).
const ALLOWED = new Set([
  "samsung","xiaomi","redmi","poco","realme","vivo","oppo","apple","iphone",
  "infinix","tecno","itel","oneplus","motorola","nokia","honor","huawei",
  "symphony","walton"
].map(norm));

function brandAllowed(brand, model){
  const b = norm(brand), m = norm(model);
  if(ALLOWED.has(b)) return true;
  // Some datasets put brand in the model string (e.g. Apple -> "iPhone 15").
  for(const a of ALLOWED){ if(m.startsWith(a)) return true; }
  return false;
}

function yearOf(row){
  const y = parseInt(String(row.year ?? row.released ?? "").match(/\d{4}/)?.[0] ?? "", 10);
  return Number.isFinite(y) ? y : null;
}

export function normalizeRows(rows, { minYear = 2018 } = {}){
  const seen = new Set();
  const out = [];
  for(const r of rows || []){
    const brand = String(r.brand || "").trim();
    const model = String(r.model || r.model_name || r.name || "").trim();
    if(!model) continue;
    if(!brandAllowed(brand, model)) continue;
    const y = yearOf(r);
    if(y !== null && y < minYear) continue;   // unknown year is kept
    const key = norm(model);
    if(!key || seen.has(key)) continue;
    seen.add(key);
    out.push({ brand, model });
  }
  out.sort((a,b) => a.model.localeCompare(b.model));
  return out;
}

function readRaw(file){
  const txt = fs.readFileSync(file, "utf8");
  if(file.endsWith(".json")) return JSON.parse(txt);
  // minimal CSV: header row with brand,model[,year]
  const [head, ...lines] = txt.split(/\r?\n/).filter(Boolean);
  const cols = head.split(",").map(s => s.trim().toLowerCase());
  return lines.map(line => {
    const cells = line.split(",");
    const o = {};
    cols.forEach((c,i) => o[c] = (cells[i]||"").trim());
    return o;
  });
}

function main(){
  const rawFile = process.argv[2];
  if(!rawFile){ console.error("usage: build-phones-master.mjs <raw.json|raw.csv>"); process.exit(1); }
  const raw = readRaw(rawFile);
  const supPath = path.join(path.dirname(new URL(import.meta.url).pathname), "..", "data", "local-brands-supplement.json");
  const supplement = JSON.parse(fs.readFileSync(supPath, "utf8"));
  const merged = normalizeRows([...raw, ...supplement], { minYear: 2018 });
  const outPath = path.join(path.dirname(new URL(import.meta.url).pathname), "..", "data", "phones-master.json");
  fs.writeFileSync(outPath, JSON.stringify(merged, null, 0));
  console.log(`Wrote ${merged.length} models -> ${outPath}`);
}

// Run main() only when invoked directly (not when imported by the test).
if(process.argv[1] && process.argv[1].endsWith("build-phones-master.mjs")) main();
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `node scripts/__tests__/build-phones-master.test.mjs`
Expected: `build-phones-master transforms: PASS`

- [ ] **Step 6: Obtain the raw dataset and generate the real file**

Use WebSearch/WebFetch to locate an open, GSMArena-derived phone dataset (GitHub or Kaggle) exposing at least brand + model (+ release year if available). Search terms: `gsmarena dataset github json`, `gsmarena phone specs csv`. Validate the file has the brands listed in `ALLOWED` and reasonable model names. Save it to `data/raw-phones.json` (or `.csv`). Then:

Run: `node scripts/build-phones-master.mjs data/raw-phones.json`
Expected: `Wrote <N> models -> .../data/phones-master.json`, with N in the low thousands (e.g. 1500–4000). If N is far outside that, re-check the brand filter / year cutoff before committing.

- [ ] **Step 7: Sanity-check the output**

Run: `node -e "const a=require('./data/phones-master.json'); console.log(a.length, a.filter(x=>/iphone/i.test(x.model)).slice(0,3), a.filter(x=>/redmi note/i.test(x.model)).slice(0,3))"`
Expected: a count in the thousands and recognizable iPhone + Redmi Note entries. Do NOT commit `data/raw-phones.json` (it's an input, not a product) — add it to `.gitignore`.

- [ ] **Step 8: Commit**

```bash
echo "data/raw-phones.*" >> .gitignore
git add scripts/build-phones-master.mjs scripts/__tests__/build-phones-master.test.mjs data/local-brands-supplement.json data/phones-master.json .gitignore
git commit -m "feat: master phone-list generator + generated data/phones-master.json

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Edge Function `sync`

**Files:**
- Create: `supabase/functions/sync/transform.ts`
- Create: `supabase/functions/sync/transform.test.mjs`
- Create: `supabase/functions/sync/index.ts`

- [ ] **Step 1: Write the failing test for the pure transforms**

Create `supabase/functions/sync/transform.test.mjs`:

```js
import assert from "node:assert";
import { parseMaster, parseSheet, isDue } from "./transform.mjs";

// master: pass-through of {brand, model}, drop empties
assert.deepEqual(
  parseMaster([{brand:"Samsung",model:"Galaxy A15"},{model:""},{model:"iPhone 15"}]),
  [{brand:"Samsung",model:"Galaxy A15"},{brand:"",model:"iPhone 15"}]
);

// sheet: Apps Script shape -> {brand, model, avail_2d, avail_3d}; "available" => true
assert.deepEqual(
  parseSheet([
    { modelName:"Galaxy A15", brand:"Samsung", availability2D:"Available", availability3D:"no" },
    { modelName:"", brand:"x", availability2D:"available", availability3D:"available" }
  ]),
  [{ brand:"Samsung", model:"Galaxy A15", avail_2d:true, avail_3d:false }]
);

// isDue: force always true; disabled false; else now - last >= freq days
const DAY = 86400000, now = 1_000_000_000_000;
assert.equal(isDue({enabled:false, frequency_days:1, last_run_at:null}, false, now), false);
assert.equal(isDue({enabled:true,  frequency_days:1, last_run_at:null}, false, now), true);
assert.equal(isDue({enabled:true,  frequency_days:3, last_run_at:new Date(now-DAY).toISOString()}, false, now), false);
assert.equal(isDue({enabled:false, frequency_days:3, last_run_at:null}, true,  now), true); // force overrides
console.log("sync transforms: PASS");
```

Note: the test imports `./transform.mjs`. We author the logic once in `transform.ts` (used by Deno) and keep a byte-identical `.mjs` copy for the Node test, OR symlink. Simplest: write `transform.ts`, then `cp` it to `transform.mjs` (plain ESM, no TS-only syntax used). Keep them in sync — the code below uses no type annotations so the copy is valid both ways.

- [ ] **Step 2: Run the test to verify it fails**

Run: `node supabase/functions/sync/transform.test.mjs`
Expected: FAIL — cannot find `./transform.mjs`.

- [ ] **Step 3: Write the pure transforms**

Create `supabase/functions/sync/transform.ts` (no TS-only syntax, so it doubles as ESM):

```js
// Pure, side-effect-free helpers — shared by index.ts and the Node test.
export function parseMaster(list){
  return (list || [])
    .map(p => ({ brand: String(p.brand || "").trim(), model: String(p.model || p.model_name || p.name || "").trim() }))
    .filter(p => p.model);
}

export function parseSheet(list){
  const avail = v => String(v == null ? "" : v).trim().toLowerCase() === "available";
  return (list || [])
    .map(p => ({
      brand: String(p.brand || "").trim(),
      model: String(p.modelName || p.model || "").trim(),
      avail_2d: avail(p.availability2D),
      avail_3d: avail(p.availability3D)
    }))
    .filter(p => p.model);
}

export function isDue(src, force, nowMs){
  if(force) return true;
  if(!src || !src.enabled) return false;
  if(!src.last_run_at) return true;
  const last = Date.parse(src.last_run_at);
  const days = (Number(src.frequency_days) || 1) * 86400000;
  return (nowMs - last) >= days;
}
```

Then copy for the Node test:

Run: `cp supabase/functions/sync/transform.ts supabase/functions/sync/transform.mjs`

- [ ] **Step 4: Run the test to verify it passes**

Run: `node supabase/functions/sync/transform.test.mjs`
Expected: `sync transforms: PASS`

- [ ] **Step 5: Write the Edge Function**

Create `supabase/functions/sync/index.ts`:

```ts
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
```

- [ ] **Step 6: Re-sync the `.mjs` copy if `transform.ts` changed, re-run test**

Run: `cp supabase/functions/sync/transform.ts supabase/functions/sync/transform.mjs && node supabase/functions/sync/transform.test.mjs`
Expected: `sync transforms: PASS`

- [ ] **Step 7: Commit**

```bash
git add supabase/functions/sync/
git commit -m "feat: sync Edge Function (gsm master + sheet availability)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: admin.html — Sync panel + manual override

**Files:**
- Modify: `admin.html:193-217` (Phones tab markup), `admin.html:507-581` (phones JS), `admin.html:280` (LOADERS)

- [ ] **Step 1: Replace the Import card + note with Sync panel and two lists (markup)**

Replace the `<div class="note">…</div>` + the Import `<div class="card">…</div>` (lines ~194-203) with the three cards below. The existing "Add / search models" card and `#phonesList` stay (they become the GSM/all search). Result order inside `#tab-phones`: Sync panel → Sheet list → Search-all → results.

```html
    <div class="card">
      <h3>Automatic sync</h3>
      <div class="muted" style="font-size:.85rem;margin-bottom:8px">
        Master list = all phone models (drives search). Availability sheet = which models have 2D/3D.
        Toggle auto-sync, set how often, or run now.
      </div>
      <div id="syncRows"><div class="loading">Loading…</div></div>
    </div>

    <div class="card">
      <div class="row" style="justify-content:space-between;align-items:center;gap:10px">
        <h3 style="margin:0">Availability sheet models <span id="sheetCount" class="muted" style="font-size:.8rem"></span></h3>
        <input id="sheetFilter" placeholder="Filter…" style="max-width:200px" />
      </div>
      <div class="muted" style="font-size:.8rem;margin:6px 0">Models from the Google Sheet — loaded here so you can manage 2D/3D fast.</div>
      <div id="sheetList"><div class="loading">Loading…</div></div>
    </div>

    <div class="card">
      <h3>Search all models (incl. GSM master)</h3>
      <div class="muted" style="font-size:.8rem;margin-bottom:8px">The full catalog is large — search to find any model and set its availability.</div>
```

(The existing "Add / search models" inner controls — `phBrand`/`phModel`/`ph2d`/`ph3d`/`addPhone`/`phSearch`/`phMsg` — move inside this card; keep them as-is. `#phonesList` stays right after.)

- [ ] **Step 2: Add the loaders + render (JS)**

In `admin.html`, change the LOADERS line (currently `phones:()=>{}`):

```js
const LOADERS = { designs:loadDesigns, orders:loadOrders, promos:loadPromos, settings:loadSettings, phones:loadPhonesTab };
function loadPhonesTab(){ loadSync(); loadSheetList(); }
```

Add near the PHONES section (replace the old `$("importPhones").onclick = …` block entirely):

```js
/* ---- shared row renderer for a <tbody>: one phone row with avail toggles,
        source tag, override pin/release, delete. Used by both lists. ---- */
function renderPhoneRow(tb, p, reload){
  const tr = document.createElement("tr");
  const src = p.on_sheet ? `<span class="muted" style="font-size:.72rem">sheet</span>` : `<span class="muted" style="font-size:.72rem">GSM</span>`;
  const ov  = p.manual_override
    ? `<span class="muted" style="font-size:.72rem">pinned</span> <button class="ghost b-rel" style="padding:2px 8px">Release</button>`
    : src;
  tr.innerHTML = `
    <td>${esc(p.brand)}</td><td>${esc(p.model_name)}</td>
    <td><input type="checkbox" class="t2" ${p.avail_2d?"checked":""} style="width:auto" /></td>
    <td><input type="checkbox" class="t3" ${p.avail_3d?"checked":""} style="width:auto" /></td>
    <td style="white-space:nowrap">${ov}</td>
    <td style="text-align:right"><button class="ghost b-save" style="padding:4px 10px">Save</button>
        <button class="danger b-del" style="padding:4px 10px">✕</button></td>`;
  tr.querySelector(".b-save").onclick = async (e) => {
    e.target.disabled = true;
    await sb.from("phones").update({
      avail_2d: tr.querySelector(".t2").checked,
      avail_3d: tr.querySelector(".t3").checked,
      manual_override: true,            // admin edit wins over sheet sync
      updated_at: new Date().toISOString()
    }).eq("id", p.id);
    e.target.textContent = "✓"; setTimeout(reload, 700);
  };
  const rel = tr.querySelector(".b-rel");
  if(rel) rel.onclick = async () => {
    await sb.from("phones").update({ manual_override:false, updated_at:new Date().toISOString() }).eq("id", p.id);
    reload();
  };
  tr.querySelector(".b-del").onclick = async () => { if(confirm(`Delete ${p.model_name}?`)){ await sb.from("phones").delete().eq("id", p.id); reload(); } };
  tb.appendChild(tr);
}
function phoneTableShell(box){
  box.innerHTML = `<div class="card" style="overflow-x:auto;max-height:420px"><table><thead><tr>
    <th>Brand</th><th>Model</th><th>2D</th><th>3D</th><th>Source</th><th></th></tr><tbody></tbody></table></div>`;
  return box.querySelector("tbody");
}

/* ---- sheet list: auto-loaded, fast, on_sheet=true only ---- */
let SHEET_ROWS = [];
async function loadSheetList(){
  const box = $("sheetList");
  const { data, error } = await sb.from("phones").select("*").eq("on_sheet", true).order("model_name").limit(2000);
  if(error){ box.innerHTML = `<div class="loading">Couldn't load.</div>`; return; }
  SHEET_ROWS = data || [];
  $("sheetCount").textContent = `(${SHEET_ROWS.length})`;
  renderSheetList();
}
function renderSheetList(){
  const box = $("sheetList");
  const q = norm($("sheetFilter").value || "");
  const rows = q ? SHEET_ROWS.filter(p => norm(p.model_name).includes(q) || norm(p.brand).includes(q)) : SHEET_ROWS;
  if(!rows.length){ box.innerHTML = `<div class="loading">No models.</div>`; return; }
  const tb = phoneTableShell(box);
  rows.forEach(p => renderPhoneRow(tb, p, loadSheetList));
}
$("sheetFilter").addEventListener("input", () => { clearTimeout(window._sf); window._sf = setTimeout(renderSheetList, 150); });

/* ---- automatic sync panel ---- */
async function loadSync(){
  const box = $("syncRows");
  const { data, error } = await sb.from("sync_sources").select("*").order("key");
  if(error){ box.innerHTML = `<div class="loading">Couldn't load sync config.</div>`; return; }
  box.innerHTML = "";
  (data||[]).forEach(s => {
    const when = s.last_run_at ? new Date(s.last_run_at).toLocaleString() : "never";
    const row = document.createElement("div");
    row.className = "card";
    row.style.cssText = "margin:8px 0;padding:12px";
    row.innerHTML = `
      <div class="row" style="justify-content:space-between;flex-wrap:wrap;gap:10px;align-items:center">
        <b>${esc(s.label || s.key)}</b>
        <label class="row" style="gap:6px;margin:0">
          <input type="checkbox" class="s-en" ${s.enabled?"checked":""} style="width:auto" /> Auto
        </label>
        <label class="row" style="gap:6px;margin:0">every
          <input type="number" min="1" class="s-freq" value="${Number(s.frequency_days)||1}" style="width:64px" /> days
        </label>
        <button class="ghost s-save" style="padding:4px 10px">Save</button>
        <button class="s-run" style="padding:4px 10px">Run now</button>
      </div>
      <div class="muted" style="font-size:.8rem;margin-top:6px">Last run: ${esc(when)} — ${esc(s.last_status||"")}</div>`;
    row.querySelector(".s-save").onclick = async (e) => {
      e.target.disabled = true;
      await sb.from("sync_sources").update({
        enabled: row.querySelector(".s-en").checked,
        frequency_days: Math.max(1, parseInt(row.querySelector(".s-freq").value,10) || 1),
        updated_at: new Date().toISOString()
      }).eq("key", s.key);
      e.target.textContent = "✓"; setTimeout(()=>{e.target.textContent="Save"; e.target.disabled=false;},1200);
    };
    row.querySelector(".s-run").onclick = async (e) => {
      e.target.disabled = true; e.target.textContent = "Running…";
      const { data: res, error: err } = await sb.functions.invoke("sync", { body:{ source:s.key, force:true } });
      e.target.disabled = false; e.target.textContent = "Run now";
      if(err){ alert("Sync failed: " + err.message); }
      else { alert(res?.status || "Done"); loadSync(); }
    };
    box.appendChild(row);
  });
}
```

- [ ] **Step 3: Rewrite `runPhoneSearch` to use the shared renderer (searches the whole table incl. GSM)**

Replace the entire existing `runPhoneSearch` function body with:

```js
async function runPhoneSearch(){
  const q = $("phSearch").value.trim();
  const box = $("phonesList");
  if(!q){ box.innerHTML = `<div class="loading">Search above to list models.</div>`; return; }
  const { data, error } = await sb.from("phones").select("*").ilike("model_name", `%${q}%`).order("model_name").limit(50);
  if(error){ box.innerHTML = `<div class="loading">Couldn't search.</div>`; return; }
  if(!data.length){ box.innerHTML = `<div class="loading">No matches.</div>`; return; }
  const tb = phoneTableShell(box);
  data.forEach(p => renderPhoneRow(tb, p, runPhoneSearch));
}
```

Note: the manual "Add" form (`addPhone`) is a hand edit — add `manual_override:true` AND `on_sheet:true` to its upsert object so a manually-added model shows in the sheet list. After a successful add, also call `loadSheetList()`.

- [ ] **Step 4: Remove the dead `LEGACY_PHONES_URL` reference**

Confirm the old `importPhones` handler (which referenced `CONFIG.LEGACY_PHONES_URL`) is fully removed in Step 2.
Run: `grep -n "LEGACY_PHONES_URL\|importPhones\|importMsg" admin.html`
Expected: no matches.

- [ ] **Step 5: Syntax check the admin script**

Run: `awk '/^<script>$/{f=1;next} /<\/script>/{f=0} f' admin.html > /tmp/adm.js && node --check /tmp/adm.js && echo OK`
Expected: `OK`

- [ ] **Step 6: Commit**

```bash
git add admin.html
git commit -m "feat: admin sync panel + sticky manual availability overrides

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: index.html — verify no change needed

**Files:**
- Modify: `index.html` (only if a check fails)

- [ ] **Step 1: Confirm search reads the live table, not a static list**

Run: `grep -n "for(const p of PHONES)\|CONFIG.PHONE_DB" index.html`
Expected: matches `for(const p of PHONES)`, NO match for `CONFIG.PHONE_DB`. (Search already iterates the loaded table — seeding it is all that's needed.)

- [ ] **Step 2: Confirm the "use anyway" fallback only fires on zero matches**

Run: `grep -n "results.length === 0" index.html`
Expected: one match (the unknown-model fallback guard). No change needed.

- [ ] **Step 3: Syntax check (regression guard)**

Run: `awk '/^<script>$/{f=1;next} /<\/script>/{f=0} f' index.html > /tmp/idx.js && node --check /tmp/idx.js && echo OK`
Expected: `OK`

- [ ] **Step 4: No commit** (no code change). If any check above surprised you, stop and reconcile with the spec before editing.

---

## Task 7: SETUP-supabase.md — deployment runbook

**Files:**
- Modify: `SETUP-supabase.md` (append a "Phone sync" section)

- [ ] **Step 1: Append the runbook**

Add this section to `SETUP-supabase.md`:

```markdown
## Phone model list + availability sync

The phone search is driven by a master model list; 2D/3D availability is a
separate layer updated by two syncs (GSM master ~monthly, availability sheet
~3×/week). One-time setup:

1. **Apply the schema** — open Supabase → SQL Editor → paste all of
   `supabase-schema.sql` → Run. (Safe to re-run.)
2. **Seed sync sources** — in the SQL Editor, set the real URLs:
   ```sql
   update public.sync_sources set source_url =
     'https://cdn.jsdelivr.net/gh/OWNER/REPO@main/data/phones-master.json' where key='gsm';
   update public.sync_sources set source_url = 'PASTE_APPS_SCRIPT_URL' where key='sheet';
   ```
3. **Enable extensions** — SQL Editor:
   ```sql
   create extension if not exists pg_cron;
   create extension if not exists pg_net;
   ```
4. **Deploy the Edge Function** — install the Supabase CLI, then:
   ```bash
   supabase functions deploy sync --project-ref <PROJECT_REF>
   supabase secrets set CRON_SECRET=<a-long-random-string> --project-ref <PROJECT_REF>
   ```
   (`SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are injected automatically.)
5. **Schedule the daily cron** — SQL Editor, replacing `<PROJECT_REF>` and `<CRON_SECRET>`:
   ```sql
   select cron.schedule('phone-sync-daily', '0 3 * * *', $$
     select net.http_post(
       url := 'https://<PROJECT_REF>.functions.supabase.co/sync',
       headers := '{"content-type":"application/json","x-cron-secret":"<CRON_SECRET>"}'::jsonb,
       body := '{"source":"gsm"}'::jsonb);
     select net.http_post(
       url := 'https://<PROJECT_REF>.functions.supabase.co/sync',
       headers := '{"content-type":"application/json","x-cron-secret":"<CRON_SECRET>"}'::jsonb,
       body := '{"source":"sheet"}'::jsonb);
   $$);
   ```
   The function self-gates on each source's `frequency_days`, so the daily fire
   only actually runs a source when it's due.
6. **First seed** — in admin.html → Phones tab → "Run now" on both rows (or wait
   for cron). GSM seeds the master list; sheet layers availability on top.

Manual edits in the Phones tab pin a model (`manual_override`); the sheet sync
skips pinned rows. Click "Release" to let a model rejoin sheet sync.
```

- [ ] **Step 2: Commit**

```bash
git add SETUP-supabase.md
git commit -m "docs: phone sync setup runbook

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 8: Deploy & smoke test (owner-run, live)

**These steps run against the live Supabase project + a public GitHub repo. They require the owner's credentials — the coding agent prepares everything; the owner executes.**

- [ ] **Step 1: Push a public GitHub repo**

```bash
gh repo create <name> --public --source=. --remote=origin --push
```
Then in `sync_sources` (and SETUP), set the `gsm` `source_url` to the repo's jsDelivr path. Verify the file is reachable:
Run: `curl -sI "https://cdn.jsdelivr.net/gh/OWNER/REPO@main/data/phones-master.json" | head -1`
Expected: `HTTP/2 200`.

- [ ] **Step 2: Apply schema + extensions + secrets + cron** — follow `SETUP-supabase.md` steps 1,3,4,5.

- [ ] **Step 3: Run the SHEET sync FIRST** — admin → Phones → "Run now" on Availability sheet. This marks the current ~556 models `on_sheet=true` before GSM adds the rest.
Verify the sheet list populates:
Run: `curl -s "$SUPABASE_URL/rest/v1/phones?on_sheet=eq.true&select=count" -H "apikey: $KEY" -H "Authorization: Bearer $KEY" -H "Prefer: count=exact" -i | grep -i content-range`
Expected: `content-range: 0-0/<~556>`. Confirm the admin "Availability sheet models" card shows them.

- [ ] **Step 4: Run the GSM sync** — admin → Phones → "Run now" on GSM master.
Verify total count grew while on_sheet count stayed:
Run: `curl -s "$SUPABASE_URL/rest/v1/phones?select=count" -H "apikey: $KEY" -H "Authorization: Bearer $KEY" -H "Prefer: count=exact" -i | grep -i content-range`
Expected: `content-range: 0-0/<thousands>` total; the `on_sheet=eq.true` count from Step 3 is unchanged (GSM rows are `on_sheet=false`).

- [ ] **Step 5: Verify override stickiness**

In admin, pin a model (toggle a flag → Save, shows "pinned"). Re-run the sheet sync. Confirm that model's flags are unchanged and a non-pinned model still updates.
Run (check one pinned row): `curl -s "$SUPABASE_URL/rest/v1/phones?manual_override=eq.true&select=model_name,avail_2d,avail_3d&limit=5" -H "apikey: $KEY" -H "Authorization: Bearer $KEY"`
Expected: the pinned row reflects your manual values.

- [ ] **Step 6: Storefront end-to-end**

Open `index.html` (incognito, fresh cache). Search a phone that was NOT in the original 556 (e.g. a recent budget model). Expected: it appears in autocomplete (from master), with TPU·UV always and 2D/3D per the sheet/override. A truly obscure string still shows "Use anyway".

- [ ] **Step 7: Final commit (any URL edits to schema/setup)**

```bash
git add -A && git commit -m "chore: wire live sync source URLs

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
git push
```

---

## Self-Review (completed)

- **Spec coverage:** one-table seeded model (Task 1,3) ✓; new columns (Task 1) ✓; master JSON via jsDelivr (Task 3, Task 8 Step 1) ✓; both sheet+admin availability with admin-sticky overrides (Task 1 RPC + Task 5) ✓; two scheduled syncs, per-source frequency, auto on/off, manual run (Task 1 `sync_sources` + Task 4 `isDue` + Task 5 panel + Task 7 cron) ✓; admin can edit any master model (solved by seeding + existing search, Task 5/6) ✓; storefront minimal change (Task 6) ✓; config rename (Task 2) ✓; security/no service key in repo (Task 4 env, Task 7) ✓; testing (Tasks 3,4 Node tests + manual) ✓.
- **Placeholders:** intentional, owner-supplied values only — `OWNER/REPO`, `PASTE_APPS_SCRIPT_URL`, `<PROJECT_REF>`, `<CRON_SECRET>`. All flagged in SETUP/Task 8.
- **Type consistency:** `norm` identical across JS/SQL/generator/transform; RPC params `p_models`/`p_rows` match `index.ts` calls; `sync_sources` columns (`enabled`,`frequency_days`,`source_url`,`last_run_at`,`last_status`) consistent across schema, function, and admin panel; `isDue`/`parseMaster`/`parseSheet` signatures match between `transform.ts`/`.mjs` and both callers.
```
