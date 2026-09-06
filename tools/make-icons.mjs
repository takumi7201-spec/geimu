#!/usr/bin/env node
/**
 * アプリアイコンを生成する（依存パッケージなし）。
 *
 * 16×16 のドット絵を最近傍で拡大するだけ。アイコンもボクセルの世界観に
 * そろえたいので、ぼかさずにドットのまま大きくするのが要点。
 *
 *   node tools/make-icons.mjs
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { encodePNG } from './png.mjs';

// 16×16 のドット絵。文字はパレットの添字
const ART = [
  '................',
  '......ss........',
  '.....ssss..t....',
  '......ss..ttt...',
  '.........ttttt..',
  '......t...ttt...',
  '.....ttt...T....',
  '.gggggTgggggggg.',
  'gGGGGGGGGGGGGGGg',
  'GDDDDDDDDDDDDDDG',
  'GDrrDDDDDDrrrDDG',
  'GDrrrDDDDrrrrDDG',
  'wDDDDDDDDDDDDDDw',
  'wwwDDDDDDDDDDwww',
  'wwwwwwwwwwwwwwww',
  'wwwwwwwwwwwwwwww',
];

const PALETTE = {
  '.': [11, 15, 26],      // 空（アプリの背景色）
  s: [246, 200, 96],      // 太陽
  t: [46, 100, 68],       // 針葉
  T: [106, 74, 48],       // 幹
  g: [126, 166, 70],      // 草の明部
  G: [104, 150, 62],      // 草
  D: [122, 92, 60],       // 土
  r: [162, 88, 58],       // 赤色層
  w: [38, 92, 148],       // 水
};

function render(size) {
  const px = new Uint8Array(size * size * 4);
  const scale = size / 16;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const c = PALETTE[ART[Math.floor(y / scale)][Math.floor(x / scale)]] || PALETTE['.'];
      const o = (y * size + x) * 4;
      px[o] = c[0]; px[o + 1] = c[1]; px[o + 2] = c[2]; px[o + 3] = 255;
    }
  }
  return px;
}

const out = new URL('../icons/', import.meta.url).pathname;
mkdirSync(out, { recursive: true });
for (const size of [64, 180, 192, 512]) {
  const file = join(out, `icon-${size}.png`);
  writeFileSync(file, encodePNG(render(size), size, size));
  console.log(`  → ${file}`);
}
