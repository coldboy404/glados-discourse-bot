# GLaDOS + NodeLoc Telegram Bot

[![Deploy to Cloudflare Workers](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/Linsars/glados-nodeloc-bot)

GLaDOS 自动签到 + NodeLoc 自动阅读 合体 Telegram Bot，运行在 Cloudflare Workers 上。

---

## 功能

### 🤖 GLaDOS 签到
- 每天定时自动签到
- 支持多个 GLaDOS 账号
- 账号状态查看（剩余天数、积分、流量）
- 积分兑换天数（手动操作）
- 获取订阅配置

### 🌐 NodeLoc 自动阅读
- 每次定时触发静默阅读 5 帖
- 顺序消费话题，不重复
- 自动休息机制（12% 概率休息 2-6 小时）
- 签到通知汇总当日阅读数

---

## 一键部署

1. **点击上方屎黄色按钮**
2. **登录 GitHub 授权**（Fork 仓库）
3. **选择 KV Namespace**（或创建新的）
   - 部署界面会让你绑定 `GLADOS_DB` KV 命名空间
   - 直接选「创建新 Namespace」或选已有的即可
4. **设置环境变量**
   - `ENV_BOT_TOKEN`：Telegram Bot Token（[BotFather](https://t.me/BotFather) 创建）
   - `ENV_ADMIN_ID`：你的 Telegram 用户 ID（[获取](https://t.me/userinfobot)）
5. **部署**
   - Cron 触发器已默认配置 `0 * * * *`，无需手动设置
   - ⚠️ `wrangler.toml` 中不要写 `id` 字段，否则部署会失败

## 使用

### 添加 GLaDOS 账号
> 账户管理 → 添加账户 → 选择站点 → 输入 `邮箱:Cookie`

Cookie 获取：
1. 浏览器登录 [GLaDOS](https://glados.space)
2. F12 → Application → Cookies → 复制 `koa:sess` 和 `koa:sess.sig` 值
3. 格式：`你的邮箱:koa:sess=xxx; koa:sess.sig=yyy`

### 添加 NodeLoc 账号  
> 账户管理 → 添加账户 → 🌐 NodeLoc 自动阅读 → 粘贴 Cookie

Cookie 获取：
1. 浏览器登录 [NodeLoc](https://www.nodeloc.com)
2. F12 → Application → Cookies → 复制全部 Cookie 字符串
3. 格式：`你的名称:_forum_session=xxx; _t=yyy; ...`

### 定时任务说明
- Cron 每小时触发一次
- 到签到时间（默认 9:00）自动签到，通知中附带 NodeLoc 今日阅读汇总
- 非签到时间仅执行 NodeLoc 静默阅读
- NodeLoc 状态通过「账户管理 → 查看所有账户信息」查看

---

## 本地开发

```bash
git clone https://github.com/Linsars/glados-nodeloc-bot
cd glados-nodeloc-bot

# 安装 wrangler
npm install -g wrangler

# 配置 KV（创建后把 id 填回 wrangler.toml）
npx wrangler kv namespace create GLADOS_DB

# 设置秘密变量
npx wrangler secret put ENV_ADMIN_ID
npx wrangler secret put ENV_BOT_TOKEN

# 部署
npx wrangler deploy
```

## 技术栈
- Cloudflare Workers（Free Plan）
- Cloudflare Workers KV
- Telegram Bot API
- Discourse API（NodeLoc）
- GLaDOS API
