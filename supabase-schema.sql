
-- ====================================================================
-- CaseBari — Supabase schema (run once in: SQL Editor -> New query -> Run)
-- Creates tables, security rules, server functions, storage buckets,
-- and seeds the default case types + settings row.
-- Safe to re-run: uses IF NOT EXISTS / ON CONFLICT / OR REPLACE.
-- ====================================================================

-- ---------- TABLES ----------

-- Phone 2D/3D availability list (imported once from the old Sheets API).
create table if not exists public.phones (
  id          bigint generated always as identity primary key,
  brand       text default '',
  model_name  text not null,
  search_key  text unique not null,       -- normalized: lower + alphanumerics only
  avail_2d    boolean default false,
  avail_3d    boolean default false
);
create index if not exists phones_search_idx on public.phones (search_key);

-- Case types & prices (editable from admin).
create table if not exists public.case_types (
  id               text primary key,      -- tpu | uv | d2 | d3
  name             text not null,
  price            int  not null default 0,
  always_available boolean default false,
  requires         text,                  -- null | '2d' | '3d'
  descr            text default '',
  sort             int  default 0
);

-- Design catalog (image lives in the 'designs' storage bucket).
create table if not exists public.designs (
  id         bigint generated always as identity primary key,
  name       text not null,
  context    text default '',
  image_url  text not null,
  active     boolean default true,
  sort       int default 0,
  created_at timestamptz default now()
);

-- Shop settings — single row (id = 1).
create table if not exists public.settings (
  id                    int primary key default 1,
  bkash_number          text default '01XXXXXXXXX',
  delivery_inside       int  default 70,
  delivery_outside      int  default 130,
  store_discount_type   text default 'none',   -- none | percent | flat
  store_discount_value  numeric default 0,
  store_discount_active boolean default false,
  store_discount_label  text default '',
  constraint settings_singleton check (id = 1)
);

-- Promo codes.
create table if not exists public.promos (
  id           bigint generated always as identity primary key,
  code         text unique not null,
  type         text not null default 'percent',  -- percent | flat | free_delivery
  value        numeric default 0,
  min_order    int default 0,
  max_discount int,                               -- cap for percent (null = none)
  active       boolean default true,
  starts_at    timestamptz,
  expires_at   timestamptz,
  usage_limit  int,                               -- null = unlimited
  used_count   int default 0,
  created_at   timestamptz default now()
);

-- Orders.
create table if not exists public.orders (
  id             bigint generated always as identity primary key,
  order_id       text unique not null,
  created_at     timestamptz default now(),
  name           text,
  mobile         text,
  area           text,
  address        text,
  payment_method text,
  items          jsonb not null default '[]',
  subtotal       int default 0,
  delivery       int default 0,
  discount       int default 0,
  total          int default 0,
  promo_code     text,
  photo_urls     text[] default '{}',
  status         text default 'New'
);

-- ---------- SEED ----------
insert into public.case_types (id,name,price,always_available,requires,descr,sort) values
  ('tpu','TPU Soft',     249, true,  null, 'Flexible, slim, shock-friendly', 1),
  ('uv', 'UV Printed',   349, true,  null, 'Vivid print, glossy finish',     2),
  ('d2', '2D Hard Case', 449, false, '2d', 'Hard back, flat print',          3),
  ('d3', '3D Hard Case', 549, false, '3d', 'Print wraps the edges',          4)
on conflict (id) do nothing;

insert into public.settings (id) values (1) on conflict (id) do nothing;

-- ---------- ROW LEVEL SECURITY ----------
alter table public.phones     enable row level security;
alter table public.case_types enable row level security;
alter table public.designs    enable row level security;
alter table public.settings   enable row level security;
alter table public.promos     enable row level security;
alter table public.orders     enable row level security;

-- Public (anyone) may READ catalog data.
drop policy if exists "public read phones"     on public.phones;
drop policy if exists "public read case_types" on public.case_types;
drop policy if exists "public read designs"    on public.designs;
drop policy if exists "public read settings"   on public.settings;
create policy "public read phones"     on public.phones     for select to anon, authenticated using (true);
create policy "public read case_types" on public.case_types for select to anon, authenticated using (true);
create policy "public read designs"    on public.designs    for select to anon, authenticated using (true);
create policy "public read settings"   on public.settings   for select to anon, authenticated using (true);

