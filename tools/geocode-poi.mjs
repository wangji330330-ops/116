/* 用高德「POI 搜索」重新定位 64 处场馆
 * 比地理编码准得多：地理编码是按地址字符串模糊匹配（常落到村庄/道路），
 * POI 搜索是按场馆名称找真实兴趣点（level=兴趣点/门址，误差通常几十米内）
 *
 * 用法: node tools/geocode-poi.mjs <KEY>
 * 输出: data/red-sites.geo.js（覆盖），并打印与旧坐标的位移
 */
import { readFile, writeFile } from 'node:fs/promises';
import vm from 'node:vm';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const KEY = process.argv[2] || process.env.AMAP_KEY || '';
if (!KEY) { console.error('缺少 Key'); process.exit(1); }

/* 旧坐标（用于对比） */
let OLD = [];
try {
  const src = await readFile(path.join(ROOT, 'data', 'red-sites.geo.js'), 'utf8');
  OLD = JSON.parse(src.slice(src.indexOf('=') + 1).trim().replace(/;\s*$/, ''));
} catch (_) {}

const ctx = { window: {} };
vm.createContext(ctx);
vm.runInContext(await readFile(path.join(ROOT, 'data', 'red-sites.js'), 'utf8'), ctx);
const SITES = ctx.window.RED_SITES;

let RESOLVED = [];
try {
  const src = await readFile(path.join(ROOT, 'data', 'red-sites.resolved.js'), 'utf8');
  RESOLVED = JSON.parse(src.slice(src.indexOf('=') + 1).trim().replace(/;\s*$/, ''));
} catch (_) {}
const rmap = new Map(RESOLVED.map(r => [r.name, r]));

const sleep = ms => new Promise(r => setTimeout(r, ms));

/* 名称归一：去括号、去空白 */
const norm = s => String(s).replace(/[（(][^）)]*[）)]/g, '').replace(/\s/g, '').trim();

function variants(name) {
  const base = norm(name);
  const out = new Set([name, base]);
  // 去掉常见后缀，再试一次（POI 名称常不带「旧址」「纪念馆」）
  const stripped = base.replace(/(旧址纪念馆|纪念馆|纪念园|纪念公园|旧址|故居|陵园|烈士陵园|博物馆|公园|遗址|纪念碑)$/g, '');
  if (stripped.length >= 2) out.add(stripped);
  return [...out].filter(Boolean);
}

async function place(v, keywords) {
  const url = 'https://restapi.amap.com/v3/place/text?' +
    'key=' + encodeURIComponent(KEY) +
    '&keywords=' + encodeURIComponent(keywords) +
    (v.city ? '&city=' + encodeURIComponent(v.city) : '') +
    '&citylimit=true&offset=8&page=1&extensions=base';
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const j = await (await fetch(url)).json();
      if (j.status === '1') return j.pois || [];
      if (/INVALID_USER_KEY|INSUFFICIENT/.test(j.info || '')) throw new Error('Key: ' + j.info);
      if (/QPS|LIMIT|FREQUENT|TOO_FAST/.test(j.info || '')) { await sleep(800 * (attempt + 1)); continue; }
      return [];
    } catch (e) {
      if (String(e.message).startsWith('Key:')) throw e;
      await sleep(400);
    }
  }
  return [];
}

/* 常见城市名：POI 名称里若出现别的城市，说明是异地同名点（如「上海孙中山故居」），必须剔除 */
const CITY_TOKENS = ['上海', '北京', '南京', '武汉', '重庆', '成都', '西安', '天津', '杭州', '苏州',
  '长沙', '福州', '厦门', '南昌', '合肥', '郑州', '济南', '青岛', '沈阳', '哈尔滨', '昆明', '贵阳',
  '南宁', '海口', '广州', '深圳', '珠海', '佛山', '东莞', '中山', '惠州', '江门', '肇庆', '汕头',
  '湛江', '茂名', '梅州', '韶关', '清远', '河源', '汕尾', '潮州', '揭阳', '阳江', '云浮'];

