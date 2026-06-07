/* ==================================================================
   AURA CASES — ANALYTICS
   ------------------------------------------------------------------
   One shared file for Google Analytics 4 + Meta (Facebook) Pixel.
   Loaded in the <head> of the customer pages (index / shop / demos),
   NOT in admin.html (we don't track the owner's own visits).

   - Loads GA4 + Pixel and fires a PageView on every page.
   - Auto-tracks scroll depth (25/50/75/100%) once per page.
   - Exposes window.track(name, params) to fire a conversion event to
     BOTH GA4 and the Pixel at once (used by the page's inline JS).

   IDs are public by design (they live in client-side code on every
   analytics setup) — safe to commit.
   ================================================================== */
(function () {
  var GA_ID        = "G-TR40T51EC7";        // Google Analytics 4 Measurement ID
  var FB_PIXEL_ID  = "1003325708911348";    // Meta (Facebook) Pixel ID
  var CLARITY_ID   = "x3gzriv05s";          // Microsoft Clarity project ID (heatmaps + session replay)

  /* ---- Google Analytics 4 (gtag.js) ---- */
  if (GA_ID) {
    var s = document.createElement("script");
    s.async = true;
    s.src = "https://www.googletagmanager.com/gtag/js?id=" + GA_ID;
    document.head.appendChild(s);
    window.dataLayer = window.dataLayer || [];
    window.gtag = function () { window.dataLayer.push(arguments); };
    window.gtag("js", new Date());
    window.gtag("config", GA_ID);
  }

  /* ---- Meta (Facebook) Pixel ---- */
  if (FB_PIXEL_ID) {
    !function (f, b, e, v, n, t, s) {
      if (f.fbq) return; n = f.fbq = function () {
        n.callMethod ? n.callMethod.apply(n, arguments) : n.queue.push(arguments);
      };
      if (!f._fbq) f._fbq = n; n.push = n; n.loaded = !0; n.version = "2.0";
      n.queue = []; t = b.createElement(e); t.async = !0;
      t.src = v; s = b.getElementsByTagName(e)[0]; s.parentNode.insertBefore(t, s);
    }(window, document, "script", "https://connect.facebook.net/en_US/fbevents.js");
    window.fbq("init", FB_PIXEL_ID);
    window.fbq("track", "PageView");
  }

  /* ---- Microsoft Clarity (heatmaps + session replay) ----
     Lazy-loaded ~2.5s after the page settles so it never competes with
     content/images on first paint. Async, masks text/inputs by default. */
  if (CLARITY_ID) {
    var loadClarity = function () {
      (function (c, l, a, r, i, t, y) {
        c[a] = c[a] || function () { (c[a].q = c[a].q || []).push(arguments); };
        t = l.createElement(r); t.async = 1; t.src = "https://www.clarity.ms/tag/" + i;
        y = l.getElementsByTagName(r)[0]; y.parentNode.insertBefore(t, y);
      })(window, document, "clarity", "script", CLARITY_ID);
    };
    if (document.readyState === "complete") setTimeout(loadClarity, 2500);
    else window.addEventListener("load", function () { setTimeout(loadClarity, 2500); });
  }

  /* ---- Standard Meta Pixel event names (everything else = custom) ---- */
  var FB_STANDARD = {
    PageView: 1, ViewContent: 1, Search: 1, AddToCart: 1, AddToWishlist: 1,
    InitiateCheckout: 1, AddPaymentInfo: 1, Purchase: 1, Lead: 1,
    CompleteRegistration: 1, Contact: 1
  };

  /* ---- Pixel name -> GA4 canonical ecommerce name ----
     GA4's built-in reports use these lowercase names. */
  var GA_MAP = {
    ViewContent: "view_item", Search: "search", AddToCart: "add_to_cart",
    InitiateCheckout: "begin_checkout", Purchase: "purchase", Scroll: "scroll"
  };

  /* ---- Unified tracker: send one event to BOTH GA4 and the Pixel ----
     track("Purchase", { value: 549, currency: "BDT", order_id: "CB..." }) */
  window.track = function (name, params) {
    params = params || {};
    try {
      if (window.gtag) {
        var gaName = GA_MAP[name] || name;
        var gaParams = {}; for (var k in params) gaParams[k] = params[k];
        if (name === "Purchase" && params.order_id) gaParams.transaction_id = params.order_id;
        window.gtag("event", gaName, gaParams);
      }
    } catch (e) {}
    try {
      if (window.fbq) {
        // eventID lets the browser Purchase de-dupe against the server-side
        // (CAPI) Purchase fired from the order DB trigger with the same order_id.
        var eid = params.event_id || params.order_id;
        var opts = eid ? { eventID: String(eid) } : undefined;
        if (FB_STANDARD[name]) window.fbq("track", name, params, opts);
        else window.fbq("trackCustom", name, params, opts);
      }
    } catch (e) {}
  };

  /* ---- Auto scroll-depth: fire each milestone once per page ---- */
  var hit = {};
  function onScroll() {
    var doc = document.documentElement;
    var scrolled = (doc.scrollTop || document.body.scrollTop);
    var height = (doc.scrollHeight || document.body.scrollHeight) - doc.clientHeight;
    if (height <= 0) return;
    var pct = Math.round((scrolled / height) * 100);
    [25, 50, 75, 100].forEach(function (m) {
      if (pct >= m && !hit[m]) {
        hit[m] = true;
        window.track("Scroll", { percent: m, page: location.pathname });
      }
    });
  }
  window.addEventListener("scroll", onScroll, { passive: true });
})();
