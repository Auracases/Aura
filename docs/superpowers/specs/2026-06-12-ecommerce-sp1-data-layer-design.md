# SP1 — Ecommerce Platform: Data Layer

**Date:** 2026-06-12
**Status:** Approved (design); pending implementation plan.

## Context

The Shop (`shop.html` + admin Shop tab + `readymade_products`/`product_categories` +
`place_order`/`validate_promo` RPCs) is being grown into a full guest-checkout ecommerce
platform. The full effort is decomposed into four sub-projects, each with its own
spec → plan → implementation cycle:

- **SP1 — Data layer** (this doc): all new schema, RLS, RPCs, triggers, seed. Foundation.
- **SP2 — Storefront**: themed store (announcement bar, nav + Browse-Categories dropdown),
  product detail (variant picker, qty stepper, discount %, tabs Desc/Shipping/Reviews,
  related, Buy Now), cart page + drawer + free-delivery hint, checkout (coupon box, flat
  shipping, COD), order-confirmation page, track-order page with status timeline. Content
  from `site_content` deep-merged over `config.js`.
- **SP3 — Admin expansion**: products table + filters + bulk, full product editor (card
  sections, sticky save bar, slug auto, discount auto-calc, variant chip editor, image
  manager with paste-URL + upload + reorder + main-image badge, **markdown** description
  editor), Reviews CRUD (approve queue), Coupons CRUD (extend Promos), Shipping admin
  (flat + free-delivery rule), Site Content admin (show/hide toggles), order source label.
- **SP4 — AI import**: two Edge Functions (`import-product`, `list-category`) GPT-4o-mini,
  admin-gated via `is_admin()`, key as a function secret; admin review UI.

Build order: **SP1 → SP2 + SP3 → SP4**.

### Decisions locked during brainstorming

- **Variants**: simple option labels, one shared price + stock per product. The chosen
  label rides along in the order item jsonb. No per-variant pricing, no variants table.
- **Shipping**: keep the existing flat `delivery_inside` / `delivery_outside`. Add a
  free-delivery rule (toggle + threshold). **No zones.**
- **Reviews**: customers submit → land `pending` → admin approves. Only `approved` reviews
  are publicly readable. Anon submits via a security-definer RPC (anon never writes tables
  directly — repo convention).
- **Track-order timeline**: a real `order_status_history` table + trigger (exact timestamps).
- **AI import**: GPT-4o-mini; owner provisions the OpenAI key at SP4 deploy time.
- **track_order privacy**: returns a safe subset only — withholds address/notes/tags, caps
  to the 5 most recent matches. (Resolved: keep mobile lookup, withhold PII.)
- **Announcement**: moves into `site_content`; `settings.announcement(_active)` becomes a
  legacy fallback the storefront reads only if `site_content` has none.

## Existing facts that shape the design

- `orders.order_id` is `text unique not null` — clean FK / lookup target.
- `orders` has **no** `updated_at` — added here.
- `place_order` already stores `items` jsonb verbatim → the chosen variant label persists
  with no RPC pricing change.
- `place_order` already accepts `promo_code` and prices server-side → the SP2 coupon box
  needs no RPC change beyond what is below.
- `settings` already has `announcement` + `announcement_active`.
- RLS convention: `anon` reads public catalog, writes nothing (uses RPCs); any
  `authenticated` user is the admin (`to authenticated using(true)`).

