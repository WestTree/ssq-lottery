#!/usr/bin/env node
/**
 * 生成 Cloudflare Pages 部署目录 dist/
 * 用法: node tools/build_dist.mjs
 *
 * 产出（仅发布必需文件，不含 tests/tools）:
 *   dist/index.html
 *   dist/data/ssq.js    （瘦身版：只带最近 KEEP 期，数组精简格式）
 *   dist/_headers       （Cloudflare Pages 响应头配置）
 *
 * 为什么瘦身：完整数据 3515 期约 383KB，而页面只用到最近 60 期；
 * 线上首屏没必要背全量。源数据 data/ssq.js 保持完整不动，
 * 完整数据集仍可由页面用 window.SSQ_TOTAL 展示真实期数。
 *
 * 说明: 幂等，可反复运行；build 失败直接抛错并以非 0 退出，避免把坏产物传上线。
 */
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const DIST = join(ROOT, 'dist');

// 部署副本保留的期数（页面下拉只用 60 期，留足余量给后续统计功能）
const KEEP = 300;

function fail(msg) {
  console.error('BUILD FAIL:', msg);
  process.exit(1);
}

const kb = n => (n / 1024).toFixed(1) + 'KB';

// 1) 清理重建
rmSync(DIST, { recursive: true, force: true });
mkdirSync(join(DIST, 'data'), { recursive: true });

