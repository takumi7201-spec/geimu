# ゲームに転用する

`src/game/` は、アトラスの UI から独立した**ゲーム向けの入口**です。
ここだけを import すれば、世界を作り、一区画に降り、当たり判定つきで歩き回り、
別のエンジンへ書き出すところまでができます。DOM に依存しないので、
ブラウザでも Node でも同じ結果になります。

```
src/game/
├── api.js       世界と区画を作る・環境を問い合わせる・書き出す
├── physics.js   高さマップに対する当たり判定と移動（重力・段差・水）
└── player.js    キー入力を体の動きに変える操作役
```

## 最短の例

```js
import { createGameWorld, enterScene, findSpawn } from './src/game/api.js';
import { Explorer } from './src/game/player.js';

const game  = await createGameWorld({ seed: 'pangaea', ma: 160, size: 'medium' });
const scene = await enterScene(game, null, { size: 'large' });   // 見応えのある地点を自動で選ぶ
const you   = new Explorer(scene, findSpawn(scene));

you.key('KeyW', true);                    // 前進を押しっぱなしにする
setInterval(() => {
  const view = you.update(1 / 60);        // 体を 1 フレーム進める
  camera.position.set(...view.eye);       // 目の位置（ブロック単位）
  camera.rotation.set(view.pitch, view.yaw, 0);
}, 16);
```

`ma` は百万年前（70〜250）。`size` は世界の解像度、`enterScene` の `size` は
区画の広さ（`small`〜`huge` ＝ 2.3〜4.6km 四方）です。

## 座標と単位

| 記号 | 意味 |
| --- | --- |
| 1 ブロック | 6 m（`VOX_M`） |
| `scene.total` | 区画の一辺のブロック数（384〜768） |
| `x, z` | 区画内の水平座標（0〜`total`）。配列の添字は `z * total + x` |
| `y` | 高さ（ブロック）。0 が海面。`y * 6` がメートル |
| `scene.height[i]` | その柱の天面。ここに立てる |
| `scene.water[i]` | 水面の高さ。`WATER_NONE`（-32768）は水なし |
| `scene.blockers[i]` | 幹や岩の高さ。**通り抜けられない**が、上には立てない |
| `scene.surf[i]` | 地表ブロック（`BLOCKS` の添字） |

マップ側の座標（`scene.x`, `scene.y`）は正距円筒図法のセル座標で、
緯度経度は `scene.meta.lat` / `scene.meta.lon` にあります。

## 当たり判定（physics.js）

地形は柱の高さマップなので、判定も高さ 1 枚で済みます。オーバーハングは
表現できませんが、区画が 4.6km 四方でも O(1) で当たります。

```js
import { createBody, stepBody, eyeOf, raycast, PHYS } from './src/game/api.js';

const body = createBody(scene, x, z);
stepBody(scene, body, {
  forward: 1, strafe: 0, up: 0,     // -1..1
  yaw: 0.9,                          // 進む向き（ラジアン）
  jump: false, run: false,
}, dt);                              // dt は秒（内部で 0.05 秒に丸める）

const hit = raycast(scene, eyeOf(body), [dx, dy, dz], 400);  // 地表との交点
```

`PHYS` に定数がまとまっています。1 ブロック 6m の世界なので、実寸の人間は
0.28 ブロックしかありません。既定値は**大型恐竜の視点**（目線 2 ブロック＝12m、
歩き 3.4 ブロック/秒）に寄せてあります。別のスケールにしたいときはここを差し替えます。

| 定数 | 既定値 | 意味 |
| --- | --- | --- |
| `eye` | 2.0 | 目線の高さ（ブロック） |
| `radius` | 0.45 | 体の半径 |
| `step` | 1.0 | よじ登れる段差 |
| `walk` / `run` | 3.4 / 8.0 | 速度（ブロック/秒） |
| `jump` / `gravity` | 8.5 / 22 | 跳躍と重力 |
| `buoyancy` | 13 | 浮力。重力の半分より大きいので水面に浮く |

`body.fly = true` にすると重力を切って自由に飛べます（壁はすり抜けます）。

## 環境の問い合わせ

```js
import { sampleColumn, faunaNear, describeScene } from './src/game/api.js';

sampleColumn(scene, x, z);
// → { elevM, depthM, biomeId, biomeName, blockName, wetness, tempC, fauna: [...] }

faunaNear(scene, x, z, 40);   // 半径 40 ブロック以内の個体を近い順に
describeScene(scene);         // 年代・緯度経度・広さ・主要バイオーム
```

`sampleColumn` は NPC の行動判断にも使えます（水辺かどうか、森かどうか、
その環境に何が棲むか）。動物の種は `src/world/fauna.js` の実データから引いています。

## 他のエンジンへ書き出す

```bash
node tools/export-scene.mjs --seed pangaea --ma 160 --scene large --out out/
```

出力は 3 つです。

- `<名前>.json` — 区画まるごと。`format: "mesozoic-voxel-scene/1"`
- `<名前>-height.png` — 高さマップ。**R が上位バイト、G が下位バイト**（値 = R×256+G−32768、単位はブロック）。B は水の有無
- `<名前>-color.png` — 地表色。そのままテクスチャに使える

JSON の中身:

| キー | 内容 |
| --- | --- |
| `meta` | 年代・緯度経度・広さ・主要バイオーム |
| `palette` | ブロック表（`id`, `name`, `color`）。`surface` 配列の添字がここを指す |
| `arrays` | `height`(int16) / `water`(int16) / `blockers`(uint8) / `surface`(uint8) / `biome`(uint8)。いずれも base64、行優先（`z * size + x`） |
| `models` | ボクセルモデル。`boxes` は `[x, y, z, w, h, d, ブロック番号]` |
| `props` | 植生の配置 `[モデル番号, x, y, z, 回転(0-3)]` |
| `fauna` | 動物の配置と種名（`name`, `latin`, `group`, `sizeM`） |
| `spawn` | 立てる出現地点 |

Unity / Godot / three.js のどれでも、`height` から地形メッシュを組み、
`props` の位置に `models` の箱を置けば、ブラウザで見たものと同じ絵になります。

## 差し替えどころ

| やりたいこと | 触る場所 |
| --- | --- |
| 人間サイズで歩きたい | `PHYS`（`eye`, `walk`, `step`）。ブロックを小さくするなら `VOX_M` |
| 別の入力（ゲームパッド等） | `Explorer` を使わず `stepBody` に自前の input を渡す |
| 地形をもっと細かく | `src/voxel/scene.js` の周波数と `SCENE_SIZES` |
| 動植物を増やす | `src/world/fauna.js` と `src/voxel/blocks.js` の `GROUND` |
| 別の年代・惑星配置 | `src/world/eras.js` |
