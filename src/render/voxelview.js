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
import { BLOCK_COLORS, BLOCK_GLOW, B, VOX_M } from '../voxel/blocks.js';
import { WATER_NONE, strataFor } from '../voxel/scene.js';
import { sprite } from '../voxel/sprites.js';
import { SPRITE_FALLBACK } from '../voxel/models.js';

/** 絵が無い種別は近い体つきの絵で代用する（10 枚揃っていなくても動物を消さない） */
function spriteKey(key) {
  if (!key) return null;
  if (sprite(key)) return key;
  const alt = SPRITE_FALLBACK[key];
  return alt && sprite(alt) ? alt : null;
}

// 影を焼くパス。色は要らないので位置だけ通す
const DEPTH_VS = `
attribute vec3 aPos;
uniform mat4 uMVP;
void main() { gl_Position = uMVP * vec4(aPos, 1.0); }`;

const DEPTH_FS = `
precision mediump float;
void main() {}`;

// 板の影。カメラ向きのまま焼くと、見る角度で地面の影の形が変わってしまうので、
// 焼くときだけは日の方を向かせる（絵のシルエットがそのまま影になる）
const DEPTH_SPRITE_VS = `
attribute vec3 aCenter;
attribute vec2 aCorner;
attribute vec2 aUV;
uniform mat4 uMVP;
uniform vec3 uSun;
varying vec2 vUV;
void main() {
  vec2 to = uSun.xz;
  float len = length(to);
  vec2 right = len > 0.001 ? vec2(-to.y, to.x) / len : vec2(1.0, 0.0);
  vec3 p = vec3(aCenter.x + right.x * aCorner.x, aCenter.y + aCorner.y, aCenter.z + right.y * aCorner.x);
  vUV = aUV;
  gl_Position = uMVP * vec4(p, 1.0);
}`;

const DEPTH_SPRITE_FS = `
precision mediump float;
uniform sampler2D uTex;
varying vec2 vUV;
void main() { if (texture2D(uTex, vUV).a < 0.5) discard; }`;

// 影を受ける側で共有する断片。日なたなら 1、影なら 0 を返す
const SHADOW_FN = `
uniform sampler2D uShadowMap;
uniform vec2 uShadowTexel;
uniform float uShadowOn;
varying vec4 vShadow;
float sunlight() {
  if (uShadowOn < 0.5) return 1.0;
  vec3 p = vShadow.xyz / vShadow.w * 0.5 + 0.5;
  if (p.x < 0.0 || p.x > 1.0 || p.y < 0.0 || p.y > 1.0 || p.z > 1.0) return 1.0;
  // 焼いた範囲の縁では影を薄めていく。切り落とすと、そこに見えない壁が立つ
  float edge = min(min(p.x, 1.0 - p.x), min(p.y, 1.0 - p.y));
  float fade = smoothstep(0.0, 0.07, edge);
  if (fade <= 0.0) return 1.0;
  // 一点だけ引く。ドットの世界では影の縁が硬いほうが馴染むうえ、
  // 3x3 の PCF はフラグメントの負荷が 9 倍になり、ここが一番効く
  float d = texture2D(uShadowMap, p.xy).r;
  // バイアスを削りすぎると自分の影で縞（アクネ）が出る
  float lit = p.z - 0.0026 > d ? 0.0 : 1.0;
  return mix(1.0, lit, fade);
}`;

const SOLID_VS = `
attribute vec3 aPos;
attribute vec4 aColor;
uniform mat4 uMVP;
uniform mat4 uLightMVP;
uniform vec3 uCam;
varying vec4 vColor;
varying float vDist;
varying vec4 vShadow;
void main() {
  vColor = aColor;
  vDist = length(aPos - uCam);
  vShadow = uLightMVP * vec4(aPos, 1.0);
  gl_Position = uMVP * vec4(aPos, 1.0);
}`;

