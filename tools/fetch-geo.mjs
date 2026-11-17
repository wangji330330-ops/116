// Download DataV boundary GeoJSON for country + every province.
// Run: node tools/fetch-geo.mjs
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const OUT = path.join(ROOT, 'data', 'geo');
const BASE = 'https://geo.datav.aliyun.com/areas_v3/bound';

const AD = [
  110000,120000,130000,140000,150000,210000,220000,230000,
  310000,320000,330000,340000,350000,360000,370000,
  410000,420000,430000,440000,450000,460000,
  500000,510000,520000,530000,540000,
  610000,620000,630000,640000,650000,
  710000,810000,820000
];

await mkdir(OUT, { recursive: true });

async function grab(url, tries = 3) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return await r.text();
    } catch (e) {
      if (i === tries - 1) throw e;
      await new Promise(s => setTimeout(s, 800));
    }
  }
}

// 1) country
const countryPath = path.join(OUT, '100000_full.json');
const countryTxt = await grab(`${BASE}/100000_full.json`);
await writeFile(countryPath, countryTxt, 'utf8');
const country = JSON.parse(countryTxt);
console.log('country: %d features, %d KB', country.features.length, Math.round(countryTxt.length / 1024));

const report = [];
for (const ad of AD) {
  const target = path.join(OUT, `${ad}_full.json`);
  if (existsSync(target)) { report.push([ad, 'cached']); continue; }
  try {
    const txt = await grab(`${BASE}/${ad}_full.json`);
    const j = JSON.parse(txt);
    await writeFile(target, txt, 'utf8');
    report.push([ad, `${j.features.length} feats, ${Math.round(txt.length / 1024)}KB`]);
  } catch (e) {
    report.push([ad, 'FAIL ' + e.message]);
  }
}
for (const [ad, s] of report) console.log('  %s -> %s', ad, s);

// 2) quick sanity: which provinces have children?
const withKids = country.features
  .filter(f => f.properties.childrenNum > 0)
  .map(f => f.properties.name);
console.log('provinces with childrenNum>0: %d', withKids.length);
const noKids = country.features
  .filter(f => !(f.properties.childrenNum > 0))
  .map(f => `${f.properties.name}(${f.properties.adcode}) childrenNum=${f.properties.childrenNum}`);
console.log('no children:', noKids.join(', '));
