/** アプリ本体：UI と生成器・2D 描画・3D 地球儀の接続 */

import { ERAS, getEra } from './world/eras.js';
import { eraAtAge, timelineMarks, AGE_MIN, AGE_MAX } from './world/timeline.js';
import { generateWorld, SIZES } from './world/worldgen.js';
import { buildRegions, buildLandmarks } from './world/regions.js';
import { BIOMES, BIOME_IDS, toMeters } from './world/biomes.js';
import { FAUNA, FLORA, faunaFor } from './world/fauna.js';
import { MapRenderer, VIEW_MODES } from './render/renderer.js';
import { GlobeRenderer } from './render/globe.js';
import { mulberry32, clamp } from './core/rng.js';

const $ = (s) => document.querySelector(s);
const canvas = $('#map');
const globeCanvas = $('#globe');
const globeOverlay = $('#globe-overlay');

const renderer = new MapRenderer(canvas);
let globe = null;

const state = {
  ma: 160,            // 百万年前。これが世界の唯一の時間軸
  seed: 'pangaea',
  size: 'medium',
  view: '2d',
  world: null,
  regions: null,
  marks: [],
  busy: false,
  spin: false,
};

/** 現在の年代が属する紀（キーフレームちょうどでなくても近いほうを返す） */
const currentEra = () => eraAtAge(state.ma);

// ---------- UI の組み立て ----------------------------------------------

function buildEraTabs() {
  const box = $('#era-tabs');
  box.innerHTML = '';
  const era = currentEra();
  for (const e of ERAS) {
    const b = document.createElement('button');
    b.style.setProperty('--era', e.accent);
    b.innerHTML = `<b>${e.name}</b><em>${e.ma} Ma</em>`;
    b.className = state.ma === e.ma ? 'on' : '';
    b.onclick = () => { setAge(e.ma, true); };
    box.appendChild(b);
  }
  $('#era-desc').innerHTML = `<b>${era.age}</b><br>${era.sub}`;
}

function buildTimeline() {
  const slider = $('#age');
  slider.min = AGE_MIN;
  slider.max = AGE_MAX;
  slider.value = state.ma;
  const ticks = $('#age-ticks');
  ticks.innerHTML = '';
  for (const m of timelineMarks()) {
    const el = document.createElement('span');
    el.textContent = m.name;
    el.style.left = `${((AGE_MAX - m.ma) / (AGE_MAX - AGE_MIN)) * 100}%`;
    el.style.color = m.accent;
    el.onclick = () => setAge(m.ma, true);
    ticks.appendChild(el);
  }
  slider.oninput = () => {
    state.ma = Number(slider.value);
    $('#age-label').textContent = state.ma;
    $('#era-desc').innerHTML = `<b>${currentEra().age}</b><br>${currentEra().sub}`;
    markActiveEra();
  };
  slider.onchange = () => regenerate();   // 離した時点で生成する（重いため）
  $('#age-label').textContent = state.ma;
}

function markActiveEra() {
  const btns = $('#era-tabs').children;
  ERAS.forEach((e, i) => btns[i] && btns[i].classList.toggle('on', state.ma === e.ma));
}

function setAge(ma, regen) {
  state.ma = ma;
  $('#age').value = ma;
  $('#age-label').textContent = ma;
  buildEraTabs();
  if (regen) regenerate();
}

function buildViewSwitch() {
  for (const b of $('#viewswitch').children) {
    b.onclick = () => setView(b.dataset.view);
    b.classList.toggle('on', b.dataset.view === state.view);
  }
}

function setView(view) {
  state.view = view;
  for (const b of $('#viewswitch').children) b.classList.toggle('on', b.dataset.view === view);
  const is3d = view === '3d';
  canvas.classList.toggle('hidden', is3d);
  globeCanvas.classList.toggle('hidden', !is3d);
  globeOverlay.classList.toggle('hidden', !is3d);
  $('#minimap-wrap').style.display = is3d ? 'none' : '';
  if (is3d && !globe) initGlobe();
  buildToggles();
  resize();
  draw();
}

