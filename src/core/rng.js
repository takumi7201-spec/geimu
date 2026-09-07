/**
 * 決定論的乱数とノイズ。
 * 同じシードからは常に同じ世界が生まれる（生成の再現性を保証する）。
 */

/** 文字列 → 32bit シード列 */
export function xmur3(str) {
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return function () {
    h = Math.imul(h ^ (h >>> 16), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    h ^= h >>> 16;
    return h >>> 0;
  };
}

/** 32bit 状態の高速 PRNG */
export function mulberry32(a) {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** シード文字列から PRNG を作る */
export function rngFromSeed(seed) {
  const h = xmur3(String(seed));
  return mulberry32(h());
}

/**
 * 勾配ノイズ。
 *
 * 格子点のハッシュから勾配を引くので周期を持たない。そのかわり
 * `period` を渡すと x 方向の格子インデックスをそこで折り返し、
 * 指定した周期でぴったり繰り返す場を作れる。
 * 地図の x は経度なので、周波数と同じ値を period に渡せば
 * 左右端が継ぎ目なくつながる（これを忘れると経度 0 に段差が出る）。
 */
export class Noise {
  constructor(seed) {
    const rand = rngFromSeed(seed);
    this.s0 = (rand() * 0xffffffff) >>> 0;
    this.s1 = (rand() * 0xffffffff) >>> 0;
  }

  _hash(X, Y) {
    let h = Math.imul(X, 374761393) ^ Math.imul(Y, 668265263) ^ this.s0;
    h = Math.imul(h ^ (h >>> 13), 1274126177) ^ this.s1;
    return (h ^ (h >>> 16)) >>> 0;
  }

  _grad(h, x, y) {
    // 8 方向の勾配ベクトル
    switch (h & 7) {
      case 0: return x + y;
      case 1: return x - y;
      case 2: return -x + y;
      case 3: return -x - y;
      case 4: return x;
      case 5: return -x;
      case 6: return y;
      default: return -y;
    }
  }

  /** 基本ノイズ。戻り値はおおむね -1..1 */
  noise2(x, y, period = 0) {
    const xi = Math.floor(x), yi = Math.floor(y);
    const xf = x - xi, yf = y - yi;
    const u = xf * xf * xf * (xf * (xf * 6 - 15) + 10);
    const v = yf * yf * yf * (yf * (yf * 6 - 15) + 10);
    let x0 = xi, x1 = xi + 1;
    if (period > 0) {
      x0 = ((x0 % period) + period) % period;
      x1 = ((x1 % period) + period) % period;
    }
    const aa = this._hash(x0, yi), ba = this._hash(x1, yi);
    const ab = this._hash(x0, yi + 1), bb = this._hash(x1, yi + 1);
    const n1 = lerp(this._grad(aa, xf, yf), this._grad(ba, xf - 1, yf), u);
    const n2 = lerp(this._grad(ab, xf, yf - 1), this._grad(bb, xf - 1, yf - 1), u);
    return lerp(n1, n2, v);
  }

  /** 複数オクターブの合成（fBm）。period はオクターブごとに倍化する */
  fbm(x, y, octaves = 5, lacunarity = 2.0, gain = 0.5, period = 0) {
    let amp = 1, freq = 1, sum = 0, norm = 0, p = period;
    for (let i = 0; i < octaves; i++) {
      sum += amp * this.noise2(x * freq, y * freq, p);
      norm += amp;
      amp *= gain;
      freq *= lacunarity;
      p = p > 0 ? p * lacunarity : 0;
    }
    return sum / norm;
  }

  /** 尾根状ノイズ。山脈のシャープな稜線に使う */
  ridged(x, y, octaves = 5, lacunarity = 2.0, gain = 0.5, period = 0) {
    let amp = 1, freq = 1, sum = 0, norm = 0, p = period;
    for (let i = 0; i < octaves; i++) {
      const n = 1 - Math.abs(this.noise2(x * freq, y * freq, p));
      sum += amp * n * n;
      norm += amp;
      amp *= gain;
      freq *= lacunarity;
      p = p > 0 ? p * lacunarity : 0;
    }
    return (sum / norm) * 2 - 1;
  }
}

export function lerp(a, b, t) { return a + (b - a) * t; }
export function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
export function smoothstep(e0, e1, x) {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
}
/** 経度方向のラップを考慮した差分（-0.5..0.5） */
/**
 * 角度差を -π..π に畳む（wrapDelta は経度 0..1 の周期用なので使えない）。
 * 畳まないと、真後ろを向くときに遠回りして一周する。
 */
export function angleDelta(from, to) {
  const TAU = Math.PI * 2;
  let d = (to - from) % TAU;
  if (d > Math.PI) d -= TAU;
  if (d < -Math.PI) d += TAU;
  return d;
}

export function wrapDelta(a, b) {
  let d = a - b;
  if (d > 0.5) d -= 1;
  if (d < -0.5) d += 1;
  return d;
}
