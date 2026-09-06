#!/usr/bin/env node
/**
 * CLI レンダラ。ブラウザなしで世界を生成し PNG に書き出す。
 * 生成器の回帰確認と、素材としての大判マップ出力に使う。
 *
 *   node tools/render.mjs --era jurassic --seed pangaea --size large --mode biome --out out/
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { dirname, join } from 'node:path';
import { generateWorld, SIZES } from '../src/world/worldgen.js';
import { buildRegions, buildLandmarks } from '../src/world/regions.js';
import { buildRaster, VIEW_MODES } from '../src/render/raster.js';
import { BIOMES } from '../src/world/biomes.js';
import { ERAS } from '../src/world/eras.js';

function parseArgs(argv) {
  const o = { era: 'jurassic', seed: 'pangaea', size: 'medium', mode: 'biome', out: 'out' };
  for (let i = 0; i < argv.length; i += 2) {
    const k = argv[i].replace(/^--/, '');
    if (k in o) o[k] = argv[i + 1];
    else if (k === 'all') { o.all = true; i -= 1; }
  }
  return o;
}

/** 最小限の PNG エンコーダ（RGBA, filter 0） */
function encodePNG(rgba, w, h) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0;
    Buffer.from(rgba.buffer, rgba.byteOffset + y * w * 4, w * 4).copy(raw, y * (w * 4 + 1) + 1);
  }
  const chunks = [Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])];
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body) >>> 0);
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  chunks.push(chunk('IHDR', ihdr));
  chunks.push(chunk('IDAT', deflateSync(raw, { level: 6 })));
  chunks.push(chunk('IEND', Buffer.alloc(0)));
  return Buffer.concat(chunks);
}

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return c ^ -1;
}

const args = parseArgs(process.argv.slice(2));
if (!(args.size in SIZES)) { console.error(`size は ${Object.keys(SIZES).join('|')}`); process.exit(1); }
if (!(args.mode in VIEW_MODES)) { console.error(`mode は ${Object.keys(VIEW_MODES).join('|')}`); process.exit(1); }

const eras = args.all ? ERAS.map((e) => e.id) : [args.era];
mkdirSync(args.out, { recursive: true });

for (const eraId of eras) {
  const t0 = Date.now();
  const world = await generateWorld({ seed: args.seed, eraId, size: args.size });
  const regions = buildRegions(world);
  const marks = buildLandmarks(world, regions);
  const rgba = buildRaster(world, args.mode, {});
  const file = join(args.out, `${eraId}-${args.seed}-${args.size}-${args.mode}.png`);
  writeFileSync(file, encodePNG(rgba, world.w, world.h));

  const s = world.stats;
  const land = Object.entries(s.biomeCounts).filter(([k]) => !BIOMES[k].water);
  const lt = land.reduce((a, [, v]) => a + v, 0) || 1;
  console.log(`\n■ ${world.era.name} (${eraId})  seed=${args.seed}  ${world.w}×${world.h}  ${Date.now() - t0}ms`);
  console.log(`  陸地率 ${(s.landRatio * 100).toFixed(1)}%  平均気温 ${s.meanTemp.toFixed(1)}℃  最高峰 ${Math.round(s.maxElev * 4600)}m`);
  console.log(`  大陸 ${regions.landmasses.filter((l) => l.kind === 'continent').length} / 島 ${regions.landmasses.filter((l) => l.kind === 'island').length}  名所 ${marks.length}`);
  console.log(`  主要陸上バイオーム: ${land.sort((a, b) => b[1] - a[1]).slice(0, 6).map(([k, v]) => `${BIOMES[k].name} ${(v / lt * 100).toFixed(0)}%`).join(' / ')}`);
  console.log(`  → ${file}`);
}
