# 部署到 Cloudflare Pages

本项目是纯静态站点，无后端、无构建依赖。发布产物仅 3 个文件：

```
dist/
├── index.html      页面本体（CSS/JS 全内联）
├── data/ssq.js     3515 期开奖数据（window.SSQ_HISTORY）
└── _headers        缓存策略 + 基础安全头
```

## 0. 生成发布目录

```bash
node tools/build_dist.mjs
```

构建时会自动校验（任一不满足直接失败，避免把坏产物传上线）：

- `index.html` 引用了 `data/ssq.js`
- 核心标记块 / 物理标记块完整
- 数据文件包含 `window.SSQ_HISTORY` 且期数 ≥ 3000

## 方案 A：控制台直接上传（最快，适合先上线验证）

1. 登录 <https://dash.cloudflare.com> → 左侧 **Workers & Pages** → **Create** → **Pages** → **Upload assets**
2. 项目名填 `ssq-lottery`（可自定义），把**整个 `dist` 文件夹**拖进去
3. **Deploy site** → 得到 `https://<项目名>.pages.dev`
4. 手机打开验证：物理摇奖、中奖核对、复播、台账导出

> 更新数据后：重新 `node tools/build_dist.mjs` → 同项目 **Create new deployment** → 再拖一次 `dist`。

## 方案 B：Git 集成（推荐长期使用）

1. GitHub 新建仓库（**Private 也可以**，Pages 通过 GitHub App 授权读取）
2. 本地已初始化仓库（`ssq/` 为仓库根目录），补上远端并推送：

```bash
git remote add origin git@github.com:<你的账号>/<仓库名>.git
git push -u origin main
```

3. Cloudflare 控制台：**Workers & Pages → Create → Pages → Connect to Git** → 选仓库
4. 构建设置：

| 项 | 值 |
|---|---|
| Framework preset | None |
| Build command | `node tools/build_dist.mjs` |
| Build output directory | `dist` |

5. **Save and Deploy**

之后每次更新数据：

```bash
node tools/update_ssq_data.mjs
git add -A && git commit -m "data: 更新开奖数据" && git push
```

→ Pages 自动构建发布（每次 push 消耗 1 次构建，免费额度 500 次/月）。

## 方案 C：wrangler CLI（可脚本化，便于并入自动化）

```bash
npx wrangler pages deploy dist --project-name ssq-lottery
```

首次使用需登录：`npx wrangler login`，或在环境变量中提供 `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID`（适合无人值守场景）。

## 数据更新与发布的关系（重要）

- 开奖日自动化**只更新本地** `data/ssq.js`，不会自动上线
- 发布动作三选一：方案 A 手动重传 / 方案 B `git push` / 方案 C 再跑 `wrangler deploy`
- 若想全自动：在本机配置 `CLOUDFLARE_API_TOKEN`，把「构建 + 发布」两步加进自动化提示词

## 自定义域名

Pages 项目 → **Custom domains** → 添加域名（域名已托管在 Cloudflare 时自动配 DNS；否则按提示加 CNAME）。

> 免费版全部走海外节点，中国大陆访问速度不稳定、可能间歇不可达（受地区与运营商影响，需实测）。若主要面向大陆用户，可考虑腾讯云 COS+CDN、EdgeOne Pages 等国内方案。

## 常见问题

| 现象 | 原因与处理 |
|---|---|
| 页面能开，但「中奖核对」卡片消失 | `data/ssq.js` 未加载。访问 `https://<域名>/data/ssq.js` 确认可打开且类型为 JS |
| 复播提示「与原始记录不一致」 | 物理参数或模拟代码改动过，同种子结果变化。属诚实审计行为，旧记录仍可查看 |
| 发版后仍是旧页面 | 强刷一次（HTML 为 `must-revalidate`）；`data/ssq.js` 缓存 5 分钟 |
| 构建失败 | 看 Pages 构建日志；本地先跑 `node tools/build_dist.mjs` 复现 |

## 免费额度（官方文档 2026-10）

| 项 | 免费版 |
|---|---|
| 静态请求 / 流量 | 不限量、不计费 |
| 文件数 | 20,000 / 站点 |
| 单文件 | 25 MiB |
| 构建次数 | 500 / 月 |
| 自定义域名 | 100 / 项目 |
