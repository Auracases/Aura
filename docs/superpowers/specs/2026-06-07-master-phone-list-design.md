# Master phone list + layered availability — design

Date: 2026-06-07
Status: approved (pending user spec review)

## Problem

The storefront autocomplete and the admin phones tab both run over a single
`phones` table that contains only the ~400 rows imported once from the owner's
Google Sheet. That table doubles as the availability list (which models have
2D/3D hard cases). Consequences:

- Autocomplete only finds the ~400 sheet models. A customer whose phone isn't in
  the sheet falls through to the "Use anyway" fallback even for common models.
- The admin phones tab (`ilike` over the same table) can only find/edit models
  already in the sheet — it cannot set availability for a model that isn't there.

Goal: autocomplete should cover nearly every phone sold in Bangladesh, while
2D/3D availability stays a separate, independently-updatable layer on top of that
model list. Updating availability must never wipe the model list.

## Chosen approach (Option A — one table, seeded)

Keep the single `phones` table but seed it with a master list of ~thousands of BD
phone models. Availability lives in two columns on the same rows. The two concerns
stay logically separate by a discipline enforced in the sync logic:

> **Sync only ever INSERTs models and UPDATEs availability flags. It never DELETEs
> a model row.** So changing availability can never remove a model from autocomplete.

Rejected alternatives:
- **Two tables** (`phone_models` + `phones`): cleaner schema separation but adds a
  merge path, a second admin tab, more surface. Not worth it — the discipline above
  gives the same guarantee.
- **Static JSON master in repo, loaded by storefront**: breaks "owner never edits
  code", and forces a code change to add a model. (Note: we DO ship a master JSON,
  but only as the *server-side sync source* — the storefront never loads it; see below.)

## Data model

Existing `phones` columns: `brand`, `model_name`, `search_key` (unique, `= norm(model_name)`),
`avail_2d`, `avail_3d`. Two new columns:

```sql
alter table public.phones add column if not exists manual_override boolean default false;
alter table public.phones add column if not exists updated_at      timestamptz default now();
```

- `search_key` is the canonical join/identity key. `norm(s)` = lowercase, strip to
  `[a-z0-9]` only. Must be byte-identical across storefront JS, admin JS, and the
  Edge Function (Deno/TS) — documented as the contract.
- `manual_override = true` marks a row whose availability was set by hand in admin;
  the sheet sync skips it (see conflict rule).

## Master model list (source data)

- A curated, GSMArena-derived dump of ~thousands of BD-relevant models, filtered to:
  - Brands: Samsung, Xiaomi/Redmi/Poco, Realme, Vivo, Oppo, Apple (iPhone), Infinix,
    Tecno, itel, OnePlus, Motorola, Nokia, Honor, Huawei, plus local **Symphony** and
    **Walton** (supplemented, since GSMArena under-covers these).
  - Recent years (~2018→present) to keep the list to a few thousand, not 20k legacy.
- Normalized + deduped on `search_key`. Shape: `[{ "brand": "...", "model": "..." }, ...]`.
- Committed to the repo as `data/phones-master.json` (~150–200KB).
- **The storefront never fetches this file.** It is only the input the GSM sync
  Edge Function pulls. The storefront always reads the `phones` *table* (cached 24h).

## Two scheduled syncs

Both are independent, each with: auto on/off, an editable frequency, and a manual
"run now" button. Schedule config lives in the DB so a fixed daily cron can drive
variable frequencies.

### `sync_sources` table

```sql
create table if not exists public.sync_sources (
  key            text primary key,    -- 'gsm' | 'sheet'
  enabled        boolean default true, -- the auto on/off toggle
  frequency_days int default 1,        -- gsm ~15-30, sheet ~2-3
  source_url     text,
  last_run_at    timestamptz,
  last_status    text default ''
);
-- seed two rows: 'gsm' (jsDelivr master URL, ~21 days), 'sheet' (Apps Script URL, ~3 days)
```
RLS: admin (authenticated) read/write; no anon access.

### GSM master sync (~1–2×/month)

- Source = `https://cdn.jsdelivr.net/gh/<owner>/<repo>@main/data/phones-master.json`.
- Action = **INSERT-only into master**:
  ```sql
  insert into phones (brand, model_name, search_key)
  values (...)
  on conflict (search_key) do nothing;   -- never touches avail flags
  ```
- New models appear; availability of existing rows is untouched.

### Availability sheet sync (~2–3×/week)

