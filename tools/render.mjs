#!/usr/bin/env node
/**
 * CLI レンダラ。ブラウザなしで世界を生成し PNG に書き出す。
 * 生成器の回帰確認と、素材としての大判マップ出力に使う。
 *
 *   node tools/render.mjs --era jurassic --seed pangaea --size large --mode biome --out out/
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { encodePNG } from './png.mjs';
import { generateWorld, SIZES } from '../src/world/worldgen.js';
import { buildRegions, buildLandmarks } from '../src/world/regions.js';
import { buildRaster, VIEW_MODES } from '../src/render/raster.js';
import { BIOMES } from '../src/world/biomes.js';
import { ERAS } from '../src/world/eras.js';

function parseArgs(argv) {
  const o = { era: 'jurassic', seed: 'pangaea', size: 'medium', mode: 'biome', out: 'out', ma: '' };
  for (let i = 0; i < argv.length; i += 2) {
    const k = argv[i].replace(/^--/, '');
    if (k in o) o[k] = argv[i + 1];
    else if (k === 'all') { o.all = true; i -= 1; }
  }
  return o;
}

const args = parseArgs(process.argv.slice(2));
if (!(args.size in SIZES)) { console.error(`size は ${Object.keys(SIZES).join('|')}`); process.exit(1); }
if (!(args.mode in VIEW_MODES)) { console.error(`mode は ${Object.keys(VIEW_MODES).join('|')}`); process.exit(1); }

const eras = args.all ? ERAS.map((e) => e.id) : [args.era];
const ageMa = args.ma === '' ? null : Number(args.ma);
mkdirSync(args.out, { recursive: true });

for (const eraId of eras) {
  const t0 = Date.now();
  const world = await generateWorld({ seed: args.seed, eraId, size: args.size, ma: ageMa });
  const regions = buildRegions(world);
  const marks = buildLandmarks(world, regions);
  const rgba = buildRaster(world, args.mode, {});
  const tag = ageMa == null ? eraId : `${Math.round(ageMa)}Ma`;
  const file = join(args.out, `${tag}-${args.seed}-${args.size}-${args.mode}.png`);
  writeFileSync(file, encodePNG(rgba, world.w, world.h));

  const s = world.stats;
  const land = Object.entries(s.biomeCounts).filter(([k]) => !BIOMES[k].water);
  const lt = land.reduce((a, [, v]) => a + v, 0) || 1;
  console.log(`\n■ ${world.era.name} (${world.era.ma ?? eraId}Ma)  seed=${args.seed}  ${world.w}×${world.h}  ${Date.now() - t0}ms`);
  console.log(`  陸地率 ${(s.landRatio * 100).toFixed(1)}%  平均気温 ${s.meanTemp.toFixed(1)}℃  最高峰 ${Math.round(s.maxElev * 4600)}m`);
  console.log(`  大陸 ${regions.landmasses.filter((l) => l.kind === 'continent').length} / 島 ${regions.landmasses.filter((l) => l.kind === 'island').length}  名所 ${marks.length}`);
  console.log(`  主要陸上バイオーム: ${land.sort((a, b) => b[1] - a[1]).slice(0, 6).map(([k, v]) => `${BIOMES[k].name} ${(v / lt * 100).toFixed(0)}%`).join(' / ')}`);
  console.log(`  → ${file}`);
}
