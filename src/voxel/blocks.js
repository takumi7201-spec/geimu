/**
 * 地表ボクセルのブロック定義。
 *
 * 「1 ブロック = 6 m」の縮尺（VOX_M）で地表に降りたときの見た目を決める。
 * マップ側のバイオームは 20 km セルの分類なので、ここではそれを
 * 「地面の材質・地層・植生の種類」へ翻訳する。
 *
 * 色はドット絵として成立するよう、彩度を少し上げて段差をはっきりさせている。
 * DOM に依存しないので Node からも同じ結果を再現できる。
 */

/** ブロック 1 個の一辺（メートル）。樹高 40m ≒ 7 ブロックになる縮尺 */
export const VOX_M = 6;

export const BLOCKS = [
  { id: 'air',        name: '空気',         color: [0, 0, 0] },
  // --- 地表 ---
  { id: 'fernTurf',   name: 'シダ草地',     color: [104, 150, 62] },
  { id: 'fernDark',   name: '林床',         color: [74, 118, 52] },
  { id: 'meadow',     name: '下生え',       color: [126, 166, 70] },
  { id: 'savanna',    name: '乾いた草地',   color: [170, 164, 84] },
  { id: 'scrubland',  name: '低木荒原',     color: [166, 142, 88] },
  { id: 'sand',       name: '砂',           color: [228, 210, 152] },
  { id: 'redSand',    name: '赤色砂',       color: [198, 118, 72] },
  { id: 'dirt',       name: '土',           color: [122, 92, 60] },
  { id: 'mud',        name: '泥',           color: [98, 84, 56] },
  { id: 'peat',       name: '泥炭',         color: [66, 58, 44] },
  { id: 'clay',       name: '粘土',         color: [168, 116, 92] },
  { id: 'gravel',     name: '礫',           color: [150, 144, 134] },
  // --- 岩と地層 ---
  { id: 'rock',       name: '灰色岩',       color: [128, 128, 136] },
  { id: 'rockDark',   name: '暗色岩',       color: [92, 92, 100] },
  { id: 'limestone',  name: '石灰岩',       color: [192, 186, 164] },
  { id: 'redBed',     name: '赤色層',       color: [162, 88, 58] },
  { id: 'sandstone',  name: '砂岩',         color: [198, 160, 106] },
  { id: 'basalt',     name: '玄武岩',       color: [62, 58, 64] },
  { id: 'ash',        name: '火山灰',       color: [108, 100, 98] },
  { id: 'lava',       name: '溶岩',         color: [238, 126, 44], glow: 1 },
  { id: 'bare',       name: '裸岩',         color: [178, 174, 168] },
  // --- 水中 ---
  { id: 'seabed',     name: '海底砂',       color: [204, 194, 156] },
  { id: 'coralRed',   name: 'ルディスト礁', color: [202, 112, 112] },
  { id: 'coralTeal',  name: '造礁生物',     color: [92, 168, 164] },
  { id: 'algae',      name: '藻場',         color: [72, 120, 84] },
  // --- 植物 ---
  { id: 'trunk',      name: '幹',           color: [106, 74, 48] },
  { id: 'trunkDark',  name: '暗い幹',       color: [78, 56, 38] },
  { id: 'conifer',    name: '針葉',         color: [46, 100, 68] },
  { id: 'coniferHi',  name: '針葉（明）',   color: [62, 126, 80] },
  { id: 'frond',      name: 'シダの葉',     color: [96, 152, 74] },
  { id: 'cycadLeaf',  name: 'ソテツの葉',   color: [130, 154, 66] },
  { id: 'broadleaf',  name: '広葉',         color: [92, 154, 68] },
  { id: 'broadleafHi',name: '広葉（明）',   color: [116, 176, 84] },
  { id: 'autumnLeaf', name: '落葉針葉',     color: [188, 152, 64] },
  { id: 'blossom',    name: '花',           color: [224, 166, 192] },
  { id: 'deadwood',   name: '枯木',         color: [132, 120, 100] },
  { id: 'bone',       name: '骨',           color: [232, 226, 206] },
  // --- 動物 ---
  { id: 'hideA',      name: '皮膚A',        color: [124, 112, 88] },
  { id: 'hideB',      name: '皮膚B',        color: [96, 106, 78] },
  { id: 'hideC',      name: '皮膚C',        color: [150, 112, 70] },
  { id: 'hideDark',   name: '皮膚（陰）',   color: [72, 68, 58] },
  { id: 'crest',      name: '鶏冠・帆',     color: [190, 84, 70] },
  { id: 'eye',        name: '眼',           color: [26, 24, 22] },
];

export const B = Object.fromEntries(BLOCKS.map((b, i) => [b.id, i]));
export const BLOCK_COLORS = BLOCKS.map((b) => b.color);
export const BLOCK_GLOW = BLOCKS.map((b) => b.glow || 0);

/** 草地に散る花・低木の色（画面のちらつきを生む差し色） */
export const SPECKLE = [B.blossom, B.meadow, B.savanna, B.frond];
/** 林床に散る明るい下生え */
export const UNDERGROWTH = [B.frond, B.meadow, B.fernTurf, B.blossom];

/**
 * 崖に出る地層。
 *
 * y（絶対高度ブロック）だけの関数にしてあるのが要点で、
 * 列ごとにハッシュを混ぜると縞が横につながらず、崖がただのノイズになる。
 * @param {number} y      ブロック単位の高度
 * @param {number} salt   世界ごとの位相（同じ場所で毎回同じ縞になる）
 * @param {number} suite  0=石灰岩系 1=赤色層系 2=灰色岩系 3=玄武岩系
 */