- Source = the owner's Apps Script sheet URL (was `LEGACY_PHONES_URL`, renamed
  `AVAIL_SHEET_URL` in `config.js` since the sheet is now a living source, not legacy).
- Per sheet row, upsert that respects manual overrides:
  ```sql
  insert into phones (brand, model_name, search_key, avail_2d, avail_3d)
  values (...)
  on conflict (search_key) do update
    set avail_2d = excluded.avail_2d,
        avail_3d = excluded.avail_3d,
        updated_at = now()
    where phones.manual_override = false;   -- admin-pinned rows skipped
  ```
- INSERTs missing models too (sheet may introduce models), UPDATEs avail where not
  overridden, SKIPs overridden rows.

### Conflict rule (the "both: sheet + admin")

**Admin edit is sticky.** Toggling 2D/3D in admin sets `manual_override = true`; the
sheet sync never overwrites those rows. Owner clicks "release to sheet" in admin to
clear the flag and let the row rejoin daily sync.

### Execution

- **One Edge Function** `sync(source, force)` (Deno), using the service-role key
  (env only — never in repo) to bypass RLS for upserts.
- **pg_cron** fires the function **daily**. For each source the function runs it only
  if `enabled AND (last_run_at is null OR now() - last_run_at >= frequency_days)`.
  `force = true` (manual button) ignores `enabled` and frequency.
- Invocation auth:
  - Manual (admin): `supabase.functions.invoke('sync', { body:{ source, force:true }})`
    with the authenticated admin JWT; function requires an authenticated caller.
  - Cron: pg_cron job uses `pg_net` to POST the function URL with a shared secret
    header (stored in Supabase Vault / function env); function accepts either a valid
    admin JWT or the cron secret.
- On finish, function writes `last_run_at` + `last_status` on the source row.

## Admin changes (`admin.html`)

- **New "Sync" panel** (own tab, or a card in the Phones tab). Two rows — GSM master,
  Avail sheet — each showing:
  - enable toggle (auto on/off → `sync_sources.enabled`)
  - frequency-days input (`frequency_days`)
  - **"Run now"** button → invokes `sync` with `force:true`
  - last-run time + status (`last_run_at`, `last_status`)
- **Phones tab**: search now hits the full seeded table (the original complaint is
  solved by seeding — no code change needed to search). Toggling avail sets
  `manual_override = true`. Show an override badge + a **"release to sheet"** button
  that clears `manual_override`.
- The old one-time "Import phones from old sheet" button is removed/repurposed — its
  job is now the `sheet` sync's "Run now".

## Storefront changes (`index.html`)

Minimal — the architecture already supports this:
- `searchModels` already runs over the entire cached `phones` list, so once the table
  is seeded it covers everything. No search-logic change.
- 24h `localStorage` cache (`cb_phones`) stays — this is the passive "daily-ish"
  refresh per visitor. (Heavier server syncs are the scheduled jobs above.)
- "Use anyway" fallback unchanged — it fires only on 0 matches, which becomes rare
  (truly obscure phones), exactly as intended.
- `config.js`: rename `LEGACY_PHONES_URL` → `AVAIL_SHEET_URL` (used now by the sheet
  sync source config, not the browser).

## Security

- Storefront still uses only the publishable anon key; RLS unchanged for public reads.
- `sync_sources` is admin-only (no anon policy).
- Service-role key lives only in the Edge Function environment, never in the repo.
- Repo will be made **public** (for jsDelivr). Audited: only the publishable anon key,
  schema SQL, and admin markup are exposed — no secrets. Acceptable.

## Prerequisites (one-time, owner/dev)

1. Create a **public GitHub repo** and push (no remote exists yet) — required for jsDelivr.
2. Deploy the `sync` Edge Function (Supabase CLI or dashboard); set service-role +
   cron-secret env vars.
3. Enable `pg_cron` + `pg_net` extensions; schedule the daily job.
4. Run the schema migration (new columns + `sync_sources`).
5. First GSM sync (manual "Run now") to seed the master list.

## Testing

- `node --check` on inline `<script>` blocks of both pages + `config.js`.
- After seed: REST `curl` count of `phones` + spot-check `search_key` for sample models.
- Forgiving-match check: "redmi note12", "Note 12", "redmi note-12" all resolve to one model.
- Sync UPDATE-only: set a row's `manual_override=true`, run sheet sync, confirm its
  avail flags are unchanged; confirm a non-overridden row does update.
- GSM sync INSERT-only: confirm existing rows' avail flags untouched after a run.
- Frequency gate: confirm a source with recent `last_run_at` is skipped by cron-path
  but runs under `force:true`.