function initGlobe() {
  globe = new GlobeRenderer(globeCanvas, globeOverlay);
  if (!globe.ok) {
    const box = document.createElement('div');
    box.id = 'gl-error';
    box.textContent = `3D 表示を開始できませんでした：${globe.error || 'WebGL 非対応'}`;
    $('#stage').appendChild(box);
    return;
  }
  globe.setMode(renderer.mode);
  for (const [k, v] of Object.entries(renderer.layers)) globe.setLayer(k, v);
  if (state.world) globe.setWorld(state.world, state.regions, state.marks);
}

function buildSizes() {
  const sel = $('#size');
  sel.innerHTML = '';
  for (const [k, v] of Object.entries(SIZES)) {
    const o = document.createElement('option');
    o.value = k; o.textContent = v.label;
    if (k === state.size) o.selected = true;
    sel.appendChild(o);
  }
  sel.onchange = () => { state.size = sel.value; regenerate(); };
}

function buildModes() {
  const box = $('#modes');
  box.innerHTML = '';
  for (const [k, label] of Object.entries(VIEW_MODES)) {
    const b = document.createElement('button');
    b.textContent = label;
    b.className = renderer.mode === k ? 'on' : '';
    b.onclick = () => {
      renderer.setMode(k);
      if (globe && globe.ok) globe.setMode(k);
      buildModes(); buildLegend(); draw();
    };
    box.appendChild(b);
  }
}

const LAYER_LABELS = {
  hillshade: '陰影起伏', rivers: '河川・湖', labels: '地名',
  marks: '名所', grid: '経緯線', borders: '海岸線',
};
const LAYER_3D = { ocean: '海面', atmosphere: '大気' };

function buildToggles() {
  const box = $('#toggles');
  box.innerHTML = '';
  const labels = state.view === '3d' ? { ...LAYER_LABELS, ...LAYER_3D } : LAYER_LABELS;
  for (const [k, label] of Object.entries(labels)) {
    if (state.view === '3d' && k === 'grid') continue;
    const l = document.createElement('label');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = k in renderer.layers ? renderer.layers[k] : (globe ? globe.layers[k] : true);
    cb.onchange = () => {
      if (k in renderer.layers) renderer.setLayer(k, cb.checked);
      if (globe && globe.ok) globe.setLayer(k, cb.checked);
      draw();
    };
    l.append(cb, document.createTextNode(label));
    box.appendChild(l);
  }
  if (state.view === '3d') {
    const l = document.createElement('label');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = state.spin;
    cb.onchange = () => { state.spin = cb.checked; if (state.spin) spinLoop(); };
    l.append(cb, document.createTextNode('自転'));
    box.appendChild(l);
  }
}

function buildLegend() {
  const box = $('#legend');
  box.innerHTML = '';
  const mode = renderer.mode;
  const addRamp = (grad, lo, hi) => {
    const d = document.createElement('div');
    d.innerHTML = `<span style="font-size:10.5px">${lo}</span>`;
    const i = document.createElement('i');
    i.className = 'ramp';
    i.style.cssText = `background:${grad};width:100%;height:12px;border-radius:3px`;
    d.appendChild(i);
    d.insertAdjacentHTML('beforeend', `<span style="font-size:10.5px">${hi}</span>`);
    box.appendChild(d);
  };

  if (mode === 'biome') {
    const counts = state.world ? state.world.stats.biomeCounts : {};
    const ids = BIOME_IDS.slice().sort((a, b) => (counts[b] || 0) - (counts[a] || 0));
    for (const id of ids) {
      const share = counts[id] || 0;
      if (share < 0.0004) continue;
      const b = BIOMES[id];
      const d = document.createElement('div');
      d.innerHTML = `<i style="background:rgb(${b.color.join(',')})"></i>${b.name}<b>${(share * 100).toFixed(1)}%</b>`;
      box.appendChild(d);
    }
  } else if (mode === 'elevation') {
    addRamp('linear-gradient(90deg,#08142f,#1c3a6e,#2e6a9e,#7eb2c8,#5c8c58,#94a860,#c4b06c,#a07a56,#f6f6f8)', '-6,200m', '+4,600m');
  } else if (mode === 'temperature') {
    addRamp('linear-gradient(90deg,#283c82,#468cbe,#8cc8aa,#ebdc8c,#e28c4a,#962228)', '-30℃', '+45℃');
  } else if (mode === 'moisture') {
    addRamp('linear-gradient(90deg,#b08a5c,#cebe80,#a8be76,#5c9c6c,#2a7080,#1a4478)', '極乾燥', '過湿潤');
  } else if (mode === 'crust') {
    addRamp('linear-gradient(90deg,#182a4c,#2a4c70,#806a52,#d8c296)', '海洋地殻', '大陸地殻');
  }
}

