/**
 * 陸塊・海域のラベリングと地名生成。
 * 大陸核の定義名を優先し、名前のない地形には音節合成で命名する。
 */

import { rngFromSeed, wrapDelta } from '../core/rng.js';
import { BIOMES, toMeters } from './biomes.js';

const SYL_A = ['アル', 'ケラ', 'ドラ', 'テリ', 'ザウ', 'ノト', 'リオ', 'メガ', 'ステ', 'プレ', 'カル', 'エオ', 'ヒプ', 'トロ', 'マイ', 'ウル', 'ヴァ', 'ギガ', 'クリ', 'サル'];
const SYL_B = ['コス', 'ミラ', 'ドン', 'テス', 'ヴィス', 'ラント', 'ネス', 'ポリス', 'ガル', 'ムート', 'セラ', 'ファン', 'ダイン', 'ロス', 'ティア', 'ヴェル'];

const LAND_SUFFIX = ['大陸', '地塊', '陸塊', '大地'];
const ISLE_SUFFIX = ['島', '諸島', '半島状陸塊'];
const SEA_SUFFIX = ['海', '内海', '海盆', '海峡'];
const RIVER_SUFFIX = ['川', '大河', '河'];
const PEAK_SUFFIX = ['山', '峰', '嶺'];

function makeName(rand, suffixes) {
  const a = SYL_A[(rand() * SYL_A.length) | 0];
  const b = SYL_B[(rand() * SYL_B.length) | 0];
  const s = suffixes[(rand() * suffixes.length) | 0];
  return a + b + s;
}

/**
 * 連結成分を取り出す。x 方向はラップする。
 * @param {(i:number)=>boolean} test  そのセルが対象かどうか
 */
function components(w, h, test, minArea) {
  const n = w * h;
  const label = new Int32Array(n).fill(-1);
  const out = [];
  const stack = new Int32Array(n);
  for (let start = 0; start < n; start++) {
    if (label[start] !== -1 || !test(start)) continue;
    const id = out.length;
    let sp = 0;
    stack[sp++] = start;
    label[start] = id;
    let area = 0, sx = 0, sy = 0, cxs = 0, cxc = 0;
    let minY = h, maxY = 0;
    while (sp > 0) {
      const i = stack[--sp];
      const x = i % w, y = (i / w) | 0;
      area++;
      sy += y;
      const ang = (x / w) * Math.PI * 2;
      cxc += Math.cos(ang); cxs += Math.sin(ang);
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      for (let k = 0; k < 4; k++) {
        const nx = k === 0 ? (x + 1) % w : k === 1 ? (x - 1 + w) % w : x;
        const ny = k === 2 ? y + 1 : k === 3 ? y - 1 : y;
        if (ny < 0 || ny >= h) continue;
        const j = ny * w + nx;
        if (label[j] === -1 && test(j)) { label[j] = id; stack[sp++] = j; }
      }
    }
    let cx = (Math.atan2(cxs / area, cxc / area) / (Math.PI * 2)) * w;
    if (cx < 0) cx += w;
    out.push({ id, area, cx, cy: sy / area, minY, maxY, seed: start });
  }
  return { label, list: out.filter((c) => c.area >= minArea) };
}

/**
 * 世界にラベルと地名を付ける。
 * @param {object} world generateWorld の戻り値
 */