const SOLID_FS = `
precision mediump float;
uniform vec3 uFog;
uniform vec2 uFogRange;
varying vec4 vColor;
varying float vDist;
` + SHADOW_FN + `
void main() {
  // 影は真っ黒にしない。空からの回り込みが残るので、暗くして青に寄せるだけ
  vec3 c = mix(vColor.rgb * vec3(0.52, 0.57, 0.72), vColor.rgb, sunlight());
  // 霧は完全には塗りつぶさない。奥の山が輪郭を保つほうが広く見える
  float f = smoothstep(uFogRange.x, uFogRange.y, vDist) * 0.82;
  gl_FragColor = vec4(mix(c, uFog, f), 1.0);
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

// 動物はドット絵の板で立てる。Y 軸まわりだけカメラへ向け、上方向は世界の上に固定する
// （完全なビルボードにすると見上げたとき絵が寝てしまい、地面から生えたように見える）。
const SPRITE_VS = `
attribute vec3 aCenter;
attribute vec2 aCorner;
attribute vec2 aUV;
uniform mat4 uMVP;
uniform mat4 uLightMVP;
uniform vec3 uCam;
varying vec2 vUV;
varying float vDist;
varying vec4 vShadow;
void main() {
  vec2 to = aCenter.xz - uCam.xz;
  float len = length(to);
  // 真上から覗いたときは向きが決まらないので、そのときだけ X 軸で代用する
  vec2 right = len > 0.001 ? vec2(-to.y, to.x) / len : vec2(1.0, 0.0);
  vec3 p = vec3(aCenter.x + right.x * aCorner.x, aCenter.y + aCorner.y, aCenter.z + right.y * aCorner.x);
  vUV = aUV;
  vDist = length(p - uCam);
  vShadow = uLightMVP * vec4(p, 1.0);
  gl_Position = uMVP * vec4(p, 1.0);
}`;

const SPRITE_FS = `
precision mediump float;
uniform sampler2D uTex;
uniform vec3 uFog;
uniform vec2 uFogRange;
varying vec2 vUV;
varying float vDist;
` + SHADOW_FN + `
void main() {
  vec4 c = texture2D(uTex, vUV);
  // ドット絵の抜きは捨てる。半透明で混ぜると板の矩形が深度に残り、
  // 後ろの地形が四角く欠ける
  if (c.a < 0.5) discard;
  vec3 col = mix(c.rgb * vec3(0.52, 0.57, 0.72), c.rgb, sunlight());
  float f = smoothstep(uFogRange.x, uFogRange.y, vDist) * 0.82;
  gl_FragColor = vec4(mix(col, uFog, f), 1.0);
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
/** 板の最小の幅（ブロック）。これ未満の種はこの大きさで描く */
const SPRITE_MIN_W = 2.0;

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
    this.layers = { water: true, plants: true, fauna: true, shadow: true, labels: true, fog: true };
    this.pixelSize = 3;                 // 内部解像度を何分の一にするか（ドットの粗さ）
    // dist > 0 は俯瞰（注視点まわりの周回）、dist = 0 は一人称。
    // 一人称では cam.x/y/z が目の位置そのものになる
    this.cam = { yaw: 0.9, pitch: -0.34, dist: 0, x: 0, y: 0, z: 0 };
    this.firstPerson = false;
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
    this.gl2 = typeof WebGL2RenderingContext !== 'undefined' && gl instanceof WebGL2RenderingContext;
    try {
      this.progSolid = program(gl, SOLID_VS, SOLID_FS);
      this.progWater = program(gl, WATER_VS, WATER_FS);
      this.progSky = program(gl, SKY_VS, SKY_FS);
      this.progSprite = program(gl, SPRITE_VS, SPRITE_FS);
      this.progDepth = program(gl, DEPTH_VS, DEPTH_FS);
      this.progDepthSprite = program(gl, DEPTH_SPRITE_VS, DEPTH_SPRITE_FS);
    } catch (e) { this.error = e.message; return; }
    this.skyBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.skyBuf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    gl.enable(gl.DEPTH_TEST);
    gl.enable(gl.CULL_FACE);
    gl.cullFace(gl.BACK);
    this._initShadow();
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
    if (this.scene && (k === 'plants' || k === 'fauna')) this._build();   // 影は焼き直すだけなので組み直さない
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
    this._buildSprites();          // 動物は板なので solid のメッシュには混ぜない

    const upload = (mb) => {
      const vb = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, vb);
      gl.bufferData(gl.ARRAY_BUFFER, new Uint8Array(mb.buf, 0, mb.count * 16), gl.STATIC_DRAW);
      const ib = gl.createBuffer();
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ib);
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, mb.idx.subarray(0, mb.icount), gl.STATIC_DRAW);
      return { vb, ib, count: mb.icount };
    };
    // 古いバッファを消す前に、頂点属性の列を全部外す。消えたバッファを指したままの
    // 列が残ると、次の描画がまるごと INVALID_OPERATION で落ちる（絵は出るが
    // GL のエラーが立ち、以降の検証がすべて汚れる）
    for (let a = 0; a < 8; a++) gl.disableVertexAttribArray(a);
    if (this.solid) { gl.deleteBuffer(this.solid.vb); gl.deleteBuffer(this.solid.ib); }
    if (this.water) { gl.deleteBuffer(this.water.vb); gl.deleteBuffer(this.water.ib); }
    this._shadowMVP = null;   // 地形が変わったので焼き直す
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

  /**
   * 動物の板。1 体 = 2 三角形で、回転は頂点ではなくシェーダが持つ。
   * 絵を替えても頂点は変わらないので、アップロードは区画ごとに一度で済む。
   */
  _buildSprites() {
    const gl = this.gl, s = this.scene;
    if (this.spriteMesh) { gl.deleteBuffer(this.spriteMesh.vb); this.spriteMesh = null; }
    const list = [];
    if (this.layers.fauna) {
      for (const f of s.fauna) {
        const k = spriteKey(f.sprite);
        if (k) list.push({ f, k });
      }
    }
    if (!list.length) return;

    // 使う絵だけを横に並べて 1 枚に。体ごとにテクスチャを持ち替えずに済む
    const keys = [...new Set(list.map((e) => e.k))];
    const slot = {};
    let AW = 0, AH = 0;
    for (const k of keys) {
      const sp = sprite(k);
      slot[k] = { x: AW, w: sp.w, h: sp.h };
      AW += sp.w; AH = Math.max(AH, sp.h);
    }
    const atlas = new Uint8Array(AW * AH * 4);
    for (const k of keys) {
      const sp = sprite(k), o = slot[k];
      for (let y = 0; y < sp.h; y++) {
        for (let x = 0; x < sp.w; x++) {
          const si = (y * sp.w + x) * 4, di = (y * AW + o.x + x) * 4;
          atlas[di] = sp.data[si]; atlas[di + 1] = sp.data[si + 1];
          atlas[di + 2] = sp.data[si + 2]; atlas[di + 3] = sp.data[si + 3];
        }
      }
    }
    if (!this.spriteTex) this.spriteTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.spriteTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, AW, AH, 0, gl.RGBA, gl.UNSIGNED_BYTE, atlas);
    // ドット絵なので最近傍で拡大する。線形だと輪郭がにじんで別の絵になる
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    // 位置も向きも毎フレーム変わるので、器だけ作って中身は _updateSprites が書く
    this.spriteList = list.map((e) => ({ ...e, slot: slot[e.k], sp: sprite(e.k) }));
    this.spriteData = new Float32Array(list.length * 6 * 7);
    this.spriteUV = { AW, AH };
    const vb = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vb);
    gl.bufferData(gl.ARRAY_BUFFER, this.spriteData.byteLength, gl.DYNAMIC_DRAW);
    this.spriteMesh = { vb, count: list.length * 6 };
    this._updateSprites();
  }

  /**
   * 動物の板を今の姿に書き換える。絵は 1 枚なので、動きは
   *   ・上下の揺れ（歩幅）
   *   ・前傾（走り）
   *   ・前への踏み込み（噛みつき）
   * の三つで作る。位相 phase はゲーム層が速度に比例して進めている。
   */
  _updateSprites() {
    if (!this.spriteMesh || !this.spriteList) return;
    const gl = this.gl;
    const F = this.spriteData;
    const { AW, AH } = this.spriteUV;
    const eye = this._eye();
    let o = 0;

    for (const { f, sp, slot: st } of this.spriteList) {
      // 絵の横幅がその種の全長。ただし 1 ブロック（6m）は木立の中では数画素にしかならず、
      // 6m の獣脚類が背景に沈む。小さい種にだけ下限を置いて、大きい種は実寸のままにする
      // （下限を上げるのではなく倍率を掛けると、竜脚類が区画からはみ出す）
      const wB = Math.max(SPRITE_MIN_W, f.size / VOX_M);
      const hB = wB * (sp.h / sp.w), hw = wB / 2;

      const state = f.state || 'idle';
      const ph = f.phase || 0;
      let bob = 0, lean = 0, lunge = 0, squash = 0;
      if (state === 'walk') {
        bob = Math.sin(ph * 2) * hB * 0.045;
        lean = Math.sin(ph) * 0.05;
      } else if (state === 'run') {
        bob = Math.sin(ph * 2) * hB * 0.085;
        lean = 0.17 + Math.sin(ph * 2) * 0.06;
      } else if (state === 'attack') {
        // 噛みつきは、沈んでから前へ出る
        const t = Math.min(1, (f.lunge || 0) / 1.1);
        const k = Math.sin(t * Math.PI);
        lunge = k * wB * 0.42;
        lean = 0.28 * k;
        squash = -0.10 * k;
      } else {
        bob = Math.sin(ph * 0.7) * hB * 0.012;   // 息づかい
        squash = Math.sin(ph * 0.7) * 0.012;
      }
      if (f.flying) { bob += Math.sin(ph * 1.5) * hB * 0.10; lean = Math.sin(ph * 1.5) * 0.10; }
      if (f.swimming) { lean = Math.sin(ph) * 0.13; }

      // 板の右方向（シェーダと同じ向き）と進む向きの内積で、絵を裏返すか決める。
      // これをしないと、右へ歩いても左向きの絵のまま後ずさりして見える
      const cxw = f.x + 0.5, czw = f.z + 0.5;
      const tox = cxw - eye[0], toz = czw - eye[2];
      const tl = Math.hypot(tox, toz) || 1;
      const rx = -toz / tl, rz = tox / tl;
      const facing = Math.cos(f.yaw) * rx + Math.sin(f.yaw) * rz;
      const flip = facing < 0;

      const cx = cxw + Math.cos(f.yaw) * lunge;
      const cz = czw + Math.sin(f.yaw) * lunge;
      const cy = f.y + bob;

      let u0 = st.x / AW, u1 = (st.x + sp.w) / AW;
      if (flip) { const t = u0; u0 = u1; u1 = t; }
      const v1 = sp.h / AH;

      // 足元を軸に傾ける。進む向きが画面の左右どちらかで倒れる側も変わる
      const L = flip ? -lean : lean;
      const cs = Math.cos(L), sn = Math.sin(L);
      const top = hB * (1 + squash);
      const put = (dx, dy, u, v) => {
        F[o++] = cx; F[o++] = cy; F[o++] = cz;
        F[o++] = dx * cs - dy * sn;
        F[o++] = dx * sn + dy * cs;
        F[o++] = u; F[o++] = v;
      };
      put(-hw, 0, u0, v1); put(hw, 0, u1, v1); put(hw, top, u1, 0);
      put(-hw, 0, u0, v1); put(hw, top, u1, 0); put(-hw, top, u0, 0);
    }

    gl.bindBuffer(gl.ARRAY_BUFFER, this.spriteMesh.vb);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, F);
  }

  /**
   * 俯瞰のカメラを対象へ寄せる。区画全体を見る縮尺のままだと 6m の獣脚類は
   * 数画素なので、注視点だけでなく距離も詰める。
   */
  followTarget(x, y, z, dt, near = 20) {
    if (!this.ok || this.firstPerson) return;
    const k = 1 - Math.exp(-dt * 3.5);
    this.cam.x += (x - this.cam.x) * k;
    // 相手と同じ高さに置くと、森のなかでは幹と樹冠の中に潜り込んで緑一色になる。
    // 樹冠より上から見下ろす。ただし真上に立つと板が線になるので 30 度ほどに留める
    this.cam.y += (y + 5 - this.cam.y) * k;
    this.cam.z += (z - this.cam.z) * k;
    this.cam.dist += (near - this.cam.dist) * k;
    this.cam.pitch += (-0.58 - this.cam.pitch) * k;
    // 森のなかでは、寄っただけでは幹と樹冠に隠れる。塞がれていたらその手前まで詰める
    const clear = this._clearDist(this.cam.dist);
    if (clear < this.cam.dist) this.cam.dist = Math.max(4, clear);
  }

  /**
   * 注視点からカメラの向きへ、地形にぶつからずに下がれる距離。
   * 三人称のカメラが壁にめり込むのを防ぐのと同じ理屈で、
   * 手前に何かあるならそこまでしか下がらない。
   */
  _clearDist(want) {
    const s = this.scene;
    if (!s) return want;
    const { yaw, pitch, x, y, z } = this.cam;
    const cp = Math.cos(pitch);
    const dx = Math.sin(yaw) * cp, dy = -Math.sin(pitch), dz = Math.cos(yaw) * cp;
    const T = s.total;
    for (let t = 1.5; t < want; t += 0.6) {
      const px = x + dx * t, py = y + dy * t, pz = z + dz * t;
      if (px < 0 || pz < 0 || px >= T || pz >= T) return t;
      const i = (pz | 0) * T + (px | 0);
      const solid = Math.max(s.height[i], s.blockers ? s.blockers[i] : 0);
      if (py <= solid) return t;
    }
    return want;
  }

  /**
   * 影を焼くための深度テクスチャ。深度テクスチャが無い環境（古い WebGL1）では
   * 影を諦める ―― 影が無くても遊べるが、動かないほうが困る。
   */
  _initShadow() {
    const gl = this.gl;
    this.shadow = null;
    if (!this.gl2 && !gl.getExtension('WEBGL_depth_texture')) return;
    const size = 1024;
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, this.gl2 ? gl.DEPTH_COMPONENT24 : gl.DEPTH_COMPONENT,
      size, size, 0, gl.DEPTH_COMPONENT, this.gl2 ? gl.UNSIGNED_INT : gl.UNSIGNED_SHORT, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const fb = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.TEXTURE_2D, tex, 0);
    if (this.gl2) { gl.drawBuffers([gl.NONE]); gl.readBuffer(gl.NONE); }
    const complete = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    if (!complete) { gl.deleteFramebuffer(fb); gl.deleteTexture(tex); return; }
    this.shadow = { fb, tex, size };
  }

  /**
   * 太陽から見た行列。区画全体（2.3km）を一枚で覆うと 1 ブロックが数画素になり、
   * 木の影が溶けて消える。見ているあたりだけを切り取って解像度を稼ぐ。
   */
  _lightMVP() {
    const s = this.scene;
    const eye = this._eye();
    const T = s ? s.total : 128;
    const cx = clamp(eye[0], 0, T - 1), cz = clamp(eye[2], 0, T - 1);
    const cy = s ? s.height[(cz | 0) * T + (cx | 0)] : 0;
    const R = this.firstPerson ? 54 : clamp(this.cam.dist * 1.15, 42, 230);
    const D = 320;
    const from = [cx + SUN[0] * D, cy + SUN[1] * D, cz + SUN[2] * D];
    return M.multiply(M.ortho(-R, R, -R, R, 1, D * 2.2), M.lookAt(from, [cx, cy, cz]));
  }

  /**
   * 影を焼く。戻り値の行列を本描画に渡す（null なら影なしで描く）。
   *
   * 焼き直しは毎フレームやらない。地形も草木も動かないので、変わるのは
   * 動物の影と、視点が動いたぶんの切り取り範囲だけ。ここは深度パスに
   * 地形の全ポリゴンを流すいちばん重い処理なので、間引きがそのまま効く。
   */
  _renderShadow() {
    const gl = this.gl;
    if (!this.shadow || !this.layers.shadow || !this.solid || !this.solid.count) return null;
    const eye = this._eye();
    const moved = !this._shadowEye
      || Math.hypot(eye[0] - this._shadowEye[0], eye[1] - this._shadowEye[1], eye[2] - this._shadowEye[2]) > 3;
    this._shadowAge = (this._shadowAge || 0) + 1;
    if (!moved && this._shadowAge < 4 && this._shadowMVP) return this._shadowMVP;
    this._shadowAge = 0;
    this._shadowEye = eye;
    const mvp = this._lightMVP();
    this._shadowMVP = mvp;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.shadow.fb);
    gl.viewport(0, 0, this.shadow.size, this.shadow.size);
    gl.enable(gl.DEPTH_TEST);
    gl.depthMask(true);
    gl.clear(gl.DEPTH_BUFFER_BIT);
    // 板は裏表がある。カリングを効かせたままだと、向きによって影が抜ける
    gl.disable(gl.CULL_FACE);
    {
      const { p, loc } = this.progDepth;
      gl.useProgram(p);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.solid.vb);
      gl.enableVertexAttribArray(loc.aPos);
      gl.vertexAttribPointer(loc.aPos, 3, gl.FLOAT, false, 16, 0);
      gl.uniformMatrix4fv(loc.uMVP, false, mvp);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.solid.ib);
      gl.drawElements(gl.TRIANGLES, this.solid.count, gl.UNSIGNED_INT, 0);
        gl.disableVertexAttribArray(loc.aPos);
    }
    if (this.spriteMesh && this.layers.fauna) {
      const { p, loc } = this.progDepthSprite;
      gl.useProgram(p);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.spriteMesh.vb);
      const S = 28;
      gl.enableVertexAttribArray(loc.aCenter);
      gl.vertexAttribPointer(loc.aCenter, 3, gl.FLOAT, false, S, 0);
      gl.enableVertexAttribArray(loc.aCorner);
      gl.vertexAttribPointer(loc.aCorner, 2, gl.FLOAT, false, S, 12);
      gl.enableVertexAttribArray(loc.aUV);
      gl.vertexAttribPointer(loc.aUV, 2, gl.FLOAT, false, S, 20);
      gl.uniformMatrix4fv(loc.uMVP, false, mvp);
      gl.uniform3fv(loc.uSun, SUN);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.spriteTex);
      gl.uniform1i(loc.uTex, 0);
      gl.drawArrays(gl.TRIANGLES, 0, this.spriteMesh.count);
        gl.disableVertexAttribArray(loc.aCenter);
      gl.disableVertexAttribArray(loc.aCorner);
      gl.disableVertexAttribArray(loc.aUV);
    }
    gl.enable(gl.CULL_FACE);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return mvp;
  }

  /**
   * 箱庭をひとつの模型として覗き込む構え。
   *
   * 一人称は目線が地表 18m にあり、木立に入ると数ブロック先しか見えない。
   * どんな場所に降りたのか掴めないので、まずは全体が入るところまで引く。
   * 見下ろしを深くしすぎると Y 軸ビルボードの板が線に潰れるので、45 度手前で止める。
   */
  frameSandbox() {
    const s = this.scene;
    if (!this.ok || !s) return;
    this.setFirstPerson(false);
    const c = s.total / 2;
    // 中心の一点ではなく真ん中あたりの平均をとる。たまたま谷底や崖の上だと
    // 注視点が上下に飛んで、同じ箱庭でも見え方が変わってしまう
    let sum = 0, cnt = 0;
    const r = Math.max(8, s.cols >> 1);
    for (let z = c - r; z < c + r; z += 4) {
      for (let x = c - r; x < c + r; x += 4) {
        const i = (z | 0) * s.total + (x | 0);
        const wl = s.water[i];
        sum += Math.max(s.height[i], wl === WATER_NONE ? s.height[i] : wl);
        cnt++;
      }
    }
    this.cam.x = c;
    this.cam.z = c;
    this.cam.y = (cnt ? sum / cnt : 0) + 5;
    // 区画は total（= cols * 4）ブロック四方ある。画角 52 度で全体を収めるには
    // その 0.8 ぶんが入る距離が要る。近すぎると森の一角しか見えず、
    // どんな地形の箱庭なのか分からない
    this.cam.pitch = -0.78;
    this.cam.yaw = 0.9;
    // 全体を隅まで収めると丘の遠景になって、木も生き物も粒になる。
    // 半分ほどが視野に入るあたりが、地形も足元も見える距離
    const span = s.total * 0.5;
    this.cam.dist = span / (2 * Math.tan((52 * Math.PI / 180) / 2));
  }

  /** 絵を差し替えたときに呼ぶ。地形は変わらないので板だけ作り直す */
  refreshSprites() {
    if (!this.ok || !this.scene) return;
    this._buildSprites();
  }

  // ---- 視点 ------------------------------------------------------------

  rotate(dx, dy) {
    if (this.firstPerson) return;      // 一人称の視線は Explorer 側が持つ
    this.cam.yaw -= dx * 0.005;
    const s = this.invertY === false ? -1 : 1;
    this.cam.pitch = clamp(this.cam.pitch + s * dy * 0.004, -1.35, 0.35);
  }
  zoom(f) {
    if (this.firstPerson) return;
    const s = this.scene;
    this.cam.dist = clamp(this.cam.dist / f, 6, s ? s.total * 0.9 : 400);
  }

  /** 一人称に切り替える。dist を 0 にすると注視点＝目の位置になる */
  setFirstPerson(on) {
    this.firstPerson = on;
    if (on) this.cam.dist = 0;
    else if (this.scene) this.resetCamera();
  }

  /** 探索モードから毎フレーム渡される視点 */
  setEye(x, y, z, yaw, pitch) {
    this.cam.x = x; this.cam.y = y; this.cam.z = z;
    this.cam.yaw = yaw;
    this.cam.pitch = clamp(pitch, -1.45, 1.45);
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
    // 動物は毎フレーム居場所も姿も変わる。板だけ書き直す（地形は据え置き）
    this._updateSprites();
    // 影は板の位置が決まってから焼く。順が逆だと動物の影が 1 フレーム遅れる
    const lightMVP = this._renderShadow();
    const s = this.scene;
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.enable(gl.DEPTH_TEST);
    gl.depthMask(true);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

    const { mvp, eye } = this._matrices();
    const extent = s.total;
    // 目が水面下にあるかどうかで霧を切り替える。
    // 水中でも空気と同じ霧だと、潜っているのに見通しが変わらず違和感が出る
    const wi = (clamp(eye[2] | 0, 0, s.total - 1)) * s.total + clamp(eye[0] | 0, 0, s.total - 1);
    const wl = s.water[wi];
    const underwater = wl !== WATER_NONE && eye[1] < wl - 0.05;
    this.underwater = underwater;
    const fog = underwater ? [0.09, 0.28, 0.42] : this.fogColor();
    const fogRange = underwater
      ? [2, 46]
      : this.layers.fog
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
      gl.uniform3fv(loc.uTop, this.underwater ? [0.05, 0.18, 0.32] : this.skyTop());
      gl.uniform3fv(loc.uHorizon, fog);
      // 地平線の画面上の高さ（俯角が深いほど上に来る）
      gl.uniform1f(loc.uHorizonY, 0.5 + this.cam.pitch * 0.62);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      gl.depthMask(true);
    }

    // 影を受ける側に渡すもの。影を持たないシェーダでは loc が null になり、
    // uniform 呼び出しはそのまま素通りする
    const IDENT = M.identity();
    const bindShadow = (loc) => {
      gl.uniformMatrix4fv(loc.uLightMVP, false, lightMVP || IDENT);
      gl.uniform1f(loc.uShadowOn, lightMVP ? 1 : 0);
      if (!this.shadow) return;
      gl.uniform2f(loc.uShadowTexel, 1 / this.shadow.size, 1 / this.shadow.size);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, this.shadow.tex);
      gl.uniform1i(loc.uShadowMap, 1);
    };

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
      bindShadow(loc);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, mesh.ib);
      return loc;
    };

    // 2. 地形・植物・動物（不透明）
    gl.disable(gl.BLEND);
    bind(this.progSolid, this.solid);
    gl.drawElements(gl.TRIANGLES, this.solid.count, gl.UNSIGNED_INT, 0);

    // 3. 動物（ドット絵の板。抜きを discard するので不透明として扱える）
    if (this.spriteMesh) {
      const { p, loc } = this.progSprite;
      gl.useProgram(p);
      gl.disable(gl.CULL_FACE);          // 板は裏返らないが、回り込みで裏を向いても消さない
      gl.bindBuffer(gl.ARRAY_BUFFER, this.spriteMesh.vb);
      const S = 28;
      gl.enableVertexAttribArray(loc.aCenter);
      gl.vertexAttribPointer(loc.aCenter, 3, gl.FLOAT, false, S, 0);
      gl.enableVertexAttribArray(loc.aCorner);
      gl.vertexAttribPointer(loc.aCorner, 2, gl.FLOAT, false, S, 12);
      gl.enableVertexAttribArray(loc.aUV);
      gl.vertexAttribPointer(loc.aUV, 2, gl.FLOAT, false, S, 20);
      gl.uniformMatrix4fv(loc.uMVP, false, mvp);
      gl.uniform3fv(loc.uCam, eye);
      gl.uniform3fv(loc.uFog, fog);
      gl.uniform2fv(loc.uFogRange, fogRange);
      bindShadow(loc);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.spriteTex);
      gl.uniform1i(loc.uTex, 0);
      gl.drawArrays(gl.TRIANGLES, 0, this.spriteMesh.count);
        // 次のパスは頂点の並びが違う。有効にした列を残すと、無い属性を読みに行く
      gl.disableVertexAttribArray(loc.aCenter);
      gl.disableVertexAttribArray(loc.aCorner);
      gl.disableVertexAttribArray(loc.aUV);
      gl.enable(gl.CULL_FACE);
    }

    // 4. 水面（半透明。深度は書かない — 戻し忘れると次のフレームが真っ黒になる）
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
    if (!this.scene) return;
    if (this.firstPerson) {
      // 照準。ドットの粗さに関係なく同じ大きさで出したいので overlay 側に描く
      const cx = W / 2, cy = H / 2, r = 7;
      ctx.strokeStyle = 'rgba(255,255,255,0.75)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(cx - r, cy); ctx.lineTo(cx - 2, cy);
      ctx.moveTo(cx + 2, cy); ctx.lineTo(cx + r, cy);
      ctx.moveTo(cx, cy - r); ctx.lineTo(cx, cy - 2);
      ctx.moveTo(cx, cy + 2); ctx.lineTo(cx, cy + r);
      ctx.stroke();
    }
    if (!this.layers.labels) return;
    const sx = W / this.canvas.width, sy = H / this.canvas.height;
    const drawn = [];
    const seenName = new Set();
    for (const f of this.scene.fauna) {
      // 同じ種の名前を何度も出さない。群れの上に同じ札が並ぶと読めなくなる
      if (seenName.has(f.name) || drawn.length >= 6) continue;
      const sp = sprite(spriteKey(f.sprite));
      const top = f.y + (sp ? (f.size / VOX_M) * (sp.h / sp.w) : 1);
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
