/**
 * 各紀の動植物相。バイオームとの親和性でマップ上に分布させる。
 * size は概算の全長（m）、diet は 肉/植/雑/魚。
 */

const T = 'triassic', J = 'jurassic', K = 'cretaceous';

export const FAUNA = {
  [T]: [
    { name: 'コエロフィシス', latin: 'Coelophysis', group: '獣脚類', size: 3, diet: '肉', biomes: ['redDesert', 'scrub', 'cycadSavanna', 'fernPrairie'], w: 3 },
    { name: 'ヘレラサウルス', latin: 'Herrerasaurus', group: '獣脚類', size: 5, diet: '肉', biomes: ['fernPrairie', 'temperate', 'araucaria'], w: 2 },
    { name: 'エオラプトル', latin: 'Eoraptor', group: '基盤竜盤類', size: 1.5, diet: '雑', biomes: ['fernPrairie', 'scrub'], w: 2 },
    { name: 'プラテオサウルス', latin: 'Plateosaurus', group: '竜脚形類', size: 8, diet: '植', biomes: ['fernPrairie', 'cycadSavanna', 'araucaria', 'temperate'], w: 3 },
    { name: 'リッペルロサウルス', latin: 'Riojasaurus', group: '竜脚形類', size: 10, diet: '植', biomes: ['cycadSavanna', 'araucaria'], w: 1 },
    { name: 'ポストスクス', latin: 'Postosuchus', group: 'ラウイスクス類', size: 5, diet: '肉', biomes: ['redDesert', 'scrub', 'fernPrairie'], w: 2 },
    { name: 'デスマトスクス', latin: 'Desmatosuchus', group: 'アエトサウルス類', size: 4.5, diet: '植', biomes: ['scrub', 'fernPrairie', 'swamp'], w: 2 },
    { name: 'メトポサウルス', latin: 'Metoposaurus', group: '分椎目', size: 3, diet: '魚', biomes: ['swamp', 'delta', 'lagoon'], w: 2 },
    { name: 'トリナクソドン', latin: 'Thrinaxodon', group: 'キノドン類', size: 0.5, diet: '肉', biomes: ['coldScrub', 'polarForest', 'scrub'], w: 2 },
    { name: 'エウディモルフォドン', latin: 'Eudimorphodon', group: '翼竜', size: 1, diet: '魚', biomes: ['lagoon', 'reef', 'shelf', 'beach'], w: 2 },
    { name: 'ショニサウルス', latin: 'Shonisaurus', group: '魚竜', size: 15, diet: '魚', biomes: ['ocean', 'abyss', 'shelf'], w: 2 },
    { name: 'ノトサウルス', latin: 'Nothosaurus', group: '鰭竜類', size: 4, diet: '魚', biomes: ['shelf', 'epeiric', 'lagoon'], w: 3 },
    { name: 'プラコドゥス', latin: 'Placodus', group: '板歯類', size: 2, diet: '雑', biomes: ['lagoon', 'reef', 'epeiric'], w: 2 },
    { name: 'タニストロフェウス', latin: 'Tanystropheus', group: '原鰭竜類', size: 6, diet: '魚', biomes: ['lagoon', 'shelf', 'beach'], w: 1 },
  ],
  [J]: [
    { name: 'アロサウルス', latin: 'Allosaurus', group: '獣脚類', size: 9, diet: '肉', biomes: ['fernPrairie', 'cycadSavanna', 'araucaria', 'temperate'], w: 3 },
    { name: 'ケラトサウルス', latin: 'Ceratosaurus', group: '獣脚類', size: 6, diet: '肉', biomes: ['swamp', 'delta', 'fernPrairie'], w: 2 },
    { name: 'トルヴォサウルス', latin: 'Torvosaurus', group: '獣脚類', size: 10, diet: '肉', biomes: ['araucaria', 'temperate'], w: 1 },
    { name: 'ディプロドクス', latin: 'Diplodocus', group: '竜脚類', size: 27, diet: '植', biomes: ['fernPrairie', 'cycadSavanna'], w: 3 },
    { name: 'ブラキオサウルス', latin: 'Brachiosaurus', group: '竜脚類', size: 23, diet: '植', biomes: ['araucaria', 'temperate', 'fernPrairie'], w: 3 },
    { name: 'アパトサウルス', latin: 'Apatosaurus', group: '竜脚類', size: 22, diet: '植', biomes: ['fernPrairie', 'swamp'], w: 2 },
    { name: 'ステゴサウルス', latin: 'Stegosaurus', group: '剣竜類', size: 9, diet: '植', biomes: ['fernPrairie', 'cycadSavanna', 'temperate'], w: 3 },
    { name: 'カンプトサウルス', latin: 'Camptosaurus', group: '鳥脚類', size: 6, diet: '植', biomes: ['fernPrairie', 'delta', 'temperate'], w: 2 },
    { name: 'クリョロフォサウルス', latin: 'Cryolophosaurus', group: '獣脚類', size: 7, diet: '肉', biomes: ['polarForest', 'coldScrub'], w: 2 },
    { name: 'アーケオプテリクス', latin: 'Archaeopteryx', group: '鳥類型', size: 0.5, diet: '雑', biomes: ['lagoon', 'beach', 'araucaria'], w: 2 },
    { name: 'ランフォリンクス', latin: 'Rhamphorhynchus', group: '翼竜', size: 1.2, diet: '魚', biomes: ['lagoon', 'reef', 'shelf', 'epeiric'], w: 3 },
    { name: 'プテロダクティルス', latin: 'Pterodactylus', group: '翼竜', size: 1, diet: '魚', biomes: ['lagoon', 'beach', 'delta'], w: 2 },
    { name: 'リオプレウロドン', latin: 'Liopleurodon', group: '首長竜（プリオサウルス類）', size: 7, diet: '肉', biomes: ['ocean', 'shelf', 'epeiric'], w: 3 },
    { name: 'オフタルモサウルス', latin: 'Ophthalmosaurus', group: '魚竜', size: 6, diet: '魚', biomes: ['ocean', 'abyss', 'shelf'], w: 3 },
    { name: 'レエドシクティス', latin: 'Leedsichthys', group: '硬骨魚', size: 16, diet: '濾過', biomes: ['ocean', 'shelf'], w: 1 },
  ],
  [K]: [
    { name: 'ティラノサウルス', latin: 'Tyrannosaurus', group: '獣脚類', size: 12, diet: '肉', biomes: ['angiosperm', 'delta', 'fernPrairie', 'swamp'], w: 3 },
    { name: 'ギガノトサウルス', latin: 'Giganotosaurus', group: '獣脚類', size: 13, diet: '肉', biomes: ['fernPrairie', 'araucaria', 'cycadSavanna'], w: 2 },
    { name: 'スピノサウルス', latin: 'Spinosaurus', group: '獣脚類', size: 15, diet: '魚', biomes: ['delta', 'swamp', 'lagoon', 'epeiric'], w: 3 },
    { name: 'カルカロドントサウルス', latin: 'Carcharodontosaurus', group: '獣脚類', size: 12, diet: '肉', biomes: ['scrub', 'cycadSavanna', 'desert'], w: 2 },
    { name: 'ヴェロキラプトル', latin: 'Velociraptor', group: 'ドロマエオサウルス類', size: 2, diet: '肉', biomes: ['desert', 'scrub', 'cycadSavanna'], w: 3 },
    { name: 'デイノニクス', latin: 'Deinonychus', group: 'ドロマエオサウルス類', size: 3.4, diet: '肉', biomes: ['angiosperm', 'temperate', 'fernPrairie'], w: 2 },
    { name: 'テリジノサウルス', latin: 'Therizinosaurus', group: '獣脚類', size: 10, diet: '植', biomes: ['angiosperm', 'temperate', 'swamp'], w: 2 },
    { name: 'アルゼンチノサウルス', latin: 'Argentinosaurus', group: '竜脚類', size: 35, diet: '植', biomes: ['fernPrairie', 'araucaria', 'angiosperm'], w: 2 },
    { name: 'トリケラトプス', latin: 'Triceratops', group: '角竜類', size: 9, diet: '植', biomes: ['angiosperm', 'fernPrairie', 'delta'], w: 3 },
    { name: 'アンキロサウルス', latin: 'Ankylosaurus', group: '曲竜類', size: 7, diet: '植', biomes: ['angiosperm', 'fernPrairie', 'temperate'], w: 2 },
    { name: 'パラサウロロフス', latin: 'Parasaurolophus', group: 'ハドロサウルス類', size: 10, diet: '植', biomes: ['delta', 'swamp', 'angiosperm'], w: 3 },
    { name: 'エドモントサウルス', latin: 'Edmontosaurus', group: 'ハドロサウルス類', size: 12, diet: '植', biomes: ['delta', 'polarForest', 'angiosperm'], w: 3 },
    { name: 'パキケファロサウルス', latin: 'Pachycephalosaurus', group: '堅頭竜類', size: 4.5, diet: '雑', biomes: ['highland', 'fernPrairie', 'temperate'], w: 2 },
    { name: 'ケツァルコアトルス', latin: 'Quetzalcoatlus', group: '翼竜', size: 11, diet: '肉', biomes: ['fernPrairie', 'delta', 'epeiric', 'beach'], w: 2 },
    { name: 'プテラノドン', latin: 'Pteranodon', group: '翼竜', size: 6, diet: '魚', biomes: ['epeiric', 'shelf', 'ocean', 'beach'], w: 3 },
    { name: 'モササウルス', latin: 'Mosasaurus', group: 'モササウルス類', size: 13, diet: '肉', biomes: ['epeiric', 'shelf', 'ocean'], w: 3 },
    { name: 'エラスモサウルス', latin: 'Elasmosaurus', group: '首長竜', size: 10, diet: '魚', biomes: ['epeiric', 'shelf', 'ocean'], w: 3 },
    { name: 'アーケロン', latin: 'Archelon', group: 'ウミガメ類', size: 4, diet: '雑', biomes: ['epeiric', 'shelf', 'lagoon'], w: 2 },
    { name: 'ヘスペロルニス', latin: 'Hesperornis', group: '鳥類', size: 1.8, diet: '魚', biomes: ['epeiric', 'shelf', 'beach'], w: 2 },
    { name: 'ディディモケラス', latin: 'Didymoceras', group: '異常巻アンモナイト', size: 0.5, diet: '濾過', biomes: ['epeiric', 'shelf', 'reef'], w: 2 },
  ],
};

export const FLORA = {
  [T]: ['ディクロイディウム（シダ種子類）', 'ヴォルツィア（球果類）', 'ソテツ類', 'トクサ類', 'グロッソプテリス残存林'],
  [J]: ['ナンヨウスギ（アラウカリア）', 'イチョウ類', 'ベネチテス類', 'ヘゴ状木性シダ', 'マツ科の祖先型'],
  [K]: ['モクレン類（初期被子植物）', 'プラタナス類', 'スギ・メタセコイア', 'ヤシ状単子葉', 'イネ科の初期型', 'イチョウ残存林'],
};

/** 指定バイオームに棲む生物を重み付きで返す */
export function faunaFor(eraId, biomeId) {
  return (FAUNA[eraId] || []).filter((f) => f.biomes.includes(biomeId));
}
