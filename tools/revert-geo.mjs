/* 个别场所 POI 匹配错误，回退到地址地理编码结果（其地址本身已指向该村 / 该镇） */
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const OLD_FILE = process.argv[2];
const load = async f => {
  const s = await readFile(f, 'utf8');
  return JSON.parse(s.slice(s.indexOf('=') + 1).trim().replace(/;+$/, '').trim());
};

const FIX = [
  '周其鉴纪念馆',            // POI 落到端州区城东，实际在广宁县其鉴纪念中学内
  '广东南路革命化州纪念馆'      // POI 落到化州城区，实际在笪桥镇柑村
];

const NOW = await load(path.join(ROOT, 'data', 'red-sites.geo.js'));
const OLD = await load(OLD_FILE);

for (const v of NOW) {
  if (!FIX.includes(v.name)) continue;
  const o = OLD.find(x => x.name === v.name);
  if (!o) continue;
  v.lng = o.lng; v.lat = o.lat; v.level = o.level; v.matched = o.matched;
  console.log('回退:', v.name, '->', v.lng + ',' + v.lat, '|', v.level);
}

await writeFile(path.join(ROOT, 'data', 'red-sites.geo.js'),
  'window.__RED_GEO=' + JSON.stringify(NOW) + ';\n', 'utf8');
console.log('已写入');