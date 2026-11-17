/* 把 data 里的 JSON 转成 <script> 可直接加载的 .js
 * 目的：双击 index.html 即可运行，不再需要本地服务器（file:// 下 fetch 本地 JSON 会被浏览器拦截）
 * 用法: node tools/build-jsdata.mjs
 */
import { readFile, writeFile, readdir, unlink } from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const GEO = path.join(ROOT, 'data', 'geo');
const DATA = path.join(ROOT, 'data');

/* 1) 行政区划边界：data/geo/<adcode>.json -> .js */
let geoCount = 0;
for (const f of (await readdir(GEO)).filter(x => x.endsWith('.json'))) {
  const key = path.basename(f, '.json');
  const raw = await readFile(path.join(GEO, f), 'utf8');
  JSON.parse(raw);
  await writeFile(path.join(GEO, key + '.js'),
    `window.__GEO_SET(${JSON.stringify(key)},${raw});\n`, 'utf8');
  await unlink(path.join(GEO, f));
  geoCount++;
}

/* 2) 场馆坐标与归属 */
for (const [file, name] of [
  ['red-sites.geo.json', '__RED_GEO'],
  ['red-sites.resolved.json', '__RED_RESOLVED']
]) {
  const src = path.join(DATA, file);
  const raw = await readFile(src, 'utf8');
  JSON.parse(raw);
  await writeFile(path.join(DATA, file.replace('.json', '.js')),
    `window.${name}=${raw};\n`, 'utf8');
  await unlink(src);
  console.log(`  ${file} -> ${file.replace('.json', '.js')}`);
}

console.log(`geo: ${geoCount} 个边界文件已转为 .js`);
console.log('完成：现在可以直接双击 index.html 打开');