/**
 * 地表ボクセルの当たり判定と移動。
 *
 * 地形は「柱の高さマップ」なので、当たり判定も高さマップだけで済ませる。
 * ブロックを一つずつ持たない代わりにオーバーハングは表現できないが、
 * 判定は O(1) で、区画が 4.6km 四方でもフレーム落ちしない。
 *
 * 単位はブロック（1 ブロック = 6m、`VOX_M`）と秒。DOM に依存しないので
 * Node からも動かせる（`npm test` が挙動を確認している）。
 */

import { WATER_NONE } from '../voxel/scene.js';
import { clamp } from '../core/rng.js';

/**
 * 動きの定数。
 * 1 ブロック 6m なので実寸に合わせると人間サイズは 0.28 ブロックしかなく、
 * 歩いても景色が動かない。目線 2 ブロック（12m）＝大型恐竜の視点にして、
 * 速度もゲームとして気持ちよい値に寄せてある。
 */
export const PHYS = {
  gravity: 22,      // ブロック/秒²
  walk: 3.4,        // 歩き
  run: 8.0,         // 走り（Shift）
  swimSpeed: 2.2,
  jump: 8.5,
  flySpeed: 14,
  accel: 14,        // 接地時の加速
  airAccel: 4,
  friction: 10,
  step: 1.0,        // 登れる段差（ブロック）
  eye: 2.0,         // 目線の高さ
  radius: 0.45,     // 体の半径
  waterDrag: 3.2,
  buoyancy: 13.0,   // 重力の半分（水中の実効重力）より大きくして水面に浮かせる
};

const at = (scene, x, z) => {
  const t = scene.total;
  const xi = clamp(x | 0, 0, t - 1);
  const zi = clamp(z | 0, 0, t - 1);
  return zi * t + xi;
};

/** その位置に立てる高さ（柱の天面）。ブロック単位 */
export function columnTop(scene, x, z) {
  return scene.height[at(scene, x, z)];
}

/** 水面の高さ。水が無ければ -Infinity */
export function waterTop(scene, x, z) {
  const w = scene.water[at(scene, x, z)];
  return w === WATER_NONE ? -Infinity : w;
}

/** 幹や岩を含めた「ぶつかる高さ」。地面には立てるが、幹の上には立てない */
export function obstacleTop(scene, x, z) {
  const i = at(scene, x, z);
  const b = scene.blockers ? scene.blockers[i] : 0;
  return scene.height[i] + b;
}

/**
 * 体が占める正方形と重なる柱のうち、いちばん高い天面。
 * kind='ground' は立てる高さ、'block' は幹・岩を含めたぶつかる高さ。
 */
function topAround(scene, x, z, r, kind = 'ground') {
  const f = kind === 'block' ? obstacleTop : columnTop;
  let top = -Infinity;
  for (const dx of [-r, r]) {
    for (const dz of [-r, r]) {
      const h = f(scene, x + dx, z + dz);
      if (h > top) top = h;
    }
  }
  return top;
}

/** 出現・移動に使う体を作る */
export function createBody(scene, x, z, opts = {}) {
  const y = Math.max(columnTop(scene, x, z), waterTop(scene, x, z) === -Infinity ? -Infinity : waterTop(scene, x, z));
  return {
    x, z, y: Number.isFinite(y) ? y : 0,
    vx: 0, vy: 0, vz: 0,
    onGround: true, inWater: false, submerged: false,
    fly: false,
    ...opts,
  };
}

/**
 * 1 フレーム進める。
 * @param {object} scene   buildVoxelScene() の結果
 * @param {object} body    createBody() の結果
 * @param {{forward:number, strafe:number, up:number, yaw:number, jump:boolean, run:boolean}} input
 * @param {number} dt      秒
 */
