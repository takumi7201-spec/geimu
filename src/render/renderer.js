/**
 * マップ描画。
 * 世界解像度のラスタをオフスクリーンに一度だけ焼き、
 * ビューはそれをスケール描画するだけにして パンやズームを続けても軽くする。
 */

import { clamp } from '../core/rng.js';
import { buildRaster, VIEW_MODES } from './raster.js';

export { VIEW_MODES };

export class MapRenderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.world = null;
    this.regions = null;
    this.marks = [];
    this.mode = 'biome';
    this.layers = { rivers: true, labels: true, marks: true, grid: false, hillshade: true, borders: true };
    this.cam = { x: 0, y: 0, zoom: 1 };
    this.raster = document.createElement('canvas');
    this.hover = null;
  }

  setWorld(world, regions, marks) {
    this.world = world;
    this.regions = regions;
    this.marks = marks || [];
    this.raster.width = world.w;
    this.raster.height = world.h;
    this.rebuild();
    this.fit();
  }

  /**
   * 初期表示。cover=true なら縦方向を埋めて黒帯を出さない。
   * 経度はラップするので横がはみ出しても切れ目は見えない。
   */
  fit(cover = true) {
    if (!this.world) return;
    const { width, height } = this.canvas;
    const contain = Math.min(width / this.world.w, height / this.world.h);
    this.minZoom = contain * 0.85;
    this.cam.zoom = cover ? Math.max(contain, height / this.world.h) : contain;
    this.cam.x = this.world.w / 2;
    this.cam.y = this.world.h / 2;
  }

  setMode(mode) { this.mode = mode; this.rebuild(); }
  setLayer(k, v) {
    this.layers[k] = v;
    if (k === 'rivers' || k === 'hillshade' || k === 'borders') this.rebuild();
  }

  /** 世界ラスタを焼き直す */
  rebuild() {
    const world = this.world;
    if (!world) return;
    const img = this.ctx.createImageData(world.w, world.h);
    buildRaster(world, this.mode, this.layers, img.data);
    this.raster.getContext('2d').putImageData(img, 0, 0);
  }

  /** 画面座標 → 世界座標 */
  toWorld(sx, sy) {
    const { zoom, x, y } = this.cam;
    const wx = (sx - this.canvas.width / 2) / zoom + x;
    const wy = (sy - this.canvas.height / 2) / zoom + y;
    return { x: ((wx % this.world.w) + this.world.w) % this.world.w, y: wy };
  }

  /** 世界座標 → 画面座標（最も近いラップを選ぶ） */
  toScreen(wx, wy) {
    const { zoom, x, y } = this.cam;
    let dx = wx - x;
    const W = this.world.w;
    if (dx > W / 2) dx -= W;
    if (dx < -W / 2) dx += W;
    return { x: dx * zoom + this.canvas.width / 2, y: (wy - y) * zoom + this.canvas.height / 2 };
  }

  zoomAt(sx, sy, factor) {
    const before = this.toWorld(sx, sy);
    this.cam.zoom = clamp(this.cam.zoom * factor, this.minZoom || 0.05, 14);
    const after = this.toWorld(sx, sy);
    this.cam.x += before.x - after.x;
    this.cam.y += before.y - after.y;
    this.clampCam();
  }

  pan(dxs, dys) {
    this.cam.x -= dxs / this.cam.zoom;
    this.cam.y -= dys / this.cam.zoom;
    this.clampCam();
  }

  clampCam() {
    const W = this.world.w, H = this.world.h;
    this.cam.x = ((this.cam.x % W) + W) % W;
    const half = this.canvas.height / 2 / this.cam.zoom;
    this.cam.y = clamp(this.cam.y, Math.min(half, H / 2), Math.max(H - half, H / 2));
  }

  render() {
    const ctx = this.ctx;
    const { width, height } = this.canvas;
    ctx.save();
    ctx.fillStyle = '#080c18';
    ctx.fillRect(0, 0, width, height);
    if (!this.world) { ctx.restore(); return; }

    const { zoom, x, y } = this.cam;
    const W = this.world.w, H = this.world.h;
    ctx.imageSmoothingEnabled = zoom < 1.5;
    ctx.imageSmoothingQuality = 'high';

    // 経度方向のラップに対応するため 3 枚並べて描く
    const originY = height / 2 - y * zoom;
    for (let k = -1; k <= 1; k++) {
      const originX = width / 2 - x * zoom + k * W * zoom;
      if (originX > width || originX + W * zoom < 0) continue;
      ctx.drawImage(this.raster, originX, originY, W * zoom, H * zoom);
    }

    if (this.layers.grid) this.drawGraticule(ctx);
    if (this.layers.labels) this.drawLabels(ctx);
    if (this.layers.marks) this.drawMarks(ctx);
    this.drawFrame(ctx);
    ctx.restore();
  }

  drawGraticule(ctx) {
    const W = this.world.w, H = this.world.h;
    ctx.save();
    ctx.strokeStyle = 'rgba(230,238,255,0.16)';
    ctx.fillStyle = 'rgba(210,224,255,0.5)';
    ctx.font = '11px system-ui, sans-serif';
    ctx.lineWidth = 1;
    for (let lat = -60; lat <= 60; lat += 30) {
      const wy = ((90 - lat) / 180) * H;
      const p = this.toScreen(this.cam.x, wy);
      ctx.beginPath();
      ctx.setLineDash(lat === 0 ? [] : [4, 5]);
      ctx.moveTo(0, p.y); ctx.lineTo(this.canvas.width, p.y);
      ctx.stroke();
      ctx.fillText(`${lat === 0 ? '赤道' : (lat > 0 ? '北緯' : '南緯') + Math.abs(lat) + '°'}`, 8, p.y - 4);
    }
    ctx.setLineDash([]);
    for (let lon = 0; lon < 360; lon += 30) {
      const wx = (lon / 360) * W;
      const p = this.toScreen(wx, this.cam.y);
      if (p.x < -20 || p.x > this.canvas.width + 20) continue;
      ctx.beginPath();
      ctx.moveTo(p.x, 0); ctx.lineTo(p.x, this.canvas.height);
      ctx.stroke();
    }
    ctx.restore();
  }

  drawLabels(ctx) {
    const z = this.cam.zoom;
    ctx.save();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const drawn = [];
    const put = (name, wx, wy, size, color, letterSpacing) => {
      const p = this.toScreen(wx, wy);
      if (p.x < -120 || p.x > this.canvas.width + 120 || p.y < -40 || p.y > this.canvas.height + 40) return;
      if (drawn.some((q) => Math.abs(q.x - p.x) < 60 && Math.abs(q.y - p.y) < 18)) return;
      drawn.push(p);
      ctx.font = `600 ${size}px "Hiragino Sans", "Noto Sans JP", system-ui, sans-serif`;
      ctx.letterSpacing = letterSpacing;
      ctx.lineWidth = 3.5;
      ctx.strokeStyle = 'rgba(6,10,20,0.78)';
      ctx.strokeText(name, p.x, p.y);
      ctx.fillStyle = color;
      ctx.fillText(name, p.x, p.y);
      ctx.letterSpacing = '0px';
    };

    for (const s of this.regions.anchored) {
      put(s.name, s.x, s.y, clamp(15 * Math.sqrt(z), 12, 26), 'rgba(178,214,246,0.92)', '3px');
    }
    for (const s of this.regions.seas) {
      if (s.share < 0.004 && z < 2) continue;
      if (s.kind === 'ocean') continue;
      put(s.name, s.x, s.y, clamp(12 * Math.sqrt(z), 10, 20), 'rgba(160,200,236,0.85)', '2px');
    }
    for (const p of this.regions.landAnchors || []) {
      if (this.regions.landmasses.some((l) => l.name === p.name)) continue;
      put(p.name, p.x, p.y, clamp(13 * Math.sqrt(z), 11, 21), 'rgba(238,226,200,0.72)', '3px');
    }
    for (const l of this.regions.landmasses) {
      if (l.kind === 'island' && z < 2.2) continue;
      const size = l.kind === 'continent' ? clamp(17 * Math.sqrt(z), 13, 30) : clamp(11 * Math.sqrt(z), 10, 17);
      put(l.name, l.x, l.y, size, 'rgba(255,246,226,0.95)', '2px');
    }
    ctx.restore();
  }

  drawMarks(ctx) {
    const z = this.cam.zoom;
    ctx.save();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineJoin = 'round';
    for (const m of this.marks) {
      if (z < 1.1 && m.type === 'fossil') continue;
      const p = this.toScreen(m.x, m.y);
      if (p.x < -40 || p.x > this.canvas.width + 40 || p.y < -30 || p.y > this.canvas.height + 30) continue;
      const r = clamp(6 * Math.sqrt(z), 5, 11);
      drawMarkGlyph(ctx, m.type, p.x, p.y, r);
      if (z > 1.8) {
        ctx.font = `500 ${clamp(10 * Math.sqrt(z), 10, 15)}px "Hiragino Sans", "Noto Sans JP", system-ui, sans-serif`;
        ctx.lineWidth = 3;
        ctx.strokeStyle = 'rgba(6,10,20,0.85)';
        ctx.strokeText(m.name, p.x, p.y + r + 9);
        ctx.fillStyle = 'rgba(240,236,228,0.92)';
        ctx.fillText(m.name, p.x, p.y + r + 9);
      }
    }
    ctx.restore();
  }

  drawFrame(ctx) {
    // スケールバー
    const W = this.world.w;
    const kmPerCell = 40075 / W;
    const targets = [200, 500, 1000, 2000, 5000, 10000];
    let km = targets.find((t) => (t / kmPerCell) * this.cam.zoom > 70) || 10000;
    const px = (km / kmPerCell) * this.cam.zoom;
    const x0 = this.canvas.width - px - 22, y0 = this.canvas.height - 24;
    ctx.save();
    ctx.strokeStyle = 'rgba(255,255,255,0.85)';
    ctx.fillStyle = 'rgba(255,255,255,0.9)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(x0, y0 - 5); ctx.lineTo(x0, y0); ctx.lineTo(x0 + px, y0); ctx.lineTo(x0 + px, y0 - 5);
    ctx.stroke();
    ctx.font = '11px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.strokeStyle = 'rgba(0,0,0,0.7)';
    ctx.lineWidth = 3;
    ctx.strokeText(`${km.toLocaleString()} km`, x0 + px / 2, y0 - 9);
    ctx.fillText(`${km.toLocaleString()} km`, x0 + px / 2, y0 - 9);
    ctx.restore();
  }
}