-- Admin (any logged-in user) may do everything. promos/orders have NO anon
-- read policy, so the public can never list codes or other people's orders.
drop policy if exists "admin all phones"     on public.phones;
drop policy if exists "admin all case_types" on public.case_types;
drop policy if exists "admin all designs"    on public.designs;
drop policy if exists "admin all settings"   on public.settings;
drop policy if exists "admin all promos"     on public.promos;
drop policy if exists "admin all orders"     on public.orders;
create policy "admin all phones"     on public.phones     for all to authenticated using (true) with check (true);
create policy "admin all case_types" on public.case_types for all to authenticated using (true) with check (true);
create policy "admin all designs"    on public.designs    for all to authenticated using (true) with check (true);
create policy "admin all settings"   on public.settings   for all to authenticated using (true) with check (true);
create policy "admin all promos"     on public.promos     for all to authenticated using (true) with check (true);
create policy "admin all orders"     on public.orders     for all to authenticated using (true) with check (true);

-- ---------- SERVER FUNCTIONS (RPC) ----------

-- Validate a promo code against a subtotal. Runs with elevated rights so the
-- promos table itself is never exposed to the public.
create or replace function public.validate_promo(p_code text, p_subtotal int)
returns json language plpgsql security definer set search_path = public as $$
declare r public.promos; disc int := 0;
begin
  select * into r from public.promos where upper(code) = upper(p_code) limit 1;
  if not found        then return json_build_object('valid',false,'message','Invalid code'); end if;
  if not r.active     then return json_build_object('valid',false,'message','This code is not active'); end if;
  if r.starts_at  is not null and now() < r.starts_at  then return json_build_object('valid',false,'message','This code is not active yet'); end if;
  if r.expires_at is not null and now() > r.expires_at then return json_build_object('valid',false,'message','This code has expired'); end if;
  if r.usage_limit is not null and r.used_count >= r.usage_limit then return json_build_object('valid',false,'message','This code has reached its limit'); end if;
  if p_subtotal < coalesce(r.min_order,0) then return json_build_object('valid',false,'message','Minimum order BDT '||r.min_order); end if;

  if r.type = 'percent' then
    disc := floor(p_subtotal * r.value / 100.0);
    if r.max_discount is not null and disc > r.max_discount then disc := r.max_discount; end if;
  elsif r.type = 'flat' then
    disc := least(r.value, p_subtotal);
  else
    disc := 0;  -- free_delivery: discount applies to delivery at checkout
  end if;

  return json_build_object('valid',true,'type',r.type,'value',r.value,'discount',disc,
                           'label',upper(r.code),'message','Applied');
end $$;
grant execute on function public.validate_promo(text,int) to anon, authenticated;

-- Place an order. Recomputes the subtotal from server-side prices, applies the
-- store-wide sale + promo, inserts the order, and bumps the promo's used_count.
-- payload: { order_id, name, mobile, area, address, payment_method,
--            items:[{caseTypeId,...}], photo_urls:[...], promo_code }
create or replace function public.place_order(payload jsonb)
returns json language plpgsql security definer set search_path = public as $$
declare
  it jsonb; sub int := 0; cprice int;
  s public.settings; pr public.promos;
  disc int := 0; deliv int := 0; pd int;
  free_delivery boolean := false;
  area text := payload->>'area';
  promo text := nullif(payload->>'promo_code','');
  oid text := payload->>'order_id';
