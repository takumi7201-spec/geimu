/**
 * ゲームから使うための入口。
 *
 * アトラス（UI）とは独立していて、ここだけを import すれば
 *   世界を作る → 一区画に降りる → 立てる場所を探す → 環境を問い合わせる
 *   → 他のエンジンへ書き出す
 * までができる。DOM に依存しないので Node からも動く。
 *
 *   const game = await createGameWorld({ seed: 'pangaea', ma: 160 });
 *   const scene = await enterScene(game, { x: 512, y: 300 });
 *   const spawn = findSpawn(scene);
 *   const body = createBody(scene, spawn.x, spawn.z);
 */

import { generateWorld, SIZES } from '../world/worldgen.js';
import { buildRegions, buildLandmarks } from '../world/regions.js';
import { BIOMES } from '../world/biomes.js';
import { faunaFor } from '../world/fauna.js';
import { buildVoxelScene, pickScenicSpot, SCENE_SIZES, WATER_NONE } from '../voxel/scene.js';
import { BLOCKS, VOX_M } from '../voxel/blocks.js';
import { columnTop, waterTop, createBody, stepBody, raycast, eyeOf, PHYS } from './physics.js';

export { createBody, stepBody, raycast, eyeOf, PHYS, columnTop, waterTop };
export { SIZES as WORLD_SIZES, SCENE_SIZES, VOX_M, WATER_NONE };

/** 書き出しフォーマットの版。読み込む側はこれを見て互換を判断する */
export const SCENE_FORMAT = 'mesozoic-voxel-scene/1';

/**
 * 世界（マップ）を作る。ゲームでは起動時に一度だけ呼べばよい。
 * @param {{seed?:string, ma?:number, size?:string}} opts
 */
export async function createGameWorld(opts = {}, onProgress = () => {}) {
  const world = await generateWorld(
    { seed: opts.seed ?? 'pangaea', ma: opts.ma ?? 160, size: opts.size ?? 'medium' },
    onProgress,
  );
  const regions = buildRegions(world);
  const marks = buildLandmarks(world, regions);
  return { world, regions, marks };
}

/**
 * 世界の一区画に降りる（ボクセル地形を組む）。
 * spot を省くと河口や海岸など見応えのある場所を選ぶ。
 */
export async function enterScene(game, spot = null, opts = {}, onProgress = () => {}) {
  const target = spot || pickScenicSpot(game.world, game.marks, opts.variant || '');
  return buildVoxelScene(
    game.world,
    { x: target.x, y: target.y, size: opts.size || 'medium', variant: opts.variant || '', from: target.from },
    onProgress,
  );
}

/**
 * 立てる出現地点を探す。
 * 中心から渦巻き状に見て、水没していない・急すぎない柱を選ぶ。
 */
const zi = (scene, x, z) => (z | 0) * scene.total + (x | 0);

export function findSpawn(scene, opts = {}) {
  const { preferDry = true, maxSlope = 2 } = opts;
  const c = Math.floor(scene.total / 2);
  const step = Math.max(1, Math.floor(scene.cols / 48));
  let fallback = null;
  for (let r = 0; r < scene.cols; r += step) {
    for (let k = 0; k < Math.max(1, r * 4); k += step) {
      // 半径 r の正方リング上を歩く
      const t = r === 0 ? 0 : (k / Math.max(1, r * 4)) * 4;
      const side = Math.floor(t) % 4;
      const f = (t % 1) * 2 - 1;
      const x = c + Math.round(side === 0 ? r : side === 1 ? -f * r : side === 2 ? -r : f * r);
      const z = c + Math.round(side === 0 ? f * r : side === 1 ? r : side === 2 ? -f * r : -r);
      if (x < 2 || z < 2 || x >= scene.total - 2 || z >= scene.total - 2) continue;
      const h = columnTop(scene, x, z);
      const w = waterTop(scene, x, z);
      const slope = Math.max(
        Math.abs(columnTop(scene, x + 1, z) - h), Math.abs(columnTop(scene, x - 1, z) - h),
        Math.abs(columnTop(scene, x, z + 1) - h), Math.abs(columnTop(scene, x, z - 1) - h),
      );
      const dry = !(w > h);
      // 幹や岩のなかはもちろん、木立の隙間にも出さない。
      // 5×5 が空いていないと、探索モードに入った瞬間に幹と葉で画面が埋まる
      let crowded = false;
      if (scene.blockers) {
        for (let dz = -2; dz <= 2 && !crowded; dz++) {
          for (let dx = -2; dx <= 2; dx++) {
            if (scene.blockers[zi(scene, x + dx, z + dz)]) { crowded = true; break; }
          }
        }
      }
      if (crowded) continue;
      if (!fallback) fallback = { x: x + 0.5, z: z + 0.5, y: Math.max(h, w === -Infinity ? h : w) };
      if (slope > maxSlope) continue;
      if (preferDry && !dry) continue;
      return { x: x + 0.5, z: z + 0.5, y: h };
    }
  }
  return fallback || { x: c + 0.5, z: c + 0.5, y: columnTop(scene, c, c) };
}

