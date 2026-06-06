/* ==================================================================
   CASEBARI — CONFIG
   ------------------------------------------------------------------
   This is the ONLY file you edit day-to-day. All data lives here:
   shop settings, case types & prices, phone list, and designs.
   index.html holds the logic and reads everything from CONFIG.
   Loaded before the app via <script src="config.js"></script>.
   ================================================================== */
const CONFIG = {

  /* ---- 1) SHOP SETTINGS ---- */
  // bKash/Nagad number shown on confirmation when customer picks digital pay.
  BKASH_NUMBER: "01XXXXXXXXX",
  // Delivery charges in taka. Picked live from the area radio.
  DELIVERY: { insideDhaka: 70, outsideDhaka: 130 },
  // Google Apps Script Web App URL. Empty until the backend is deployed.
  ORDER_ENDPOINT: "",
  // (Reserved) Google Sheet CSV URL for a live phone list. Empty = use PHONE_DB below.
  SHEET_CSV_URL: "",

  /* ---- 2) CASE TYPES & PRICES (taka) ----
     TPU and UV are always available. 2D/3D depend on the phone model. */
  CASE_TYPES: [
    { id:"tpu",  name:"TPU Soft",     price:249, always:true,  desc:"Flexible, slim, shock-friendly" },
    { id:"uv",   name:"UV Printed",   price:349, always:true,  desc:"Vivid print, glossy finish" },
    { id:"d2",   name:"2D Hard Case", price:449, always:false, desc:"Hard back, flat print" },
    { id:"d3",   name:"3D Hard Case", price:549, always:false, desc:"Print wraps the edges" },
  ],

  /* ---- 3) PHONE MODEL DATA — this is your sheet as JSON ----
     d2 / d3 = is 2D / 3D hard case available for this model?
     "aliases" helps the search match short or common typings. */
  PHONE_DB: [
    {name:"iPhone 11", aliases:["ip11"], d2:true,  d3:true},
    {name:"iPhone 12", aliases:["ip12"], d2:true,  d3:true},
    {name:"iPhone 13", aliases:["ip13"], d2:true,  d3:true},
    {name:"iPhone 14", aliases:["ip14"], d2:true,  d3:true},
    {name:"iPhone 15", aliases:["ip15"], d2:true,  d3:false},
    {name:"iPhone 16", aliases:["ip16"], d2:false, d3:false},
    {name:"Samsung Galaxy A05", aliases:["a05"], d2:true,  d3:false},
    {name:"Samsung Galaxy A15", aliases:["a15"], d2:true,  d3:true},
    {name:"Samsung Galaxy A25", aliases:["a25"], d2:true,  d3:false},
    {name:"Samsung Galaxy A54", aliases:["a54"], d2:true,  d3:true},
    {name:"Samsung Galaxy A55", aliases:["a55"], d2:true,  d3:true},
    {name:"Samsung Galaxy S23", aliases:["s23"], d2:true,  d3:true},
    {name:"Samsung Galaxy S24", aliases:["s24"], d2:true,  d3:false},
    {name:"Samsung Galaxy M14", aliases:["m14"], d2:true,  d3:false},
    {name:"Redmi Note 11", aliases:["note11"], d2:true,  d3:true},
    {name:"Redmi Note 12", aliases:["note12"], d2:true,  d3:true},
    {name:"Redmi Note 13", aliases:["note13"], d2:true,  d3:true},
    {name:"Redmi Note 13 Pro", aliases:["note13pro"], d2:true, d3:false},
    {name:"Redmi 12C", aliases:["12c"], d2:true,  d3:false},
    {name:"Redmi 13C", aliases:["13c"], d2:true,  d3:true},
    {name:"Redmi A3", aliases:[], d2:false, d3:false},
    {name:"Poco X6 Pro", aliases:["pocox6"], d2:true, d3:false},
    {name:"Poco M6", aliases:["pocom6"], d2:true, d3:false},
    {name:"Realme C53", aliases:["c53"], d2:true,  d3:true},
    {name:"Realme C55", aliases:["c55"], d2:true,  d3:true},
    {name:"Realme C65", aliases:["c65"], d2:true,  d3:false},
    {name:"Realme 11", aliases:[], d2:true,  d3:false},
    {name:"Realme Narzo 60", aliases:["narzo60"], d2:false, d3:false},
    {name:"Vivo Y17s", aliases:["y17s"], d2:true,  d3:false},
    {name:"Vivo Y27", aliases:["y27"], d2:true,  d3:true},
    {name:"Vivo Y36", aliases:["y36"], d2:true,  d3:false},
    {name:"Vivo V29", aliases:["v29"], d2:true,  d3:false},
    {name:"Oppo A58", aliases:["a58"], d2:true,  d3:true},
    {name:"Oppo A78", aliases:["a78"], d2:true,  d3:false},
    {name:"Oppo Reno 11", aliases:["reno11"], d2:true, d3:false},
    {name:"Infinix Hot 40", aliases:["hot40"], d2:true, d3:true},
    {name:"Infinix Note 40", aliases:["infnote40"], d2:true, d3:false},
    {name:"Infinix Smart 8", aliases:["smart8"], d2:true, d3:false},
    {name:"Tecno Spark 20", aliases:["spark20"], d2:true, d3:true},
    {name:"Tecno Camon 20", aliases:["camon20"], d2:true, d3:false},
    {name:"Symphony Z70", aliases:["z70"], d2:true, d3:false},
    {name:"Symphony Innova 30", aliases:["innova30"], d2:false, d3:false},
    {name:"Walton Primo H10", aliases:["primoh10"], d2:false, d3:false},
    {name:"Walton Xanon X20", aliases:["xanonx20"], d2:false, d3:false},
    {name:"Itel A70", aliases:["itela70"], d2:false, d3:false},
  ],

  /* ---- 4) PRESET DESIGNS ----
     In the demo these are CSS gradients + an emoji. In the real
     site each becomes an image URL of your uploaded design. */
  DESIGNS: [
    {id:"galaxy",  name:"Galaxy Night",  emoji:"🌌", css:"linear-gradient(160deg,#1b1340,#3b1d6e 45%,#0b2a52)"},
    {id:"marble",  name:"Pink Marble",   emoji:"🩷", css:"linear-gradient(135deg,#fbd3e0,#f7f1f3 40%,#f5b8cd 75%,#fff)"},
    {id:"bloom",   name:"Bloom",         emoji:"🌸", css:"linear-gradient(180deg,#FFF3E2,#FFD9E8)"},
    {id:"matte",   name:"Matte Black",   emoji:"🖤", css:"linear-gradient(160deg,#23262b,#0e0f11)"},
    {id:"waves",   name:"Retro Waves",   emoji:"🌊", css:"repeating-linear-gradient(135deg,#FF8C5A 0 14px,#FFC15E 14px 28px,#3FA796 28px 42px)"},
    {id:"cricket", name:"Cricket Fever", emoji:"🏏", css:"linear-gradient(160deg,#0B6E4F,#0B8C5D 55%,#BF1E2E)"},
    {id:"mina",    name:"Minimal Lines", emoji:"➿", css:"repeating-linear-gradient(0deg,#FBF5EA 0 18px,#211C15 18px 20px)"},
    {id:"sunset",  name:"Cox's Sunset",  emoji:"🌅", css:"linear-gradient(180deg,#2E3192 0%,#FF6B6B 55%,#FFD93D 100%)"},
  ],

};