begin
  select * into s from public.settings where id = 1;

  for it in select value from jsonb_array_elements(coalesce(payload->'items','[]'::jsonb)) loop
    select price into cprice from public.case_types where id = it->>'caseTypeId';
    sub := sub + coalesce(cprice,0);
  end loop;

  deliv := case when area = 'insideDhaka' then coalesce(s.delivery_inside,0) else coalesce(s.delivery_outside,0) end;

  if s.store_discount_active then
    if s.store_discount_type = 'percent' then disc := disc + floor(sub * s.store_discount_value / 100.0);
    elsif s.store_discount_type = 'flat' then disc := disc + least(s.store_discount_value, sub); end if;
  end if;

  if promo is not null then
    select * into pr from public.promos where upper(code) = upper(promo) limit 1;
    if found and pr.active
       and (pr.starts_at  is null or now() >= pr.starts_at)
       and (pr.expires_at is null or now() <= pr.expires_at)
       and (pr.usage_limit is null or pr.used_count < pr.usage_limit)
       and sub >= coalesce(pr.min_order,0) then
      if pr.type = 'percent' then
        pd := floor((sub - disc) * pr.value / 100.0);
        if pr.max_discount is not null and pd > pr.max_discount then pd := pr.max_discount; end if;
        disc := disc + pd;
      elsif pr.type = 'flat' then
        disc := disc + least(pr.value, sub - disc);
      elsif pr.type = 'free_delivery' then
        free_delivery := true;
      end if;
      update public.promos set used_count = used_count + 1 where id = pr.id;
    else
      promo := null;  -- invalid/expired promo is silently ignored
    end if;
  end if;

  if free_delivery then deliv := 0; end if;
  if disc > sub then disc := sub; end if;

  insert into public.orders
    (order_id,name,mobile,area,address,payment_method,items,subtotal,delivery,discount,total,promo_code,photo_urls,status)
  values
    (oid, payload->>'name', payload->>'mobile', area, payload->>'address', payload->>'payment_method',
     coalesce(payload->'items','[]'::jsonb), sub, deliv, disc, (sub - disc + deliv), promo,
     coalesce((select array_agg(value) from jsonb_array_elements_text(payload->'photo_urls')), '{}'),
     'New');

  return json_build_object('ok',true,'order_id',oid,'subtotal',sub,'delivery',deliv,
                           'discount',disc,'total',(sub - disc + deliv),'free_delivery',free_delivery);
end $$;
grant execute on function public.place_order(jsonb) to anon, authenticated;

-- ---------- SYNC: master list + availability layer ----------

-- Canonical normalizer — must match norm() in the JS and the generator:
-- lowercase, then strip everything that isn't a-z or 0-9.
create or replace function public.norm(s text)
returns text language sql immutable as $$
  select regexp_replace(lower(coalesce(s,'')), '[^a-z0-9]', '', 'g');
$$;

alter table public.phones add column if not exists manual_override boolean default false;
alter table public.phones add column if not exists updated_at      timestamptz default now();
-- on_sheet = this model appears in the availability sheet feed (set by the sheet
-- sync). Lets admin show the small sheet list separately from the big GSM master.
alter table public.phones add column if not exists on_sheet        boolean default false;

-- Admin-only note on an order (shown in the admin Orders tab; never to customers).
alter table public.orders add column if not exists note text default '';

-- Demo gallery (demos.html), fully admin-managed. Categories are free-form and
-- independent of the customize case_types. Each category can show an "Order now"
-- button linking anywhere (a ready-made product page, a collection, or the
-- customize flow); each demo item can also carry its own order link.
create table if not exists public.demo_categories (
  id          bigint generated always as identity primary key,
  name        text not null unique,
  sort        int  default 0,
  active      boolean default true,
  show_order  boolean default false,           -- show an "Order now" button on this section
  order_label text default 'Order now',
  order_url   text default '',                 -- where the button goes (blank = customize flow)
  created_at  timestamptz default now()
);
alter table public.demo_categories enable row level security;
drop policy if exists "public read demo_categories" on public.demo_categories;
create policy "public read demo_categories" on public.demo_categories for select to anon, authenticated using (true);
drop policy if exists "admin all demo_categories" on public.demo_categories;
create policy "admin all demo_categories" on public.demo_categories for all to authenticated using (true) with check (true);

create table if not exists public.demos (
  id          bigint generated always as identity primary key,
  category_id bigint references public.demo_categories(id) on delete cascade,
  case_key    text default '',                 -- legacy (pre-categories); ignored once migrated
  media_type  text not null default 'image',   -- image | video
  url         text not null,
  caption     text default '',
  order_url   text default '',                 -- optional per-item order link (overrides category)
  sort        int  default 0,
  active      boolean default true,
  created_at  timestamptz default now()
);
alter table public.demos add column if not exists category_id bigint references public.demo_categories(id) on delete cascade;
alter table public.demos add column if not exists order_url   text default '';
alter table public.demos enable row level security;
drop policy if exists "public read demos" on public.demos;
create policy "public read demos" on public.demos for select to anon, authenticated using (true);
drop policy if exists "admin all demos" on public.demos;
create policy "admin all demos" on public.demos for all to authenticated using (true) with check (true);

