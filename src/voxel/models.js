/**
 * ボクセルモデル（植物・動物・岩）。
 *
 * モデルは「直方体の集まり」で持つ。1 個ずつ立方体を並べるとブロック数が
 * 数十万になるので、幹や脚のように連続する部分はまとめた箱にしている。
 * それでも見た目がドット絵のままなのは、箱の辺をボクセル格子に必ず載せるため。
 *
 * unit はモデル 1 ボクセルの大きさ（地形ブロック単位）。
 *   植物 unit=1   … 地形と同じ格子に載る（6m 角）
 *   動物 unit=0.25 … 体を 1.5m 角で刻む（恐竜が地形ブロックより細かい）
 * DOM 非依存。
 */

import { B } from './blocks.js';

/** 箱を積むための小さなビルダ */
function model(unit) {
  const boxes = [];
  return {
    unit,
    boxes,
    /** x,y,z を最小角として w×h×d の箱を置く（y が上） */
    box(x, y, z, w, h, d, b) { boxes.push({ x, y, z, w, h, d, b }); return this; },
    cell(x, y, z, b) { return this.box(x, y, z, 1, 1, 1, b); },
    /** 中心 (cx,cz) の水平リング。葉を放射状に置くのに使う */
    ring(cx, y, cz, r, b, skipCorner = true) {
      for (let dx = -r; dx <= r; dx++) {
        for (let dz = -r; dz <= r; dz++) {
          if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
          if (skipCorner && Math.abs(dx) === r && Math.abs(dz) === r) continue;
          this.cell(cx + dx, y, cz + dz, b);
        }
      }
      return this;
    },
    /** 中心 (cx,cz) の塊。半径 r のひし形＋角の欠けで丸く見せる */
    disc(cx, y, cz, r, b) {
      for (let dx = -r; dx <= r; dx++) {
        for (let dz = -r; dz <= r; dz++) {
          if (Math.abs(dx) + Math.abs(dz) > r + (r > 1 ? 1 : 0)) continue;
          this.cell(cx + dx, y, cz + dz, b);
        }
      }
      return this;
    },
  };
}

const ri = (rand, a, b) => a + ((rand() * (b - a + 1)) | 0);

// ---------------------------------------------------------------- 植物

/** ナンヨウスギ：細い幹に傘型の樹冠。中生代の景色の主役 */
function araucaria(rand) {
  const m = model(1);
  const h = ri(rand, 5, 9);
  m.box(0, 0, 0, 1, h, 1, B.trunk);
  // 樹冠は板を重ねて作る。1 ブロックずつ置くと箱の数が数十万に膨れるため、
  // 見た目が同じ「四角い層」でまとめる（森 1 面で 10 倍以上軽くなる）
  m.box(-2, h - 2, -2, 5, 1, 5, B.conifer);
  m.box(-1, h - 1, -1, 3, 1, 3, B.conifer);
  m.box(0, h, 0, 1, 2, 1, B.coniferHi);
  m.cell(-2, h - 1, 0, B.conifer);
  m.cell(2, h - 1, 0, B.conifer);
  if (rand() < 0.5) m.box(-2, h - 3, -1, 5, 1, 3, B.conifer);
  return m;
}

/** 沼のスギ（メタセコイア型）：細長い円錐 */
function swampConifer(rand) {
  const m = model(1);
  const h = ri(rand, 6, 10);
  m.box(0, 0, 0, 1, h, 1, B.trunkDark);
  m.box(-1, h - 4, -1, 3, 2, 3, B.conifer);
  m.box(-1, h - 2, 0, 3, 1, 1, B.conifer);
  m.box(0, h - 2, -1, 1, 1, 3, B.conifer);
  m.box(0, h - 1, 0, 1, 2, 1, B.coniferHi);
  return m;
}

/** 極地の落葉針葉樹：黄葉した円錐（氷冠のない極域の森） */
function polarConifer(rand) {
  const m = model(1);
  const h = ri(rand, 4, 7);
  m.box(0, 0, 0, 1, h, 1, B.trunkDark);
  m.box(-1, h - 2, -1, 3, 2, 3, B.autumnLeaf);
  m.box(0, h, 0, 1, 1, 1, B.autumnLeaf);
  return m;
}

