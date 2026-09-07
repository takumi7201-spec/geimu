/** アプリ本体：UI と生成器・2D 描画・3D 地球儀の接続 */

import { ERAS, getEra } from './world/eras.js';
import { eraAtAge, timelineMarks, AGE_MIN, AGE_MAX } from './world/timeline.js';
import { generateWorld, SIZES } from './world/worldgen.js';
import { buildRegions, buildLandmarks } from './world/regions.js';
import { BIOMES, BIOME_IDS, toMeters } from './world/biomes.js';
import { FAUNA, FLORA, faunaFor } from './world/fauna.js';
import { MapRenderer, VIEW_MODES } from './render/renderer.js';
import { GlobeRenderer } from './render/globe.js';
import { VoxelRenderer } from './render/voxelview.js';
import { buildVoxelScene, pickScenicSpot, SCENE_SIZES, WATER_NONE } from './voxel/scene.js';
import { BLOCKS, VOX_M } from './voxel/blocks.js';
import { SPRITE_GROUPS, SPRITE_FALLBACK } from './voxel/models.js';
import { sprite, setSprite, isOverridden, clearSprites } from './voxel/sprites.js';
import { trimSprite, checkSprite } from './voxel/spriteutil.js';
import { Explorer } from './game/player.js';
import { findSpawn, sampleColumn, faunaNear, nearestFauna } from './game/api.js';
import { stepFauna, initFauna } from './game/fauna.js';
import { mulberry32, clamp } from './core/rng.js';

const $ = (s) => document.querySelector(s);
const canvas = $('#map');
const globeCanvas = $('#globe');
const globeOverlay = $('#globe-overlay');
const voxCanvas = $('#vox');
const voxOverlay = $('#vox-overlay');

const renderer = new MapRenderer(canvas);
let globe = null;
let vox = null;

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
  // 地表ビュー（ボクセル）
  voxScene: null,
  voxSpot: null,
  voxSize: 'medium',
  voxDirty: true,
  explore: false,     // 一人称の探索モード
  explorer: null,
  watch: null,        // 目で追っている個体（scene.fauna の実体を掴む）
};

/** 現在の年代が属する紀（キーフレームちょうどでなくても近いほうを返す） */
const currentEra = () => eraAtAge(state.ma);

// ---------- 端末に憶えさせる操作の好み --------------------------------

/** 指で操作する端末か。タッチ用の操作盤はここでだけ出す */
const IS_TOUCH = matchMedia('(pointer: coarse)').matches || navigator.maxTouchPoints > 0;

const PREF = {
  // 上下反転が既定。指で世界を掴んで動かす向きに揃える
  get invertY() { try { return localStorage.getItem('mz.invertY') !== '0'; } catch { return true; } },
  set invertY(v) { try { localStorage.setItem('mz.invertY', v ? '1' : '0'); } catch { /* 保存できなくても操作は効く */ } },
  // 指でなぞる量に対する首の振れ。指の大きさも画面の広さも人によるので変えられる
  get lookSpeed() {
    try { return (Number(localStorage.getItem('mz.lookSpeed')) || 180) / 100; } catch { return 1.8; }
  },
  set lookSpeed(v) { try { localStorage.setItem('mz.lookSpeed', String(Math.round(v * 100))); } catch { /* 同上 */ } },
};

/** 視点の設定を、いま生きている描画側すべてに配る */
function applyLookPref() {
  const v = PREF.invertY;
  if (vox) vox.invertY = v;
  if (globe) globe.invertY = v;
  if (state.explorer) state.explorer.invertY = v;
}

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
  const isVox = view === 'pixel';
  if (!isVox && state.explore) setExplore(false);
  canvas.classList.toggle('hidden', view !== '2d');
  globeCanvas.classList.toggle('hidden', !is3d);
  globeOverlay.classList.toggle('hidden', !is3d);
  voxCanvas.classList.toggle('hidden', !isVox);
  voxOverlay.classList.toggle('hidden', !isVox);
  $('#vox-panel').classList.toggle('hidden', !isVox);
  $('#minimap-wrap').style.display = view === '2d' ? '' : 'none';
  if (is3d && !globe) initGlobe();
  if (isVox && !vox) initVox();
  hideInspector();
  buildToggles();
  buildStats();
  resize();
  if (isVox) startVoxLoop();
  if (isVox && vox && vox.ok && (state.voxDirty || !state.voxScene)) descend(state.voxSpot);
  else draw();
}

