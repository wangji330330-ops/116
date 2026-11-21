/* =========================================================================
 *  数绘湾区红脉 · 践行医者初心 —— 思政数字地图
 *  地球 → 中国 → 省 → 市 → 区县 → 乡镇  逐级展开
 *
 *  底图：高德地图（标准图 / 卫星图）
 *  界线：阿里云 DataV 行政区划（含台湾省、香港、澳门、南海诸岛十段线）
 *  排序：省府 / 市府优先，其余按 GDP 由高到低逐级渐出
 * ========================================================================= */
(() => {
  'use strict';

  const CFG       = window.APP_CONFIG || {};
  const GDP       = window.GDP_DATA || { province: {}, city: {}, county: {}, year: 2023 };
  const CAPITALS  = window.CAPITALS || {};
  const RED_SITES = window.RED_SITES || [];

  const GEO   = './data/geo/';
  const CACHE = new Map();
  const INFLIGHT = new Map();
  const PREFETCHED = new Set();

  const RED = '#c8102e', RED_DEEP = '#8c0a20', GOLD = '#c9a227';

  /* 中国全景（含海南本岛与台湾；南海诸岛另以右下角附图呈现） */
  const CHINA_BOUNDS = [[73.4, 16.6], [135.2, 53.9]];

  /* ------------------------------- 底图瓦片 ------------------------------- */
  const tiles = tpl => [1, 2, 3, 4].map(i => tpl.replace('{s}', '0' + i));
  const AMAP_STREET = tiles('https://webrd{s}.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scale=1&style=8&x={x}&y={y}&z={z}');
  const AMAP_SAT    = tiles('https://webst{s}.is.autonavi.com/appmaptile?style=6&x={x}&y={y}&z={z}');

  /* ============================ 小工具 ============================ */
  const $ = id => document.getElementById(id);
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const fmt = n => n == null ? '—' : n.toLocaleString('zh-CN');
  const propsOf = r => (r && r.properties) ? r.properties : (r || {});
  const featOf  = r => (r && r.type === 'Feature') ? r : r.f;

  function bboxOf(features) {
    let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
    const walk = c => {
      if (typeof c[0] === 'number') {
        if (c[0] < x0) x0 = c[0]; if (c[0] > x1) x1 = c[0];
        if (c[1] < y0) y0 = c[1]; if (c[1] > y1) y1 = c[1];
      } else c.forEach(walk);
    };
    features.forEach(f => f.geometry && walk(f.geometry.coordinates));
    return [x0, y0, x1, y1];
  }

  function centerOf(feature) {
    const p = feature.properties || {};
    if (p.centroid) return p.centroid;
    if (p.center) return p.center;
    const b = bboxOf([feature]);
    return [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2];
  }

  function fitFeature(features, { padding = 50, maxZoom = 11, duration = 1400 } = {}) {
    const b = bboxOf(features);
    if (!isFinite(b[0])) return;
    map.stop();                       // 打断上一次镜头，避免连点导致乱跳
    map.fitBounds([[b[0], b[1]], [b[2], b[3]]], {
      padding: { top: 150, bottom: 170, left: padding + 40, right: padding + 40 },
      maxZoom, duration, pitch: 0, bearing: 0
    });
  }

  /* 居中定位：四边等距留白，几何中心恰好落在屏幕正中 */
  function centerOn(features, { padding = 90, maxZoom = 7.4, duration = 1400 } = {}) {
    const b = bboxOf(features);
    if (!isFinite(b[0])) return;
    map.stop();
    map.fitBounds([[b[0], b[1]], [b[2], b[3]]], {
      padding: { top: padding, bottom: padding, left: padding, right: padding },
      maxZoom, duration, pitch: 0, bearing: 0
    });
  }

  /* 点哪儿放大到哪儿：以点击点为锚，按区块大小给出合适层级，不乱跳 */
  function zoomToRegion(feature, clickedLngLat, { maxZoom = 11.2, duration = 760 } = {}) {
    const b = bboxOf([feature]);
    if (!isFinite(b[0])) return;
    const nw = map.project([b[0], b[3]]);
    const se = map.project([b[2], b[1]]);
    const w = Math.abs(se.x - nw.x), h = Math.abs(se.y - nw.y);
    const vw = window.innerWidth, vh = window.innerHeight;

    // 目标层级：让该区块约占视口 78%，但不超过 maxZoom
    let scale = 1;
    if (w > 0 && h > 0) scale = Math.min((vw * 0.78) / w, (vh * 0.78) / h);
    const target = Math.min(maxZoom, map.getZoom() + Math.log2(Math.max(1.01, scale)));

    const center = clickedLngLat && map.getBounds().contains(clickedLngLat)
      ? clickedLngLat
      : (() => { const c = centerOf(feature); return { lng: c[0], lat: c[1] }; })();

    map.stop();
    map.easeTo({ center, zoom: target, pitch: 0, bearing: 0, duration });
  }

  /* --------------------------- GDP 与排序 --------------------------- */
  function gdpOf(adcode, name, level) {
    if (level === 'province') return GDP.province[name] ?? null;
    if (level === 'district' || level === 'town') {
      const c = GDP.county[adcode];
      if (c != null) return c;
    }
    const v = GDP.city[name];
    return v == null ? null : v;
  }

  function buildOrder(features, parentName) {
    const capName = CAPITALS[parentName];
    const rows = features.map(f => {
      const p = f.properties;
      return {
        f, adcode: String(p.adcode), name: p.name, level: p.level,
        gdp: gdpOf(String(p.adcode), p.name, p.level),
        isCapital: !!capName && capName === p.name
      };
    });
    rows.sort((a, b) => {
      if (a.isCapital !== b.isCapital) return a.isCapital ? -1 : 1;
      if (a.gdp != null && b.gdp != null) return b.gdp - a.gdp;
      if (a.gdp != null) return -1;
      if (b.gdp != null) return 1;
      return String(a.adcode).localeCompare(String(b.adcode));
    });
    const n = rows.filter(r => r.gdp != null).length;
    /* 界面文案不提排序指标，只在「说明」面板里交代依据 */
    let basis;
    if (n === 0) {
      basis = '按行政区划顺序依次展开';
    } else {
      basis = '省会 / 首府先行，其余依次展开';
    }
    return { rows, basis };
  }

  /* --------------------------- 全局状态 --------------------------- */
  let map;
  let countryFC = null;
  let pins = [];
  let parentPins = [];       // 上一级的兄弟标记：保持可见可点，随时横向切换
  let runToken = 0;
  let selProvId = null;
  let selDetailId = null;
  let dragging = false;

  const current = { level: 0, region: null, province: null, city: null };

  const els = {
    boot: $('boot'), bootT2: document.querySelector('.boot__t2'),
    crumb: $('crumb'), pgLabel: $('pg-label'), pgCount: $('pg-count'),
    pgBar: $('pg-bar'), pgBasis: $('pg-basis'),
    hint: $('hint'),
    panel: $('panel'), panelTitle: $('panel-title'), panelBody: $('panel-body'),
    toast: $('toast')
  };

  /* ============================== 标记 Pin ============================== */
  function makePin(row, rank, total, kind, onClick) {
    const wrap = document.createElement('div');
    wrap.className = 'pinwrap';

    const el = document.createElement('button');
    el.type = 'button';
    el.className = `pin pin--${kind}` + (row.isCapital ? ' pin--core' : '');
    el.setAttribute('aria-label', row.name);
    /* 只显示地名：弹出顺序仍按省会先行 → GDP 由高到低，但不展示 GDP 数值 */
    el.innerHTML =
      '<span class="pin__ring"></span><span class="pin__dot"></span>' +
      '<span class="pin__card"><span class="pin__name"></span></span>';

    el.querySelector('.pin__name').textContent = row.name;

    if (onClick) el.addEventListener('click', ev => { ev.stopPropagation(); onClick(row); });

    const lngLat = centerOf(row.f);
    wrap.appendChild(el);
    new maplibregl.Marker({ element: wrap, anchor: 'center' })
      .setLngLat(lngLat)
      .addTo(map);

    return { row, el, wrap, rank, lngLat };
  }

  function clearPins() {
    pins.forEach(p => p.wrap.remove());
    pins = [];
  }

  /* 进入下一级时，把当前层级的标记「降级」而不是删掉：
     它们变成上一层兄弟标记，样式变淡但仍可点击，
     这样任何时候都能点别的省 / 市 / 区县直接跳过去。 */
  function demotePins() {
    parentPins.forEach(p => p.wrap.remove());
    parentPins = pins.map(p => {
      p.el.classList.add('pin--ctx');
      p.el.classList.remove('is-now');
      return p;
    });
    pins = [];
  }

  function clearAllPins() {
    clearPins();
    parentPins.forEach(p => p.wrap.remove());
    parentPins = [];
  }

  /* ------------------------ 标签避让（防重叠） ------------------------ */
  let declutterTimer = null;
  function scheduleDeclutter() {
    clearTimeout(declutterTimer);
    declutterTimer = setTimeout(declutter, 90);
  }

  /* 国家版图相关省级单元：标签必定常驻，不受避让压制 */
  const ALWAYS_LABEL = new Set(['710000', '810000', '820000']);

  /* 每个标签实测一次尺寸后缓存；切换紧凑模式时整体失效重测，
     保证「先批量读、再批量写」，不产生读写交替造成的强制回流 */
  function cachePinSize(p) {
    if (p._w) return;
    const card = p.el.querySelector('.pin__card');
    if (!card) return;
    const w = card.offsetWidth, h = card.offsetHeight;
    if (w > 0 && h > 0) { p._w = w; p._h = h; }
  }

  function invalidateSizes() {
    pins.concat(parentPins).forEach(p => { p._w = 0; p._h = 0; });
  }

  function declutter() {
    // 当前层级优先级最高，上一层兄弟标记最先被挤掉；港澳台始终保留
    /* 优先级：行政区名称一律常显（不挤没）→ 场馆/聚合点按空间避让 */
    const rankOf = (p) => {
      if (ALWAYS_LABEL.has(String(p.row.adcode))) return 0;
      const lvl = p.row.level;
      if (lvl === 'venue' || lvl === 'cluster') return 3;
      if (parentPins.includes(p)) return 2;
      return 1;
    };
    const order = pins.concat(parentPins).concat(venuePins).sort((a, b) => rankOf(a) - rankOf(b));

    // —— 阶段一：全部读取（无写入） ——
    order.forEach(p => { if (p.el.classList.contains('is-on')) cachePinSize(p); });

    const boxes = [];
    const free = box => !boxes.some(b =>
      !(box.x + box.w < b.x - 4 || box.x > b.x + b.w + 4 ||
        box.y + box.h < b.y - 3 || box.y > b.y + b.h + 3));

    const fallback = document.body.classList.contains('lbl-compact')
      ? { w: 64, h: 20 } : { w: 86, h: 34 };

    // —— 阶段二：全部写入 ——
    order.forEach(p => {
      if (!p.el.classList.contains('is-on')) return;
      if (p.el.classList.contains('is-dim')) return;
      if (!p.lngLat) return;

      const pt = map.project(p.lngLat);
      if (!pt || !isFinite(pt.x)) return;

      const forced = ALWAYS_LABEL.has(String(p.row.adcode)) ||
        (p.row.level !== 'venue' && p.row.level !== 'cluster' && !parentPins.includes(p));
      const w = p._w || fallback.w;
      const h = p._h || fallback.h;
      const cx = pt.x, cy = pt.y;

      const below = { x: cx - w / 2, y: cy + 5, w, h };
      const above = { x: cx - w / 2, y: cy - 5 - h, w, h };
      const right = { x: cx + 9, y: cy - h / 2, w, h };
      const left  = { x: cx - 9 - w, y: cy - h / 2, w, h };

      const pick =
        free(below) ? { cls: '', box: below } :
        free(above) ? { cls: 'lab-above', box: above } :
        free(right) ? { cls: 'lab-right', box: right } :
        free(left)  ? { cls: 'lab-left',  box: left }  :
        forced      ? { cls: '', box: below } : null;

      p.el.classList.remove('lab-above', 'lab-right', 'lab-left');
      if (pick) {
        if (pick.cls) p.el.classList.add(pick.cls);
        p.el.classList.add('lab-on');
        p.el.classList.remove('is-lbl-hide');
        boxes.push(pick.box);
      } else {
        p.el.classList.remove('lab-on');
        p.el.classList.add('is-lbl-hide');
      }
    });
  }

  /* 缩小时只显示地名，放大后补出 GDP 与名次 */
  let compactMode = null;
  function updateLabelMode() {
    const compact = map.getZoom() < 8.6;
    if (compact === compactMode) return;
    compactMode = compact;
    document.body.classList.toggle('lbl-compact', compact);
    invalidateSizes();          // 紧凑模式改变标签尺寸，需重测
    scheduleDeclutter();
  }

  /* ========================= 要素状态动画 ========================= */
  function setState(source, id, obj) {
    try { map.setFeatureState({ source, id: String(id) }, obj); } catch (_) {}
  }

  function tweenState(source, id, key, from, to, dur) {
    const t0 = performance.now();
    const step = t => {
      const k = Math.min(1, (t - t0) / dur);
      const e = 1 - Math.pow(1 - k, 3);
      setState(source, id, { [key]: from + (to - from) * e });
      if (k < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  function selectProvince(id) {
    if (selProvId) setState('prov', selProvId, { selected: false, dim: false });
    selProvId = id ? String(id) : null;

    if (selProvId && countryFC) {
      // 只突出选中的省份，其余全部淡化
      countryFC.features.forEach(f => {
        const ad = String(f.properties.adcode);
        if (ad === selProvId) setState('prov', ad, { selected: true, dim: false });
        else setState('prov', ad, { selected: false, dim: true });
      });
    } else if (countryFC) {
      countryFC.features.forEach(f => setState('prov', String(f.properties.adcode), { dim: false, selected: false }));
    }

    pins.forEach(p => p.el.classList.toggle('is-dim', false));
    pins.concat(parentPins).forEach(p => {
      if (p.row.level === 'province' || p.el.classList.contains('pin--prov')) {
        p.el.classList.toggle('is-dim', !!selProvId && String(p.row.adcode) !== selProvId);
      }
    });
    scheduleDeclutter();
  }

  function selectDetail(id) {
    if (selDetailId) setState('detail', selDetailId, { selected: false });
    selDetailId = id ? String(id) : null;
    if (selDetailId) setState('detail', selDetailId, { selected: true });
  }

  /* ============================ 悬停 / 点击信息 ============================ */
  const tipEl = document.getElementById('tip');
  const spotEl = document.getElementById('spot');
  const spotBody = document.getElementById('spot-body');

  /* 行政区划完整层级：中国 › 广东省 › 广州市 › 天河区 */
  function pathOf(props) {
    const parts = [];
    if (props.level !== 'province' && current.province) parts.push(current.province.properties.name);
    if (props.level === 'district' && current.city) parts.push(current.city.properties.name);
    if (props.level === 'town' && current.region) parts.push(current.region.properties.name);
    parts.push(props.name);
    return parts.join(' › ');
  }

  /* 悬停提示（rAF 节流，跟随指针） */
  let tipRaf = 0, tipPending = null;
  function showTip(props, point) {
    tipPending = { props, point };
    if (tipRaf) return;
    tipRaf = requestAnimationFrame(() => {
      tipRaf = 0;
      if (!tipPending) return;
      const { props: p, point: pt } = tipPending;
      tipEl.innerHTML = `<span class="tip__name">${p.name}</span>` +
        (p.level === 'province' ? '' : `<span class="tip__path">${pathOf(p)}</span>`);
      tipEl.style.left = pt.x + 'px';
      tipEl.style.top = pt.y + 'px';
      tipEl.hidden = false;
      tipEl.classList.add('is-on');
    });
  }
  function hideTip() {
    tipPending = null;
    tipEl.classList.remove('is-on');
    if (!tipEl.hidden) setTimeout(() => { if (!tipEl.classList.contains('is-on')) tipEl.hidden = true; }, 140);
  }

  /* 点击区块后的信息卡：只占一角，地图仍可自由拖动 */
  function hideSpot() {
    spotEl.classList.remove('is-on');
    if (!spotEl.hidden) setTimeout(() => { if (!spotEl.classList.contains('is-on')) spotEl.hidden = true; }, 200);
  }

  function showSpot(props, point, feature) {
    const p = props;
    const path = pathOf(p);
    const cityName = p.level === 'city' ? p.name
      : (current.city ? current.city.properties.name : (current.province ? current.province.properties.name : ''));
    const sites = p.level === 'district' || p.level === 'city'
      ? RED_SITES.filter(s => s.city === cityName)
      : [];

    spotBody.innerHTML = `
      <p class="spot__name">${p.name}</p>
      <p class="spot__path">${path}</p>
      <div class="spot__row"><span>所属</span><b>${path.split(' › ').slice(0, -1).join(' › ') || '中国'}</b></div>
      <div class="spot__row"><span>层级</span><b>${
        p.level === 'province' ? '省级行政区'
        : p.level === 'city' ? '地级行政区'
        : p.level === 'district' ? '县级行政区' : '乡镇 / 街道'}</b></div>
      ${sites.length ? `<div class="spot__row" style="display:block">
          <span style="display:block;margin-bottom:2px">${cityName}红色场馆（${sites.length}）</span>
          <ul class="spot__sites">${sites.slice(0, 4).map(s => `<li>${s.name}</li>`).join('')}
          ${sites.length > 4 ? `<li>…等 ${sites.length} 处，详见「说明」</li>` : ''}</ul>
        </div>` : ''}
      ${CFG.AMAP_KEY && p.level === 'district' && feature
        ? `<button class="spot__more" id="spot-more">展开街道 / 乡镇</button>` : ''}
      <div class="spot__hint">拖动地图可继续浏览，卡片会自动收起</div>
    `;

    if (CFG.AMAP_KEY && p.level === 'district' && feature) {
      const b = document.getElementById('spot-more');
      if (b) b.onclick = () => { hideSpot(); openTownship(feature); };
    }

    // 定位交给 CSS：固定贴右侧中部，不压住地图中心
    spotEl.hidden = false;
    requestAnimationFrame(() => spotEl.classList.add('is-on'));
  }

  /* ============================ 点击命中（自绘几何判定） ============================ */
  /* 不依赖 queryRenderedFeatures：直接对已加载的 GeoJSON 做点面判定，
     这样无论填充多淡、渲染状态如何，点区块都一定能命中 */
  let detailFeats = [];
  let contextFeats = [];

  function pointInRing(pt, ring) {
    let inside = false;
    const x = pt[0], y = pt[1];
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const xi = ring[i][0], yi = ring[i][1];
      const xj = ring[j][0], yj = ring[j][1];
      if (((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi)) inside = !inside;
    }
    return inside;
  }

  function pointInGeometry(pt, geom) {
    if (!geom) return false;
    const polys = geom.type === 'Polygon' ? [geom.coordinates]
      : geom.type === 'MultiPolygon' ? geom.coordinates : [];
    for (const poly of polys) {
      if (!poly || !poly.length) continue;
      if (!pointInRing(pt, poly[0])) continue;
      let hole = false;
      for (let r = 1; r < poly.length; r++) {
        if (pointInRing(pt, poly[r])) { hole = true; break; }
      }
      if (!hole) return true;
    }
    return false;
  }

  function hitTest(lngLat) {
    const pt = [lngLat.lng, lngLat.lat];
    // 优先级：本层下级（最细）→ 同级上下文 → 省级
    const sets = [detailFeats, contextFeats, countryFC ? countryFC.features : []];
    for (const list of sets) {
      for (const f of list) {
        if (!f.properties || !f.properties.level) continue;   // 跳过南海诸岛等辅助要素
        if (f.geometry && pointInGeometry(pt, f.geometry)) return f;
      }
    }
    return null;
  }

  function sourceOfFeature(f) {
    const ad = String(f.properties.adcode);
    if (detailFeats.some(x => String(x.properties.adcode) === ad)) return 'detail';
    if (contextFeats.some(x => String(x.properties.adcode) === ad)) return 'context';
    return 'prov';
  }

  /* ============================ 图层数据 ============================ */
  function setDetail(features) {
    selDetailId = null;
    detailFeats = features || [];
    const s = map.getSource('detail');
    if (!s) return;
    s.setData({ type: 'FeatureCollection', features: detailFeats });
    detailFeats.forEach(f => setState('detail', f.properties.adcode, { reveal: 0, hover: false, selected: false }));
  }

  function setFocus(features) {
    const s = map.getSource('focus');
    if (s) s.setData({ type: 'FeatureCollection', features });
  }

  /* 同级上下文：把「当前区域的兄弟」放进一个常驻可点图层。
     例如进入广州市后，广东省其余 20 个市依然可见、可点，直接跳转即可。 */
  function setContext(features) {
    const s = map.getSource('context');
    const cur = current.region ? String(current.region.properties.adcode) : null;
    contextFeats = (features || []).filter(f => String(f.properties.adcode) !== cur);
    if (s) s.setData({ type: 'FeatureCollection', features: contextFeats });
    contextFeats.forEach(f => setState('context', f.properties.adcode, { hover: false }));
  }

  /* 取某个区域的同级兄弟（其父级的全部下级）
     —— 注意：要素经 MapLibre 图层取回后，嵌套属性会变成 JSON 字符串，
        这里统一兼容对象与字符串两种形态 */
  function parentAdcode(p) {
    let v = p && p.parent;
    if (!v) return null;
    if (typeof v === 'string') {
      try { v = JSON.parse(v); } catch (_) { return null; }
    }
    return v && v.adcode != null ? String(v.adcode) : null;
  }

  async function siblingsOf(feature) {
    const p = propsOf(feature);
    const parent = parentAdcode(p);
    if (!parent) return [];
    if (parent === '100000') return [];   // 省级的兄弟就是全部省份，已在 prov 图层
    return (await loadChildren(parent)) || [];
  }

  /* 在所有已加载数据里按 adcode 找要素 */
  function findAnywhere(adcode) {
    const ad = String(adcode);
    if (countryFC) {
      const f = countryFC.features.find(x => String(x.properties.adcode) === ad);
      if (f) return f;
    }
    for (const list of CACHE.values()) {
      if (!list) continue;
      const f = list.find(x => String(x.properties.adcode) === ad);
      if (f) return f;
    }
    return null;
  }

  /* 顺着 parent 链把 current.province / current.city 补齐。
     这样从任何地方点过来（哪怕是别的省的区县）层级都不会错。 */
  function syncAncestors(p) {
    let city = null, prov = null;
    let cur = parentAdcode(p);
    let guard = 0;
    while (cur && guard++ < 5) {
      const f = findAnywhere(cur);
      if (!f) break;
      const fp = f.properties;
      if (fp.level === 'city') city = f;
      else if (fp.level === 'province') prov = f;
      cur = parentAdcode(fp);
    }
    if (prov) current.province = prov;
    if (p.level === 'city') { current.city = null; }
    else if (city) current.city = city;
  }

  /* ============================ 读取下级 ============================ */
  /* 全部行政区划边界均已本地打包（省级 + 地级市），
     不依赖任何第三方接口，打开即用、离线可用 */
  function normalize(gj) {
    return gj.features.map(f => ({ ...f, id: String(f.properties.adcode) }));
  }

  async function loadChildren(adcode) {
    const ad = String(adcode);
    if (CACHE.has(ad)) return CACHE.get(ad);
    if (INFLIGHT.has(ad)) return INFLIGHT.get(ad);
    const job = (async () => {
      try {
        if (!window.__GEO[ad]) await window.__loadScript(`${GEO}${ad}.js`);
        const gj = window.__GEO[ad];
        if (!gj) throw new Error('empty');
        const feats = normalize(gj);
        CACHE.set(ad, feats);
        return feats;
      } catch (_) {
        CACHE.set(ad, []);
        return [];
      } finally {
        INFLIGHT.delete(ad);
      }
    })();
    INFLIGHT.set(ad, job);
    return job;
  }

  /* 预取：鼠标划过区块 / 上一级展开完成后，提前把下一级边界取进内存，
     真正点击时基本可以瞬间出图 */
  function prefetchChildren(adcode) {
    const ad = String(adcode);
    if (!ad || CACHE.has(ad) || INFLIGHT.has(ad) || PREFETCHED.has(ad)) return;
    PREFETCHED.add(ad);
    loadChildren(ad);
  }

  /* ============================ 展开一个区域的下级 ============================ */
  async function openRegion(feature, { preload = null } = {}) {
    const my = ++runToken;
    demotePins();

    const p = propsOf(feature);
    const adcode = String(p.adcode);
    const name = p.name;
    const feats = await (preload || loadChildren(adcode));
    if (my !== runToken) return;

    setFocus([feature]);
    siblingsOf(feature).then(list => { if (my === runToken) setContext(list); });

    if (!feats.length) {
      setDetail([]);
      updateCrumb();
      showEmptyNotice(p);
      return;
    }

    setDetail(feats);
    const { rows, basis } = buildOrder(feats, name);
    const kind = rows[0].level === 'city' ? 'city' : 'dist';

    rows.forEach((row, i) => {
      pins.push(makePin(row, i, rows.length, kind, r => drillInto(r)));
    });

    updateCrumb();
    els.pgBasis.textContent = basis;
    els.pgLabel.textContent = `准备展开 ${rows.length} 个${kind === 'city' ? '市 / 州' : '区 / 县'}`;
    els.pgCount.textContent = '';
    els.pgBar.style.width = '0%';
    els.hint.classList.add('is-hide');

    /* 区块轮廓先整体淡入，标签再逐个弹出，避免「等很久什么都没有」 */
    rows.forEach(row => tweenState('detail', row.adcode, 'reveal', 0, 0.45, 260));

    const gap = rows.length > 26 ? 60 : rows.length > 14 ? 90 : 120;

    for (let i = 0; i < rows.length; i++) {
      if (my !== runToken) return;
      await sleep(gap);
      if (my !== runToken) return;

      const row = rows[i];
      const pin = pins[i];
      pin.el.classList.add('is-on', 'is-now');
      tweenState('detail', row.adcode, 'reveal', 0.45, 1, 380);
      setTimeout(() => pin.el.classList.remove('is-now'), 1200);
      scheduleDeclutter();

      els.pgLabel.textContent = row.name;
      els.pgCount.textContent = `${i + 1} / ${rows.length}`;
      els.pgBar.style.width = `${((i + 1) / rows.length) * 100}%`;
    }

    if (my === runToken) {
      els.pgLabel.textContent = `已展开 ${rows.length} 个${kind === 'city' ? '市 / 州' : '区 / 县'}`;
      els.pgBasis.textContent = basis + ' · 点击任一区域继续下钻';
      schedulePrefetch(rows);
      updateVenues();
      updateRedFocus();
    }
  }

  /* 展开完成后，空闲时预取下一级边界，让后续点击秒开 */
  let prefetchTimer = null;
  function schedulePrefetch(rows) {
    clearTimeout(prefetchTimer);
    prefetchTimer = setTimeout(() => {
      const targets = rows.filter(r => r.level === 'city' && r.f);
      let i = 0;
      const step = () => {
        if (i >= targets.length) return;
        // 每次只预取 3 个，避免抢占带宽影响当前交互
        for (let k = 0; k < 3 && i < targets.length; k++, i++) prefetchChildren(targets[i].adcode);
        prefetchTimer = setTimeout(step, 260);
      };
      step();
    }, 900);
  }

  /* ============================ 下钻 ============================ */
  /* 本作品只做广东：其余省份只作版图参照，不提供进入 */
  const GUANGDONG = '广东省';
  let gdToastAt = 0;
  function onlyGuangdong(name) {
    if (name === GUANGDONG) return true;
    const now = Date.now();
    if (now - gdToastAt > 1500) {
      gdToastAt = now;
      toast('本作品仅收录<b class="t-hi">广东省</b>的红色资源，其他省份仅作版图参照。', 2800);
    }
    return false;
  }

  function drillProvince(row) {
    const f = featOf(row);
    if (!onlyGuangdong(propsOf(f).name)) return Promise.resolve();
    current.level = 1;
    current.province = f;
    current.city = null;
    current.region = f;

    selectProvince(f.properties.adcode);
    // 数据加载与渐次展开立刻开始，镜头同时飞行，二者并行
    const opening = openRegion(f);
    // 四边等距 → 该省几何中心落在屏幕正中
    centerOn([f], { maxZoom: 7.4, padding: 80, duration: 900 });
    return opening;
  }

  async function drillInto(row, clickedLngLat) {
    const f = featOf(row);
    const p = propsOf(f);

    if (p.level === 'province') return drillProvince(row);

    // 先把所属省市补齐（可能来自别的省 / 别的市）
    syncAncestors(p);

    current.region = f;
    if (p.level === 'city') { current.city = f; current.level = 2; }
    else { current.level = 3; }

    selectDetail(p.adcode);

    // 进入区县：聚焦 + 适度拉近
    if (p.level === 'district' || p.level === 'town') {
      demotePins();
      setFocus([f]);

      /* 跨级可点：
         ① 本市的其余区县保持在 detail 图层里 → 可点同级
         ② 本省的全部市放进 context 图层 → 可直接跨到别的市
         ③ 其余省份由 prov 图层承接 → 可直接跨到别的省 */
      const cityKids = current.city
        ? await loadChildren(current.city.properties.adcode) : [];
      setDetail(cityKids);
      cityKids.forEach(k => setState('detail', k.properties.adcode, { reveal: 1 }));
      selectDetail(p.adcode);

      if (current.province) {
        const provKids = await loadChildren(current.province.properties.adcode);
        setContext(provKids);
      }

      zoomToRegion(f, clickedLngLat, { maxZoom: 11.4, duration: 720 });
      updateCrumb();
      els.pgLabel.textContent = `${p.name} · 县级行政区`;
      els.pgCount.textContent = '';
      els.pgBar.style.width = '100%';
      els.pgBasis.textContent = '点击周边区县或任意城市可直接切换 · 拖动地图浏览';
      showSpot(p, null, f);
      updateVenues();
      updateRedFocus();
      return;
    }

    // 市 → 区县：先出图形和标签，镜头同时飞过去
    const opening = openRegion(f);
    zoomToRegion(f, clickedLngLat, { maxZoom: 10.8, duration: 780 });
    return opening;
  }

  /* ============================ 乡镇级 ============================ */
  async function openTownship(feature) {
    const my = ++runToken;

    const p = propsOf(feature);
    // 先记下本级名次（pins 仍是上一层的区县列表）
    const hit = pins.find(x => String(x.row.adcode) === String(p.adcode));
    const rankInfo = hit ? { rank: hit.rank + 1, total: pins.length } : null;

    demotePins();
    setFocus([feature]);
    setDetail([]);
    updateCrumb();

    els.pgLabel.textContent = `${p.name} · 乡镇 / 街道`;
    els.pgCount.textContent = '';
    els.pgBar.style.width = '0%';

    els.pgLabel.textContent = `正在获取 ${p.name} 的乡镇数据…`;
    let towns = [];
    try {
      const url = `https://restapi.amap.com/v3/config/district?key=${encodeURIComponent(CFG.AMAP_KEY)}` +
                  `&keywords=${encodeURIComponent(p.name)}&subdistrict=1&extensions=all`;
      const j = await (await fetch(url)).json();
      const d = j.districts && j.districts[0];
      towns = ((d && d.districts) || []).map(t => ({
        name: t.name, adcode: t.adcode,
        center: String(t.center).split(',').map(Number),
        polyline: t.polyline
      }));
    } catch (_) { towns = []; }

    if (my !== runToken) return;

    if (!towns.length) {
      els.pgBasis.textContent = '未取到乡镇数据，请确认 Key 已开通「行政区查询」服务';
      toast(`未取到 <b class="t-hi">${p.name}</b> 的乡镇数据，请检查高德 Key 权限。`);
      return;
    }

    const feats = towns.map(t => {
      let geom = null;
      if (t.polyline) {
        const rings = t.polyline.split('|').map(seg =>
          seg.split(';').map(pt => {
            const [lng, lat] = pt.split(',').map(Number);
            return [lng, lat];
          }).filter(pt => isFinite(pt[0]) && isFinite(pt[1]))
        ).filter(r => r.length > 2);
        if (rings.length) {
          const r0 = rings[0];
          const a = r0[0], b = r0[r0.length - 1];
          if (a[0] !== b[0] || a[1] !== b[1]) r0.push(a);
          geom = { type: 'Polygon', coordinates: [r0] };
        }
      }
      return {
        type: 'Feature', id: String(t.adcode),
        properties: { name: t.name, adcode: t.adcode, level: 'town', center: t.center, centroid: t.center },
        geometry: geom
      };
    });

    setDetail(feats);
    demotePins();

    const rows = feats.map(f => ({
      f, adcode: String(f.properties.adcode), name: f.properties.name,
      level: 'town', gdp: null, isCapital: false
    }));
    rows.forEach((row, i) => pins.push(makePin(row, i, rows.length, 'town', null)));

    els.pgBasis.textContent = '乡镇 / 街道按行政区划顺序依次展开';
    for (let i = 0; i < rows.length; i++) {
      if (my !== runToken) return;
      await sleep(170);
      if (my !== runToken) return;
      pins[i].el.classList.add('is-on', 'is-now');
      if (feats[i].geometry) tweenState('detail', rows[i].adcode, 'reveal', 0, 1, 520);
      setTimeout(() => pins[i].el.classList.remove('is-now'), 1500);
      els.pgLabel.textContent = rows[i].name;
      els.pgCount.textContent = `${i + 1} / ${rows.length}`;
      els.pgBar.style.width = `${((i + 1) / rows.length) * 100}%`;
    }
  }

  /* ============================ 空层级提示 ============================ */
  function showEmptyNotice(p) {
    els.pgLabel.textContent = `${p.name} · 暂无下级面数据`;
    els.pgCount.textContent = '';
    els.pgBar.style.width = '100%';

    if (String(p.adcode) === '710000') {
      els.pgBasis.textContent = '台湾省是中国神圣领土不可分割的一部分，本图层以省级全幅完整呈现。';
      toast(
        `<b class="t-hi">台湾省</b>是中国神圣领土不可分割的一部分。<br>` +
        `本平台已完整收录台湾省省级全幅，其下辖县市边界数据暂未开放。`, 5600);
    } else {
      els.pgBasis.textContent = '本级无下级面数据（不设区的地级市或数据缺失）。';
      toast(`<b class="t-hi">${p.name}</b> 无下级面数据。`);
    }
  }

  /* ============================ 面包屑 ============================ */
  function updateCrumb() {
    const items = [{ label: '中国', level: 0 }];
    const c = current;
    if (c.province) items.push({ label: c.province.properties.name, level: 1, f: c.province });
    if (c.city) items.push({ label: c.city.properties.name, level: 2, f: c.city });
    if (c.region && c.level >= 3 && c.region !== c.city && c.region !== c.province) {
      items.push({ label: c.region.properties.name, level: 3, f: c.region });
    }

    els.crumb.innerHTML = '';
    items.forEach((it, i) => {
      if (i) els.crumb.insertAdjacentHTML('beforeend', '<span class="sep">›</span>');
      const b = document.createElement('button');
      b.textContent = it.label;
      if (i === items.length - 1) b.className = 'now';
      b.onclick = () => jumpTo(it);
      els.crumb.appendChild(b);
    });
  }

  function jumpTo(it) {
    if (it.level === 0) return resetToChina();
    if (it.level === 1) return drillProvince({ f: it.f });
    current.level = it.level;
    current.region = it.f;
    if (it.level === 2) { current.city = it.f; }
    selectDetail(it.f.properties.adcode);
    fitFeature([it.f], { maxZoom: it.level === 2 ? 10.8 : 7.4, padding: 30 });
    openRegion(it.f);
  }

  function backOne() {
    if (current.level === 0) return;
    if (current.level === 1) return resetToChina();
    if (current.level === 2 && current.province) {
      const prov = current.province;
      current.level = 1; current.city = null; current.region = prov;
      selectDetail(null);
      fitFeature([prov], { maxZoom: 7.4, padding: 30 });
      openRegion(prov);
      return;
    }
    if (current.level === 3 && current.city) {
      const city = current.city;
      current.level = 2; current.region = city;
      fitFeature([city], { maxZoom: 10.8, padding: 30 });
      openRegion(city);
    }
  }

  /* ============================ 回到全国 ============================ */
  async function resetToChina({ animate = true } = {}) {
    const my = ++runToken;
    clearAllPins();
    clearVenues();
    setDetail([]);
    setFocus([]);
    setContext([]);
    selectDetail(null);
    selectProvince(null);

    current.level = 0; current.region = null; current.province = null; current.city = null;

    updateCrumb();
    els.pgLabel.textContent = '中国 · 34 个省级行政区';
    els.pgCount.textContent = '';
    els.pgBar.style.width = '0%';
    els.pgBasis.textContent = '点击任一省份开始逐级展开';
    els.hint.classList.remove('is-hide');

    const provFeats = countryFC.features.filter(f => f.properties.level === 'province');
    const { rows } = buildOrder(provFeats, '中国');
    rows.forEach((row, i) => pins.push(makePin(row, i, rows.length, 'prov', r => drillProvince(r))));

    if (animate) {
      map.fitBounds(CHINA_BOUNDS, {
        padding: { top: 130, bottom: 80, left: 70, right: 70 },
        duration: 1600, pitch: 0, bearing: 0, maxZoom: 5.4
      });
    } else {
      map.fitBounds(CHINA_BOUNDS, {
        padding: { top: 130, bottom: 80, left: 70, right: 70 },
        duration: 0, pitch: 0, bearing: 0, maxZoom: 5.4
      });
    }

    // 省级标签按 GDP 顺序渐次浮现
    for (let i = 0; i < pins.length; i++) {
      if (my !== runToken) return;
      await sleep(i === 0 ? 260 : 58);
      pins[i].el.classList.add('is-on');
      scheduleDeclutter();
    }
  }

  /* ============================ 开场 ============================ */
  /* 球面投影只用于开场「地球 → 中国」的镜头运动。
     实测球面渲染开销约为平面投影的 2 倍，落地后切回平面，
     既保留地球观感，又让后续下钻交互更流畅 */
  function setProjection(kind) {
    if (typeof map.setProjection !== 'function') return;
    try { map.setProjection({ type: kind }); } catch (_) {}
  }

  /* 落地中国后限制可平移范围，彻底杜绝拖到两极出现瓦片拉花；
     范围留足余量（含港澳台与南海），既不影响看全国，也够不到极点。
     开场地球阶段不加限制，保证「地球 → 中国」的镜头自由 */
  const CHINA_PAN_BOUNDS = [[40, -12], [165, 70]];
  function lockToChina(on) {
    try { map.setMaxBounds(on ? CHINA_PAN_BOUNDS : null); } catch (_) {}
  }

  async function intro() {
    els.boot.classList.add('is-gone');
    lockToChina(false);
    setProjection('globe');
    map.jumpTo({ center: [101, 16], zoom: 1.35, pitch: 0, bearing: 0 });
    await sleep(900);
    map.flyTo({ center: [104.6, 33], zoom: 3.8, duration: 4300, curve: 1.28, essential: true });
    await new Promise(res => {
      const done = () => res();
      map.once('moveend', done);
      setTimeout(done, 5200);
    });
    setProjection('mercator');   // 落地后转平面，换取交互流畅度
    lockToChina(true);

    // 先看全国：34 个省级行政区依次弹出
    await resetToChina();
    toast('已载入 <b class="t-hi">国家标准版中国地图</b>', 2600);

    const q = new URLSearchParams(location.search).get('go');
    if (q) { autoDrill(); return; }

    // 省份全部弹出后，自动进入广东（本作品只做广东）
    await sleep(1400);
    if (!countryFC) return;
    const gd = countryFC.features.find(f => f.properties.name === GUANGDONG);
    if (gd) {
      toast('本作品聚焦 <b class="t-hi">广东省</b>，正在进入…', 2600);
      await sleep(700);
      drillProvince({ f: gd });
    }
  }

  /* ====================== 深链接：?go=440000,440100 ====================== */
  async function autoDrill() {
    const q = new URLSearchParams(location.search).get('go');
    if (!q) return;
    const codes = q.split(',').map(s => s.trim()).filter(Boolean);
    let pool = countryFC.features;
    for (const code of codes) {
      const f = pool.find(x => String(x.properties.adcode) === code);
      if (!f) break;
      if (f.properties.level === 'province') {
        await drillProvince({ f });
        await sleep(2400);
      } else {
        await drillInto({ f });
        await sleep(2400);
      }
      pool = await loadChildren(code);
    }
  }

  /* ============================ 提示 ============================ */
  let toastT;
  function toast(html, ms = 3400) {
    els.toast.innerHTML = html;
    els.toast.classList.add('is-on');
    clearTimeout(toastT);
    toastT = setTimeout(() => els.toast.classList.remove('is-on'), ms);
  }

  /* ============================ 南海诸岛附图 ============================ */
  function buildInset() {
    const box = $('inset');
    if (!box || !countryFC) return;

    const LON = [105.2, 124.8], LAT = [2.6, 24.2];
    const W = 158, H = 186;
    const px = lon => ((lon - LON[0]) / (LON[1] - LON[0])) * W;
    const py = lat => H - ((lat - LAT[0]) / (LAT[1] - LAT[0])) * H;

    const toPath = geom => {
      const polys = geom.type === 'Polygon' ? [geom.coordinates]
                  : geom.type === 'MultiPolygon' ? geom.coordinates : [];
      let d = '';
      polys.forEach(poly => poly.forEach(ring => {
        ring.forEach((c, i) => {
          const x = px(c[0]), y = py(c[1]);
          if (x < -20 || x > W + 20 || y < -20 || y > H + 20) { d += (i ? 'L' : 'M') + x.toFixed(1) + ' ' + y.toFixed(1); return; }
          d += (i ? 'L' : 'M') + x.toFixed(1) + ' ' + y.toFixed(1);
        });
        d += 'Z';
      }));
      return d;
    };

    const touch = f => {
      const b = bboxOf([f]);
      return !(b[2] < LON[0] || b[0] > LON[1] || b[3] < LAT[0] || b[1] > LAT[1]);
    };

    let g = '';
    countryFC.features
      .filter(f => f.properties.level === 'province' && touch(f))
      .forEach(f => {
        g += `<path d="${toPath(f.geometry)}" fill="rgba(200,16,46,.18)" stroke="${RED}" stroke-width=".7" stroke-opacity=".6"/>`;
      });

    const jd = countryFC.features.find(f => String(f.properties.adcode) === '100000_JD');
    if (jd) g += `<path d="${toPath(jd.geometry)}" fill="rgba(201,162,39,.28)" stroke="${GOLD}" stroke-width="1.1" stroke-dasharray="3 2" stroke-linecap="round"/>`;

    box.innerHTML = `
      <div class="inset__hd">南海诸岛</div>
      <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet" role="img" aria-label="南海诸岛附图">
        <rect width="${W}" height="${H}" fill="#e9f1f7"/>
        ${g}
      </svg>
      <div class="inset__ft">十段线 · 国家版图完整</div>`;
    box.hidden = false;
  }

  /* ============================ 红色场馆定位 ============================ */
  const sleepMs = ms => new Promise(r => setTimeout(r, ms));

  /* 依次：广东省 → 所在市 → 所在区县，最后弹出该场馆卡片 */
  async function gotoRedSite(name) {
    const site = RED_SITES.find(s => s.name === name);
    if (!site || !countryFC) return;
    hideSpot();
    closePanelIfCompact();

    const prov = countryFC.features.find(f => f.properties.name === '广东省');
    if (!prov) return;

    if (!current.province || current.province.properties.name !== '广东省') {
      drillProvince({ f: prov });
      await sleepMs(1400);
    }

    const provKids = await loadChildren(prov.properties.adcode);
    const city = provKids.find(x => String(x.properties.adcode) === String(site.cityAdcode));
    if (city) {
      drillInto({ f: city });
      await sleepMs(1500);
    }

    if (site.districtAdcode) {
      const cityKids = await loadChildren(site.cityAdcode);
      const dist = cityKids.find(x => String(x.properties.adcode) === String(site.districtAdcode));
      if (dist) {
        drillInto({ f: dist });
        await sleepMs(1600);
      }
    }

    toast(`已定位：<b class="t-hi">${esc(site.name)}</b><br>${esc(site.addr)}`, 5200);
  }

  function closePanelIfCompact() {
    if (window.innerWidth < 860) closePanel();
  }

  /* ============================ 地图搜索框 ============================ */
  function setupSearch() {
    const box = document.getElementById('searchwrap');
    const input = document.getElementById('q');
    const drop = document.getElementById('qs');
    const clear = document.getElementById('q-clear');
    const btn = document.getElementById('btn-search');
    if (!box || !input || !drop) return;

    let items = [];
    let active = -1;

    function close() { drop.hidden = true; drop.innerHTML = ''; active = -1; }

    if (btn) {
      btn.onclick = () => {
        const show = box.hidden;
        box.hidden = !show;
        btn.classList.toggle('is-on', show);
        if (show) { input.focus(); if (input.value.trim()) search(input.value); }
        else { input.value = ''; search(''); close(); }
      };
    }

    function paint() {
      box.classList.toggle('has-q', !!input.value);
      if (!items.length) {
        drop.innerHTML = input.value.trim()
          ? '<div class="qs__empty">没有找到匹配项</div>' : '';
        drop.hidden = !input.value.trim();
        return;
      }
      drop.innerHTML =
        '<div class="qs__hd">红色场馆</div>' +
        items.map((it, i) => `<button class="qs__item${i === active ? ' is-active' : ''}" data-i="${i}">
            <span class="qs__t">${hl(it.name, input.value.trim())}</span>
            <span class="qs__p">${esc(it.city)}${it.district ? ' · ' + esc(it.district) : ''}${it.town ? ' · ' + esc(it.town) : ''}</span>
          </button>`).join('');
      drop.hidden = false;
    }

    function search(q) {
      const s = q.trim().toLowerCase();
      if (!s) { items = []; active = -1; close(); box.classList.remove('has-q'); return; }
      items = RED_SITES
        .filter(x => `${x.name} ${x.addr} ${x.city} ${x.district || ''} ${x.town || ''}`.toLowerCase().includes(s))
        .slice(0, 12);
      active = -1;
      paint();
    }

    input.addEventListener('input', () => search(input.value));
    input.addEventListener('focus', () => { if (input.value.trim()) search(input.value); });
    clear.addEventListener('click', () => { input.value = ''; search(''); input.focus(); });

    drop.addEventListener('click', ev => {
      const b = ev.target.closest('.qs__item');
      if (!b) return;
      const it = items[+b.dataset.i];
      if (it) { input.value = ''; search(''); input.blur(); gotoRedSite(it.name); }
    });

    input.addEventListener('keydown', ev => {
      if (ev.key === 'Escape') {
        input.value = ''; search('');
        box.hidden = true;
        if (btn) btn.classList.remove('is-on');
        input.blur();
        return;
      }
      if (!items.length) return;
      if (ev.key === 'ArrowDown') { ev.preventDefault(); active = Math.min(items.length - 1, active + 1); paint(); }
      if (ev.key === 'ArrowUp') { ev.preventDefault(); active = Math.max(0, active - 1); paint(); }
      if (ev.key === 'Enter') {
        ev.preventDefault();
        const it = items[active >= 0 ? active : 0];
        if (it) { input.value = ''; search(''); input.blur(); gotoRedSite(it.name); }
      }
    });

    document.addEventListener('click', ev => {
      if (!box.contains(ev.target) && ev.target !== btn) close();
    });
  }

  /* ============================ 广东 3D 立体 ============================ */
  let is3D = false;

  function redCountByCity() {
    const m = new Map();
    RED_SITES.forEach(s => {
      if (!s.cityAdcode) return;
      m.set(String(s.cityAdcode), (m.get(String(s.cityAdcode)) || 0) + 1);
    });
    return m;
  }

  async function toggle3D(force) {
    const on = force != null ? force : !is3D;
    is3D = on;
    const btn = document.getElementById('btn-3d');
    if (btn) btn.classList.toggle('is-on', on);

    if (!on) {
      if (map.getLayer('city-3d')) map.setLayoutProperty('city-3d', 'visibility', 'none');
      map.easeTo({ pitch: 0, bearing: 0, duration: 700 });
      setTimeout(() => { try { map.setMaxPitch(0); } catch (_) {} }, 900);
      return;
    }

    // 进入广东省
    const prov = countryFC && countryFC.features.find(f => f.properties.name === '广东省');
    if (!prov) return;
    const cities = await loadChildren(prov.properties.adcode);
    if (!cities.length) return;

    const counts = redCountByCity();
    const fc = {
      type: 'FeatureCollection',
      features: cities.map(f => ({
        ...f,
        properties: { ...f.properties, red: counts.get(String(f.properties.adcode)) || 0 }
      }))
    };

    if (map.getSource('city3d')) {
      map.getSource('city3d').setData(fc);
    } else {
      map.addSource('city3d', { type: 'geojson', data: fc });
      map.addLayer({
        id: 'city-3d', type: 'fill-extrusion', source: 'city3d',
        paint: {
          'fill-extrusion-color': ['interpolate', ['linear'], ['get', 'red'],
            0, '#efdfc0', 3, '#dfa478', 8, '#c05a46', 16, '#8f2422'],
          /* 只要一点起伏：基地 2km，每处红色场馆 +1.5km，
             最高约 33km（约省域宽度的 3%），是浅浅的浮雕而非高塔 */
          'fill-extrusion-height': ['+', 2000, ['*', ['get', 'red'], 1500]],
          'fill-extrusion-base': 0,
          'fill-extrusion-opacity': 0.78
        }
      });
    }
    map.setLayoutProperty('city-3d', 'visibility', 'visible');

    if (!current.province || current.province.properties.name !== '广东省') {
      drillProvince({ f: prov });
      await sleepMs(1400);
    }
    // 平时锁死俯仰，进入 3D 时才临时放开
    try { map.setMaxPitch(70); } catch (_) {}
    map.easeTo({ pitch: 46, bearing: -14, duration: 1200 });
    toast('广东 <b class="t-hi">立体浮雕</b>：起伏高度对应各市收录的红色场馆数量', 4600);
  }

  /* ============================ 红色场馆点位 ============================ */
  /* 数据来自 data/red-sites.geo.json（由 tools/geocode-red-sites.mjs 用高德地理编码生成，
     与高德底图同为 GCJ-02，可直接对齐）。没有坐标的场馆不出点，避免假点位。 */
  let VENUES = [];
  let venuePins = [];

  function clearVenues() {
    venuePins.forEach(p => p.wrap.remove());
    venuePins = [];
  }

  function sitesForView() {
    if (!VENUES.length) return [];
    const lvl = current.level;
    if (lvl >= 3 && current.region) {
      const ad = String(current.region.properties.adcode);
      const byD = VENUES.filter(v => String(v.districtAdcode) === ad);
      if (byD.length) return byD;
      const cityAd = current.city ? String(current.city.properties.adcode) : null;
      return VENUES.filter(v => String(v.cityAdcode) === cityAd);
    }
    if (lvl === 2 && current.city) {
      const ad = String(current.city.properties.adcode);
      return VENUES.filter(v => String(v.cityAdcode) === ad);
    }
    if (lvl === 1) return VENUES;          // 广东省：全省场馆
    return [];
  }


  /* 四类手绘图标：旧址=红旗 故居=小屋 陵园=纪念碑 馆=五角星 */
  function venueIconSvg(name) {
    const C = '#b8342e';
    let body;
    if (/陵园|烈士/.test(name)) {
      body = '<polygon points="12,2 6,3 7.5,15 16.5,15 18,3" fill="' + C + '"/>' +
             '<rect x="4.5" y="15" width="15" height="3.2" rx="0.8" fill="' + C + '"/>';
    } else if (/故居/.test(name)) {
      body = '<polygon points="12,2.5 21,10 3,10" fill="' + C + '"/>' +
             '<rect x="5.6" y="10" width="12.8" height="10.4" rx="0.8" fill="' + C + '"/>';
    } else if (/旧址|遗址|标语/.test(name)) {
      body = '<rect x="5.2" y="3" width="2.6" height="18" rx="1" fill="' + C + '"/>' +
             '<polygon points="7.8,3.4 20,7.2 7.8,11" fill="' + C + '"/>';
    } else {
      body = '<polygon points="12,2 14.6,8.6 21.6,9 16.2,13.4 18,20.2 12,16.4 6,20.2 7.8,13.4 2.4,9 9.4,8.6" fill="' + C + '"/>';
    }
    return '<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">' + body + '</svg>';
  }

  function makeVenuePin(v) {
    const wrap = document.createElement('div');
    wrap.className = 'pinwrap';
    const el = document.createElement('button');
    el.type = 'button';
    el.className = 'pin pin--venue';
    el.setAttribute('aria-label', v.name);
    el.innerHTML =
      '<span class="pin__ring"></span><span class="pin__dot">' + venueIconSvg(v.name) + '</span>' +
      '<span class="pin__card"><span class="pin__name"></span></span>';
    el.querySelector('.pin__name').textContent = v.name;
    el.addEventListener('click', ev => {
      ev.stopPropagation();
      showVenueCard(v, map.project([v.lng, v.lat]));
    });

    const lngLat = [v.lng, v.lat];
    wrap.appendChild(el);
    new maplibregl.Marker({ element: wrap, anchor: 'center' }).setLngLat(lngLat).addTo(map);
    return { row: { adcode: 'v_' + v.name, name: v.name, level: 'venue' }, el, wrap, lngLat, venue: v };
  }

  function updateVenues() {
    clearVenues();
    const list = sitesForView().filter(v => isFinite(v.lng) && isFinite(v.lat));
    if (!list.length) { scheduleDeclutter(); return; }

    /* 就近聚合：屏幕上靠得很近的场馆合并成一个「N 处」气泡，点开再散开，
       避免老城区几十个点糊成一团 */
    const R = 46;
    const pts = list.map(v => ({
      v,
      p: map.project([v.lng, v.lat])
    })).filter(o => isFinite(o.p.x) && isFinite(o.p.y));

    const used = new Set();
    const groups = [];
    pts.forEach((o, i) => {
      if (used.has(i)) return;
      const g = [o.v];
      used.add(i);
      pts.forEach((q, j) => {
        if (used.has(j) || i === j) return;
        if (Math.hypot(o.p.x - q.p.x, o.p.y - q.p.y) < R) { g.push(q.v); used.add(j); }
      });
      groups.push(g);
    });

    groups.forEach(g => {
      if (g.length === 1) {
        venuePins.push(makeVenuePin(g[0]));
      } else {
        venuePins.push(makeClusterPin(g));
      }
    });

    venuePins.forEach((p, i) => setTimeout(() => p.el.classList.add('is-on'), 50 + i * 24));
    setTimeout(scheduleDeclutter, 60 + venuePins.length * 24 + 140);
  }

  /* 缩放后重新聚合（节流，避免频繁重建 DOM） */
  let venueZoomTimer = null;
  function scheduleVenueZoom() {
    if (!VENUES.length) return;
    clearTimeout(venueZoomTimer);
    venueZoomTimer = setTimeout(() => {
      if (current.level >= 1) updateVenues();
    }, 260);
  }

  function makeClusterPin(items) {
    const wrap = document.createElement('div');
    wrap.className = 'pinwrap';
    const el = document.createElement('button');
    el.type = 'button';
    el.className = 'pin pin--cluster';
    el.setAttribute('aria-label', `${items.length} 处红色场馆`);
    el.innerHTML = `<span class="pin__dot">${items.length}</span>` +
      `<span class="pin__card"><span class="pin__name">${items.length} 处红色场馆</span></span>`;

    const lng = items.reduce((s, v) => s + v.lng, 0) / items.length;
    const lat = items.reduce((s, v) => s + v.lat, 0) / items.length;

    el.addEventListener('click', ev => {
      ev.stopPropagation();
      // 点气泡：放大到这一簇
      map.easeTo({ center: [lng, lat], zoom: Math.min(15, map.getZoom() + 2), duration: 600 });
    });

    wrap.appendChild(el);
    new maplibregl.Marker({ element: wrap, anchor: 'center' }).setLngLat([lng, lat]).addTo(map);
    return { row: { adcode: 'c_' + lng + '_' + lat, name: `${items.length} 处场馆`, level: 'cluster' },
             el, wrap, lngLat: [lng, lat], cluster: items };
  }

  function showVenueCard(v, point) {
    spotBody.innerHTML = `
      <p class="spot__name">${esc(v.name)}</p>
      <p class="spot__path">${esc(v.city || '')}${v.district ? ' › ' + esc(v.district) : ''}${v.town ? ' › ' + esc(v.town) : ''}</p>
      <div class="spot__row"><span>地址</span><b>${esc(v.addr)}</b></div>
      <div class="spot__row"><span>类别</span><b>红色场馆</b></div>
      <div class="spot__hint">拖动地图可继续浏览，卡片会自动收起</div>`;

    const W = 300, H = 170;
    spotEl.hidden = false;
    requestAnimationFrame(() => spotEl.classList.add('is-on'));
  }

  /* ============================ 红色传承：铺满屏幕即显示 ============================ */
  /* 当某个行政区在屏幕上占的面积达到视口 75% 时，显示该地的红色场馆；
     高亮只画它自己的地块，不会溢到别的市 / 区去 */
  const COVER_THRESHOLD = 0.75;
  let redFocusId = null;
  let redPanelTimer = null;

  function coverageOf(feature) {
    const b = bboxOf([feature]);
    if (!isFinite(b[0])) return 0;
    const p1 = map.project([b[0], b[3]]);
    const p2 = map.project([b[2], b[1]]);
    const x0 = Math.max(0, Math.min(p1.x, p2.x));
    const x1 = Math.min(window.innerWidth, Math.max(p1.x, p2.x));
    const y0 = Math.max(0, Math.min(p1.y, p2.y));
    const y1 = Math.min(window.innerHeight, Math.max(p1.y, p2.y));
    if (x1 <= x0 || y1 <= y0) return 0;
    return ((x1 - x0) * (y1 - y0)) / (window.innerWidth * window.innerHeight);
  }

  function sitesOfRegion(props) {
    // 市：按市名匹配；区县：按区县名匹配
    if (props.level === 'province') return RED_SITES;
    if (props.level === 'city') return RED_SITES.filter(s => s.city === props.name);
    if (props.level === 'district') {
      return RED_SITES.filter(s => s.district === props.name ||
        (!s.district && s.city && current.city && s.city === current.city.properties.name));
    }
    return [];
  }

  function updateRedFocus() {
    clearTimeout(redPanelTimer);
    redPanelTimer = setTimeout(() => {
      const pool = detailFeats.length ? detailFeats : contextFeats;
      let best = null, bestCov = 0;
      for (const f of pool) {
        if (!f.properties || !f.properties.level) continue;
        const c = coverageOf(f);
        if (c > bestCov) { bestCov = c; best = f; }
      }

      const panel = document.getElementById('redpanel');
      const title = document.getElementById('red-title');
      const body = document.getElementById('red-body');
      if (!panel) return;

      if (!best || bestCov < COVER_THRESHOLD) {
        panel.hidden = true;
        setRedFocus(null);
        return;
      }

      const p = best.properties;
      const id = String(p.adcode);
      if (id !== redFocusId) {
        redFocusId = id;
        setRedFocus(best);
      }

      const sites = sitesOfRegion(p);
      title.innerHTML = `${esc(p.name)}<small>红色传承 · ${sites.length} 处</small>`;
      body.innerHTML = sites.length
        ? `<ul>${sites.slice(0, 6).map(s => `<li>${esc(s.name)}</li>`).join('')}</ul>` +
          (sites.length > 6 ? `<div class="more">…等 ${sites.length} 处，可在「说」中查看全部</div>` : '')
        : '<div class="none">该区域暂无收录的红色场馆</div>';
      panel.hidden = false;
    }, 120);
  }

  function setRedFocus(feature) {
    const s = map.getSource('redfocus');
    if (!s) return;
    s.setData({
      type: 'FeatureCollection',
      features: feature ? [feature] : []
    });
  }

  /* ============================ 说明面板 ============================ */
  /* ---------- 红色场馆：省 › 市 › 区县 › 乡镇 四级树 ---------- */
  function buildRedTree() {
    const root = { name: '广东省', depth: 1, children: new Map(), sites: [] };
    const ensure = (map, key, depth) => {
      if (!map.has(key)) map.set(key, { name: key, depth, children: new Map(), sites: [] });
      return map.get(key);
    };
    RED_SITES.forEach(s => {
      const city = ensure(root.children, s.city || '其他', 2);
      if (!s.district) { city.sites.push(s); return; }
      const dist = ensure(city.children, s.district, 3);
      if (!s.town) { dist.sites.push(s); return; }
      ensure(dist.children, s.town, 4).sites.push(s);
    });
    return root;
  }

  function countOf(node) {
    let n = node.sites.length;
    for (const c of node.children.values()) n += countOf(c);
    return n;
  }

  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  function hl(text, q) {
    const t = esc(text);
    if (!q) return t;
    const i = text.toLowerCase().indexOf(q.toLowerCase());
    if (i < 0) return t;
    return esc(text.slice(0, i)) + '<mark>' + esc(text.slice(i, i + q.length)) + '</mark>' + esc(text.slice(i + q.length));
  }

  function siteMatches(s, q) {
    if (!q) return true;
    const hay = `${s.name} ${s.addr} ${s.city} ${s.district || ''} ${s.town || ''}`.toLowerCase();
    return hay.includes(q.toLowerCase());
  }

  function renderNode(node, q) {
    const kids = [...node.children.values()]
      .map(c => renderNode(c, q))
      .filter(Boolean);

    const own = node.sites.filter(s => siteMatches(s, q));
    if (q && !kids.length && !own.length) return '';

    const total = countOf(node);
    const head = `<summary><span>${hl(node.name, q)}</span><span class="n-count">${total}</span></summary>`;
    const list = own.length
      ? `<ul>${own.map(s => `<li><button data-site="${esc(s.name)}">${hl(s.name, q)}<span class="s-addr">${esc(s.addr)}</span></button></li>`).join('')}</ul>`
      : '';
    const open = q ? ' open' : (node.depth <= 2 ? ' open' : '');
    return `<details${open} class="lv${node.depth}">${head}${kids.join('')}${list}</details>`;
  }

  function renderTree(q) {
    const box = document.getElementById('red-tree');
    if (!box) return;
    const tree = buildRedTree();
    box.innerHTML = renderNode(tree, q || '') || '<p style="color:#86868b">没有匹配的场馆</p>';
  }
  function buildAbout() {
    return `
      <h3>作品主题</h3>
      <p><strong>数绘湾区红脉 · 践行医者初心</strong>——粤港澳大湾区红色文化资源思政数字地图。</p>
      <p>以国家标准公开版地图为底图，用「地球 → 中国 → 省 → 市 → 区县」的逐级下钻，
      呈现广东红色文化资源与医疗卫生事业的空间脉络。</p>

      <div class="note">
        <strong>收录范围：</strong>本作品<strong>仅收录广东省</strong>的红色场馆与红色文化资源
        （依据课程附件《广东革命文化与红色记忆场馆名录》，共 ${RED_SITES.length} 处）。
        <strong>未收录其他省、自治区、直辖市的红色点位</strong>；
        点开其他省份时仅显示行政区划，不含场馆数据。
      </div>

      <h3>核心机制</h3>
      <table>
        <tr><th>层级</th><th>展开规则</th></tr>
        <tr><td>省</td><td>省会优先，其余依次展开</td></tr>
        <tr><td>市</td><td>市辖区 / 主城区优先，其余依次展开</td></tr>
        <tr><td>区县</td><td>按行政区划代码依次展开</td></tr>
        <tr><td>乡镇</td><td>高德行政区划顺序</td></tr>
      </table>
      <p style="font-size:12px;color:#86868b">
        展开先后统一依据 ${GDP.year} 年 GDP 公开统计口径整理值排序，
        仅用于决定出现次序，界面上不显示数值。
      </p>

      <h3>创作团队</h3>
      <p>广州卫生职业技术学院　2025 级针灸推拿专业</p>
      <p>马晟焘　王术清　伍晟楠　刘嘉韡　林熹桐　曾庆均</p>
      <p style="font-size:11px;color:#86868b">（按姓氏笔画排名）</p>

      <h3>数据与资源致谢</h3>
      <p>本作品使用了以下公开网络资源，谨致谢意：</p>
      <table>
        <tr><th>资源</th><th>提供方</th><th>用途</th></tr>
        <tr><td>高德地图瓦片服务</td><td>高德开放平台（lbs.amap.com）</td><td>标准底图与卫星影像</td></tr>
        <tr><td>高德地理编码服务</td><td>高德开放平台</td><td>64 处场馆经纬度解析</td></tr>
        <tr><td>DataV.GeoAtlas 行政区划</td><td>阿里云计算有限公司</td><td>全国省 / 市 / 区县行政界线</td></tr>
        <tr><td>MapLibre GL JS</td><td>MapLibre 开源社区</td><td>地图渲染引擎</td></tr>
        <tr><td>广东革命文化与红色记忆场馆名录</td><td>课程教学方案附件二</td><td>场馆名称与地址</td></tr>
      </table>

      <div class="note">
        <strong>关于国家版图：</strong>本作品严格遵循《地图管理条例》与国家标准地图。
        所绘疆域完整包含台湾省、香港特别行政区、澳门特别行政区，
        以及南海诸岛与十段线，不存在任何形式的「问题地图」表述。
      </div>

      <h3>红色场馆名录（${RED_SITES.length} 处 · 按省 › 市 › 区县 › 乡镇 分层）</h3>
      <input class="panel__search" id="tree-q" type="search" placeholder="在名录中搜索场馆…" autocomplete="off" />
      <div class="tree" id="red-tree"></div>
    `;
  }

  function openPanel() {
    els.panelTitle.textContent = '作品说明';
    els.panelBody.innerHTML = buildAbout();
    els.panel.classList.add('is-open');
    els.panel.setAttribute('aria-hidden', 'false');
    els.panelBody.scrollTop = 0;

    renderTree('');

    const tq = $('tree-q');
    if (tq) {
      let t = 0;
      tq.addEventListener('input', () => {
        clearTimeout(t);
        t = setTimeout(() => renderTree(tq.value.trim()), 130);
      });
    }
    els.panelBody.addEventListener('click', ev => {
      const btn = ev.target.closest('button[data-site]');
      if (btn) gotoRedSite(btn.dataset.site);
    });
  }

  /* ============================ 底图切换 ============================ */
  /* auto：球面阶段用卫星影像，落地后自动切标准图（高德标准图 z<3 为空白） */
  let baseMode = 'auto';
  let baseApplied = null;

  function applyBasemap(force) {
    if (!map.getLayer('sat')) return;
    const z = map.getZoom();
    let sat;
    if (baseMode === 'sat') sat = true;
    else if (baseMode === 'vec') sat = false;
    else sat = z < 3.15;

    const key = String(sat);
    if (!force && key === baseApplied) return;
    baseApplied = key;

    map.setLayoutProperty('sat', 'visibility', sat ? 'visible' : 'none');
    map.setLayoutProperty('vec', 'visibility', sat ? 'none' : 'visible');
  }

  /* ============================ UI 绑定 ============================ */
  function bindUI() {
    const app = document.getElementById('app');

    /* —— 隐藏 / 显示界面 —— */
    function setUIHidden(hide) {
      app.classList.toggle('ui-hidden', hide);
      try { localStorage.setItem('sz-ui-hidden', hide ? '1' : '0'); } catch (_) {}
      if (hide) closePanel();
    }
    const btnHide = document.getElementById('btn-hide');
    const btnShow = document.getElementById('btn-show');
    if (btnHide) btnHide.onclick = () => setUIHidden(true);
    if (btnShow) btnShow.onclick = () => setUIHidden(false);
    try { if (localStorage.getItem('sz-ui-hidden') === '1') setUIHidden(true); } catch (_) {}

    /* —— 全屏：作用于 #app，保证界面控件一并进入全屏 —— */
    const btnFull = document.getElementById('btn-full');
    if (btnFull) {
      btnFull.onclick = async () => {
        try {
          if (document.fullscreenElement) {
            await document.exitFullscreen();
          } else if (app.requestFullscreen) {
            await app.requestFullscreen();
          } else if (app.webkitRequestFullscreen) {
            app.webkitRequestFullscreen();
          } else {
            toast('当前浏览器不支持全屏，可按 <b class="t-hi">F11</b> 进入浏览器全屏。');
          }
        } catch (e) {
          toast('全屏被浏览器拦截，可按 <b class="t-hi">F11</b> 进入浏览器全屏。');
        }
      };
    }
    document.addEventListener('fullscreenchange', () => {
      const on = !!document.fullscreenElement;
      btnFull && (btnFull.textContent = on ? '退' : '全');
      btnFull && (btnFull.title = on ? '退出全屏' : '全屏');
      // 全屏改变可视区域，必须让地图重新计算尺寸
      requestAnimationFrame(() => { map.resize(); scheduleDeclutter(); });
      setTimeout(() => { map.resize(); scheduleDeclutter(); }, 260);
    });

    document.getElementById('btn-replay').onclick = () => { resetToChina({ animate: false }).then(intro); };
    document.getElementById('btn-basemap').onclick = ev => {
      baseMode = baseMode === 'vec' ? 'sat' : 'vec';
      ev.currentTarget.classList.toggle('is-on', baseMode === 'sat');
      ev.currentTarget.textContent = baseMode === 'sat' ? '标' : '卫';
      ev.currentTarget.title = baseMode === 'sat' ? '当前为卫星图，点击切换标准图' : '当前为标准图，点击切换卫星图';
      applyBasemap(true);
    };
    document.getElementById('btn-panel').onclick = openPanel;
    document.getElementById('panel-close').onclick = closePanel;
    document.getElementById('spot-close').onclick = hideSpot;
    document.getElementById('btn-3d').onclick = () => toggle3D();
    setupSearch();

    window.addEventListener('keydown', ev => {
      if (ev.key === 'Escape') {
        if (!spotEl.hidden) hideSpot();
        else if (els.panel.classList.contains('is-open')) closePanel();
        else if (app.classList.contains('ui-hidden')) setUIHidden(false);
        else backOne();
      }
      if ((ev.key === 'h' || ev.key === 'H') && !ev.ctrlKey && !ev.metaKey && !ev.altKey) {
        setUIHidden(!app.classList.contains('ui-hidden'));
      }
      if (ev.key === 'Backspace' && current.level > 0) { ev.preventDefault(); backOne(); }
    });
  }

  function closePanel() {
    els.panel.classList.remove('is-open');
    els.panel.setAttribute('aria-hidden', 'true');
  }

  /* ============================ 图层 ============================ */
  function addOverlayLayers() {
    const provF = ['==', ['get', 'level'], 'province'];
    const jdF   = ['==', ['get', 'adcode'], '100000_JD'];

    map.addLayer({
      id: 'jd-fill', type: 'fill', source: 'prov', filter: jdF, maxzoom: 7.6,
      paint: { 'fill-color': GOLD, 'fill-opacity': 0.18 }
    });
    map.addLayer({
      id: 'jd-line', type: 'line', source: 'prov', filter: jdF, maxzoom: 7.6,
      paint: {
        'line-color': GOLD,
        'line-width': ['interpolate', ['linear'], ['zoom'], 2, 0.9, 5, 1.7, 8, 2.6],
        'line-dasharray': [3, 2], 'line-opacity': 0.95
      }
    });
    map.addLayer({
      id: 'prov-fill', type: 'fill', source: 'prov', filter: provF,
      paint: {
        'fill-color': ['case',
          ['boolean', ['feature-state', 'selected'], false], '#f3e6cb',
          ['boolean', ['feature-state', 'hover'], false], '#f8efd9',
          '#fbf6ea'],
        /* 未选中的省份淡化，只留极浅底色 */
        'fill-opacity': ['case',
          ['boolean', ['feature-state', 'dim'], false], 0.20,
          ['boolean', ['feature-state', 'selected'], false], 0.66,
          ['boolean', ['feature-state', 'hover'], false], 0.50, 0.26]
      }
    });
    map.addLayer({
      id: 'prov-line', type: 'line', source: 'prov', filter: provF,
      paint: {
        'line-color': ['case',
          ['boolean', ['feature-state', 'dim'], false], '#cfc3ab',
          ['boolean', ['feature-state', 'selected'], false], '#9e2e2e',
          '#c0a98a'],
        'line-width': ['case',
          ['boolean', ['feature-state', 'dim'], false], 0.5,
          ['boolean', ['feature-state', 'selected'], false], 2.8,
          ['boolean', ['feature-state', 'hover'], false], 1.6, 0.85],
        'line-opacity': ['case',
          ['boolean', ['feature-state', 'dim'], false], 0.45,
          ['boolean', ['feature-state', 'selected'], false], 1,
          ['boolean', ['feature-state', 'hover'], false], 0.95, 0.80]
      }
    });
    map.addLayer({
      id: 'focus-fill', type: 'fill', source: 'focus',
      paint: { 'fill-color': RED_DEEP, 'fill-opacity': 0.05 }
    });
    map.addLayer({
      id: 'focus-line', type: 'line', source: 'focus',
      paint: { 'line-color': RED_DEEP, 'line-width': 2.6, 'line-opacity': 0.9 }
    });
    /* 红色传承高亮：只填该地块本身，天然不会溢出到相邻行政区 */
    map.addLayer({
      id: 'redfocus-fill', type: 'fill', source: 'redfocus',
      paint: { 'fill-color': '#b8342e', 'fill-opacity': 0.16 }
    });
    map.addLayer({
      id: 'redfocus-line', type: 'line', source: 'redfocus',
      paint: { 'line-color': '#8f2422', 'line-width': 3, 'line-opacity': 0.95 }
    });
    /* 同级上下文：当前区域的「兄弟」行政区，保持可见且可点击，
       随时可以直接跳到别的省 / 市 / 区县，不必先退回上一级 */
    map.addLayer({
      id: 'context-fill', type: 'fill', source: 'context',
      paint: {
        'fill-color': ['case', ['boolean', ['feature-state', 'hover'], false], RED, RED],
        'fill-opacity': ['case',
          ['boolean', ['feature-state', 'hover'], false], 0.16, 0.03]
      }
    });
    map.addLayer({
      id: 'context-line', type: 'line', source: 'context',
      paint: {
        'line-color': ['case', ['boolean', ['feature-state', 'hover'], false], RED_DEEP, GOLD],
        'line-width': ['case', ['boolean', ['feature-state', 'hover'], false], 1.8, 1.1],
        'line-opacity': ['case', ['boolean', ['feature-state', 'hover'], false], 0.95, 0.55],
        'line-dasharray': [2, 1.4]
      }
    });
    map.addLayer({
      id: 'detail-fill', type: 'fill', source: 'detail',
      paint: {
        'fill-color': ['case',
          ['boolean', ['feature-state', 'core'], false], '#f6e7c6', '#f8efdb'],
        'fill-opacity': ['case',
          ['boolean', ['feature-state', 'selected'], false], 0.46,
          ['*', ['coalesce', ['feature-state', 'reveal'], 0], 0.40]]
      }
    });
    map.addLayer({
      id: 'detail-line', type: 'line', source: 'detail',
      paint: {
        'line-color': ['case',
          ['boolean', ['feature-state', 'selected'], false], '#9e2e2e', '#c9b18e'],
        'line-width': ['case',
          ['boolean', ['feature-state', 'selected'], false], 2.8,
          ['*', ['coalesce', ['feature-state', 'reveal'], 0], 1.5]],
        'line-opacity': ['case',
          ['boolean', ['feature-state', 'selected'], false], 1,
          ['coalesce', ['feature-state', 'reveal'], 0]]
      }
    });
  }

  function bindMapEvents() {
    /* —— 悬停：显示所属 + 预取下一级边界（自绘判定，rAF 节流） —— */
    let hovRaf = 0, hovEv = null, hovKey = null, hovSrc = 'prov';
    map.on('mousemove', e => {
      hovEv = e;
      if (hovRaf) return;
      hovRaf = requestAnimationFrame(() => {
        hovRaf = 0;
        const ev = hovEv;
        if (!ev) return;
        const f = hitTest(ev.lngLat);
        const key = f ? String(f.properties.adcode) : null;

        if (hovKey && hovKey !== key) {
          try { map.setFeatureState({ source: hovSrc, id: hovKey }, { hover: false }); } catch (_) {}
        }
        if (!f) { hideTip(); map.getCanvas().style.cursor = ''; hovKey = null; return; }

        const src = sourceOfFeature(f);
        try { map.setFeatureState({ source: src, id: key }, { hover: true }); } catch (_) {}
        hovKey = key; hovSrc = src;

        const p = f.properties;
        if (p.adcode && (p.level === 'province' || p.level === 'city')) prefetchChildren(p.adcode);
        map.getCanvas().style.cursor = 'pointer';
        showTip(p, ev.point);
      });
    });

    map.on('mouseout', () => { hideTip(); map.getCanvas().style.cursor = ''; });

    /* —— 点击：无论当前在哪一级，点谁就进入谁 —— */
    function enterAt(f, point, lngLat) {
      if (!f) return;
      const p = f.properties || {};

      if (p.level === 'province') {
        // 点的正是当前省：交给内部图层处理；否则直接切到那个省
        if (current.province && String(p.adcode) === String(current.province.properties.adcode)) return;
        return drillProvince({ f });
      }
      if (p.level === 'city') return drillInto({ f }, lngLat);

      // 区县 / 乡镇：进入该区域并显示所属
      return drillInto({ f }, lngLat);
    }

    /* —— 点击：无论当前在哪一级，点谁就进入谁（自绘几何判定，稳定命中） —— */
    map.on('click', e => {
      const f = hitTest(e.lngLat);
      if (f) enterAt(f, e.point, e.lngLat);
    });

    /* —— 点击：无论当前在哪一级，点谁就进入谁（自绘几何判定，稳定命中） —— */
    map.on('click', e => {
      const f = hitTest(e.lngLat);
      if (f) enterAt(f, e.point);
    });

    /* 地图一移动就收起信息卡，保证拖动永远不被遮挡 */
    /* 地图一移动就收起信息卡，保证拖动永远不被遮挡
       （MapLibre 的 on() 不支持空格分隔事件名，必须逐个绑定） */
    ['movestart', 'dragstart', 'zoomstart'].forEach(ev =>
      map.on(ev, () => { hideSpot(); hideTip(); }));

    /* 球面/平面投影在两极附近都会出现瓦片拉花，
       限制中心纬度，避免把极点拖到屏幕中央 */
    map.on('moveend', () => {
      const c = map.getCenter();
      const LIMIT = 72;
      if (Math.abs(c.lat) > LIMIT) {
        map.easeTo({ center: [c.lng, c.lat > 0 ? LIMIT : -LIMIT], duration: 220 });
      }
    });

    map.on('moveend', () => { applyBasemap(); updateLabelMode(); scheduleDeclutter(); updateRedFocus(); scheduleVenueZoom(); });
    map.on('zoom', () => { applyBasemap(); updateLabelMode(); });
    map.on('resize', () => { scheduleDeclutter(); updateRedFocus(); scheduleVenueZoom(); });
  }

  /* ============================ 启动 ============================ */
  async function main() {
    map = new maplibregl.Map({
      container: 'map',
      style: {
        version: 8,
        projection: { type: 'globe' },
        sources: {
          sat:  { type: 'raster', tiles: AMAP_SAT, tileSize: 256, maxzoom: 18,
                  attribution: '底图 © 高德地图 | 界线 © DataV.GeoAtlas' },
          vec:  { type: 'raster', tiles: AMAP_STREET, tileSize: 256, maxzoom: 18 },
          prov:   { type: 'geojson', data: { type: 'FeatureCollection', features: [] } },
          focus:  { type: 'geojson', data: { type: 'FeatureCollection', features: [] } },
          redfocus: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } },
          context: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } },
          detail: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } }
        },
        layers: [
          { id: 'bg', type: 'background', paint: { 'background-color': '#e3edee' } },
          /* 高德标准图在 z<3 为空白瓦片；卫星图仅用于地球阶段。
             两图层靠 visibility 切换，避免同时拉取两套瓦片。
             raster-fade-duration 设为 0：省去新旧瓦片逐帧混合的开销 */
          { id: 'sat', type: 'raster', source: 'sat',
            paint: { 'raster-opacity': 1, 'raster-fade-duration': 0 } },
          { id: 'vec', type: 'raster', source: 'vec',
            layout: { visibility: 'none' },
            paint: { 'raster-opacity': 0.58, 'raster-fade-duration': 0,
                     'raster-saturation': -0.42, 'raster-contrast': -0.04 } }
        ]
      },
      center: [104.6, 33],
      zoom: 3.6,
      pitch: 0,
      bearing: 0,
      dragRotate: false,
      pitchWithRotate: false,
      touchPitch: false,
      maxPitch: 0,
      minZoom: 0.4,
      maxZoom: 16,
      renderWorldCopies: false,
      antialias: false,
      /* 关闭混合与动态重绘，降低低配机器的 GPU 压力 */
      attributionControl: { compact: true }
    });

    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
    map.touchZoomRotate.disableRotation();
    /* 滚轮缩放：以鼠标位置为锚点，滚到哪放大到哪，不必再去点左下进度条 */
    try {
      map.scrollZoom.enable();
      map.scrollZoom.setZoomRate(1 / 260);   // 默认 1/450，调快一些
    } catch (_) {}
    try { map.doubleClickZoom.enable(); } catch (_) {}
    try { map.boxZoom.disable(); } catch (_) {}
    window.__map = map;   // 便于现场调试与作品演示
    map.on('error', e => { if (e && e.error) console.warn('[map]', e.error.message); });

    /* 初始化不依赖单一事件：load / idle / 轮询 三路兜底，
       避免弱网或某些内核下 'load' 迟迟不触发而卡在启动页 */
    let booted = false;
    async function initApp() {
      if (booted) return;
      if (!map.getSource('prov')) { setTimeout(initApp, 300); return; }
      booted = true;

      try {
        if (!window.__GEO['100000']) await window.__loadScript(GEO + '100000.js');
        const gj = window.__GEO['100000'];
        if (!gj) throw new Error('no country data');
        gj.features = gj.features.map(f => ({ ...f, id: String(f.properties.adcode) }));
        countryFC = gj;
        map.getSource('prov').setData(gj);
      } catch (e) {
        els.bootT2.textContent = '底图数据加载失败，请检查网络后刷新';
        booted = false;
        setTimeout(initApp, 1500);
        return;
      }

      // 场馆补全区县 / 乡镇归属（失败不影响主流程）
      if (!window.__RED_RESOLVED) { try { await window.__loadScript('./data/red-sites.resolved.js'); } catch (_) {} }
      if (window.__RED_RESOLVED) {
        window.__RED_RESOLVED.forEach(r => {
          const s = RED_SITES.find(x => x.name === r.name);
          if (!s) return;
          s.cityAdcode = r.cityAdcode;
          s.district = r.district;
          s.districtAdcode = r.districtAdcode;
          s.town = r.town;
        });
      }

      // 场馆精确坐标（缺文件则不出点位，避免假点）
      if (!window.__RED_GEO) { try { await window.__loadScript('./data/red-sites.geo.js'); } catch (_) {} }
      VENUES = Array.isArray(window.__RED_GEO)
        ? window.__RED_GEO.filter(v => isFinite(v.lng) && isFinite(v.lat))
        : [];

      addOverlayLayers();
      applyBasemap(true);
      bindMapEvents();
      buildInset();
      bindUI();
      intro();
    }

    map.on('load', initApp);
    map.on('idle', initApp);
    setTimeout(initApp, 1200);
  }

  main();
})();