function buildStats() {
  const box = $('#stats');
  const w = state.world;
  if (!w) { box.innerHTML = ''; return; }
  const s = w.stats;
  const continents = state.regions.landmasses.filter((l) => l.kind === 'continent').length;
  const islands = state.regions.landmasses.length - continents;
  const rows = [
    ['年代', `${Math.round(w.era.ma)} 百万年前`],
    ['陸地率', `${(s.landRatio * 100).toFixed(1)} %`],
    ['平均気温', `${s.meanTemp.toFixed(1)} ℃`],
    ['最高標高', `${toMeters(s.maxElev).toLocaleString()} m`],
    ['最深海底', `${toMeters(s.minElev).toLocaleString()} m`],
    ['大陸 / 島', `${continents} / ${islands}`],
    ['名所', `${state.marks.length} 地点`],
    ['マップ', `${w.w} × ${w.h} セル`],
    ['1セル', `${(40075 / w.w).toFixed(0)} km`],
  ];
  box.innerHTML = rows.map(([k, v]) => `<div><span>${k}</span><b>${v}</b></div>`).join('');
}

// ---------- 生成 --------------------------------------------------------

async function regenerate() {
  if (state.busy) return;
  state.busy = true;
  const btn = $('#generate');
  btn.disabled = true;
  const prog = $('#progress');
  prog.classList.remove('hidden');
  const bar = prog.querySelector('i');
  const label = prog.querySelector('span');

  try {
    const world = await generateWorld(
      { seed: state.seed, ma: state.ma, size: state.size },
      (p, msg) => { bar.style.width = `${(p * 100).toFixed(1)}%`; label.textContent = msg; }
    );
    label.textContent = '地名を付けています';
    await new Promise((r) => requestAnimationFrame(() => r()));
    const regions = buildRegions(world);
    const marks = buildLandmarks(world, regions);
    bar.style.width = '100%';

    state.world = world;
    state.regions = regions;
    state.marks = marks;
    renderer.setWorld(world, regions, marks);
    if (globe && globe.ok) {
      label.textContent = '地球儀を組み立てています';
      await new Promise((r) => requestAnimationFrame(() => r()));
      globe.setWorld(world, regions, marks);
    }
    buildEraTabs();
    buildLegend();
    buildStats();
    hideInspector();
    draw();
  } catch (err) {
    label.textContent = `生成に失敗しました: ${err.message}`;
    console.error(err);
    await new Promise((r) => setTimeout(r, 2500));
  } finally {
    prog.classList.add('hidden');
    btn.disabled = false;
    state.busy = false;
  }
}

// ---------- 描画 --------------------------------------------------------

function resize() {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const r = $('#stage').getBoundingClientRect();
  for (const c of [canvas, globeCanvas, globeOverlay]) {
    c.width = Math.max(320, Math.round(r.width * dpr));
    c.height = Math.max(240, Math.round(r.height * dpr));
    c.style.width = `${r.width}px`;
    c.style.height = `${r.height}px`;
  }
  renderer.dpr = dpr;
  if (state.world) { renderer.clampCam(); draw(); }
}

let frame = 0;
function draw() {
  if (frame) return;
  frame = requestAnimationFrame(() => {
    frame = 0;
    if (state.view === '3d') {
      if (globe && globe.ok) globe.render();
    } else {
      renderer.render();
      drawMinimap();
    }
  });
}

function spinLoop() {
  if (!state.spin || state.view !== '3d' || !globe || !globe.ok) return;
  globe.cam.yaw += 0.0022;
  globe.render();
  requestAnimationFrame(spinLoop);
}