-- Seed 4 starter demo categories + migrate any pre-categories demos by case_key.
insert into public.demo_categories (name, sort) values
  ('TPU Soft',1),('UV Printed',2),('2D Hard Case',3),('3D Hard Case',4)
on conflict (name) do nothing;
update public.demos d set category_id = c.id
from public.demo_categories c
where d.category_id is null and (
     (d.case_key='tpu' and c.name='TPU Soft')
  or (d.case_key='uv'  and c.name='UV Printed')
  or (d.case_key='d2'  and c.name='2D Hard Case')
  or (d.case_key='d3'  and c.name='3D Hard Case'));

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

-- The inner RPCs are only ever called by run_sync (security definer, runs as
-- owner), so lock them out of anon/authenticated direct calls.
revoke all on function public.sync_master_models(jsonb) from anon, authenticated;
revoke all on function public.sync_sheet_avail(jsonb)   from anon, authenticated;

-- One-call sync used by both the admin "Run now" button and pg_cron. Fetches the
-- source URL server-side (http extension), applies it via the inner RPCs, and
-- records last_run_at/last_status. p_force=true ignores the enabled+frequency gate
-- (the admin button); cron passes false so each source only runs when due.
-- Requires: create extension if not exists http with schema extensions;
create or replace function public.run_sync(p_source text, p_force boolean default false)
returns text language plpgsql security definer set search_path = public, extensions as $$
declare s public.sync_sources; body jsonb; n int; due boolean; msg text;
begin
  select * into s from public.sync_sources where key = p_source;
  if not found then return 'unknown source'; end if;
  due := p_force or (s.enabled and (s.last_run_at is null
        or now() - s.last_run_at >= make_interval(days => greatest(coalesce(s.frequency_days,1),1))));
  if not due then return 'skipped (not due)'; end if;

  begin
    body := (extensions.http_get(s.source_url)).content::jsonb;
  exception when others then
    update public.sync_sources set last_run_at = now(), last_status = 'ERROR fetch: '||SQLERRM where key = p_source;
    return 'ERROR: fetch failed';
  end;

  if p_source = 'gsm' then
    n := public.sync_master_models(body);
    msg := 'inserted ' || n || ' new models';
  elsif p_source = 'sheet' then
    n := public.sync_sheet_avail(
      (select jsonb_agg(jsonb_build_object(
         'brand',    e->>'brand',
         'model',    e->>'modelName',
         'avail_2d', lower(coalesce(e->>'availability2D','')) = 'available',
         'avail_3d', lower(coalesce(e->>'availability3D','')) = 'available'))
       from jsonb_array_elements(body) e));
    msg := 'updated ' || n || ' availability rows';
  else
    return 'bad source';
  end if;

  update public.sync_sources set last_run_at = now(), last_status = msg where key = p_source;
  return msg;
end $$;
-- Admin (authenticated) may trigger a sync from the browser; the public cannot.
revoke all on function public.run_sync(text, boolean) from anon;
grant execute on function public.run_sync(text, boolean) to authenticated;

-- ---------- STORAGE BUCKETS ----------
insert into storage.buckets (id, name, public) values ('designs','designs',true)
  on conflict (id) do nothing;
insert into storage.buckets (id, name, public) values ('order-photos','order-photos',true)
  on conflict (id) do nothing;

-- Admin manages design images; the public (checkout) may upload order photos.
drop policy if exists "admin write designs"    on storage.objects;
drop policy if exists "admin update designs"   on storage.objects;
drop policy if exists "admin delete designs"   on storage.objects;
drop policy if exists "anon upload order pics" on storage.objects;
create policy "admin write designs"    on storage.objects for insert to authenticated with check (bucket_id = 'designs');
create policy "admin update designs"   on storage.objects for update to authenticated using (bucket_id = 'designs');
create policy "admin delete designs"   on storage.objects for delete to authenticated using (bucket_id = 'designs');
create policy "anon upload order pics" on storage.objects for insert to anon, authenticated with check (bucket_id = 'order-photos');

-- Done. Public buckets serve files at:
--   https://<project>.supabase.co/storage/v1/object/public/<bucket>/<path>