// 2) 入口 HTML（校验关键引用，防止发布半成品）
const htmlPath = join(ROOT, 'index.html');
if (!existsSync(htmlPath)) fail('缺少 index.html');
const html = readFileSync(htmlPath, 'utf8');
if (!html.includes('src="data/ssq.js"')) fail('index.html 未引用 data/ssq.js');
if (!/\/\*__CORE_START__\*\/[\s\S]*?\/\*__CORE_END__\*\//.test(html)) fail('index.html 缺少核心标记块');
if (!/\/\*__PHYS_START__\*\/[\s\S]*?\/\*__PHYS_END__\*\//.test(html)) fail('index.html 缺少物理标记块');
for (const id of ['drawCount', 'drawKept', 'issueSelect']) {
  if (!html.includes('id="' + id + '"')) fail('index.html 缺少节点 #' + id);
}
writeFileSync(join(DIST, 'index.html'), html);

// 3) 开奖数据：完整校验 → 取最近 KEEP 期 → 转数组精简格式
const dataPath = join(ROOT, 'data', 'ssq.js');
if (!existsSync(dataPath)) fail('缺少 data/ssq.js，请先运行 node tools/update_ssq_data.mjs');
const src = readFileSync(dataPath, 'utf8');

const marker = 'window.SSQ_HISTORY';
const mAt = src.indexOf(marker);
if (mAt < 0) fail('data/ssq.js 缺少 window.SSQ_HISTORY');
const eqAt = src.indexOf('=', mAt);
if (eqAt < 0) fail('data/ssq.js 中 window.SSQ_HISTORY 赋值格式异常');
let body = src.slice(eqAt + 1).trim();
if (body.endsWith(';')) body = body.slice(0, -1).trim();

let all;
try {
  all = JSON.parse(body);
} catch (e) {
  fail('data/ssq.js 无法解析为 JSON：' + e.message);
}
if (!Array.isArray(all)) fail('data/ssq.js 解析结果不是数组');
if (all.length < 3000) fail(`data/ssq.js 数据量异常（${all.length} 期），疑似未完整更新`);

// 全量校验：期号 5 位、日期合法、红球 6 个不重复且在 1-33、蓝球 1 个且在 1-16
function bad(i, why) {
  const t = all[i] || {};
  fail(`第 ${i} 条数据非法（${why}）：${JSON.stringify(t).slice(0, 120)}`);
}
const lastIssue = String((all[0] || {}).issue || '');
for (let i = 0; i < all.length; i++) {
  const d = all[i];
  if (!d || typeof d !== 'object') bad(i, '不是对象');
  const issue = String(d.issue == null ? '' : d.issue);
  const date = String(d.date == null ? '' : d.date);
  if (!/^\d{5}$/.test(issue)) bad(i, '期号格式');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) bad(i, '日期格式');
  const [y, mo, da] = date.split('-').map(Number);
  const dt = new Date(y, mo - 1, da);
  if (dt.getFullYear() !== y || dt.getMonth() !== mo - 1 || dt.getDate() !== da) bad(i, '日期不存在');
  if (!Array.isArray(d.red) || d.red.length !== 6) bad(i, '红球个数');
  const seen = new Set();
  for (const r of d.red) {
    const n = Number(r);
    if (!Number.isInteger(n) || n < 1 || n > 33) bad(i, '红球范围');
    if (seen.has(n)) bad(i, '红球重复');
    seen.add(n);
  }
  if (!Array.isArray(d.blue) || d.blue.length !== 1) bad(i, '蓝球个数');
  const b = Number(d.blue[0]);
  if (!Number.isInteger(b) || b < 1 || b > 16) bad(i, '蓝球范围');
}

// 取最近 KEEP 期，转 ["期号","日期","05,21,22,23,28,31","14"]
const kept = all.slice(0, KEEP).map(d => {
  const red = d.red.map(n => String(n).padStart(2, '0')).sort();
  return [String(d.issue), String(d.date), red.join(','), d.blue.map(n => String(n).padStart(2, '0')).join(',')];
});

const header = [
  '// 双色球历史开奖数据 · 部署精简版（自动生成，请勿手改）',
  '// 源：data/ssq.js（完整 ' + all.length + ' 期）· 本文件仅含最近 ' + kept.length + ' 期，供页面核对使用',
  '// 记录格式: 期号, 日期, 红球串, 蓝球串',
  ''
].join('\n');

const slim = header
  + 'window.SSQ_TOTAL = ' + all.length + ';\n'
  + 'window.SSQ_KEPT = ' + kept.length + ';\n'
  + 'window.SSQ_HISTORY = [\n'
  + kept.map(r => JSON.stringify(r)).join(',\n')
  + '\n];\n';

// 产出后自检：能解析回数组、条数正确、首条期号与源一致
const arrAt = slim.indexOf('[', slim.indexOf('window.SSQ_HISTORY'));
const arrEnd = slim.lastIndexOf(']');
if (arrAt < 0 || arrEnd <= arrAt) fail('精简数据自检失败（找不到数组体）');
const reParsed = JSON.parse(slim.slice(arrAt, arrEnd + 1));
if (!Array.isArray(reParsed) || reParsed.length !== KEEP) fail('精简数据自检失败（条数不符）');
if (String(reParsed[0][0]) !== lastIssue) fail('精简数据自检失败（最新一期期号不符）');
if (reParsed[0][2].split(',').length !== 6) fail('精简数据自检失败（首条红球个数）');

writeFileSync(join(DIST, 'data', 'ssq.js'), slim);

// 4) 响应头：HTML 不缓存（发版即生效），数据短缓存；基础安全头
const headers = [
  '/*',
  '  X-Content-Type-Options: nosniff',
  '  Referrer-Policy: no-referrer',
  '  X-Frame-Options: SAMEORIGIN',
  '',
  '/',
  '  Cache-Control: public, max-age=0, must-revalidate',
  '',
  '/index.html',
  '  Cache-Control: public, max-age=0, must-revalidate',
  '',
  '/data/ssq.js',
  '  Cache-Control: public, max-age=300',
  ''
].join('\n');
writeFileSync(join(DIST, '_headers'), headers);

// 5) 报告
console.log('构建完成 dist/');
console.log('  index.html      ' + kb(Buffer.byteLength(html)) + '  Cache-Control: must-revalidate');
console.log('  data/ssq.js     ' + kb(Buffer.byteLength(slim)) + '  ' + kept.length + ' 期（源共 ' + all.length + ' 期）  max-age=300');
console.log('  _headers        安全头 + 缓存策略');
console.log('源数据体积        ' + kb(Buffer.byteLength(src)) + ' → 部署副本 ' + kb(Buffer.byteLength(slim))
  + '（省 ' + (100 - Buffer.byteLength(slim) / Buffer.byteLength(src) * 100).toFixed(0) + '%）');
console.log('上传目录: ' + DIST);
