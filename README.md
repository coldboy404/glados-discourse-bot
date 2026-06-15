# GLaDOS 签到 + Discourse 多站摸鱼 Bot ☁️

Telegram bot，自动签 GLaDOS，同时在 NodeLoc / NodeSeek / LinuxDO 假装人类刷阅读量升信任等级。

## 能干吗

- **GLaDOS 签到** — 多账号，每天自动，积分换天数
- **三站自动阅读** — 定时在 NodeLoc、NodeSeek、LinuxDO 上读帖，风控友好
- **健康监控** — 菜单显示各站状态，Cookie 失效自动标红，连续失败主动推送告警
- **Telegram 管理** — 绑定账号、看数据、手动阅读，都在对话框完成

## 部署

点这个按钮，授权 GitHub + Cloudflare，填 `BOT_TOKEN` 跟 `ADMIN_ID`：

[![Deploy to Cloudflare Workers](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/Linsars/glados-discourse-bot)

部署完访问 worker 域名（`https://xxx.workers.dev/`）自动激活 webhook，返回 `{"webhook":"✅ 已激活","commands":"✅ 已注册"}` 即可。

### 自动部署更新

[![Auto Deploy](https://github.com/Linsars/glados-discourse-bot/actions/workflows/deploy.yml/badge.svg)](https://github.com/Linsars/glados-discourse-bot/actions/workflows/deploy.yml)

设好以下 Secret 后，每次推 `worker.js` 到 `main` 自动更新 CF 上的代码，不需要再手动重新部署：

> 仓库 Settings → Secrets and variables → Actions

| Secret | 哪里拿 |
|--------|--------|
| `CF_API_TOKEN` | Cloudflare Dashboard → 我的 API 令牌 → 创建令牌（Workers 编辑权限） |
| `CF_ACCOUNT_ID` | Cloudflare Dashboard → 右侧边栏 → 账户 ID |
| `KV_NS_ID` | 一键部署后，在 Worker 的设置 → KV 里能看到 `GLADOS_DB` 的 Namespace ID |

没设的人 fork 了也能正常用一键按钮部署，这条自动跳过，不影响。

## 绑定账号

在 Telegram 里跟 bot 聊：

- **Discourse 论坛**：点「添加账号」→ 选站点 → 发 cookie（`_forum_session=xxx; _t=yyy`）
- **GLaDOS**：点「绑定账号」→ 发 cookie（`connect.sid=xxx`）

Bot 自动取邮箱和用户名，不用你费劲取名。

## 抓 Cookie（Surge / Loon / QX / Egern）

```
https://raw.githubusercontent.com/Linsars/Surge/main/sg/glados.yaml
```

Surge 模块，Egern 也兼容。装上后进各站点的「设置→账户」页面，模块自动捞 cookie。

### 手动也行

浏览器 F12 → Application → Cookies，找 `_forum_session` 和 `_t`，发给 bot。

## LinuxDO 特别说明

LinuxDO 的 Cloudflare 防护较严格，CF Workers 的请求可能被 `JS challenge` 拦截。三种解决方式（任选一）：

**方式一：手动更新 Cookie（简单）**  
浏览器打开 linux.do 过 CF → F12 → Application → Cookies → 复制完整 cookie（含 `cf_clearance`）→ 在 bot 中「🔁 更新 Cookies」。有效期取决于 CF TTL，一般几小时到一天。

**方式二：Sidecar Proxy（一劳永逸）**  
部署一个带 Playwright 的轻量转发服务，自动处理 CF 挑战，cookie 自动续期。支持以下平台：

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy)
[![Deploy on Railway](https://railway.app/button.svg)](https://railway.app/template)

部署步骤：
1. Fork 本仓库，确保 `sidecar/` 目录完整
2. 在 Render/Railway 选择「从仓库部署」，Dockerfile 路径指向 `sidecar/`
3. 部署完成后获得 Proxy URL（例如 `https://ld-proxy.onrender.com`）
4. 在 bot 的 LinuxDO 账户管理中绑定此 URL

**方式三：均不配置**  
Bot 正常跑 NL/NS/GLADOS 功能，LD 显示 `❌ CF 拦截`，不影响其他功能。

## Sidecar Proxy 技术说明

位于 `sidecar/` 目录，包含：
```
sidecar/
├── Dockerfile    # 基于 node:20-slim + Chromium，~300MB
├── package.json  # 依赖 express + playwright  
└── proxy.js      # Playwright 浏览器自动过 CF 挑战
```

工作原理：收到请求后先尝试用本地 `cf_clearance` 直接 `fetch`，若返回 403 则启动无头 Chromium 访问 linux.do，自动执行 JS 挑战，获取新 cookie 后重试请求。cookie 持久化到 `/data/cookies.json`，重启不丢失。

当 `LD_PROXY_URL` 环境变量配置后，Worker 将 LD 的相关请求自动转发至 Proxy，Cookie 通过 `_cookie` 查询参数透传。

### NodeLoc

| 等级 | 门槛 | Bot 能跑 |
|------|------|---------|
| TL1 白银 | 600 分钟，100 帖 | ✅ |
| TL2 黄金 | 3000 分钟，30 天，赞/回复 | ✅ 阅读部分 |
| TL3 钻石 | 100 天，赞/回复 | ✅ 阅读部分 |
| TL4 王者 | 申请投票制 | ❌ |

### NodeSeek

| 等级 | 门槛 | Bot 能跑 |
|------|------|---------|
| TL1 基础 | 30 帖，10 分钟 | ✅ |
| TL2 成员 | 100 帖，60 分钟，15 天 | ✅ |
| TL3 常规 | 200 话题+500 帖，100 天 | ✅ |
| TL4 领袖 | 手动 | ❌ |

### LinuxDO

| 等级 | 门槛 | Bot 能跑 |
|------|------|---------|
| TL1 基础 | 10 分钟，15 帖 | ✅ |
| TL2 成员 | 300 分钟，80 帖，30 天 | ✅ |
| TL3 常规 | 2000 分钟，500 帖，100 天 | ✅ |
| TL4 领袖 | 手动隐藏关 | ❌ |

## 环境变量

| 变量 | 干啥的 | 哪来的 |
|------|-------|-------|
| `BOT_TOKEN` | Telegram Bot Token | [@BotFather](https://t.me/BotFather) |
| `ADMIN_ID` | 你（管理员）的用户 ID | [@userinfobot](https://t.me/userinfobot) |
| `GLADOS_DB` | KV Namespace ID | 一键部署时自动生成 |
| `LD_PROXY_URL` | Sidecar Proxy 地址（可选） | 部署自托管 Proxy 后获得，配置后 LD 请求走浏览器转发绕过 CF |

## License

MIT

爱改就改，反正我写完了。