export function strataAt(y, salt, suite) {
  const band = Math.floor((y + salt) / 4) + Math.floor((y + salt * 3) / 13);
  const k = ((band % 5) + 5) % 5;
  switch (suite) {
    case 1: return [B.redBed, B.sandstone, B.redBed, B.redBed, B.sandstone][k];
    case 2: return [B.rock, B.rockDark, B.rock, B.sandstone, B.rockDark][k];
    case 3: return [B.basalt, B.rockDark, B.basalt, B.basalt, B.ash][k];
    default: return [B.limestone, B.sandstone, B.limestone, B.rock, B.limestone][k];
  }
}

/**
 * バイオームごとの地表・地層・植生プロファイル。
 * top は地表 1 ブロック、sub は数ブロック下、suite は崖に出る岩相。
 * veg は 1 ブロックあたりの出現確率、kinds は植物モデルの重み。
 */
export const GROUND = {
  // 水域（海底として使う）
  abyss:        { top: 'rockDark', sub: 'basalt', suite: 3, veg: 0, kinds: {} },
  ocean:        { top: 'seabed',   sub: 'sandstone', suite: 0, veg: 0, kinds: {} },
  shelf:        { top: 'seabed',   sub: 'sandstone', suite: 0, veg: 0.006, kinds: { algae: 1 } },
  epeiric:      { top: 'seabed',   sub: 'limestone', suite: 0, veg: 0.010, kinds: { algae: 2, coral: 1 } },
  reef:         { top: 'coralTeal',sub: 'limestone', suite: 0, veg: 0.070, kinds: { coral: 1 } },
  lagoon:       { top: 'sand',     sub: 'limestone', suite: 0, veg: 0.020, kinds: { coral: 1, algae: 2 } },

  beach:        { top: 'sand',     sub: 'sandstone', suite: 0, canopy: 'meadow', veg: 0.004, kinds: { driftwood: 2, shell: 3, cycad: 1 } },
  delta:        { top: 'fernDark', sub: 'clay',      suite: 0, canopy: 'conifer', veg: 0.070, kinds: { horsetail: 4, treeFern: 3, swampConifer: 3, log: 1 } },
  swamp:        { top: 'peat',     sub: 'mud',       suite: 0, canopy: 'conifer', veg: 0.082, kinds: { swampConifer: 5, treeFern: 3, horsetail: 4, log: 1 } },
  angiosperm:   { top: 'fernDark', sub: 'dirt',      suite: 0, canopy: 'broadleaf', veg: 0.115, kinds: { broadTree: 6, treeFern: 2, shrub: 3, flowerBush: 2 } },
  araucaria:    { top: 'fernDark', sub: 'dirt',      suite: 2, canopy: 'conifer', veg: 0.090, kinds: { araucaria: 6, treeFern: 2, cycad: 1, shrub: 2 } },
  temperate:    { top: 'fernTurf', sub: 'dirt',      suite: 2, canopy: 'fernDark', veg: 0.090, kinds: { treeFern: 4, araucaria: 3, shrub: 3, horsetail: 1 } },
  polarForest:  { top: 'fernTurf', sub: 'dirt',      suite: 2, canopy: 'autumnLeaf', veg: 0.082, kinds: { polarConifer: 6, shrub: 3, log: 1 } },
  coldScrub:    { top: 'scrubland',sub: 'gravel',    suite: 2, canopy: 'fernDark', veg: 0.030, kinds: { shrub: 5, boulder: 3, log: 1 } },
  fernPrairie:  { top: 'fernTurf', sub: 'dirt',      suite: 0, canopy: 'frond', veg: 0.045, kinds: { fernClump: 6, cycad: 2, araucaria: 1, shrub: 2 } },
  cycadSavanna: { top: 'savanna',  sub: 'dirt',      suite: 1, canopy: 'cycadLeaf', veg: 0.038, kinds: { cycad: 5, araucaria: 2, fernClump: 3, boulder: 1 } },
  scrub:        { top: 'scrubland',sub: 'sandstone', suite: 1, canopy: 'fernDark', veg: 0.020, kinds: { shrub: 4, cycad: 2, boulder: 3, bones: 1 } },
  desert:       { top: 'sand',     sub: 'sandstone', suite: 0, veg: 0.006, kinds: { boulder: 4, shrub: 2, bones: 2 } },
  redDesert:    { top: 'redSand',  sub: 'redBed',    suite: 1, veg: 0.006, kinds: { boulder: 4, shrub: 1, bones: 3 } },
  highland:     { top: 'gravel',   sub: 'rock',      suite: 2, canopy: 'conifer', veg: 0.030, kinds: { araucaria: 3, shrub: 4, boulder: 4 } },
  alpine:       { top: 'bare',     sub: 'rock',      suite: 2, veg: 0.004, kinds: { boulder: 6, shrub: 1 } },
  volcanic:     { top: 'ash',      sub: 'basalt',    suite: 3, canopy: 'deadwood', veg: 0.012, kinds: { deadTree: 4, boulder: 3, log: 2 } },
};

/**
 * 遠景の地表色。草木を 1 本ずつ置けない距離では、地面そのものを
 * 樹冠の色で塗って森に見せる（置くと頂点が 10 倍になる）
 */
export function canopyOf(biomeId) {
  const g = groundOf(biomeId);
  return g.canopy ? B[g.canopy] : null;
}

/** GROUND に無いバイオームが来ても落ちないようにする */
export function groundOf(biomeId) {
  return GROUND[biomeId] || GROUND.fernPrairie;
}