function initGlobe() {
  globe = new GlobeRenderer(globeCanvas, globeOverlay);
  applyLookPref();
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

function initVox() {
  vox = new VoxelRenderer(voxCanvas, voxOverlay);
  applyLookPref();
  if (!vox.ok) {
    const box = document.createElement('div');
    box.id = 'gl-error';
    box.textContent = `地表ビューを開始できませんでした：${vox.error || 'WebGL 非対応'}`;
    $('#stage').appendChild(box);
    return;
  }
  vox.layers.labels = renderer.layers.labels;
  vox.pixelSize = Number($('#vox-pixel').value) || 3;
}

/**
 * 世界の一区画に降りてボクセル地形を組む。
 * spot を省くと、河口や海岸など見応えのある場所を自動で選ぶ。
 */
async function descend(spot = null, variant = '') {
  if (!state.world || !vox || !vox.ok || state.busy) return;
  state.busy = true;
  const prog = $('#progress');
  prog.classList.remove('hidden');
  const bar = prog.querySelector('i');
  const label = prog.querySelector('span');
  try {
    const target = spot || pickScenicSpot(state.world, state.marks, variant);
    const scene = await buildVoxelScene(
      state.world,
      { x: target.x, y: target.y, size: state.voxSize, from: target.from, variant },
      (p, msg) => { bar.style.width = `${(p * 100).toFixed(1)}%`; label.textContent = msg; },
    );
    label.textContent = 'ブロックを積んでいます';
    await new Promise((r) => requestAnimationFrame(() => r()));
    state.voxScene = scene;
    initFauna(scene);      // 群れを動かせる形に整える
    setWatch(null);        // 前の区画の個体を掴んだままにしない
    state.voxSpot = target;
    state.voxDirty = false;
    vox.setScene(scene);
    if (state.explore) {
      // 別の区画に降りたら、その場に立ち直す
      vox.setFirstPerson(true);
      state.explorer = new Explorer(scene, findSpawn(scene), { yaw: vox.cam.yaw, pitch: -0.1 });
    }
    buildVoxPlace();
    buildStats();
    draw();
  } catch (err) {
    label.textContent = `地表の生成に失敗しました: ${err.message}`;
    console.error(err);
    await new Promise((r) => setTimeout(r, 2500));
  } finally {
    prog.classList.add('hidden');
    state.busy = false;
  }
}

/**
 * 探索モード。区画のなかを一人称で歩く。
 * 操作は `game/player.js`（DOM 非依存）に閉じてあるので、
 * ゲームに持っていくときはこのアプリ側の配線だけを書き換えればよい。
 */
// ---------- 生き物を目で追う ----------------------------------------------
// 6m の獣脚類は、区画を一望する縮尺だと数画素にしかならない。
// 一人称では視線を、俯瞰ではカメラごと寄せて、姿が見える大きさにする。

function setWatch(f) {
  state.watch = f || null;
  document.querySelector('#tbtns button[data-act="watch"]')?.classList.toggle('on', !!state.watch);
  updateVoxHud();
  draw();
}

function toggleWatch() {
  if (state.view !== 'pixel' || !vox || !vox.ok || !state.voxScene) return;
  if (state.watch) { setWatch(null); return; }
  const from = state.explorer ? state.explorer.status() : vox.cam;
  setWatch(nearestFauna(state.voxScene, from.x, from.z, 260));
}

function setExplore(on) {
  if (!vox || !vox.ok || !state.voxScene) return;
  state.explore = on;
  if (on) {
    const spawn = findSpawn(state.voxScene);
    // 降りた向きが崖や幹だと、何も居ない壁を見て始めることになる。
    // いちばん近い生き物のほうを向いておく（yaw は前進が (-sin, -cos) の系）
    const near = faunaNear(state.voxScene, spawn.x, spawn.z, 140)[0];
    const yaw = near
      ? Math.atan2(-(near.x - spawn.x), -(near.z - spawn.z))
      : vox.cam.yaw;
    state.explorer = new Explorer(state.voxScene, spawn, { yaw, pitch: -0.1, invertY: PREF.invertY });
    vox.setFirstPerson(true);
    voxCanvas.classList.add('explore');
    hideInspector();
    // ポインタロックが取れればマウスで視線を回せる。取れない環境では
    // ドラッグでも回せるようにしてあるので、失敗しても探索自体は続く
    voxCanvas.requestPointerLock?.();
  } else {
    state.explorer = null;
    vox.setFirstPerson(false);
    voxCanvas.classList.remove('explore');
    if (document.pointerLockElement === voxCanvas) document.exitPointerLock?.();
  }
  $('#vox-explore').textContent = on ? '探索モードを抜ける（E）' : '探索モードに入る（E）';
  $('#vox-hud').classList.toggle('hidden', !on);
  // 操作盤は指の端末だけ。マウスでは邪魔にしかならない
  $('#touch').classList.toggle('hidden', !(on && IS_TOUCH));
  if (!on) resetStick();
  // 狭い画面では設定が場所を食う。探索に入る間は畳んで全画面にする
  if (on && matchMedia('(max-width: 860px)').matches) {
    $('#sidebar').classList.add('collapsed');
    $('#panel-toggle').textContent = '設定';
    requestAnimationFrame(() => { resize(); draw(); });
  }
  updateVoxHud();
  draw();
}

function updateVoxHud() {
  const hud = $('#vox-hud');
  if (!state.explore || !state.explorer) { hud.textContent = ''; return; }
  const st = state.explorer.status();
  const s = state.voxScene;
  if (!st) return;
  const col = sampleColumn(s, st.x, st.z);
  const near = faunaNear(s, st.x, st.z, 70)[0];
  const mode = st.flying ? '飛行' : st.submerged ? '潜水' : st.inWater ? '遊泳' : st.onGround ? '徒歩' : '落下';
  hud.innerHTML =
    `<b>${col.biomeName}</b>　${col.blockName}　${Math.round(col.elevM).toLocaleString()}m　${col.tempC.toFixed(1)}℃\n` +
    `${mode}　${(st.speed * VOX_M).toFixed(0)} m/s　目線 ${Math.round(st.eyeM).toLocaleString()}m\n` +
    (state.watch
      ? `<b>${state.watch.name}</b> を目で追っています（${Math.round(Math.hypot(state.watch.x - st.x, state.watch.z - st.z) * VOX_M)}m）\n`
      : near ? `近くに <b>${near.name}</b>（${Math.round(near.dist * VOX_M)}m）\n` : '') +
    // 指の端末には操作盤が出ているので、キーの案内は場所の無駄にしかならない
    (IS_TOUCH ? '' : `<i>WASD 移動 / Space 跳ぶ / Shift 走る / V 飛行 / E 抜ける</i>`);
}

function buildVoxPlace() {
  const box = $('#vox-place');
  const s = state.voxScene;
  if (!s) { box.innerHTML = '<b>—</b>まだ降りていません'; return; }
  const m = s.meta;
  const ns = m.lat >= 0 ? '北緯' : '南緯';
  const ew = m.lon >= 0 ? '東経' : '西経';
  const top = m.biomes.map((b) => `${BIOMES[b.id].name} ${(b.share * 100).toFixed(0)}%`).join(' / ');
  box.innerHTML =
    `<b>${m.from ? m.from + ' 周辺' : `${ns}${Math.abs(m.lat).toFixed(1)}° ${ew}${Math.abs(m.lon).toFixed(1)}°`}</b>` +
    `${Math.round(s.era.ma)} 百万年前・${s.era.name}<br>` +
    `<i>${top}</i><br>` +
    `${(m.spanM / 1000).toFixed(1)} km 四方 / 1 ブロック ${VOX_M} m`;
}

function buildVoxControls() {
  const sel = $('#vox-size');
  sel.innerHTML = '';
  for (const [k, v] of Object.entries(SCENE_SIZES)) {
    const o = document.createElement('option');
    o.value = k; o.textContent = v.label;
    if (k === state.voxSize) o.selected = true;
    sel.appendChild(o);
  }
  sel.onchange = () => { state.voxSize = sel.value; descend(state.voxSpot); };
  $('#vox-pixel').onchange = (e) => {
    if (vox) vox.pixelSize = Number(e.target.value) || 3;
    resize();
    draw();
  };
  $('#vox-reroll').onclick = () => descend(null, String(Math.random()).slice(2, 7));
  $('#vox-explore').onclick = () => setExplore(!state.explore);
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
const LAYER_VOX = { water: '水面', plants: '植生', fauna: '動物', labels: '名前', fog: '霞' };

/** 視点の反転。レイヤではないが、操作を変えたい人が最初に探すのはここ */
function addLookToggle(box) {
  const l = document.createElement('label');
  const cb = document.createElement('input');
  cb.type = 'checkbox';
  cb.checked = PREF.invertY;
  cb.onchange = () => { PREF.invertY = cb.checked; applyLookPref(); };
  l.append(cb, document.createTextNode('視点の上下を反転'));
  box.appendChild(l);
}

function buildToggles() {
  const box = $('#toggles');
  box.innerHTML = '';
  if (state.view === 'pixel') {
    for (const [k, label] of Object.entries(LAYER_VOX)) {
      const l = document.createElement('label');
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = vox ? vox.layers[k] : true;
      cb.onchange = () => { if (vox && vox.ok) vox.setLayer(k, cb.checked); draw(); };
      l.append(cb, document.createTextNode(label));
      box.appendChild(l);
    }
    addLookToggle(box);
    return;
  }
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
  if (state.view === '3d') addLookToggle(box);
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
  if (state.view === 'pixel' && state.voxScene) {
    const s = state.voxScene;
    const m = s.meta;
    let lo = 1e9, hi = -1e9, wet = 0;
    for (let i = 0; i < s.height.length; i++) {
      if (s.height[i] < lo) lo = s.height[i];
      if (s.height[i] > hi) hi = s.height[i];
      if (s.water[i] !== WATER_NONE) wet++;
    }
    const rows = [
      ['年代', `${Math.round(s.era.ma)} 百万年前`],
      ['区画', `${(m.spanM / 1000).toFixed(1)} km 四方`],
      ['ブロック', `${VOX_M} m 角 / ${s.total.toLocaleString()}²`],
      ['標高差', `${((hi - lo) * VOX_M).toLocaleString()} m`],
      ['最高地点', `${(hi * VOX_M).toLocaleString()} m`],
      ['水面', `${((wet / s.height.length) * 100).toFixed(0)} %`],
      ['植物', `${m.propCount.toLocaleString()} 株`],
      ['動物', `${m.faunaCount} 頭`],
      ['ポリゴン', vox && vox.stats ? `${Math.round(vox.stats.quads / 1000)} k 面` : '—'],
    ];
    box.innerHTML = rows.map(([k, v]) => `<div><span>${k}</span><b>${v}</b></div>`).join('');
    return;
  }
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
    state.voxDirty = true;
    state.voxSpot = null;
    buildEraTabs();
    buildLegend();
    buildStats();
    hideInspector();
    if (state.view === 'pixel' && vox && vox.ok) {
      prog.classList.add('hidden');
      state.busy = false;
      await descend(null);
    }
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
  for (const c of [canvas, globeCanvas, globeOverlay, voxOverlay]) {
    c.width = Math.max(320, Math.round(r.width * dpr));
    c.height = Math.max(240, Math.round(r.height * dpr));
    c.style.width = `${r.width}px`;
    c.style.height = `${r.height}px`;
  }
  // 地表ビューだけは内部解像度を落として描く（CSS 側で nearest 拡大される）
  const px = vox ? vox.pixelSize : 3;
  voxCanvas.width = Math.max(160, Math.round((r.width * dpr) / px));
  voxCanvas.height = Math.max(120, Math.round((r.height * dpr) / px));
  voxCanvas.style.width = `${r.width}px`;
  voxCanvas.style.height = `${r.height}px`;
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
    } else if (state.view === 'pixel') {
      if (vox && vox.ok) vox.render(16);
    } else {
      renderer.render();
      drawMinimap();
    }
  });
}

