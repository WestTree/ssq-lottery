#!/bin/sh
# 一键发布：更新数据 -> 测试 -> 构建 -> 部署（Cloudflare Pages）-> 推送 GitHub
# 用法:
#   sh tools/release.sh                     仅本地构建 + 提交推送（GitHub Pages 生效）
#   CLOUDFLARE_API_TOKEN=xxx \
#   CLOUDFLARE_ACCOUNT_ID=yyy sh tools/release.sh   额外用 wrangler 直传 Pages（推荐）
set -e
cd "$(dirname "$0")/.."

echo "[1/6] 拉取最新开奖数据"
node tools/update_ssq_data.mjs

echo "[2/6] 核心逻辑自测"
node tests/core.test.js

echo "[3/6] 构建发布目录（数据瘦身）"
node tools/build_dist.mjs

echo "[4/6] 部署到 Cloudflare Pages"
if [ -n "$CLOUDFLARE_API_TOKEN" ] && [ -n "$CLOUDFLARE_ACCOUNT_ID" ]; then
  CI=true npx -y wrangler@latest pages deploy dist \
    --project-name ssq-machine --branch main --commit-dirty=true
else
  echo " 跳过：未设置 CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID"
  echo " （如需直传，先 export 这两个变量；否则依赖 GitHub 集成自动构建）"
fi

echo "[5/6] 提交变更"
git add -A
if git diff --cached --quiet; then
  echo " 无变更，跳过提交"
else
  git commit -m "data: 更新开奖数据 $(date +%F)"
fi

echo "[6/6] 推送到 GitHub"
git push

echo "完成：https://ssq-machine.pages.dev"
