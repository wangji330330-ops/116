/* 修正 geo 数据文件名：<adcode>_full.js -> <adcode>.js，并同步注册表键名 */
import { readdir, readFile, writeFile, unlink } from 'node:fs/promises';
import path from 'node:path';

const dir = path.resolve(import.meta.dirname, '..', 'data', 'geo');
const files = (await readdir(dir)).filter(f => f.endsWith('_full.js'));
let n = 0;

for (const f of files) {
  const ad = f.replace('_full.js', '');
  const src = path.join(dir, f);
  let s = await readFile(src, 'utf8');
  const from = `window.__GEO_SET(${JSON.stringify(ad + '_full')},`;
  const to = `window.__GEO_SET(${JSON.stringify(ad)},`;
  if (s.startsWith(from)) s = to + s.slice(from.length);
  await writeFile(path.join(dir, ad + '.js'), s, 'utf8');
  await unlink(src);
  n++;
}

console.log(`重命名 ${n} 个文件`);
const left = await readdir(dir);
console.log('现有文件示例:', left.slice(0, 6).join(', '));
console.log('还剩 _full 文件:', left.filter(x => x.includes('_full')).length);