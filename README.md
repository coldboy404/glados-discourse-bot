# GLaDOS 多账号自动签到 Bot ☁️

Telegram bot，自动签到 GLaDOS；支持多账号 Cookie 管理和健康监控。

## 能干吗

- **GLaDOS 签到** — 多账号每天自动签到；所有 GLaDOS 域名统一为一个账户入口，自动回退可用域名。
- **Cookie 自动识别** — GLaDOS 从 `koa:sess` 查询账户邮箱，并按邮箱更新去重。
- **健康监控** — 菜单显示账号状态；Cookie 失效自动标红，签到失败主动推送告警。
- **Telegram 管理** — 绑定账号、看状态、手动签到，都在对话框完成。

## 部署

点这个按钮，授权 GitHub + Cloudflare，填 `BOT_TOKEN` 跟 `ADMIN_ID`：

[![Deploy to Cloudflare Workers](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/coldboy404/glados-discourse-bot)

部署后，使用带 `X-Bot-Token: <BOT_TOKEN>` 请求头访问 `https://xxx.workers.dev/setup` 激活 webhook，并清空旧命令、只保留 `/start`；根路径只返回运行状态，不再自动调用 Telegram API。若 Telegram 客户端仍显示旧命令，重新打开机器人菜单或发送 `/start`。

> ⚠️  按钮需要 `wrangler.toml` 的 `kv_namespaces` 里**不要写** `id` 字段（包括 `id = ""`），否则按钮页面报"无法获取存储库内容"。

### Cloudflare GitHub 自动部署

本项目使用 Cloudflare Dashboard 的 GitHub 集成部署。Cloudflare 默认执行 `npx wrangler deploy`，每次仓库更新后会自动部署 `worker.js`。

请只在 Cloudflare Dashboard 中配置一次以下变量：

`Workers & Pages` → `glados-bot` → `Settings` → `Variables and Secrets`

| 名称 | 类型 | 值 |
|------|------|----|
| `BOT_TOKEN` | Secret | Telegram BotFather 的机器人 Token |
| `ADMIN_ID` | Secret 或 Text | 你的 Telegram 用户 ID |

`wrangler.toml` 已配置 `keep_vars = true`。Cloudflare GitHub 自动部署时会保留 Dashboard 中已保存的变量，不会因为仓库配置里没有写入 Token/ID 而将它们清空。

如果 Cloudflare 的构建设置里手动填写了 `npx wrangler deploy`，保持即可。不要把真实的 `BOT_TOKEN` 写进 GitHub；只在 Cloudflare Dashboard 的 Variables and Secrets 中保存一次。

## 绑定账号

在 Telegram 里跟 bot 聊。手动批量签到和每天定时签到都会逐个显示 GLaDOS 账号结果；账号较多时会自动拆分成多条消息，避免 Telegram 长度限制。

- **GLaDOS**：点「添加账号」→ 选择唯一的 `glados.network` → 直接发送完整 Cookie。Bot 会在多个互通域名中验证 Cookie、自动读取邮箱，并按邮箱更新已有账户。
Cookie 不要删减。

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
