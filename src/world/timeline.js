/**
 * 年代軸。三つの紀を一本の時間軸につなぐ。
 *
 * 各紀の古地理はキーフレームで、大陸核・海路・造山帯には紀をまたいで
 * 同じプレートを指す id が付いている。ここではその id を手がかりに
 * 位置と大きさを補間し、任意の年代の古地理をつくる。
 * 片方の紀にしか存在しないプレートは、影響度 h を 0 から立ち上げる／0 へ落とす
 * ことで、分裂や衝突として見える。
 */

import { ERAS } from './eras.js';
import { clamp, wrapDelta, lerp } from '../core/rng.js';

/** 時間軸の範囲（百万年前）。中生代のおおよその全域 */
export const AGE_MIN = 70;
export const AGE_MAX = 250;

const KEYS = [...ERAS].sort((a, b) => b.ma - a.ma); // 古い順

/** 年代を挟む二つのキーフレームと混合比を返す */
function bracket(ma) {
  const age = clamp(ma, KEYS[KEYS.length - 1].ma, KEYS[0].ma);
  for (let i = 0; i < KEYS.length - 1; i++) {
    const a = KEYS[i], b = KEYS[i + 1];
    if (age <= a.ma && age >= b.ma) {
      const t = a.ma === b.ma ? 0 : (a.ma - age) / (a.ma - b.ma);
      return { a, b, t };
    }
  }
  return { a: KEYS[0], b: KEYS[0], t: 0 };
}

/** 経度のラップを考慮して位置を補間する */
function lerpPos(a, b, t) {
  const x = a.x + wrapDelta(b.x, a.x) * t;
  return { x: ((x % 1) + 1) % 1, y: lerp(a.y, b.y, t) };
}

/**
 * id をそろえて二つのリストを補間する。
 * 片側にしかない要素は fade で指定したキーの値を 0 に落として立ち上げる。
 */
function blendById(listA, listB, t, fade) {
  const ids = new Set([...listA.map((e) => e.id), ...listB.map((e) => e.id)]);
  const byA = new Map(listA.map((e) => [e.id, e]));
  const byB = new Map(listB.map((e) => [e.id, e]));
  const out = [];
  for (const id of ids) {
    const a = byA.get(id), b = byB.get(id);
    if (a && b) {
      const p = lerpPos(a, b, t);
      out.push({ ...(t < 0.5 ? a : b), ...p, ...fade(a, b, t) });
    } else if (a) {
      // 消えていくプレート：位置は据え置き、影響だけを落とす
      out.push({ ...a, ...fade(a, { ...a, h: 0, r: a.r }, t) });
    } else {
      out.push({ ...b, ...fade({ ...b, h: 0, r: b.r }, b, t) });
    }
  }
  return out;
}

const fadeBlob = (a, b, t) => ({
  rx: lerp(a.rx, b.rx, t),
  ry: lerp(a.ry, b.ry, t),
  h: lerp(a.h, b.h, t),
});

/**
 * 指定した年代の古地理をつくる。
 * キーフレームちょうどの年代なら、その紀の定義をそのまま返す。
 * @param {number} ma 百万年前
 */
export function eraAtAge(ma) {
  const { a, b, t } = bracket(ma);
  if (a === b || t <= 0.001) return { ...a, ma, interpolated: false };
  if (t >= 0.999) return { ...b, ma, interpolated: false };

  const dom = t < 0.5 ? a : b; // 名前や紀の性格は近いほうから取る

  const cratons = blendById(a.cratons, b.cratons, t, fadeBlob);
  const seas = blendById(a.seas, b.seas, t, fadeBlob);

  const belts = blendBelts(a.belts, b.belts, t);

  const volcanoes = blendById(a.volcanoes, b.volcanoes, t, (x, y, k) => ({
    r: lerp(x.r ?? 0, y.r ?? 0, k),
    w: lerp(x.r != null && x.h !== 0 ? 1 : 1, 1, k),
  })).map((v, i) => ({ ...v, w: volcWeight(a, b, v.id, t) })).filter((v) => v.w > 0.05);

  const provinces = blendById(a.provinces, b.provinces, t, () => ({}))
    .filter((p) => (t < 0.5 ? a.provinces : b.provinces).some((q) => q.id === p.id))
    .map((p) => {
      const near = (t < 0.5 ? a : b).provinces.find((q) => q.id === p.id);
      return { ...p, name: near ? near.name : p.name };
    });

  return {
    id: dom.id,
    ma,
    interpolated: true,
    name: dom.name,
    nameEn: dom.nameEn,
    age: `${Math.round(ma)} 百万年前`,
    sub: describeTransition(a, b, t),
    accent: dom.accent,
    seaLevel: lerp(a.seaLevel, b.seaLevel, t),
    baseTemp: lerp(a.baseTemp, b.baseTemp, t),
    aridity: lerp(a.aridity, b.aridity, t),
    cratons, seas, belts, volcanoes, provinces,
    oceans: dom.oceans,
  };
}

/**
 * 造山帯の補間。
 * 同じ id で節点数も同じなら折れ線ごと動かす（沈み込み帯が移動していく）。
 * 片方の紀にしか無い山脈は、単純に高さを 0 まで落とすと中間年代で
 * すべての山が半分の高さになってしまうので、下限を残して緩やかに増減させる。
 */
function blendBelts(beltsA, beltsB, t) {
  const byB = new Map(beltsB.map((e) => [e.id, e]));
  const byA = new Map(beltsA.map((e) => [e.id, e]));
  const out = [];
  const seen = new Set();

  for (const a of beltsA) {
    const b = byB.get(a.id);
    if (b && b.pts.length === a.pts.length) {
      seen.add(a.id);
      out.push({
        ...(t < 0.5 ? a : b),
        pts: a.pts.map((p, i) => {
          const q = b.pts[i];
          const x = p[0] + wrapDelta(q[0], p[0]) * t;
          return [((x % 1) + 1) % 1, lerp(p[1], q[1], t)];
        }),
        w: lerp(a.w, b.w, t),
        h: lerp(a.h, b.h, t),
      });
    } else {
      // 削剥されていく山脈。完全には消さない
      out.push({ ...a, h: a.h * (1 - 0.68 * smoothstep01(0.25, 1.0, t)) });
    }
  }
  for (const b of beltsB) {
    if (seen.has(b.id) || byA.has(b.id)) continue;
    // 隆起してくる山脈
    out.push({ ...b, h: b.h * (0.32 + 0.68 * smoothstep01(0.0, 0.75, t)) });
  }
  return out;
}

function smoothstep01(e0, e1, x) {
  const k = clamp((x - e0) / (e1 - e0), 0, 1);
  return k * k * (3 - 2 * k);
}

/** 火成区は片方の紀にしか無いことが多いので、存在の重みだけを混ぜる */
function volcWeight(a, b, id, t) {
  const inA = a.volcanoes.some((v) => v.id === id);
  const inB = b.volcanoes.some((v) => v.id === id);
  if (inA && inB) return 1;
  return inA ? 1 - t : t;
}

function describeTransition(a, b, t) {
  const pct = Math.round(t * 100);
  return `${a.name}から${b.name}への遷移（${100 - pct}% : ${pct}%）。大陸は移動の途中にある`;
}

/** スライダー用のラベル。キーフレームの位置を返す */
export function timelineMarks() {
  return KEYS.map((e) => ({ ma: e.ma, name: e.name, id: e.id, accent: e.accent }));
}
