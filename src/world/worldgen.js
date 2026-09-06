/**
 * 中生代ワールドジェネレータ。
 *
 * 手順:
 *   1. 大陸核と海路の影響場から素の標高をつくる
 *   2. 造山帯に尾根ノイズを重ね、大陸棚と深海底を整形する
 *   3. 緯度・標高から気温を求める
 *   4. 卓越風を東西に走らせて降水と雨陰をつくる
 *   5. 窪地を埋めて河川と湖を流す
 *   6. バイオームを判定する
 *
 * DOM に依存しないので Node からも同じ結果を再現できる。
 */

import { Noise, clamp, smoothstep, wrapDelta, rngFromSeed } from '../core/rng.js';
import { getEra } from './eras.js';
import { eraAtAge } from './timeline.js';
import { classify, BIOME_IDS, BIOME_INDEX } from './biomes.js';
import { fillDepressions, accumulateFlow, detectLakes } from './hydrology.js';

export const SIZES = {
  small:  { w: 1024, h: 512,  label: '小 1024×512' },
  medium: { w: 2048, h: 1024, label: '中 2048×1024' },
  large:  { w: 3072, h: 1536, label: '大 3072×1536' },
  huge:   { w: 4096, h: 2048, label: '極大 4096×2048' },
};

// 基本周波数。ノイズ呼び出しには必ず同じ値を period として渡す。
// そうしないと経度 0 の位置で標高が不連続になる（地図の左右端に段差が出る）。
const F_CONT = 8;
const F_DETAIL = 32;
const F_RIDGE = 64;

// 海面基準のオフセット。大きいほど陸地が減る
const LAND_BIAS = 0.30;

/**
 * 楕円ブロブの影響度 0..1。
 * warp に距離のゆがみを渡すと輪郭そのものが崩れ、楕円らしさが消える。
 */
function blob(x, y, b, warp = 0) {
  const dx = wrapDelta(x, b.x) / b.rx;
  const dy = (y - b.y) / b.ry;
  const d = Math.sqrt(dx * dx + dy * dy) * (1 + warp);
  return b.h * smoothstep(1.02, 0.20, d);
}

/**
 * 外洋に島弧・海洋島・海台をばらまく。
 * 大陸から離れた場所だけを選び、弧状に連なるチェーンとして置く。
 */
function scatterIslands(era, rand, count) {
  const isDeepOcean = (x, y) => {
    for (const cr of era.cratons) if (blob(x, y, cr) > 0.12) return false;
    return true;
  };
  const chains = [];
  let guard = 0;
  while (chains.length < count && guard++ < 4000) {
    const x0 = rand(), y0 = 0.10 + rand() * 0.80;
    if (!isDeepOcean(x0, y0)) continue;
    const plateau = rand() < 0.32;
    const len = plateau ? 1 : 2 + ((rand() * 6) | 0);
    const ang = rand() * Math.PI * 2;
    const curve = (rand() - 0.5) * 0.9;
    const step = 0.020 + rand() * 0.022;
    const blobs = [];
    let x = x0, y = y0, a = ang;
    for (let k = 0; k < len; k++) {
      if (!isDeepOcean(x, y)) break;
      const r = plateau ? 0.028 + rand() * 0.026 : 0.009 + rand() * 0.016;
      blobs.push({
        x: ((x % 1) + 1) % 1, y,
        rx: r, ry: r * 2,
        // 海台は海面下の浅堆にとどめ、火山島だけが海面を突き抜ける
        h: plateau ? 0.09 + rand() * 0.09 : 0.55 + rand() * 0.36,
      });
      a += curve * 0.5;
      x += Math.cos(a) * step;
      y += Math.sin(a) * step * 0.5;
      if (y < 0.06 || y > 0.94) break;
    }
    if (blobs.length) chains.push(...blobs);
  }
  return chains;
}

/** 折れ線（造山帯）までの正規化距離 0..1（1 が中心） */
function beltInfluence(x, y, belt, widthScale = 1) {
  let best = Infinity;
  const pts = belt.pts;
  for (let i = 0; i < pts.length - 1; i++) {
    const [ax, ay] = pts[i];
    const [bx, by] = pts[i + 1];
    // y を x と同じ尺度に合わせる（正距円筒 2:1 の補正）
    const vx = wrapDelta(bx, ax), vy = (by - ay) * 0.5;
    const px = wrapDelta(x, ax), py = (y - ay) * 0.5;
    const len2 = vx * vx + vy * vy || 1e-9;
    const t = clamp((px * vx + py * vy) / len2, 0, 1);
    const cx = px - vx * t, cy = py - vy * t;
    const d = Math.sqrt(cx * cx + cy * cy);
    if (d < best) best = d;
  }
  const bw = belt.w * widthScale;
  return smoothstep(bw, bw * 0.15, best) * belt.h;
}

