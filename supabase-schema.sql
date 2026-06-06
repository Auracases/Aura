
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
