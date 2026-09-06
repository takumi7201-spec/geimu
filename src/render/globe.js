/**
 * 3D 地球儀。
 *
 * 2D マップと同じラスタをテクスチャに使い、標高で球面を変位させる。
 * 海面は半径 1.0 の半透明シェルとして別に描くので、大陸棚や内海では
 * 水の下に海底地形が透けて見える。
 *
 * WebGL2 があれば使う（32bit インデックスと NPOT テクスチャのため）。
 * 無ければ WebGL1 + OES_element_index_uint にフォールバックする。
 */

import { buildRaster } from './raster.js';
import { toMeters } from '../world/biomes.js';
import * as M from './glmat.js';
import { clamp } from '../core/rng.js';

const TERRAIN_VS = `
attribute vec3 aPos;
attribute vec3 aNormal;
attribute vec2 aUV;
attribute float aElev;
uniform mat4 uMVP;
uniform mat4 uModel;
uniform mat3 uNormalMat;
varying vec2 vUV;
varying vec3 vNormal;
varying vec3 vWorld;
varying float vElev;
void main() {
  vUV = aUV;
  vElev = aElev;
  vNormal = uNormalMat * aNormal;
  vWorld = (uModel * vec4(aPos, 1.0)).xyz;
  gl_Position = uMVP * vec4(aPos, 1.0);
}`;

const TERRAIN_FS = `
precision highp float;
uniform sampler2D uTex;
uniform vec3 uLight;
uniform vec3 uCam;
varying vec2 vUV;
varying vec3 vNormal;
varying vec3 vWorld;
varying float vElev;
void main() {
  vec3 base = texture2D(uTex, vUV).rgb;
  vec3 N = normalize(vNormal);
  vec3 V = normalize(uCam - vWorld);
  float ndl = max(dot(N, uLight), 0.0);
  // 半球アンビエント：上からは空の色、下からは地の色
  vec3 amb = mix(vec3(0.10, 0.12, 0.18), vec3(0.24, 0.26, 0.30), N.y * 0.5 + 0.5);
  vec3 col = base * (amb + vec3(1.0, 0.96, 0.88) * ndl * 0.95);
  // 縁を光らせて球であることを強調する
  float rim = pow(1.0 - max(dot(N, V), 0.0), 3.0);
  col += vec3(0.20, 0.34, 0.52) * rim * 0.45;
  gl_FragColor = vec4(col, 1.0);
}`;

const OCEAN_VS = `
attribute vec3 aPos;
attribute vec2 aUV;
uniform mat4 uMVP;
uniform mat4 uModel;
uniform mat3 uNormalMat;
varying vec2 vUV;
varying vec3 vNormal;
varying vec3 vWorld;
void main() {
  vUV = aUV;
  vNormal = uNormalMat * aPos;
  vWorld = (uModel * vec4(aPos, 1.0)).xyz;
  gl_Position = uMVP * vec4(aPos, 1.0);
}`;

const OCEAN_FS = `
precision highp float;
uniform sampler2D uData;
uniform vec3 uLight;
uniform vec3 uCam;
uniform float uOpacity;
varying vec2 vUV;
varying vec3 vNormal;
varying vec3 vWorld;
void main() {
  float e = texture2D(uData, vUV).r * 2.0 - 1.0;
  if (e >= 0.0) discard;                       // 陸の上に水は張らない
  float depth = -e;
  vec3 shallow = vec3(0.32, 0.63, 0.72);
  vec3 deep    = vec3(0.02, 0.09, 0.24);
  vec3 water = mix(shallow, deep, smoothstep(0.0, 0.42, depth));
  vec3 N = normalize(vNormal);
  vec3 V = normalize(uCam - vWorld);
  vec3 H = normalize(uLight + V);
  float ndl = max(dot(N, uLight), 0.0);
  float spec = pow(max(dot(N, H), 0.0), 220.0);
  float fres = pow(1.0 - max(dot(N, V), 0.0), 4.0);
  vec3 col = water * (0.16 + ndl * 0.95) + vec3(1.0, 0.95, 0.86) * spec * 0.30;
  col += vec3(0.24, 0.44, 0.68) * fres * 0.34;
  // 浅いほど海底を透かす
  float alpha = (mix(0.42, 0.95, smoothstep(0.0, 0.26, depth)) + fres * 0.2) * uOpacity;
  gl_FragColor = vec4(col, clamp(alpha, 0.0, 1.0));
}`;