const mini = $('#minimap');
const miniCtx = mini.getContext('2d');
function drawMinimap() {
  const w = state.world;
  miniCtx.fillStyle = '#0a0e18';
  miniCtx.fillRect(0, 0, mini.width, mini.height);
  if (!w) return;
  miniCtx.drawImage(renderer.raster, 0, 0, mini.width, mini.height);
  const z = renderer.cam.zoom;
  const vw = (canvas.width / z) / w.w * mini.width;
  const vh = (canvas.height / z) / w.h * mini.height;
  const cx = renderer.cam.x / w.w * mini.width;
  const cy = renderer.cam.y / w.h * mini.height;
  miniCtx.strokeStyle = 'rgba(255,214,120,.9)';
  miniCtx.lineWidth = 1.5;
  for (const off of [-mini.width, 0, mini.width]) {
    miniCtx.strokeRect(cx - vw / 2 + off, cy - vh / 2, vw, vh);
  }
}

// ---------- 操作：2D マップ ---------------------------------------------

let drag = null;
canvas.addEventListener('pointerdown', (e) => {
  if (!state.world) return;
  canvas.setPointerCapture(e.pointerId);
  drag = { x: e.clientX, y: e.clientY, moved: 0 };
  canvas.classList.add('dragging');
});
canvas.addEventListener('pointermove', (e) => {
  if (!state.world) return;
  const dpr = renderer.dpr || 1;
  if (drag) {
    const dx = (e.clientX - drag.x) * dpr, dy = (e.clientY - drag.y) * dpr;
    drag.moved += Math.abs(dx) + Math.abs(dy);
    drag.x = e.clientX; drag.y = e.clientY;
    renderer.pan(dx, dy);
    draw();
  }
  updateCoords(renderer.toWorld(...canvasPoint(canvas, e)));
});
canvas.addEventListener('pointerup', (e) => {
  canvas.classList.remove('dragging');
  const wasClick = drag && drag.moved < 5;
  drag = null;
  if (wasClick) inspect(renderer.toWorld(...canvasPoint(canvas, e)));
});
canvas.addEventListener('pointerleave', () => { drag = null; canvas.classList.remove('dragging'); });
canvas.addEventListener('wheel', (e) => {
  if (!state.world) return;
  e.preventDefault();
  const [px, py] = canvasPoint(canvas, e);
  renderer.zoomAt(px, py, Math.exp(-e.deltaY * 0.0018));
  draw();
}, { passive: false });

// ---------- 操作：3D 地球儀 ---------------------------------------------

let gdrag = null;
globeCanvas.addEventListener('pointerdown', (e) => {
  if (!globe || !globe.ok) return;
  globeCanvas.setPointerCapture(e.pointerId);
  gdrag = { x: e.clientX, y: e.clientY, moved: 0 };
  globeCanvas.classList.add('dragging');
});
globeCanvas.addEventListener('pointermove', (e) => {
  if (!globe || !globe.ok) return;
  if (gdrag) {
    const dpr = renderer.dpr || 1;
    const dx = (e.clientX - gdrag.x) * dpr, dy = (e.clientY - gdrag.y) * dpr;
    gdrag.moved += Math.abs(dx) + Math.abs(dy);
    gdrag.x = e.clientX; gdrag.y = e.clientY;
    globe.rotate(dx, dy);
    draw();
  }
  const p = globe.pick(...canvasPoint(globeCanvas, e));
  updateCoords(p);
});
globeCanvas.addEventListener('pointerup', (e) => {
  globeCanvas.classList.remove('dragging');
  const wasClick = gdrag && gdrag.moved < 5;
  gdrag = null;
  if (wasClick) inspect(globe.pick(...canvasPoint(globeCanvas, e)));
});
globeCanvas.addEventListener('pointerleave', () => { gdrag = null; globeCanvas.classList.remove('dragging'); });
globeCanvas.addEventListener('wheel', (e) => {
  if (!globe || !globe.ok) return;
  e.preventDefault();
  globe.zoom(Math.exp(-e.deltaY * 0.0016));
  draw();
}, { passive: false });

mini.addEventListener('pointerdown', (e) => {
  if (!state.world) return;
  const r = mini.getBoundingClientRect();
  renderer.cam.x = ((e.clientX - r.left) / r.width) * state.world.w;
  renderer.cam.y = ((e.clientY - r.top) / r.height) * state.world.h;
  renderer.clampCam();
  draw();
});

