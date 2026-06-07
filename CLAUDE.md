# CLAUDE.md

Guidance for Claude Code working in this repo.

## What this is

**CaseBari** — a phone-case store for Bangladesh (EN/Bengali). **Static, build-less, vanilla-JS**
front end backed by **Supabase** (Postgres + Storage + Auth + RPC). No framework, no bundler, no
package.json. Hosted on **GitHub Pages** from the public repo `Auracases/Aura` (push to `main` =
auto-deploy). The store owner manages everything from `admin.html`; they never edit code day-to-day.

Two product lines, one shared checkout (`place_order` RPC):
1. **Custom** — customer picks phone → case type → a catalog design or their own photo (`index.html`).
2. **Ready-made** — pre-stocked products bought directly (`shop.html`).

## Pages (each = markup + CSS + one inline `<script>`, loads `config.js` + supabase-js from jsDelivr)

- **`index.html`** — custom storefront. Flow: pick phone (Step 1) → case type (Step 2) → design (Step 3,
  category pills + inner-scroll grid + big preview + upload-your-own) → cart drawer → checkout → confirm.
  Ad deep-link: `?design=<id>` presets a design (pinned banner, share button). Header links to Shop/Demos.
- **`shop.html`** — ready-made catalog: category pills + search → product grid → detail sheet (image
  carousel, price/old-price, description, model-fit) → cart drawer → checkout (calls `place_order` with
  `items:[{productId, qty}]`). Cart in `localStorage` (`cb_shop_cart`).
- **`demos.html`** — public gallery of case-type demos (images + inline videos), grouped by admin-managed
  **demo categories** (separate from case types). Per-category / per-item "Order now" links.
- **`admin.html`** — email/password login (`signInWithPassword`). Tabs: **Designs** (catalog + design
  categories + bulk upload + bulk ops + ad-link), **Orders** (paginated 30/page, search incl. tags,
  detail modal, status/note/tags, manual order with fast in-memory phone search, multi-delete),
  **Promos**, **Pricing & Settings** (case-type prices + active toggle, delivery, bKash, store sale),
  **Phones** (sync panel + search/edit availability + manual override), **Demos** (demo categories +
  items + drag-reorder + bulk ops), **Shop** (product categories + products + bulk ops). All via
  supabase-js as the authenticated admin (RLS-guarded).
- **`config.js`** — `SUPABASE_URL`, `SUPABASE_ANON_KEY` (publishable key, public by design), `AVAIL_TTL_MS`
  (24h phone cache), `AVAIL_SHEET_URL` (Apps Script availability sheet, used by sync config), `FALLBACK`.
- **`supabase-schema.sql`** — **the contract**: all tables, RLS, RPCs, storage policies, seeds. Idempotent
  (re-runnable). Change columns/RPC signatures here AND in the front-end calls together.
- **`scripts/build-phones-master.mjs`** — offline Node generator → `data/phones-master.json` (the master
  phone list). Merges a raw dataset + `data/*-supplement.json`. Has a Node test in `scripts/__tests__/`.
- **`supabase/functions/sync/`** — optional Edge Function (gsm+sheet). Superseded in practice by the
  `run_sync()` SQL function (CLI-free); kept for reference.

## Data model (Postgres)

- `phones` (master list ~1900 rows: brand, model_name, search_key, avail_2d/3d, **on_sheet**,
  manual_override, updated_at). `search_key = norm(model_name)`, unique.
- `case_types` (tpu/uv/d2/d3 + any you add: name, price, descr, always_available, requires, **active**, sort).
- `designs` (name, image_url, **category_id**, active, sort) + `design_categories`.
- `demos` (category_id, media_type image|video, url, caption, order_url, show_order, sort, active) + `demo_categories`.
- `readymade_products` (name, price, old_price, description, category_id, **image_urls text[]**, model_fit,
  stock, active, sort) + `product_categories`.
- `settings` (single row id=1: delivery, bkash_number, store-wide discount).
- `promos`, `orders` (orders carry items jsonb, note, **tags**, photo_urls). `sync_sources` (gsm/sheet config).

## Money & ordering — the rule that matters

**Totals are computed server-side, never trusted from the client.** `place_order(payload jsonb)`
(security-definer RPC) prices each item: `items[].caseTypeId` → `case_types.price` (custom), or
`items[].productId` (+ `qty`) → `readymade_products.price` (ready-made). Then store-wide sale, then promo,
inserts the order, bumps `promos.used_count`, returns `{subtotal, delivery, discount, total}`. The browser
shows only an estimate. Touch pricing/discounts in the RPC, not just JS. `validate_promo` is a separate
security-definer RPC (promo codes never listable by the public).

**Each order item stores a design `image`** (catalog image for presets, uploaded photo for uploads) so admin
always sees what was ordered.

## Phone availability & sync

The **availability sheet** (Google Apps Script JSON) holds case-fitment **groups** — one row lists several
models that share a case + its 2D/3D. The **master list** (`data/phones-master.json` → seeded into `phones`)
drives autocomplete. Storefront `availFor(name)` resolves 2D/3D by substring-matching a model against the
sheet group blobs. `run_sync(source, force)` (security-definer, uses the `http` extension) refreshes data:
admin "Run now" calls it; `pg_cron` calls it daily, self-gating on `sync_sources.frequency_days`. No CLI needed.

## Security (RLS)

`anon` (publishable key) can: read public catalog tables (`phones`, `case_types`, `designs`,
`design_categories`, `demos`, `demo_categories`, `readymade_products`, `product_categories`, `settings`,
`sync_sources` is admin-only); call `place_order` + `validate_promo`; upload to `order-photos`. It **cannot**
read `promos`/`orders` or write tables. Don't add anon SELECT to `promos`/`orders`. `run_sync` and the inner
sync RPCs are authenticated/service-only.

## Images / Storage

Public buckets `designs` (also holds `demos/` and `products/` paths) and `order-photos`. Full CDN URL stored
in the row. Client compresses images via `compressImage` before upload. Uploads use `upsert:false`
(anon/auth have INSERT but not UPDATE on these buckets — `upsert:true` fails RLS).

## Conventions

- Framework-free, build-free. New logic in the page's inline `<script>`, styles in its `<style>`. Match the
  plain-DOM style (`$ = getElementById`, template-string `innerHTML`, `escapeHtml`/`esc` on any user/DB text).
- `norm(s)` = lowercase + strip to `[a-z0-9]`. Canonical key, **identical in storefront JS, admin JS,
  generator, and SQL `public.norm()`**. `search_key = norm(model_name)`.
- Supabase access via `supabase-js` (jsDelivr CDN) — don't hand-roll REST in app code.
- Supabase caps each REST response at **1000 rows** — paginate with `.range()` for full lists (phones, etc.).
- After editing a page's inline JS, syntax-check:
  `awk '/^<script>$/{f=1;next} /<\/script>/{f=0} f' FILE.html > /tmp/x.js && node --check /tmp/x.js`
- Re-running `supabase-schema.sql` can't drop a NOT NULL or alter existing columns — add explicit `ALTER`s.
- Git: commit/push only when asked. Co-author trailer required on commits (see system guidance). `main` is
  live (GitHub Pages) — pushing deploys.
- Specs/plans live in `docs/superpowers/`.

## Open / not-yet-done

- Automation deploy (`pg_cron` schedule of `run_sync`) is owner-run; data has been seeded manually via SQL.
- `app.htm`, legacy `images/` — ignore.