export function stepBody(scene, body, input, dt) {
  dt = clamp(dt, 0, 0.05);                     // 大きく飛ぶとすり抜けるので上限を切る
  const yaw = input.yaw || 0;
  const cos = Math.cos(yaw), sin = Math.sin(yaw);
  // yaw は「+Z を向いて 0」。前進は視線方向、右移動はその 90 度右
  const fx = -sin, fz = -cos;
  const sx = cos, sz = -sin;

  const wTop = waterTop(scene, body.x, body.z);
  body.inWater = wTop > body.y + 0.1;
  body.submerged = wTop > body.y + PHYS.eye * 0.85;

  let speed = input.run ? PHYS.run : PHYS.walk;
  if (body.fly) speed = PHYS.flySpeed * (input.run ? 1.8 : 1);
  else if (body.inWater) speed = PHYS.swimSpeed;

  const wishX = fx * (input.forward || 0) + sx * (input.strafe || 0);
  const wishZ = fz * (input.forward || 0) + sz * (input.strafe || 0);
  const len = Math.hypot(wishX, wishZ) || 1;
  const nx = (wishX / len) * (Math.min(1, Math.hypot(input.forward || 0, input.strafe || 0)) * speed);
  const nz = (wishZ / len) * (Math.min(1, Math.hypot(input.forward || 0, input.strafe || 0)) * speed);

  const accel = body.onGround || body.fly || body.inWater ? PHYS.accel : PHYS.airAccel;
  body.vx += (nx - body.vx) * Math.min(1, accel * dt);
  body.vz += (nz - body.vz) * Math.min(1, accel * dt);
  if (!input.forward && !input.strafe) {
    const f = Math.min(1, PHYS.friction * dt);
    body.vx -= body.vx * f;
    body.vz -= body.vz * f;
  }

  // --- 上下 ---
  if (body.fly) {
    body.vy += ((input.up || 0) * PHYS.flySpeed - body.vy) * Math.min(1, 10 * dt);
  } else if (body.inWater) {
    // 水中：浮力と抵抗。ジャンプキーで浮上する
    body.vy += (PHYS.buoyancy - PHYS.gravity * 0.5) * dt;
    if (input.jump) body.vy += PHYS.buoyancy * 0.6 * dt;
    body.vy -= body.vy * Math.min(1, PHYS.waterDrag * dt);
  } else {
    if (input.jump && body.onGround) { body.vy = PHYS.jump; body.onGround = false; }
    body.vy -= PHYS.gravity * dt;
  }

  // --- 水平移動（軸ごとに試し、段差は乗り越える） ---
  const r = PHYS.radius;
  const tryAxis = (dx, dz) => {
    const px = body.x + dx, pz = body.z + dz;
    // 幹や岩は壁。地面は段差 step までよじ登れる
    const wall = topAround(scene, px, pz, r, 'block');
    const ground = topAround(scene, px, pz, r);
    if (wall <= body.y + PHYS.step + 1e-6 || body.fly) {
      body.x = px; body.z = pz;
      if (!body.fly && ground > body.y) { body.y = ground; body.vy = Math.max(body.vy, 0); }
      return true;
    }
    return false;
  };
  if (!tryAxis(body.vx * dt, 0)) body.vx = 0;
  if (!tryAxis(0, body.vz * dt)) body.vz = 0;

  // --- 落下と着地 ---
  body.y += body.vy * dt;
  const ground = topAround(scene, body.x, body.z, r);
  if (body.y <= ground) {
    body.y = ground;
    if (body.vy < 0) body.vy = 0;
    body.onGround = true;
  } else {
    body.onGround = false;
  }
  // 水面より上には浮き上がらせない（水面で頭が飛び出したままにしない）
  if (body.inWater && !body.fly && body.y > wTop) { body.y = wTop; body.vy = Math.min(body.vy, 0); }

  // 区画の外へは出さない
  const lim = scene.total - 2;
  body.x = clamp(body.x, 2, lim);
  body.z = clamp(body.z, 2, lim);
  return body;
}

/** 目の位置（描画のカメラ位置） */
export function eyeOf(body) {
  return [body.x, body.y + PHYS.eye, body.z];
}

/**
 * 高さマップに対するレイキャスト。
 * @returns {{x:number, z:number, y:number, dist:number}|null}
 */
export function raycast(scene, origin, dir, maxDist = 400) {
  const t0 = scene.total;
  for (let t = 0.3; t < maxDist; t += Math.max(0.25, t * 0.004)) {
    const px = origin[0] + dir[0] * t;
    const py = origin[1] + dir[1] * t;
    const pz = origin[2] + dir[2] * t;
    if (px < 0 || pz < 0 || px >= t0 || pz >= t0) {
      if (py < -60) return null;
      continue;
    }
    const i = (pz | 0) * t0 + (px | 0);
    const w = scene.water[i];
    const top = w !== WATER_NONE && w > scene.height[i] ? w : scene.height[i];
    if (py <= top) return { x: px | 0, z: pz | 0, y: top, dist: t, i };
  }
  return null;
}
