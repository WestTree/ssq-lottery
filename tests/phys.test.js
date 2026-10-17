/**
 * 物理摇奖机 · 无头模拟测试
 * 运行: node ssq/tests/phys.test.js
 * 说明: 从 index.html 提取 /*__PHYS_START__*​/ ... /*__PHYS_END__*​/ 之间的模拟核心，
 *       在 Node 中以固定步长(1/240s)驱动完整开奖流程，验证：
 *       - 一注 7 球能由物理过程自然完成（6 红 + 1 蓝，红球不重复）
 *       - 每次出球都发生在正确的资格相位（前 6 球只出红球，第 7 球只出蓝球）
 *       - 出球口关闭时无球逃逸；全程无 NaN、无超速、初始化无重叠
 *       - 相同随机种子结果完全可复现
 */
'use strict';
const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const m = html.match(/\/\*__PHYS_START__\*\/([\s\S]*?)\/\*__PHYS_END__\*\//);
if (!m) {
  console.error('FAIL: 未找到物理模拟标记块 __PHYS_START__/__PHYS_END__');
  process.exit(1);
}
// 构造即语法校验
new Function(html.match(/<script>([\s\S]*?)<\/script>/)[1]);

const S = new Function(m[1] +
  '\nreturn { PHYS, RED_OUT, BLUE_OUT, RED_TUBE, BLUE_TUBE, RED_TRAY, BLUE_TRAY, simCreate, simReset, simStart, simStep, closestOnPolyline, lcgFromSeed, newSeed };')();

let fail = 0;
const assert = (c, msg) => { if (!c) { fail++; console.error('FAIL:', msg); } };

// 可复现的线性同余随机源
function makeLCG(seed) {
  let s = (seed >>> 0) || 1;
  return function () {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function runDraw(seed, maxT, numericSeed) {
  maxT = maxT || 45;
  const rng = makeLCG(seed);
  const events = { exits: [], done: null, capturedOmega: [] };
  const s = S.simCreate(numericSeed ? seed : rng, {
    onEject: (b) => events.exits.push({ n: b.n, color: b.color, drum: b.drum, needBlue: s.needBlue }),
    onDrawDone: (c) => { events.done = c; },
    onCapture: (n, color, count, ball) => { if (ball) events.capturedOmega.push(Math.abs(ball.omega)); },
  });
  S.simReset(s);
  S.simStart(s);
  const dt = 1 / 240;
  let t = 0, escaped = 0, maxSpeed = 0, nan = false;
  let maxTubeOmega = 0, rollViolations = 0, contactSamples = 0;
  let blueStaticViolations = 0, blueStarted = false, blueRestSpeed = 0;
  while (!events.done && t < maxT) {
    S.simStep(s, dt);
    t += dt;
    // 蓝球机在红球出完前不得摇动（鼓壁角速度恒为 0）；needBlue 之后必须启动
    if (!s.needBlue) {
      if (s.omegaBlue !== 0) blueStaticViolations++;
      if (s.simTime > 3) {
        for (const b of s.balls) {
          if (b.drum === 'blue' && b.state === 'drum') {
            const sp = Math.hypot(b.vx, b.vy);
            if (sp > blueRestSpeed) blueRestSpeed = sp;
          }
        }
      }
    } else if (s.omegaBlue > 0) {
      blueStarted = true;
    }
    for (let i = 0; i < s.balls.length; i++) {
      const b = s.balls[i];
      if (!isFinite(b.x) || !isFinite(b.y) || !isFinite(b.vx) || !isFinite(b.vy) || !isFinite(b.omega)) { nan = true; }
      const sp = Math.hypot(b.vx, b.vy);
      if (sp > maxSpeed) maxSpeed = sp;
      if (b.state === 'drum' && !s.outletOpen) {
        // 分属两台机器，各自不得鼓腔
        const D = b.drum === 'red' ? S.PHYS.redDrum : S.PHYS.blueDrum;
        const d = Math.hypot(b.x - D.cx, b.y - D.cy);
        if (d > D.R + 1) escaped++;
      }
      // 滚动不变量：管道内球接触管壁时，角速度应满足纯滚动 ω = -vt/r
      if (b.state === 'tube') {
        if (Math.abs(b.omega) > maxTubeOmega) maxTubeOmega = Math.abs(b.omega);
        const T = b.drum === 'red' ? S.RED_TUBE : S.BLUE_TUBE;
        const cp = S.closestOnPolyline(T.segs, b.x, b.y);
        const dx = b.x - cp.x, dy = b.y - cp.y;
        const d = Math.hypot(dx, dy) || 1;
        const maxD = S.PHYS.tubeHW - S.PHYS.ballR;
        // 仅当球真正贴合管壁（投影约束本步已触发，d 被压回 maxD）时校验纯滚动；
        // 空中飞行帧保持恒自旋是正确物理，不参与校验
        if (d > maxD - 0.01) {
          const nx = dx / d, ny = dy / d;
          const tx = -ny, ty = nx;
          const vt = b.vx * tx + b.vy * ty;
          const expect = -vt / S.PHYS.ballR;
          contactSamples++;
          if (Math.abs(b.omega - expect) > 4) rollViolations++;
        }
      }
    }
  }
  return { s, events, t, escaped, maxSpeed, nan, maxTubeOmega, rollViolations, contactSamples, blueStaticViolations, blueStarted, blueRestSpeed };
}

function checkDraw(tag, r) {
  assert(r.events.done !== null, `${tag}: 未能在 ${45}s 模拟时间内完成开奖（phase=${r.s.phase}）`);
  if (!r.events.done) return;
  const cap = r.events.done;
  assert(cap.length === 7, `${tag}: 出球数量=${cap.length}，应为 7`);
  const reds = cap.slice(0, 6), blue = cap[6];
  assert(reds.every(c => c.color === 'red'), `${tag}: 前 6 球必须全是红球`);
  assert(blue && blue.color === 'blue', `${tag}: 第 7 球必须是蓝球`);
  const nums = reds.map(c => c.n);
  assert(nums.every(n => n >= 1 && n <= 33), `${tag}: 红球号码越界`);
  assert(new Set(nums).size === 6, `${tag}: 红球存在重复`);
  assert(blue && blue.n >= 1 && blue.n <= 16, `${tag}: 蓝球号码越界`);
  // 出球资格：前 6 球必须出自红球机，第 7 球必须出自蓝球机
  for (let k = 0; k < r.events.exits.length; k++) {
    const e = r.events.exits[k];
    const wantDrum = k < 6 ? 'red' : 'blue';
    const wantColor = k < 6 ? 'red' : 'blue';
    assert(e.drum === wantDrum, `${tag}: 第 ${k + 1} 球出自${e.drum}机，应出自${wantDrum}机`);
    assert(e.color === wantColor, `${tag}: 第 ${k + 1} 球颜色 ${e.color} 应为 ${wantColor}`);
  }
  assert(r.events.exits.length === 7, `${tag}: 实际出球次数=${r.events.exits.length}`);
  assert(!r.nan, `${tag}: 出现 NaN`);
  assert(r.escaped === 0, `${tag}: 出球口关闭时有 ${r.escaped} 次球逃逸`);
  assert(r.maxSpeed <= S.PHYS.maxBallSpeed + 60, `${tag}: 球速超限 maxSpeed=${r.maxSpeed.toFixed(0)}`);
  // 滚动验证
  assert(r.maxTubeOmega > 5, `${tag}: 下滑过程未发生滚动（maxOmega=${r.maxTubeOmega.toFixed(1)}）`);
  assert(r.contactSamples > 50, `${tag}: 接触采样不足（${r.contactSamples}）`);
  assert(r.rollViolations / Math.max(1, r.contactSamples) < 0.02,
    `${tag}: 纯滚动被违反 ${r.rollViolations}/${r.contactSamples} 次`);
  const maxCapOmega = Math.max(0, ...r.events.capturedOmega);
  assert(maxCapOmega < 4, `${tag}: 落定时仍在自旋（omega=${maxCapOmega.toFixed(2)}）`);
  // 双机台时序：红球出完前蓝球机不得摇动，且蓝球确实已静置；第 7 球前蓝球机必须启动
  assert(r.blueStaticViolations === 0,
    `${tag}: 红球阶段蓝球机发生转动 ${r.blueStaticViolations} 步（应完全静止）`);
  assert(r.blueRestSpeed < 40,
    `${tag}: 红球阶段蓝球未静置（maxSpeed=${r.blueRestSpeed.toFixed(1)}）`);
  assert(r.blueStarted, `${tag}: 蓝球机在红球出完后未启动`);
}

// ---- 1. 多种子完整开奖 ----
const SEEDS = [1, 7, 42, 2024, 888, 31415, 65535, 123456];
for (const seed of SEEDS) {
  const r = runDraw(seed);
  checkDraw('seed=' + seed, r);
  console.log(`seed=${seed} 完成: ${r.events.done ? r.events.done.map(c => c.n).join(',') : 'FAILED'} 用时 ${r.t.toFixed(1)}s`);
}

// ---- 2. 可复现性 ----
{
  const a = runDraw(42), b = runDraw(42);
  assert(JSON.stringify(a.events.done) === JSON.stringify(b.events.done),
    '相同种子应产生完全相同的开奖结果');
}

// ---- 3. 初始化不变量：49 球、分机装载、无重叠、全部在各自鼓内 ----
{
  const s = S.simCreate(makeLCG(9), {});
  S.simReset(s);
  assert(s.balls.length === 49, '初始化应有 49 颗球');
  assert(s.balls.filter(b => b.drum === 'red').length === 33, '红球机应装 33 颗');
  assert(s.balls.filter(b => b.drum === 'blue').length === 16, '蓝球机应装 16 颗');
  let maxOverlap = 0, outside = 0, wrongDrum = 0;
  for (let i = 0; i < s.balls.length; i++) {
    for (let j = i + 1; j < s.balls.length; j++) {
      const a = s.balls[i], b = s.balls[j];
      if (a.drum !== b.drum) continue;
      const d = Math.hypot(b.x - a.x, b.y - a.y);
      const ov = S.PHYS.ballR * 2 - d;
      if (ov > maxOverlap) maxOverlap = ov;
    }
    const b = s.balls[i];
    const D = b.drum === 'red' ? S.PHYS.redDrum : S.PHYS.blueDrum;
    const dc = Math.hypot(b.x - D.cx, b.y - D.cy);
    if (dc > D.R - S.PHYS.ballR + 1) outside++;
    if ((b.drum === 'red') !== (b.color === 'red')) wrongDrum++;
  }
  assert(maxOverlap < 1.5, `初始化重叠过大: ${maxOverlap.toFixed(2)}px`);
  assert(outside === 0, `初始化有 ${outside} 颗球在鼓腔外`);
  assert(wrongDrum === 0, '存在球装错了机台');
}

// ---- 4. 待机混合 10 秒：两台机器均无逃逸、无 NaN、球保持悬浮 ----
{
  const s = S.simCreate(makeLCG(77), {});
  S.simReset(s);
  let escaped = 0, nan = false;
  const dt = 1 / 240;
  for (let i = 0; i < 240 * 10; i++) {
    S.simStep(s, dt);
    for (const b of s.balls) {
      if (!isFinite(b.x) || !isFinite(b.y)) nan = true;
      const D = b.drum === 'red' ? S.PHYS.redDrum : S.PHYS.blueDrum;
      const d = Math.hypot(b.x - D.cx, b.y - D.cy);
      if (!s.outletOpen && d > D.R + 1) escaped++;
    }
  }
  const reds = s.balls.filter(b => b.drum === 'red');
  const avgY = reds.reduce((acc, b) => acc + (b.y - S.PHYS.redDrum.cy), 0) / reds.length;
  assert(!nan, '待机 10s 出现 NaN');
  assert(escaped === 0, `待机 10s 有 ${escaped} 次逃逸`);
  assert(avgY < S.PHYS.redDrum.R * 0.9, `待机 10s 红球沉底 avgY=${avgY.toFixed(1)}，鼓风机应使其悬浮`);
}

// ---- 5. 多注连续开奖（模拟 remaining 链式调用） ----
{
  for (let k = 0; k < 3; k++) {
    const r = runDraw(1000 + k);
    checkDraw('连续第' + (k + 1) + '注', r);
  }
}

// ---- 6. 数值种子（台账/复播基础）：暴露 seed、同种子可复现、不同种子结果不同 ----
{
  const key = r => (r.events.done || []).map(c => c.n + c.color).join(',');
  const a = runDraw(4242, 45, true);
  const b = runDraw(4242, 45, true);
  checkDraw('数值种子 4242', a);
  assert(a.s.seed === 4242, `simCreate(4242) 应暴露 seed=4242，实际 ${a.s.seed}`);
  assert(key(a) === key(b), '同数值种子两次开奖结果应完全一致（复播前提）');
  assert(a.s.simTime > 0, '数值种子开奖 simTime 应大于 0');

  // 不同种子 → 至少出现 2 种不同结果
  const keys = new Set([4242, 4243, 4244, 4245].map(sd => key(runDraw(sd, 45, true))));
  assert(keys.size >= 2, '不同数值种子应产生不同结果');

  // lcgFromSeed：同种子同序列、输出区间 [0,1)
  const r1 = S.lcgFromSeed(99), r2 = S.lcgFromSeed(99);
  let same = true, inRange = true;
  for (let i = 0; i < 2000; i++) {
    const x = r1(), y = r2();
    if (x !== y) same = false;
    if (!(x >= 0 && x < 1)) inRange = false;
  }
  assert(same, 'lcgFromSeed 同种子应产生同序列');
  assert(inRange, 'lcgFromSeed 输出应落在 [0,1)');
  assert(S.simCreate(0, {}).seed === 0, '种子 0 应原样保留');
  assert(typeof S.newSeed() === 'number' && S.newSeed() >= 0, 'newSeed 应返回非负整数');
}

if (fail) {
  console.error(`\n共 ${fail} 个断言失败`);
  process.exit(1);
}
console.log('\nPHYS TESTS ALL PASSED');
