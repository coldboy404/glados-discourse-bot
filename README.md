# GLaDOS / NodeLoc / NodeSeek 多站自动签到 Bot ☁️

Telegram bot，自动签到 GLaDOS、NodeLoc 与 NodeSeek；支持多账号 Cookie 管理和健康监控。

## 能干吗

- **GLaDOS 签到** — 多账号每天自动签到；所有 GLaDOS 域名统一为一个账户入口，自动回退可用域名。
- **NodeLoc / NodeSeek 签到** — 与 GLaDOS 使用同一签到时间；支持逐账号手动签到和定时签到，并显示每个账号的详细结果原因。
- **Cookie 自动识别** — NodeSeek 从 `pjwt` 自动读取用户名；GLaDOS 从 `koa:sess` 查询账户邮箱，并按邮箱更新去重。
- **论坛浏览功能** — 已移除 NodeLoc / NodeSeek 的自动浏览帖子逻辑，只保留稳定的自动签到。
- **健康监控** — 菜单显示各站状态；Cookie 失效自动标红，连续失败主动推送告警。
- **Telegram 管理** — 绑定账号、看状态、手动签到，都在对话框完成。

## 部署

点这个按钮，授权 GitHub + Cloudflare，填 `BOT_TOKEN` 跟 `ADMIN_ID`：

[![Deploy to Cloudflare Workers](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/coldboy404/glados-discourse-bot)

部署后，使用带 `X-Bot-Token: <BOT_TOKEN>` 请求头访问 `https://xxx.workers.dev/setup` 激活 webhook；根路径只返回运行状态，不再自动调用 Telegram API。

> ⚠️  按钮需要 `wrangler.toml` 的 `kv_namespaces` 里**不要写** `id` 字段（包括 `id = ""`），否则按钮页面报"无法获取存储库内容"。

### Cloudflare GitHub 自动部署

本项目使用 Cloudflare Dashboard 的 GitHub 集成部署。Cloudflare 默认执行 `npx wrangler deploy`，每次仓库更新后会自动部署 `worker.js`。

请只在 Cloudflare Dashboard 中配置一次以下变量：

`Workers & Pages` → `glados-bot` → `Settings` → `Variables and Secrets`

| 名称 | 类型 | 值 |
|------|------|----|
| `BOT_TOKEN` | Secret | Telegram BotFather 的机器人 Token |
| `ADMIN_ID` | Secret 或 Text | 你的 Telegram 用户 ID |

这两个变量已经从 `wrangler.toml` 中移除，不会再被仓库更新中的占位值覆盖。以后 GitHub 有新提交时，Cloudflare 自动部署代码，但会保留 Dashboard 中已保存的变量。

如果 Cloudflare 的构建设置里手动填写了 `npx wrangler deploy`，保持即可；不要把 `BOT_TOKEN` 或 `ADMIN_ID` 写回 `wrangler.toml`。

## 绑定账号

在 Telegram 里跟 bot 聊。手动批量签到和每天定时签到都会逐个账号发送结果，包括成功、今日已签到、Cookie 失效、Cloudflare 拦截、CSRF/请求参数错误、超时等原因；账号较多时会自动拆分成多条消息，避免 Telegram 长度限制。

- **GLaDOS**：点「添加账号」→ 选择唯一的 `glados.network` → 直接发送完整 Cookie。Bot 会在多个互通域名中验证 Cookie、自动读取邮箱，并按邮箱更新已有账户。
- **NodeLoc**：点「添加账号」→「NodeLoc 自动签到」→ 从 `https://www.nodeloc.com` 复制完整 Cookie（必须包含 `_forum_session`）。
- **NodeSeek**：点「添加账号」→「NodeSeek 自动签到」→ 从 `https://nodeseek.com` 复制完整 Cookie（包含 `session` 与 `pjwt`）。Bot 自动从 `pjwt`（JWT）解析用户名，例如 `weaponj`。

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