function volcanoInfluence(x, y, v) {
  const dx = wrapDelta(x, v.x), dy = (y - v.y) * 0.5;
  const d = Math.sqrt(dx * dx + dy * dy);
  return smoothstep(v.r, v.r * 0.2, d);
}

const nextTick = () =>
  new Promise((r) => (typeof requestAnimationFrame === 'function' ? requestAnimationFrame(() => r()) : setTimeout(r, 0)));

/**
 * 世界を生成する。
 * `ma`（百万年前）を渡すと、紀と紀のあいだの年代も生成できる。
 * 指定がなければ eraId の紀の代表年代を使う。
 * @param {{seed:string, eraId?:string, ma?:number, size:string}} opts
 * @param {(p:number, label:string)=>void} [onProgress]
 */
export async function generateWorld(opts, onProgress = () => {}) {
  const { seed = 'mesozoic', eraId = 'jurassic', size = 'medium', ma = null } = opts;
  const dim = SIZES[size] || SIZES.medium;
  const w = dim.w, h = dim.h, n = w * h;
  const era = ma == null ? getEra(eraId) : eraAtAge(ma);

  const nContinent = new Noise(seed + ':continent');
  const nDetail = new Noise(seed + ':detail');
  const nWarp = new Noise(seed + ':warp');
  const nWarp2 = new Noise(seed + ':warp2');
  const nDetail2 = new Noise(seed + ':detail2');
  const nMoist2 = new Noise(seed + ':moist2');
  const nRidge = new Noise(seed + ':ridge');
  const nTemp = new Noise(seed + ':temp');
  const nMoist = new Noise(seed + ':moist');
  const rand = rngFromSeed(seed + ':scatter');

  const elev = new Float32Array(n);
  const cont = new Uint8Array(n);
  const volc = new Uint8Array(n);
  const temp = new Uint8Array(n);   // (℃ + 60) * 2
  const moist = new Uint8Array(n);  // 0..255
  const biome = new Uint8Array(n);

  const CHUNK = Math.max(8, (65536 / w) | 0);

  // 外洋の島弧・海台。行ごとに候補を絞ってから評価する
  const islands = scatterIslands(era, rngFromSeed(`${seed}:islands:${Math.round(era.ma ?? 0)}`), 26);
  const islandRows = Array.from({ length: h }, () => []);
  for (const b of islands) {
    const y0 = Math.max(0, Math.floor((b.y - b.ry) * h));
    const y1 = Math.min(h - 1, Math.ceil((b.y + b.ry) * h));
    for (let y = y0; y <= y1; y++) islandRows[y].push(b);
  }

  // ---- 1. 標高 -------------------------------------------------------
  for (let y0 = 0; y0 < h; y0 += CHUNK) {
    const y1 = Math.min(h, y0 + CHUNK);
    for (let y = y0; y < y1; y++) {
      const fy = y / h;
      const rowIslands = islandRows[y];
      for (let x = 0; x < w; x++) {
        const fx = x / w;

        // 大陸輪郭のゆがみ。大小 2 スケールで効かせて楕円の名残を消す
        const dWarp =
          nWarp.fbm(fx * F_CONT * 2, fy * F_CONT, 4, 2, 0.5, F_CONT * 2) * 0.40 +
          nWarp.fbm(fx * F_DETAIL, fy * F_DETAIL * 0.5, 3, 2, 0.5, F_DETAIL) * 0.16;
        const edgeWarp = nWarp2.fbm(fx * F_RIDGE * 2, fy * F_RIDGE, 3, 2, 0.5, F_RIDGE * 2) * 0.30;

        // 影響場は最大値ではなく p-ノルムで結合する。
        // 単純な max だと核どうしの境界に直線的な稜線と海岸の弧が残る。
        let acc = 0;
        for (const cr of era.cratons) { const v = blob(fx, fy, cr, dWarp); acc += v * v * v; }
        for (let k = 0; k < rowIslands.length; k++) {
          // 島は小さいので高周波側のゆがみを強めにかける
          const v = blob(fx, fy, rowIslands[k], dWarp * 1.2 + edgeWarp);
          acc += v * v * v;
        }
        const c = Math.min(1.15, Math.cbrt(acc));

        let sAcc = 0;
        for (const se of era.seas) {
          // 海峡のように細い海域は低周波ワープでは形が崩れないので高周波も足す
          const narrow = se.rx < 0.03 ? edgeWarp * 1.4 : edgeWarp * 0.4;
          const v = blob(fx, fy, se, dWarp * 0.85 + narrow);
          sAcc += v * v * v;
        }
        const s = Math.min(1.3, Math.cbrt(sAcc));

        const shape = nContinent.fbm(fx * F_CONT, fy * F_CONT * 0.5, 6, 2, 0.5, F_CONT);
        const detail = nDetail.fbm(fx * F_DETAIL, fy * F_DETAIL * 0.5, 5, 2, 0.5, F_DETAIL);
        const edge = nDetail2.fbm(fx * F_RIDGE, fy * F_RIDGE * 0.5, 4, 2, 0.5, F_RIDGE);
        // 海岸付近（c が中間値の帯）でだけ高周波を強く乗せて、入り江と岬をつくる
        const edgeAmp = 4 * c * (1 - c);

        const land =
          (c - s * 1.06) * 1.30 - LAND_BIAS - era.seaLevel +
          shape * (0.13 + 0.26 * c) + detail * (0.04 + 0.10 * c) +
          edge * 0.16 * edgeAmp;

        let hv;
        if (land <= 0) {
          const openness = 1 - clamp(c, 0, 1);
          // 大陸棚 → 大陸斜面 → 深海平原へなだらかに落とす
          hv = land * (1 + 2.2 * smoothstep(0.0, 0.38, -land) * openness);
          // 海嶺と深海丘陵で海底を単調にしない
          // 座標をずらしてから尾根ノイズを取る（格子に沿った直線的な模様を防ぐ）
          const ox = fx + nWarp.fbm(fx * F_DETAIL, fy * F_DETAIL * 0.5, 2, 2, 0.5, F_DETAIL) * 0.05;
          const oy = fy + nWarp2.fbm(fx * F_DETAIL, fy * F_DETAIL * 0.5, 2, 2, 0.5, F_DETAIL) * 0.05;
          hv += nRidge.ridged(ox * F_CONT * 2, oy * F_CONT, 4, 2, 0.5, F_CONT * 2) * 0.13 * openness;
          hv += nDetail2.fbm(fx * F_RIDGE, fy * F_RIDGE * 0.5, 4, 2, 0.5, F_RIDGE) * 0.055 * openness;
          // 大陸地殻の上は深海にならない：内海と陸棚海はあくまで浅い
          if (c > 0.25) {
            const floor = -0.05 - 0.45 * (1 - c);
            if (hv < floor) hv = floor - (floor - hv) * 0.18;
          }
        } else {
          // 陸：大陸は基本的に低平で、高度は造山帯が担う
          hv = Math.pow(Math.min(land, 1.25), 1.5) * 0.30;
        }

        // 造山帯：陸上のみ隆起させる
        let beltAmt = 0;
        // 幅をノイズで揺らし、定規で引いたような山脈にしない
        const beltJitter = 1 + edge * 0.45 + shape * 0.25;
        for (const b of era.belts) {
          const v = beltInfluence(fx, fy, b, beltJitter);
          if (v > beltAmt) beltAmt = v;
        }
        if (beltAmt > 0 && land > 0) {
          const ridge = (nRidge.ridged(fx * F_RIDGE, fy * F_RIDGE * 0.5, 4, 2, 0.5, F_RIDGE) + 1) * 0.5;
          hv += beltAmt * (0.18 + ridge * 0.72) * clamp(land * 4, 0, 1);
        }

        // 火山区。輪郭をノイズで崩して円形に見せない
        let vAmt = 0;
        for (const v of era.volcanoes) {
          const t = volcanoInfluence(fx, fy, v) * (v.w ?? 1) * clamp(0.72 + shape * 0.5 + edge * 0.55, 0, 1.4);
          if (t > vAmt) vAmt = t;
        }
        if (vAmt > 0) hv += vAmt * (land > 0 ? 0.20 : 0.28) * clamp(land + 0.35, 0, 1);

        const i = y * w + x;
        elev[i] = clamp(hv, -1, 1);
        cont[i] = (clamp(c, 0, 1) * 255) | 0;
        volc[i] = (clamp(vAmt, 0, 1) * 255) | 0;
      }
    }
    onProgress((y1 / h) * 0.40, '大陸と海盆を配置中');
    await nextTick();
  }

  // ---- 2. 気温 -------------------------------------------------------
  for (let y = 0; y < h; y++) {
    const lat = 90 - 180 * (y / h);
    const a = Math.abs(lat) / 90;
    const base = 32 - 34 * Math.pow(a, 1.30) + era.baseTemp * 0.6;
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const m = elev[i] > 0 ? elev[i] * 4600 : 0;
      const jitter = nTemp.fbm((x / w) * 16, (y / h) * 8, 3, 2, 0.5, 16) * 2.4;
      const t = base - m * 0.0062 + jitter;
      temp[i] = clamp((t + 60) * 2, 0, 255) | 0;
    }
  }
  onProgress(0.46, '気候帯を計算中');
  await nextTick();

  // ---- 3. 海からの距離（大陸度） ------------------------------------
  const dist = oceanDistance(elev, w, h);
  onProgress(0.52, '内陸度を測定中');
  await nextTick();

  // ---- 4. 卓越風による降水と雨陰 ------------------------------------
  // 貿易風（東寄り）と偏西風を両方走らせ、境界緯度で混ぜる。
  // 片方だけを緯度で切り替えると、風向が反転する緯度に不自然な横縞が出る。
  const precip = new Float32Array(n);
  const rowE = new Float32Array(w);
  const rowW = new Float32Array(w);

  const marchRow = (y, dir, out) => {
    const row = y * w;
    let humidity = 0.5;
    let prevE = elev[row + (dir > 0 ? w - 1 : 0)];
    const laps = 3;               // 2 周を助走にして、開始経度の継ぎ目を消す
    const steps = w * laps;
    const x0 = dir > 0 ? 0 : w - 1;
    for (let k = 0; k < steps; k++) {
      const x = (((x0 + dir * k) % w) + w) % w;
      const i = row + x;
      const e = elev[i];
      const tC = temp[i] / 2 - 60;
      let p;
      if (e <= 0) {
        const cap = clamp(0.30 + tC * 0.026, 0.05, 1.5);
        humidity += (cap - humidity) * 0.14;
        p = humidity * 0.010;
      } else {
        const rise = Math.max(0, e - prevE);
        p = humidity * (0.013 + rise * 6.5);
        humidity = Math.max(0, humidity - p * 0.75);
        humidity += 0.0016;       // 蒸散による戻り
      }
      prevE = e;
      if (k >= w * (laps - 1)) out[x] = p;
    }
  };

  for (let y = 0; y < h; y++) {
    const al = Math.abs(90 - 180 * (y / h));
    // 偏西風帯（およそ 30〜60 度）の重み。境界はなめらかに渡す
    const westerly = smoothstep(20, 40, al) - smoothstep(50, 70, al);
    marchRow(y, 1, rowW);
    marchRow(y, -1, rowE);
    for (let x = 0; x < w; x++) {
      precip[y * w + x] = rowW[x] * westerly + rowE[x] * (1 - westerly);
    }
    if ((y & 63) === 0) { onProgress(0.52 + (y / h) * 0.10, '大気循環を回しています'); await nextTick(); }
  }

  // 降水量は陸上セルだけを母集団にして正規化する（海が大半を占めるため）
  const landPrecip = [];
  for (let i = 0; i < n; i += Math.max(1, (n / 300000) | 0)) if (elev[i] > 0) landPrecip.push(precip[i]);
  const pNorm = rankNormalizer(landPrecip.length > 1000 ? landPrecip : Array.from(precip));
  // 内陸度は「その世界で最も海から遠い場所」を 1 とする。
  // 大陸の大きさが紀ごとに違うので固定値では乾燥帯が出ない。
  const landDist = [];
  for (let i = 0; i < n; i += Math.max(1, (n / 200000) | 0)) if (elev[i] > 0) landDist.push(dist[i]);
  landDist.sort((a, b) => a - b);
  const maxDist = Math.max(4, landDist.length ? landDist[(landDist.length * 0.97) | 0] : w * 0.05);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      // 気候帯の境界を経度方向にうねらせる（直線的な横縞を避ける）
      const jog = nMoist.fbm((x / w) * 8, (y / h) * 4, 3, 2, 0.5, 8) * 9;
      const lat = 90 - 180 * (y / h) + jog;
      const al = Math.abs(lat);
      // ITCZ と中緯度低圧帯、亜熱帯高圧帯の乾燥
      const band =
        0.85 * Math.exp(-Math.pow(lat / 14, 2)) +
        0.55 * Math.exp(-Math.pow((al - 50) / 22, 2)) +
        0.16;
      const inland = clamp(dist[i] / maxDist, 0, 1);
      const wind = pNorm(precip[i]);
      let m = (0.58 * wind + 0.42 * clamp(band, 0, 1)) * 1.15; // 温室地球の高い蒸発量
      m *= 1 - era.aridity * Math.pow(inland, 0.55);
      m += nMoist2.fbm((x / w) * 24, (y / h) * 12, 4, 2, 0.5, 24) * 0.09;
      if (elev[i] <= 0) m = clamp(m + 0.35, 0, 1);
      moist[i] = clamp(m, 0, 1) * 255;
    }
  }
  onProgress(0.66, '降水と雨陰を配分中');
  await nextTick();

  // ---- 5. 河川と湖（半解像度） ---------------------------------------
  const hw = w >> 1, hh = h >> 1;
  const he = new Float32Array(hw * hh);
  const hrain = new Float32Array(hw * hh);
  for (let y = 0; y < hh; y++) {
    for (let x = 0; x < hw; x++) {
      const a = (y * 2) * w + x * 2;
      const b = a + 1, c2 = a + w, d = a + w + 1;
      he[y * hw + x] = (elev[a] + elev[b] + elev[c2] + elev[d]) * 0.25;
      hrain[y * hw + x] = 0.25 + (moist[a] / 255) * 1.75;
    }
  }
  // 平坦面ではセルの標高が並ぶため、流路が走査順に沿って直線化する。
  // 微小なゆらぎ（数十 cm 相当）を足して流向のタイを崩す。
  for (let i = 0; i < he.length; i++) {
    if (he[i] > 0) {
      const hsh = Math.imul(i ^ 0x9e3779b9, 2654435761) >>> 8;
      he[i] += ((hsh & 1023) / 1023 - 0.5) * 3e-4;
    }
  }
  const filled = fillDepressions(he, hw, hh, 0);
  const { flow, down } = accumulateFlow(filled, he, hw, hh, hrain, 0);
  const lake = detectLakes(filled, he, hw, hh, 0, 0.004);
  onProgress(0.82, '河川網を流しています');
  await nextTick();

  // 流量を 0..6 の河川次数に落とす
  const river = new Uint8Array(hw * hh);
  const sorted = Array.from(flow).filter((v) => v > 0).sort((a, b) => a - b);
  const q = (p) => sorted.length ? sorted[Math.min(sorted.length - 1, (sorted.length * p) | 0)] : Infinity;
  const levels = [q(0.980), q(0.991), q(0.9965), q(0.9988), q(0.9996), q(0.99992)];
  for (let i = 0; i < river.length; i++) {
    if (he[i] <= 0) continue;
    const f = flow[i];
    let lv = 0;
    for (let k = 0; k < levels.length; k++) if (f >= levels[k]) lv = k + 1;
    river[i] = lv;
  }

  // ---- 6. バイオーム -------------------------------------------------
  for (let y0 = 0; y0 < h; y0 += CHUNK) {
    const y1 = Math.min(h, y0 + CHUNK);
    for (let y = y0; y < y1; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        const hi = (y >> 1) * hw + (x >> 1);
        let m = moist[i] / 255;
        if (river[hi] >= 2) m = Math.min(1, m + 0.10 + river[hi] * 0.02);
        if (lake[hi]) m = Math.min(1, m + 0.20);
        const id = classify(elev[i], temp[i] / 2 - 60, m, cont[i] / 255, volc[i] / 255, era.id);
        biome[i] = BIOME_INDEX[id];
      }
    }
    onProgress(0.82 + (y1 / h) * 0.14, '生態系を分類中');
    await nextTick();
  }

  const world = {
    seed, size, era, w, h, hw, hh,
    elev, cont, volc, temp, moist, biome,
    flow, river, lake, down, dist,
    rand,
    idx: (x, y) => ((y | 0) * w + (((x | 0) % w) + w) % w),
    tempAt(i) { return this.temp[i] / 2 - 60; },
    moistAt(i) { return this.moist[i] / 255; },
    biomeAt(i) { return BIOME_IDS[this.biome[i]]; },
  };
  world.stats = computeStats(world);
  onProgress(0.97, '仕上げ');
  return world;
}

