/**
 * 世界ラスタの生成（DOM 非依存）。
 * ブラウザの描画も CLI の PNG 書き出しもここを通す。
 */

import { BIOMES, BIOME_IDS } from '../world/biomes.js';
import { hypsometric, thermal, hydric, crust } from './palette.js';
import { clamp } from '../core/rng.js';

export const VIEW_MODES = {
  biome:       '生態系',
  elevation:   '標高段彩',
  temperature: '気温',
  moisture:    '降水・湿潤',
  crust:       '地殻区分',
};

/** 標高勾配から陰影係数を作る（光源は北西・仰角 45°） */
export function computeHillshade(elev, w, h) {
  const out = new Float32Array(w * h);
  const scale = 34;
  for (let y = 0; y < h; y++) {
    const yn = Math.max(0, y - 1), ys = Math.min(h - 1, y + 1);
    for (let x = 0; x < w; x++) {
      const xw = (x - 1 + w) % w, xe = (x + 1) % w;
      const dzdx = (elev[y * w + xe] - elev[y * w + xw]) * scale;
      const dzdy = (elev[ys * w + x] - elev[yn * w + x]) * scale;
      const nx = -dzdx, ny = -dzdy, nz = 1;
      const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
      const dot = (nx * -0.55 + ny * -0.55 + nz * 0.63) / len;
      out[y * w + x] = clamp(0.62 + dot * 0.62, 0.5, 1.45);
    }
  }
  return out;
}

/**
 * RGBA ラスタを作る。
 * @param {object} world
 * @param {string} mode  VIEW_MODES のキー
 * @param {{hillshade?:boolean, rivers?:boolean, borders?:boolean}} layers
 * @param {Uint8ClampedArray} [into] 既存バッファに書き込む場合
 */
export function buildRaster(world, mode = 'biome', layers = {}, into = null) {
  const { w, h, elev, temp, moist, cont, biome, river, lake, hw, hh } = world;
  const opt = { hillshade: true, rivers: true, borders: true, ...layers };
  const d = into || new Uint8ClampedArray(w * h * 4);
  const shade = opt.hillshade ? computeHillshade(elev, w, h) : null;

  for (let i = 0; i < w * h; i++) {
    const e = elev[i];
    let c;
    switch (mode) {
      case 'elevation':
        c = hypsometric(e >= 0 ? 0.5 + Math.pow(e, 0.75) * 0.5 : 0.5 - Math.pow(-e, 0.65) * 0.5);
        break;
      case 'temperature':
        c = thermal(clamp((temp[i] / 2 - 60 + 30) / 75, 0, 1));
        break;
      case 'moisture':
        c = hydric(moist[i] / 255);
        break;
      case 'crust':
        c = crust(clamp((cont[i] / 255) * 0.5 + (e > 0 ? 0.55 : 0.2), 0, 1));
        break;
      default:
        c = BIOMES[BIOME_IDS[biome[i]]].color;
    }

    let r = c[0], g = c[1], b = c[2];
    if (e < 0 && (mode === 'biome' || mode === 'crust')) {
      const k = 1 - clamp(-e * 0.55, 0, 0.42);
      r *= k; g *= k; b *= k;
    }
    if (shade && e > 0) { const s = shade[i]; r *= s; g *= s; b *= s; }
    if (opt.borders && e > 0 && e < 0.012) { r *= 0.86; g *= 0.86; b *= 0.88; }

    const o = i * 4;
    d[o] = r; d[o + 1] = g; d[o + 2] = b; d[o + 3] = 255;
  }

  if (opt.rivers) {
    for (let y = 0; y < hh; y++) {
      for (let x = 0; x < hw; x++) {
        const hi = y * hw + x;
        const lv = river[hi];
        const isLake = lake[hi];
        if (!lv && !isLake) continue;
        const col = isLake ? [58, 106, 152] : [52, 96, 150];
        const alpha = isLake ? 1 : clamp(0.30 + lv * 0.14, 0, 1);
        const span = lv >= 5 ? 2 : 1;
        for (let dy = 0; dy < 2 * span; dy++) {
          const py = y * 2 + dy;
          if (py >= h) continue;
          for (let dx = 0; dx < 2 * span; dx++) {
            const px = (x * 2 + dx) % w;
            const o = (py * w + px) * 4;
            d[o] = d[o] * (1 - alpha) + col[0] * alpha;
            d[o + 1] = d[o + 1] * (1 - alpha) + col[1] * alpha;
            d[o + 2] = d[o + 2] * (1 - alpha) + col[2] * alpha;
          }
        }
      }
    }
  }
  return d;
}