All changes go in `supabase-schema.sql` (the contract) and must stay idempotent
(`if not exists` / `create or replace` / drop+create policy). New NOT-NULL columns get a
default (re-running can't add a bare NOT NULL to an existing table).

---

## A. `readymade_products` — new columns

```sql
alter table public.readymade_products add column if not exists slug         text;
alter table public.readymade_products add column if not exists variants     text[] default '{}';
alter table public.readymade_products add column if not exists rating_avg   numeric(2,1) default 0;
alter table public.readymade_products add column if not exists rating_count int default 0;
alter table public.readymade_products add column if not exists best_seller  boolean default false;
alter table public.readymade_products add column if not exists is_combo     boolean default false;
-- unique slug (partial: ignore nulls so the add is safe before backfill)
create unique index if not exists readymade_products_slug_idx
  on public.readymade_products (slug) where slug is not null;
```

- `slug`: URL key for the product page (`shop.html?p=<slug>`). Admin auto-generates from
  the name (`norm()`-style, hyphenated, de-duplicated with a numeric suffix). Backfilled
  for existing rows in the migration (see I).
- `variants`: e.g. `{Black,Clear,Blue}`. One price + one `stock` for the whole product
  (shared). The picked label is stored on the order item (`items[].variant`).
- `rating_avg` / `rating_count`: denormalized, maintained by the `reviews` trigger (B).
- `best_seller` / `is_combo`: drive admin filters and storefront badges.
- `description` is unchanged (`text`) — it now holds **Markdown**; SP2 renders it and
  supports image syntax. No schema change.

## B. `reviews` table + submit RPC + rating rollup

```sql
create table if not exists public.reviews (
  id          bigint generated always as identity primary key,
  product_id  bigint references public.readymade_products(id) on delete cascade,
  author_name text not null,
  rating      int  not null check (rating between 1 and 5),
  body        text default '',
  status      text default 'pending',   -- pending | approved | rejected
  created_at  timestamptz default now()
);
alter table public.reviews enable row level security;
-- public sees ONLY approved; admin (authenticated) sees all
drop policy if exists "public read approved reviews" on public.reviews;
create policy "public read approved reviews" on public.reviews
  for select to anon, authenticated using (status = 'approved');
drop policy if exists "admin all reviews" on public.reviews;
create policy "admin all reviews" on public.reviews
  for all to authenticated using (true) with check (true);
-- NOTE: no anon INSERT policy — submission goes through submit_review().
```

`submit_review` — security-definer, granted to anon, forces `pending`:

```sql
create or replace function public.submit_review(
  p_product_id bigint, p_name text, p_rating int, p_body text)
returns json language plpgsql security definer set search_path = public as $$
begin
  if p_rating < 1 or p_rating > 5 then
    return json_build_object('ok',false,'error','Rating must be 1–5');
  end if;
  if coalesce(trim(p_name),'') = '' then
    return json_build_object('ok',false,'error','Name required');
  end if;
  if not exists (select 1 from public.readymade_products where id = p_product_id) then
    return json_build_object('ok',false,'error','Unknown product');
  end if;
  insert into public.reviews (product_id, author_name, rating, body, status)
  values (p_product_id, trim(p_name), p_rating, coalesce(p_body,''), 'pending');
  return json_build_object('ok',true);
end $$;
grant execute on function public.submit_review(bigint,text,int,text) to anon, authenticated;
```

Rating rollup trigger (recompute from approved rows on any change):

```sql
create or replace function public.reviews_rollup() returns trigger
language plpgsql security definer set search_path = public as $$
declare pid bigint := coalesce(NEW.product_id, OLD.product_id);
begin
  update public.readymade_products p set
    rating_count = (select count(*)      from public.reviews r where r.product_id = pid and r.status = 'approved'),
    rating_avg   = coalesce((select round(avg(r.rating)::numeric,1)
                             from public.reviews r where r.product_id = pid and r.status = 'approved'),0)
  where p.id = pid;
  return null;
end $$;
drop trigger if exists trg_reviews_rollup on public.reviews;
create trigger trg_reviews_rollup after insert or update or delete on public.reviews
  for each row execute function public.reviews_rollup();
```

## C. `order_status_history` + status triggers

```sql
create table if not exists public.order_status_history (
  id         bigint generated always as identity primary key,
  order_id   text not null references public.orders(order_id) on delete cascade,
  status     text not null,
  changed_at timestamptz default now()
);
create index if not exists osh_order_idx on public.order_status_history (order_id);
alter table public.order_status_history enable row level security;
-- admin-only direct access; the public reads timeline via track_order() only
drop policy if exists "admin all order_status_history" on public.order_status_history;
create policy "admin all order_status_history" on public.order_status_history
  for all to authenticated using (true) with check (true);

alter table public.orders add column if not exists updated_at timestamptz default now();
```

Status ladder for display (storefront renders from history): `New → Confirmed → Packed →
Shipped → Delivered`, plus terminal `Cancelled`. The admin status dropdown should use
these exact labels.

Trigger: write an initial `New` row on order insert; write a row + bump `updated_at`
whenever `status` changes:

```sql
create or replace function public.track_order_status() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if TG_OP = 'INSERT' then
    insert into public.order_status_history (order_id, status) values (NEW.order_id, NEW.status);
  elsif TG_OP = 'UPDATE' and NEW.status is distinct from OLD.status then
    insert into public.order_status_history (order_id, status) values (NEW.order_id, NEW.status);
    NEW.updated_at := now();
  end if;
  return NEW;
end $$;
drop trigger if exists trg_order_status_ins on public.orders;
create trigger trg_order_status_ins after insert on public.orders
  for each row execute function public.track_order_status();
drop trigger if exists trg_order_status_upd on public.orders;
create trigger trg_order_status_upd before update on public.orders
  for each row execute function public.track_order_status();
```

(Note: INSERT trigger is `after` so the FK target row exists; UPDATE is `before` so it can
set `NEW.updated_at` in-row.)

## D. `track_order(p_query text)` RPC

Security-definer, granted anon. Matches `order_id` (case-insensitive exact) **or**
normalized `mobile`. Returns a **safe subset only** — no address, note, or tags; capped to
the 5 most recent matches.

```sql
create or replace function public.track_order(p_query text)
returns json language plpgsql security definer set search_path = public as $$
declare q text := trim(coalesce(p_query,'')); qd text;
begin
  if q = '' then return json_build_object('ok',false,'error','Enter an order number or mobile'); end if;
  qd := regexp_replace(q, '\D', '', 'g');   -- digits-only for mobile match
  return (
    select json_build_object('ok', true, 'orders', coalesce(json_agg(o order by o.created_at desc), '[]'::json))
    from (
      select json_build_object(
        'order_id', ord.order_id,
        'status',   ord.status,
        'created_at', ord.created_at,
        'updated_at', ord.updated_at,
        'total',    ord.total,
        'items', (select coalesce(json_agg(json_build_object(
                     'name', coalesce(i->>'name', i->>'caseType', 'item'),
                     'qty',  coalesce((i->>'qty')::int, 1),
                     'variant', i->>'variant')), '[]'::json)
                  from jsonb_array_elements(coalesce(ord.items,'[]'::jsonb)) i),
        'timeline', (select coalesce(json_agg(json_build_object('status', h.status, 'at', h.changed_at)
                                              order by h.changed_at), '[]'::json)
                     from public.order_status_history h where h.order_id = ord.order_id)
      ) as o, ord.created_at
      from public.orders ord
      where upper(ord.order_id) = upper(q)
         or (qd <> '' and regexp_replace(coalesce(ord.mobile,''), '\D', '', 'g') = qd)
      order by ord.created_at desc
      limit 5
    ) o
  );
end $$;
grant execute on function public.track_order(text) to anon, authenticated;
```

## E. `orders` — source tagging + `place_order` change

```sql
alter table public.orders add column if not exists source text default 'custom';  -- store | custom | mixed
```

In `place_order`, after building items, derive `source`:
- any item with `productId` and any with `caseTypeId` → `mixed`
- only `productId` items → `store`
- otherwise → `custom`

Add `source` to the `insert into public.orders (...)` column list and value. SP3 adds the
admin Orders filter; the admin manual-order insert also sets `source`.

## F. `settings` — free-delivery rule + `place_order` change

```sql
alter table public.settings add column if not exists free_delivery_active    boolean default false;
alter table public.settings add column if not exists free_delivery_threshold int default 0;
```

In `place_order`, after `disc` is finalized and before computing the total, if a promo
hasn't already zeroed delivery:

```sql
if not free_delivery and s.free_delivery_active
   and s.free_delivery_threshold > 0 and sub >= s.free_delivery_threshold then
  deliv := 0;
end if;
```

(Threshold compares against `sub`, the pre-discount subtotal — simplest, predictable for
the customer.) Shipping stays flat inside/outside; **no zones**.

## G. `site_content` table

Single-row content store, deep-merged over `config.js` defaults by the storefront. Every
display block carries a `show` toggle (the hide/show requirement).

```sql
create table if not exists public.site_content (
  id         int primary key default 1,
  content    jsonb default '{}'::jsonb,
  updated_at timestamptz default now(),
  constraint site_content_singleton check (id = 1)
);
alter table public.site_content enable row level security;
drop policy if exists "public read site_content" on public.site_content;
create policy "public read site_content" on public.site_content
  for select to anon, authenticated using (true);
drop policy if exists "admin all site_content" on public.site_content;
create policy "admin all site_content" on public.site_content
  for all to authenticated using (true) with check (true);
insert into public.site_content (id) values (1) on conflict (id) do nothing;
```

`content` JSON shape (documented contract; admin Site Content form writes it, storefront
deep-merges over `CONFIG.SITE_DEFAULTS`):

```jsonc
{
  "store_name": "Aura Cases",
  "announcement":       { "show": true,  "text": "", "link": "" },
  "hero":               { "show": true,  "slides": [ { "image":"", "title":"", "subtitle":"", "cta_text":"", "cta_link":"" } ] },
  "trust_badges":       { "show": true,  "items":  [ { "icon":"", "label":"" } ] },
  "product_info_boxes": { "show": true,  "items":  [ { "title":"", "body":"" } ] },  // shown on every product page
  "contact":            { "show": true,  "phone":"", "email":"", "address":"" },
  "social":             { "facebook":"", "instagram":"", "whatsapp":"", "tiktok":"" },
  "nav_categories":     [ /* ordered product_category ids pinned in the top nav */ ]
}
```

Storefront reads `announcement` from here; if absent, falls back to legacy
`settings.announcement` / `announcement_active`.

## H. `is_admin()` — SP4 gate

```sql
create or replace function public.is_admin()
returns boolean language sql stable security definer set search_path = public as $$
  select auth.uid() is not null;
$$;
grant execute on function public.is_admin() to authenticated;
```

Single-admin app: a logged-in user is the admin (matches existing `to authenticated`
policies). SP4 Edge Functions verify the caller's JWT and call `is_admin()`.

## I. Seed data (idempotent)

```sql
-- product categories
insert into public.product_categories (name, sort) values
  ('Silicone',1),('Clear',2),('MagSafe',3),('Wallet',4)
on conflict (name) do nothing;

-- sample products (slug + variants + best_seller). Use placeholder image URLs.
-- (exact rows finalized in the migration; ~4 products across the categories above)

-- backfill slugs for any existing product missing one (name → hyphenated norm + id suffix)
update public.readymade_products
  set slug = regexp_replace(lower(name), '[^a-z0-9]+', '-', 'g') || '-' || id
  where slug is null;

-- default site_content already inserted in G (empty {} → storefront uses CONFIG defaults)
-- 1 sample coupon
insert into public.promos (code,type,value,min_order,active) values ('WELCOME10','percent',10,300,true)
  on conflict (code) do nothing;
-- 2 approved sample reviews are inserted against a seeded product id in the migration
```

(The migration finalizes exact sample rows; the rollup trigger sets their `rating_*`.)

---

## RLS summary (what changes for `anon`)

- **Read:** add `reviews` (approved only) and `site_content`.
- **Execute:** add `submit_review`, `track_order` (both safe, security-definer).
- **Still no** anon read on `orders` / `order_status_history` / `promos`, and **no** anon
  table writes anywhere.

## Out of scope for SP1 (deferred)

- All UI (storefront SP2, admin SP3).
- Edge Functions (SP4).
- Shipping zones (explicitly dropped — flat + free-delivery only).
- Per-variant pricing/stock.

## Verification for SP1

- Re-run `supabase-schema.sql` twice in a scratch DB → no errors (idempotent).
- `select place_order(...)` with a store item → order row has correct `source='store'`,
  total honors free-delivery threshold; a history `New` row exists.
- `submit_review(...)` → row is `pending`, not publicly selectable as anon; after admin
  sets `approved`, `rating_avg`/`rating_count` update.
- `track_order('<order_id>')` and `track_order('<mobile>')` → safe subset, no address.
- anon cannot `select * from orders` / `reviews` (non-approved) / `order_status_history`.
