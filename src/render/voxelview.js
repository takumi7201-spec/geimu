/**
 * 地表ボクセルビュー（3D ピクセル表示）。
 *
 * 高さマップ 1 枚を「柱の集まり」として描く。全ボクセルを持たずに
 *   ・柱の天面
 *   ・隣より高い分だけの側面（地層で色を変える）
 * だけを面にするので、数十万本の柱でも 1 枚のメッシュに収まる。
 *
 * ドット絵らしさは次の三つで作っている:
 *   1. 面ごとに単色（頂点色に陰影を焼き込む＝フラットシェーディング）
 *   2. 内部解像度を落として nearest 拡大（styles.css の image-rendering）
 *   3. 光源も色数も動かさない — 動くのは霧と水面だけ
 *
 * 遠景は 2 倍・4 倍のブロックにまとめて描く（LOD）。手前の 6m ブロックの
 * まま全域を描くと頂点が数千万になり、広さと引き換えに動かなくなる。
 */

import * as M from './glmat.js';
import { clamp } from '../core/rng.js';
import { BLOCK_COLORS, BLOCK_GLOW, B } from '../voxel/blocks.js';
import { WATER_NONE, strataFor } from '../voxel/scene.js';

const SOLID_VS = `
attribute vec3 aPos;
attribute vec4 aColor;
uniform mat4 uMVP;
uniform vec3 uCam;
varying vec4 vColor;
varying float vDist;
void main() {
  vColor = aColor;
  vDist = length(aPos - uCam);
  gl_Position = uMVP * vec4(aPos, 1.0);
}`;

const SOLID_FS = `
precision mediump float;
uniform vec3 uFog;
uniform vec2 uFogRange;
varying vec4 vColor;
varying float vDist;
void main() {
  // 霧は完全には塗りつぶさない。奥の山が輪郭を保つほうが広く見える
  float f = smoothstep(uFogRange.x, uFogRange.y, vDist) * 0.82;
  gl_FragColor = vec4(mix(vColor.rgb, uFog, f), 1.0);
}`;

const WATER_VS = `
attribute vec3 aPos;
attribute vec4 aColor;
uniform mat4 uMVP;
uniform vec3 uCam;
uniform float uTime;
varying vec4 vColor;
varying float vDist;
void main() {
  vec3 p = aPos;
  // さざなみ。振幅は 1/8 ブロックに抑える（大きくすると水際に隙間ができる）
  p.y += sin(p.x * 0.6 + uTime) * 0.06 + sin(p.z * 0.45 - uTime * 0.8) * 0.06;
  vColor = aColor;
  vDist = length(p - uCam);
  gl_Position = uMVP * vec4(p, 1.0);
}`;

const WATER_FS = `
precision mediump float;
uniform vec3 uFog;
uniform vec2 uFogRange;
varying vec4 vColor;
varying float vDist;
void main() {
  float f = smoothstep(uFogRange.x, uFogRange.y, vDist);
  gl_FragColor = vec4(mix(vColor.rgb, uFog, f), vColor.a * (1.0 - f * 0.6));
}`;

const SKY_VS = `
attribute vec2 aPos;
varying vec2 vUV;
void main() { vUV = aPos * 0.5 + 0.5; gl_Position = vec4(aPos, 0.999, 1.0); }`;

const SKY_FS = `
precision mediump float;
uniform vec3 uTop;
uniform vec3 uHorizon;
uniform float uHorizonY;
varying vec2 vUV;
void main() {
  // 地平線の位置に合わせて霞ませる。空だけ別に描くと遠景と色がつながらない
  float t = smoothstep(uHorizonY - 0.55, uHorizonY + 0.35, vUV.y);
  gl_FragColor = vec4(mix(uHorizon, uTop, t), 1.0);
}`;

function compile(gl, type, src) {
  const sh = gl.createShader(type);
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    throw new Error('シェーダのコンパイルに失敗: ' + gl.getShaderInfoLog(sh));
  }
  return sh;
}

