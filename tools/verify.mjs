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
import { eraAtAge, AGE_MIN, AGE_MAX } from '../src/world/timeline.js';
import { buildVoxelScene, pickScenicSpot, WATER_NONE } from '../src/voxel/scene.js';
import { VOX_M, BLOCKS, groundOf } from '../src/voxel/blocks.js';
import { spriteForGroup, SPRITE_FALLBACK } from '../src/voxel/models.js';
import { sprite, SPRITE_KEYS } from '../src/voxel/sprites.js';
import { FAUNA } from '../src/world/fauna.js';
import {
  createGameWorld, enterScene, findSpawn, sampleColumn, faunaNear,
  serializeScene, describeScene, SCENE_FORMAT, createBody, stepBody, columnTop, PHYS,
} from '../src/game/api.js';
import { Explorer } from '../src/game/player.js';

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

// ---- 3. 年代軸の連続性 -------------------------------------------------
console.log('\n[年代軸]');
{
  // プレート id は紀をまたいで一貫していること
  for (const era of ERAS) {
    const ids = era.cratons.map((c) => c.id);
    if (new Set(ids).size !== ids.length) fail(`${era.id}: 大陸核の id が重複している`);
    if (ids.some((i) => !i)) fail(`${era.id}: id の無い大陸核がある`);
  }

  // 補間した年代でも古地理が壊れないこと
  let prevLand = null, prevPos = null;
  for (let ma = AGE_MAX; ma >= AGE_MIN; ma -= 10) {
    const e = eraAtAge(ma);
    if (!e.cratons.length || !e.provinces.length) { fail(`${ma}Ma: 古地理が空`); continue; }
    if (e.belts.some((b) => b.h > 1.2 || b.h < 0)) fail(`${ma}Ma: 造山帯の高さが範囲外`);
    // プレートは飛ばずに動くこと（10Ma で経度 5% 以上跳ねたら補間が壊れている）
    const laur = e.cratons.find((c) => c.id === 'laurentia');
    if (laur && prevPos != null) {
      let d = Math.abs(laur.x - prevPos);
      if (d > 0.5) d = 1 - d;
      if (d > 0.05) fail(`${ma}Ma: laurentia が 10Ma で経度 ${(d * 100).toFixed(1)}% 跳んだ`);
    }
    if (laur) prevPos = laur.x;
  }
  pass(`${AGE_MIN}〜${AGE_MAX}Ma を 10Ma 刻みで補間し、プレートが連続して動く`);

  // 中間年代でも山脈がつぶれないこと
  for (const ma of [195, 125]) {
    const w = await generateWorld({ seed: 'pangaea', ma, size: 'small' });
    const peak = Math.round(w.stats.maxElev * 4600);
    if (peak < 3000) fail(`${ma}Ma: 最高峰が ${peak}m しかない（造山帯の補間が潰れている）`);
    if (w.stats.landRatio < 0.14 || w.stats.landRatio > 0.40) fail(`${ma}Ma: 陸地率 ${(w.stats.landRatio * 100).toFixed(1)}% が範囲外`);
    console.log(`  · ${ma}Ma  陸地 ${(w.stats.landRatio * 100).toFixed(1)}%  最高峰 ${peak}m  ${w.era.name}`);
  }

  // 陸地率は時代とともに単調に近く減る（海進が進む）
  const lands = [];
  for (const ma of [230, 195, 160, 125, 90]) {
    const w = await generateWorld({ seed: 'pangaea', ma, size: 'small' });
    lands.push(w.stats.landRatio);
  }
  for (let i = 1; i < lands.length; i++) {
    if (lands[i] > lands[i - 1] + 0.02) fail(`陸地率が時代とともに増えている（${lands.map((v) => (v * 100).toFixed(1)).join(' → ')}）`);
  }
  pass(`海進の傾向：陸地率 ${lands.map((v) => (v * 100).toFixed(1) + '%').join(' → ')}`);
}

