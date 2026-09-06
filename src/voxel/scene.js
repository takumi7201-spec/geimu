/**
 * 地表ボクセル世界の生成（DOM 非依存）。
 *
 * マップの 1 セルは約 20 km ある。地表に降りた縮尺（1 ブロック = 6 m）では
 * 1 セルの内側だけで景色が完結するので、ここでは
 *   ・マップから借りるもの … 標高・気候・大陸性・火山活動・海面
 *   ・その場で作るもの     … 起伏の細部・水系・地層・植生・動物
 * という分担にしている。マップと矛盾しない「中生代のある一区画」を作る。
 *
 * バイオームは worldgen と同じ classify() に地元の標高・気温・湿潤度を
 * 通して決め直す。こうすると尾根は高地、谷底は沼、汀は砂浜と、
 * 1 セルの中に地形なりの環境の差が出る。
 */

import { Noise, clamp, smoothstep, rngFromSeed } from '../core/rng.js';
import { classify, BIOMES } from '../world/biomes.js';
import { fillDepressions, accumulateFlow } from '../world/hydrology.js';
import { FAUNA } from '../world/fauna.js';
import { B, VOX_M, groundOf, canopyOf, strataAt, SPECKLE, UNDERGROWTH } from './blocks.js';
import { PLANT_BUILDERS, FAUNA_BUILDERS, HIDES, modelForGroup, modelSpan } from './models.js';

/** 水面なしを表す番兵 */
export const WATER_NONE = -30000;

/** 水域バイオームの集合（陸の動物を水に置かないための判定） */
const WATER_BIOMES = new Set(Object.entries(BIOMES).filter(([, b]) => b.water).map(([k]) => k));

/**
 * 区画の広さ。cols は最も細かく描く中心部の一辺（ブロック数）で、
 * 生成グリッドはその 4 倍まで広げる（遠景を粗いブロックで描くため）。
 */
export const SCENE_SIZES = {
  small:  { cols: 96,  label: '小 2.3 km 四方' },
  medium: { cols: 128, label: '中 3.1 km 四方' },
  large:  { cols: 160, label: '大 3.8 km 四方' },
  huge:   { cols: 192, label: '特大 4.6 km 四方' },
};

const nextTick = () =>
  new Promise((r) => (typeof requestAnimationFrame === 'function' ? requestAnimationFrame(() => r()) : setTimeout(r, 0)));

/**
 * 水域の環境を「実際の水深（m）」で決める。
 *
 * classify() の水中判定はマップの 20km セル向けで、深さ 0.04（＝248m）までを
 * 礁とみなす。6m ブロックの縮尺でそのまま使うと、大陸棚が丸ごと蛍光色の
 * サンゴ礁になってしまうので、ここだけは地表用のしきい値を別に持つ。
 */
function marineBiome(depthM, tempC, contV, reefPatch) {
  if (depthM < 4) return 'lagoon';
  if (reefPatch && tempC > 21 && depthM < 32) return 'reef';
  if (depthM < 12) return 'lagoon';
  if (depthM < 110) return contV > 0.45 ? 'epeiric' : 'shelf';
  if (depthM < 900) return 'ocean';
  return 'abyss';
}

/** マップ標高（-1..1）→ メートル。biomes.toMeters と同じ換算 */
const elevM = (e) => (e >= 0 ? e * 4600 : -(-e * 6200));
/** メートル → マップ標高。classify に渡すために戻す */
const mToElev = (m) => (m >= 0 ? m / 4600 : -(-m / 6200));