function program(gl, vs, fs) {
  const p = gl.createProgram();
  gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, vs));
  gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
    throw new Error('シェーダのリンクに失敗: ' + gl.getProgramInfoLog(p));
  }
  const loc = new Proxy({}, {
    get: (cache, name) => {
      if (!(name in cache)) {
        cache[name] = name[0] === 'a' ? gl.getAttribLocation(p, name) : gl.getUniformLocation(p, name);
      }
      return cache[name];
    },
  });
  return { p, loc };
}

/** 位置 3 float + 色 4 byte を 1 本のバッファに詰めるビルダ（stride 16B） */
class MeshBuilder {
  constructor(cap = 1 << 16) {
    this._alloc(cap);
    this.count = 0;      // 頂点数
    this.icount = 0;     // インデックス数
  }
  _alloc(cap) {
    this.cap = cap;
    const buf = new ArrayBuffer(cap * 16);
    const f = new Float32Array(buf);
    // 色は Uint8Clamped で持つ。陰影を掛けた値が 255 を超えると、
    // 素の Uint8Array では 260 → 4 と巻き戻り、砂浜や岩が蛍光色になる
    const u = new Uint8ClampedArray(buf);
    if (this.buf) { u.set(new Uint8Array(this.buf, 0, this.count * 16)); }
    this.buf = buf; this.f = f; this.u = u;
    const idx = new Uint32Array(cap * 2);
    if (this.idx) idx.set(this.idx.subarray(0, this.icount));
    this.idx = idx;
  }
  _need(v) { if (this.count + v > this.cap) this._alloc(Math.max(this.cap * 2, this.count + v)); }
  _vert(x, y, z, r, g, b, a) {
    const i = this.count++;
    this.f[i * 4] = x; this.f[i * 4 + 1] = y; this.f[i * 4 + 2] = z;
    const o = i * 16 + 12;
    this.u[o] = r; this.u[o + 1] = g; this.u[o + 2] = b; this.u[o + 3] = a;
  }
  /** 反時計回りに 4 点を渡す */
  quad(p, r, g, b, a) {
    this._need(4);
    const base = this.count;
    for (let k = 0; k < 4; k++) this._vert(p[k * 3], p[k * 3 + 1], p[k * 3 + 2], r, g, b, a);
    const id = this.idx;
    id[this.icount++] = base; id[this.icount++] = base + 1; id[this.icount++] = base + 2;
    id[this.icount++] = base; id[this.icount++] = base + 2; id[this.icount++] = base + 3;
  }
}

// 面の向きごとの明るさ。太陽は北西の高い位置に固定する。
// 天面を 1.0 に正規化してあるので、掛けても色が飽和しない
const SUN = (() => { const v = [-0.42, 0.84, 0.34]; const l = Math.hypot(...v); return v.map((k) => k / l); })();
function rawShade(nx, ny, nz) {
  const d = Math.max(0, nx * SUN[0] + ny * SUN[1] + nz * SUN[2]);
  const sky = 0.42 + 0.20 * (ny * 0.5 + 0.5);   // 半球アンビエント
  return clamp(sky + d * 0.62, 0.28, 1.35);
}
const TOP_RAW = rawShade(0, 1, 0);
function faceShade(nx, ny, nz) { return rawShade(nx, ny, nz) / TOP_RAW; }
const SHADE_TOP = 1;
const SHADE_PX = faceShade(1, 0, 0), SHADE_NX = faceShade(-1, 0, 0);
const SHADE_PZ = faceShade(0, 0, 1), SHADE_NZ = faceShade(0, 0, -1);

/** 水中の色。深いほど青に沈める */
function submerge(c, depth) {
  const t = clamp(depth * 0.12, 0, 0.80);
  return [c[0] * (1 - t) + 22 * t, c[1] * (1 - t) + 58 * t, c[2] * (1 - t) + 104 * t];
}