export function buildRegions(world) {
  const { w, h, elev, era, biome } = world;
  const rand = rngFromSeed(world.seed + ':names');

  // 1/4 解像度でラベリング（見た目の粒度としては十分）
  const rw = w >> 2, rh = h >> 2;
  const at = (x, y) => elev[(y << 2) * w + (x << 2)];

  const landMask = new Uint8Array(rw * rh);
  for (let y = 0; y < rh; y++) for (let x = 0; x < rw; x++) landMask[y * rw + x] = at(x, y) > 0 ? 1 : 0;

  const total = rw * rh;
  const landC = components(rw, rh, (i) => landMask[i] === 1, Math.max(6, total * 0.00025));
  const seaC = components(rw, rh, (i) => landMask[i] === 0, Math.max(20, total * 0.0015));

  const scaleX = w / rw, scaleY = h / rh;

  // 大陸名は「地域アンカー（provinces）」から取る。
  // 大陸核の名前をそのまま使うと、複数の核が融合した陸塊に
  // その一部の名前（例：カザフ地塊）が付いてしまう。
  const compProvinces = new Map();
  for (const pv of era.provinces || []) {
    const px = Math.min(rw - 1, Math.max(0, Math.round(pv.x * rw)));
    const py = Math.min(rh - 1, Math.max(0, Math.round(pv.y * rh)));
    const id = landC.label[py * rw + px];
    if (id < 0) continue;
    if (!compProvinces.has(id)) compProvinces.set(id, []);
    compProvinces.get(id).push(pv);
  }

  const landmasses = landC.list
    .sort((a, b) => b.area - a.area)
    .map((c) => {
      const fx = (c.cx * scaleX) / w, fy = (c.cy * scaleY) / h;
      let name = null;

      // 1. その陸塊に載っている地域アンカー（major を優先し、重心に近いもの）
      const pvs = compProvinces.get(c.id);
      if (pvs && pvs.length) {
        let best = null, bestScore = Infinity;
        for (const pv of pvs) {
          const d = Math.hypot(wrapDelta(pv.x, fx), (pv.y - fy) * 0.5) / (pv.major ? 1.6 : 1);
          if (d < bestScore) { bestScore = d; best = pv; }
        }
        name = best.name;
      }

      // 2. なければ最も近い大陸核の名前
      if (!name) {
        let best = null, bestScore = -1;
        for (const cr of era.cratons) {
          const dx = wrapDelta(cr.x, fx) / cr.rx, dy = (cr.y - fy) / cr.ry;
          const d = Math.sqrt(dx * dx + dy * dy);
          if (d < 1.25) {
            const score = cr.h / (0.35 + d);
            if (score > bestScore) { bestScore = score; best = cr; }
          }
        }
        if (best) name = best.name;
      }

      const share = c.area / total;
      const big = share > 0.012;
      // 3. それでも決まらなければ音節合成で命名する
      if (!name) name = makeName(rand, big ? LAND_SUFFIX : ISLE_SUFFIX);

      return {
        kind: big ? 'continent' : 'island',
        name,
        x: c.cx * scaleX, y: c.cy * scaleY,
        area: c.area, share,
        comp: c,
      };
    });

  // 陸上に載っている地域アンカーは補助ラベルとして常に描く
  const landAnchors = (era.provinces || [])
    .filter((pv) => {
      const px = Math.min(rw - 1, Math.max(0, Math.round(pv.x * rw)));
      const py = Math.min(rh - 1, Math.max(0, Math.round(pv.y * rh)));
      return landC.label[py * rw + px] >= 0;
    })
    .map((pv) => ({ kind: 'province', name: pv.name, x: pv.x * w, y: pv.y * h, share: 0.02 }));

  const seas = seaC.list
    .sort((a, b) => b.area - a.area)
    .map((c) => {
      const fx = (c.cx * scaleX) / w, fy = (c.cy * scaleY) / h;
      let best = null, bestD = 1e9;
      for (const o of era.oceans) {
        const dx = wrapDelta(o.x, fx), dy = o.y - fy;
        const d = Math.sqrt(dx * dx + dy * dy);
        if (d < bestD) { bestD = d; best = o; }
      }
      return {
        kind: c.area / total > 0.05 ? 'ocean' : 'sea',
        name: best && bestD < 0.30 ? best.name : makeName(rand, SEA_SUFFIX),
        x: c.cx * scaleX, y: c.cy * scaleY,
        area: c.area, share: c.area / total,
      };
    });

  // 定義済みの海域アンカーは常にラベルとして出す
  const anchored = era.oceans.map((o) => ({
    kind: 'oceanAnchor', name: o.name, x: o.x * w, y: o.y * h, share: 0.02,
  }));

  return { landmasses, seas, anchored, landAnchors, labelGrid: { rw, rh, land: landC.label } };
}

/**
 * 名所（最高峰・火山・大河・内海・化石産地）を配置する。
 */
