# GLaDOS 签到 + Discourse 多站摸鱼 Bot ☁️

Telegram bot，自动签到 GLaDOS、NodeLoc 与 NodeSeek；支持多账号 Cookie 管理和健康监控。

## 能干吗

- **GLaDOS 签到** — 多账号每天自动签到；所有 GLaDOS 域名统一为一个账户入口，自动回退可用域名。
- **NodeLoc / NodeSeek 签到** — 与 GLaDOS 使用同一签到时间；支持立即单独签到。
- **Cookie 自动识别** — NodeSeek 从 `koa:sess` 自动读取用户 ID；GLaDOS 自动从 Cookie 查询账户邮箱，并按邮箱更新去重。
- **健康监控** — 菜单显示各站状态；Cookie 失效自动标红，连续失败主动推送告警。
- **Telegram 管理** — 绑定账号、看状态、手动签到，都在对话框完成。

## 部署

点这个按钮，授权 GitHub + Cloudflare，填 `BOT_TOKEN` 跟 `ADMIN_ID`：

[![Deploy to Cloudflare Workers](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/Linsars/glados-discourse-bot)

部署完访问 worker 域名（`https://xxx.workers.dev/`）自动激活 webhook，返回 `{"webhook":"✅ 已激活","commands":"✅ 已注册"}` 即可。

> ⚠️  按钮需要 `wrangler.toml` 的 `kv_namespaces` 里**不要写** `id` 字段（包括 `id = ""`），否则按钮页面报"无法获取存储库内容"。

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

- **GLaDOS**：点「添加账号」→ 选择唯一的 `glados.network` → 直接发送完整 Cookie。Bot 会在多个互通域名中验证 Cookie、自动读取邮箱，并按邮箱更新已有账户。
- **NodeLoc**：点「添加账号」→「NodeLoc 自动签到」→ 从 `https://www.nodeloc.com` 复制完整 Cookie（必须包含 `_forum_session`）。
- **NodeSeek**：点「添加账号」→「NodeSeek 自动签到」→ 从 `https://nodeseek.com` 复制完整 Cookie（包含 `session` 与 `pjwt`）。Bot 自动从 `pjwt`（JWT）解析用户 ID/昵称，例如 `NodeSeek #30820 (weaponj)`。

Cookie 不要删减；若站点启用 Cloudflare 验证，也应一并保留浏览器复制到的 `cf_clearance`。

## 抓 Cookie（Surge / Loon / QX / Egern）

```
https://raw.githubusercontent.com/Linsars/Surge/main/sg/glados.yaml
```

Surge 模块，Egern 也兼容。装上后进各站点的「设置→账户」页面，模块自动捞 cookie。

### 手动也行

浏览器 F12 → Application → Cookies，右键复制全部 Cookie，发给 bot。

## 环境变量

| 变量 | 干啥的 | 哪来的 |
|------|-------|-------|
| `BOT_TOKEN` | Telegram Bot Token | [@BotFather](https://t.me/BotFather) |
| `ADMIN_ID` | 你（管理员）的用户 ID | [@userinfobot](https://t.me/userinfobot) |
| `GLADOS_DB` | KV Namespace ID | 一键部署时自动生成 |

## License

MIT

爱改就改，反正我写完了。
