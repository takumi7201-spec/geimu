/**
 * 単一 HTML ファイルへのバンドル（依存パッケージなし）。
 *
 * file:// で開いたときブラウザは外部ファイルの import を CORS で拒否するが、
 * インラインの <script type="module"> は許す。なので全モジュールを依存順に
 * 連結してひとつの inline script にし、CSS も <style> に畳んで 1 枚の HTML にする。
 *
 * バンドラを外から入れないのは、この生成物こそが「何も要らずに遊べる版」だから。
 * ビルドに npm install が要るなら、サーバを立てられない人にはやはり届かない。
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const IMPORT_RE = /^import\s+(?:(\*\s+as\s+\w+)|\{([^}]*)\}|(\w+))\s+from\s+['"]([^'"]+)['"];?\s*$/gm;
const EXPORT_LIST_RE = /^export\s*\{([^}]*)\};?\s*$/gm;
const EXPORT_DECL_RE = /^export\s+(?=(?:const|let|var|function|class|async)\b)/gm;

/** そのモジュールがトップレベルに出す名前を集める（namespace import の合成に要る） */
function exportedNames(src) {
  const names = new Set();
  for (const m of src.matchAll(/^export\s+(?:async\s+)?(?:const|let|var|function|class)\s+(\w+)/gm)) {
    names.add(m[1]);
  }
  for (const m of src.matchAll(EXPORT_LIST_RE)) {
    for (const part of m[1].split(',')) {
      const t = part.trim();
      if (!t) continue;
      const as = t.split(/\s+as\s+/);
      names.add((as[1] || as[0]).trim());
    }
  }
  return names;
}

/** エントリから静的 import を辿り、依存が先に来る順で並べる */
function collect(entry) {
  const order = [];
  const seen = new Set();
  const visiting = new Set();

  function walk(file) {
    if (seen.has(file)) return;
    if (visiting.has(file)) {
      throw new Error(`循環参照: ${relative(ROOT, file)}`);
    }
    visiting.add(file);

    const src = readFileSync(file, 'utf8');
    const deps = [];
    for (const m of src.matchAll(IMPORT_RE)) {
      deps.push({ ns: m[1], named: m[2], def: m[3], from: resolve(dirname(file), m[4]) });
    }
    for (const d of deps) walk(d.from);

    visiting.delete(file);
    seen.add(file);
    order.push({ file, src, deps });
  }

  walk(entry);
  return order;
}

/** import/export を剥がして、IIFE に閉じられる素のコードにする */
function strip(mod, exportsByFile) {
  let src = mod.src;

  // namespace import は連結後に実体が無くなるので、名前を集めたオブジェクトで代用する
  src = src.replace(IMPORT_RE, (_all, ns, _named, _def, from) => {
    if (!ns) return '';
    const alias = ns.replace(/^\*\s+as\s+/, '').trim();
    const target = resolve(dirname(mod.file), from);
    const names = [...(exportsByFile.get(target) || [])];
    return `const ${alias} = { ${names.join(', ')} };\n`;
  });

  // `export { a, b as c }` は再エクスポート。別名だけ実体に束ね直す
  src = src.replace(EXPORT_LIST_RE, (_all, list) => {
    const lines = [];
    for (const part of list.split(',')) {
      const t = part.trim();
      if (!t) continue;
      const [orig, alias] = t.split(/\s+as\s+/).map((s) => s.trim());
      if (alias && alias !== orig) lines.push(`const ${alias} = ${orig};`);
    }
    return lines.join('\n');
  });

  return src.replace(EXPORT_DECL_RE, '');
}

/** 同一スコープに並べるので、そのコードがトップレベルに宣言する名前を拾う */
function topLevelNames(src) {
  const names = new Set();
  for (const m of src.matchAll(/^(?:async\s+)?(?:const|let|var|function|class)\s+(\w+)/gm)) {
    names.add(m[1]);
  }
  return names;
}

export function bundle() {
  const entry = resolve(ROOT, 'src/main.js');
  const mods = collect(entry);

  const exportsByFile = new Map();
  for (const m of mods) exportsByFile.set(m.file, exportedNames(m.src));

  const chunks = [];

  for (const mod of mods) {
    const body = strip(mod, exportsByFile).trim();
    const declared = topLevelNames(body);
    // 素通しの再エクスポート（renderer.js の VIEW_MODES など）は元のモジュールが
    // すでに外へ出しているので、ここで返すと同じ名前を二度宣言することになる
    const names = [...exportsByFile.get(mod.file)].filter((n) => declared.has(n));
    const rel = relative(ROOT, mod.file);

    // モジュールごとに閉じる。連結すると nextTick や compile のような内部ヘルパが
    // 名前でぶつかるため、公開する名前だけを外へ返す（リネームより壊れにくい）
    chunks.push(names.length
      ? `// ===== ${rel} =====\nconst { ${names.join(', ')} } = await (async () => {\n${body}\nreturn { ${names.join(', ')} };\n})();\n`
      : `// ===== ${rel} =====\nawait (async () => {\n${body}\n})();\n`);
  }

  const js = chunks.join('\n');
  const css = readFileSync(resolve(ROOT, 'styles.css'), 'utf8');
  let html = readFileSync(resolve(ROOT, 'index.html'), 'utf8');

  // file:// では manifest もアイコンも意味を持たない。参照だけ残ると 404 を引く
  html = html.replace(/^\s*<link rel="manifest"[^>]*>\s*$/m, '');
  html = html.replace(/^\s*<link rel="apple-touch-icon"[^>]*>\s*$/m, '');
  html = html.replace(/^\s*<link rel="stylesheet"[^>]*>\s*$/m, `<style>\n${css}\n</style>`);
  html = html.replace(
    /^\s*<script type="module" src="src\/main\.js"><\/script>\s*$/m,
    `<script type="module">\n${js}\n</script>`
  );

  if (html.includes('src="src/main.js"')) throw new Error('エントリの差し替えに失敗しました');

  mkdirSync(resolve(ROOT, 'dist'), { recursive: true });
  const outFile = resolve(ROOT, 'dist/mesozoic-atlas.html');
  writeFileSync(outFile, html);
  return { outFile, modules: mods.length, bytes: Buffer.byteLength(html) };
}

const r = bundle();
console.log(`${relative(ROOT, r.outFile)} — ${r.modules} モジュール / ${(r.bytes / 1024).toFixed(0)} KB`);