export class VoxelRenderer {
  constructor(canvas, overlay) {
    this.canvas = canvas;
    this.overlay = overlay;
    this.octx = overlay ? overlay.getContext('2d') : null;
    this.scene = null;
    this.ok = false;
    this.error = null;
    this.layers = { water: true, plants: true, fauna: true, labels: true, fog: true };
    this.pixelSize = 3;                 // 内部解像度を何分の一にするか（ドットの粗さ）
    this.cam = { yaw: 0.9, pitch: -0.34, dist: 0, x: 0, y: 0, z: 0 };
    this.time = 0;
    this._initGL();
  }

  _initGL() {
    const opts = { antialias: false, alpha: false, depth: true, preserveDrawingBuffer: true };
    let gl = this.canvas.getContext('webgl2', opts);
    this.isGL2 = !!gl;
    if (!gl) {
      gl = this.canvas.getContext('webgl', opts) || this.canvas.getContext('experimental-webgl', opts);
      if (gl && !gl.getExtension('OES_element_index_uint')) {
        this.error = 'この環境の WebGL は 32bit インデックスに対応していません';
        return;
      }
    }
    if (!gl) { this.error = 'WebGL を初期化できませんでした'; return; }
    this.gl = gl;
    try {
      this.progSolid = program(gl, SOLID_VS, SOLID_FS);
      this.progWater = program(gl, WATER_VS, WATER_FS);
      this.progSky = program(gl, SKY_VS, SKY_FS);
    } catch (e) { this.error = e.message; return; }
    this.skyBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.skyBuf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    gl.enable(gl.DEPTH_TEST);
    gl.enable(gl.CULL_FACE);
    gl.cullFace(gl.BACK);
    this.ok = true;
  }

  setScene(scene) {
    if (!this.ok) return;
    this.scene = scene;
    this._build();
    this.resetCamera();
  }

  setLayer(k, v) {
    this.layers[k] = v;
    if (this.scene && (k === 'plants' || k === 'fauna')) this._build();
  }

  resetCamera() {
    const s = this.scene;
    if (!s) return;
    const c = s.total / 2;
    const i = (c | 0) * s.total + (c | 0);
    this.cam.x = c;
    this.cam.z = c;
    // 少し上を注視して、地平線と空が画面に入るようにする
    this.cam.y = Math.max(s.height[i], s.water[i] === WATER_NONE ? s.height[i] : s.water[i]) + 8;
    this.cam.dist = s.cols * 1.7;
    this.cam.yaw = 0.9;
    this.cam.pitch = -0.52;
  }

  // ---- メッシュ構築 ----------------------------------------------------

