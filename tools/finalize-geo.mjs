/* 最后一道清洗：
 * 只有当 POI 匹配结果的地址里出现了「同市的其他区县名」，且没有出现本场馆所属区县时，才回退旧坐标。
 * 这样可以避免把「罗浮山风景名胜区」这类景区名误判成别的区县。
 */
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const OLD_FILE = process.argv[2];
const load = async f => {
  const s = await readFile(f, 'utf8');
  return JSON.parse(s.slice(s.indexOf('=') + 1).trim().replace(/;+$/, '').trim());
};

const NOW = await load(path.join(ROOT, 'data', 'red-sites.geo.js'));
const OLD = await load(OLD_FILE);

const CHILD = {};
async function children(cityAd) {
  if (CHILD[cityAd]) return CHILD[cityAd];
  try {
    const s = await readFile(path.join(ROOT, 'data', 'geo', String(cityAd) + '.js'), 'utf8');
    const json = s.slice(s.indexOf(',') + 1).replace(/\);\s*$/, '');
    const fc = JSON.parse(json);
    CHILD[cityAd] = fc.features.map(f => f.properties.name);
  } catch (_) { CHILD[cityAd] = []; }
  return CHILD[cityAd];
}

let reverted = 0;
const log = [];

for (const v of NOW) {
  const o = OLD.find(x => x.name === v.name);
  if (!o || !v.district || !v.cityAdcode) continue;
  if (v.lng === o.lng && v.lat === o.lat) continue;

  const m = v.matched || '';
  const kids = await children(v.cityAdcode);
  const own = v.district;
  const bare = (s) => s.replace(/[区县市]$/, '');

  const hitOwn = m.includes(own) || (bare(own).length >= 2 && m.includes(bare(own)));
  if (hitOwn) continue;

  const others = kids.filter(n => n && n !== own && (m.includes(n) || (bare(n).length >= 2 && bare(n) !== bare(own) && m.includes(bare(n)))));
  if (others.length) {
    v.lng = o.lng; v.lat = o.lat; v.level = o.level; v.matched = o.matched;
    reverted++;
    log.push(`${v.name}（应属 ${own}，匹配到 ${others.slice(0, 2).join('/')}）`);
  }
}

await writeFile(path.join(ROOT, 'data', 'red-sites.geo.js'),
  'window.__RED_GEO=' + JSON.stringify(NOW) + ';\n', 'utf8');

console.log(`回退 ${reverted} 处`);
log.forEach(l => console.log('  ' + l));
const lv = {};
NOW.forEach(x => lv[x.level || '(空)'] = (lv[x.level || '(空)'] || 0) + 1);
console.log('最终精度分布：', JSON.stringify(lv));