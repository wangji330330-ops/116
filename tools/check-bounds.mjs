/* 全量体检：检查每个场馆坐标是否落在其所属区县多边形内 */
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const s = await readFile(path.join(ROOT, 'data', 'red-sites.geo.js'), 'utf8');
const DATA = JSON.parse(s.slice(s.indexOf('=') + 1).trim().replace(/;+$/, '').trim());

const CACHE = {};
async function geo(cityAd) {
  if (CACHE[cityAd]) return CACHE[cityAd];
  try {
    const t = await readFile(path.join(ROOT, 'data', 'geo', String(cityAd) + '.js'), 'utf8');
    CACHE[cityAd] = JSON.parse(t.slice(t.indexOf(',') + 1).replace(/\);\s*$/, ''));
  } catch (_) { CACHE[cityAd] = null; }
  return CACHE[cityAd];
}

function inRing(pt, ring) {
  let ins = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1];
    if (((yi > pt[1]) !== (yj > pt[1])) && (pt[0] < (xj - xi) * (pt[1] - yi) / (yj - yi) + xi)) ins = !ins;
  }
  return ins;
}
function inGeom(pt, g) {
  if (!g) return false;
  const polys = g.type === 'Polygon' ? [g.coordinates] : g.type === 'MultiPolygon' ? g.coordinates : [];
  for (const poly of polys) {
    if (!poly.length) continue;
    if (!inRing(pt, poly[0])) continue;
    let hole = false;
    for (let r = 1; r < poly.length; r++) if (inRing(pt, poly[r])) { hole = true; break; }
    if (!hole) return true;
  }
  return false;
}

const bad = [], ok = [], unknown = [];

for (const v of DATA) {
  if (!v.cityAdcode) { unknown.push(v); continue; }
  const fc = await geo(v.cityAdcode);
  if (!fc) { unknown.push(v); continue; }

  const cityF = fc.features.find(f => String(f.properties.adcode) === String(v.cityAdcode));
  const distF = v.districtAdcode ? fc.features.find(f => String(f.properties.adcode) === String(v.districtAdcode)) : null;

  const pt = [v.lng, v.lat];
  if (distF) (inGeom(pt, distF.geometry) ? ok : bad).push(v);
  else if (cityF) (inGeom(pt, cityF.geometry) ? ok : bad).push(v);   // 东莞/中山等不设区，按市判
  else unknown.push(v);
}

console.log(`在界内 ${ok.length}　越界 ${bad.length}　无法判定 ${unknown.length}`);
if (bad.length) {
  console.log('\n越界清单：');
  bad.forEach(v => console.log(`  ${v.name.slice(0, 18).padEnd(20)} 应属 ${v.district || v.city}　实际 ${v.lng},${v.lat}　[${v.level}] ${(v.matched || '').slice(0, 26)}`));
}
await writeFile(path.join(ROOT, '..', 'preview', 'out-of-bound.txt'),
  bad.map(v => `${v.name}\t${v.district || v.city}\t${v.lng},${v.lat}\t${v.level}\t${v.matched || ''}`).join('\n'), 'utf8');