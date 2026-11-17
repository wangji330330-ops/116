/* 下载全部「地级市 / 州」级行政区划边界，打包进 data/geo/
 * 目的：避免运行时依赖第三方接口（DataV 对 github.io 来源返回 403）
 * 用法: node tools/fetch-geo-districts.mjs
 */
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const OUT = path.join(ROOT, 'data', 'geo');
const BASE = 'https://geo.datav.aliyun.com/areas_v3/bound';
await mkdir(OUT, { recursive: true });

const country = JSON.parse(await readFile(path.join(OUT, '100000_full.json'), 'utf8'));

// 收集需要下钻的第二级单元（childrenNum > 0 才有下级面）
const targets = [];
for (const f of country.features) {
  const p = f.properties;
  if (!(p.childrenNum > 0)) continue;
  const file = path.join(OUT, `${p.adcode}_full.json`);
  if (!existsSync(file)) continue;
  const prov = JSON.parse(await readFile(file, 'utf8'));
  for (const c of prov.features) {
    if (c.properties.childrenNum > 0) targets.push(c.properties);
  }
}

const unique = [...new Map(targets.map(t => [t.adcode, t])).values()];
console.log('第二级单元需下钻:', unique.length);

async function grab(url, tries = 3) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36',
          'Referer': 'https://datav.aliyun.com/'
        }
      });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return await r.text();
    } catch (e) {
      if (i === tries - 1) throw e;
      await new Promise(s => setTimeout(s, 500 * (i + 1)));
    }
  }
}

let ok = 0, skip = 0, fail = [];
for (let i = 0; i < unique.length; i += 6) {
  const batch = unique.slice(i, i + 6);
  await Promise.all(batch.map(async t => {
    const target = path.join(OUT, `${t.adcode}_full.json`);
    if (existsSync(target)) { skip++; return; }
    try {
      const txt = await grab(`${BASE}/${t.adcode}_full.json`);
      JSON.parse(txt);
      await writeFile(target, txt, 'utf8');
      ok++;
    } catch (e) {
      fail.push(`${t.name}(${t.adcode}): ${e.message}`);
    }
  }));
  if ((i / 6) % 8 === 0) console.log(`  进度 ${Math.min(i + 6, unique.length)}/${unique.length}  新增 ${ok} 跳过 ${skip} 失败 ${fail.length}`);
}

console.log(`\n完成：新增 ${ok}，已存在 ${skip}，失败 ${fail.length}`);
if (fail.length) console.log('失败列表:\n' + fail.join('\n'));
