/**
 * Service Worker：インストールして「アプリとして」開けるようにする。
 *
 * 方針は network-first。生成器を書き換えながら開発するので、
 * つながっていれば必ず最新を取りに行き、取れないときだけキャッシュを返す。
 * （cache-first にすると、直した src/*.js が反映されず何時間も悩むことになる）
 */

const VERSION = 'mesozoic-atlas-v1';
const SHELL = [
  './',
  './index.html',
  './styles.css',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './src/main.js',
  './src/core/rng.js',
  './src/world/eras.js',
  './src/world/timeline.js',
  './src/world/worldgen.js',
  './src/world/hydrology.js',
  './src/world/biomes.js',
  './src/world/fauna.js',
  './src/world/regions.js',
  './src/voxel/blocks.js',
  './src/voxel/models.js',
  './src/voxel/scene.js',
  './src/game/api.js',
  './src/game/physics.js',
  './src/game/player.js',
  './src/render/raster.js',
  './src/render/renderer.js',
  './src/render/globe.js',
  './src/render/voxelview.js',
  './src/render/glmat.js',
  './src/render/palette.js',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  e.respondWith(
    fetch(req)
      .then((res) => {
        const copy = res.clone();
        caches.open(VERSION).then((c) => c.put(req, copy)).catch(() => {});
        return res;
      })
      .catch(() => caches.match(req).then((hit) => hit || caches.match('./index.html'))),
  );
});
