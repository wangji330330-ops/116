/* 校验 POI 匹配结果：若新坐标落在该场馆所属区县之外，则回退到旧坐标
 * 依据：我们本地有完整的区县边界数据，可做点面判定
 * 用法: node tools/validate-poi.mjs <旧数据文件>
 */
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const OLD_FILE = process.argv[2];
if (!OLD_FILE) { console.error('需要旧数据文件路径'); process.exit(1); }

const loadGlobal = async (file, name) => {
  const src = await readFile(file, 'utf8');
  const i = src.indexOf('=');
  return JSON.parse(src.slice(i + 1).trim().replace(/;\s*$/, ''));
};

const NOW = await loadGlobal(path.join(ROOT, 'data', 'red-sites.geo.js'), '__RED_GEO');
const OLD = await loadGlobal(OLD_FILE, '__RED_GEO');

/* 区县边界缓存 */
const GEO = {};
async function loadGeo(ad) {
  if (GEO[ad]) return GEO[ad];
  const ctx = { window: { __GEO_SET: (k, v) => { ctx.window.__v = v; } } };
  const src = await readFile(path.join(ROOT, 'data', 'geo', ad + '.js'), 'utf8');
  // 直接解析出对象：文件形如 window.__GEO_SET("440100",{...});
  const i = src.indexOf(',');
  const json = src.slice(i + 1).replace(/\);\s*$/, '');
  GEO[ad] = JSON.parse(json);
  return GEO[ad];
}

function inRing(pt, ring) {
  let ins = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1];
    if (((yi > pt[1]) !== (yj > pt[1])) && (pt[0] < (xj - xi) * (pt[1] - yi) / (yj - yi) + xi)) ins = !ins;
  }
  return ins;
}
function inFeature(pt, geom) {
  if (!geom) return false;
  const polys = geom.type === 'Polygon' ? [geom.coordinates] : geom.type === 'MultiPolygon' ? geom.coordinates : [];
  for (const poly of polys) {
    if (!poly.length) continue;
    if (!inRing(pt, poly[0])) continue;
    let hole = false;
    for (let r = 1; r < poly.length; r++) if (inRing(pt, poly[r])) { hole = true; break; }
    if (!hole) return true;
  }
  return false;
}

async function locateInDistrict(lng, lat, cityAd, distAd) {
  try {
    const fc = await loadGeo(String(cityAd));
    const f = fc.features.find(x => String(x.properties.adcode) === String(distAd));
    if (!f) return null;               // 该市无此区县（如东莞中山）
    return inFeature([lng, lat], f.geometry);
  } catch (_) { return null; }
}

let reverted = 0, kept = 0, unknown = 0;
const log = [];

for (const v of NOW) {
  const o = OLD.find(x => x.name === v.name);
  if (!o) continue;
  if (v.lng === o.lng && v.lat === o.lat) { kept++; continue; }

  if (!v.cityAdcode) { unknown++; continue; }

  // 新点是否在所属区县内
  let okNew = true;
  if (v.districtAdcode) {
    okNew = await locateInDistrict(v.lng, v.lat, v.cityAdcode, v.districtAdcode);
    if (okNew === null) okNew = true;   // 无该区县边界数据，放行
  }

  if (!okNew) {
    // 旧点是否在界内？旧点在界内则回退
    let okOld = true;
    if (v.districtAdcode) {
      okOld = await locateInDistrict(o.lng, o.lat, v.cityAdcode, v.districtAdcode);
      if (okOld === null) okOld = true;
    }
    if (okOld) {
      log.push(`回退 ${v.name}（新点越界）`);
      v.lng = o.lng; v.lat = o.lat;
      v.level = o.level; v.matched = o.matched;
      reverted++;
      continue;
    }
    log.push(`保留 ${v.name}（新旧皆越界，需人工核）`);
  }
  kept++;
}

await writeFile(path.join(ROOT, 'data', 'red-sites.geo.js'),
  'window.__RED_GEO=' + JSON.stringify(NOW) + ';\n', 'utf8');

console.log(`回退 ${reverted} 处，保留 ${kept} 处，无区县信息 ${unknown} 处`);
log.forEach(l => console.log('  ' + l));
const lv = {};
NOW.forEach(x => lv[x.level || '(空)'] = (lv[x.level || '(空)'] || 0) + 1);
console.log('精度分布：', JSON.stringify(lv));