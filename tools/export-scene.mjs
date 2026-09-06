#!/usr/bin/env node
/**
 * 地表の一区画を、他のエンジンで組み立てられる形に書き出す。
 *
 * 出す物:
 *   <名前>.json         区画まるごと（高さ・水・地表・植生・動物・モデル）
 *   <名前>-height.png   高さマップ。R が上位バイト、G が下位バイト（16bit 相当）
 *   <名前>-color.png    地表色のプレビュー（そのままテクスチャにも使える）
 *
 * 使い方:
 *   node tools/export-scene.mjs --seed pangaea --ma 160 --size large --out out/
 *   node tools/export-scene.mjs --x 1024 --y 512 --scene huge --out out/ --name delta
 *
 * JSON の読み方は docs/game-api.md を参照。
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { encodePNG } from './png.mjs';
import { createGameWorld, enterScene, serializeScene, describeScene, findSpawn, WATER_NONE, VOX_M } from '../src/game/api.js';
import { SCENE_SIZES } from '../src/voxel/scene.js';
import { SIZES } from '../src/world/worldgen.js';
import { BLOCK_COLORS } from '../src/voxel/blocks.js';

function parseArgs(argv) {
  const o = { seed: 'pangaea', ma: '160', size: 'medium', scene: 'medium', out: 'out', name: '', x: '', y: '', json: '1', png: '1' };
  for (let i = 0; i < argv.length; i += 2) {
    const k = argv[i].replace(/^--/, '');
    if (k in o) o[k] = argv[i + 1];
    else { console.error(`知らない引数: --${k}`); process.exit(1); }
  }
  return o;
}

const a = parseArgs(process.argv.slice(2));
if (!(a.size in SIZES)) { console.error(`--size は ${Object.keys(SIZES).join('|')}`); process.exit(1); }
if (!(a.scene in SCENE_SIZES)) { console.error(`--scene は ${Object.keys(SCENE_SIZES).join('|')}`); process.exit(1); }

const t0 = Date.now();
const game = await createGameWorld({ seed: a.seed, ma: Number(a.ma), size: a.size });
const spot = a.x !== '' && a.y !== '' ? { x: Number(a.x), y: Number(a.y), from: null } : null;
const scene = await enterScene(game, spot, { size: a.scene });
const meta = describeScene(scene);
const spawn = findSpawn(scene);

mkdirSync(a.out, { recursive: true });
const name = a.name || `${meta.ma}Ma-${a.seed}-${Math.round(scene.x)}x${Math.round(scene.y)}`;

if (a.json !== '0') {
  const json = serializeScene(scene);
  json.spawn = spawn;
  const file = join(a.out, `${name}.json`);
  writeFileSync(file, JSON.stringify(json));
  console.log(`  → ${file}`);
}

if (a.png !== '0') {
  const n = scene.total;
  // 高さマップ：R=上位バイト、G=下位バイト。海面 0 を 32768 に寄せて符号を消す
  const hm = new Uint8ClampedArray(n * n * 4);
  const cm = new Uint8ClampedArray(n * n * 4);
  for (let i = 0; i < n * n; i++) {
    const v = Math.max(0, Math.min(65535, scene.height[i] + 32768));
    hm[i * 4] = v >> 8; hm[i * 4 + 1] = v & 255;
    hm[i * 4 + 2] = scene.water[i] === WATER_NONE ? 0 : 255;   // B: 水の有無
    hm[i * 4 + 3] = 255;
    const c = BLOCK_COLORS[scene.surf[i]];
    const w = scene.water[i];
    const depth = w !== WATER_NONE && w > scene.height[i] ? w - scene.height[i] : 0;
    const t = Math.min(0.8, depth * 0.12);
    cm[i * 4] = c[0] * (1 - t) + 22 * t;
    cm[i * 4 + 1] = c[1] * (1 - t) + 58 * t;
    cm[i * 4 + 2] = c[2] * (1 - t) + 104 * t;
    cm[i * 4 + 3] = 255;
  }
  const hf = join(a.out, `${name}-height.png`);
  const cf = join(a.out, `${name}-color.png`);
  writeFileSync(hf, encodePNG(hm, n, n));
  writeFileSync(cf, encodePNG(cm, n, n));
  console.log(`  → ${hf}`);
  console.log(`  → ${cf}`);
}

console.log(`\n■ ${meta.era} ${meta.ma}Ma  ${meta.blocks}² ブロック（1 ブロック ${VOX_M}m / ${(meta.spanM / 1000).toFixed(1)}km 四方）  ${Date.now() - t0}ms`);
console.log(`  位置: 緯度 ${meta.at.lat.toFixed(2)} 経度 ${meta.at.lon.toFixed(2)}（マップ ${Math.round(scene.x)}, ${Math.round(scene.y)}）`);
console.log(`  環境: ${meta.biomes.map((b) => `${b.id} ${(b.share * 100).toFixed(0)}%`).join(' / ')}`);
console.log(`  植物 ${meta.props} 株 / 動物 ${meta.fauna} 頭 / 出現地点 (${spawn.x.toFixed(1)}, ${spawn.z.toFixed(1)})`);
