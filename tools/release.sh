#!/bin/sh
# 一键更新数据并发布：更新 -> 测试 -> 构建 -> 提交 -> 推送（Cloudflare Pages 自动构建）
# 用法: sh tools/release.sh
set -e
cd "$(dirname "$0")/.."

echo "[1/5] 拉取最新开奖数据"
node tools/update_ssq_data.mjs

echo "[2/5] 核心逻辑自测"
node tests/core.test.js

echo "[3/5] 构建发布目录"
node tools/build_dist.mjs

echo "[4/5] 提交变更"
git add -A
if git diff --cached --quiet; then
  echo "无变更，跳过发布"
  exit 0
fi
git commit -m "data: 更新开奖数据 $(date +%F)"

echo "[5/5] 推送到 GitHub"
git push

echo "完成：Cloudflare Pages 将自动构建并发布"