/** 被子植物の広葉樹（白亜紀）。花のブロックを少し混ぜる */
function broadTree(rand) {
  const m = model(1);
  const h = ri(rand, 3, 6);
  m.box(0, 0, 0, 1, h, 1, B.trunk);
  m.box(-2, h, -2, 5, 2, 5, B.broadleaf);
  m.box(-1, h + 2, -1, 3, 1, 3, B.broadleafHi);
  if (rand() < 0.45) {
    m.cell(ri(rand, -1, 1), h + 2, ri(rand, -1, 1), B.blossom);
    m.cell(ri(rand, -2, 2), h + 1, ri(rand, -2, 2), B.blossom);
  }
  return m;
}

/** 木性シダ：細い幹の先に葉を放射状に伸ばす */
function treeFern(rand) {
  const m = model(1);
  const h = ri(rand, 2, 4);
  m.box(0, 0, 0, 1, h, 1, B.trunkDark);
  m.box(-1, h, 0, 3, 1, 1, B.frond);
  m.box(0, h, -1, 1, 1, 3, B.frond);
  if (rand() < 0.7) { m.cell(2, h - 1, 0, B.frond); m.cell(-2, h - 1, 0, B.frond); }
  return m;
}

/** ソテツ：太く低い幹に厚い葉冠 */
function cycad(rand) {
  const m = model(1);
  const h = ri(rand, 1, 2);
  m.box(0, 0, 0, 1, h, 1, B.trunkDark);
  m.box(-1, h, -1, 3, 1, 3, B.cycadLeaf);
  if (rand() < 0.6) { m.cell(2, h, 0, B.cycadLeaf); m.cell(-2, h, 0, B.cycadLeaf); }
  return m;
}

/** シダの茂み・低木・花：草地の差し色になる小物 */
function fernClump(rand) {
  const m = model(1);
  m.cell(0, 0, 0, B.frond);
  if (rand() < 0.6) m.cell(1, 0, 0, B.frond);
  if (rand() < 0.4) m.cell(0, 1, 0, B.frond);
  return m;
}
function shrub(rand) {
  const m = model(1);
  m.cell(0, 0, 0, rand() < 0.5 ? B.fernDark : B.meadow);
  if (rand() < 0.35) m.cell(0, 1, 0, B.fernDark);
  return m;
}
function flowerBush(rand) {
  const m = model(1);
  m.cell(0, 0, 0, B.blossom);
  if (rand() < 0.4) m.cell(1, 0, 0, B.meadow);
  return m;
}
/** トクサ：湿地に立つ細い棒 */
function horsetail(rand) {
  const m = model(1);
  const n = ri(rand, 2, 4);
  for (let k = 0; k < n; k++) {
    m.box(ri(rand, -1, 1), 0, ri(rand, -1, 1), 1, ri(rand, 1, 3), 1, B.frond);
  }
  return m;
}

/** 倒木・枯木・流木 */
function log(rand) {
  const m = model(1);
  m.box(0, 0, 0, ri(rand, 2, 4), 1, 1, B.deadwood);
  return m;
}
function deadTree(rand) {
  const m = model(1);
  const h = ri(rand, 3, 5);
  m.box(0, 0, 0, 1, h, 1, B.deadwood);
  m.cell(1, h - 1, 0, B.deadwood);
  if (rand() < 0.6) m.cell(-1, h - 2, 0, B.deadwood);
  return m;
}
function driftwood(rand) {
  const m = model(1);
  m.box(0, 0, 0, ri(rand, 2, 3), 1, 1, B.deadwood);
  if (rand() < 0.5) m.cell(0, 1, 0, B.deadwood);
  return m;
}

/** アンモナイトの殻：渦を 1 ブロックずつ置く */
function shell(rand) {
  const m = model(1);
  m.cell(0, 0, 0, B.bone);
  m.cell(1, 0, 0, B.bone);
  if (rand() < 0.5) m.cell(1, 0, 1, B.bone);
  return m;
}

