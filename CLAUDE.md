# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

CaseBari — a phone-case storefront (Bangladesh; bilingual EN/Bengali). A **static, build-less, vanilla-JS** front end backed by **Supabase** (Postgres + Storage + Auth + RPC). No framework, no bundler, no package.json. Two pages share one `config.js` and the Supabase client.

## Run / develop

```bash
python3 -m http.server 8000      # then open http://localhost:8000/index.html (storefront) or /admin.html
```

No build, lint, or test tooling. After editing JS, syntax-check the inline `<script>` blocks:

```bash
awk '/^<script>$/{f=1;next} /<\/script>/{f=0} f' index.html > /tmp/idx.js && node --check /tmp/idx.js
node --check config.js
```

Supabase REST is reachable for quick backend checks (publishable key is public by design):

```bash
curl -s "$SUPABASE_URL/rest/v1/case_types?select=*" -H "apikey: $KEY" -H "Authorization: Bearer $KEY"
```

## Architecture

**Front end is a thin client; Supabase is the source of truth.** All catalog data, prices,
settings, promos, and orders live in Postgres and are managed from `admin.html`. The store
owner never edits code for day-to-day changes.

- `index.html` — the whole storefront: markup + CSS + one inline `<script>`. Three-step flow
  (pick phone → case type → design), cart drawer, checkout, confirmation. On load it fetches
  `case_types`, `designs` (active), `settings`, and `phones` from Supabase; **phones are cached
  in `localStorage` (`cb_phones`) for `CONFIG.AVAIL_TTL_MS` = 24h** because the list is ~400 rows.
  Phone search (`searchModels`/`norm`) runs client-side over the cached list. Selecting a phone
  looks up `avail_2d`/`avail_3d` to decide which case types show (TPU/UV always; 2D/3D per phone).
- `admin.html` — Supabase email/password login (`signInWithPassword`); five tabs: Designs,
  Orders, Promos, Pricing & Settings, Phones. All reads/writes go straight through `supabase-js`
  as the authenticated admin (RLS-guarded). The **Phones tab → Import** button is a one-time
  migration that pulls `CONFIG.LEGACY_PHONES_URL` (old Google Sheets API), normalizes, and upserts.
- `config.js` — the only shared/edited config: `SUPABASE_URL`, `SUPABASE_ANON_KEY` (a publishable
  key, safe in the browser), `AVAIL_TTL_MS`, `LEGACY_PHONES_URL`, and a small `FALLBACK` block used
  only when Supabase is unreachable so the page still renders.
- `supabase-schema.sql` — **the contract**. Tables, RLS, two RPCs, storage buckets, seeds. Run once
  in the Supabase SQL editor. If you change table columns or RPC signatures, change them here AND
  in the front-end calls together.
- `SETUP-supabase.md` — owner-facing setup steps.
- `app.htm`, `images/` — legacy/unused; ignore.

### Money & ordering — the rule that matters

**Order totals are computed server-side, never trusted from the client.** `place_order(payload jsonb)`
(security-definer RPC) re-reads `case_types.price` for each item's `caseTypeId`, applies the
store-wide sale then the promo, inserts the order, bumps `promos.used_count`, and returns the
authoritative `{subtotal, delivery, discount, total}`. The browser only displays an estimate.
When touching pricing/discounts, edit the RPC in `supabase-schema.sql` — not just the JS.

Discount stacking: **store-wide sale comes off subtotal first, then the promo applies to the
remainder** (a `free_delivery` promo zeros delivery instead of subtracting). `validate_promo` is a
separate security-definer RPC so promo codes are never listable by the public.

### Security model (RLS)

`anon` (publishable key) can: read `phones`/`case_types`/`designs`/`settings`; call the two RPCs;
upload to the `order-photos` storage bucket. It **cannot** read `promos`/`orders` or write any table
directly (verified: direct anon inserts return `401` RLS). Everything else requires the
`authenticated` admin. Don't add an anon SELECT policy to `promos` or `orders`.

### Images

Design images and customer order photos live in **Supabase Storage public buckets** (`designs`,
`order-photos`), referenced by full CDN URL stored in the row (`designs.image_url`,
`orders.photo_urls[]`). Uploads are compressed client-side via `compressImage` before upload.
There is no longer any repo `images/` dependency.

## Conventions

- Keep it framework-free and build-free. New logic goes in the existing inline `<script>`; new
  styles in the page's `<style>`. Match the surrounding plain-DOM style (`$ = getElementById`,
  template-string `innerHTML`, `escapeHtml`/`esc` on any user/DB text).
- `norm(s)` (lower + alphanumerics only) is the canonical key for phone matching; `search_key` in
  the DB is `norm(model_name)`. Reuse it on both sides.
- Supabase POST/RPC from the browser is via `supabase-js` (loaded from the jsDelivr CDN on both
  pages); don't hand-roll fetches to the REST endpoint in app code.
- Git: commit/push only when asked. Co-author trailer is required on commits (see system guidance).
