/**
 * 探索モードの操作役。
 *
 * 入力（押されているキーとマウスの移動量）を溜めて、`physics.js` の体を
 * 1 フレーム進める。DOM には触らないので、キーの購読はアプリ側の担当。
 * ゲームに転用するときは、ここを自前の入力に差し替えればよい。
 */

import { createBody, stepBody, eyeOf, PHYS } from './physics.js';
import { clamp, angleDelta } from '../core/rng.js';

/** 既定のキー割り当て（KeyboardEvent.code） */
export const DEFAULT_KEYS = {
  forward: ['KeyW', 'ArrowUp'],
  back: ['KeyS', 'ArrowDown'],
  left: ['KeyA', 'ArrowLeft'],
  right: ['KeyD', 'ArrowRight'],
  jump: ['Space'],
  run: ['ShiftLeft', 'ShiftRight'],
  down: ['KeyC', 'ControlLeft'],
  fly: ['KeyV'],
};

export class Explorer {
  constructor(scene, spawn, opts = {}) {
    this.keys = new Set();
    this.yaw = opts.yaw ?? 0.9;
    this.pitch = opts.pitch ?? -0.15;
    this.sensitivity = opts.sensitivity ?? 0.0022;
    // 上下を反転（既定）。指で世界を掴んで動かす向きになり、俯瞰の操作とも揃う
    this.invertY = opts.invertY ?? true;
    this.binding = { ...DEFAULT_KEYS, ...(opts.keys || {}) };
    this.setScene(scene, spawn);
  }

  setScene(scene, spawn) {
    this.scene = scene;
    if (!scene) { this.body = null; return; }
    const s = spawn || { x: scene.total / 2, z: scene.total / 2 };
    this.body = createBody(scene, s.x, s.z);
    if (typeof s.y === 'number') this.body.y = s.y;
  }

  _held(action) { return this.binding[action].some((k) => this.keys.has(k)); }

  /** キーの上げ下げ。戻り値はそのキーを操作として消費したか */
  key(code, down) {
    const known = Object.values(this.binding).some((list) => list.includes(code));
    if (!known) return false;
    if (down && this.binding.fly.includes(code) && !this.keys.has(code)) this.toggleFly();
    if (down) this.keys.add(code); else this.keys.delete(code);
    return true;
  }

  /** 入力が途切れたとき（ウィンドウ外へ出た等）に押しっぱなしを解く */
  releaseAll() { this.keys.clear(); }

  /** マウス・ドラッグの移動量で視線を回す */
  look(dx, dy) {
    this.yaw -= dx * this.sensitivity;
    // 真上・真下は詰まるので少し手前で止める
    const s = this.invertY ? 1 : -1;
    this.pitch = clamp(this.pitch + s * dy * this.sensitivity, -1.45, 1.45);
  }

  /**
   * 対象へ視線を寄せる。ひと息で振り向くと何が起きたか分からないので、
   * dt で補間する（指数の寄せ方なので、フレームレートが変わっても速さは同じ）。
   */
  aimAt(x, y, z, dt) {
    if (!this.body) return;
    const e = eyeOf(this.body);
    const dx = x - e[0], dy = y - e[1], dz = z - e[2];
    const flat = Math.hypot(dx, dz);
    if (flat < 1e-4 && Math.abs(dy) < 1e-4) return;
    // yaw は前進が (-sin, -cos) の系（physics.js と揃える）
    const wantYaw = Math.atan2(-dx, -dz);
    const wantPitch = clamp(Math.atan2(dy, Math.max(flat, 1e-4)), -1.45, 1.45);
    const k = 1 - Math.exp(-dt * 7);
    this.yaw += angleDelta(this.yaw, wantYaw) * k;
    this.pitch += (wantPitch - this.pitch) * k;
  }

  toggleFly() {
    if (!this.body) return;
    this.body.fly = !this.body.fly;
    this.body.vy = 0;
  }

  get flying() { return !!(this.body && this.body.fly); }

  /** 1 フレーム進めて、カメラに渡す視点を返す */
  update(dt) {
    if (!this.scene || !this.body) return null;
    const input = {
      forward: (this._held('forward') ? 1 : 0) - (this._held('back') ? 1 : 0),
      strafe: (this._held('right') ? 1 : 0) - (this._held('left') ? 1 : 0),
      up: (this._held('jump') ? 1 : 0) - (this._held('down') ? 1 : 0),
      jump: this._held('jump'),
      run: this._held('run'),
      yaw: this.yaw,
    };
    // stepBody は 1 回 0.05 秒までしか進めない（速いとすり抜けるため）。
    // フレームレートが落ちた端末で世界がスローモーションにならないよう、
    // 長い dt はここで分割して詰める
    const n = Math.max(1, Math.min(4, Math.ceil(dt / 0.05)));
    for (let k = 0; k < n; k++) stepBody(this.scene, this.body, input, dt / n);
    return { eye: eyeOf(this.body), yaw: this.yaw, pitch: this.pitch, body: this.body };
  }

  /** HUD 用の状態 */
  status() {
    const b = this.body;
    if (!b) return null;
    return {
      x: b.x, y: b.y, z: b.z,
      speed: Math.hypot(b.vx, b.vz),
      onGround: b.onGround,
      inWater: b.inWater,
      submerged: b.submerged,
      flying: b.fly,
      eyeM: (b.y + PHYS.eye) * 6,
    };
  }
}