/** 骨層：あばらと頭骨。乾燥地の名物 */
function bones(rand) {
  const m = model(1);
  const l = ri(rand, 3, 5);
  for (let k = 0; k < l; k++) if (rand() < 0.8) m.cell(k, 0, 0, B.bone);
  m.cell(-1, 0, 0, B.bone);
  if (rand() < 0.7) m.cell(1, 1, 1, B.bone);
  return m;
}

/** 岩塊 */
function boulder(rand) {
  const m = model(1);
  const b = rand() < 0.5 ? B.rock : B.rockDark;
  m.box(0, 0, 0, ri(rand, 1, 2), ri(rand, 1, 2), ri(rand, 1, 2), b);
  if (rand() < 0.5) m.cell(1, 0, 1, b);
  return m;
}

/** 造礁生物（ルディスト礁）：水中の柱 */
function coral(rand) {
  const m = model(1);
  const h = ri(rand, 1, 3);
  const b = rand() < 0.5 ? B.coralRed : B.coralTeal;
  m.box(0, 0, 0, 1, h, 1, b);
  if (rand() < 0.6) m.cell(1, h - 1, 0, b);
  if (rand() < 0.4) m.cell(0, h - 1, 1, rand() < 0.5 ? B.coralRed : B.coralTeal);
  return m;
}
function algae(rand) {
  const m = model(1);
  m.cell(0, 0, 0, B.algae);
  if (rand() < 0.5) m.cell(0, 1, 0, B.algae);
  return m;
}

export const PLANT_BUILDERS = {
  araucaria, swampConifer, polarConifer, broadTree, treeFern, cycad,
  fernClump, shrub, flowerBush, horsetail, log, deadTree, driftwood,
  shell, bones, boulder, coral, algae,
};

// ---------------------------------------------------------------- 動物
//
// 体は 1 ボクセル = 1.5m（unit 0.25）で刻む。地形ブロックより細かいので、
// 25m の竜脚類でも首と尾の形が分かる。

/** 竜脚類：胴・首・尾・4 本脚 */
function sauropod(rand, hide) {
  const m = model(0.25);
  const legH = ri(rand, 4, 6);
  const bodyY = legH;
  m.box(0, bodyY, 0, 10, 5, 5, hide);              // 胴
  m.box(1, bodyY - legH, 1, 2, legH, 2, hide);     // 前脚
  m.box(7, bodyY - legH, 1, 2, legH, 2, hide);
  m.box(1, bodyY - legH, 3, 2, legH, 2, hide);
  m.box(7, bodyY - legH, 3, 2, legH, 2, hide);
  // 首：段々に上げる
  for (let k = 0; k < 5; k++) m.box(10 + k, bodyY + 1 + k, 2, 2, 2, 2, hide);
  m.box(15, bodyY + 6, 2, 2, 2, 2, hide);          // 頭
  m.box(17, bodyY + 6, 2, 1, 1, 1, B.eye);
  // 尾：段々に下げて細く
  for (let k = 0; k < 6; k++) m.box(-2 - k * 2, bodyY + 2 - Math.floor(k / 2), 2, 2, 2, 2, hide);
  return m;
}

/** 獣脚類：二足・水平な体・大きな頭 */
function theropod(rand, hide) {
  const m = model(0.25);
  const legH = ri(rand, 4, 6);
  const y = legH;
  m.box(0, y, 0, 8, 4, 4, hide);                   // 胴
  m.box(2, y - legH, 0, 2, legH, 2, hide);         // 脚
  m.box(2, y - legH, 2, 2, legH, 2, hide);
  m.box(8, y + 1, 1, 4, 3, 2, hide);               // 頭
  m.box(12, y + 1, 1, 1, 1, 2, B.crest);           // 口先
  m.box(11, y + 3, 1, 1, 1, 1, B.eye);
  m.box(7, y + 4, 1, 1, 1, 2, B.crest);            // 首の飾り
  for (let k = 0; k < 5; k++) m.box(-2 - k * 2, y + 1 - Math.floor(k / 3), 1, 2, 2, 2, hide);
  m.box(6, y - 1, 0, 2, 1, 1, hide);               // 小さな前肢
  return m;
}