// ---- 4. 動物のドット絵 -------------------------------------------------
console.log('\n[動物のドット絵]');
{
  // 絵が 10 枚揃っていなくても、どの種も代用の絵で描けること。
  // ここが落ちると、その分類の動物だけが画面から消える（気づきにくい）
  const resolve = (k) => (sprite(k) ? k : (SPRITE_FALLBACK[k] && sprite(SPRITE_FALLBACK[k]) ? SPRITE_FALLBACK[k] : null));
  const missing = [];
  const used = new Map();
  for (const [era, list] of Object.entries(FAUNA)) {
    for (const sp of list) {
      const want = spriteForGroup(sp.group);
      if (!resolve(want)) missing.push(`${era}/${sp.name}(${sp.group})→${want}`);
      used.set(want, (used.get(want) || 0) + 1);
    }
  }
  if (missing.length) fail(`絵に行き着かない種：${missing.slice(0, 4).join(' ')}`);
  else pass(`${[...used.values()].reduce((a, b) => a + b, 0)} 種すべてが絵に行き着く（絵 ${SPRITE_KEYS.length} 枚 / 種別 ${used.size} 分類）`);

  // 絵そのものが空でないこと（透明だけの PNG を取り込むと動物が見えなくなる）
  let blank = 0;
  for (const k of SPRITE_KEYS) {
    const s2 = sprite(k);
    let opaque = 0;
    for (let i = 3; i < s2.data.length; i += 4) if (s2.data[i] > 128) opaque++;
    if (opaque < 4) blank++;
  }
  if (blank) fail(`中身が空に近い絵が ${blank} 枚`);
  else pass('どの絵にも不透明な画素がある');

  const own = [...used.keys()].filter((k) => sprite(k));
  const sub = [...used.keys()].filter((k) => !sprite(k));
  if (sub.length) console.log(`  · 専用の絵 ${own.length} 分類 / 代用 ${sub.length} 分類（${sub.join('・')}）`);
}

// ---- 5. 地表ボクセル ---------------------------------------------------
console.log('\n[地表ボクセル]');
{
  const w = await generateWorld({ seed: 'pangaea', ma: 160, size: 'small' });
  const regions = buildRegions(w);
  const marks = buildLandmarks(w, regions);

  // 決定性
  const spot = pickScenicSpot(w, marks, 'verify');
  const a = await buildVoxelScene(w, { x: spot.x, y: spot.y, size: 'small' });
  const b = await buildVoxelScene(w, { x: spot.x, y: spot.y, size: 'small' });
  let diff = 0;
  for (let i = 0; i < a.height.length; i++) if (a.height[i] !== b.height[i] || a.surf[i] !== b.surf[i]) diff++;
  if (diff) fail(`ボクセル区画が同じ入力で再現されない（${diff} 列）`);
  else if (a.props.length !== b.props.length || a.fauna.length !== b.fauna.length) fail('植物・動物の配置が再現されない');
  else pass('決定性：同じ地点からは同じ区画が組み上がる');

  // 複数の地点で健全性を見る
  let inlandWater = 0, sceneCount = 0, landScenes = 0;
  for (const variant of ['a', 'b', 'c', 'd', 'e']) {
    const p = pickScenicSpot(w, marks, variant);
    const s = await buildVoxelScene(w, { x: p.x, y: p.y, size: 'small', variant });
    sceneCount++;
    const tag = `区画 ${variant}`;

    // 値の健全性
    let bad = 0, wet = 0, land = 0, floating = 0;
    for (let i = 0; i < s.height.length; i++) {
      const hb = s.height[i], wl = s.water[i];
      if (!Number.isFinite(hb) || Math.abs(hb) > 4000) bad++;
      if (wl !== WATER_NONE) {
        wet++;
        // 水面は必ず地面より上にある（下にあると地面の中に水が埋まる）
        if (wl <= hb) floating++;
      } else land++;
      if (!BLOCKS[s.surf[i]]) bad++;
    }
    if (bad) fail(`${tag}: 標高または地表ブロックが不正な列が ${bad} 本`);
    if (floating) fail(`${tag}: 地面の中に埋まった水面が ${floating} 列`);
    if (wet / s.height.length > 0.985) fail(`${tag}: 区画がほぼ全面水没している`);
    if (land / s.height.length > 0.02) landScenes++;

    // 陸の草木が水に沈んでいない／翼竜は地面より上を飛ぶ
    let drowned = 0;
    for (const pr of s.props) {
      const i = pr.z * s.total + pr.x;
      const wl = s.water[i];
      const underwater = wl !== WATER_NONE && wl > s.height[i];
      const kindIsWater = ['coral', 'algae'].includes(s.models[pr.m].kind);
      if (underwater && !kindIsWater && pr.y <= wl - 2) drowned++;
    }
    if (drowned > s.props.length * 0.02) fail(`${tag}: 水没した陸生植物が ${drowned} 株`);
    for (const f of s.fauna) {
      const i = f.z * s.total + f.x;
      if (f.y < s.height[i]) fail(`${tag}: ${f.name} が地面に埋まっている`);
    }
    if (s.fauna.length > 60) fail(`${tag}: 動物が ${s.fauna.length} 頭と多すぎる`);

    // 起伏：真っ平らな板になっていない
    let lo = 1e9, hi = -1e9;
    for (let i = 0; i < s.height.length; i++) { if (s.height[i] < lo) lo = s.height[i]; if (s.height[i] > hi) hi = s.height[i]; }
    const relief = (hi - lo) * VOX_M;
    if (relief < 25) fail(`${tag}: 標高差が ${relief}m しかなく、地形が平板`);
    if (relief > 6000) fail(`${tag}: 標高差 ${relief}m は 3km 四方の起伏として過大`);

    let inland = 0;
    for (let i = 0; i < s.height.length; i++) if (s.height[i] > 0 && s.water[i] !== WATER_NONE) inland++;
    if (inland > s.height.length * 0.002) inlandWater++;

    console.log(`  · ${variant}  ${s.total}²  標高差 ${relief.toLocaleString()}m  水面 ${(wet / s.height.length * 100).toFixed(0)}%  ` +
      `植物 ${s.props.length}  動物 ${s.fauna.length}  ${s.meta.biomes.slice(0, 2).map((x) => BIOMES[x.id].name).join('/')}`);
  }
  if (landScenes === 0) fail('陸を含む区画が一つも作られない');
  if (!inlandWater) fail('河川も湖もある区画が一つも無い（水系が機能していない）');
  else pass(`${sceneCount} 区画中 ${inlandWater} 区画に河川・湖がある`);

  // 乾燥地の植生は森より薄い
  const veg = (id) => groundOf(id).veg;
  if (!(veg('desert') < veg('araucaria') * 0.3)) fail('砂漠の植生密度が森と変わらない');
  else pass('植生密度：砂漠 < 森');
}

