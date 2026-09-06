/**
 * 中生代のバイオーム定義と分類。
 * 氷冠のない温室地球が前提で、極域にも森林が成立する。
 */

export const BIOMES = {
  abyss:        { name: '深海平原',       color: [12, 26, 58],    water: true },
  ocean:        { name: '外洋',           color: [22, 52, 102],   water: true },
  shelf:        { name: '大陸棚',         color: [38, 92, 148],   water: true },
  epeiric:      { name: '大陸内海',       color: [58, 126, 172],  water: true },
  reef:         { name: 'ルディスト礁',   color: [86, 176, 178],  water: true },
  lagoon:       { name: '潟・浅瀬',       color: [96, 166, 186],  water: true },

  beach:        { name: '海岸砂丘',       color: [206, 190, 142] },
  delta:        { name: '三角州湿地',     color: [104, 138, 92] },
  swamp:        { name: '沼沢林',         color: [58, 92, 62] },
  angiosperm:   { name: '被子植物林',     color: [82, 132, 62] },
  araucaria:    { name: 'ナンヨウスギ林', color: [46, 104, 76] },
  temperate:    { name: '温帯シダ林',     color: [78, 122, 74] },
  polarForest:  { name: '極地落葉針葉樹林', color: [92, 118, 110] },
  coldScrub:    { name: '寒冷低木荒原',   color: [126, 132, 122] },
  fernPrairie:  { name: 'シダ大平原',     color: [140, 158, 88] },
  cycadSavanna: { name: 'ソテツ・サバンナ', color: [168, 158, 80] },
  scrub:        { name: '乾燥低木地',     color: [178, 148, 92] },
  desert:       { name: '大砂漠',         color: [214, 186, 122] },
  redDesert:    { name: '赤色砂漠',       color: [190, 122, 78] },
  highland:     { name: '高地',           color: [138, 122, 100] },
  alpine:       { name: '高山帯',         color: [186, 182, 176] },
  volcanic:     { name: '火山荒原',       color: [94, 68, 66] },
};

export const BIOME_IDS = Object.keys(BIOMES);
export const BIOME_INDEX = Object.fromEntries(BIOME_IDS.map((k, i) => [k, i]));

/**
 * 1 セルのバイオームを決める。
 * @param {number} h        標高 -1..1（0 が海水準）
 * @param {number} temp     気温（℃）
 * @param {number} moist    湿潤度 0..1
 * @param {number} cont     大陸性 0..1（大陸核の影響場）
 * @param {number} volc     火山活動度 0..1
 * @param {string} eraId
 */
export function classify(h, temp, moist, cont, volc, eraId) {
  if (h < 0) {
    const depth = -h;
    // 大陸地殻が水没した「陸棚海」は深さによらず内海として扱う
    if (cont > 0.45 && depth < 0.26) {
      if (depth < 0.04 && temp > 23) return 'reef';
      if (depth < 0.018) return 'lagoon';
      return 'epeiric';
    }
    if (depth > 0.55) return 'abyss';
    if (depth > 0.16) return 'ocean';
    if (depth < 0.035 && temp > 23 && cont > 0.25) return 'reef';
    if (depth < 0.02) return 'lagoon';
    return 'shelf';
  }

  if (volc > 0.72 && h < 0.55) return 'volcanic';

  if (h > 0.70) return 'alpine';
  if (h > 0.42) return 'highland';
  if (h < 0.008 && moist < 0.55) return 'beach';

  if (temp < 4) return moist > 0.34 ? 'polarForest' : 'coldScrub';
  if (temp < 12) return moist > 0.30 ? 'polarForest' : 'coldScrub';

  if (moist > 0.80 && h < 0.10) return 'delta';
  if (moist > 0.70) return 'swamp';

  if (moist > 0.52) {
    if (eraId === 'cretaceous' && temp > 14) return 'angiosperm';
    if (temp > 20) return 'araucaria';
    return 'temperate';
  }
  if (moist > 0.36) return 'fernPrairie';
  if (moist > 0.24) return 'cycadSavanna';
  if (moist > 0.14) return 'scrub';
  return eraId === 'triassic' ? 'redDesert' : 'desert';
}

/** 標高（-1..1）をメートルに換算 */
export function toMeters(h) {
  return h >= 0 ? Math.round(h * 4600) : -Math.round(-h * 6200);
}