/** 鳥盤類：背の板・襟飾りのどちらかを載せた四足 */
function ornithischian(rand, hide) {
  const m = model(0.25);
  const legH = ri(rand, 3, 4);
  const y = legH;
  m.box(0, y, 0, 8, 4, 4, hide);
  for (const [x, z] of [[1, 0], [1, 3], [6, 0], [6, 3]]) m.box(x, y - legH, z, 1, legH, 1, hide);
  m.box(8, y, 1, 3, 3, 2, hide);                   // 頭
  m.box(11, y + 1, 1, 1, 1, 1, B.eye);
  const plates = rand() < 0.5;
  if (plates) {
    for (let k = 0; k < 4; k++) m.box(1 + k * 2, y + 4, 2, 1, 2, 1, B.crest);   // 背板
    m.box(-2, y + 1, 1, 2, 1, 2, hide);
    m.box(-3, y + 1, 1, 1, 1, 1, B.crest);
  } else {
    m.box(9, y + 3, 0, 2, 2, 4, B.crest);          // 襟飾り
    m.box(11, y, 2, 2, 1, 1, B.bone);              // 角
  }
  for (let k = 0; k < 3; k++) m.box(-1 - k * 2, y + 1, 1, 2, 2, 2, hide);
  return m;
}

/** 翼竜：翼を張った十字形。地面から浮かせて置く */
function pterosaur(rand, hide) {
  const m = model(0.25);
  m.box(0, 0, 4, 5, 2, 2, hide);                   // 胴
  m.box(5, 1, 4, 3, 1, 2, hide);                   // 頭
  m.box(8, 1, 4, 2, 2, 1, B.crest);                // 鶏冠
  for (let k = 0; k < 4; k++) {                    // 翼（外へ行くほど薄く）
    m.box(1, 1 + (k > 1 ? 1 : 0), 3 - k, 3 - Math.floor(k / 2), 1, 1, hide);
    m.box(1, 1 + (k > 1 ? 1 : 0), 6 + k, 3 - Math.floor(k / 2), 1, 1, hide);
  }
  m.box(-3, 0, 4, 3, 1, 2, hide);                  // 尾
  return m;
}

/** 首長竜：水面に首とヒレだけを出す */
function plesiosaur(rand, hide) {
  const m = model(0.25);
  m.box(0, 0, 0, 7, 2, 4, hide);
  for (let k = 0; k < 4; k++) m.box(7 + k, 1 + k, 1, 2, 2, 2, hide);
  m.box(11, 5, 1, 2, 1, 2, hide);
  m.box(1, 0, -2, 3, 1, 2, hide);                  // ヒレ
  m.box(1, 0, 4, 3, 1, 2, hide);
  m.box(-3, 0, 1, 3, 1, 2, hide);
  return m;
}

export const FAUNA_BUILDERS = { sauropod, theropod, ornithischian, pterosaur, plesiosaur };

/** fauna.js の分類群名を、どのモデルで描くかに対応づける */
export function modelForGroup(group) {
  if (/翼竜/.test(group)) return 'pterosaur';
  if (/竜脚/.test(group)) return 'sauropod';
  if (/獣脚|ラウイスクス|鳥類/.test(group)) return 'theropod';
  if (/首長竜|モササウルス|魚竜|鰭竜|板歯|原鰭竜|ウミガメ/.test(group)) return 'plesiosaur';
  if (/角竜|剣竜|曲竜|堅頭竜|鳥脚|ハドロサウルス|アエトサウルス|キノドン|分椎|基盤竜盤/.test(group)) return 'ornithischian';
  return 'theropod';
}

export const HIDES = [B.hideA, B.hideB, B.hideC, B.hideDark];

/** モデルの水平方向の長さ（ボクセル）。実寸に合わせるスケール計算に使う */
export function modelSpan(m) {
  let lo = Infinity, hi = -Infinity;
  for (const b of m.boxes) { lo = Math.min(lo, b.x); hi = Math.max(hi, b.x + b.w); }
  return Math.max(1, hi - lo);
}
