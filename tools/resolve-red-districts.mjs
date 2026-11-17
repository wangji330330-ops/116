/* 把红色场馆解析到「区 / 县」一级，供分层展开使用
 * 依据：场馆地址里通常包含所属区县全称
 * 用法: node tools/resolve-red-districts.mjs > red-districts.json
 */
import { readFile, writeFile } from 'node:fs/promises';
import vm from 'node:vm';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const GEO = path.join(ROOT, 'data', 'geo');

const ctx = { window: {} };
vm.createContext(ctx);
vm.runInContext(await readFile(path.join(ROOT, 'data', 'red-sites.js'), 'utf8'), ctx);
const SITES = ctx.window.RED_SITES;

const gd = JSON.parse(await readFile(path.join(GEO, '440000_full.json'), 'utf8'));
const cities = gd.features.map(f => ({ name: f.properties.name, adcode: String(f.properties.adcode) }));

const cityKids = new Map();
async function kidsOf(adcode) {
  if (cityKids.has(adcode)) return cityKids.get(adcode);
  let list = [];
  try {
    const j = JSON.parse(await readFile(path.join(GEO, `${adcode}_full.json`), 'utf8'));
    list = j.features.map(f => ({
      name: f.properties.name,
      adcode: String(f.properties.adcode),
      level: f.properties.level
    }));
  } catch (_) {}
  cityKids.set(adcode, list);
  return list;
}

const out = [];
let resolved = 0;
let towned = 0;

const TOWN_RE = /([\u4e00-\u9fa5]{2,4}(?:镇|街道|乡))/;

for (const s of SITES) {
  const city = cities.find(c => c.name === s.city);
  let district = null, districtAdcode = null;

  if (city) {
    const kids = await kidsOf(city.adcode);
    // 先按全称匹配；再退化到去掉「区/县/市」后缀的简称匹配（如「南雄」-> 南雄市）
    let best = null, bestLen = 0;
    for (const k of kids) {
      const full = k.name;
      const short = k.name.replace(/[区县市]$/, '');
      for (const cand of [full, short]) {
        if (cand && cand.length >= 2 && s.addr.includes(cand) && cand.length > bestLen) {
          best = k; bestLen = cand.length;
        }
      }
    }
    if (best) { district = best.name; districtAdcode = best.adcode; }
  }

  // 先把市名、区县名从地址里切断，剩下的片段再找乡镇 / 街道
  let rest = s.addr;
  if (city) rest = rest.split(city.name).join('|');
  if (district) {
    rest = rest.split(district).join('|');
    const short = district.replace(/[区县市]$/, '');
    if (short.length >= 2) rest = rest.split(short).join('|');
  }
  let town = null;
  const tm = TOWN_RE.exec(rest);
  if (tm) { town = tm[1]; towned++; }

  if (district) resolved++;
  out.push({
    name: s.name,
    city: s.city,
    cityAdcode: city ? city.adcode : null,
    district,
    districtAdcode,
    town,
    addr: s.addr
  });
}

console.log('total:', out.length, '| 解析到区县:', resolved, '| 识别到乡镇:', towned);
console.log('\n仍未解析到区县的:');
for (const o of out.filter(x => !x.district)) console.log('  %s | town=%s | %s', o.name, o.town || '-', o.addr);

await writeFile(path.join(ROOT, 'data', 'red-sites.resolved.json'), JSON.stringify(out, null, 1), 'utf8');
console.log('\n写入 data/red-sites.resolved.json');