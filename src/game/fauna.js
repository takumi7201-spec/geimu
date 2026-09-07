/**
 * 動物の振る舞い。歩き回り、こちらに気づき、追うか逃げるかする。
 *
 * 絵は 1 枚きりなので、脚を描き分けることはできない。動きは
 *   ・実際に位置が変わること
 *   ・上下の揺れと前傾（描画側が phase から作る）
 * の二つで見せる。歩幅の速さ（phase の進み）は速度に比例させるので、
 * 走ると足踏みも速くなる。
 *
 * DOM も WebGL も触らない。Node からも回せる。
 */

import { clamp, angleDelta } from '../core/rng.js';
import { columnTop, waterTop, obstacleTop } from './physics.js';
import { WATER_NONE } from '../voxel/scene.js';

export const FAUNA_PHYS = {
  walk: 0.9,        // ブロック/秒（1 ブロック 6m なので 5.4 m/s ほど）
  run: 2.6,
  fly: 1.8,
  swim: 1.2,
  turn: 2.6,        // rad/秒。これ以上速く向きを変えると、板の反転がちらつく
  sense: 70,        // こちらに気づく距離（ブロック＝420m）。狭いと森で一生すれ違う
  lunge: 4.0,       // 肉食がここまで詰めたら噛みつきに入る
  flee: 11,         // 草食が逃げ出す距離（ブロック＝66m）。遠すぎると、降りた途端に散ってしまう
  roam: 46,         // 生まれた場所からこれ以上は離れない（群れが散らばりきらない）
  stepUp: 1.2,      // 登れる段差。これを超える壁は迂回する
};

/** 群れを動かせる形に整える。scene を作り直したときに一度だけ呼ぶ */
export function initFauna(scene) {
  if (!scene || !scene.fauna) return;
  for (const f of scene.fauna) {
    f.state = 'idle';
    f.speed = 0;
    f.timer = 0.6 + (f.phase / (Math.PI * 2)) * 3.2;   // 群れが一斉に動き出さないようずらす
    f.goal = null;
    f.lunge = 0;
    if (!f.home) f.home = { x: f.x, z: f.z };
    if (f.phase === undefined) f.phase = 0;
  }
  scene._faunaReady = true;
}

/** その地点で立てる高さ。段差が急なら null（そこへは進めない） */
function standAt(scene, x, z, fromY) {
  const T = scene.total;
  if (x < 2 || z < 2 || x > T - 3 || z > T - 3) return null;
  const g = columnTop(scene, x, z);
  const ob = obstacleTop(scene, x, z);
  const top = Math.max(g, ob);
  if (fromY !== undefined && top - fromY > FAUNA_PHYS.stepUp) return null;
  return top + 1;
}

/** 群れをひとつ進める。player は { x, z } でよい（居なければ null） */
export function stepFauna(scene, dt, player = null) {
  if (!scene || !scene.fauna || !scene.fauna.length) return;
  if (!scene._faunaReady) initFauna(scene);
  const P = FAUNA_PHYS;
  const step = Math.min(dt, 0.05);          // 大きな dt でも壁をすり抜けない
  let left = Math.min(dt, 0.25);

  while (left > 0) {
    const d = Math.min(step, left);
    left -= d;
    for (const f of scene.fauna) stepOne(scene, f, d, player, P);
  }
}

