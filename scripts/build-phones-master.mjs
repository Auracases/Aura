// Offline generator: curated BD-market data -> data/phones-master.json
// Primary source: data/bd-current-models.json (curated from mobiledokan.com + knowledge, 2021-2026)
// Supplements: data/local-brands-supplement.json, data/recent-models-supplement.json
// Usage: node scripts/build-phones-master.mjs
//   Optional: node scripts/build-phones-master.mjs <extra-raw.json|raw.csv>  (merged in addition)
// raw rows need at least: brand, model. Optional: year (number or "2023").
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export function norm(s){ return String(s||"").toLowerCase().replace(/[^a-z0-9]/g,""); }

// Brands big in Bangladesh (lowercased norm of brand for matching).
const ALLOWED = new Set([
  "samsung","xiaomi","redmi","poco","realme","vivo","oppo","apple","iphone",
  "infinix","tecno","itel","oneplus","motorola","nokia","honor","huawei",
  "symphony","walton","google","pixel"
].map(norm));

function brandAllowed(brand, model){
  const b = norm(brand), m = norm(model);
  if(ALLOWED.has(b)) return true;
  // Some datasets put brand in the model string (e.g. Apple -> "iPhone 15").
  for(const a of ALLOWED){ if(m.startsWith(a)) return true; }
  return false;
}

function yearOf(row){
  const y = parseInt(String(row.year ?? row.released ?? "").match(/\d{4}/)?.[0] ?? "", 10);
  return Number.isFinite(y) ? y : null;
}

export function normalizeRows(rows, { minYear = 2018 } = {}){
  const seen = new Set();
  const out = [];
  for(const r of rows || []){
    const brand = String(r.brand || "").trim();
    const model = String(r.model || r.model_name || r.name || "").trim();
    if(!model) continue;
    if(!brandAllowed(brand, model)) continue;
    const y = yearOf(r);
    if(y !== null && y < minYear) continue;   // unknown year is kept
    const key = norm(model);
    if(!key || seen.has(key)) continue;
    seen.add(key);
    out.push({ brand, model });
  }
  out.sort((a,b) => a.model.localeCompare(b.model));
  return out;
}

function readRaw(file){
  const txt = fs.readFileSync(file, "utf8");
  if(file.endsWith(".json")) return JSON.parse(txt);
  // minimal CSV: header row with brand,model[,year]
  const [head, ...lines] = txt.split(/\r?\n/).filter(Boolean);
  const cols = head.split(",").map(s => s.trim().toLowerCase());
  return lines.map(line => {
    const cells = line.split(",");
    const o = {};
    cols.forEach((c,i) => o[c] = (cells[i]||"").trim());
    return o;
  });
}

function main(){
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const dataDir = path.join(__dirname, "..", "data");

  // Primary source: curated BD-market list (replaces the stale raw GSMArena dump).
  const bdPath = path.join(dataDir, "bd-current-models.json");
  const bdCurrent = JSON.parse(fs.readFileSync(bdPath, "utf8"));

  // Supplements kept for any models not already in bdCurrent.
  const supPath = path.join(dataDir, "local-brands-supplement.json");
  const supplement = JSON.parse(fs.readFileSync(supPath, "utf8"));
  const recPath = path.join(dataDir, "recent-models-supplement.json");
  const recent = JSON.parse(fs.readFileSync(recPath, "utf8"));

  // Optional extra raw file (legacy path, still usable for one-off additions).
  const rawFile = process.argv[2];
  const extra = rawFile ? readRaw(rawFile) : [];
  if(rawFile) console.log(`Merging extra raw file: ${rawFile} (${extra.length} rows)`);

  // bd-current-models.json rows have no year field; treat as "current" (year unknown = kept).
  // Supplements may have year; minYear:2019 prunes very old clutter but keeps unknowns.
  const merged = normalizeRows([...bdCurrent, ...supplement, ...recent, ...extra], { minYear: 2019 });
  const outPath = path.join(dataDir, "phones-master.json");
  fs.writeFileSync(outPath, JSON.stringify(merged, null, 0));
  console.log(`Wrote ${merged.length} models -> ${outPath}`);
}

// Run main() only when invoked directly (not when imported by the test).
if(process.argv[1] && process.argv[1].endsWith("build-phones-master.mjs")) main();