function canvasPoint(c, e) {
  const dpr = renderer.dpr || 1;
  const r = c.getBoundingClientRect();
  return [(e.clientX - r.left) * dpr, (e.clientY - r.top) * dpr];
}

window.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
  const step = 60;
  switch (e.key.toLowerCase()) {
    case '1': setAge(230, true); break;
    case '2': setAge(160, true); break;
    case '3': setAge(90, true); break;
    case 'g': setView(state.view === '2d' ? '3d' : '2d'); break;
    case 'r': regenerate(); break;
    case ' ':
      if (state.view === '3d') { state.spin = !state.spin; buildToggles(); if (state.spin) spinLoop(); }
      break;
    case 'l':
      renderer.setLayer('labels', !renderer.layers.labels);
      if (globe && globe.ok) globe.setLayer('labels', renderer.layers.labels);
      buildToggles(); draw();
      break;
    case 'f':
      if (state.view === '3d') { globe.cam.dist = 4.0; globe.cam.pitch = -0.15; }
      else renderer.fit(renderer.cam.zoom <= (renderer.minZoom / 0.85) * 1.01);
      draw();
      break;
    case 'arrowleft': state.view === '3d' ? globe.rotate(-step, 0) : renderer.pan(step, 0); draw(); break;
    case 'arrowright': state.view === '3d' ? globe.rotate(step, 0) : renderer.pan(-step, 0); draw(); break;
    case 'arrowup': state.view === '3d' ? globe.rotate(0, -step) : renderer.pan(0, step); draw(); break;
    case 'arrowdown': state.view === '3d' ? globe.rotate(0, step) : renderer.pan(0, -step); draw(); break;
    case '+': case '=':
      state.view === '3d' ? globe.zoom(1.2) : renderer.zoomAt(canvas.width / 2, canvas.height / 2, 1.25);
      draw(); break;
    case '-':
      state.view === '3d' ? globe.zoom(1 / 1.2) : renderer.zoomAt(canvas.width / 2, canvas.height / 2, 0.8);
      draw(); break;
    default: return;
  }
  e.preventDefault();
});

// ---------- 地点の調査 ---------------------------------------------------

function latLon(world, x, y) {
  return { lat: 90 - 180 * (y / world.h), lon: (x / world.w) * 360 - 180 };
}

function updateCoords(p) {
  const w = state.world;
  const coords = $('#coords');
  if (!w || !p || p.y < 0 || p.y >= w.h) { coords.textContent = ''; return; }
  const i = w.idx(p.x, p.y);
  const { lat, lon } = latLon(w, p.x, p.y);
  const b = BIOMES[w.biomeAt(i)];
  coords.textContent =
    `${lat >= 0 ? 'N' : 'S'}${Math.abs(lat).toFixed(1)}° ${lon >= 0 ? 'E' : 'W'}${Math.abs(lon).toFixed(1)}°\n` +
    `${b.name} / ${toMeters(w.elev[i]).toLocaleString()}m / ${w.tempAt(i).toFixed(1)}℃`;
}

function hideInspector() { $('#inspector').classList.add('hidden'); }

