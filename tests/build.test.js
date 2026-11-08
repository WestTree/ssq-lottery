#!/usr/bin/env node
/**
 * 构建产物一致性测试
 *
 * 背景：曾出现「data/ssq.js 更新到新一期、dist/ 没重建、线上仍是旧数据」的断链，
 * 以及「靠数页面字节数判断线上新旧」。本测试把版本戳与数据一致性固化下来。
 *
 * 覆盖：
 *   1. dist/index.html 已注入 SSQ_BUILD，字段齐全且与主数据一致
 *   2. 去掉注入脚本后 dist/index.html 与源 index.html 逐字节一致（防止手改 dist）
 *   3. dist/data/ssq.js 的 SSQ_TOTAL / SSQ_KEPT / 首条期号与主数据一致
 *   4. 源 index.html 仍保留 <!--SSQ_BUILD--> 占位（保证下次可注入）
 *   5. _headers 含 HTML must-revalidate 与数据短缓存
 *
 * 运行：node tests/build.test.js（需先 node tools/build_dist.mjs）
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SRC_HTML = path.join(ROOT, 'index.html');
const SRC_DATA = path.join(ROOT, 'data', 'ssq.js');
const DIST_HTML = path.join(ROOT, 'dist', 'index.html');
const DIST_DATA = path.join(ROOT, 'dist', 'data', 'ssq.js');
const DIST_HEADERS = path.join(ROOT, 'dist', '_headers');

let pass = 0, fail = 0;
function assert(cond, msg, detail) {
  if (cond) { pass++; console.log('  ✓ ' + msg); }
  else { fail++; console.log('  ✗ ' + msg + (detail !== undefined ? '  → ' + detail : '')); }
}

function main() {
  for (const p of [DIST_HTML, DIST_DATA, DIST_HEADERS]) {
    if (!fs.existsSync(p)) {
      console.error('BUILD TESTS FAILED: 缺少产物 ' + p + '，请先运行 node tools/build_dist.mjs');
      process.exit(1);
    }
  }

  const srcHtml = fs.readFileSync(SRC_HTML, 'utf8');
  const distHtml = fs.readFileSync(DIST_HTML, 'utf8');
  const srcData = fs.readFileSync(SRC_DATA, 'utf8');
  const distData = fs.readFileSync(DIST_DATA, 'utf8');
  const headers = fs.readFileSync(DIST_HEADERS, 'utf8');

  const dataStart = srcData.indexOf('=', srcData.indexOf('window.SSQ_HISTORY')) + 1;
  let body = srcData.slice(dataStart).trim();
  if (body.endsWith(';')) body = body.slice(0, -1).trim();
  const all = JSON.parse(body);

  console.log('【1】版本戳字段与主数据一致');
  const m = distHtml.match(/<script>window\.SSQ_BUILD = (\{[^}]*\});<\/script>/);
  assert(!!m, 'dist/index.html 已注入 window.SSQ_BUILD');
  let build = null;
  try { build = m ? JSON.parse(m[1]) : null; } catch (e) { /* 下面逐项报错 */ }
  assert(build !== null, '版本戳是可解析的 JSON');
  if (build) {
    assert(/^\d{4}-\d{2}-\d{2}$/.test(build.built || ''), 'built 为 YYYY-MM-DD', build.built);
    assert(typeof build.commit === 'string' && build.commit.length > 0, 'commit 非空', build.commit);
    assert(String(build.issue) === String(all[0].issue), 'issue 与主数据最新期号一致', build.issue);
    assert(build.date === all[0].date, 'date 与主数据最新日期一致', build.date);
    assert(build.total === all.length, 'total 与主数据条数一致', build.total);
    assert(build.kept === 300, 'kept 为 300 期', build.kept);
  }
  assert(!distHtml.includes('<!--SSQ_BUILD-->'), '占位已在产物中被替换');

  console.log('【2】产物 HTML 除版本戳外与源文件完全一致');
  const restored = m ? distHtml.replace(m[0], '<!--SSQ_BUILD-->') : distHtml;
  assert(restored === srcHtml, '无手改 dist 的残留差异',
    restored === srcHtml ? '' : (restored.length + ' vs ' + srcHtml.length + ' 字节'));
  assert(srcHtml.includes('<!--SSQ_BUILD-->'), '源文件仍保留占位，可重复构建');

  console.log('【3】部署数据与主数据一致');
  const total = Number((distData.match(/SSQ_TOTAL\s*=\s*(\d+)/) || [])[1]);
  const kept = Number((distData.match(/SSQ_KEPT\s*=\s*(\d+)/) || [])[1]);
  assert(total === all.length, 'SSQ_TOTAL 与主数据条数一致', total);
  assert(kept === 300, 'SSQ_KEPT 为 300', kept);
  const arrAt = distData.indexOf('[', distData.indexOf('window.SSQ_HISTORY'));
  const slim = JSON.parse(distData.slice(arrAt, distData.lastIndexOf(']') + 1));
  assert(slim.length === kept, '精简数组条数正确', slim.length);
  assert(String(slim[0][0]) === String(all[0].issue), '首条期号与主数据一致', slim[0][0]);
  assert(slim[0][1] === all[0].date, '首条日期与主数据一致', slim[0][1]);
  const reds = slim[0][2].split(',').map(Number);
  assert(reds.length === 6 && reds.every(n => n >= 1 && n <= 33), '首条红球合法', slim[0][2]);

  console.log('【4】响应头策略');
  assert(headers.includes('must-revalidate'), 'HTML 发版即生效（must-revalidate）');
  assert(/\/data\/ssq\.js[\s\S]*max-age=300/.test(headers), '数据文件短缓存 300s');
  assert(headers.includes('X-Content-Type-Options: nosniff'), '保留 nosniff 安全头');

  console.log('\n' + (fail === 0 ? 'BUILD TESTS ALL PASSED' : 'BUILD TESTS FAILED: ' + fail));
  process.exit(fail === 0 ? 0 : 1);
}

main();
