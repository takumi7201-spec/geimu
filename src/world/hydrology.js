/**
 * 水文モデル：窪地埋め（Priority-Flood）→ 流向 → 流量集積。
 * 半解像度グリッドで動かして、そこから河川・湖を取り出す。
 */

/** 標高順に取り出す最小ヒープ（インデックスのみ保持） */
class MinHeap {
  constructor(cap, key) {
    this.a = new Int32Array(cap);
    this.n = 0;
    this.key = key;
  }
  push(v) {
    const a = this.a, key = this.key;
    let i = this.n++;
    a[i] = v;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (key[a[p]] <= key[a[i]]) break;
      const t = a[p]; a[p] = a[i]; a[i] = t;
      i = p;
    }
  }
  pop() {
    const a = this.a, key = this.key;
    const top = a[0];
    if (--this.n > 0) {
      a[0] = a[this.n];
      let i = 0;
      for (;;) {
        const l = i * 2 + 1, r = l + 1;
        let s = i;
        if (l < this.n && key[a[l]] < key[a[s]]) s = l;
        if (r < this.n && key[a[r]] < key[a[s]]) s = r;
        if (s === i) break;
        const t = a[s]; a[s] = a[i]; a[i] = t;
        i = s;
      }
    }
    return top;
  }
}

const DX = [1, -1, 0, 0, 1, 1, -1, -1];
const DY = [0, 0, 1, -1, 1, -1, 1, -1];

/**
 * 窪地を埋めて排水可能な地形にする。x 方向はラップ、y 方向は極で閉じる。
 * @returns {Float32Array} 埋め後の標高
 */
export function fillDepressions(elev, w, h, seaLevel = 0) {
  const n = w * h;
  const filled = new Float32Array(n);
  const done = new Uint8Array(n);
  const heap = new MinHeap(n, filled);

  for (let i = 0; i < n; i++) filled[i] = elev[i];

  // 海（および極の縁）を出口として初期化
  for (let i = 0; i < n; i++) {
    if (elev[i] <= seaLevel) {
      done[i] = 1;
      heap.push(i);
    }
  }
  for (let x = 0; x < w; x++) {
    for (const y of [0, h - 1]) {
      const i = y * w + x;
      if (!done[i]) { done[i] = 1; heap.push(i); }
    }
  }

  const EPS = 1e-5;
  while (heap.n > 0) {
    const i = heap.pop();
    const x = i % w, y = (i / w) | 0;
    for (let k = 0; k < 8; k++) {
      const ny = y + DY[k];
      if (ny < 0 || ny >= h) continue;
      const nx = (x + DX[k] + w) % w;
      const j = ny * w + nx;
      if (done[j]) continue;
      done[j] = 1;
      if (filled[j] <= filled[i]) filled[j] = filled[i] + EPS;
      heap.push(j);
    }
  }
  return filled;
}

/**
 * 流量集積。標高降順に水を下流へ渡す。
 * @returns {{flow: Float32Array, down: Int32Array}}
 */
export function accumulateFlow(filled, elev, w, h, rain, seaLevel = 0) {
  const n = w * h;
  const down = new Int32Array(n).fill(-1);
  const flow = new Float32Array(n);

  for (let i = 0; i < n; i++) {
    flow[i] = rain ? rain[i] : 1;
    if (elev[i] <= seaLevel) { flow[i] = 0; continue; }
    const x = i % w, y = (i / w) | 0;
    let best = -1, bestDrop = 0;
    const lower = [];
    for (let k = 0; k < 8; k++) {
      const ny = y + DY[k];
      if (ny < 0 || ny >= h) continue;
      const nx = (x + DX[k] + w) % w;
      const j = ny * w + nx;
      const drop = filled[i] - filled[j];
      if (drop <= 0) continue;
      lower.push(j);
      if (drop > bestDrop) { bestDrop = drop; best = j; }
    }
    // 埋めた窪地の上は勾配がほぼ均一で、そのままだと流路が走査順に沿って
    // 直線になる。落差が無視できるときは下流候補から擬似乱数で選ぶ。
    if (lower.length > 1 && bestDrop < 5e-5) {
      const hsh = (Math.imul(i ^ 0x85ebca6b, 2246822519) >>> 13) % lower.length;
      best = lower[hsh];
    }
    down[i] = best;
  }

  // 標高降順に処理すれば 1 パスで集積が完了する
  const order = new Int32Array(n);
  for (let i = 0; i < n; i++) order[i] = i;
  const arr = Array.from(order);
  arr.sort((a, b) => filled[b] - filled[a]);

  for (let k = 0; k < n; k++) {
    const i = arr[k];
    const d = down[i];
    if (d >= 0) flow[d] += flow[i];
  }
  return { flow, down };
}

/** 埋め量から湖を検出する */
export function detectLakes(filled, elev, w, h, seaLevel = 0, minDepth = 0.004) {
  const n = w * h;
  const lake = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    if (elev[i] > seaLevel && filled[i] - elev[i] > minDepth) lake[i] = 1;
  }
  return lake;
}
