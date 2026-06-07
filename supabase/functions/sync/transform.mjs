// Pure, side-effect-free helpers — shared by index.ts and the Node test.
export function parseMaster(list){
  return (list || [])
    .map(p => ({ brand: String(p.brand || "").trim(), model: String(p.model || p.model_name || p.name || "").trim() }))
    .filter(p => p.model);
}

export function parseSheet(list){
  const avail = v => String(v == null ? "" : v).trim().toLowerCase() === "available";
  return (list || [])
    .map(p => ({
      brand: String(p.brand || "").trim(),
      model: String(p.modelName || p.model || "").trim(),
      avail_2d: avail(p.availability2D),
      avail_3d: avail(p.availability3D)
    }))
    .filter(p => p.model);
}

export function isDue(src, force, nowMs){
  if(force) return true;
  if(!src || !src.enabled) return false;
  if(!src.last_run_at) return true;
  const last = Date.parse(src.last_run_at);
  const days = (Number(src.frequency_days) || 1) * 86400000;
  return (nowMs - last) >= days;
}
