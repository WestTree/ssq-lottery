#!/usr/bin/env node
/**
 * 双色球历史开奖数据更新脚本
 * 用法:
 *   node ssq/tools/update_ssq_data.mjs          # 检查并更新（有变化才写文件）
 *   node ssq/tools/update_ssq_data.mjs --check  # 仅检查，不写文件
 *
 * 数据源: https://raw.githubusercontent.com/yangxb919/lottery-data/main/data/ssq.json
 *         （该仓库由 GitHub Actions 在开奖日 21:15 后自动从 500.com 同步，
 *           开奖日: 周二 / 周四 / 周日，故本脚本适合在 22:00 之后运行）
 * 产出:   ssq/data/ssq.js  （页面通过 <script src> 加载，window.SSQ_HISTORY）
 * 许可:   数据为公开开奖事实信息；脚本 MIT
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const SRC_URL = 'https://raw.githubusercontent.com/yangxb919/lottery-data/main/data/ssq.json';
const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_PATH = join(HERE, '..', 'data', 'ssq.js');
const CHECK_ONLY = process.argv.includes('--check');
const MIN_RECORDS = 3000; // 数据量 sanity 下限（2026-10 实际约 3515 期）
const TODAY_CST = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10); // 北京时间日期

function fail(msg) {
  console.error('FAIL:', msg);
  process.exit(1);
}

/** 校验单条记录；返回错误信息或 null */
function validateRecord(d, i) {
  const at = `第 ${i + 1} 条`;
  if (!d || typeof d !== 'object') return `${at}: 不是对象`;
  const issue = String(d.issue ?? '');
  if (!/^\d{5}$/.test(issue)) return `${at}: 期号格式错误 (${issue})`;
  const date = String(d.date ?? '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return `${at}: 日期格式错误 (${date})`;
  const [y, m, dd] = date.split('-').map(Number);
  const dt = new Date(y, m - 1, dd);
  if (dt.getFullYear() !== y || dt.getMonth() !== m - 1 || dt.getDate() !== dd) {
    return `${at}: 非法日期 (${date})`;
  }
  if (!Array.isArray(d.red) || d.red.length !== 6) return `${at}: 红球不是 6 个`;
  const seen = new Set();
  for (const r of d.red) {
    const n = Number(r);
    if (!Number.isInteger(n) || n < 1 || n > 33) return `${at}: 红球越界 (${r})`;
    if (seen.has(n)) return `${at}: 红球重复 (${r})`;
    seen.add(n);
  }
  if (!Array.isArray(d.blue) || d.blue.length !== 1) return `${at}: 蓝球不是 1 个`;
  const b = Number(d.blue[0]);
  if (!Number.isInteger(b) || b < 1 || b > 16) return `${at}: 蓝球越界 (${b})`;
  return null;
}

/** 读取现有数据文件，返回记录数组或 null */
function readExisting() {
  if (!existsSync(OUT_PATH)) return null;
  try {
    const src = readFileSync(OUT_PATH, 'utf8');
    const m = src.match(/window\.SSQ_HISTORY\s*=\s*([\s\S]*?);\s*$/);
    if (!m) return null;
    return JSON.parse(m[1]);
  } catch (e) {
    return null;
  }
}

function render(arr) {
  const header = [
    '// 双色球历史开奖数据（自动生成，请勿手改；更新: node tools/update_ssq_data.mjs）',
    `// 数据来源: 500.com（datachart.500.com）· 经 github.com/yangxb919/lottery-data 同步`,
    `// 生成时间: ${TODAY_CST}（北京时间）· 共 ${arr.length} 期`,
    'window.SSQ_HISTORY = ' + JSON.stringify(arr) + ';',
    ''
  ].join('\n');
  return header;
}

/** 拉取 URL 文本：优先全局 fetch，失败时降级 curl（curl 自动遵循 http_proxy 环境变量） */
async function fetchText(url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(30000), redirect: 'follow' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } catch (fetchErr) {
    try {
      return execFileSync('curl', ['-sSL', '--max-time', '30', url], {
        encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe']
      });
    } catch (curlErr) {
      throw new Error(`fetch 失败(${fetchErr.cause ? fetchErr.cause.code || fetchErr.cause.message : fetchErr.message})，curl 降级也失败(${curlErr.message})`);
    }
  }
}

async function main() {
  // 1) 拉取
  let text;
  try {
    text = await fetchText(SRC_URL);
  } catch (e) {
    fail(`网络请求失败: ${e.message}（可稍后重试，或检查代理）`);
  }
  let arr;
  try {
    arr = JSON.parse(text);
  } catch (e) {
    fail('数据源不是合法 JSON');
  }
  if (!Array.isArray(arr)) fail('数据源顶层不是数组');
  if (arr.length < MIN_RECORDS) fail(`数据量异常: ${arr.length} 期（少于 ${MIN_RECORDS}，疑似源数据不完整）`);

  // 2) 全量校验（任何一条不合法都不写入，保证页面数据干净）
  for (let i = 0; i < arr.length; i++) {
    const err = validateRecord(arr[i], i);
    if (err) fail(`数据校验未通过: ${err}`);
  }
  const issues = new Set(arr.map(d => String(d.issue)));
  if (issues.size !== arr.length) fail('存在重复期号');
  for (let i = 1; i < arr.length; i++) {
    if (String(arr[i - 1].issue) < String(arr[i].issue)) {
      console.warn('WARN: 数据未按期号降序排列（不影响使用）');
      break;
    }
  }

  // 3) 与现有数据对比
  const old = readExisting();
  const oldLatest = old && old.length ? String(old[0].issue) : null;
  const newLatest = String(arr[0].issue);
  if (old && old.length === arr.length && oldLatest === newLatest) {
    console.log(`已是最新: ${arr.length} 期，最新第 ${newLatest} 期（${arr[0].date}）`);
    return;
  }

  if (CHECK_ONLY) {
    console.log(`有新数据: ${old ? old.length + ' -> ' : ''}${arr.length} 期，最新第 ${newLatest} 期（${arr[0].date}）`);
    return;
  }

  // 4) 写入
  writeFileSync(OUT_PATH, render(arr), 'utf8');
  console.log(`已更新: ${old ? old.length + ' -> ' : ''}${arr.length} 期，最新第 ${newLatest} 期（${arr[0].date}），写入 ${OUT_PATH}`);
}

main().catch(e => fail('未预期错误: ' + (e && e.stack || e)));
