# CaseBari — Supabase setup

CaseBari now runs on **Supabase** (free): a real database, image uploads, an
admin login, and a promo/discount system. The storefront (`index.html`) and the
admin (`admin.html`) are static files you can host anywhere — all data lives in
Supabase and is managed from the admin page (no code edits for day-to-day work).

You'll do five short steps once. Total time ~15 minutes.

---

## 1. Create the project
1. Go to **supabase.com** → sign up (free) → **New project**.
   - Name: `casebari`. Pick a strong database password (save it). Region: closest to you.
2. Wait for it to finish provisioning (~2 min).

## 2. Run the schema
1. Left sidebar → **SQL Editor** → **New query**.
2. Open `supabase-schema.sql` from this project, copy ALL of it, paste, **Run**.
3. It creates the tables, security rules, server functions, the two storage
   buckets (`designs`, `order-photos`), and seeds the default case prices + settings.
   "Success. No rows returned" is the expected result.

## 3. Connect the site
1. Left sidebar → **Project Settings → API**. Copy:
   - **Project URL** (e.g. `https://abcd1234.supabase.co`)
   - **anon public** key (the long one labelled `anon` / `public`)
   Both are safe to put in the browser — Row Level Security protects the data.
2. Open `config.js` and paste them in:
   ```js
   SUPABASE_URL:      "https://abcd1234.supabase.co",
   SUPABASE_ANON_KEY: "eyJhbGciOi...your-anon-key...",
   ```
3. Save.

## 4. Create your admin login
1. Left sidebar → **Authentication → Providers → Email**: turn **OFF**
   "Allow new users to sign up" (so only you can log in). Save.
2. **Authentication → Users → Add user → Create new user**.
   Enter your email + a password, and tick **Auto Confirm User**. Create.
   This is the only account that can open the admin or change data.

## 5. Import your phones (one-time)
1. Open `admin.html` in a browser → log in with the user from step 4.
2. Go to the **Phones** tab → click **Import phones from old sheet**.
   It pulls your existing Google Sheets list (`LEGACY_PHONES_URL` in `config.js`),
   cleans + de-duplicates it, and loads it into Supabase. Wait for "Imported N ✓".

Done. The old Google Sheet / Apps Script is no longer used.

---

## Day-to-day — everything from `admin.html`

- **Designs** — upload an image + name + context; it goes straight to storage and
  appears on the storefront. Hide/show or remove anytime. No git, no redeploy.
- **Orders** — every order with customer details, items, photo links, totals, and
  a Status dropdown (New → Processing → Shipped → Delivered → Cancelled).
- **Promos** — create codes: `% off`, flat amount off, or free delivery, with
  min-order, a cap, an expiry, and a usage limit. Toggle on/off; see how many times used.
- **Pricing & Settings** — edit each case price + description, the bKash/Nagad
  number, delivery charges, and a **store-wide sale** (percent or flat, with a label).
- **Phones** — search/add/edit model availability (or bulk-edit in the Supabase
  dashboard → Table editor → `phones`).

You can also edit any table directly in the Supabase dashboard (**Table editor**).

---

## How discounts combine
1. The **store-wide sale** (if active) comes off the subtotal first.
2. A **promo code** then applies to what's left (free-delivery promos zero the
   delivery instead). Totals are always recomputed **on the server** when an order
   is placed, so prices can't be tampered with in the browser.

## Notes
- The storefront caches the phone list in the browser for 24h (`AVAIL_TTL_MS` in
  `config.js`) so repeat visits are instant. Designs/prices/settings load fresh
  each visit. To see catalog changes immediately, hard-refresh.
- Buckets are public-read (image links work for anyone with the URL). Uploading
  designs requires the admin login; uploading order photos is allowed for the
  checkout flow only.