function inspect(p) {
  const w = state.world;
  if (!w || !p || p.y < 0 || p.y >= w.h) return;
  const x = Math.floor(p.x), y = Math.floor(p.y);
  const i = w.idx(x, y);
  const biomeId = w.biomeAt(i);
  const biome = BIOMES[biomeId];
  const { lat, lon } = latLon(w, x, y);
  const hi = (y >> 1) * w.hw + (x >> 1);

  const near = nearest(state.regions.landmasses.concat(state.regions.seas), x, y, w);
  const mark = nearestMark(x, y, w);

  const rand = mulberry32((x * 73856093) ^ (y * 19349663) ^ 0x9e3779b9);
  let pool = faunaFor(w.era.id, biomeId);
  if (pool.length < 3) {
    const sameRealm = (FAUNA[w.era.id] || []).filter(
      (f) => f.biomes.some((b) => !!BIOMES[b].water === !!biome.water) && !pool.includes(f)
    );
    pool = pool.concat(sameRealm.map((f) => ({ ...f, w: 0.5 })));
  }
  const picks = weightedSample(pool, 4, rand);
  const flora = FLORA[w.era.id] || [];
  const floraPicks = weightedSample(flora.map((f) => ({ name: f, w: 1 })), biome.water ? 0 : 3, rand);

  const el = $('#inspector');
  el.classList.remove('hidden');
  el.innerHTML = `
    <button class="close" title="閉じる">×</button>
    <h3>${biome.name}</h3>
    <p class="sub">${near ? near.name + ' 付近 · ' : ''}${Math.round(w.era.ma)} 百万年前（${w.era.name}）</p>
    <dl>
      <dt>座標</dt><dd>${lat >= 0 ? '北緯' : '南緯'} ${Math.abs(lat).toFixed(2)}° / ${lon >= 0 ? '東経' : '西経'} ${Math.abs(lon).toFixed(2)}°</dd>
      <dt>${w.elev[i] > 0 ? '標高' : '水深'}</dt><dd>${Math.abs(toMeters(w.elev[i])).toLocaleString()} m</dd>
      <dt>${w.elev[i] > 0 ? '年平均気温' : '表層水温'}</dt><dd>${w.tempAt(i).toFixed(1)} ℃</dd>
      <dt>湿潤度</dt><dd>${(w.moistAt(i) * 100).toFixed(0)} %</dd>
      <dt>大陸性</dt><dd>${(w.cont[i] / 255 * 100).toFixed(0)} %</dd>
      ${w.volc[i] > 8 ? `<dt>火山活動</dt><dd>${(w.volc[i] / 255 * 100).toFixed(0)} %</dd>` : ''}
      ${w.river[hi] ? `<dt>河川次数</dt><dd>${w.river[hi]} 級</dd>` : ''}
      ${w.lake[hi] ? `<dt>水域</dt><dd>内陸湖</dd>` : ''}
      ${mark ? `<dt>最寄りの名所</dt><dd>${mark.name}</dd>` : ''}
    </dl>
    ${picks.length ? `<h4>この環境で見られる動物</h4><ul>${picks.map((f) =>
      `<li>${f.name}<em>${f.latin} · ${f.group} · 全長${f.size}m · ${f.diet}食</em></li>`).join('')}</ul>` : ''}
    ${floraPicks.length ? `<h4>植生</h4><ul>${floraPicks.map((f) => `<li>${f.name}</li>`).join('')}</ul>` : ''}
  `;
  el.querySelector('.close').onclick = hideInspector;
}

function weightedSample(pool, k, rand) {
  const items = pool.slice();
  const out = [];
  let total = items.reduce((a, b) => a + (b.w || 1), 0);
  while (out.length < k && items.length) {
    let t = rand() * total;
    let idx = 0;
    for (; idx < items.length; idx++) { t -= items[idx].w || 1; if (t <= 0) break; }
    idx = Math.min(idx, items.length - 1);
    total -= items[idx].w || 1;
    out.push(items.splice(idx, 1)[0]);
  }
  return out;
}

function nearest(list, x, y, w) {
  let best = null, bd = Infinity;
  for (const it of list) {
    let dx = Math.abs(it.x - x);
    if (dx > w.w / 2) dx = w.w - dx;
    const d = Math.hypot(dx, it.y - y);
    const score = d / Math.max(0.25, Math.sqrt(it.share || 0.01) * 6);
    if (score < bd) { bd = score; best = it; }
  }
  return best;
}

function nearestMark(x, y, w) {
  let best = null, bd = w.w * 0.06;
  for (const m of state.marks) {
    let dx = Math.abs(m.x - x);
    if (dx > w.w / 2) dx = w.w - dx;
    const d = Math.hypot(dx, m.y - y);
    if (d < bd) { bd = d; best = m; }
  }
  return best;
}

// ---------- 起動 --------------------------------------------------------

$('#seed').value = state.seed;
$('#seed').addEventListener('change', (e) => { state.seed = e.target.value.trim() || 'pangaea'; regenerate(); });
$('#reroll').onclick = () => {
  state.seed = Math.random().toString(36).slice(2, 9);
  $('#seed').value = state.seed;
  regenerate();
};
$('#generate').onclick = () => regenerate();

buildViewSwitch();
buildEraTabs();
buildTimeline();
buildSizes();
buildModes();
buildToggles();
window.addEventListener('resize', resize);
resize();
regenerate();