export function buildLandmarks(world, regions) {
  const { w, h, hw, hh, elev, era, river, flow, biome, volc } = world;
  const rand = rngFromSeed(world.seed + ':landmarks');
  const marks = [];

  // --- 最高峰：大陸ごとに最も高い地点 ---
  for (const lm of regions.landmasses.filter((l) => l.kind === 'continent').slice(0, 8)) {
    const rx = Math.round(lm.x), ry = Math.round(lm.y);
    const span = Math.round(Math.sqrt(lm.area) * (w / (w >> 2)) * 1.2);
    let bi = -1, bh = 0;
    for (let y = Math.max(0, ry - span); y < Math.min(h, ry + span); y += 2) {
      for (let dx = -span; dx < span; dx += 2) {
        const i = world.idx(rx + dx, y);
        if (elev[i] > bh) { bh = elev[i]; bi = i; }
      }
    }
    if (bi >= 0 && bh > 0.45) {
      marks.push({
        type: 'peak', icon: '▲',
        name: makeName(rand, PEAK_SUFFIX),
        x: bi % w, y: (bi / w) | 0,
        detail: `標高 ${toMeters(bh).toLocaleString()} m・${lm.name}`,
      });
    }
  }

  // --- 火山区 ---
  for (const v of era.volcanoes) {
    let bi = -1, bh = -2;
    const cx = Math.round(v.x * w), cy = Math.round(v.y * h), r = Math.round(v.r * w * 0.8);
    for (let y = Math.max(0, cy - r); y < Math.min(h, cy + r); y += 2) {
      for (let dx = -r; dx < r; dx += 2) {
        const i = world.idx(cx + dx, y);
        const score = elev[i] + volc[i] / 255;
        if (score > bh) { bh = score; bi = i; }
      }
    }
    if (bi >= 0) {
      marks.push({
        type: 'volcano', icon: '▲', name: v.name,
        x: bi % w, y: (bi / w) | 0,
        detail: '大規模火成岩石区。玄武岩台地と溶岩流の源',
      });
    }
  }

  // --- 大河：河口の流量上位を間隔をあけて拾う ---
  const mouths = [];
  for (let y = 1; y < hh - 1; y++) {
    for (let x = 0; x < hw; x++) {
      const i = y * hw + x;
      if (river[i] < 3) continue;
      const d = world.down[i];
      const isMouth = d < 0 || world.elev[((y * 2) | 0) * w + ((x * 2) | 0)] <= 0;
      // 下流が海（半解像度標高<=0）なら河口
      const dx = [1, -1, 0, 0];
      const dy = [0, 0, 1, -1];
      let coastal = false;
      for (let k = 0; k < 4; k++) {
        const nx = (x + dx[k] + hw) % hw, ny = y + dy[k];
        const ei = (ny * 2) * w + nx * 2;
        if (elev[ei] <= 0) coastal = true;
      }
      if (coastal || isMouth) mouths.push({ i, x, y, f: flow[i] });
    }
  }
  mouths.sort((a, b) => b.f - a.f);
  const placed = [];
  for (const m of mouths) {
    if (placed.length >= 14) break;
    if (placed.some((p) => Math.hypot(wrapDelta(m.x / hw, p.x / hw) * hw, m.y - p.y) < hw * 0.06)) continue;
    placed.push(m);
    marks.push({
      type: 'river', icon: '≈', name: makeName(rand, RIVER_SUFFIX),
      x: m.x * 2, y: m.y * 2,
      detail: `流域からの水を集める河口。相対流量 ${Math.round(m.f)}`,
    });
  }

  // --- 化石産地：堆積環境に置く ---
  const fossilBiomes = new Set(['delta', 'swamp', 'redDesert', 'desert', 'lagoon', 'epeiric', 'beach']);
  const BIOME_KEYS = Object.keys(BIOMES);
  let tries = 0;
  let fossils = 0;
  while (fossils < 12 && tries < 20000) {
    tries++;
    const x = (rand() * w) | 0, y = ((0.08 + rand() * 0.84) * h) | 0;
    const i = y * w + x;
    if (!fossilBiomes.has(BIOME_KEYS[biome[i]])) continue;
    if (marks.some((p) => Math.hypot(wrapDelta(x / w, p.x / w) * w, y - p.y) < w * 0.055)) continue;
    marks.push({
      type: 'fossil', icon: '✦', name: makeName(rand, ['層', '累層', '化石床']),
      x, y,
      detail: '骨層が密集する産地。保存状態のよい標本が出る',
    });
    fossils++;
  }

  return marks;
}