const ATMO_VS = `
attribute vec3 aPos;
uniform mat4 uMVP;
uniform mat4 uModel;
varying vec3 vNormal;
varying vec3 vWorld;
void main() {
  vNormal = aPos;
  vWorld = (uModel * vec4(aPos, 1.0)).xyz;
  gl_Position = uMVP * vec4(aPos, 1.0);
}`;

const ATMO_FS = `
precision highp float;
uniform vec3 uCam;
uniform vec3 uLight;
varying vec3 vNormal;
varying vec3 vWorld;
void main() {
  vec3 N = normalize(vWorld);
  vec3 V = normalize(uCam - vWorld);
  float fres = pow(1.0 - max(dot(N, V), 0.0), 2.2);
  float lit = max(dot(N, uLight), 0.0) * 0.75 + 0.25;
  gl_FragColor = vec4(vec3(0.34, 0.56, 0.88) * fres * lit, fres * 0.55 * lit);
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

/** 経緯度メッシュの分割数。世界の解像度に応じて上げる */
function meshSegments(w) {
  if (w >= 4096) return [640, 320];
  if (w >= 3072) return [576, 288];
  if (w >= 2048) return [512, 256];
  return [384, 192];
}

export class GlobeRenderer {
  constructor(canvas, overlay) {
    this.canvas = canvas;
    this.overlay = overlay;
    this.octx = overlay.getContext('2d');
    this.world = null;
    this.regions = null;
    this.marks = [];
    this.mode = 'biome';
    this.layers = { rivers: true, labels: true, marks: true, hillshade: true, borders: true, ocean: true, atmosphere: true };
    this.relief = 0.055;          // 起伏の誇張（実スケールでは球面上に何も見えない）
    this.cam = { yaw: -1.9, pitch: -0.15, dist: 4.0 };
    this.spin = 0;
    this.ok = false;
    this.error = null;
    this._initGL();
  }

  _initGL() {
    const opts = { antialias: true, alpha: false, depth: true, preserveDrawingBuffer: true };
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
      this.progTerrain = program(gl, TERRAIN_VS, TERRAIN_FS);
      this.progOcean = program(gl, OCEAN_VS, OCEAN_FS);
      this.progAtmo = program(gl, ATMO_VS, ATMO_FS);
    } catch (e) {
      this.error = e.message;
      return;
    }
    gl.enable(gl.DEPTH_TEST);
    gl.enable(gl.CULL_FACE);
    gl.cullFace(gl.BACK);
    this.ok = true;
  }

  setWorld(world, regions, marks) {
    if (!this.ok) return;
    this.world = world;
    this.regions = regions;
    this.marks = marks || [];
    this._buildMesh();
    this._buildTextures();
  }

  setMode(mode) { this.mode = mode; if (this.world) this._updateColorTexture(); }
  setLayer(k, v) {
    this.layers[k] = v;
    if (this.world && (k === 'rivers' || k === 'hillshade' || k === 'borders')) this._updateColorTexture();
  }
  setRelief(v) { this.relief = v; if (this.world) this._buildMesh(); }

  /** 経緯度グリッドを標高で変位させた球面メッシュを作る */
  _buildMesh() {
    const gl = this.gl, world = this.world;
    const [SX, SY] = meshSegments(world.w);
    const nv = (SX + 1) * (SY + 1);
    const pos = new Float32Array(nv * 3);
    const nrm = new Float32Array(nv * 3);
    const uv = new Float32Array(nv * 2);
    const elv = new Float32Array(nv);
    const radius = new Float32Array(nv);

    // 標高をバイリニアで拾う
    const { w, h, elev } = world;
    const sample = (u, v) => {
      const fx = u * w - 0.5, fy = clamp(v * h - 0.5, 0, h - 1);
      const x0 = Math.floor(fx), y0 = Math.floor(fy);
      const tx = fx - x0, ty = fy - y0;
      const xa = ((x0 % w) + w) % w, xb = ((x0 + 1) % w + w) % w;
      const ya = clamp(y0, 0, h - 1), yb = clamp(y0 + 1, 0, h - 1);
      const e00 = elev[ya * w + xa], e10 = elev[ya * w + xb];
      const e01 = elev[yb * w + xa], e11 = elev[yb * w + xb];
      return (e00 * (1 - tx) + e10 * tx) * (1 - ty) + (e01 * (1 - tx) + e11 * tx) * ty;
    };

    for (let j = 0; j <= SY; j++) {
      const v = j / SY;
      const theta = v * Math.PI;             // 0 = 北極
      const sy = Math.cos(theta), sr = Math.sin(theta);
      for (let i = 0; i <= SX; i++) {
        const u = i / SX;
        const phi = u * Math.PI * 2;
        const k = j * (SX + 1) + i;
        const e = sample(u, v);
        // 陸は強く、海底は控えめに誇張する
        const r = 1 + (e > 0 ? e * this.relief : e * this.relief * 0.55);
        radius[k] = r;
        const dx = sr * Math.sin(phi), dy = sy, dz = sr * Math.cos(phi);
        pos[k * 3] = dx * r; pos[k * 3 + 1] = dy * r; pos[k * 3 + 2] = dz * r;
        uv[k * 2] = u; uv[k * 2 + 1] = v;
        elv[k] = e;
      }
    }

    // 法線は隣接頂点の外積から求める（斜面が陰影に出る）
    for (let j = 0; j <= SY; j++) {
      for (let i = 0; i <= SX; i++) {
        const k = j * (SX + 1) + i;
        const kl = j * (SX + 1) + (i === 0 ? SX - 1 : i - 1);
        const kr = j * (SX + 1) + (i === SX ? 1 : i + 1);
        const ku = (j === 0 ? j : j - 1) * (SX + 1) + i;
        const kd = (j === SY ? j : j + 1) * (SX + 1) + i;
        const ax = pos[kr * 3] - pos[kl * 3], ay = pos[kr * 3 + 1] - pos[kl * 3 + 1], az = pos[kr * 3 + 2] - pos[kl * 3 + 2];
        const bx = pos[kd * 3] - pos[ku * 3], by = pos[kd * 3 + 1] - pos[ku * 3 + 1], bz = pos[kd * 3 + 2] - pos[ku * 3 + 2];
        let nx = ay * bz - az * by, ny = az * bx - ax * bz, nz = ax * by - ay * bx;
        const len = Math.hypot(nx, ny, nz) || 1;
        nx /= len; ny /= len; nz /= len;
        // 外向きにそろえる
        const ox = pos[k * 3], oy = pos[k * 3 + 1], oz = pos[k * 3 + 2];
        if (nx * ox + ny * oy + nz * oz < 0) { nx = -nx; ny = -ny; nz = -nz; }
        nrm[k * 3] = nx; nrm[k * 3 + 1] = ny; nrm[k * 3 + 2] = nz;
      }
    }

    const idx = new Uint32Array(SX * SY * 6);
    let o = 0;
    for (let j = 0; j < SY; j++) {
      for (let i = 0; i < SX; i++) {
        const a = j * (SX + 1) + i, b = a + 1, c = a + SX + 1, d = c + 1;
        idx[o++] = a; idx[o++] = c; idx[o++] = b;
        idx[o++] = b; idx[o++] = c; idx[o++] = d;
      }
    }

    // 海面シェル（半径 1.0 の素の球）
    const spos = new Float32Array(nv * 3);
    for (let k = 0; k < nv; k++) {
      const r = radius[k];
      spos[k * 3] = pos[k * 3] / r;
      spos[k * 3 + 1] = pos[k * 3 + 1] / r;
      spos[k * 3 + 2] = pos[k * 3 + 2] / r;
    }

    const buf = (data, target = gl.ARRAY_BUFFER) => {
      const b = gl.createBuffer();
      gl.bindBuffer(target, b);
      gl.bufferData(target, data, gl.STATIC_DRAW);
      return b;
    };
    this.mesh = {
      pos: buf(pos), nrm: buf(nrm), uv: buf(uv), elv: buf(elv), sphere: buf(spos),
      idx: buf(idx, gl.ELEMENT_ARRAY_BUFFER), count: idx.length,
    };
  }

  _buildTextures() {
    const gl = this.gl, world = this.world;
    this.colorTex = this.colorTex || gl.createTexture();
    this._updateColorTexture();

    // 海面シェル用のデータテクスチャ。R に標高を詰める
    const { w, h, elev } = world;
    const data = new Uint8Array(w * h * 4);
    for (let i = 0; i < w * h; i++) {
      data[i * 4] = clamp((elev[i] * 0.5 + 0.5) * 255, 0, 255);
      data[i * 4 + 1] = world.temp[i];
      data[i * 4 + 2] = world.moist[i];
      data[i * 4 + 3] = 255;
    }
    this.dataTex = this.dataTex || gl.createTexture();
    this._upload(this.dataTex, w, h, data, false);
  }

  _updateColorTexture() {
    const gl = this.gl, world = this.world;
    const rgba = buildRaster(world, this.mode, this.layers);
    this._upload(this.colorTex, world.w, world.h, new Uint8Array(rgba.buffer), true);
  }

  _upload(tex, w, h, data, mip) {
    const gl = this.gl;
    const pot = (w & (w - 1)) === 0 && (h & (h - 1)) === 0;
    const canRepeat = this.isGL2 || pot;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, data);
    const wrap = canRepeat ? gl.REPEAT : gl.CLAMP_TO_EDGE;
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, wrap);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    // 斜めから見たときに手前がぼけないよう異方性フィルタを効かせる
    const aniso = this._aniso ?? (this._aniso =
      gl.getExtension('EXT_texture_filter_anisotropic') ||
      gl.getExtension('WEBKIT_EXT_texture_filter_anisotropic') || null);
    if (aniso && mip) {
      const max = gl.getParameter(aniso.MAX_TEXTURE_MAX_ANISOTROPY_EXT);
      gl.texParameterf(gl.TEXTURE_2D, aniso.TEXTURE_MAX_ANISOTROPY_EXT, Math.min(8, max));
    }
    if (mip && canRepeat) {
      gl.generateMipmap(gl.TEXTURE_2D);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    } else {
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    }
  }

  // ---- 視点操作 --------------------------------------------------------

  rotate(dx, dy) {
    this.cam.yaw += dx * 0.005;
    this.cam.pitch = clamp(this.cam.pitch + dy * 0.005, -1.45, 1.45);
  }
  zoom(factor) { this.cam.dist = clamp(this.cam.dist / factor, 1.55, 12); }

  _matrices() {
    const aspect = this.canvas.width / this.canvas.height;
    const proj = M.perspective((38 * Math.PI) / 180, aspect, 0.05, 60);
    const view = M.translation(0, 0, -this.cam.dist);
    const model = M.multiply(M.rotationX(this.cam.pitch), M.rotationY(this.cam.yaw));
    const mvp = M.multiply(proj, M.multiply(view, model));
    // カメラのモデル空間での位置（逆回転を掛ける）
    const inv = M.transposeRot(model);
    const camPos = M.transformPoint(inv, 0, 0, this.cam.dist);
    return { proj, view, model, mvp, camPos };
  }

  /** 画面座標から球面上の緯度経度を求める。当たらなければ null */
  pick(sx, sy) {
    if (!this.world) return null;
    const { model } = this._matrices();
    const aspect = this.canvas.width / this.canvas.height;
    const f = Math.tan((38 * Math.PI) / 180 / 2);
    const ndcX = (sx / this.canvas.width) * 2 - 1;
    const ndcY = 1 - (sy / this.canvas.height) * 2;
    // ビュー空間のレイ
    const dir = [ndcX * f * aspect, ndcY * f, -1];
    const org = [0, 0, this.cam.dist];
    const len = Math.hypot(...dir);
    const d = dir.map((v) => v / len);
    // 単位球との交差
    const b = 2 * (org[0] * d[0] + org[1] * d[1] + org[2] * d[2]);
    const c = org[0] ** 2 + org[1] ** 2 + org[2] ** 2 - 1;
    const disc = b * b - 4 * c;
    if (disc < 0) return null;
    const t = (-b - Math.sqrt(disc)) / 2;
    if (t < 0) return null;
    const hit = [org[0] + d[0] * t, org[1] + d[1] * t, org[2] + d[2] * t];
    // モデル回転を戻して球面座標へ
    const inv = M.transposeRot(model);
    const p = M.transformPoint(inv, hit[0], hit[1], hit[2]);
    const lat = Math.asin(clamp(p[1], -1, 1));
    const lon = Math.atan2(p[0], p[2]);
    const u = ((lon / (Math.PI * 2)) % 1 + 1) % 1;
    const v = 0.5 - lat / Math.PI;
    return { x: u * this.world.w, y: clamp(v * this.world.h, 0, this.world.h - 1) };
  }

  /** 緯度経度（世界座標）を画面座標へ。裏側なら null */
  project(wx, wy) {
    const { mvp, model } = this._matrices();
    const u = wx / this.world.w, v = wy / this.world.h;
    const theta = v * Math.PI, phi = u * Math.PI * 2;
    const sr = Math.sin(theta);
    const p = [sr * Math.sin(phi), Math.cos(theta), sr * Math.cos(phi)];
    const wpos = M.transformPoint(model, p[0], p[1], p[2]);
    // 視線に対して裏を向いていたら描かない
    const toCam = [-wpos[0], -wpos[1], this.cam.dist - wpos[2]];
    const dot = wpos[0] * toCam[0] + wpos[1] * toCam[1] + wpos[2] * toCam[2];
    if (dot <= 0.02) return null;
    const cx = mvp[0] * p[0] + mvp[4] * p[1] + mvp[8] * p[2] + mvp[12];
    const cy = mvp[1] * p[0] + mvp[5] * p[1] + mvp[9] * p[2] + mvp[13];
    const cw = mvp[3] * p[0] + mvp[7] * p[1] + mvp[11] * p[2] + mvp[15];
    if (cw <= 0) return null;
    return {
      x: ((cx / cw) * 0.5 + 0.5) * this.canvas.width,
      y: (0.5 - (cy / cw) * 0.5) * this.canvas.height,
      depth: dot,
    };
  }

  // ---- 描画 ------------------------------------------------------------

  render() {
    if (!this.ok || !this.world) return;
    const gl = this.gl;
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.clearColor(0.031, 0.043, 0.078, 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

    const { mvp, model, camPos } = this._matrices();
    const nrmMat = M.mat3From(model);
    const light = [-0.42, 0.46, 0.78];
    const ll = Math.hypot(...light);
    const L = light.map((v) => v / ll);

    const bindAttr = (loc, buffer, size) => {
      if (loc < 0) return;
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, size, gl.FLOAT, false, 0, 0);
    };

    // 1. 地形（不透明）
    {
      const { p, loc } = this.progTerrain;
      gl.useProgram(p);
      gl.depthMask(true);
      gl.disable(gl.BLEND);
      bindAttr(loc.aPos, this.mesh.pos, 3);
      bindAttr(loc.aNormal, this.mesh.nrm, 3);
      bindAttr(loc.aUV, this.mesh.uv, 2);
      bindAttr(loc.aElev, this.mesh.elv, 1);
      gl.uniformMatrix4fv(loc.uMVP, false, mvp);
      gl.uniformMatrix4fv(loc.uModel, false, model);
      gl.uniformMatrix3fv(loc.uNormalMat, false, nrmMat);
      gl.uniform3fv(loc.uLight, L);
      gl.uniform3fv(loc.uCam, [0, 0, this.cam.dist]);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.colorTex);
      gl.uniform1i(loc.uTex, 0);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.mesh.idx);
      gl.drawElements(gl.TRIANGLES, this.mesh.count, gl.UNSIGNED_INT, 0);
    }

    // 2. 海面シェル（半透明。深度は書かない）
    if (this.layers.ocean) {
      const { p, loc } = this.progOcean;
      gl.useProgram(p);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      gl.depthMask(false);
      bindAttr(loc.aPos, this.mesh.sphere, 3);
      bindAttr(loc.aUV, this.mesh.uv, 2);
      gl.uniformMatrix4fv(loc.uMVP, false, mvp);
      gl.uniformMatrix4fv(loc.uModel, false, model);
      gl.uniformMatrix3fv(loc.uNormalMat, false, nrmMat);
      gl.uniform3fv(loc.uLight, L);
      gl.uniform3fv(loc.uCam, [0, 0, this.cam.dist]);
      // 標高段彩や気温の表示では、水面が濃いと海底の情報が見えなくなる。
      // 生態系表示のときだけ水を厚く張る。
      gl.uniform1f(loc.uOpacity, this.mode === 'biome' ? 1.0 : 0.3);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.dataTex);
      gl.uniform1i(loc.uData, 0);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.mesh.idx);
      gl.drawElements(gl.TRIANGLES, this.mesh.count, gl.UNSIGNED_INT, 0);
    }

    // 3. 大気。裏面を加算合成して縁だけを光らせる
    if (this.layers.atmosphere) {
      const { p, loc } = this.progAtmo;
      gl.useProgram(p);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE);
      gl.depthMask(false);
      gl.cullFace(gl.FRONT);
      const scale = M.scaling(1.055);
      const am = M.multiply(model, scale);
      bindAttr(loc.aPos, this.mesh.sphere, 3);
      gl.uniformMatrix4fv(loc.uMVP, false, M.multiply(mvp, scale));
      gl.uniformMatrix4fv(loc.uModel, false, am);
      gl.uniform3fv(loc.uLight, L);
      gl.uniform3fv(loc.uCam, [0, 0, this.cam.dist]);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.mesh.idx);
      gl.drawElements(gl.TRIANGLES, this.mesh.count, gl.UNSIGNED_INT, 0);
      gl.cullFace(gl.BACK);
    }

    gl.depthMask(true);
    gl.disable(gl.BLEND);
    this._drawOverlay();
  }

  /** 地名と名所は 2D キャンバスに投影して重ねる */
  _drawOverlay() {
    const ctx = this.octx;
    const W = this.overlay.width, H = this.overlay.height;
    ctx.clearRect(0, 0, W, H);
    if (!this.regions) return;
    const drawn = [];
    const put = (name, wx, wy, size, color, spacing) => {
      const p = this.project(wx, wy);
      if (!p) return;
      if (drawn.some((q) => Math.abs(q.x - p.x) < 62 && Math.abs(q.y - p.y) < 17)) return;
      drawn.push(p);
      const fade = clamp(p.depth * 2.4, 0, 1);
      // 縁に近いラベルは奥行きに合わせて小さくする
      size *= 0.68 + 0.32 * fade;
      ctx.font = `600 ${size}px "Hiragino Sans", "Noto Sans JP", system-ui, sans-serif`;
      ctx.letterSpacing = spacing;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.globalAlpha = fade;
      ctx.lineWidth = 3.5;
      ctx.strokeStyle = 'rgba(6,10,20,0.8)';
      ctx.strokeText(name, p.x, p.y);
      ctx.fillStyle = color;
      ctx.fillText(name, p.x, p.y);
      ctx.globalAlpha = 1;
      ctx.letterSpacing = '0px';
    };

    if (this.layers.labels) {
      const s = clamp(62 / this.cam.dist, 12, 30);
      for (const o of this.regions.anchored) put(o.name, o.x, o.y, s * 0.68, 'rgba(178,214,246,0.9)', '3px');
      for (const l of this.regions.landmasses) {
        if (l.kind === 'island' && this.cam.dist > 3.0) continue;
        put(l.name, l.x, l.y, l.kind === 'continent' ? 1.0 * s : s * 0.62, 'rgba(255,246,226,0.95)', '2px');
      }
      for (const p of this.regions.landAnchors || []) {
        if (this.regions.landmasses.some((l) => l.name === p.name)) continue;
        put(p.name, p.x, p.y, s * 0.72, 'rgba(238,226,200,0.72)', '3px');
      }
    }

    if (this.layers.marks) {
      for (const m of this.marks) {
        if (m.type === 'fossil' && this.cam.dist > 2.8) continue;
        const p = this.project(m.x, m.y);
        if (!p) continue;
        ctx.globalAlpha = clamp(p.depth * 2.4, 0, 1);
        drawMarkDot(ctx, m.type, p.x, p.y, clamp(16 / this.cam.dist, 2.5, 6.5));
        ctx.globalAlpha = 1;
      }
    }
  }
}

function drawMarkDot(ctx, type, x, y, r) {
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fillStyle =
    type === 'volcano' ? '#f2803f' :
    type === 'peak' ? '#efe8da' :
    type === 'river' ? '#8fd0f0' : '#ffd98a';
  ctx.strokeStyle = 'rgba(6,10,20,0.8)';
  ctx.lineWidth = 1.6;
  ctx.fill();
  ctx.stroke();
}
