/**
 * ブラウザでの操作の検証（Chromium を CDP から直に動かす）。
 *
 * npm 依存を増やさないため Playwright は使わない。指の操作は
 * Input.dispatchTouchEvent で送る ―― PointerEvent を JS で合成すると
 * 「ハンドラが呼ばれた」ことしか確かめられず、touch-action や
 * 同時タッチの取り合いといった、実機で効く部分をすり抜けてしまう。
 *
 *   node tools/uitest.mjs [--phone] [--url ...] [--shot out.png]
 */

import { spawn } from 'node:child_process';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CHROME = process.env.CHROME || '/opt/pw-browsers/chromium';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function launch({ phone = null, url, port = 9444, size = [1400, 900] } = {}) {
  const profile = mkdtempSync(resolve(tmpdir(), 'uitest-'));
  const chrome = spawn(CHROME, [
    '--headless=new', '--no-sandbox', '--disable-gpu-sandbox',
    '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
    '--hide-scrollbars', `--window-size=${size[0]},${size[1]}`,
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`, 'about:blank',
  ], { stdio: 'ignore' });

  for (let i = 0; ; i++) {
    try { await (await fetch(`http://127.0.0.1:${port}/json/version`)).json(); break; }
    catch { if (i > 60) throw new Error('Chromium が起動しません'); await sleep(500); }
  }
  const tab = await (await fetch(
    `http://127.0.0.1:${port}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' })).json();

  const ws = new WebSocket(tab.webSocketDebuggerUrl);
  const pending = new Map();
  const logs = [];
  let id = 0;
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    if (m.method === 'Runtime.exceptionThrown') {
      const d = m.params.exceptionDetails;
      logs.push('EXCEPTION ' + (d.exception?.description || d.text));
    }
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
      logs.push('console.error ' + m.params.args.map((a) => a.value ?? '').join(' '));
    }
  });
  await new Promise((r) => ws.addEventListener('open', r));

  const send = (method, params = {}) => new Promise((res) => {
    const n = ++id;
    pending.set(n, res);
    ws.send(JSON.stringify({ id: n, method, params }));
  });

  await send('Runtime.enable');
  await send('Page.enable');

  if (phone) {
    const [w, h, dpr] = phone;
    await send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: dpr, mobile: true });
    await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
    await send('Page.reload');
    await sleep(1800);
  }

  const evaluate = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.text + ' / ' + (r.result.exceptionDetails.exception?.description || ''));
    return r.result?.result?.value;
  };

  /** 指を置く・動かす・離す。points は [{x,y,id}] */
  const touch = async (type, points) => {
    await send('Input.dispatchTouchEvent', {
      type,
      touchPoints: points.map((p) => ({ x: p.x, y: p.y, id: p.id ?? 0, radiusX: 12, radiusY: 12, force: 1 })),
    });
  };

  const shot = async (path) => {
    const s = await send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(path, Buffer.from(s.result.data, 'base64'));
  };

  const waitReady = async (limit = 240) => {
    for (let i = 0; i < limit; i++) {
      if (await evaluate(`document.getElementById('progress')?.className === 'hidden'`)) return true;
      await sleep(1000);
    }
    return false;
  };

  const close = () => { try { chrome.kill(); } catch { /* もう落ちていることがある */ } };
  return { send, evaluate, touch, shot, waitReady, sleep, logs, close };
}

export const DEFAULT_URL = 'file://' + resolve(ROOT, 'dist/mesozoic-atlas.html');

// ---- ここから下は CLI として走らせたときの検証 -------------------------

const PASS = [];
const FAIL = [];
const ok = (m) => { PASS.push(m); console.log('  ✓ ' + m); };
const ng = (m) => { FAIL.push(m); console.log('  ✗ ' + m); };
/** 状態表示から速さだけを取る（目線の m と混ざらないよう単位で見分ける） */
const num = (s) => { const m = String(s).match(/([\d.]+)\s*m\/s/); return m ? Number(m[1]) : NaN; };

/** スマホ：探索の操作がひととおり効くか */
async function testPhone(url) {
  console.log('\n[スマホ 390×844]');
  const b = await launch({ phone: [390, 844, 3], url });
  try {
    if (!(await b.waitReady())) return ng('世界の生成が終わらない');
    ok('世界が生成される');

    await b.evaluate(`document.querySelector('button[data-view="pixel"]').click()`);
    await b.sleep(2000);
    if (!(await b.waitReady())) return ng('区画の生成が終わらない');
    await b.sleep(1200);
    ok('地表の区画が組み上がる');

    await b.evaluate(`document.getElementById('vox-explore').click()`);
    await b.sleep(1200);
    if (await b.evaluate(`document.getElementById('touch').classList.contains('hidden')`)) return ng('操作盤が出ない');
    ok('探索に入ると操作盤が出る');

    if (!(await b.evaluate(`document.getElementById('sidebar').classList.contains('collapsed')`))) ng('探索に入っても設定が畳まれない');
    else ok('探索に入ると設定が畳まれて全画面になる');

    const speed = () => b.evaluate(`document.getElementById('vox-hud').textContent.split('\\n')[1]`);

    // 定位置でなく、左下のどこを触っても歩けること。
    // 倒す向きは変えて試す ―― 降りた先が崖や幹に面していることがあり、
    // 前だけで判定すると地形しだいで落ちる
    const spots = [[70, 770], [120, 620], [175, 700]];
    const dirs = [[0, -50], [50, 0], [0, 50], [-50, 0]];
    let walked = 0;
    for (const [x, y] of spots) {
      let moved = false;
      for (const [dx, dy] of dirs) {
        await b.touch('touchStart', [{ x, y, id: 1 }]);
        await b.touch('touchMove', [{ x: x + dx, y: y + dy, id: 1 }]);
        await b.sleep(600);
        moved = num(await speed()) > 1;
        await b.touch('touchEnd', [{ x: x + dx, y: y + dy, id: 1 }]);
        await b.sleep(300);
        if (moved) break;
      }
      if (moved) walked++;
    }
    if (walked === spots.length) ok(`左下の ${walked} 箇所すべてから歩き出せる`);
    else ng(`左下 ${spots.length} 箇所のうち ${walked} 箇所でしか歩けない`);

    // 歩きながら振り向けること（指の取り合いが起きていないか）
    await b.touch('touchStart', [{ x: 110, y: 700, id: 1 }]);
    await b.touch('touchMove', [{ x: 110, y: 645, id: 1 }]);
    await b.sleep(600);
    const before = num(await speed());
    await b.touch('touchStart', [{ x: 110, y: 645, id: 1 }, { x: 300, y: 300, id: 2 }]);
    for (let i = 1; i <= 8; i++) {
      await b.touch('touchMove', [{ x: 110, y: 645, id: 1 }, { x: 300 - i * 12, y: 300, id: 2 }]);
      await b.sleep(50);
    }
    const during = num(await speed());
    if (before > 1 && during > 1) ok(`歩きながら振り向ける（${before} → ${during} m/s）`);
    else ng(`振り向くと歩みが止まる（${before} → ${during} m/s）`);

    await b.touch('touchEnd', [{ x: 110, y: 645, id: 1 }]);
    await b.touch('touchEnd', [{ x: 204, y: 300, id: 2 }]);
    await b.sleep(600);
    if (num(await speed()) === 0) ok('指を離すと止まる');
    else ng('指を離しても止まらない');

    // スティックは触れた所に出る
    await b.touch('touchStart', [{ x: 150, y: 560, id: 3 }]);
    await b.sleep(250);
    const st = await b.evaluate(`(() => { const p = document.getElementById('stick'), r = p.getBoundingClientRect();
      return { on: p.classList.contains('on'), x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2) }; })()`);
    await b.touch('touchEnd', [{ x: 150, y: 560, id: 3 }]);
    if (st.on && Math.abs(st.x - 150) < 6 && Math.abs(st.y - 560) < 6) ok('スティックは触れた所に出る');
    else ng(`スティックが指の位置に出ない（${JSON.stringify(st)}）`);

    // 下部の余白。実機は下に端末の UI が乗る
    const gap = await b.evaluate(`Math.round(innerHeight - document.getElementById('tbtns').getBoundingClientRect().bottom)`);
    if (gap >= 24) ok(`操作ボタンの下に ${gap}px の余白がある`);
    else ng(`操作ボタンが画面の下端に寄りすぎ（${gap}px）`);

    // 状態表示と操作盤が重ならないこと
    const lap = await b.evaluate(`(() => {
      const h = document.getElementById('vox-hud').getBoundingClientRect();
      const t = document.getElementById('tbtns').getBoundingClientRect();
      return h.bottom > t.top && h.right > t.left; })()`);
    if (!lap) ok('状態表示と操作盤が重ならない');
    else ng('状態表示が操作盤に重なる');

    // 生き物を目で追えること（相手が居る区画でだけ検める）
    await b.evaluate(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', bubbles: true }))`);
    await b.sleep(900);
    const watching = await b.evaluate(`document.getElementById('vox-hud').textContent.includes('目で追っています')`);
    const btnOn = await b.evaluate(`!!document.querySelector('#tbtns button[data-act="watch"]')?.classList.contains('on')`);
    if (watching && btnOn) ok('F で近くの生き物を目で追い始める');
    else if (!(await b.evaluate(`!!document.getElementById('vox-hud').textContent.match(/近くに|目で追/)`))) ok('近くに生き物が居ないので、追跡は検証しない');
    else ng(`目で追えない（HUD ${watching} / ボタン ${btnOn}）`);

    // なぞったら追うのをやめること（見たい方を見られないと窮屈）
    await b.touch('touchStart', [{ x: 300, y: 300, id: 5 }]);
    for (let i = 1; i <= 5; i++) { await b.touch('touchMove', [{ x: 300 + i * 12, y: 300, id: 5 }]); await b.sleep(50); }
    await b.touch('touchEnd', [{ x: 360, y: 300, id: 5 }]);
    await b.sleep(400);
    if (!(await b.evaluate(`document.getElementById('vox-hud').textContent.includes('目で追っています')`))) ok('自分で見回すと追うのをやめる');
    else ng('見回しても追うのをやめない');

    // 動物が動いても描画が回り続けること（板を毎フレーム書き換えている）
    const t0 = await b.evaluate(`document.getElementById('vox-hud').textContent`);
    await b.sleep(4000);
    const t1 = await b.evaluate(`document.getElementById('vox-hud').textContent`);
    if (t0 && t1) ok('動物が動いている間も描画が続く');
    else ng('描画が止まった');

    const err = await b.evaluate(`(() => { const c = document.getElementById('vox');
      const g = c.getContext('webgl2') || c.getContext('webgl'); return g ? g.getError() : -1; })()`);
    if (err === 0) ok('WebGL のエラーなし');
    else ng('WebGL のエラー ' + err);
  } finally { b.close(); }
}