// ---- 5. ゲーム層（当たり判定・出現・書き出し） --------------------------
console.log('\n[ゲーム層]');
{
  const game = await createGameWorld({ seed: 'pangaea', ma: 160, size: 'small' });
  const scene = await enterScene(game, null, { size: 'small', variant: 'game' });

  // 出現地点：水没していない・幹の中でない・立てる
  const spawn = findSpawn(scene);
  const si = (spawn.z | 0) * scene.total + (spawn.x | 0);
  if (scene.blockers[si]) fail('出現地点が幹や岩の中にある');
  if (scene.water[si] !== WATER_NONE && scene.water[si] > scene.height[si]) fail('出現地点が水没している');
  else pass(`出現地点 (${spawn.x.toFixed(1)}, ${spawn.z.toFixed(1)}) は陸で、立てる`);

  // 落下：空中から落として地面で止まること、地面にめり込まないこと
  const body = createBody(scene, spawn.x, spawn.z);
  body.y = columnTop(scene, spawn.x, spawn.z) + 30;
  for (let i = 0; i < 300; i++) stepBody(scene, body, { forward: 0, strafe: 0, yaw: 0 }, 1 / 60);
  const ground = columnTop(scene, body.x, body.z);
  if (Math.abs(body.y - ground) > 0.01) fail(`落下後に地面に止まらない（y=${body.y.toFixed(2)} 地面=${ground}）`);
  else pass('重力：空中から落ちて地面でちょうど止まる');

  // 歩行：地面をなぞって進み、どのフレームでもめり込まない
  const walker = createBody(scene, spawn.x, spawn.z);
  let sink = 0, moved = 0;
  const start = { x: walker.x, z: walker.z };
  for (let i = 0; i < 900; i++) {
    stepBody(scene, walker, { forward: 1, strafe: 0, yaw: i * 0.004, run: i > 400 }, 1 / 60);
    sink = Math.max(sink, columnTop(scene, walker.x, walker.z) - walker.y);
    if (!Number.isFinite(walker.x) || !Number.isFinite(walker.y)) { fail('移動で座標が壊れた'); break; }
  }
  moved = Math.hypot(walker.x - start.x, walker.z - start.z);
  if (sink > 0.01) fail(`歩行中に地面へ ${(sink * VOX_M).toFixed(1)}m めり込む`);
  else if (moved < 5) fail(`900 フレーム歩いて ${moved.toFixed(1)} ブロックしか進まない`);
  else pass(`歩行：${(moved * VOX_M).toFixed(0)}m 進み、地面にめり込まない`);

  // 区画の外へは出ない
  const runner = createBody(scene, spawn.x, spawn.z);
  runner.fly = true;
  for (let i = 0; i < 2000; i++) stepBody(scene, runner, { forward: 1, strafe: 0, yaw: 0.6, run: true }, 1 / 60);
  if (runner.x < 1 || runner.z < 1 || runner.x > scene.total - 1 || runner.z > scene.total - 1) {
    fail(`区画の外に出た（${runner.x.toFixed(0)}, ${runner.z.toFixed(0)}）`);
  } else pass('飛行しても区画の外には出ない');

  // 幹は壁になる
  let trunk = -1;
  for (let i = 0; i < scene.blockers.length; i++) if (scene.blockers[i] > 2) { trunk = i; break; }
  if (trunk >= 0) {
    const tx = trunk % scene.total, tz = (trunk / scene.total) | 0;
    const h = scene.height[trunk];
    const b = createBody(scene, tx - 2.5, tz + 0.5);
    b.y = h;
    // 幹へ向かって歩き続けても、幹の柱には入り込まない
    for (let i = 0; i < 240; i++) stepBody(scene, b, { forward: 1, strafe: 0, yaw: Math.PI / 2 }, 1 / 60);
    const inside = (b.x | 0) === tx && (b.z | 0) === tz;
    if (inside) fail('幹の中に入り込める（当たり判定が効いていない）');
    else pass('幹と岩は壁として止まる');
  }

  // Explorer：キー入力で動き、飛行で浮く
  const ex = new Explorer(scene, spawn);
  ex.key('KeyW', true);
  for (let i = 0; i < 120; i++) ex.update(1 / 60);
  const st1 = ex.status();
  if (st1.speed < 0.5) fail('Explorer が前進しない');
  ex.key('KeyW', false);
  ex.key('KeyV', true);         // 飛行に切り替え
  ex.key('Space', true);
  const y0 = ex.body.y;
  for (let i = 0; i < 120; i++) ex.update(1 / 60);
  if (!ex.flying || ex.body.y <= y0 + 1) fail('飛行モードで上昇しない');
  else pass(`Explorer：前進 ${(st1.speed * VOX_M).toFixed(0)}m/s、飛行で ${((ex.body.y - y0) * VOX_M).toFixed(0)}m 上昇`);

  // 問い合わせ API
  const col = sampleColumn(scene, spawn.x, spawn.z);
  if (!col.biomeName || !col.blockName) fail('sampleColumn が環境を返さない');
  if (!Number.isFinite(col.tempC)) fail('sampleColumn の気温が数値でない');
  const near = faunaNear(scene, spawn.x, spawn.z, scene.total);
  if (near.length !== scene.fauna.length) fail('faunaNear が全個体を拾えない');

  // 書き出し：フォーマットと配列の長さ
  const json = serializeScene(scene);
  const cells = scene.total * scene.total;
  if (json.format !== SCENE_FORMAT) fail('書き出しの format が一致しない');
  if (describeScene(scene).blocks !== scene.total) fail('describeScene のブロック数が合わない');
  // base64 は 3 バイトが 4 文字になる（Int16 なので 1 セル 2 バイト）
  const expect16 = Math.ceil((cells * 2) / 3) * 4;
  const expect8 = Math.ceil(cells / 3) * 4;
  if (json.arrays.height.data.length !== expect16) fail('高さマップの書き出し長が合わない');
  if (json.arrays.surface.data.length !== expect8) fail('地表ブロックの書き出し長が合わない');
  if (json.models.length !== scene.models.length || json.props.length !== scene.props.length) fail('モデル・植生の書き出し数が合わない');
  else pass(`書き出し：${json.models.length} モデル / ${json.props.length} 株 / ${json.fauna.length} 頭 と ${cells.toLocaleString()} セルの地形`);
}

console.log('');
if (failures) {
  console.error(`${failures} 件の問題が見つかりました`);
  process.exit(1);
}
console.log('すべての検証を通過しました');
