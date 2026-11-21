/* 手工修正个别场所坐标（依据高德 POI 名称明确对应的点位） */
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const FIX = {
  // 广宁县南街街道其鉴路45号，其鉴纪念中学（中国工农红军广宁周其鉴红军中学）内
  '周其鉴纪念馆': { lng: 112.442889, lat: 23.638731, level: '兴趣点', matched: '中国工农红军广宁周其鉴红军中学（其鉴路45号）' }
};

const s = await readFile(path.join(ROOT, 'data', 'red-sites.geo.js'), 'utf8');
const DATA = JSON.parse(s.slice(s.indexOf('=') + 1).trim().replace(/;+$/, '').trim());

for (const v of DATA) {
  const f = FIX[v.name];
  if (!f) continue;
  v.lng = f.lng; v.lat = f.lat; v.level = f.level; v.matched = f.matched;
  console.log('修正:', v.name, '->', v.lng + ',' + v.lat);
}

await writeFile(path.join(ROOT, 'data', 'red-sites.geo.js'),
  'window.__RED_GEO=' + JSON.stringify(DATA) + ';\n', 'utf8');
console.log('已写入');