function stepOne(scene, f, dt, player, P) {
  const dist = player ? Math.hypot(player.x - f.x, player.z - f.z) : Infinity;
  const hunter = f.diet === '肉' || f.diet === '魚';

  // ---- 何をするか決める ------------------------------------------------
  f.timer -= dt;
  if (dist < P.sense && player) {
    // 気づいたら、追うか逃げるか。魚食は水の中の相手にしか関心を示さない
    if (hunter && !f.swimming) {
      f.state = dist < P.lunge ? 'attack' : 'run';
      f.goal = { x: player.x, z: player.z };
    } else if (!hunter && dist < P.flee) {
      f.state = 'run';
      const a = Math.atan2(f.z - player.z, f.x - player.x);
      f.goal = { x: f.x + Math.cos(a) * 20, z: f.z + Math.sin(a) * 20 };
    }
  } else if (f.timer <= 0) {
    // 気ままに歩く。生まれた場所から離れすぎたら戻る
    const away = Math.hypot(f.x - f.home.x, f.z - f.home.z);
    if (f.state === 'walk' || f.state === 'run') {
      f.state = 'idle';
      f.timer = 1.2 + (f.phase % 1) * 2.6;
      f.goal = null;
    } else {
      f.state = 'walk';
      f.timer = 2.4 + (f.phase % 1) * 4.0;
      const a = away > P.roam
        ? Math.atan2(f.home.z - f.z, f.home.x - f.x) + (Math.sin(f.phase * 7) * 0.6)
        : f.yaw + Math.sin(f.phase * 3 + f.timer) * 1.8;
      const reach = 8 + (f.phase % 1) * 14;
      f.goal = { x: f.x + Math.cos(a) * reach, z: f.z + Math.sin(a) * reach };
    }
  }

  // 噛みついたら、間合いを取り直す
  if (f.state === 'attack') {
    f.lunge += dt;
    if (f.lunge > 1.1) { f.lunge = 0; f.state = dist < P.sense ? 'run' : 'idle'; f.timer = 0.8; }
  } else {
    f.lunge = 0;
  }

  // ---- 向きと速さ ------------------------------------------------------
  let want = 0;
  if (f.state === 'walk') want = P.walk;
  else if (f.state === 'run') want = P.run;
  else if (f.state === 'attack') want = P.walk * 0.5;
  if (f.flying) want = f.state === 'idle' ? P.fly * 0.6 : P.fly;      // 翼竜は止まらない
  else if (f.swimming) want = Math.max(want, P.swim * 0.5);

  if (f.goal) {
    const target = Math.atan2(f.goal.z - f.z, f.goal.x - f.x);
    f.yaw += clamp(angleDelta(f.yaw, target), -P.turn * dt, P.turn * dt);
  } else if (f.flying) {
    f.yaw += dt * 0.35;      // 何もないときは大きく旋回する
  }

  f.speed += (want - f.speed) * Math.min(1, dt * 5);
  f.phase += dt * (1.6 + f.speed * 3.4);    // 速いほど足が速く動く

  // ---- 進む ------------------------------------------------------------
  const nx = f.x + Math.cos(f.yaw) * f.speed * dt;
  const nz = f.z + Math.sin(f.yaw) * f.speed * dt;

  if (f.flying) {
    const ground = columnTop(scene, nx | 0, nz | 0);
    const T = scene.total;
    if (nx > 2 && nz > 2 && nx < T - 3 && nz < T - 3) { f.x = nx; f.z = nz; }
    else { f.yaw += Math.PI * 0.6; }         // 縁で折り返す
    // 地面すれすれには降りない。高さはゆっくり戻す
    // 高く飛ばせると、真下に降りても見上げないと目に入らない
    const want2 = ground + 5.5 + Math.sin(f.phase * 0.35) * 2;
    f.y += (want2 - f.y) * Math.min(1, dt * 0.8);
    return;
  }

  if (f.swimming) {
    const T = scene.total;
    const i = (nz | 0) * T + (nx | 0);
    const wl = scene.water[i];
    const bed = scene.height[i];
    // 水から出ない。岸に当たったら向きを変える
    if (nx > 2 && nz > 2 && nx < T - 3 && nz < T - 3 && wl !== WATER_NONE && wl > bed + 1) {
      f.x = nx; f.z = nz;
      f.y += ((bed + Math.min(2.2, (wl - bed) * 0.5)) - f.y) * Math.min(1, dt * 2);
    } else {
      f.yaw += Math.PI * 0.55;
    }
    return;
  }

  const top = standAt(scene, nx | 0, nz | 0, f.y - 1);
  if (top !== null) {
    f.x = nx; f.z = nz;
    f.y += (top - f.y) * Math.min(1, dt * 9);   // 段差はなめらかに乗り越える
  } else {
    // 壁。向きを変えて回り込む（同じ壁で往復しないよう回る向きを個体で決める）
    f.yaw += (f.phase > Math.PI ? 1 : -1) * dt * 5.5;
    f.speed *= 0.6;
    f.goal = null;
    f.timer = Math.min(f.timer, 0.4);
  }
}
