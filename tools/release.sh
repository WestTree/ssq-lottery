#!/bin/sh
# 一键发布闭环：更新数据 -> 构建 -> 全量测试 -> 提交 -> 重建发布版 -> 部署 -> 推送
#
# 用法:
#   sh tools/release.sh                     完整发布（无令牌时跳过部署，仍会构建/测试/提交/推送）
#   sh tools/release.sh --dry-run           只构建 + 测试，不提交、不部署、不推送
#   sh tools/release.sh --no-update         跳过联网拉数据，用现有 data/ssq.js 重建发布
#
# 直传部署需两个环境变量（不要写进脚本）:
#   CLOUDFLARE_API_TOKEN   Pages:Edit 权限的 API 令牌
#   CLOUDFLARE_ACCOUNT_ID  Cloudflare 账户 ID
#
# 两条顺序约束：
#   1) 构建在测试之前 —— core.test.js / build.test.js 会校验 dist 产物，
#      先测试后构建等于拿旧产物验新代码。
#   2) 提交后再重建一次 —— 版本戳里的 git hash 才会指向本次发布提交，
#      而不是上一次 HEAD。
set -e
cd "$(dirname "$0")/.."

DRY=0
SKIP_UPDATE=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY=1 ;;
    --no-update) SKIP_UPDATE=1 ;;
    *) echo "未知参数: $arg"; echo "可用: --dry-run | --no-update"; exit 2 ;;
  esac
done

# npm 主缓存目录部分子目录属主异常（历史 root 进程留下），改用当前用户可写的缓存
NPM_CACHE="${npm_config_cache:-/tmp/dsh-npm-cache}"

echo "[1/7] 更新开奖数据"
if [ "$DRY" -eq 1 ]; then
  echo " 跳过：dry-run 不产生副作用"
elif [ "$SKIP_UPDATE" -eq 1 ]; then
  echo " 跳过：--no-update"
else
  node tools/update_ssq_data.mjs
fi

echo "[2/7] 构建部署目录（数据瘦身 + 注入版本戳）"
node tools/build_dist.mjs

echo "[3/7] 全量自测（含 dist 产物集成校验）"
node tests/core.test.js
node tests/phys.test.js
node tests/history.test.js
node tests/build.test.js

ISSUE=$(node -e "
  const fs = require('fs');
  const s = fs.readFileSync('data/ssq.js', 'utf8');
  const i = s.indexOf('window.SSQ_HISTORY');
  const a = JSON.parse(s.slice(s.indexOf('=', i) + 1).trim().replace(/;\$/, ''));
  process.stdout.write(String(a[0].issue));
")
echo "      当前数据最新期号: $ISSUE"

echo "[4/7] 提交变更"
if [ "$DRY" -eq 1 ]; then
  echo " 跳过：dry-run。待提交文件："
  git status --short
else
  git add -A
  if git diff --cached --quiet; then
    echo " 无变更，跳过提交"
  else
    CHANGED=$(git diff --cached --name-only)
    OTHER=$(printf '%s\n' "$CHANGED" | grep -vc '^data/ssq.js$' || true)
    HAS_DATA=$(printf '%s\n' "$CHANGED" | grep -c '^data/ssq.js$' || true)
    TODAY=$(date +%F)
    if [ "$HAS_DATA" -gt 0 ] && [ "$OTHER" -eq 0 ]; then
      MSG="data: 更新开奖数据至第 ${ISSUE} 期（${TODAY}）"
    elif [ "$HAS_DATA" -gt 0 ]; then
      MSG="release: 代码与开奖数据更新（第 ${ISSUE} 期，${TODAY}）"
    else
      MSG="release: 代码更新与重新构建（${TODAY}）"
    fi
    git commit -m "$MSG"
    echo " 提交信息: $MSG"
  fi
fi

echo "[5/7] 重建发布版 dist（版本戳对齐本次提交）"
if [ "$DRY" -eq 1 ]; then
  echo " 跳过：dry-run"
else
  node tools/build_dist.mjs
fi

echo "[6/7] 部署到 Cloudflare Pages"
if [ "$DRY" -eq 1 ]; then
  echo " 跳过：dry-run"
elif [ -n "$CLOUDFLARE_API_TOKEN" ] && [ -n "$CLOUDFLARE_ACCOUNT_ID" ]; then
  CI=true npm_config_cache="$NPM_CACHE" npx -y wrangler@latest pages deploy dist \
    --project-name ssq-machine --branch main --commit-dirty=true
else
  echo " 跳过：未设置 CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID"
  echo "        dist/ 已就绪，可到控制台 Upload assets 手动上传，或补齐令牌重跑本脚本"
fi

echo "[7/7] 推送到 GitHub"
if [ "$DRY" -eq 1 ]; then
  echo " 跳过：dry-run"
else
  git push
fi

echo "完成：https://ssq-machine.pages.dev"