  _build() {
    const gl = this.gl, s = this.scene;
    const t0 = Date.now();
    const solid = new MeshBuilder(1 << 18);
    const water = new MeshBuilder(1 << 15);
    this._buildTerrain(solid, water);
    if (this.layers.plants) this._buildProps(solid, s.props, s.models, false);
    if (this.layers.fauna) this._buildProps(solid, s.fauna, s.models, true);

    const upload = (mb) => {
      const vb = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, vb);
      gl.bufferData(gl.ARRAY_BUFFER, new Uint8Array(mb.buf, 0, mb.count * 16), gl.STATIC_DRAW);
      const ib = gl.createBuffer();
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ib);
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, mb.idx.subarray(0, mb.icount), gl.STATIC_DRAW);
      return { vb, ib, count: mb.icount };
    };
    if (this.solid) { gl.deleteBuffer(this.solid.vb); gl.deleteBuffer(this.solid.ib); }
    if (this.water) { gl.deleteBuffer(this.water.vb); gl.deleteBuffer(this.water.ib); }
    this.solid = upload(solid);
    this.water = upload(water);
    this.stats = {
      quads: (solid.icount + water.icount) / 6,
      verts: solid.count + water.count,
      ms: Date.now() - t0,
    };
  }

  /** LOD 段ごとの代表高さ。s×s 本の柱を平均し、s の倍数に丸めて立方体を保つ */
  _tile(x, z, step) {
    const s = this.scene, T = s.total;
    if (x < 0 || z < 0 || x >= T || z >= T) return null;
    if (step === 1) {
      const i = z * T + x;
      return { h: s.height[i], surf: s.surf[i], sub: s.sub[i], water: s.water[i], i };
    }
    let sum = 0, cnt = 0, wl = WATER_NONE;
    for (let dz = 0; dz < step; dz++) {
      const zz = z + dz;
      if (zz >= T) break;
      for (let dx = 0; dx < step; dx++) {
        const xx = x + dx;
        if (xx >= T) break;
        const i = zz * T + xx;
        sum += s.height[i]; cnt++;
        if (s.water[i] !== WATER_NONE && s.water[i] > wl) wl = s.water[i];
      }
    }
    const ci = Math.min(T - 1, z + (step >> 1)) * T + Math.min(T - 1, x + (step >> 1));
    const avg = sum / Math.max(1, cnt);
    return {
      h: Math.round(avg / step) * step,
      surf: s.surf[ci], sub: s.sub[ci],
      water: wl === WATER_NONE ? WATER_NONE : Math.round(wl / step) * step,
      i: ci,
    };
  }

  _buildTerrain(mb, wb) {
    const s = this.scene, T = s.total, C = T / 2, cols = s.cols;
    // LOD 段：中心 cols 四方は 1、その外側は 2、いちばん外は 4 ブロック単位
    const bandOf = (x, z) => {
      const d = Math.max(Math.abs(x + 0.5 - C), Math.abs(z + 0.5 - C));
      if (d <= cols / 2) return 1;
      if (d <= cols) return 2;
      return 4;
    };
    const seen = new Uint8Array(T * T);

    for (let z = 0; z < T; z++) {
      for (let x = 0; x < T; x++) {
        if (seen[z * T + x]) continue;
        const step = bandOf(x, z);
        // 段の境界でタイルが半端にならないよう、格子に合わせて始点をそろえる
        const x0 = x - (x % step), z0 = z - (z % step);
        if (x0 !== x || z0 !== z) { seen[z * T + x] = 1; continue; }
        for (let dz = 0; dz < step; dz++)
          for (let dx = 0; dx < step; dx++) {
            const zz = z0 + dz, xx = x0 + dx;
            if (xx < T && zz < T) seen[zz * T + xx] = 1;
          }
        const t = this._tile(x0, z0, step);
        if (!t) continue;
        this._emitColumn(mb, wb, x0, z0, step, t);
      }
    }
  }

  _emitColumn(mb, wb, x, z, step, t) {
    const s = this.scene, T = s.total;
    const h = t.h;
    const x1 = x + step, z1 = z + step;
    const wl = t.water;
    const submerged = wl !== WATER_NONE && wl > h;

    // --- 天面 ---
    let col = BLOCK_COLORS[t.surf];
    if (submerged) col = submerge(col, wl - h);
    // 隣が高いほど暗くする（谷底と崖の足元が沈んで立体に見える）
    const nb = [
      this._tile(x - step, z, step), this._tile(x + step, z, step),
      this._tile(x, z - step, step), this._tile(x, z + step, step),
    ];
    let occ = 0;
    for (const q of nb) if (q) occ += clamp((q.h - h) / (step * 6), 0, 1);
    const ao = 1 - clamp(occ * 0.12, 0, 0.34);
    const jitter = 1 + (((Math.imul((z * T + x) ^ 0x9e3779b9, 0x85ebca6b) >>> 24) & 15) - 7) * 0.006;
    const k = SHADE_TOP * ao * jitter * (BLOCK_GLOW[t.surf] ? 1.6 : 1);
    mb.quad([x, h, z, x, h, z1, x1, h, z1, x1, h, z], col[0] * k, col[1] * k, col[2] * k, 255);

    // --- 側面 ---
    const sides = [
      { n: nb[0], sx: x, sz: z, ex: x, ez: z1, shade: SHADE_NX, flip: false },
      { n: nb[1], sx: x1, sz: z1, ex: x1, ez: z, shade: SHADE_PX, flip: false },
      { n: nb[2], sx: x1, sz: z, ex: x, ez: z, shade: SHADE_NZ, flip: false },
      { n: nb[3], sx: x, sz: z1, ex: x1, ez: z1, shade: SHADE_PZ, flip: false },
    ];
    for (const side of sides) {
      // 隣が無い（区画の外）なら底まで壁を作る。LOD 境界では丸めの差で
      // 隙間が空くことがあるので、余分に step 分だけ下へ伸ばす
      let hn = side.n ? side.n.h - step : h - 8 * step;
      if (hn >= h) continue;
      const bottom = Math.max(hn, h - 96);       // 深部は見えないので打ち切る
      let y = h;
      while (y > bottom) {
        const depth = h - y;
        // 地表直下は土、そこから下は地層。地層は y だけの関数なので崖で横につながる
        const blk = depth < 1 ? t.surf : depth < 3 ? t.sub : strataFor(s, y - 1);
        let run = 1;
        while (y - run > bottom && run < 12) {
          const d2 = h - (y - run);
          const b2 = d2 < 1 ? t.surf : d2 < 3 ? t.sub : strataFor(s, y - run - 1);
          if (b2 !== blk) break;
          run++;
        }
        let c = BLOCK_COLORS[blk];
        if (submerged) c = submerge(c, wl - (y - run));
        const kk = side.shade * (1 + (((y * 2654435761) >>> 28) - 8) * 0.004);
        const yb = y - run;
        mb.quad([side.sx, yb, side.sz, side.ex, yb, side.ez, side.ex, y, side.ez, side.sx, y, side.sz],
          c[0] * kk, c[1] * kk, c[2] * kk, 255);
        y -= run;
      }
      if (bottom > hn) {
        // 打ち切った下は 1 枚の岩でふさぐ
        const c = BLOCK_COLORS[B.rockDark];
        mb.quad([side.sx, hn, side.sz, side.ex, hn, side.ez, side.ex, bottom, side.ez, side.sx, bottom, side.sz],
          c[0] * side.shade, c[1] * side.shade, c[2] * side.shade, 255);
      }
    }

    // --- 水面 ---
    if (this.layers.water && submerged) {
      const depth = wl - h;
      const shallow = [86, 158, 178], deep = [22, 56, 110];
      const m = clamp(depth / 14, 0, 1);
      const c = [
        shallow[0] + (deep[0] - shallow[0]) * m,
        shallow[1] + (deep[1] - shallow[1]) * m,
        shallow[2] + (deep[2] - shallow[2]) * m,
      ];
      // 浅くても水は水として見えるだけの濃さを持たせる。
      // 透けすぎると海底のブロックがそのまま見えて、水に見えなくなる
      const a = 196 + 52 * m;
      const kw = SHADE_TOP;
      wb.quad([x, wl, z, x, wl, z1, x1, wl, z1, x1, wl, z], c[0] * kw, c[1] * kw, c[2] * kw, a);
      // 隣に水が無ければ側面を張る（滝や河岸の段差が抜けて見えるのを防ぐ）
      const wsides = [
        { n: nb[0], sx: x, sz: z, ex: x, ez: z1, shade: SHADE_NX },
        { n: nb[1], sx: x1, sz: z1, ex: x1, ez: z, shade: SHADE_PX },
        { n: nb[2], sx: x1, sz: z, ex: x, ez: z, shade: SHADE_NZ },
        { n: nb[3], sx: x, sz: z1, ex: x1, ez: z1, shade: SHADE_PZ },
      ];
      for (const w2 of wsides) {
        const q = w2.n;
        const nwl = q ? (q.water !== WATER_NONE ? Math.max(q.water, q.h) : q.h) : wl - 2;
        if (nwl >= wl) continue;
        const yb = Math.max(nwl, h);
        if (yb >= wl) continue;
        wb.quad([w2.sx, yb, w2.sz, w2.ex, yb, w2.ez, w2.ex, wl, w2.ez, w2.sx, wl, w2.sz],
          c[0] * w2.shade, c[1] * w2.shade, c[2] * w2.shade, a);
      }
    }
  }

  /** 植物・動物のモデルを箱として展開する */
  _buildProps(mb, list, models, animated) {
    for (const p of list) {
      const model = models[p.m];
      const unit = model.unit * (p.scale || 1);
      const yaw = animated ? (p.yaw || 0) : (p.rot || 0) * (Math.PI / 2);
      const cs = Math.cos(yaw), sn = Math.sin(yaw);
      const ox = p.x + 0.5, oz = p.z + 0.5, oy = p.y;
      for (const b of model.boxes) {
        const c = BLOCK_COLORS[b.b];
        const x0 = b.x * unit, x1 = (b.x + b.w) * unit;
        const z0 = b.z * unit, z1 = (b.z + b.d) * unit;
        const y0 = oy + b.y * unit, y1 = oy + (b.y + b.h) * unit;
        // yaw で回した 4 隅（上から見た矩形）
        const P = (lx, lz) => [ox + lx * cs - lz * sn, oz + lx * sn + lz * cs];
        const a = P(x0, z0), b2 = P(x1, z0), c2 = P(x1, z1), d2 = P(x0, z1);
        const face = (pts, nx, ny, nz) => {
          const k = faceShade(nx, ny, nz) * (BLOCK_GLOW[b.b] ? 1.5 : 1);
          mb.quad(pts, c[0] * k, c[1] * k, c[2] * k, 255);
        };
        face([a[0], y1, a[1], d2[0], y1, d2[1], c2[0], y1, c2[1], b2[0], y1, b2[1]], 0, 1, 0);
        face([a[0], y0, a[1], b2[0], y0, b2[1], c2[0], y0, c2[1], d2[0], y0, d2[1]], 0, -1, 0);
        face([a[0], y0, a[1], d2[0], y0, d2[1], d2[0], y1, d2[1], a[0], y1, a[1]], -cs, 0, -sn);
        face([b2[0], y0, b2[1], b2[0], y1, b2[1], c2[0], y1, c2[1], c2[0], y0, c2[1]], cs, 0, sn);
        face([a[0], y0, a[1], a[0], y1, a[1], b2[0], y1, b2[1], b2[0], y0, b2[1]], sn, 0, -cs);
        face([d2[0], y0, d2[1], c2[0], y0, c2[1], c2[0], y1, c2[1], d2[0], y1, d2[1]], -sn, 0, cs);
      }
    }
  }

  // ---- 視点 ------------------------------------------------------------

  rotate(dx, dy) {
    this.cam.yaw -= dx * 0.005;
    this.cam.pitch = clamp(this.cam.pitch + dy * 0.004, -1.35, 0.35);
  }
  zoom(f) {
    const s = this.scene;
    this.cam.dist = clamp(this.cam.dist / f, 6, s ? s.total * 0.9 : 400);
  }
  /** 視線方向に focus を動かす（前後左右の移動） */
  move(fwd, side) {
    const s = this.scene;
    if (!s) return;
    const c = Math.cos(this.cam.yaw), sn = Math.sin(this.cam.yaw);
    const step = Math.max(2, this.cam.dist * 0.06);
    this.cam.x = clamp(this.cam.x + (-sn * fwd + c * side) * step, 0, s.total);
    this.cam.z = clamp(this.cam.z + (-c * fwd - sn * side) * step, 0, s.total);
    const i = (clamp(Math.round(this.cam.z), 0, s.total - 1) | 0) * s.total + (clamp(Math.round(this.cam.x), 0, s.total - 1) | 0);
    const wl = s.water[i];
    this.cam.y = Math.max(s.height[i], wl === WATER_NONE ? s.height[i] : wl) + 8;
  }

  _eye() {
    const { yaw, pitch, dist, x, y, z } = this.cam;
    const cp = Math.cos(pitch);
    return [
      x + Math.sin(yaw) * cp * dist,
      y - Math.sin(pitch) * dist,
      z + Math.cos(yaw) * cp * dist,
    ];
  }

  _matrices() {
    const aspect = this.canvas.width / this.canvas.height;
    const far = Math.max(400, (this.scene ? this.scene.total : 400) * 2.2);
    const proj = M.perspective((52 * Math.PI) / 180, aspect, 0.5, far);
    const eye = this._eye();
    // 注視点へ向けるビュー行列（yaw/pitch から直接組む）
    const view = M.multiply(
      M.multiply(M.rotationX(-this.cam.pitch), M.rotationY(-this.cam.yaw)),
      M.translation(-eye[0], -eye[1], -eye[2]),
    );
    return { mvp: M.multiply(proj, view), eye, view, proj };
  }

  /** 画面座標 → 地表の列。高さマップを直接レイマーチする */
  pick(sx, sy) {
    const s = this.scene;
    if (!s) return null;
    const aspect = this.canvas.width / this.canvas.height;
    const f = Math.tan((52 * Math.PI) / 180 / 2);
    const ndcX = (sx / this.canvas.width) * 2 - 1;
    const ndcY = 1 - (sy / this.canvas.height) * 2;
    const cy = Math.cos(this.cam.pitch), sy2 = Math.sin(this.cam.pitch);
    const cyaw = Math.cos(this.cam.yaw), syaw = Math.sin(this.cam.yaw);
    // ビュー空間のレイをワールドへ回す
    let d = [ndcX * f * aspect, ndcY * f, -1];
    let v = [d[0], d[1] * cy - d[2] * sy2, d[1] * sy2 + d[2] * cy];
    v = [v[0] * cyaw + v[2] * syaw, v[1], -v[0] * syaw + v[2] * cyaw];
    const len = Math.hypot(...v);
    v = v.map((k) => k / len);
    const eye = this._eye();
    const maxT = s.total * 2.2;
    for (let t = 0.5; t < maxT; t += Math.max(0.35, t * 0.004)) {
      const px = eye[0] + v[0] * t, py = eye[1] + v[1] * t, pz = eye[2] + v[2] * t;
      if (px < 0 || pz < 0 || px >= s.total || pz >= s.total) {
        if (py < -60) return null;
        continue;
      }
      const i = (pz | 0) * s.total + (px | 0);
      const wl = s.water[i];
      const top = wl !== WATER_NONE && wl > s.height[i] ? wl : s.height[i];
      if (py <= top) return { x: px | 0, z: pz | 0, i, y: top };
    }
    return null;
  }

  /** 画面座標へ投影（ラベル用）。カメラの後ろなら null */
  project(x, y, z) {
    const { mvp } = this._matrices();
    const cw = mvp[3] * x + mvp[7] * y + mvp[11] * z + mvp[15];
    if (cw <= 0.001) return null;
    const cx = mvp[0] * x + mvp[4] * y + mvp[8] * z + mvp[12];
    const cyy = mvp[1] * x + mvp[5] * y + mvp[9] * z + mvp[13];
    return {
      x: ((cx / cw) * 0.5 + 0.5) * this.canvas.width,
      y: (0.5 - (cyy / cw) * 0.5) * this.canvas.height,
      w: cw,
    };
  }

  // ---- 描画 ------------------------------------------------------------

  render(dt = 16) {
    if (!this.ok || !this.scene) return;
    const gl = this.gl;
    this.time += dt * 0.001;
    const s = this.scene;
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.enable(gl.DEPTH_TEST);
    gl.depthMask(true);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

    const { mvp, eye } = this._matrices();
    const fog = this.fogColor();
    const extent = s.total;
    const fogRange = this.layers.fog
      ? [extent * 0.42, extent * 1.30]
      : [extent * 4, extent * 8];

    // 1. 空（深度は書かない）
    {
      const { p, loc } = this.progSky;
      gl.useProgram(p);
      gl.depthMask(false);
      gl.disable(gl.BLEND);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.skyBuf);
      gl.enableVertexAttribArray(loc.aPos);
      gl.vertexAttribPointer(loc.aPos, 2, gl.FLOAT, false, 0, 0);
      gl.uniform3fv(loc.uTop, this.skyTop());
      gl.uniform3fv(loc.uHorizon, fog);
      // 地平線の画面上の高さ（俯角が深いほど上に来る）
      gl.uniform1f(loc.uHorizonY, 0.5 + this.cam.pitch * 0.62);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      gl.depthMask(true);
    }

    const bind = (prog, mesh) => {
      const { p, loc } = prog;
      gl.useProgram(p);
      gl.bindBuffer(gl.ARRAY_BUFFER, mesh.vb);
      gl.enableVertexAttribArray(loc.aPos);
      gl.vertexAttribPointer(loc.aPos, 3, gl.FLOAT, false, 16, 0);
      gl.enableVertexAttribArray(loc.aColor);
      gl.vertexAttribPointer(loc.aColor, 4, gl.UNSIGNED_BYTE, true, 16, 12);
      gl.uniformMatrix4fv(loc.uMVP, false, mvp);
      gl.uniform3fv(loc.uCam, eye);
      gl.uniform3fv(loc.uFog, fog);
      gl.uniform2fv(loc.uFogRange, fogRange);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, mesh.ib);
      return loc;
    };

    // 2. 地形・植物・動物（不透明）
    gl.disable(gl.BLEND);
    bind(this.progSolid, this.solid);
    gl.drawElements(gl.TRIANGLES, this.solid.count, gl.UNSIGNED_INT, 0);

    // 3. 水面（半透明。深度は書かない — 戻し忘れると次のフレームが真っ黒になる）
    if (this.layers.water && this.water.count) {
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      gl.depthMask(false);
      gl.disable(gl.CULL_FACE);
      const loc = bind(this.progWater, this.water);
      gl.uniform1f(loc.uTime, this.time);
      gl.drawElements(gl.TRIANGLES, this.water.count, gl.UNSIGNED_INT, 0);
      gl.enable(gl.CULL_FACE);
      gl.depthMask(true);
      gl.disable(gl.BLEND);
    }

    this._drawOverlay();
  }

  /** 霧＝地平線の色。紀ごとの色味を少しだけ混ぜる */
  fogColor() {
    const s = this.scene;
    const base = [0.66, 0.73, 0.80];
    if (!s) return base;
    const warm = clamp(((s.meta.tempC ?? 20) - 8) / 26, 0, 1);
    return [base[0] * (0.92 + warm * 0.14), base[1] * (0.94 + warm * 0.06), base[2] * (1.02 - warm * 0.10)];
  }
  skyTop() {
    const f = this.fogColor();
    return [f[0] * 0.42, f[1] * 0.62, f[2] * 0.95];
  }

  _drawOverlay() {
    const ctx = this.octx;
    if (!ctx) return;
    const W = this.overlay.width, H = this.overlay.height;
    ctx.clearRect(0, 0, W, H);
    if (!this.layers.labels || !this.scene) return;
    const sx = W / this.canvas.width, sy = H / this.canvas.height;
    const drawn = [];
    const seenName = new Set();
    for (const f of this.scene.fauna) {
      // 同じ種の名前を何度も出さない。群れの上に同じ札が並ぶと読めなくなる
      if (seenName.has(f.name) || drawn.length >= 6) continue;
      const model = this.scene.models[f.m];
      const top = f.y + 6 * model.unit * (f.scale || 1);
      const p = this.project(f.x + 0.5, top, f.z + 0.5);
      if (!p || p.w > this.scene.total * 0.8) continue;
      const px = p.x * sx, py = p.y * sy;
      if (px < 0 || py < 0 || px > W || py > H) continue;
      if (drawn.some((q) => Math.abs(q.x - px) < 150 && Math.abs(q.y - py) < 26)) continue;
      drawn.push({ x: px, y: py });
      seenName.add(f.name);
      const size = clamp(1400 / p.w, 11, 20);
      ctx.font = `600 ${size}px "Hiragino Sans", "Noto Sans JP", system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'bottom';
      ctx.lineWidth = 3.2;
      ctx.strokeStyle = 'rgba(6,10,20,0.78)';
      ctx.strokeText(f.name, px, py);
      ctx.fillStyle = 'rgba(255,246,226,0.95)';
      ctx.fillText(f.name, px, py);
    }
  }
}