/** 海までのチェビシェフ近似距離（セル単位）。x 方向はラップ */
function oceanDistance(elev, w, h) {
  const n = w * h;
  const d = new Float32Array(n);
  const INF = 1e9;
  for (let i = 0; i < n; i++) d[i] = elev[i] <= 0 ? 0 : INF;

  const relax = (i, j, cost) => { const v = d[j] + cost; if (v < d[i]) d[i] = v; };
  for (let pass = 0; pass < 2; pass++) {
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (d[i] === 0) continue;
        const xl = (x - 1 + w) % w;
        relax(i, y * w + xl, 1);
        if (y > 0) {
          relax(i, (y - 1) * w + x, 1);
          relax(i, (y - 1) * w + xl, 1.41);
          relax(i, (y - 1) * w + ((x + 1) % w), 1.41);
        }
      }
    }
    for (let y = h - 1; y >= 0; y--) {
      for (let x = w - 1; x >= 0; x--) {
        const i = y * w + x;
        if (d[i] === 0) continue;
        const xr = (x + 1) % w;
        relax(i, y * w + xr, 1);
        if (y < h - 1) {
          relax(i, (y + 1) * w + x, 1);
          relax(i, (y + 1) * w + xr, 1.41);
          relax(i, (y + 1) * w + ((x - 1 + w) % w), 1.41);
        }
      }
    }
  }
  return d;
}

