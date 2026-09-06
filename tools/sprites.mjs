/**
 * ドット絵スプライトの取り込み（assets/fauna/*.png → src/voxel/sprites.js）。
 *
 * 恐竜は 3D のボクセル模型ではなく、手で打ったドット絵を板（ビルボード）で立てる。
 * file:// で開く 1 枚版では画像を fetch できないので、PNG はここで JS に畳んでおく。
 *
 * 透明で囲まれた余白はここで刈る。刈らないと板の足元が浮き、群れが宙に並ぶ。
 */

import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { resolve, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodePNG } from './png.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SRC_DIR = resolve(ROOT, 'assets/fauna');
const OUT = resolve(ROOT, 'src/voxel/sprites.js');

/** 不透明な範囲まで刈り込む（足元と輪郭を絵のとおりに合わせるため） */
function trim(img) {
  let x0 = img.w, y0 = img.h, x1 = -1, y1 = -1;
  for (let y = 0; y < img.h; y++) {
    for (let x = 0; x < img.w; x++) {
      if (img.data[(y * img.w + x) * 4 + 3] > 8) {
        if (x < x0) x0 = x; if (x > x1) x1 = x;
        if (y < y0) y0 = y; if (y > y1) y1 = y;
      }
    }
  }
  if (x1 < 0) throw new Error('全部が透明です');
  const w = x1 - x0 + 1, h = y1 - y0 + 1;
  const data = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const s = ((y + y0) * img.w + (x + x0)) * 4, d = (y * w + x) * 4;
      data[d] = img.data[s]; data[d+1] = img.data[s+1];
      data[d+2] = img.data[s+2]; data[d+3] = img.data[s+3];
    }
  }
  return { w, h, data };
}

export function buildSprites() {
  if (!existsSync(SRC_DIR)) throw new Error(`${SRC_DIR} がありません`);
  const files = readdirSync(SRC_DIR).filter((f) => f.toLowerCase().endsWith('.png')).sort();
  if (!files.length) throw new Error(`${SRC_DIR} に PNG がありません`);

  const entries = [];
  for (const f of files) {
    const key = basename(f, '.png').replace(/[^a-zA-Z0-9_]/g, '_');
    const img = trim(decodePNG(readFileSync(resolve(SRC_DIR, f))));
    let opaque = 0;
    for (let i = 3; i < img.data.length; i += 4) if (img.data[i] > 128) opaque++;
    entries.push({ key, ...img, opaque, file: f });
  }

  const body = entries.map((e) =>
    `  ${e.key}: { w: ${e.w}, h: ${e.h}, rgba: '${Buffer.from(e.data).toString('base64')}' },`
  ).join('\n');

  writeFileSync(OUT, `/**
 * 動物のドット絵（tools/sprites.mjs が assets/fauna/*.png から作る。手で編集しない）。
 * rgba は base64 の RGBA8。透明の余白は刈り済みなので、板の高さ＝絵の高さでよい。
 */

const B64 = typeof atob === 'function'
  ? (s) => { const b = atob(s); const u = new Uint8Array(b.length); for (let i = 0; i < b.length; i++) u[i] = b.charCodeAt(i); return u; }
  : (s) => new Uint8Array(Buffer.from(s, 'base64'));

const RAW = {
${body}
};

/** { w, h, data:RGBA } を返す。base64 の展開は初回だけ */
const cache = new Map();
export function sprite(key) {
  if (!cache.has(key)) {
    const r = RAW[key];
    if (!r) return null;
    cache.set(key, { w: r.w, h: r.h, data: B64(r.rgba) });
  }
  return cache.get(key);
}

export const SPRITE_KEYS = Object.keys(RAW);
`);

  return entries;
}

const list = buildSprites();
for (const e of list) console.log(`  ${e.file} → ${e.key}  ${e.w}×${e.h}  不透明 ${e.opaque} px`);
console.log(`src/voxel/sprites.js — ${list.length} 体`);