/**
 * 名所の記号はベクタで描く。
 * 絵文字や特殊記号はフォント依存で豆腐になることがあるため使わない。
 */
function drawMarkGlyph(ctx, type, x, y, r) {
  ctx.save();
  ctx.lineWidth = 2;
  ctx.strokeStyle = 'rgba(6,10,20,0.85)';
  ctx.beginPath();
  switch (type) {
    case 'volcano':
      // 台形の火山体に噴煙の切り欠き
      ctx.moveTo(x - r, y + r * 0.7);
      ctx.lineTo(x - r * 0.32, y - r * 0.55);
      ctx.lineTo(x - r * 0.1, y - r * 0.2);
      ctx.lineTo(x + r * 0.1, y - r * 0.55);
      ctx.lineTo(x + r * 0.32, y - r * 0.55);
      ctx.lineTo(x + r, y + r * 0.7);
      ctx.closePath();
      ctx.fillStyle = '#e2763f';
      break;
    case 'peak':
      ctx.moveTo(x, y - r);
      ctx.lineTo(x + r * 0.92, y + r * 0.72);
      ctx.lineTo(x - r * 0.92, y + r * 0.72);
      ctx.closePath();
      ctx.fillStyle = '#e8e2d4';
      break;
    case 'river': {
      // 二本の波線で河口を表す
      ctx.strokeStyle = 'rgba(6,10,20,0.85)';
      for (const dy of [-r * 0.32, r * 0.34]) {
        ctx.moveTo(x - r, y + dy);
        ctx.quadraticCurveTo(x - r * 0.35, y + dy - r * 0.55, x, y + dy);
        ctx.quadraticCurveTo(x + r * 0.35, y + dy + r * 0.55, x + r, y + dy);
      }
      ctx.lineWidth = 3.4;
      ctx.stroke();
      ctx.strokeStyle = '#8fd0f0';
      ctx.lineWidth = 1.7;
      ctx.stroke();
      ctx.restore();
      return;
    }
    default: // fossil
      ctx.moveTo(x, y - r);
      ctx.lineTo(x + r * 0.42, y - r * 0.36);
      ctx.lineTo(x + r, y);
      ctx.lineTo(x + r * 0.42, y + r * 0.36);
      ctx.lineTo(x, y + r);
      ctx.lineTo(x - r * 0.42, y + r * 0.36);
      ctx.lineTo(x - r, y);
      ctx.lineTo(x - r * 0.42, y - r * 0.36);
      ctx.closePath();
      ctx.fillStyle = '#ffd98a';
  }
  ctx.stroke();
  ctx.fill();
  ctx.restore();
}
