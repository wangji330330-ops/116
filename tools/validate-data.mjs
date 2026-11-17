import { readFile } from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';

const ROOT = path.resolve(import.meta.dirname, '..');
const geo = p => path.join(ROOT, 'data', 'geo', p);

const ctx = { window: {} };
vm.createContext(ctx);
vm.runInContext(await readFile(path.join(ROOT, 'data', 'gdp.js'), 'utf8'), ctx);
const { GDP_DATA, CAPITALS } = ctx.window;

const country = JSON.parse(await readFile(geo('100000_full.json'), 'utf8'));
const provNames = new Set(country.features.map(f => f.properties.name).filter(Boolean));
const provByAd = new Map(country.features.map(f => [f.properties.adcode, f]));

const allChildren = new Map(); // name -> {prov, level}
for (const f of country.features) {
  const p = f.properties;
  if (!(p.childrenNum > 0)) continue;
  const kids = JSON.parse(await readFile(geo(`${p.adcode}_full.json`), 'utf8'));
  for (const k of kids.features) {
    allChildren.set(k.properties.name, { prov: p.name, level: k.properties.level, adcode: k.properties.adcode });
  }
}

const problems = [];
const usedProv = new Set();

for (const n of Object.keys(GDP_DATA.province)) {
  usedProv.add(n);
  if (!provNames.has(n)) problems.push(`[province] 不存在: ${n}`);
}
for (const n of provNames) {
  if (n && !usedProv.has(n)) problems.push(`[province] 缺少: ${n}`);
}

const matchedCity = new Set();
for (const n of Object.keys(GDP_DATA.city)) {
  const hit = allChildren.get(n);
  if (!hit) { problems.push(`[city] 不在二级行政区中: ${n}`); continue; }
  matchedCity.add(n);
}
const allChildNames = [...allChildren.keys()];
const missingCity = allChildNames.filter(n => !matchedCity.has(n));

for (const [prov, cap] of Object.entries(CAPITALS)) {
  const provFeature = [...country.features].find(f => f.properties.name === prov);
  if (!provFeature || !(provFeature.properties.childrenNum > 0)) continue; // 台湾省等无下级面
  if (!allChildren.has(cap)) problems.push(`[capital] 找不到省会: ${prov} -> ${cap}`);
}

// 区县数据按 adcode 索引，键必须是数字
for (const k of Object.keys(GDP_DATA.county)) {
  if (!/^\d{6}$/.test(k)) problems.push(`[county] 键应为 6 位 adcode: ${k}`);
}

console.log('省级: %d/%d 匹配', usedProv.size, provNames.size);
console.log('二级: 已收录 %d / 几何中 %d，缺 %d', matchedCity.size, allChildNames.length, missingCity.length);
if (missingCity.length) {
  const byProv = {};
  for (const n of missingCity) {
    const p = allChildren.get(n).prov;
    (byProv[p] ||= []).push(n);
  }
  console.log('\n--- 未收录 GDP 的二级行政区 ---');
  for (const [p, arr] of Object.entries(byProv)) console.log(`${p}: ${arr.join('、')}`);
}
if (problems.length) {
  console.log('\n=== 问题 ===');
  for (const p of problems) console.log('  ' + p);
} else {
  console.log('\n✅ 无键名问题');
}
