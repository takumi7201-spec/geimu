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
import { trimSprite } from '../src/voxel/spriteutil.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SRC_DIR = resolve(ROOT, 'assets/fauna');
const OUT = resolve(ROOT, 'src/voxel/sprites.js');

export function buildSprites() {
  if (!existsSync(SRC_DIR)) throw new Error(`${SRC_DIR} がありません`);
  const files = readdirSync(SRC_DIR).filter((f) => f.toLowerCase().endsWith('.png')).sort();
  if (!files.length) throw new Error(`${SRC_DIR} に PNG がありません`);

  const entries = [];
  for (const f of files) {
    const key = basename(f, '.png').replace(/[^a-zA-Z0-9_]/g, '_');
    const img = trimSprite(decodePNG(readFileSync(resolve(SRC_DIR, f))));
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

// アプリから差し替えた絵。組み込みより優先する（端末に憶えさせるのは呼び出し側の仕事）
const overrides = new Map();

/** 差し替える。img に null を渡すと組み込みに戻る */
export function setSprite(key, img) {
  if (img) overrides.set(key, img); else overrides.delete(key);
  cache.delete(key);
}

export function clearSprites() { overrides.clear(); cache.clear(); }
export function isOverridden(key) { return overrides.has(key); }

/** { w, h, data:RGBA } を返す。base64 の展開は初回だけ */
const cache = new Map();
export function sprite(key) {
  const o = overrides.get(key);
  if (o) return o;
  if (!cache.has(key)) {
    const r = RAW[key];
    if (!r) return null;
    cache.set(key, { w: r.w, h: r.h, data: B64(r.rgba) });
  }
  return cache.get(key);
}

/** 組み込みの絵の名前（差し替えた分は含まない） */
export const SPRITE_KEYS = Object.keys(RAW);
`);

  return entries;
}

const list = buildSprites();
for (const e of list) console.log(`  ${e.file} → ${e.key}  ${e.w}×${e.h}  不透明 ${e.opaque} px`);
console.log(`src/voxel/sprites.js — ${list.length} 体`);
