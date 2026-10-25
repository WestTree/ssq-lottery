#!/usr/bin/env node
/**
 * 历史记录落盘回归测试（headless Chrome 驱动真实页面）
 *
 * 覆盖三个场景：
 *   1. 正常存储：物理摇奖结束后必须出现 1 条历史记录，并给出「已记入历史」提示
 *   2. 存储被禁（模拟 QuotaExceededError）：页面不得抛错、不得留白，
 *      记录降级到内存、必须有红色警告提示（旧版此处是静默失败）
 *   3. 连摇两次：必须追加成 2 条，且时间戳主键唯一（fresh 只高亮最新一条）
 *
 * 运行：node tests/history.test.js
 * 依赖：本机 Google Chrome（找不到时以 SKIP 退出，不算失败）
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'index.html');
const CHROME_CANDIDATES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
];

function findChrome() {
  for (const p of CHROME_CANDIDATES) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

// 在 IIFE 结束前挂调试桥；在 </body> 前注入探针脚本
function buildProbe(html, mode) {
  const bridge = `
  window.__T = {
    start: physicsStart,
    get sim() { return machineUI.sim; },
    step: simStep,
    ui: updateMachineUI,
    render: renderMachine,
    get state() { return state; },
    get hist() { return loadHistory(); },
    get storageError() { return storageError; }
  };
`;
  const probe = `
<script>
window.__ERRS = [];
window.addEventListener('error', function (e) { window.__ERRS.push(e.message || String(e.error)); });
window.addEventListener('load', function () {
  setTimeout(function () {
    var T = window.__T, L = [];
    function p(s) { L.push(s); }
    function drive() {
      var sim = T.sim, dt = 1 / 240;
      if (!sim) return null;
      for (var i = 0; i < 240 * 30 && sim.phase !== 'done'; i++) T.step(sim, dt);
      return sim.phase;
    }
    try {
      // 回归守卫：hidden 属性必须真的隐藏（作者样式里的 display 容易把它盖掉）
      var sn0 = document.getElementById('saveNote');
      p('noteInit=' + getComputedStyle(sn0).display);
      document.getElementById('genBtn').click();
      p('phase=' + drive());
      T.ui();
      if (${JSON.stringify(mode)} === 'twice') {
        document.getElementById('genBtn').click();
        p('phase2=' + drive());
      }
      var h = T.hist;
      p('histN=' + h.length);
      p('mode=' + (h[0] ? h[0].mode : 'none'));
      p('seed=' + (h[0] ? h[0].seed : 'none'));
      p('tk=' + (h[0] && h[0].tickets && h[0].tickets[0]
        ? h[0].tickets[0].reds.join(',') + '+' + h[0].tickets[0].blue : 'none'));
      p('rows=' + document.querySelectorAll('#historyList li').length);
      p('fresh=' + document.querySelectorAll('#historyList li.fresh').length);
      p('cnt=' + (document.getElementById('historyCount') || {}).textContent);
      var sn = document.getElementById('saveNote');
      p('note=' + (sn.hidden ? 'hidden'
        : (sn.classList.contains('warn') ? 'WARN' : 'OK')));
      p('storageError=' + (T.storageError || 'none'));
      p('errs=' + (window.__ERRS.length ? window.__ERRS.join(';') : 'none'));
    } catch (e) { p('ERR:' + e.message); }
    document.title = 'P|' + L.join('|');
  }, 400);
});
</script>
`;

  const anchor = '\n  init();\n})();';
  if (html.indexOf(anchor) < 0) throw new Error('页面结构变化：找不到 init() 锚点');
  let out = html.replace(anchor, bridge + anchor);

  if (mode === 'blocked') {
    // 在页面脚本之前劫持 localStorage.setItem，模拟隐私模式/配额耗尽
    const block = `
<script>
(function () {
  var proto = Object.getPrototypeOf(window.localStorage);
  var orig = proto.setItem;
  proto.setItem = function (k, v) {
    if (String(k).indexOf('ssq.') === 0) {
      var e = new Error('simulated'); e.name = 'QuotaExceededError'; throw e;
    }
    return orig.call(this, k, v);
  };
})();
</script>
`;
    out = out.replace('<script src="data/ssq.js">', block + '<script src="data/ssq.js">');
  }
  return out.replace('</body>', probe + '</body>');
}

function runCase(chrome, html, mode, label) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ssq-hist-'));
  const file = path.join(tmp, 'probe.html');
  fs.writeFileSync(file, buildProbe(html, mode));
  // 探针页依赖同目录的 data/ssq.js
  const dataDir = path.join(ROOT, 'data');
  if (fs.existsSync(dataDir)) {
    fs.cpSync(dataDir, path.join(tmp, 'data'), { recursive: true });
  }
  const dom = execFileSync(chrome, [
    '--headless=new', '--disable-gpu', '--no-sandbox',
    '--user-data-dir=' + path.join(tmp, 'profile'),
    '--allow-file-access-from-files',
    '--virtual-time-budget=30000',
    '--dump-dom', 'file://' + file,
  ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  fs.rmSync(tmp, { recursive: true, force: true });

  const m = dom.match(/<title>P\|([^<]*)<\/title>/);
  if (!m) throw new Error(label + '：探针未产出结果（页面可能加载失败）');
  const kv = {};
  m[1].split('|').forEach(function (seg) {
    const i = seg.indexOf('=');
    if (i > 0) kv[seg.slice(0, i)] = seg.slice(i + 1);
  });
  return kv;
}

// ===== 断言 =====
let pass = 0, fail = 0;
function assert(cond, msg, detail) {
  if (cond) { pass++; console.log('  ✓ ' + msg); }
  else { fail++; console.log('  ✗ ' + msg + (detail ? '  → ' + detail : '')); }
}

function main() {
  const chrome = findChrome();
  if (!chrome) {
    console.log('SKIP: 未找到 Chrome，跳过浏览器级历史记录测试');
    return;
  }
  const html = fs.readFileSync(SRC, 'utf8');

  console.log('【1】正常存储：物理摇奖后应写入历史');
  const a = runCase(chrome, html, 'ok', 'normal');
  assert(a.phase === 'done', '物理过程跑完', a.phase);
  assert(a.noteInit === 'none', '未摇奖时提示条保持隐藏（不占位）', a.noteInit);
  assert(a.histN === '1', '历史记录写入 1 条', a.histN);
  assert(a.mode === 'physics', '记录来源标记为 physics', a.mode);
  assert(/^\d+$/.test(a.seed || ''), '记录带可复播种子', a.seed);
  assert(/^\d+(,\d+){5}\+\d+$/.test(a.tk || ''), '记录号码为 6 红 + 1 蓝', a.tk);
  assert(a.rows === '1', '历史列表渲染出 1 行', a.rows);
  assert(a.fresh === '1', '新记录被高亮', a.fresh);
  assert(a.cnt === '（1 组）', '历史计数正确', a.cnt);
  assert(a.note === 'OK', '页面给出「已记入历史」提示', a.note);
  assert(a.errs === 'none', '无 JS 异常', a.errs);

  console.log('【2】存储被禁：不得静默丢失，需降级到内存并告警');
  const b = runCase(chrome, html, 'blocked', 'blocked');
  assert(b.phase === 'done', '物理过程仍然跑完', b.phase);
  assert(b.histN === '1', '记录降级到内存镜像，本页仍可见', b.histN);
  assert(b.rows === '1', '历史列表仍然渲染出 1 行', b.rows);
  assert(b.note === 'WARN', '提示切换为警告样式', b.note);
  assert(b.storageError !== 'none', '存储错误被记录（不再吞掉）', b.storageError);
  assert(b.errs === 'none', '无 JS 异常', b.errs);

  console.log('【3】连摇两次：追加记录且主键唯一');
  const c = runCase(chrome, html, 'twice', 'twice');
  assert(c.phase2 === 'done', '第二次摇奖完成', c.phase2);
  assert(c.histN === '2', '历史累计 2 条', c.histN);
  assert(c.rows === '2', '列表渲染 2 行', c.rows);
  assert(c.fresh === '1', '只高亮最新一条（时间戳未撞号）', c.fresh);
  assert(c.cnt === '（2 组）', '历史计数为 2 组', c.cnt);

  console.log('\n' + (fail === 0 ? 'HISTORY TESTS ALL PASSED' : 'HISTORY TESTS FAILED: ' + fail));
  process.exit(fail === 0 ? 0 : 1);
}

main();
