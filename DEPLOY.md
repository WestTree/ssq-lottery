# 部署到 Cloudflare Pages

本项目是纯静态站点，无后端、无构建依赖。发布产物仅 3 个文件：

```
dist/
├── index.html      页面本体（CSS/JS 全内联，约 85KB / gzip 约 25KB）
├── data/ssq.js     最近 300 期开奖数据（精简数组格式，15KB / gzip 约 4KB）
└── _headers        缓存策略 + 基础安全头
```

**当前线上地址**：<https://ssq-machine.pages.dev>（项目名 `ssq-machine`，`main` 为生产分支）

> 数据瘦身说明：源数据 `data/ssq.js` 保留完整 3515 期（374KB），但页面下拉核对只用到最近 60 期。
> 构建时只把最近 300 期以 `[期号,日期,"红球串","蓝球"]` 格式写入部署副本，体积降 96%；
> 完整期数由 `window.SSQ_TOTAL` 传入，页面仍显示「完整数据集共 3515 期」，不会虚报。

## 0. 生成发布目录

```bash
node tools/build_dist.mjs
```

构建时会自动校验（任一不满足直接失败，避免把坏产物传上线）：

- `index.html` 引用了 `data/ssq.js`，且含核对卡所需节点（`drawCount` / `drawKept` / `issueSelect`）
- 核心标记块 / 物理标记块完整
- 源数据可解析为 JSON 数组、期数 ≥ 3000
- **逐条校验**全部历史记录：期号 5 位、日期真实存在、红球 6 个不重复且在 1–33、蓝球 1 个且在 1–16
- 产出后自检：精简数据能解析回数组、条数 = 300、首条期号与源最新一期一致

## 方案 A：控制台直接上传（最快，适合先上线验证）

1. 登录 <https://dash.cloudflare.com> → 左侧 **Workers & Pages** → **Create** → **Pages** → **Upload assets**
2. 项目名填 `ssq-machine`（`pages.dev` 项目名**全局唯一**，被占用就换一个），把**整个 `dist` 文件夹**拖进去
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
sh tools/release.sh
```

该脚本串联：更新数据 → 核心自测 → 构建 dist → 提交 → 推送（无变化时自动跳过）。等价于手动执行：

```bash
node tools/update_ssq_data.mjs
git add -A && git commit -m "data: 更新开奖数据" && git push
```

→ Pages 自动构建发布（每次 push 消耗 1 次构建，免费额度 500 次/月）。

## 方案 C：wrangler CLI（可脚本化，便于并入自动化；本项目当前用这条）

```bash
export CLOUDFLARE_API_TOKEN=<你的令牌>
export CLOUDFLARE_ACCOUNT_ID=<你的账户 ID>
npx wrangler pages deploy dist --project-name ssq-machine --branch main --commit-dirty=true
```

首次使用也可交互登录：`npx wrangler login`。令牌方式适合无人值守场景。
`tools/release.sh` 已内置：检测到这两个环境变量就自动直传，否则只推 GitHub。

## 数据更新与发布的关系（重要）

- 开奖日自动化**只更新本地** `data/ssq.js`，不会自动上线
- 发布动作三选一：方案 A 手动重传 / 方案 B `git push` / 方案 C 再跑 `wrangler deploy`
- 若想全自动：在本机配置 `CLOUDFLARE_API_TOKEN`，把「构建 + 发布」两步加进自动化提示词

## 自定义域名

Pages 项目 → **Custom domains** → 添加域名（域名已托管在 Cloudflare 时自动配 DNS；否则按提示加 CNAME）。

免费拿到域名的两条路（都需把 NS 托管到 Cloudflare，才能挂上 Pages）：

| 途径 | 后缀示例 | 特点 |
|---|---|---|
| DigitalPlat FreeDomain | `xxx.dpdns.org` / `xxx.us.kg` | 免费、审核快，需把 NS 指到 Cloudflare |
| EU.org | `xxx.eu.org` | 长期免费，人工审核，等待数天 |

> **为什么值得配自有域名**：`*.pages.dev` 这个域名在国内部分网络下 TLS 握手经常被重置（实测三种结果：3.6s 后超时、15.8s 断连、少数 1.7s 成功），而换成自有域名后 SNI 不再是 `pages.dev`，通常能稳定握手。慢的是「域名」，不是「站点」。
>
> 免费版全部走海外节点，中国大陆访问速度不稳定、可能间歇不可达（受地区与运营商影响，需实测）。若主要面向大陆用户，可考虑腾讯云 COS+CDN、EdgeOne Pages，或用 WorkBuddy「发布为应用」生成国内链路的分享链接。

## 线上实测（2026-10-17，经沙箱代理）

| 资源 | 原始 | gzip 传输 | 耗时 |
|---|---|---|---|
| `index.html` | 85.6KB | 25.1KB | 2.1–4.1s |
| `data/ssq.js`（瘦身后） | 14.7KB | 3.9KB | 1.7–6.9s（含重试） |
| `data/ssq.js`（瘦身前） | 374KB | 46KB | 20s–180s，常失败 |

首屏总计从「接近不可用」降到「3–8 秒可开」。但要注意：以上是**代理链路**数据，波动主要来自代理与 `pages.dev` 的 TLS 重置；浏览器直连可能更快，也可能同样被重置——这也是建议配自有域名的原因。

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
