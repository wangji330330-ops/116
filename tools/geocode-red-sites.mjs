/* 高德地理编码：把 64 处红色场馆的地址转成精确经纬度（GCJ-02，与高德底图完全对齐）
 *
 * 用法：
 *   set AMAP_KEY=你的Key                      (PowerShell)
 *   node tools/geocode-red-sites.mjs
 * 或：
 *   node tools/geocode-red-sites.mjs 你的Key
 *
 * Key 申请（免费）：https://lbs.amap.com/ → 控制台 → 应用管理 → 新建 Key → 服务平台选「Web 服务」
 * 输出：data/red-sites.geo.json
 */
import { readFile, writeFile } from 'node:fs/promises';
import vm from 'node:vm';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const KEY = process.argv[2] || process.env.AMAP_KEY || '';
if (!KEY) {
  console.error('缺少高德 Web 服务 Key。用法: node tools/geocode-red-sites.mjs <KEY>');
  process.exit(1);
}

const ctx = { window: {} };
vm.createContext(ctx);
vm.runInContext(await readFile(path.join(ROOT, 'data', 'red-sites.js'), 'utf8'), ctx);
const SITES = ctx.window.RED_SITES;

let resolved = [];
try {
  resolved = JSON.parse(await readFile(path.join(ROOT, 'data', 'red-sites.resolved.json'), 'utf8'));
} catch (_) {}

const rmap = new Map(resolved.map(r => [r.name, r]));

async function geocode(site) {
  const r = rmap.get(site.name) || {};
  const city = site.city || '';
  // 高德对「结构化地址」更准：优先用详细地址，再退回「名称 + 市」
  const queries = [
    { address: site.addr, city },
    { address: `${city}${(r.district || '')}${site.name}`, city },
    { address: site.name, city }
  ];

  for (const q of queries) {
    for (let attempt = 0; attempt < 4; attempt++) {
      const url = 'https://restapi.amap.com/v3/geocode/geo?key=' + encodeURIComponent(KEY) +
        '&address=' + encodeURIComponent(q.address) +
        (q.city ? '&city=' + encodeURIComponent(q.city) : '');
      try {
        const j = await (await fetch(url)).json();
        if (j.status === '1' && j.geocodes && j.geocodes.length) {
          const g = j.geocodes[0];
          const [lng, lat] = String(g.location).split(',').map(Number);
          if (isFinite(lng) && isFinite(lat)) {
            return { lng, lat, level: g.level, matched: g.formatted_address, via: q.address };
          }
        }
        // Key 失效直接终止
        if (j.info && /INVALID_USER_KEY|INSUFFICIENT/i.test(j.info)) {
          throw new Error('Key 无效或额度不足: ' + j.info);
        }
        // 限流：等待后重试同一查询
        if (j.info && /QPS|LIMIT|FREQUENT|TOO_FAST/i.test(j.info)) {
          await new Promise(s => setTimeout(s, 700 * (attempt + 1)));
          continue;
        }
        break;
      } catch (e) {
        if (String(e.message).includes('Key 无效')) throw e;
        await new Promise(s => setTimeout(s, 400));
      }
    }
    await new Promise(s => setTimeout(s, 320));   // 限速
  }
  return null;
}

const out = [];
let ok = 0, fail = [];

for (let i = 0; i < SITES.length; i++) {
  const s = SITES[i];
  const r = rmap.get(s.name) || {};
  let hit = null;
  try { hit = await geocode(s); }
  catch (e) { console.error('\n' + e.message); process.exit(2); }

  if (hit) {
    ok++;
    out.push({
      name: s.name,
      addr: s.addr,
      city: s.city,
      district: r.district || null,
      districtAdcode: r.districtAdcode || null,
      cityAdcode: r.cityAdcode || null,
      town: r.town || null,
      lng: +hit.lng.toFixed(6),
      lat: +hit.lat.toFixed(6),
      matched: hit.matched,
      level: hit.level
    });
  } else {
    fail.push(s.name);
    out.push({
      name: s.name, addr: s.addr, city: s.city,
      district: r.district || null, districtAdcode: r.districtAdcode || null,
      cityAdcode: r.cityAdcode || null, town: r.town || null,
      lng: null, lat: null
    });
  }
  if ((i + 1) % 8 === 0) console.log(`  ${i + 1}/${SITES.length}  成功 ${ok}  失败 ${fail.length}`);
}

await writeFile(path.join(ROOT, 'data', 'red-sites.geo.json'), JSON.stringify(out, null, 1), 'utf8');
console.log(`\n完成：成功 ${ok} / ${SITES.length}`);
if (fail.length) console.log('未定位：\n  ' + fail.join('\n  '));
console.log('写入 data/red-sites.geo.json');