// 地表ビューは水面が揺れるので、表示中だけ回し続ける。
// 30fps に間引いて、ドット絵の見た目を保ちつつ負荷を抑える。
// 他の表示に切り替えたらループは自分で止まる（rAF を回し続けない）
let voxLast = 0;
let voxRunning = false;
let hudTick = 0;
function voxLoop(t) {
  if (state.view !== 'pixel') { voxRunning = false; return; }
  requestAnimationFrame(voxLoop);
  if (!vox || !vox.ok || !state.voxScene) return;
  const dt = voxLast ? (t - voxLast) / 1000 : 1 / 60;
  // 動物は俯瞰でも動き続ける。見ている間だけなので、止まっていても困らない
  const who = state.explorer && state.explorer.status();
  stepFauna(state.voxScene, dt, who ? { x: who.x, z: who.z } : null);
  // 追っている相手が遠ざかりすぎたら、そっと解く
  if (state.watch) {
    const from = state.explorer ? state.explorer.status() : vox.cam;
    if (!state.voxScene.fauna.includes(state.watch)
      || Math.hypot(state.watch.x - from.x, state.watch.z - from.z) > 300) setWatch(null);
  }
  if (state.explore && state.explorer) {
    // 視線を寄せてから歩かせる。逆にすると、返ってきた向きが 1 フレーム古くなる
    if (state.watch) state.explorer.aimAt(state.watch.x + 0.5, state.watch.y + 1, state.watch.z + 0.5, dt);
    // 探索中は間引かない（間引くと視点がかくつき、当たり判定も粗くなる）
    const v = state.explorer.update(dt);
    if (v) vox.setEye(v.eye[0], v.eye[1], v.eye[2], v.yaw, v.pitch);
    vox.render(t - voxLast);
    voxLast = t;
    if ((hudTick = (hudTick + 1) % 6) === 0) updateVoxHud();
    return;
  }
  if (t - voxLast < 32) return;
  if (state.watch) vox.followTarget(state.watch.x + 0.5, state.watch.y, state.watch.z + 0.5, (t - voxLast) / 1000);
  vox.render(t - voxLast);
  voxLast = t;
}
function startVoxLoop() {
  if (voxRunning) return;
  voxRunning = true;
  requestAnimationFrame(voxLoop);
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
  // 二本目の指では捕捉に失敗することがある。落とすとドラッグ状態が壊れる
  try { canvas.setPointerCapture(e.pointerId); } catch { /* 捕捉できなくても操作は続く */ }
  drag = { x: e.clientX, y: e.clientY, moved: 0 };
  canvas.classList.add('dragging');
});
canvas.addEventListener('pointermove', (e) => {
  if (!state.world) return;
  if (pinching(canvas)) { drag = null; return; }   // 二本指はズームに譲る
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
  // 二本目の指では捕捉に失敗することがある。落とすとドラッグ状態が壊れる
  try { globeCanvas.setPointerCapture(e.pointerId); } catch { /* 捕捉できなくても操作は続く */ }
  gdrag = { x: e.clientX, y: e.clientY, moved: 0 };
  globeCanvas.classList.add('dragging');
});
globeCanvas.addEventListener('pointermove', (e) => {
  if (!globe || !globe.ok) return;
  if (pinching(globeCanvas)) { gdrag = null; return; }
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

// ---------- 操作：地表ボクセル -------------------------------------------

let vdrag = null;
voxCanvas.addEventListener('pointerdown', (e) => {
  if (!vox || !vox.ok) return;
  // ポインタロック中はカーソルが無いので捕捉できない（例外になる）
  if (document.pointerLockElement !== voxCanvas) {
    try { voxCanvas.setPointerCapture(e.pointerId); } catch { /* 捕捉できなくても操作は続く */ }
  }
  vdrag = { x: e.clientX, y: e.clientY, moved: 0 };
  voxCanvas.classList.add('dragging');
});
voxCanvas.addEventListener('pointermove', (e) => {
  if (!vox || !vox.ok || !state.voxScene) return;
  if (pinching(voxCanvas)) { vdrag = null; return; }
  if (vdrag) {
    const dx = e.clientX - vdrag.x, dy = e.clientY - vdrag.y;
    vdrag.moved += Math.abs(dx) + Math.abs(dy);
    vdrag.x = e.clientX; vdrag.y = e.clientY;
    // 探索中はポインタロックが取れない環境のための「ドラッグで首を振る」
    if (state.watch) setWatch(null);        // 自分で見回したら追うのをやめる
    if (state.explore && state.explorer) state.explorer.look(dx * 2.2, dy * 2.2);
    else vox.rotate(dx, dy);
    draw();
  }
  if (!state.explore) updateVoxCoords(voxPoint(e));
});
voxCanvas.addEventListener('pointerup', (e) => {
  voxCanvas.classList.remove('dragging');
  const wasClick = vdrag && vdrag.moved < 5;
  vdrag = null;
  if (!wasClick) return;
  // 探索中のクリックはマウス操作を掴むため（調査は俯瞰のときだけ）
  if (state.explore) { voxCanvas.requestPointerLock?.(); return; }
  inspectVoxel(vox.pick(...voxPoint(e)));
});

// ポインタロック中はカーソルが動かないので、移動量だけを受け取る
document.addEventListener('mousemove', (e) => {
  if (!state.explore || !state.explorer) return;
  if (document.pointerLockElement !== voxCanvas) return;
  state.explorer.look(e.movementX || 0, e.movementY || 0);
});
document.addEventListener('pointerlockchange', () => {
  // ロックが外れたら押しっぱなしのキーを解く（外に出た瞬間に走り続けない）
  if (document.pointerLockElement !== voxCanvas && state.explorer) state.explorer.releaseAll();
});
window.addEventListener('blur', () => { if (state.explorer) state.explorer.releaseAll(); });
window.addEventListener('keyup', (e) => {
  if (state.explorer && state.explorer.key(e.code, false)) e.preventDefault();
});
voxCanvas.addEventListener('pointerleave', () => { vdrag = null; voxCanvas.classList.remove('dragging'); });
voxCanvas.addEventListener('wheel', (e) => {
  if (!vox || !vox.ok) return;
  e.preventDefault();
  vox.zoom(Math.exp(-e.deltaY * 0.0016));
  draw();
}, { passive: false });

/** 画面座標をボクセルキャンバスの内部解像度に合わせる（縮小して描いているため） */
function voxPoint(e) {
  const r = voxCanvas.getBoundingClientRect();
  return [
    ((e.clientX - r.left) / r.width) * voxCanvas.width,
    ((e.clientY - r.top) / r.height) * voxCanvas.height,
  ];
}

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
  // 探索中の移動キーはアトラスの操作より先に処理する
  if (state.explore && state.explorer && state.explorer.key(e.code, true)) {
    e.preventDefault();
    return;
  }
  const step = 60;
  switch (e.key.toLowerCase()) {
    case '1': setAge(230, true); break;
    case '2': setAge(160, true); break;
    case '3': setAge(90, true); break;
    case 'g': {
      const order = ['2d', '3d', 'pixel'];
      setView(order[(order.indexOf(state.view) + 1) % order.length]);
      break;
    }
    case 'n': if (state.view === 'pixel') descend(null, String(Math.random()).slice(2, 7)); break;
    case 'e': if (state.view === 'pixel') setExplore(!state.explore); break;
    case 'f': if (state.view === 'pixel') toggleWatch(); break;
    case 'w': case 'a': case 's': case 'd':
      // 俯瞰のときは注視点を平行移動する（探索中は上で処理済み）
      if (state.view !== 'pixel' || !vox || !vox.ok) return;
      vox.move(e.key.toLowerCase() === 'w' ? 1 : e.key.toLowerCase() === 's' ? -1 : 0,
               e.key.toLowerCase() === 'd' ? 1 : e.key.toLowerCase() === 'a' ? -1 : 0);
      draw();
      break;
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
      else if (state.view === 'pixel') { if (vox && vox.ok) vox.resetCamera(); }
      else renderer.fit(renderer.cam.zoom <= (renderer.minZoom / 0.85) * 1.01);
      draw();
      break;
    case 'arrowleft':
      if (state.view === 'pixel') vox.rotate(-step, 0);
      else if (state.view === '3d') globe.rotate(-step, 0); else renderer.pan(step, 0);
      draw(); break;
    case 'arrowright':
      if (state.view === 'pixel') vox.rotate(step, 0);
      else if (state.view === '3d') globe.rotate(step, 0); else renderer.pan(-step, 0);
      draw(); break;
    case 'arrowup':
      if (state.view === 'pixel') vox.move(1, 0);
      else if (state.view === '3d') globe.rotate(0, -step); else renderer.pan(0, step);
      draw(); break;
    case 'arrowdown':
      if (state.view === 'pixel') vox.move(-1, 0);
      else if (state.view === '3d') globe.rotate(0, step); else renderer.pan(0, -step);
      draw(); break;
    case '+': case '=':
      if (state.view === 'pixel') vox.zoom(1.2);
      else if (state.view === '3d') globe.zoom(1.2);
      else renderer.zoomAt(canvas.width / 2, canvas.height / 2, 1.25);
      draw(); break;
    case '-':
      if (state.view === 'pixel') vox.zoom(1 / 1.2);
      else if (state.view === '3d') globe.zoom(1 / 1.2);
      else renderer.zoomAt(canvas.width / 2, canvas.height / 2, 0.8);
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
    <button class="mini wide descend">この地点の地表へ降りる</button>
  `;
  el.querySelector('.close').onclick = hideInspector;
  el.querySelector('.descend').onclick = () => {
    const spot = { x, y, from: near ? near.name : null };
    setView('pixel');
    descend(spot);
  };
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

// ---------- 地点の調査：地表ボクセル -------------------------------------

/** 区画内の 1 列の情報。標高は「その柱の頂点」を実寸に戻して示す */
function voxColumn(hit) {
  const s = state.voxScene;
  if (!s || !hit) return null;
  const i = hit.i;
  const hb = s.height[i];
  const wl = s.water[i];
  const biomeId = s.biomeKeys[s.biomeAt[i]];
  return {
    i, hb, wl, biomeId,
    biome: BIOMES[biomeId],
    block: BLOCKS[s.surf[i]],
    elevM: hb * VOX_M,
    depthM: wl !== WATER_NONE && wl > hb ? (wl - hb) * VOX_M : 0,
    // 気温は区画の基準値から高度分だけ下げる（6.2℃/km）
    tempC: s.meta.tempC - Math.max(0, hb * VOX_M - s.meta.baseElevM) * 0.0062,
  };
}

function updateVoxCoords(p) {
  const coords = $('#coords');
  const hit = vox && vox.ok ? vox.pick(p[0], p[1]) : null;
  const c = voxColumn(hit);
  if (!c) { coords.textContent = ''; return; }
  coords.textContent =
    `${c.block.name} / ${c.biome.name}\n` +
    `標高 ${c.elevM.toLocaleString()}m${c.depthM ? ` / 水深 ${c.depthM}m` : ''} / ${c.tempC.toFixed(1)}℃`;
}

function inspectVoxel(hit) {
  const s = state.voxScene;
  const c = voxColumn(hit);
  if (!c) { hideInspector(); return; }
  // その柱にいちばん近い動物（見えている個体の説明を出す）
  let near = null, nd = 40;
  for (const f of s.fauna) {
    const d = Math.hypot(f.x - hit.x, f.z - hit.z);
    if (d < nd) { nd = d; near = f; }
  }
  const rand = mulberry32((hit.x * 73856093) ^ (hit.z * 19349663) ^ 0x9e3779b9);
  const pool = faunaFor(s.era.id, c.biomeId);
  const picks = weightedSample(pool, 3, rand);
  const flora = weightedSample((FLORA[s.era.id] || []).map((f) => ({ name: f, w: 1 })), c.biome.water ? 0 : 3, rand);

  const el = $('#inspector');
  el.classList.remove('hidden');
  el.innerHTML = `
    <button class="close" title="閉じる">×</button>
    <h3>${c.biome.name}</h3>
    <p class="sub">${s.meta.from ? s.meta.from + ' 周辺 · ' : ''}${Math.round(s.era.ma)} 百万年前（${s.era.name}）</p>
    <dl>
      <dt>地表</dt><dd>${c.block.name}</dd>
      <dt>標高</dt><dd>${c.elevM.toLocaleString()} m</dd>
      ${c.depthM ? `<dt>水深</dt><dd>${c.depthM.toLocaleString()} m</dd>` : ''}
      <dt>気温</dt><dd>${c.tempC.toFixed(1)} ℃</dd>
      <dt>区画内の位置</dt><dd>${(hit.x * VOX_M / 1000).toFixed(2)} / ${(hit.z * VOX_M / 1000).toFixed(2)} km</dd>
      ${near ? `<dt>目の前の個体</dt><dd>${near.name}</dd>` : ''}
    </dl>
    ${near ? `<h4>この個体</h4><ul><li>${near.name}<em>${near.latin} · ${near.group} · 全長${near.size}m</em></li></ul>` : ''}
    ${picks.length ? `<h4>この環境で見られる動物</h4><ul>${picks.map((f) =>
      `<li>${f.name}<em>${f.latin} · ${f.group} · 全長${f.size}m · ${f.diet}食</em></li>`).join('')}</ul>` : ''}
    ${flora.length ? `<h4>植生</h4><ul>${flora.map((f) => `<li>${f.name}</li>`).join('')}</ul>` : ''}
  `;
  el.querySelector('.close').onclick = hideInspector;
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

// インストールして「アプリとして」開けるようにする。
// file:// では Service Worker が使えないので、http(s) のときだけ登録する
if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch((err) => console.warn('SW 登録に失敗:', err.message));
  });
}

buildViewSwitch();
buildVoxControls();
buildVoxPlace();
buildEraTabs();
buildTimeline();
buildSizes();
buildModes();
buildToggles();
window.addEventListener('resize', resize);
resize();
regenerate();

// ---------- 指で遊ぶための操作盤 ---------------------------------------
// スティックとボタンはキー入力と同じ道（Explorer.key）に流す。
// 別経路にすると、押しっぱなしの解除や飛行の切り替えを二重に持つことになる。

const STICK_KEYS = { up: 'KeyW', down: 'KeyS', left: 'KeyA', right: 'KeyD' };
let stickOn = new Set();
let stickId = null;

function resetStick() {
  const pad = document.getElementById('stick');
  if (pad) { pad.classList.remove('on'); pad.querySelector('i').style.transform = ''; }
  document.getElementById('touch')?.classList.remove('holding');
  for (const code of stickOn) state.explorer?.key(code, false);
  stickOn = new Set();
  stickId = null;
}

/** いま倒れている向きだけを押し、離れた向きは戻す */
function stickSet(next) {
  for (const c of stickOn) if (!next.has(c)) state.explorer?.key(c, false);
  for (const c of next) if (!stickOn.has(c)) state.explorer?.key(c, true);
  stickOn = next;
}

// 左下の広い範囲。触れた所にスティックが出る。定位置だと、少しずれた指では
// 歩き出せず、そのたびに画面を見て置き直すことになる
{
  const zone = $('#tmove');
  const wrap = $('#touch');
  const pad = $('#stick');
  const knob = pad.querySelector('i');
  const R = 42;       // つまみが動ける半径
  const DEAD = 13;    // ここまでは止まったまま（指を置いただけで歩き出さない）

  const at = (e) => {
    const r = wrap.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  let origin = null;

  zone.addEventListener('pointerdown', (e) => {
    if (stickId !== null) return;
    stickId = e.pointerId;
    try { zone.setPointerCapture(e.pointerId); } catch { /* 捕捉できなくても操作は続く */ }
    origin = at(e);
    pad.style.left = `${origin.x}px`;
    pad.style.top = `${origin.y}px`;
    pad.classList.add('on');
    wrap.classList.add('holding');
    knob.style.transform = '';
    e.preventDefault();
  });

  zone.addEventListener('pointermove', (e) => {
    if (e.pointerId !== stickId || !origin) return;
    const p = at(e);
    const dx = p.x - origin.x, dy = p.y - origin.y;
    const len = Math.hypot(dx, dy) || 1;
    const k = Math.min(1, R / len);
    knob.style.transform = `translate(${dx * k}px, ${dy * k}px)`;
    const next = new Set();
    if (len > DEAD) {
      // 斜めも出せるよう、軸ごとに独立して見る
      if (dy < -DEAD * 0.6) next.add(STICK_KEYS.up);
      if (dy > DEAD * 0.6) next.add(STICK_KEYS.down);
      if (dx < -DEAD * 0.6) next.add(STICK_KEYS.left);
      if (dx > DEAD * 0.6) next.add(STICK_KEYS.right);
    }
    stickSet(next);
    e.preventDefault();
  });

  const end = (e) => { if (e.pointerId === stickId) resetStick(); };
  zone.addEventListener('pointerup', end);
  zone.addEventListener('pointercancel', end);
  zone.addEventListener('lostpointercapture', end);
}

// 右半分は視線。移動と別の面に分けておかないと、歩きながら振り向けない
{
  const zone = $('#tlook');
  let lookId = null, lx = 0, ly = 0;
  zone.addEventListener('pointerdown', (e) => {
    if (lookId !== null) return;
    lookId = e.pointerId;
    lx = e.clientX; ly = e.clientY;
    try { zone.setPointerCapture(e.pointerId); } catch { /* 捕捉できなくても操作は続く */ }
    e.preventDefault();
  });
  zone.addEventListener('pointermove', (e) => {
    if (e.pointerId !== lookId || !state.explorer) return;
    if (state.watch) setWatch(null);
    const k = PREF.lookSpeed;
    state.explorer.look((e.clientX - lx) * k, (e.clientY - ly) * k);
    lx = e.clientX; ly = e.clientY;
    draw();
    e.preventDefault();
  });
  const end = (e) => { if (e.pointerId === lookId) lookId = null; };
  zone.addEventListener('pointerup', end);
  zone.addEventListener('pointercancel', end);
  zone.addEventListener('lostpointercapture', end);
}

{
  const ACT = { jump: 'Space', run: 'ShiftLeft' };
  for (const b of document.querySelectorAll('#tbtns button')) {
    const act = b.dataset.act;
    if (act === 'exit') {
      b.addEventListener('pointerdown', (e) => { e.preventDefault(); setExplore(false); });
      continue;
    }
    if (act === 'watch') {
      b.addEventListener('pointerdown', (e) => { e.preventDefault(); toggleWatch(); });
      continue;
    }
    if (act === 'fly') {
      // 飛行は押した瞬間に切り替わる。押しっぱなしにすると往復してしまう
      b.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        state.explorer?.key('KeyV', true);
        state.explorer?.key('KeyV', false);
        b.classList.toggle('on', !!state.explorer?.flying);
      });
      continue;
    }
    const code = ACT[act];
    b.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      try { b.setPointerCapture(e.pointerId); } catch { /* 捕捉できなくても押下は効く */ }
      b.classList.add('on');
      state.explorer?.key(code, true);
    });
    const up = () => { b.classList.remove('on'); state.explorer?.key(code, false); };
    b.addEventListener('pointerup', up);
    b.addEventListener('pointercancel', up);
    b.addEventListener('lostpointercapture', up);
  }
}

// 設定は畳んで地図を広く使う。畳んだあとは canvas の実寸が変わるので測り直す
$('#panel-toggle').addEventListener('click', () => {
  const sb = $('#sidebar');
  const hid = sb.classList.toggle('collapsed');
  $('#panel-toggle').textContent = hid ? '設定' : '閉じる';
  requestAnimationFrame(() => { resize(); draw(); });
});

// ---------- 二本指でズーム ----------------------------------------------
// スマホにはホイールが無い。指の開き具合をそのまま倍率にする。
// ドラッグ側は pinching() を見て手を引く（同時に効くと画面が跳ねる）。

const pinchState = new WeakMap();

function pinching(el) {
  const st = pinchState.get(el);
  return !!st && st.pts.size >= 2;
}

function enablePinch(el, onZoom) {
  const st = { pts: new Map(), base: 0 };
  pinchState.set(el, st);
  const span = () => {
    const [a, b] = [...st.pts.values()];
    return Math.hypot(a.x - b.x, a.y - b.y);
  };
  el.addEventListener('pointerdown', (e) => {
    st.pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (st.pts.size === 2) st.base = span();
  });
  el.addEventListener('pointermove', (e) => {
    if (!st.pts.has(e.pointerId)) return;
    st.pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (st.pts.size !== 2) return;
    const now = span();
    // 指が重なった瞬間は倍率が飛ぶので、ある程度離れているときだけ効かせる
    if (st.base > 6 && now > 6) {
      const [a, b] = [...st.pts.values()];
      onZoom(now / st.base, (a.x + b.x) / 2, (a.y + b.y) / 2);
      draw();
    }
    st.base = now;
    e.preventDefault();
  });
  const drop = (e) => {
    st.pts.delete(e.pointerId);
    st.base = st.pts.size === 2 ? span() : 0;
  };
  el.addEventListener('pointerup', drop);
  el.addEventListener('pointercancel', drop);
  el.addEventListener('pointerleave', drop);
}

enablePinch(canvas, (f, mx, my) => {
  if (!state.world) return;
  const r = canvas.getBoundingClientRect();
  const dpr = renderer.dpr || 1;
  renderer.zoomAt((mx - r.left) * dpr, (my - r.top) * dpr, f);
});
enablePinch(globeCanvas, (f) => { if (globe && globe.ok) globe.zoom(f); });
enablePinch(voxCanvas, (f) => { if (vox && vox.ok && !state.explore) vox.zoom(f); });

// ---------- 動物の絵の差し替え ------------------------------------------
// PNG を選ぶと、その場で板の絵が変わる。file:// でも読めるよう、
// 画像は data: URL 経由で canvas に描く（ファイルを直に描くと汚染されて読めない）。

const SPR_STORE = 'mz.spr.';

function b64FromBytes(u8) {
  let s = '';
  const CH = 0x8000;   // 一度に渡しすぎると引数の上限で落ちる
  for (let i = 0; i < u8.length; i += CH) s += String.fromCharCode(...u8.subarray(i, i + CH));
  return btoa(s);
}

function bytesFromB64(b64) {
  const bin = atob(b64);
  const u = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
  return u;
}

function saveSprite(key, img) {
  try {
    localStorage.setItem(SPR_STORE + key,
      JSON.stringify({ w: img.w, h: img.h, d: b64FromBytes(img.data) }));
  } catch { /* 憶えられなくても、その場では使える */ }
}

/** 起動時に、前に選んだ絵を戻す */
function loadSavedSprites() {
  for (const g of SPRITE_GROUPS) {
    try {
      const raw = localStorage.getItem(SPR_STORE + g.key);
      if (!raw) continue;
      const o = JSON.parse(raw);
      setSprite(g.key, { w: o.w, h: o.h, data: bytesFromB64(o.d) });
    } catch { /* 壊れていたら組み込みの絵で動かす */ }
  }
}

/** ファイルを RGBA に開いて、余白を刈る */
async function readSpriteFile(file) {
  const url = await new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result);
    r.onerror = () => rej(new Error('ファイルを読めません'));
    r.readAsDataURL(file);
  });
  const im = await new Promise((res, rej) => {
    const i = new Image();
    i.onload = () => res(i);
    i.onerror = () => rej(new Error('画像として開けません'));
    i.src = url;
  });
  const cv = document.createElement('canvas');
  cv.width = im.naturalWidth; cv.height = im.naturalHeight;
  const g = cv.getContext('2d', { willReadFrequently: true });
  g.imageSmoothingEnabled = false;
  g.drawImage(im, 0, 0);
  const d = g.getImageData(0, 0, cv.width, cv.height);
  return trimSprite({ w: cv.width, h: cv.height, data: d.data });
}

/** 差し替え後に絵を出し直す。地形は変わらないので板だけ作り直す */
function afterSpriteChange() {
  buildSpriteSlots();
  if (vox && vox.ok && state.voxScene) { vox.refreshSprites(); draw(); }
}

function pickSpriteFor(key) {
  const inp = document.createElement('input');
  inp.type = 'file';
  inp.accept = 'image/png,image/*';
  inp.onchange = async () => {
    const f = inp.files && inp.files[0];
    if (!f) return;
    try {
      const img = await readSpriteFile(f);
      const bad = checkSprite(img);
      if (bad) { alert(bad); return; }
      setSprite(key, img);
      saveSprite(key, img);
      afterSpriteChange();
    } catch (err) {
      alert('絵を読めませんでした：' + err.message);
    }
  };
  inp.click();
}

/** その分類がいま何で描かれているか（差し替え → 組み込み → 代用 の順） */
function shownSprite(key) {
  return sprite(key) || sprite(SPRITE_FALLBACK[key]) || null;
}

function drawSpriteThumb(cv, key) {
  const g = cv.getContext('2d');
  const dpr = Math.min(3, window.devicePixelRatio || 1);
  cv.width = 44 * dpr; cv.height = 44 * dpr;
  g.clearRect(0, 0, cv.width, cv.height);
  const sp = shownSprite(key);
  if (!sp) return;
  // ImageData は拡大して描けないので、原寸の canvas を経由する
  const tmp = document.createElement('canvas');
  tmp.width = sp.w; tmp.height = sp.h;
  const id = tmp.getContext('2d').createImageData(sp.w, sp.h);
  id.data.set(sp.data);
  tmp.getContext('2d').putImageData(id, 0, 0);
  g.imageSmoothingEnabled = false;
  const k = Math.min(cv.width / sp.w, cv.height / sp.h) * 0.86;
  const w = sp.w * k, h = sp.h * k;
  g.drawImage(tmp, (cv.width - w) / 2, (cv.height - h) / 2, w, h);
}

function buildSpriteSlots() {
  const box = $('#sprite-slots');
  if (!box) return;
  box.innerHTML = '';
  for (const g of SPRITE_GROUPS) {
    const row = document.createElement('div');
    row.className = 'sprite-slot';
    const cv = document.createElement('canvas');
    drawSpriteThumb(cv, g.key);
    const who = document.createElement('div');
    who.className = 'who';
    who.innerHTML = `<b>${g.label}</b><em>${g.note}</em>`;
    const btn = document.createElement('button');
    const mine = isOverridden(g.key);
    btn.textContent = mine ? '選び直す' : '絵を選ぶ';
    btn.className = mine ? 'set' : '';
    btn.onclick = () => pickSpriteFor(g.key);
    row.append(cv, who, btn);
    box.appendChild(row);
  }
}

$('#sprite-reset').addEventListener('click', () => {
  for (const g of SPRITE_GROUPS) {
    try { localStorage.removeItem(SPR_STORE + g.key); } catch { /* 消せなくても戻す */ }
  }
  clearSprites();
  afterSpriteChange();
});

loadSavedSprites();
buildSpriteSlots();

// 指の端末にだけ関わる設定を出す（マウスでは意味がない）
if (IS_TOUCH) document.body.classList.add('touch');
{
  const sl = $('#look-speed');
  if (sl) {
    sl.value = String(Math.round(PREF.lookSpeed * 100));
    sl.addEventListener('input', () => { PREF.lookSpeed = Number(sl.value) / 100; });
  }
}
