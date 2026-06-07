# Demos page (case-type galleries, images + video) — design

Date: 2026-06-07
Status: approved
Subsystem: C of 3

## Goal
A beautiful, brand-matched showcase page (`demos.html`) where customers tap a case
type (TPU / UV / 2D / 3D / Custom) and see a gallery of demo **images and videos**
for it. Videos never autoplay and never force-fullscreen (inline, tap-to-play).
Admin manages all content from a new "Demos" tab.

## Data
New table:
```sql
create table public.demos (
  id bigint generated always as identity primary key,
  case_key   text not null,                    -- tpu|uv|d2|d3|custom
  media_type text not null default 'image',    -- image|video
  url        text not null,
  caption    text default '',
  sort       int  default 0,
  active     boolean default true,
  created_at timestamptz default now()
);
```
RLS: public `select`; admin (authenticated) all. Media stored in the existing
`designs` bucket under a `demos/` path (avoids new bucket policy setup).

## demos.html (new page)
- Loads `config.js` + supabase-js. Fetches `case_types` (for labels/prices/order)
  and `demos` (active). Brand styling copied from `index.html` (fonts, colors, cards).
- Header with logo + an "Order now" button → `index.html`.
- **Pills** across the top: one per case type from `case_types` (sorted) + a "Custom"
  pill. Tapping a pill shows that type's short description + price and swaps the
  gallery below.
- **Gallery grid** (responsive, mobile-first):
  - Image item: `<img loading="lazy">` with a CSS fade-in on load.
  - Video item: `<video controls playsinline preload="metadata">` (shows first frame),
    **no autoplay**, `playsinline` (no iOS forced-fullscreen); a ▶ overlay until played.
  - Tap an item's expand control → fullscreen lightbox (image, or video with controls,
    still `playsinline`).
  - Empty type → friendly "No demos yet" message.
- Default pill = first case type; gallery swaps instantly (media cached after first view).

## admin.html — new "Demos" tab
- Add form: case-type select (tpu/uv/d2/d3/custom), media source = **upload a file
  (image or video)** OR **paste a direct URL**, optional caption + sort.
  - `media_type` auto-detected from the file MIME / URL extension (video/* → video).
  - Images compressed via existing `compressImage`; videos uploaded as-is (with a
    size hint — Storage free tier is 1 GB; keep clips small).
  - Upload path: `designs` bucket, `demos/<ts>-<rand>.<ext>`, `upsert:false`.
- List (grouped or filterable by case type): thumbnail/▶, caption, sort, show/hide,
  delete (also removes the storage object for uploads).

## Reuses / no-new-bucket
- Lightbox + media patterns shared with the storefront where practical (demos.html is
  standalone but mirrors the look).
- `designs` storage bucket (admin already has write policy there).

## Edge cases
- Video that fails to load → poster/placeholder, no crash.
- External URL (not in our bucket) → used as-is; delete only removes DB row.
- No demos for a type → empty-state message.

## Testing
- `node --check` inline scripts of `demos.html` + `admin.html`.
- Manual: add an image demo + a video demo to a type in admin → appears in demos.html
  under that pill; video does not autoplay, plays inline (no forced fullscreen);
  lightbox opens; "Order now" links to store; pills swap galleries; empty type shows
  empty-state.
