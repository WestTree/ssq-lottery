/**
 * 双色球号码生成器 · 核心逻辑自测
 * 运行: node ssq/tests/core.test.js
 * 说明: 从 index.html 中提取 /*__CORE_START__*​/ ... /*__CORE_END__*​/ 之间的纯函数块，
 *       在 Node 环境中直接构造执行，保证测试对象与线上代码零漂移。
 */
'use strict';
const fs = require('fs');
const path = require('path');

const HTML_PATH = path.join(__dirname, '..', 'index.html');
const html = fs.readFileSync(HTML_PATH, 'utf8');

// 1) 提取核心逻辑块
const m = html.match(/\/\*__CORE_START__\*\/([\s\S]*?)\/\*__CORE_END__\*\//);
if (!m) {
  console.error('FAIL: 未找到核心逻辑标记块 __CORE_START__/__CORE_END__');
  process.exit(1);
}

// 2) 语法校验（仅构造不执行，验证 <script> 整体可解析）
let scriptBody = html.match(/<script>([\s\S]*?)<\/script>/);
if (scriptBody) {
  try {
    new Function(scriptBody[1]); // 构造即语法校验，不会真正运行
  } catch (e) {
    console.error('FAIL: <script> 存在语法错误 ->', e.message);
    process.exit(1);
  }
}

// 3) 构造核心函数
const core = new Function(
  m[1] + '\nreturn { randomInt, pickUnique, generateTicket, parseNums, pad2, formatTicket, sameTicket, PRIZE_NAMES, prizeLevel, checkTicket, normalizeDraw, loadDraws };'
)();

let fail = 0;
function assert(cond, msg) {
  if (!cond) { fail++; console.error('FAIL:', msg); }
}

// ---- randomInt 边界 ----
for (let i = 0; i < 200000; i++) {
  const v = core.randomInt(16);
  if (v < 0 || v > 15) { assert(false, 'randomInt(16) 越界: ' + v); break; }
}
for (let i = 0; i < 50000; i++) {
  const v = core.randomInt(33);
  if (v < 0 || v > 32) { assert(false, 'randomInt(33) 越界: ' + v); break; }
}
assert(core.randomInt(1) === 0, 'randomInt(1) 必须恒为 0');
try { core.randomInt(0); assert(false, 'randomInt(0) 应抛错'); } catch (e) { /* 预期 */ }
try { core.randomInt(1.5); assert(false, 'randomInt(1.5) 应抛错'); } catch (e) { /* 预期 */ }

// ---- randomInt 分布均匀性（无取模偏差） ----
{
  const N = 160000, buckets = new Array(16).fill(0);
  for (let i = 0; i < N; i++) buckets[core.randomInt(16)]++;
  const min = Math.min(...buckets), max = Math.max(...buckets);
  assert(min > N / 16 * 0.9 && max < N / 16 * 1.1,
    `randomInt 分布异常: min=${min} max=${max} 期望≈${N / 16}`);
}

// ---- pickUnique ----
for (let i = 0; i < 50000; i++) {
  const reds = core.pickUnique(33, 6, []);
  if (reds.length !== 6) { assert(false, 'pickUnique 长度 != 6'); break; }
  if (new Set(reds).size !== 6) { assert(false, 'pickUnique 存在重复'); break; }
  if (reds.some(n => n < 1 || n > 33)) { assert(false, 'pickUnique 越界'); break; }
  const sorted = reds.slice().sort((a, b) => a - b);
  if (JSON.stringify(reds) !== JSON.stringify(sorted)) { assert(false, 'pickUnique 未升序'); break; }
}
try { core.pickUnique(3, 6, []); assert(false, 'pickUnique n>pool 应抛错'); } catch (e) { /* 预期 */ }

// ---- generateTicket 机选 ----
for (let i = 0; i < 50000; i++) {
  const t = core.generateTicket([], null);
  if (t.reds.length !== 6 || new Set(t.reds).size !== 6) { assert(false, '机选红球不合法'); break; }
  if (t.reds.some(n => n < 1 || n > 33)) { assert(false, '机选红球越界'); break; }
  if (t.blue < 1 || t.blue > 16) { assert(false, '机选蓝球越界'); break; }
}

// ---- generateTicket 幸运号锁定 ----
for (let i = 0; i < 20000; i++) {
  const t = core.generateTicket([3, 9, 21], 7);
  if (!t.reds.includes(3) || !t.reds.includes(9) || !t.reds.includes(21)) {
    assert(false, '锁定红球缺失'); break;
  }
  if (t.blue !== 7) { assert(false, '锁定蓝球缺失'); break; }
}
{
  const full = core.generateTicket([33, 32, 31, 30, 29, 28], 1);
  assert(JSON.stringify(full.reds) === JSON.stringify([28, 29, 30, 31, 32, 33]), '6 红全锁定场景');
  try { core.generateTicket([1, 2, 3, 4, 5, 6, 7], null); assert(false, '锁定超过 6 个应抛错'); } catch (e) { /* 预期 */ }
}

// ---- parseNums ----
assert(core.parseNums('7,18,26', 1, 33, 6, '红球').ok, 'parseNums 合法输入');
assert(JSON.stringify(core.parseNums('7,18,26', 1, 33, 6, '红球').nums) === JSON.stringify([7, 18, 26]), 'parseNums 解析结果');
assert(core.parseNums('', 1, 33, 6, '红球').ok, 'parseNums 空串应为 ok（无锁定）');
assert(!core.parseNums('34', 1, 33, 6, '红球').ok, 'parseNums 越界应拒绝');
assert(!core.parseNums('0', 1, 33, 6, '红球').ok, 'parseNums 0 应拒绝');
assert(!core.parseNums('abc', 1, 33, 6, '红球').ok, 'parseNums 非数字应拒绝');
assert(!core.parseNums('1,2,3,4,5,6,7', 1, 33, 6, '红球').ok, 'parseNums 7 个唯一号应拒绝');
assert(core.parseNums('1,1,2,3,4,5,6', 1, 33, 6, '红球').ok, 'parseNums 去重后 6 个应放行');
assert(core.parseNums('08', 1, 16, 1, '蓝球').ok, 'parseNums 前导零合法');
assert(!core.parseNums('8,9', 1, 16, 1, '蓝球').ok, 'parseNums 蓝球超过 1 个应拒绝');

// ---- formatTicket ----
assert(core.formatTicket({ reds: [1, 5, 12, 18, 26, 30], blue: 8 }) === '01 05 12 18 26 30 + 08', 'formatTicket 格式');

// ---- pad2 ----
assert(core.pad2(7) === '07' && core.pad2(16) === '16', 'pad2 补零');

// ---- prizeLevel：七个奖级全覆盖 ----
{
  const drawRed = [5, 12, 18, 22, 26, 31], drawBlue = 8;
  const L = (ur, ub) => core.prizeLevel(ur, ub, drawRed, drawBlue);
  assert(L([5, 12, 18, 22, 26, 31], 8) === 1, '一等奖 6+1');
  assert(L([5, 12, 18, 22, 26, 31], 7) === 2, '二等奖 6+0');
  assert(L([5, 12, 18, 22, 26, 9], 8) === 3, '三等奖 5+1');
  assert(L([5, 12, 18, 22, 26, 9], 7) === 4, '四等奖 5+0');
  assert(L([5, 12, 18, 22, 9, 10], 8) === 4, '四等奖 4+1');
  assert(L([5, 12, 18, 22, 9, 10], 7) === 5, '五等奖 4+0');
  assert(L([5, 12, 18, 9, 10, 11], 8) === 5, '五等奖 3+1');
  assert(L([1, 2, 3, 9, 10, 11], 8) === 6, '六等奖 0+1');
  assert(L([1, 2, 3, 9, 10, 11], 7) === 0, '未中奖 0+0');
  assert(L([5, 12, 1, 2, 3, 4], 7) === 0, '未中奖 2+0');
  // 输入乱序不影响判定
  assert(L([31, 5, 26, 12, 22, 18], 8) === 1, '乱序红球一等奖');
  // 开奖数据为字符串（'05'）时兼容
  assert(core.prizeLevel([5, 12, 18, 22, 26, 31], '08', ['05', '12', '18', '22', '26', '31'], '8') === 1, '字符串输入一等奖');
  // 防御性去重：重复红号只计一次命中（[5,5,5,5,5,5] 实际只中 1 个红球）
  assert(core.prizeLevel([5, 5, 5, 5, 5, 5], 7, drawRed, drawBlue) === 0, '重复红球防御性去重');
  // 非法输入抛错
  try { core.prizeLevel([1, 2, 3, 4, 5], 8, drawRed, drawBlue); assert(false, '红球 5 个应抛错'); } catch (e) { /* 预期 */ }
  try { core.prizeLevel([1, 2, 3, 4, 5, 6], null, drawRed, drawBlue); assert(false, '蓝球 null 应抛错'); } catch (e) { /* 预期 */ }
  try { core.prizeLevel([1, 2, 3, 4, 5, 6], 8, [1, 2, 3], 8); assert(false, '开奖红球 3 个应抛错'); } catch (e) { /* 预期 */ }
  // PRIZE_NAMES 映射
  assert(core.PRIZE_NAMES[1] === '一等奖' && core.PRIZE_NAMES[6] === '六等奖' && core.PRIZE_NAMES[0] === '', 'PRIZE_NAMES 映射');
}

// ---- checkTicket ----
{
  const draw = { issue: '26118', date: '2026-10-15', red: [5, 21, 22, 23, 28, 31], blue: 14 };
  const r1 = core.checkTicket({ reds: [5, 21, 22, 23, 28, 31], blue: 14 }, draw);
  assert(r1.level === 1 && r1.name === '一等奖' && r1.hitRed.length === 6 && r1.hitBlue === true, 'checkTicket 一等奖');
  const r2 = core.checkTicket({ reds: [1, 2, 3, 4, 6, 7], blue: 14 }, draw);
  assert(r2.level === 6 && r2.name === '六等奖' && r2.hitRed.length === 0 && r2.hitBlue === true, 'checkTicket 六等奖');
  const r3 = core.checkTicket({ reds: [5, 21, 1, 2, 3, 4], blue: 7 }, draw);
  assert(r3.level === 0 && r3.name === '' && r3.hitRed.length === 2 && r3.hitBlue === false, 'checkTicket 未中奖');
  // 字符串开奖数据（与数据文件格式一致）
  const r4 = core.checkTicket({ reds: [5, 21, 22, 23, 28, 31], blue: 14 }, { red: ['05', '21', '22', '23', '28', '31'], blue: '14' });
  assert(r4.level === 1 && r4.hitBlue === true, 'checkTicket 字符串开奖数据');
  try { core.checkTicket({ reds: [1, 2, 3], blue: 8 }, draw); assert(false, '号码 3 红应抛错'); } catch (e) { /* 预期 */ }
}

// ---- normalizeDraw ----
assert(JSON.stringify(core.normalizeDraw({ issue: '26118', date: '2026-10-15', red: ['05', '21', '22', '23', '28', '31'], blue: ['14'] }))
  === JSON.stringify({ issue: '26118', date: '2026-10-15', red: [5, 21, 22, 23, 28, 31], blue: 14 }), 'normalizeDraw 规范化');
assert(core.normalizeDraw({ issue: '2611', date: '2026-10-15', red: ['05'], blue: ['14'] }) === null, 'normalizeDraw 期号位数错');
assert(core.normalizeDraw({ issue: '26118', date: '2026-13-15', red: ['05', '21', '22', '23', '28', '31'], blue: ['14'] }) === null, 'normalizeDraw 非法日期');
assert(core.normalizeDraw({ issue: '26118', date: '2026-10-15', red: ['05', '21', '22', '23', '28', '34'], blue: ['14'] }) === null, 'normalizeDraw 红球越界');
assert(core.normalizeDraw({ issue: '26118', date: '2026-10-15', red: ['05', '05', '22', '23', '28', '31'], blue: ['14'] }) === null, 'normalizeDraw 红球重复');
assert(core.normalizeDraw({ issue: '26118', date: '2026-10-15', red: ['05', '21', '22', '23', '28', '31'], blue: ['17'] }) === null, 'normalizeDraw 蓝球越界');
assert(core.normalizeDraw({ issue: '26118', date: '2026-10-15', red: ['05', '21', '22', '23', '28'], blue: ['14'] }) === null, 'normalizeDraw 红球缺 1 个');
assert(core.normalizeDraw(null) === null && core.normalizeDraw('x') === null, 'normalizeDraw 非对象');

// ---- normalizeDraw：数组精简格式（部署瘦身用 ["期号","日期","红球串","蓝球串"]） ----
assert(JSON.stringify(core.normalizeDraw(['26118', '2026-10-15', '31,05,21,22,23,28', '14']))
  === JSON.stringify({ issue: '26118', date: '2026-10-15', red: [5, 21, 22, 23, 28, 31], blue: 14 }), 'normalizeDraw 数组格式 + 乱序自动排序');
assert(JSON.stringify(core.normalizeDraw(['26118', '2026-10-15', '5 21 22 23 28 31', '14']))
  === JSON.stringify({ issue: '26118', date: '2026-10-15', red: [5, 21, 22, 23, 28, 31], blue: 14 }), 'normalizeDraw 数组格式 空格分隔');
assert(core.normalizeDraw(['26118', '2026-10-15', '05,21,22,23,28']) === null, 'normalizeDraw 数组缺元素');
assert(core.normalizeDraw(['26118', '2026-10-15', '05,21,22,23,28,34', '14']) === null, 'normalizeDraw 数组格式 红球越界');
assert(core.normalizeDraw(['26118', '2026-10-15', '05,21,22,23,28,31', '17']) === null, 'normalizeDraw 数组格式 蓝球越界');
assert(core.normalizeDraw([]) === null, 'normalizeDraw 空数组');
assert(core.normalizeDraw(['26118', '2026-10-15', null, null]) === null, 'normalizeDraw 数组含 null');

// ---- loadDraws ----
{
  const hist = [
    { issue: '26118', date: '2026-10-15', red: ['05', '21', '22', '23', '28', '31'], blue: ['14'] },
    { issue: 'BAD', date: '2026-10-13', red: ['01'], blue: ['02'] },
    { issue: '26117', date: '2026-10-13', red: ['04', '11', '14', '22', '26', '27'], blue: ['04'] },
  ];
  const ds = core.loadDraws(hist, 10);
  assert(ds.length === 2, 'loadDraws 跳过坏记录');
  assert(ds[0].issue === '26118' && ds[1].issue === '26117', 'loadDraws 保序');
  assert(core.loadDraws(hist, 1).length === 1, 'loadDraws 遵守 limit');
  assert(core.loadDraws(null).length === 0, 'loadDraws 非数组');
}

// ---- 与真实数据文件集成（data/ssq.js 存在时） ----
{
  const dataPath = path.join(__dirname, '..', 'data', 'ssq.js');
  if (fs.existsSync(dataPath)) {
    const sandbox = {};
    new Function('window', fs.readFileSync(dataPath, 'utf8'))(sandbox);
    const hist = sandbox.window ? sandbox.window.SSQ_HISTORY : sandbox.SSQ_HISTORY;
    assert(Array.isArray(hist) && hist.length > 3000, `真实数据文件加载（${hist ? hist.length : 0} 期）`);
    const draws = core.loadDraws(hist, 60);
    assert(draws.length === 60, '真实数据前 60 期全部合法');
    const latest = draws[0];
    // 用最新一期开奖号码本身当注，必中一等奖
    const win = core.checkTicket({ reds: latest.red.slice(), blue: latest.blue }, latest);
    assert(win.level === 1 && win.hitRed.length === 6 && win.hitBlue, '真实数据：开奖号码本身中一等奖');
    // 一个必定不中的注（红球全错 + 蓝球错）
    const wrongRed = [];
    for (let n = 1; n <= 33 && wrongRed.length < 6; n++) if (latest.red.indexOf(n) === -1) wrongRed.push(n);
    const wrongBlue = latest.blue === 1 ? 2 : 1;
    const lose = core.checkTicket({ reds: wrongRed, blue: wrongBlue }, latest);
    assert(lose.level === 0 && lose.hitRed.length === 0 && !lose.hitBlue, '真实数据：全错注未中奖');
    // 蓝球对、红球全错 → 六等奖
    const onlyBlue = core.checkTicket({ reds: wrongRed, blue: latest.blue }, latest);
    assert(onlyBlue.level === 6 && onlyBlue.name === '六等奖', '真实数据：仅中蓝球为六等奖');
    // 期号唯一且降序
    const issues = draws.map(d => d.issue);
    assert(new Set(issues).size === issues.length, '真实数据期号唯一');
    for (let i = 1; i < issues.length; i++) assert(issues[i - 1] > issues[i], `真实数据降序 (${issues[i - 1]} > ${issues[i]})`);
  } else {
    console.log('SKIP: data/ssq.js 不存在，跳过真实数据集成测试');
  }
}

// ---- 部署产物集成（dist/data/ssq.js 存在时） ----
{
  const distPath = path.join(__dirname, '..', 'dist', 'data', 'ssq.js');
  if (fs.existsSync(distPath)) {
    const sandbox = {};
    new Function('window', fs.readFileSync(distPath, 'utf8'))(sandbox);
    const w = sandbox.window || sandbox;
    assert(Array.isArray(w.SSQ_HISTORY), 'dist 数据可加载');
    assert(w.SSQ_HISTORY.length === w.SSQ_KEPT, 'dist 内条数等于 SSQ_KEPT');
    assert(w.SSQ_TOTAL >= w.SSQ_KEPT, 'dist 总期数不小于内置期数');
    const d = core.loadDraws(w.SSQ_HISTORY, 60);
    assert(d.length === 60, 'dist 数据前 60 期全部合法（数组精简格式解析）');
    assert(core.checkTicket({ reds: d[0].red.slice(), blue: d[0].blue }, d[0]).level === 1, 'dist 数据算奖链路可跑通');
    console.log(`dist 数据: ${w.SSQ_HISTORY.length} 期 / 总 ${w.SSQ_TOTAL} 期`);
  } else {
    console.log('SKIP: dist/data/ssq.js 不存在，跳过部署产物测试');
  }
}

// ---- sameTicket（复播一致性比对） ----
assert(core.sameTicket({ reds: [1, 5, 9, 12, 20, 33], blue: 8 }, { reds: [33, 1, 20, 5, 12, 9], blue: 8 }), 'sameTicket 乱序应视为相同');
assert(core.sameTicket({ reds: ['01', '05', 9, 12, 20, 33], blue: '08' }, { reds: [1, 5, 9, 12, 20, 33], blue: 8 }), 'sameTicket 数字/字符串兼容');
assert(!core.sameTicket({ reds: [1, 5, 9, 12, 20, 33], blue: 8 }, { reds: [1, 5, 9, 12, 20, 33], blue: 9 }), 'sameTicket 蓝球不同应判否');
assert(!core.sameTicket({ reds: [1, 5, 9, 12, 20, 32], blue: 8 }, { reds: [1, 5, 9, 12, 20, 33], blue: 8 }), 'sameTicket 红球不同应判否');
assert(!core.sameTicket({ reds: [1, 2, 3], blue: 8 }, { reds: [1, 2, 3, 4, 5, 6], blue: 8 }), 'sameTicket 长度不同应判否');
assert(!core.sameTicket(null, { reds: [1, 2, 3, 4, 5, 6], blue: 8 }), 'sameTicket null 应判否');

if (fail) {
  console.error(`\n共 ${fail} 个断言失败`);
  process.exit(1);
}
console.log('ALL TESTS PASSED');
