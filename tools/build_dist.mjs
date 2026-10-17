#!/usr/bin/env node
/**
 * 生成 Cloudflare Pages 部署目录 dist/
 * 用法: node tools/build_dist.mjs
 *
 * 产出（仅发布必需文件，不含 tests/tools）:
 *   dist/index.html
 *   dist/data/ssq.js
 *   dist/_headers       （Cloudflare Pages 响应头配置）
 *
 * 说明: 幂等，可反复运行；build 失败直接抛错并以非 0 退出，避免把坏产物传上线。
 */
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const DIST = join(ROOT, 'dist');

function fail(msg) {
  console.error('BUILD FAIL:', msg);
  process.exit(1);
}

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
writeFileSync(join(DIST, 'index.html'), html);

// 3) 开奖数据
const dataPath = join(ROOT, 'data', 'ssq.js');
if (!existsSync(dataPath)) fail('缺少 data/ssq.js，请先运行 node tools/update_ssq_data.mjs');
const data = readFileSync(dataPath, 'utf8');
if (!data.includes('window.SSQ_HISTORY')) fail('data/ssq.js 缺少 window.SSQ_HISTORY');
const count = (data.match(/"issue":/g) || []).length;
if (count < 3000) fail(`data/ssq.js 数据量异常（${count} 期），疑似未完整更新`);
writeFileSync(join(DIST, 'data', 'ssq.js'), data);

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
const kb = n => (n / 1024).toFixed(1) + 'KB';
console.log('构建完成 dist/');
console.log('  index.html      ' + kb(Buffer.byteLength(html)) + '  Cache-Control: must-revalidate');
console.log('  data/ssq.js     ' + kb(Buffer.byteLength(data)) + '  ' + count + ' 期  max-age=300');
console.log('  _headers        安全头 + 缓存策略');
console.log('上传目录: ' + DIST);