/** 1 本の柱の環境を問い合わせる（UI 表示にも AI の判断にも使える） */
export function sampleColumn(scene, x, z) {
  const t = scene.total;
  const xi = Math.min(t - 1, Math.max(0, x | 0));
  const zi = Math.min(t - 1, Math.max(0, z | 0));
  const i = zi * t + xi;
  const h = scene.height[i];
  const w = scene.water[i];
  const biomeId = scene.biomeKeys[scene.biomeAt[i]];
  const altM = h * VOX_M;
  return {
    x: xi, z: zi, index: i,
    height: h,
    elevM: altM,
    water: w === WATER_NONE ? null : w,
    depthM: w !== WATER_NONE && w > h ? (w - h) * VOX_M : 0,
    biomeId,
    biomeName: BIOMES[biomeId].name,
    isWater: !!BIOMES[biomeId].water,
    block: BLOCKS[scene.surf[i]].id,
    blockName: BLOCKS[scene.surf[i]].name,
    wetness: scene.wetness[i],
    // 気温は区画の基準値から高度分だけ下げる（6.2℃/km）
    tempC: scene.meta.tempC - Math.max(0, altM - scene.meta.baseElevM) * 0.0062,
    fauna: faunaFor(scene.era.id, biomeId).map((f) => f.name),
  };
}

/** 半径 r ブロック以内の動物を近い順に返す */
export function faunaNear(scene, x, z, r = 40) {
  return scene.fauna
    .map((f) => ({ ...f, dist: Math.hypot(f.x - x, f.z - z) }))
    .filter((f) => f.dist <= r)
    .sort((a, b) => a.dist - b.dist);
}

/** 区画のあらまし（HUD やセーブのメタ情報に） */
export function describeScene(scene) {
  return {
    format: SCENE_FORMAT,
    seed: scene.seed,
    ma: Math.round(scene.era.ma),
    era: scene.era.name,
    at: { x: scene.x, y: scene.y, lat: scene.meta.lat, lon: scene.meta.lon },
    blocks: scene.total,
    blockM: VOX_M,
    spanM: scene.meta.spanM,
    biomes: scene.meta.biomes,
    props: scene.props.length,
    fauna: scene.fauna.length,
  };
}

// ---- 他のエンジンへ渡す -------------------------------------------------

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
/** Buffer にも atob にも頼らない base64（Node とブラウザで同じ結果） */
export function toBase64(bytes) {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i], b = bytes[i + 1], c = bytes[i + 2];
    out += B64[a >> 2];
    out += B64[((a & 3) << 4) | ((b || 0) >> 4)];
    out += i + 1 < bytes.length ? B64[((b & 15) << 2) | ((c || 0) >> 6)] : '=';
    out += i + 2 < bytes.length ? B64[c & 63] : '=';
  }
  return out;
}

/**
 * 区画を JSON にする。Unity / Godot / three.js などに渡して、
 * 同じ地形・同じ植生をそのまま組み立てられる形にしてある。
 *
 * height は Int16（ブロック単位）、water は同じ長さで -32768 が「水なし」、
 * surf はブロック表のインデックス。いずれも行優先（z * total + x）。
 */
export function serializeScene(scene, opts = {}) {
  const bytes = (arr) => toBase64(new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength));
  const out = {
    format: SCENE_FORMAT,
    meta: describeScene(scene),
    blockSizeM: VOX_M,
    size: scene.total,
    waterNone: WATER_NONE,
    palette: BLOCKS.map((b) => ({ id: b.id, name: b.name, color: b.color })),
    biomes: scene.biomeKeys.map((id) => ({ id, name: BIOMES[id].name, water: !!BIOMES[id].water })),
    arrays: {
      height: { type: 'int16', data: bytes(scene.height) },
      blockers: { type: 'uint8', data: bytes(scene.blockers) },
      water: { type: 'int16', data: bytes(scene.water) },
      surface: { type: 'uint8', data: bytes(scene.surf) },
      biome: { type: 'uint8', data: bytes(scene.biomeAt) },
    },
    models: scene.models.map((m) => ({
      kind: m.kind, unit: m.unit,
      boxes: m.boxes.map((b) => [b.x, b.y, b.z, b.w, b.h, b.d, b.b]),
    })),
    props: scene.props.map((p) => [p.m, p.x, p.y, p.z, p.rot]),
    fauna: scene.fauna.map((f) => ({
      sprite: f.sprite, x: f.x, y: f.y, z: f.z, yaw: f.yaw,
      name: f.name, latin: f.latin, group: f.group, sizeM: f.size,
    })),
  };
  if (opts.withArrays === false) delete out.arrays;
  return out;
}
