## LD Cloudflare Challenge - 技术报告

### 根因
linux.do 的 Cloudflare 配置对 Workers IP 段发起 JS Challenge（`cf-mitigated: challenge`），所有 API 端点（/latest.json, /categories.json, /top.json）均返回 403。CF Workers 运行时无 JS 引擎，无法通过 challenge。

### 已做修复
- ✅ 内联 handler：不再卡死，显示 `❌ CF 拦截 linux.do (403)`
- ✅ 取消多余 PR，直接 CF API 部署
- ❌ cron handler：至今静默失败（`nlRefreshQueue` 返回 null 后直接跳过）

### 架构级方案
在多用户开源项目中，要用 CF Workers 读另一个 CF 保护的站点，只有两种路径：

**路径 1：Sidecar Proxy（推荐）**
- 用户额外部署一个轻量 HTTP 代理（Railway/Render/VPS 免费层）
- 代理用 Playwright/Puppeteer 保留浏览器上下文 → 持 `cf_clearance`
- CF Worker 配置环境变量指向代理地址，LD 请求走代理转发
- 代价：一次部署，永久有效

**路径 2：用户浏览器辅助**
- 用户在本地跑一个 CLI 工具当 relay（iOS 上不合适）

### 当前最优解
短期内让 bot 诚信降级：
1. cron 读 LD 时检测到 403 → 写 `cookieError` 到 state
2. 健康摘要 `getHealthSummary` 显示 `🔴 LinuxDO CF 拦截`
3. 用户可自行提供 `cf_clearance` cookie 绕过（已有用户 cookie 格式支持）

要不要我先做 1+2，让 bot 健康地降级运行？