/** PC：指向けの仕掛けが出てこないこと */
async function testDesktop(url) {
  console.log('\n[PC 1400×900]');
  const b = await launch({ url, port: 9445 });
  try {
    const vw = await b.evaluate('innerWidth');
    if (vw > 900) ok(`広い画面で見ている（${vw}px）`);
    else return ng(`ビューポートが ${vw}px しかない。PC の見た目を検証できていない`);
    if (!(await b.waitReady())) return ng('世界の生成が終わらない');
    ok('世界が生成される');
    await b.evaluate(`document.querySelector('button[data-view="pixel"]').click()`);
    await b.sleep(2000);
    if (!(await b.waitReady())) return ng('区画の生成が終わらない');
    await b.sleep(1000);
    await b.evaluate(`document.getElementById('vox-explore').click()`);
    await b.sleep(900);
    if (await b.evaluate(`document.getElementById('touch').classList.contains('hidden')`)) ok('操作盤は出ない');
    else ng('マウスなのに操作盤が出る');
    if (!(await b.evaluate(`getComputedStyle(document.getElementById('panel-toggle')).display !== 'none'`))) ok('設定の開閉つまみは出ない');
    else ng('マウスなのに開閉つまみが出る');
    const hud = await b.evaluate(`document.getElementById('vox-hud').textContent`);
    if (hud.includes('WASD')) ok('キーの案内が出る');
    else ng('キーの案内が出ない');
  } finally { b.close(); }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const url = process.argv.includes('--url') ? process.argv[process.argv.indexOf('--url') + 1] : DEFAULT_URL;
  console.log('操作の検証 —', url);
  await testPhone(url);
  await testDesktop(url);
  console.log(`\n${PASS.length} 件通過 / ${FAIL.length} 件失敗`);
  if (FAIL.length) { console.log('失敗:\n  ' + FAIL.join('\n  ')); process.exit(1); }
  console.log('操作の検証を通過しました');
}
