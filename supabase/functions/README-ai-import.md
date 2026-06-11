# AI Product Import — Edge Functions (SP4)

Two Supabase Edge Functions power the admin **✨ AI import** button (Shop tab):

| Function | Input | Returns |
|---|---|---|
| `import-product` | `{ url }` (a single product page) | `{ ok, source:'jsonld'\|'ai', product:{ name, description, price, original_price, images[] } }` |
| `list-category`  | `{ url }` (a listing/category page) | `{ ok, source:'ai', items:[ { name, price, url, image } ], note? }` |

Both are **admin-gated**: they run `is_admin()` *as the caller* (using the browser's
auth JWT), so only a logged-in admin can invoke them. The OpenAI key lives only as a
function secret — it is never in the front-end bundle.

`import-product` tries **JSON-LD `Product` schema first** (free + exact). If the page has
none, it sends cleaned, truncated page text + candidate image URLs to **GPT-4o-mini** with a
strict JSON instruction. `list-category` scrapes anchors + images and asks GPT-4o-mini to
keep only real products.

> ⚠️ Server `fetch` cannot run a page's JavaScript. JS-rendered / SPA stores may return
> nothing — the admin UI says so when that happens.

## Deploy

Prerequisites: [Supabase CLI](https://supabase.com/docs/guides/cli) installed and logged in
(`supabase login`), and the project ref (Project Settings → General).

```bash
# from the repo root
supabase link --project-ref nhthcgipbrmqtvuswnls      # one-time

# 1) set the OpenAI key as a function secret (never committed)
supabase secrets set OPENAI_API_KEY=sk-...your-key...

# 2) deploy both functions
supabase functions deploy import-product
supabase functions deploy list-category
```

`SUPABASE_URL` and `SUPABASE_ANON_KEY` are injected by the platform automatically — you do
**not** set those. `is_admin()` (defined in `supabase-schema.sql`) must exist first.

### Verify

In `admin.html` → **Shop** → **✨ AI import**:
- *Single product*: paste a product URL → **Fetch** → review → **Open in product editor**.
- *Category page*: paste a listing URL → **Fetch** → tick rows, set a category → **Import selected**.

A `403 forbidden` means you're not signed in as admin; a `500 OPENAI_API_KEY not set`
means the secret step was skipped.

## Cost

GPT-4o-mini is inexpensive (fractions of a cent per page). JSON-LD hits cost nothing
(no model call). Pages are truncated (~12k chars) before sending to cap token use.

## Files

- `import-product/index.ts`
- `list-category/index.ts`

(The existing `sync/` function is unrelated — phone availability sync.)
