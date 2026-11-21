/* 生成「单文件版」：把地图引擎、样式、脚本、广东相关地理数据全部内嵌进一个 HTML
 * 这样从压缩包里直接双击、甚至不建文件夹，也能打开
 * 用法: node tools/build-single.mjs
 */
import { readFile, writeFile, readdir } from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const read = p => readFile(path.join(ROOT, p), 'utf8');

let html = await read('index.html');

const css = await read('vendor/maplibre-gl.css');
const jsFiles = [
  'vendor/maplibre-gl.js',
  'config.js',
  'data/gdp.js',
  'data/red-sites.js',
  'assets/app.js'
];

/* 需要的行政区划：全国 + 广东省 + 广东各市 */
const geoDir = path.join(ROOT, 'data', 'geo');
const geoFiles = (await readdir(geoDir)).filter(f => f.endsWith('.js'));
const need = geoFiles.filter(f => {
  const ad = f.replace('.js', '');
  return ad === '100000' || ad.startsWith('44');   // 44xxxx 全部为广东
});

const geoPayload = [];
for (const f of need) geoPayload.push((await readFile(path.join(geoDir, f), 'utf8')).trim());
const geoBlob = geoPayload.join('\n');

const redGeo = await read('data/red-sites.geo.js');
const redRes = await read('data/red-sites.resolved.js');

const bundle = `
/* ===== 内嵌：地理与场馆数据（广东版） ===== */
${geoBlob}
${redGeo}
${redRes}
/* ===== 内嵌结束 ===== */
`;

/* 1) 内联样式 */
html = html.replace(
  /<link rel="stylesheet" href="\.\/vendor\/maplibre-gl\.css"\s*\/>/,
  `<style>\n${css}\n</style>`
);
html = html.replace(
  /<link rel="stylesheet" href="\.\/assets\/style\.css"\s*\/>/,
  `<style>\n${await read('assets/style.css')}\n</style>`
);

/* 2) 数据放在加载器之后、其它脚本之前 */
html = html.replace(
  '<script src="./config.js"></script>',
  `<script>${bundle}</script>\n<script>${await read('config.js')}</script>`
);

/* 3) 内联其它脚本 */
for (const f of ['data/gdp.js', 'data/red-sites.js', 'vendor/maplibre-gl.js', 'assets/app.js']) {
  const tag = `<script src="./${f}"></script>`;
  const content = await read(f);
  if (!html.includes(tag)) { console.error('未找到脚本标签:', tag); }
  html = html.replace(tag, `<script>\n${content}\n</script>`);
}

const out = path.join(ROOT, '思政数字地图_单文件版.html');
await writeFile(out, html, 'utf8');
const mb = (Buffer.byteLength(html) / 1024 / 1024).toFixed(2);
console.log(`已生成：${out}`);
console.log(`大小：${mb} MB　内含 ${need.length} 份行政区划（全国 + 广东 21 市）`);