function score(poi, site, r) {
  const pn = norm(poi.name || '');
  const sn = norm(site.name);
  if (!pn) return -1;

  /* 明确排除无关类型：公交站、停车场、地铁口、酒店等 */
  const BAD = /公交|停车场|地铁|车站|轻轨|酒店|宾馆|餐厅|饭店|加油站|售票|入口|出口|侧门|正门|后门|停车|的士|网约车|充电桩/;
  if (BAD.test(poi.name || '') || BAD.test(poi.type || '')) return -1;

  /* 异地同名点剔除 */
  const ownCity = (site.city || '').replace(/市$/, '');
  for (const t of CITY_TOKENS) {
    if (pn.includes(t) && !ownCity.includes(t)) return -1;
  }

  let s = 0;
  if (pn === sn) s += 100;
  else if (sn.includes(pn) || pn.includes(sn)) {
    // 名称是包含关系时，长度不宜相差过大
    const ratio = Math.min(pn.length, sn.length) / Math.max(pn.length, sn.length);
    if (ratio < 0.5) return -1;
    s += 60 * ratio + 20;
  } else {
    // 字符重合度（去重后）
    const setP = new Set([...pn]), setS = new Set([...sn]);
    let common = 0;
    setP.forEach(c => { if (setS.has(c)) common++; });
    const jac = common / (setP.size + setS.size - common);
    if (jac < 0.5) return -1;          // 名称不够像，直接弃用
    s += jac * 50;
  }

  if (r && r.district && poi.adname && poi.adname === r.district) s += 25;
  if (poi.cityname && site.city && poi.cityname.indexOf(site.city.replace(/市$/, '')) >= 0) s += 15;
  if (/纪念馆|名胜|风景|文物|教育|政府|故居|陵园|公园/.test(poi.type || '')) s += 10;
  return s;
}

const dist = (a, b) => {
  if (!a || !b) return null;
  const R = 6371000, toR = d => d * Math.PI / 180;
  const dLat = toR(b[1] - a[1]), dLon = toR(b[0] - a[0]);
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(toR(a[1])) * Math.cos(toR(b[1])) * Math.sin(dLon / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.sqrt(x)));
};

const out = [];
let improved = 0, total = 0;
const moves = [];

for (const site of SITES) {
  const r = rmap.get(site.name) || {};
  const old = OLD.find(x => x.name === site.name);

  let best = null, bestScore = -1;
  for (const kw of variants(site.name)) {
    const pois = await place(site, kw);
    await sleep(300);
    for (const p of pois) {
      const sc = score(p, site, r);
      if (sc > bestScore) { bestScore = sc; best = p; }
    }
    if (best && bestScore >= 90) break;   // 已经很可能命中
  }

  let lng = old ? old.lng : null, lat = old ? old.lat : null, level = old ? old.level : null, matched = old ? old.matched : null;
  if (best && bestScore >= 70 && best.location) {
    const [lo, la] = String(best.location).split(',').map(Number);
    if (isFinite(lo) && isFinite(la)) {
      const d = dist([lng, lat], [lo, la]);
      if (d === null || d > 25) {           // 位移超过 25m 才采纳，避免无谓抖动
        lng = +lo.toFixed(6); lat = +la.toFixed(6);
        level = '兴趣点';
        matched = best.name + (best.address && typeof best.address === 'string' ? '（' + best.address + '）' : '');
        if (d !== null) { improved++; moves.push({ name: site.name, d }); }
      }
    }
  }
  total++;
  out.push({
    name: site.name,
    addr: site.addr,
    city: site.city,
    district: r.district || null,
    districtAdcode: r.districtAdcode || null,
    cityAdcode: r.cityAdcode || null,
    town: r.town || null,
    lng, lat,
    matched,
    level
  });
  if (total % 8 === 0) console.log(`  ${total}/${SITES.length}  位移修正 ${improved}`);
}

await writeFile(path.join(ROOT, 'data', 'red-sites.geo.js'),
  'window.__RED_GEO=' + JSON.stringify(out) + ';\n', 'utf8');

console.log(`\n完成：${improved} 处坐标得到修正（位移 > 25m）`);
moves.sort((a, b) => b.d - a.d);
console.log('位移最大的 15 处：');
moves.slice(0, 15).forEach(m => console.log('  ', m.name.slice(0, 22).padEnd(24), m.d + ' m'));
const lv = {};
out.forEach(x => lv[x.level || '(空)'] = (lv[x.level || '(空)'] || 0) + 1);
console.log('新的精度分布：', JSON.stringify(lv, null, 0));