import assert from "node:assert";
import { norm, normalizeRows } from "../build-phones-master.mjs";

// norm matches the JS/SQL contract
assert.equal(norm("Redmi Note-12"), "redminote12");
assert.equal(norm("  iPhone 15 Pro "), "iphone15pro");

// normalizeRows: filters non-allowed brands, drops old years, dedupes by search_key,
// keeps {brand, model}, sorted by model.
const raw = [
  { brand: "Samsung", model: "Galaxy A15", year: 2024 },
  { brand: "Samsung", model: "galaxy a15", year: 2024 },   // dup by search_key
  { brand: "Nokia",   model: "Nokia 3310", year: 2000 },    // too old -> dropped
  { brand: "Foobar",  model: "Weird X1",  year: 2024 },     // brand not allowed -> dropped
  { brand: "Xiaomi",  model: "Redmi Note 13", year: 2023 }
];
const out = normalizeRows(raw, { minYear: 2018 });
assert.deepEqual(out, [
  { brand: "Samsung", model: "Galaxy A15" },
  { brand: "Xiaomi",  model: "Redmi Note 13" }
]);

console.log("build-phones-master transforms: PASS");