/**
 * 順位正規化（ヒストグラム平坦化）。
 * 地形性降水は外れ値が大きく分位点法では中央値がつぶれるため、
 * 値そのものではなく順位を 0..1 に写す。
 */
export function rankNormalizer(values) {
  const s = Float64Array.from(values);
  s.sort();
  const m = s.length;
  return (v) => {
    let lo = 0, hi = m;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (s[mid] < v) lo = mid + 1; else hi = mid;
    }
    return m > 1 ? lo / (m - 1) : 0.5;
  };
}

/** 分位点で 0..1 に正規化する関数を返す */
function percentileNormalizer(arr, lo, hi) {
  const step = Math.max(1, (arr.length / 200000) | 0);
  const s = [];
  for (let i = 0; i < arr.length; i += step) s.push(arr[i]);
  s.sort((a, b) => a - b);
  const a = s[Math.min(s.length - 1, (s.length * lo) | 0)];
  const b = s[Math.min(s.length - 1, (s.length * hi) | 0)];
  const range = Math.max(1e-9, b - a);
  return (v) => clamp((v - a) / range, 0, 1);
}

function computeStats(world) {
  const { elev, temp, biome, w, h } = world;
  const n = w * h;
  let land = 0, sumT = 0, maxE = -1, minE = 1;
  const counts = new Uint32Array(BIOME_IDS.length);
  // 緯度による面積の縮みを補正して陸地率を出す
  let landArea = 0, totalArea = 0;
  for (let y = 0; y < h; y++) {
    const cw = Math.cos(((90 - 180 * ((y + 0.5) / h)) * Math.PI) / 180);
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      counts[biome[i]]++;
      totalArea += cw;
      if (elev[i] > 0) { land++; landArea += cw; }
      if (elev[i] > maxE) maxE = elev[i];
      if (elev[i] < minE) minE = elev[i];
      sumT += temp[i];
    }
  }
  const top = [...counts]
    .map((c, i) => ({ id: BIOME_IDS[i], c }))
    .sort((a, b) => b.c - a.c)
    .filter((e) => e.c > 0);
  return {
    landRatio: landArea / totalArea,
    landCells: land,
    meanTemp: sumT / n / 2 - 60,
    maxElev: maxE,
    minElev: minE,
    biomeCounts: Object.fromEntries(top.map((e) => [e.id, e.c / n])),
  };
}
