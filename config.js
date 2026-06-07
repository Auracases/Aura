/* ==================================================================
   CASEBARI — CONFIG
   ------------------------------------------------------------------
   All shop data (phones, designs, prices, settings, promos, orders)
   lives in Supabase and is managed from admin.html. This file only
   holds the connection keys + small offline fallbacks.
   Loaded before the app via <script src="config.js"></script>.
   See SETUP-supabase.md to fill in the two Supabase values.
   ================================================================== */
const CONFIG = {

  /* ---- 1) SUPABASE CONNECTION ----
     Both values are safe to ship in the browser (the anon key is
     public by design; Row Level Security protects the data).
     Get them from: Supabase -> Project Settings -> API. */
  SUPABASE_URL:      "https://nhthcgipbrmqtvuswnls.supabase.co",
  SUPABASE_ANON_KEY: "sb_publishable_pIcrocyhJw66M_e5_NKbsw_5jD4cy5a",

  /* ---- 2) PHONE LIST CACHE ----
     The phone availability list (400+ rows) is fetched once, then
     cached in the browser for this long so repeat visits don't refetch. */
  AVAIL_TTL_MS: 24 * 60 * 60 * 1000,   // 24 hours

  /* ---- 3) AVAILABILITY SHEET ----
     The Google Apps Script endpoint that serves the 2D/3D availability
     list as JSON. The browser no longer fetches this directly — it is
     stored in sync_sources.source_url and pulled server-side by the
     `sync` Edge Function. Kept here for reference/setup only. */
  AVAIL_SHEET_URL: "https://script.google.com/macros/s/AKfycbybV45O71NzZc10ObuWHXdjzJDaqfN-T92WnZQrRqUOlhTCStVMVvrPcdbHE2jQq6zQ/exec",

  /* ---- 4) OFFLINE FALLBACKS ----
     Shown only if Supabase can't be reached, so the page still renders.
     The live values come from the case_types / settings / designs tables. */
  FALLBACK: {
    DELIVERY: { insideDhaka: 70, outsideDhaka: 130 },
    BKASH_NUMBER: "01XXXXXXXXX",
    CASE_TYPES: [
      { id:"tpu", name:"(UV) TPU Soft",          price:249, always_available:true,  requires:null, descr:"UV-printed, flexible & slim" },
      { id:"uv",  name:"Premium Silicone Cases", price:349, always_available:true,  requires:null, descr:"Soft-touch silicone, premium feel" },
      { id:"d2",  name:"2D Hard Case", price:449, always_available:false, requires:"2d", descr:"Hard back, flat print" },
      { id:"d3",  name:"3D Hard Case", price:549, always_available:false, requires:"3d", descr:"Print wraps the edges" },
    ],
    DESIGNS: [],   // no preset designs offline; real ones come from Supabase
  },

};
