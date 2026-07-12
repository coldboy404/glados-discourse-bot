#!/usr/bin/env bash
# =============================================
# GLaDOS 多账号自动签到 Bot — 一键部署脚本
# 用法: bash deploy.sh <BOT_TOKEN> <ADMIN_ID> <KV_NAMESPACE_ID>
# =============================================

set -euo pipefail

echo "=========================================="
echo " GLaDOS 多账号自动签到 Bot 部署脚本"
echo "=========================================="

if [ $# -ne 3 ]; then
    echo "用法: bash deploy.sh <BOT_TOKEN> <ADMIN_ID> <KV_NAMESPACE_ID>"
    echo ""
    echo "参数说明:"
    echo "  BOT_TOKEN        — BotFather 给你的 Token (123:abc)"
    echo "  ADMIN_ID         — 你的 Telegram User ID (纯数字)"
    echo "  KV_NAMESPACE_ID  — KV 命名空间的 UUID"
    echo ""
    echo "前置条件:"
    echo "  1. 安装 curl + jq (brew install jq / apt install jq)"
    echo "  2. 设置环境变量 CF_API_TOKEN (Cloudflare API Token)"
    echo "  3. 设置环境变量 CF_ACCOUNT_ID (Cloudflare 账号 ID)"
    exit 1
fi

BOT_TOKEN="$1"
ADMIN_ID="$2"
KV_NS="$3"

echo ""
echo "=== 检查环境变量 ==="
if [ -z "${CF_API_TOKEN:-}" ]; then echo "❌ 请设置 CF_API_TOKEN"; exit 1; fi
if [ -z "${CF_ACCOUNT_ID:-}" ]; then echo "❌ 请设置 CF_ACCOUNT_ID"; exit 1; fi
echo "✅ 环境变量正常"

echo ""
echo "=== 生成 metadata.json ==="
cat > /tmp/meta.json << MEOF
{"main_module": "worker.js", "bindings": [
  {"type": "kv_namespace", "name": "GLADOS_DB", "namespace_id": "${KV_NS}"},
  {"type": "secret_text", "name": "ADMIN_ID", "text": "${ADMIN_ID}"},
  {"type": "secret_text", "name": "BOT_TOKEN", "text": "${BOT_TOKEN}"}
]}
MEOF
echo "✅ metadata.json 已生成"

echo ""
echo "=== 部署 Worker ==="
SCRIPT_PATH="${SCRIPT_PATH:-./worker.js}"
if [ ! -f "$SCRIPT_PATH" ]; then
    echo "⚠️ 当前目录未找到 worker.js"
    echo "   请将 worker.js 放在当前目录，或设置 SCRIPT_PATH 环境变量"
    exit 1
fi

RESP=$(curl -s --max-time 60 -X PUT \
    -H "Authorization: Bearer ${CF_API_TOKEN}" \
    -F "metadata=@/tmp/meta.json;type=application/json" \
    -F "worker.js=@${SCRIPT_PATH};type=application/javascript+module" \
    "https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/workers/scripts/glados-bot")

SUCCESS=$(echo "$RESP" | jq -r '.success // false')
if [ "$SUCCESS" = "true" ]; then
    echo "✅ Worker 部署成功！"
else
    echo "❌ 部署失败:"
    echo "$RESP" | jq '.errors'
    exit 1
fi

echo ""
echo "=========================================="
echo " 部署完成！"
echo "=========================================="
echo ""
echo "接下来："
echo "  1. 在 Cloudflare Dashboard 设置 Cron 触发器："
echo "     Workers → glados-bot → 设置 → 触发器 → Cron"
echo "     添加: 0 * * * *"
echo ""
echo "  2. 在 Telegram 打开你的 Bot，发送 /start"
echo ""
echo "  3. 添加 GLaDOS 账号："
echo "     账户管理 → 添加账户 → 选择站点 → 粘贴 Cookie"
echo ""
echo "  4. 测试："
echo "     查看所有账户信息"
echo ""
echo "🎉 搞定！"
