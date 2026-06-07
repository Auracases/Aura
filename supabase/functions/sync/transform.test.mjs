import assert from "node:assert";
import { parseMaster, parseSheet, isDue } from "./transform.mjs";

// master: pass-through of {brand, model}, drop empties
assert.deepEqual(
  parseMaster([{brand:"Samsung",model:"Galaxy A15"},{model:""},{model:"iPhone 15"}]),
  [{brand:"Samsung",model:"Galaxy A15"},{brand:"",model:"iPhone 15"}]
);

// sheet: Apps Script shape -> {brand, model, avail_2d, avail_3d}; "available" => true
assert.deepEqual(
  parseSheet([
    { modelName:"Galaxy A15", brand:"Samsung", availability2D:"Available", availability3D:"no" },
    { modelName:"", brand:"x", availability2D:"available", availability3D:"available" }
  ]),
  [{ brand:"Samsung", model:"Galaxy A15", avail_2d:true, avail_3d:false }]
);

// isDue: force always true; disabled false; else now - last >= freq days
const DAY = 86400000, now = 1_000_000_000_000;
assert.equal(isDue({enabled:false, frequency_days:1, last_run_at:null}, false, now), false);
assert.equal(isDue({enabled:true,  frequency_days:1, last_run_at:null}, false, now), true);
assert.equal(isDue({enabled:true,  frequency_days:3, last_run_at:new Date(now-DAY).toISOString()}, false, now), false);
assert.equal(isDue({enabled:false, frequency_days:3, last_run_at:null}, true,  now), true); // force overrides
console.log("sync transforms: PASS");
