# Ad deep-link → preset design (+ shareable design links) — design

Date: 2026-06-07
Status: approved
Subsystem: A of 3 (A=ad deep-link, B=readymade-cases store, C=demos page)

## Problem

Most traffic will come from Facebook ads that show one design and an "Order now"
button. The click should land the user with that exact design already chosen, so
the flow from ad → order is as short as possible. Customers also want to share a
design link with friends before ordering. The store is a single custom-order flow
today (model → case → design); design lives at the bottom (step 3).

## Goal

`…/index.html?design=<id>` lands with the design preselected and pinned at the top;
the user then just picks phone + case and checks out (same checkout). Admin can copy
a per-design ad link; customers can share the selected design's link (native share
on mobile, clipboard otherwise). No backend/schema change — designs already live in
Supabase and are looked up by id.

## Behavior

### URL parameter
- `index.html?design=<id>` where `<id>` is the numeric `designs.id`.
- Extra params (e.g. `utm_*`) are ignored.

### Storefront on load (`index.html`)
1. After designs load from Supabase, read `?design=<id>`.
2. If a matching **active catalog design** is found:
   - Set `state.design = { kind:"preset", ...design }`.
   - Render a pinned banner at the top of the flow: **"Your design: 🖼 [name]"** with
     the design thumbnail, a **"change"** link, and a **"📤 Share design"** button.
   - Mark the design step as already done (the design grid still exists; "change"
     scrolls to / expands it).
   - Move the user's attention to **Step 1 (pick phone)** — flow is now
     design → model → case → Add to cart → checkout.
3. If the id is missing, not found, inactive, or invalid → ignore it and render the
   normal page (no breakage).

### Share / copy link
- The share action is available whenever a **catalog** design is selected — either
  preset from the URL or picked from the grid.
- Builds the link: `location.origin + <path-to-index> + "?design=" + id`.
- On tap:
  - If `navigator.share` exists (mobile): open the native share sheet with the URL
    (title = design name) → user shares to WhatsApp/Messenger/etc.
  - Else: copy the URL to the clipboard and show a "Link copied ✓" toast.
- A **custom uploaded** photo has no id/URL → the share button is hidden for uploads.

### Admin (`admin.html` → Designs)
- Each design card gets a **"Copy ad link"** button → copies
  `location.origin + "/index.html?design=" + id` to the clipboard (toast/inline "Copied ✓").
- Used to run a separate FB ad per design.

## Components touched
- `index.html` — param read on load; preset-design banner + "change"; share button
  + handler (native share / clipboard + toast); wire grid selection to enable share.
- `admin.html` — "Copy ad link" button on each design card in `loadDesigns()`.
- No `config.js` / schema / RPC changes.

## Edge cases
- Invalid / inactive / deleted `design` id → normal flow.
- `navigator.clipboard` unavailable (insecure context) → fall back to a temporary
  textarea + `execCommand('copy')`, or show the URL for manual copy.
- Selecting a different design (grid) after arriving via a link → banner + share link
  update to the new design.
- Custom upload selected → share hidden (no URL form).

## Testing
- `node --check` on both inline scripts.
- Manual: open `index.html?design=<validId>` → design pinned at top, step 1 focused;
  complete an order → design carries through to checkout/confirmation.
- Manual: `?design=999999` (bad id) → normal page, no errors.
- Manual: pick a grid design → share button copies/share-sheets the right link;
  open that link in a new tab → same design preset.
- Manual: custom upload → no share button.
- Admin: "Copy ad link" copies a working URL (paste in a new tab → preset).