/** マップ配列のバイリニア補間（x はラップ） */
function sampleF(arr, w, h, fx, fy) {
  const x0 = Math.floor(fx), y0 = clamp(Math.floor(fy), 0, h - 1);
  const tx = fx - x0, ty = clamp(fy - y0, 0, 1);
  const xa = ((x0 % w) + w) % w, xb = ((x0 + 1) % w + w) % w;
  const ya = clamp(y0, 0, h - 1), yb = clamp(y0 + 1, 0, h - 1);
  const a = arr[ya * w + xa], b = arr[ya * w + xb];
  const c = arr[yb * w + xa], d = arr[yb * w + xb];
  return (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty;
}

/**
 * 見応えのある地点を選ぶ。
 * 河口・海岸・森を優先し、単調な内陸砂漠や外洋には降りない。
 */
export function pickScenicSpot(world, marks = [], seed = '') {
  const rand = rngFromSeed(`${world.seed}:vox-spot:${seed}:${Math.round(world.era.ma ?? 0)}`);
  const river = marks.filter((m) => m.type === 'river');
  if (river.length && rand() < 0.5) {
    const m = river[(rand() * river.length) | 0];
    return { x: m.x, y: m.y, from: m.name };
  }
  // 陸で、海に近く、湿った場所を何度か引いて一番良いものを採る
  let best = null, bestScore = -1;
  for (let k = 0; k < 900; k++) {
    const x = (rand() * world.w) | 0;
    const y = ((0.08 + rand() * 0.84) * world.h) | 0;
    const i = world.idx(x, y);
    if (world.elev[i] <= 0.002) continue;
    const coast = 1 - clamp(world.dist[i] / (world.w * 0.03), 0, 1);
    const score = coast * 1.2 + world.moistAt(i) + (world.elev[i] > 0.35 ? 0.5 : 0) + rand() * 0.4;
    if (score > bestScore) { bestScore = score; best = { x, y, from: null }; }
  }
  return best || { x: (world.w * 0.5) | 0, y: (world.h * 0.5) | 0, from: null };
}

/**
 * ボクセル区画を作る。
 * @param {object} world  generateWorld() の結果
 * @param {{x:number, y:number, size?:string, variant?:string}} opts  x,y はマップのセル座標
 */
export async function buildVoxelScene(world, opts, onProgress = () => {}) {
  const t0 = Date.now();
  const size = opts.size in SCENE_SIZES ? opts.size : 'medium';
  const cols = SCENE_SIZES[size].cols;
  const total = cols * 4;                    // 生成グリッド。外側は粗いブロックで描く
  const n = total * total;
  const cx = opts.x, cy = opts.y;
  const key = `${world.seed}:${Math.round(world.era.ma ?? 0)}:${Math.round(cx)}:${Math.round(cy)}:${opts.variant || ''}`;

  // マップ 1 セルの実寸。区画はこの何分の一かに収まる
  const cellM = (40075000 / world.w);

  const nHills = new Noise(`${key}:hills`);
  const nRidge = new Noise(`${key}:ridge`);
  const nWarp = new Noise(`${key}:warp`);
  const nWet = new Noise(`${key}:wet`);
  const rand = rngFromSeed(`${key}:props`);

  // 周波数は「マップ全周を 1」とした正規化座標に対する値。
  // period に同じ値を渡さないと経度 0 で場が不連続になる（worldgen と同じ約束）。
  const P_BASIN = 8192;      // 波長 4.9 km：区画をまたぐ谷と丘
  const P_HILL = 65536;      // 波長 611 m：普通の起伏
  const P_RIDGE = 32768;     // 波長 1.2 km：山の稜線
  const P_MICRO = 262144;    // 波長 153 m：岩肌のざらつき

  const height = new Int16Array(n);          // 列の頂点（ブロック）
  const surf = new Uint8Array(n);            // 地表ブロック
  const sub = new Uint8Array(n);             // 地表直下（崖の上端に出る）
  const water = new Int16Array(n).fill(WATER_NONE);
  const wetness = new Float32Array(n);       // 局所湿潤度（植生密度に使う）
  const biomeAt = new Uint8Array(n);         // GROUND を引くための添字（BIOME_KEYS）
  const biomeKeys = [];
  const biomeIndex = new Map();
  const keyOf = (id) => {
    let k = biomeIndex.get(id);
    if (k === undefined) { k = biomeKeys.length; biomeKeys.push(id); biomeIndex.set(id, k); }
    return k;
  };

  // --- 1. 標高（メートル） --------------------------------------------
  const hM = new Float32Array(n);
  const centerI = world.idx(Math.round(cx), Math.round(cy));
  const baseVolc = world.volc[centerI] / 255;
  const eraId = world.era.id;

  const CHUNK = 32;
  for (let j0 = 0; j0 < total; j0 += CHUNK) {
    const j1 = Math.min(total, j0 + CHUNK);
    for (let j = j0; j < j1; j++) {
      for (let i = 0; i < total; i++) {
        // マップ上の位置（ブロック座標 → マップのセル座標）
        const gx = cx + ((i - total / 2) * VOX_M) / cellM;
        const gy = cy + ((j - total / 2) * VOX_M) / cellM;
        const fx = ((gx / world.w) % 1 + 1) % 1;
        const fy = clamp(gy / world.h, 0, 1);

        const baseE = sampleF(world.elev, world.w, world.h, gx, gy);
        const baseM = elevM(baseE);

        // 起伏の大きさは、マップの傾斜と高度から決める。
        // 平野に山ノイズを乗せると地図と食い違うので、山では山、平野では丘に留める
        const eN = clamp(baseE, -1, 1);
        const mountain = smoothstep(0.20, 0.66, eN);
        const slope =
          Math.abs(sampleF(world.elev, world.w, world.h, gx + 1, gy) - sampleF(world.elev, world.w, world.h, gx - 1, gy)) +
          Math.abs(sampleF(world.elev, world.w, world.h, gx, gy + 1) - sampleF(world.elev, world.w, world.h, gx, gy - 1));
        const rough = clamp(slope * 5 + mountain, 0, 1.4);

        // 座標をゆがめてから丘のノイズを取る（格子に沿った縞を防ぐ）
        const wx = nWarp.fbm(fx * P_BASIN, fy * P_BASIN * 0.5, 2, 2, 0.5, P_BASIN) * 0.00004;
        const basin = nHills.fbm((fx + wx) * P_BASIN, fy * P_BASIN * 0.5, 3, 2, 0.5, P_BASIN);
        const hills = nHills.fbm((fx + wx) * P_HILL, fy * P_HILL * 0.5, 5, 2, 0.5, P_HILL);
        const micro = nWarp.fbm(fx * P_MICRO, fy * P_MICRO * 0.5, 2, 2, 0.5, P_MICRO);
        const ridge = (nRidge.ridged(fx * P_RIDGE, fy * P_RIDGE * 0.5, 5, 2, 0.5, P_RIDGE) + 1) * 0.5;

        // fbm の実効振幅は ±0.3 前後しかない。係数は「その 3 分の 1 が起伏」
        // と思って読む（平野で高低差 100m、山地で 1000m 級になる値）
        let m = baseM;
        m += basin * (260 + 900 * rough);
        m += hills * (90 + 420 * rough);
        m += micro * (8 + 18 * rough);
        // 稜線は山地だけ。平野に出すと地図の山脈と関係のない峰が生えてしまう
        m += ridge * 900 * mountain * mountain;
        // 海側は水平に均す（波打つ海底より、なだらかな汀のほうが地形が読める）
        if (baseM < 0) m = baseM + (m - baseM) * clamp(1 + baseM / 300, 0.25, 1);
        // 汀の傾斜を立てる。海面ちょうどの高さに広い平坦面が残ると、
        // 陸と 1 ブロックの水が市松模様に混ざって干潟がノイズに見える。
        // tanh は 0 で 0 なので、汀線の位置は動かさずに勾配だけを急にできる
        m += 26 * Math.tanh(m / 20);

        const i2 = j * total + i;
        hM[i2] = m;
        wetness[i2] = clamp(
          world.moistAt(world.idx(Math.round(gx), clamp(Math.round(gy), 0, world.h - 1))) +
          nWet.fbm(fx * P_HILL, fy * P_HILL * 0.5, 3, 2, 0.5, P_HILL) * 0.10, 0, 1);
      }
    }
    onProgress((j1 / total) * 0.42, '地形を刻んでいます');
    await nextTick();
  }

  // --- 2. 水系（半解像度で流して、全解像度に彫る） ----------------------
  const hw = total >> 1;
  const hh = total >> 1;
  const he = new Float32Array(hw * hh);      // ブロック単位
  const hrain = new Float32Array(hw * hh);
  for (let j = 0; j < hh; j++) {
    for (let i = 0; i < hw; i++) {
      const a = (j * 2) * total + i * 2;
      he[j * hw + i] = (hM[a] + hM[a + 1] + hM[a + total] + hM[a + total + 1]) * 0.25 / VOX_M;
      hrain[j * hw + i] = 0.3 + wetness[a] * 1.7;
    }
  }
  // 区画の外周は「海（出口）」とみなす。こうしないと水が縁で行き止まりになり、
  // 区画いっぱいに湖ができる
  for (let i = 0; i < hw; i++) {
    for (const j of [0, hh - 1]) he[j * hw + i] = -400;
    he[i * hw] = -400; he[i * hw + hw - 1] = -400;
  }
  // 平坦地では流向のタイを崩さないと河川が走査順に沿って直線化する
  for (let i = 0; i < he.length; i++) {
    if (he[i] > 0) {
      const hsh = Math.imul(i ^ 0x9e3779b9, 2654435761) >>> 8;
      he[i] += ((hsh & 1023) / 1023 - 0.5) * 0.01;
    }
  }
  const filled = fillDepressions(he, hw, hh, 0);
  const { flow } = accumulateFlow(filled, he, hw, hh, hrain, 0);
  // 窪地の扱い。フラクタル地形は閉じた盆地だらけで、そのまま水を張ると
  // 稜線のあいだが全部湖になる。浅い窪地は「堆積で埋まった平地」として地面を上げ、
  // 深い窪地だけを湖にする（LAKE_MIN ブロック以上たまる所）
  const LAKE_MIN = 6;

  // 流量の上位を河川にする
  const sorted = Array.from(flow).filter((v) => v > 0).sort((a, b) => a - b);
  const q = (p) => (sorted.length ? sorted[Math.min(sorted.length - 1, (sorted.length * p) | 0)] : Infinity);
  const levels = [q(0.985), q(0.994), q(0.9975), q(0.999)];
  const rlv = new Uint8Array(hw * hh);
  for (let i = 0; i < rlv.length; i++) {
    if (he[i] <= 0) continue;
    let lv = 0;
    for (let k = 0; k < levels.length; k++) if (flow[i] >= levels[k]) lv = k + 1;
    rlv[i] = lv;
  }
  // 大河は幅を持たせる（1 段ごとに 1 セル膨らませる）
  for (let pass = 0; pass < 2; pass++) {
    const src = rlv.slice();
    for (let j = 1; j < hh - 1; j++) {
      for (let i = 1; i < hw - 1; i++) {
        const c = src[j * hw + i];
        if (c < 2 + pass) continue;
        for (const k of [-1, 1, -hw, hw]) {
          const t = j * hw + i + k;
          if (src[t] === 0 && he[t] > 0) rlv[t] = Math.max(rlv[t], c - 1);
        }
      }
    }
  }
  // 湖：窪地を連結成分にまとめ、「水が集まる・広がりすぎない」ものだけ水を張る。
  // 深さだけで判定すると、稜線のあいだの閉じた盆地が全部湖になって山地が水没する
  const lakeMask = new Uint8Array(hw * hh);
  {
    const seen = new Uint8Array(hw * hh);
    const stack = new Int32Array(hw * hh);
    const flowLake = q(0.85);
    const maxArea = hw * hh * 0.018;
    for (let s0 = 0; s0 < hw * hh; s0++) {
      if (seen[s0] || filled[s0] - he[s0] <= 0.5) continue;
      let sp = 0, count = 0;
      stack[sp++] = s0; seen[s0] = 1;
      const cells = [];
      let maxFill = 0, maxFlow = 0, wetSum = 0;
      while (sp > 0) {
        const i = stack[--sp];
        cells.push(i); count++;
        maxFill = Math.max(maxFill, filled[i] - he[i]);
        maxFlow = Math.max(maxFlow, flow[i]);
        wetSum += wetness[((i / hw) | 0) * 2 * total + (i % hw) * 2];
        const x = i % hw, y = (i / hw) | 0;
        if (x > 0) push(i - 1); if (x < hw - 1) push(i + 1);
        if (y > 0) push(i - hw); if (y < hh - 1) push(i + hw);
        function push(j) { if (!seen[j] && filled[j] - he[j] > 0.5) { seen[j] = 1; stack[sp++] = j; } }
      }
      // 乾燥地では水がたまらない。溜まり跡は湖ではなく干上がった平地にする
      const dry = wetSum / count < 0.30;
      if (!dry && maxFill > LAKE_MIN && count < maxArea && maxFlow >= flowLake) {
        for (const i of cells) lakeMask[i] = 1;
      }
    }
  }

  onProgress(0.55, '水系を流しています');
  await nextTick();

  // --- 3. 地表ブロックの決定 -------------------------------------------
  const salt = (Math.abs(Math.round(cx * 31 + cy * 17)) % 97) | 0;
  let suiteVotes = [0, 0, 0, 0];
  let waterCells = 0, landCells = 0;
  const tempBase = world.tempAt(centerI);
  const contBase = world.cont[centerI] / 255;

  for (let j = 0; j < total; j++) {
    for (let i = 0; i < total; i++) {
      const i2 = j * total + i;
      const hi = (j >> 1) * hw + (i >> 1);
      let m = hM[i2];
      const fillAmt = filled[hi] - he[hi];          // 窪地に溜まる深さ（ブロック）
      const isLake = lakeMask[hi] === 1;
      if (!isLake && fillAmt > 0) m += fillAmt * VOX_M;

      // 河川を彫る。掘った底に 1 ブロックの水を張る
      const lv = rlv[hi];
      let wLevel = WATER_NONE;
      if (lv > 0 && m > 0) {
        m -= (1 + lv * 0.6) * VOX_M;
      }

      const hb = Math.round(m / VOX_M);
      height[i2] = hb;
      if (hb < 0) {
        wLevel = 0;                    // 海面
        waterCells++;
      } else {
        landCells++;
        // 湖は「埋めた水面より低い列」だけを浸す。マスクの全域を一律に浸すと
        // 山地の窪地がすべて湖になり、稜線のあいだが水浸しになる
        if (isLake) {
          const surfaceB = Math.round(filled[hi]);
          if (surfaceB > hb) wLevel = surfaceB;
        }
        if (lv > 0 && wLevel === WATER_NONE) wLevel = hb + 1;
      }
      water[i2] = wLevel;

      // 地元の気候でバイオームを引き直す（尾根は高地、谷は沼、汀は砂浜）
      const altM = hb * VOX_M;
      const tC = tempBase - Math.max(0, altM - elevM(world.elev[centerI])) * 0.0062;
      let wet = wetness[i2];
      if (lv >= 2) wet = Math.min(1, wet + 0.12 + lv * 0.03);
      if (isLake) wet = Math.min(1, wet + 0.18);
      if (wLevel !== WATER_NONE && hb >= 0) wet = Math.min(1, wet + 0.10);
      // 礁は 100m 角ほどの斑にする。一様に敷き詰めると海底が絨毯に見える
      const reefPatch = ((Math.imul((i >> 4) ^ Math.imul(j >> 4, 0x9e3779b1), 0x85ebca6b) >>> 24) & 7) < 3;
      const id = hb < 0
        ? marineBiome(-altM, tC, contBase, reefPatch)
        : classify(mToElev(altM), tC, wet, contBase, baseVolc, eraId);
      const bk = keyOf(id);
      biomeAt[i2] = bk;
      const g = groundOf(id);
      suiteVotes[g.suite]++;

      let top = B[g.top];
      // 礁は一色だと蛍光色の絨毯に見える。石灰岩と砂を混ぜて斑にする
      if (top === B.coralTeal || top === B.coralRed) {
        const hsh = (Math.imul(i2 ^ 0x1b873593, 0x85ebca6b) >>> 17) & 7;
        if (hsh < 3) top = B.limestone;
        else if (hsh === 3) top = B.seabed;
        else if (hsh === 4) top = B.coralRed;
      }
      // 汀と河岸は砂・泥にする。ここが草だと水際が硬く見える
      if (hb >= 0 && wLevel !== WATER_NONE && hb <= wLevel + 1 && !g.top.includes('sand')) {
        top = wet > 0.6 ? B.mud : B.sand;
      } else if (hb >= -2 && hb <= 1) {
        // 汀線の前後は砂浜にする
        top = wet > 0.75 ? B.mud : B.sand;
      }
      // 草地と林床に差し色を散らす（一面同じ色だとドット絵として平板になる）
      const hsh = (Math.imul(i2 ^ 0x27d4eb2f, 0x9e3779b1) >>> 16) & 255;
      if (top === B.fernTurf || top === B.meadow || top === B.savanna) {
        if (hsh < 12) top = SPECKLE[hsh & 3];
      } else if (top === B.fernDark) {
        if (hsh < 40) top = UNDERGROWTH[hsh & 3];
      }
      // 草木を置かない外側は、地面を樹冠の色で塗って遠景の森にする。
      // ここを地面色のままにすると、植生の境界に「森が終わる線」が出る
      const edgeDist = Math.max(Math.abs(i - total / 2), Math.abs(j - total / 2));
      if (edgeDist > cols && hb >= 0 && (wLevel === WATER_NONE || wLevel <= hb)) {
        const cv = canopyOf(id);
        const hsh = (Math.imul(i2 ^ 0x51ed270b, 0x9e3779b1) >>> 12) & 1023;
        if (cv !== null && hsh < Math.min(880, groundOf(id).veg * 7000)) top = cv;
      }
      surf[i2] = top;
      sub[i2] = B[g.sub];
      wetness[i2] = wet;
    }
    if ((j & 63) === 0) { onProgress(0.55 + (j / total) * 0.20, '地表と水際を整えています'); await nextTick(); }
  }
  // 1 ブロックだけの孤立した水たまりを均す。
  // 汀や氾濫原では水面と地面が 1 ブロック差で入り混じり、そのままだと
  // 点描のような市松模様になる（地形ではなく量子化の見た目になってしまう）
  {
    const w0 = water.slice();
    for (let j = 1; j < total - 1; j++) {
      for (let i = 1; i < total - 1; i++) {
        const i2 = j * total + i;
        const wl = w0[i2];
        if (wl === WATER_NONE) continue;
        if (wl - height[i2] > 1) continue;              // 深い水は残す
        const hi = (j >> 1) * hw + (i >> 1);
        if (rlv[hi] || lakeMask[hi]) continue;          // 河川と湖は細くても残す
        let neigh = 0;
        for (const k of [-1, 1, -total, total, -total - 1, -total + 1, total - 1, total + 1]) {
          const q = w0[i2 + k];
          if (q !== WATER_NONE && q - height[i2 + k] >= 1) neigh++;
        }
        if (neigh >= 5) continue;
        water[i2] = WATER_NONE;
        if (height[i2] < wl) height[i2] = wl;           // 水を抜いた分は砂で埋める
        surf[i2] = B.sand;
      }
    }
  }

  const suite = suiteVotes.indexOf(Math.max(...suiteVotes));

  // --- 4. 植生と動物 ---------------------------------------------------
  const models = [];
  const modelCache = new Map();
  /** 同じ種類でも数種類の姿を用意して使い回す（1 本ずつ作ると重い） */
  const modelFor = (kind, variant) => {
    const k = `${kind}:${variant}`;
    if (modelCache.has(k)) return modelCache.get(k);
    const built = PLANT_BUILDERS[kind](rngFromSeed(`${key}:${k}`));
    built.kind = kind;              // 何のモデルかを残す（検証と表示で使う）
    models.push(built);
    const idx = models.length - 1;
    modelCache.set(k, idx);
    return idx;
  };

  // 動物を選ぶ前に、この区画に何が広がっているかを数えておく
  const countsEarly = new Map();
  for (let i = 0; i < n; i += 11) {
    const id = biomeKeys[biomeAt[i]];
    countsEarly.set(id, (countsEarly.get(id) || 0) + 1);
  }
  const topBiomesEarly = [...countsEarly.entries()]
    .sort((a, b) => b[1] - a[1]).filter(([, c]) => c * 11 > n * 0.02)
    .map(([id, c]) => ({ id, share: (c * 11) / n }));

  const props = [];
  const propArea = cols * 2;                 // 細かく描く範囲の外側 1 段までは草木を置く
  const lo = (total - propArea) >> 1, hi2 = lo + propArea;
  const PROP_CAP = 9000;
  for (let j = lo; j < hi2; j++) {
    for (let i = lo; i < hi2; i++) {
      const i2 = j * total + i;
      const hb = height[i2];
      const wl = water[i2];
      const id = biomeKeys[biomeAt[i2]];
      const g = groundOf(id);
      const kinds = Object.entries(g.kinds);
      if (!kinds.length) continue;
      const underwater = wl !== WATER_NONE && wl > hb;
      // 水中は礁と藻だけ。水没した森は描かない
      const dens = underwater ? (g.veg * (id === 'reef' || id === 'lagoon' ? 1 : 0.4)) : g.veg;
      if (dens <= 0) continue;
      // 中心から離れるほど間引く（遠景は色で見せる）
      const edge = Math.max(Math.abs(i - total / 2), Math.abs(j - total / 2)) / (propArea / 2);
      const d = dens * (edge > 0.5 ? 0.45 : 1);
      if (rand() > d) continue;
      if (props.length >= PROP_CAP) continue;
      let total_ = 0;
      for (const [, wgt] of kinds) total_ += wgt;
      let t = rand() * total_, kind = kinds[0][0];
      for (const [k2, wgt] of kinds) { t -= wgt; if (t <= 0) { kind = k2; break; } }
      if (underwater && !['coral', 'algae'].includes(kind)) continue;
      if (!underwater && ['coral', 'algae'].includes(kind)) continue;
      props.push({
        m: modelFor(kind, (rand() * 4) | 0),
        x: i, z: j,
        y: underwater ? hb + 1 : hb + 1,
        rot: (rand() * 4) | 0,
      });
    }
  }

  // 動物：その紀・その環境に載っている種から選ぶ
  const fauna = [];
  // その区画に実際に広がっている環境に棲む種だけを選ぶ。
  // 環境を見ずに紀だけで選ぶと、山頂の湖に首長竜が浮かぶような絵になる
  const here = new Set(topBiomesEarly.map((b) => b.id));
  let pool = (FAUNA[eraId] || []).filter((f) => f.biomes.some((b) => here.has(b)));
  if (!pool.length) pool = (FAUNA[eraId] || []).filter((f) => /翼竜/.test(f.group));
  if (!pool.length) pool = (FAUNA[eraId] || []).filter((f) => f.biomes.some((b) => !WATER_BIOMES.has(b)));
  const herds = 2 + ((rand() * 3) | 0);
  for (let hcount = 0; hcount < herds && pool.length; hcount++) {
    const sp = pool[(rand() * pool.length) | 0];
    const kind = modelForGroup(sp.group);
    const flying = kind === 'pterosaur';
    const swimming = kind === 'plesiosaur';
    const hide = HIDES[(rand() * HIDES.length) | 0];
    const built = FAUNA_BUILDERS[kind](rngFromSeed(`${key}:fauna:${hcount}`), hide);
    built.kind = kind;
    models.push(built);
    const mi = models.length - 1;
    // 実寸（m）に合わせる。モデルの長さ × unit × 6m が全長になるよう縮める
    const scale = clamp(sp.size / (modelSpan(built) * built.unit * VOX_M), 0.35, 3);
    const count = 1 + ((rand() * (sp.size > 12 ? 2 : 4)) | 0);
    const hx = lo + ((rand() * propArea) | 0), hz = lo + ((rand() * propArea) | 0);
    for (let k = 0; k < count; k++) {
      const x = clamp(hx + ((rand() - 0.5) * 26) | 0, 2, total - 3);
      const z = clamp(hz + ((rand() - 0.5) * 26) | 0, 2, total - 3);
      const i2 = z * total + x;
      const hb = height[i2], wl = water[i2];
      const wet = wl !== WATER_NONE && wl > hb;
      if (swimming && !wet) continue;
      if (!swimming && !flying && wet) continue;
      fauna.push({
        m: mi, x, z,
        y: flying ? Math.max(hb, wl === WATER_NONE ? hb : wl) + 8 + ((rand() * 14) | 0) : (wet ? wl : hb) + 1,
        yaw: rand() * Math.PI * 2,
        name: sp.name, latin: sp.latin, group: sp.group, size: sp.size, scale,
      });
    }
  }
  onProgress(0.86, '生き物を放しています');
  await nextTick();

  // --- 5. メタ情報 -----------------------------------------------------
  const lat = 90 - 180 * (cy / world.h);
  const lon = (cx / world.w) * 360 - 180;
  const topBiomes = topBiomesEarly.slice(0, 4);

  return {
    kind: 'voxel',
    seed: world.seed, era: world.era, size, cols, total, blockM: VOX_M,
    x: cx, y: cy, suite, salt,
    height, surf, sub, water, wetness, biomeAt, biomeKeys,
    models, props, fauna,
    meta: {
      lat, lon,
      spanM: total * VOX_M,
      detailM: cols * VOX_M,
      baseElevM: Math.round(elevM(world.elev[centerI])),
      tempC: tempBase,
      moist: world.moistAt(centerI),
      biomes: topBiomes,
      waterShare: waterCells / (waterCells + landCells),
      propCount: props.length,
      faunaCount: fauna.length,
      ms: Date.now() - t0,
      from: opts.from || null,
    },
  };
}

/** 崖に出す岩相。地層は y だけの関数なので横につながる */
export function strataFor(scene, y) {
  return strataAt(y, scene.salt, scene.suite);
}
