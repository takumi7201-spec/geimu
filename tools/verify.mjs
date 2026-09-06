#!/usr/bin/env node
/**
 * 生成器の回帰チェック。
 * 決定性（同じシード＝同じ世界）と、統計値が健全な範囲にあることを確認する。
 *
 *   node tools/verify.mjs [--seeds 6]
 */

import { generateWorld } from '../src/world/worldgen.js';
import { buildRegions, buildLandmarks } from '../src/world/regions.js';
import { BIOMES } from '../src/world/biomes.js';
import { ERAS } from '../src/world/eras.js';

const argSeeds = Number((process.argv.find((a, i) => process.argv[i - 1] === '--seeds') || 4));
const SEEDS = ['pangaea', 'tethys', 'gondwana', 'panthalassa', 'laurasia', 'deccan'].slice(0, Math.max(2, argSeeds));

const EXPECT = {
  triassic:   { land: [0.24, 0.40] },
  jurassic:   { land: [0.20, 0.36] },
  cretaceous: { land: [0.14, 0.30] },
};

let failures = 0;
const fail = (msg) => { console.error(`  ✗ ${msg}`); failures++; };
const pass = (msg) => console.log(`  ✓ ${msg}`);

console.log('中生代ワールドマップ 生成検証\n');

// ---- 1. 決定性 --------------------------------------------------------
{
  const a = await generateWorld({ seed: 'determinism', eraId: 'jurassic', size: 'small' });
  const b = await generateWorld({ seed: 'determinism', eraId: 'jurassic', size: 'small' });
  let diff = 0;
  for (let i = 0; i < a.elev.length; i++) if (a.elev[i] !== b.elev[i]) diff++;
  let bdiff = 0;
  for (let i = 0; i < a.biome.length; i++) if (a.biome[i] !== b.biome[i]) bdiff++;
  if (diff || bdiff) fail(`同一シードで結果が一致しない（標高 ${diff} / バイオーム ${bdiff} セル）`);
  else pass('決定性：同一シードから同一の世界が再現される');

  const c = await generateWorld({ seed: 'determinism-2', eraId: 'jurassic', size: 'small' });
  let same = 0;
  for (let i = 0; i < a.elev.length; i++) if (a.elev[i] === c.elev[i]) same++;
  if (same / a.elev.length > 0.98) fail('シードを変えても世界がほぼ同一');
  else pass('シードを変えると別の世界になる');
}

// ---- 2. 紀 × シードの健全性 -------------------------------------------
for (const era of ERAS) {
  console.log(`\n[${era.name}]`);
  for (const seed of SEEDS) {
    const w = await generateWorld({ seed, eraId: era.id, size: 'small' });
    const regions = buildRegions(w);
    const marks = buildLandmarks(w, regions);
    const s = w.stats;
    const tag = `${era.id}/${seed}`;

    const [lo, hi] = EXPECT[era.id].land;
    if (s.landRatio < lo || s.landRatio > hi) fail(`${tag}: 陸地率 ${(s.landRatio * 100).toFixed(1)}% が範囲外 (${lo * 100}〜${hi * 100}%)`);

    if (s.meanTemp < 13 || s.meanTemp > 24) fail(`${tag}: 平均気温 ${s.meanTemp.toFixed(1)}℃ が温室地球として不自然`);

    // 陸上バイオームの偏り
    const land = Object.entries(s.biomeCounts).filter(([k]) => !BIOMES[k].water);
    const lt = land.reduce((a, [, v]) => a + v, 0) || 1;
    const top = land.sort((a, b) => b[1] - a[1])[0];
    if (top && top[1] / lt > 0.35) fail(`${tag}: ${BIOMES[top[0]].name} が陸地の ${(top[1] / lt * 100).toFixed(0)}% を占め、気候分布が潰れている`);

    // 高山帯の過剰
    const alpine = (s.biomeCounts.alpine || 0) / lt;
    if (alpine > 0.06) fail(`${tag}: 高山帯が陸地の ${(alpine * 100).toFixed(1)}%（造山帯の外まで隆起している）`);

    // 左右端の継ぎ目。絶対値ではなく「隣接列の差の分布」と比べる。
    // 海上は大陸斜面の増幅で元々急なので、固定しきい値では判定できない。
    const colDiff = (a, b) => {
      let d = 0;
      for (let y = 0; y < w.h; y++) d += Math.abs(w.elev[y * w.w + a] - w.elev[y * w.w + b]);
      return d / w.h;
    };
    const seam = colDiff(0, w.w - 1);
    const diffs = [];
    for (let x = 1; x < w.w; x += 3) diffs.push(colDiff(x, x - 1));
    diffs.sort((a, b) => a - b);
    const p99 = diffs[Math.min(diffs.length - 1, (diffs.length * 0.99) | 0)];
    if (seam > p99 * 1.5) fail(`${tag}: 経度 0 に継ぎ目（差 ${seam.toFixed(4)} > 隣接列 p99 ${p99.toFixed(4)} の 1.5 倍）`);

    // 海が存在し、島もある
    if (!regions.seas.length) fail(`${tag}: 海域が検出されない`);
    if (!regions.landmasses.length) fail(`${tag}: 陸塊が検出されない`);
    if (marks.length < 6) fail(`${tag}: 名所が ${marks.length} 地点しかない`);

    // 河川が流れている
    let rivers = 0;
    for (const v of w.river) if (v >= 3) rivers++;
    if (rivers < 20) fail(`${tag}: 主要河川がほぼ無い（${rivers} セル）`);

    console.log(`  · ${seed.padEnd(13)} 陸地 ${(s.landRatio * 100).toFixed(1).padStart(5)}%  ` +
      `${s.meanTemp.toFixed(1)}℃  大陸 ${regions.landmasses.filter((l) => l.kind === 'continent').length}  ` +
      `島 ${regions.landmasses.filter((l) => l.kind === 'island').length}  名所 ${marks.length}`);
  }
}

console.log('');
if (failures) {
  console.error(`${failures} 件の問題が見つかりました`);
  process.exit(1);
}
console.log('すべての検証を通過しました');
