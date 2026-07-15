// GLaDOS 多账号自动签到 Bot

const VIP_MAP = { 0: "Free", 10: "Free", 11: "Edu", 21: "Basic", 31: "Pro", 41: "Team", 51: "Enterprise" };
const LIMIT_MAP = { 0: 10, 10: 10, 11: 100, 21: 200, 31: 500, 41: 2000, 51: 5000 };

// GLaDOS 域名共用同一套账号系统。对用户只显示 glados；请求优先使用 facility，失败时自动回退。
const GLADOS_DOMAIN = 'glados-facility.com';
const GLADOS_DOMAINS = [GLADOS_DOMAIN, 'glados.vip', 'glados.cloud', 'glados.network', 'railgun.info', 'glados.rocks', 'glados.one', 'glados.space'];
const DEFAULT_SITES = [GLADOS_DOMAIN];

const HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Content-Type': 'application/json;charset=UTF-8',
    'Accept': 'application/json, text/plain, */*'
};

function isGladosAccount(acc) { return acc && GLADOS_DOMAINS.includes(acc.domain); }

function normalizeCookie(raw) {
    return String(raw || '')
        .replace(/^Cookie:\s*/i, '')
        .replace(/[\r\n]+/g, '; ')
        .split(';')
        .map(function(part) { return part.trim(); })
        .filter(function(part) { return /^[^=;\s]+=[\s\S]*$/.test(part); })
        .join('; ');
}

function getCookieValue(cookie, name) {
    // 注意正则中必须是字面量分号+空白，不能用转义造成的 \\s（那会匹配反斜杠）。
    const match = String(cookie || '').match(new RegExp('(?:^|;\\s*)' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '=([^;]*)'));
    return match ? match[1] : '';
}

// Telegram 一条消息可以用空行、普通换行或重复 Cookie: 前缀分隔多组 Cookie。
// 每组必须同时包含 koa:sess 和 koa:sess.sig，绝不把下一组混进前一组。
function extractGladosCookies(text) {
    const rows = String(text || '').replace(/\r/g, '').split('\n');
    const cookies = [];
    let current = [];
    const flush = function() {
        const cookie = normalizeCookie(current.join('; '));
        if (getCookieValue(cookie, 'koa:sess') && getCookieValue(cookie, 'koa:sess.sig')) cookies.push(cookie);
        current = [];
    };
    for (const row of rows) {
        const line = row.trim().replace(/^Cookie:\s*/i, '');
        if (!line) { flush(); continue; }
        // 一个新 koa:sess 表示新账号；即使用户没有留空行也可正确拆分。
        if (/(?:^|;\s*)koa:sess=/.test(line) && current.some(function(part) { return /(?:^|;\s*)koa:sess=/.test(part); })) flush();
        current.push(line);
    }
    flush();
    return Array.from(new Set(cookies));
}


function gladosRequestDomains(acc) {
    const preferred = (acc && GLADOS_DOMAINS.includes(acc.domain)) ? acc.domain : GLADOS_DOMAIN;
    return [preferred].concat(GLADOS_DOMAINS.filter(function(domain) { return domain !== preferred; }));
}

function gladosBusinessAuthFailure(result) {
    if (!result || typeof result !== 'object') return true;
    const code = result.code;
    const text = JSON.stringify(result).toLowerCase();
    return code === -2 || code === -401 || code === 401 || /not\s*logged?\s*in|not.?login|unauthorized|permission|expired|登录|过期|无权限|未授权/.test(text);
}

function gladosCheckinSucceeded(result) {
    if (!result || typeof result !== 'object' || gladosBusinessAuthFailure(result)) return false;
    if (result.success === true || result.ok === true) return true;
    if (result.code !== undefined) return result.code === 0;
    const text = String(result.message || result.msg || '').toLowerCase();
    return /check.?in|success|成功|已签到|签到完成|observation logged|tomorrow/.test(text) && !/fail|error|失败|错误|无权限|登录/.test(text);
}

async function gladosFetchJson(acc, path, options) {
    const opts = options || {};
    for (const domain of gladosRequestDomains(acc)) {
        const result = await safeFetchJson('https://' + domain + path, {
            ...opts,
            headers: { ...HEADERS, ...(opts.headers || {}), 'cookie': acc.cookie, 'origin': 'https://' + domain }
        });
        if (!result) continue;
        // 统一域名后，首个域名可能返回业务层 Cookie 失效 JSON；只有业务成功或非认证业务错误才停止。
        // 这样旧域名 Cookie 仍能回退到原来可用的域名。
        const isStatusLike = /\/api\/user\/(status|info|traffic|points)/.test(path);
        if (isStatusLike && result.code !== undefined && result.code !== 0 && gladosBusinessAuthFailure(result)) continue;
        if (path.endsWith('/checkin') && gladosBusinessAuthFailure(result)) continue;
        return { data: result, domain };
    }
    return { data: null, domain: acc.domain || GLADOS_DOMAIN };
}

// ====== 健康状态系统 ======
async function getHealthSummary(userId, env) {
    const lines = [];
    const accts = await getAccounts(userId, env);
    if (accts.length > 0) {
        const ok = accts.filter(function(a){ return a.cronSuccess !== false; }).length;
        const bad = accts.filter(function(a){ return a.cronSuccess === false; }).length;
        if (bad > 0) {
            lines.push('🟡 GLaDOS ' + ok + '/' + accts.length + ' 正常，' + bad + ' 失败');
        } else {
            lines.push('🟢 GLaDOS ' + accts.length + ' 个账号已绑定');
        }
    } else {
        lines.push('⚪ GLaDOS 未绑定账号');
    }

    return lines.join('\n');
}


// Cloudflare 不会在变量保存时执行 Worker 代码。每分钟的轻量 Cron 会检测
// BOT_TOKEN 是否变化，并使用 Dashboard 保存的稳定 webhook 地址自动重新注册。
async function telegramApi(env, method, body) {
    if (!env.BOT_TOKEN) return { ok: false, description: 'BOT_TOKEN 未配置' };
    try {
        const response = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: body ? JSON.stringify(body) : undefined
        });
        return await response.json();
    } catch (e) {
        return { ok: false, description: String(e && e.message || e) };
    }
}

async function botTokenFingerprint(token) {
    const input = new TextEncoder().encode(String(token));
    const digest = await crypto.subtle.digest('SHA-256', input);
    return Array.from(new Uint8Array(digest)).map(function(byte) {
        return byte.toString(16).padStart(2, '0');
    }).join('');
}

async function reconcileTelegramWebhook(env) {
    if (!env.BOT_TOKEN || !env.GLADOS_DB) return;
    const fingerprint = await botTokenFingerprint(env.BOT_TOKEN);
    const savedFingerprint = await env.GLADOS_DB.get('SYSTEM_BOT_TOKEN_FINGERPRINT');
    if (savedFingerprint === fingerprint) return;

    // 新 Token 无法读取旧 Token 保存的 getWebhookInfo，因此 webhook URL 必须作为
    // 非敏感 Dashboard Text 变量 WEBHOOK_URL 维持不变。
    const webhookUrl = String(env.WEBHOOK_URL || '').trim().replace(/\/$/, '');
    if (!/^https:\/\/.+\/webhook(?:\?.*)?$/.test(webhookUrl)) {
        console.log('Webhook 自动恢复跳过：WEBHOOK_URL 未配置或格式无效');
        return;
    }

    const [webhookResult, deleteCommandsResult, commandsResult] = await Promise.all([
        telegramApi(env, 'setWebhook', { url: webhookUrl, allowed_updates: ['message', 'callback_query'] }),
        telegramApi(env, 'deleteMyCommands'),
        telegramApi(env, 'setMyCommands', { commands: [{ command: 'start', description: '启动机器人' }] })
    ]);
    if (webhookResult.ok && deleteCommandsResult.ok && commandsResult.ok) {
        await env.GLADOS_DB.put('SYSTEM_BOT_TOKEN_FINGERPRINT', fingerprint);
        console.log('Telegram webhook 已随 BOT_TOKEN 更新自动恢复');
    } else {
        console.log('Webhook 自动恢复失败', JSON.stringify({
            webhook: webhookResult.description,
            deleteCommands: deleteCommandsResult.description,
            commands: commandsResult.description
        }));
    }
}

export default {
    async fetch(request, env, ctx) {
        const url = new URL(request.url);
        const origin = url.origin;
        
        if (request.method === 'POST' && url.pathname === '/webhook') {
            try {
                const update = await request.json();
                ctx.waitUntil(handleUpdate(update, env, origin).catch(e => console.log("TG Error:", e)));
            } catch (e) {}
            return new Response('OK');
        }
        
        if (request.method === 'POST' && url.pathname === '/internal/task') {
            if (request.headers.get('X-Bot-Token') !== env.BOT_TOKEN) return new Response('Forbidden', { status: 403 });
            try {
                const task = await request.json();
                ctx.waitUntil(executeTask(task, env, origin).catch(e => console.log("Task Error:", e)));
            } catch (e) {}
            return new Response('OK');
        }
        
        if (url.pathname === '/setup' || url.pathname === '/debug') {
            if (!env.BOT_TOKEN || request.headers.get('X-Bot-Token') !== env.BOT_TOKEN) {
                return new Response('Forbidden', { status: 403 });
            }
            if (url.pathname === '/setup') {
                const webhookUrl = `${url.protocol}//${url.hostname}/webhook`;
                const commands = [{ command: "start", description: "启动机器人" }];
                const [webhookRes, deleteCommandsRes, commandRes] = await Promise.all([
                    fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/setWebhook?url=${encodeURIComponent(webhookUrl)}`),
                    fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/deleteMyCommands`, { method: 'POST' }),
                    fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/setMyCommands`, {
                        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ commands })
                    })
                ]);
                const result = {
                    webhook: (await webhookRes.json()).ok === true,
                    commandsCleared: (await deleteCommandsRes.json()).ok === true,
                    commands: (await commandRes.json()).ok === true
                };
                return new Response(JSON.stringify(result), { headers: { 'Content-Type': 'application/json' } });
            }
            const diag = {
                version: 'checkin-20260712',
                hasKV: typeof env.GLADOS_DB !== 'undefined',
                hasAdminID: typeof env.ADMIN_ID !== 'undefined',
                hasBotToken: typeof env.BOT_TOKEN !== 'undefined'
            };
            return new Response(JSON.stringify(diag, null, 2), { headers: { 'Content-Type': 'application/json' } });
        }
        return new Response(JSON.stringify({
            status: 'running',
            message: 'GLaDOS Bot 链式驱动引擎正常运行中。',
            note: 'Webhook 由受保护的 /setup 路径配置；发送 /start 开始使用'
        }, null, 2), { headers: { 'Content-Type': 'application/json; charset=utf-8' } });
    },

    async scheduled(event, env, ctx) {
        if (event.cron === '0 * * * *') {
            ctx.waitUntil(handleScheduled(env));
        } else {
            ctx.waitUntil(reconcileTelegramWebhook(env));
        }
    }
};

// ================= TG 交互核心 =================
async function handleUpdate(update, env, origin) {
    let uid = null;
    if (update.message) uid = String(update.message.from.id);
    else if (update.callback_query) uid = String(update.callback_query.from.id);

    if (env.ADMIN_ID && uid) {
        const adminIdStr = String(env.ADMIN_ID).trim();
        if (uid !== adminIdStr) {
            if (update.message && update.message.text === '/start') {
                await tgSend(uid, "⛔️ <b>未授权</b>\n\n您不是该机器人的管理员，无法使用。", env);
            }
            return;
        }
    }

    if (update.message && update.message.text) {
        await handleMessage(update.message, env, origin);
    } else if (update.callback_query) {
        await handleCallback(update.callback_query, env, origin);
    }
}

async function handleMessage(message, env, origin) {
    const chatId = message.chat.id;
    const text = message.text.trim();
    const userId = String(message.from.id);

    if (text === '/start') {
        await env.GLADOS_DB.delete(`STATE_${userId}`);
        // 每次 /start 都同步 Telegram 命令菜单，清除历史命令，只保留 /start。
        await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/deleteMyCommands`, { method: 'POST' }).catch(function(){});
        await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/setMyCommands`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ commands: [{ command: 'start', description: '启动机器人' }] })
        }).catch(function(){});
        await sendMainMenu(chatId, userId, env);
        return;
    }
    const state = await env.GLADOS_DB.get(`STATE_${userId}`);
    if (state === 'AWAITING_ACCOUNT_INFO') await processAddAccountInfo(chatId, userId, text, env);
    else if (state === 'AWAITING_UPDATE_COOKIE') await processUpdateCookie(chatId, userId, text, env);
    else if (state === 'AWAITING_CRON_TIME') await processCronTime(chatId, userId, text, env);
    else await sendMainMenu(chatId, userId, env);
}

async function handleCallback(callbackQuery, env, origin) {
    const chatId = callbackQuery.message.chat.id;
    const messageId = callbackQuery.message.message_id;
    const userId = String(callbackQuery.from.id);
    const data = callbackQuery.data;
    // 辅助：在同一个菜单消息上编辑，不刷屏
    var rp = function(t, k) { return tgEdit(chatId, messageId, t, k || null, env); };
    
    // 存储当前菜单消息 ID，供后续文本回复编辑
    await env.GLADOS_DB.put(`MSGID_${userId}`, String(messageId), { expirationTtl: 600 });
    
    await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/answerCallbackQuery`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ callback_query_id: callbackQuery.id })
    });

    if (data === 'menu_main') {
        await env.GLADOS_DB.delete(`STATE_${userId}`);
        await sendMainMenu(chatId, userId, env, messageId);
    } 
    else if (data === 'toggle_email') {
        const pref = await getPref(userId, env);
        pref.showEmail = !pref.showEmail;
        await env.GLADOS_DB.put(`PREF_${userId}`, JSON.stringify(pref));
        await sendMainMenu(chatId, userId, env, messageId); 
    }
    // --- 账号管理 ---
    else if (data === 'account_mgr_menu') {
        const kb = {
            inline_keyboard: [
                [{ text: "➕ 添加账户", callback_data: "add_account" }, { text: "⚙️ 管理单个账户", callback_data: "list_manage" }],
                [{ text: "👁️ 查看所有账户信息", callback_data: "view_all_accounts" }],
                [{ text: "🔙 返回主菜单", callback_data: "menu_main" }]
            ]
        };
        await tgEdit(chatId, messageId, "👤 <b>账户管理</b>\n\n请选择操作：", kb, env);
    }
    else if (data === 'view_all_accounts') {
        const accounts = await getAccounts(userId, env);
        if (accounts.length === 0) return rp("❌ 您还没添加任何账号。");
        await tgEdit(chatId, messageId, "⏳ <b>正在获取全部账户信息...</b>\n\n<i>(系统将全自动查询，请稍候)</i>", null, env);
        await executeTask({ type: 'view_all', chatId, userId, startIndex: 0, plan: null, successList: [] }, env, origin);
    }
    // --- 单个账户管理 ---
    else if (data === 'list_manage') {
        const accounts = await getAccounts(userId, env);
        if (accounts.length === 0) return rp("❌ 您还没添加任何账号。");
        await showAccountList(chatId, messageId, userId, 'manage', env);
    }
    // --- 积分兑换 ---
    else if (data === 'exchange_menu') {
        const kb = {
            inline_keyboard: [
                [{ text: "👤 单账户兑换", callback_data: "list_exchange" }],
                [{ text: "👥 统一批量兑换", callback_data: "batch_exchange_menu" }],
                [{ text: "🔙 返回主菜单", callback_data: "menu_main" }]
            ]
        };
        await tgEdit(chatId, messageId, "🔄 <b>积分兑换天数</b>\n\n请选择兑换模式：", kb, env);
    }
    else if (data === 'batch_exchange_menu') {
        const kb = {
            inline_keyboard: [
                [{ text: "1. 100积分 兑换 10天", callback_data: `batch_exch_plan100` }],
                [{ text: "2. 200积分 兑换 30天", callback_data: `batch_exch_plan200` }],
                [{ text: "3. 500积分 兑换 100天", callback_data: `batch_exch_plan500` }],
                [{ text: "🔙 取消返回", callback_data: `exchange_menu` }]
            ]
        };
        await tgEdit(chatId, messageId, "🔄 <b>统一批量兑换</b>\n\n系统将自动检测所有账户积分，满足条件的将自动兑换，不满足的自动跳过。\n👉 <b>请选择你要兑换的套餐：</b>", kb, env);
    }
    else if (data.startsWith('batch_exch_')) {
        const plan = data.split('_')[2]; 
        const accounts = await getAccounts(userId, env);
        if (accounts.length === 0) return rp("❌ 您还没添加任何账号。");
        
        await tgEdit(chatId, messageId, `⏳ <b>正在执行统一批量兑换，请稍候...</b>`, null, env);
        await executeTask({ type: 'batch_exchange', chatId, userId, startIndex: 0, plan, successList: [] }, env, origin);
    }
    // --- 订阅配置 ---
    else if (data === 'sub_menu') {
        const kb = {
            inline_keyboard: [
                [{ text: "👤 提取单账户订阅", callback_data: "list_sub" }],
                [{ text: "👥 一键提取全部账户订阅", callback_data: "do_sub_all" }],
                [{ text: "🔙 返回主菜单", callback_data: "menu_main" }]
            ]
        };
        await tgEdit(chatId, messageId, "🔗 <b>获取订阅配置 (Clash)</b>\n\n请选择提取方式：", kb, env);
    }
    else if (data === 'do_sub_all') {
        const accounts = await getAccounts(userId, env);
        if (accounts.length === 0) return rp("❌ 您还没添加任何账号。");
        await tgEdit(chatId, messageId, "⏳ <b>正在批量获取全部账户的订阅链接，请稍候...</b>", null, env);
        await executeTask({ type: 'sub_all', chatId, userId, startIndex: 0, plan: null, successList: [] }, env, origin);
    }
    // --- 签到管理 ---
    else if (data === 'checkin_menu') {
        const pref = await getPref(userId, env);
        const kb = {
            inline_keyboard: [
                [{ text: "🚀 1. 立即执行全部账号签到", callback_data: "do_checkin" }],
                [{ text: `⏰ 2. 更改定时签到 (当前: ${pref.checkinHour}:00)`, callback_data: "set_cron_time" }],
                [{ text: "🔙 返回主菜单", callback_data: "menu_main" }]
            ]
        };
        await tgEdit(chatId, messageId, "📅 <b>签到设置</b>\n请选择：", kb, env);
    }
    else if (data === 'do_checkin') {
        const accounts = await getAccounts(userId, env);
        if (accounts.length === 0) return rp("❌ 您还没添加任何账号。");
        await tgEdit(chatId, messageId, "⏳ <b>正在执行统一批量签到...</b>", null, env);
        await executeTask({ type: 'checkin', chatId, userId, startIndex: 0, plan: null, successList: [] }, env, origin);
    }
    else if (data === 'set_cron_time') {
        await env.GLADOS_DB.put(`STATE_${userId}`, 'AWAITING_CRON_TIME', { expirationTtl: 120 });
        await rp("⏰ <b>请回复数字 (0-23)</b>\n\n⚠️ 必须为整点！\n例如输入 <code>12</code> 代表每天中午 12:00 左右签到\n<i>(系统具有±10分钟容错，防止漏签)</i>");
    }
    // --- 其他辅助 ---
    else if (data === 'add_account') {
        await showSiteListMenu(chatId, messageId, userId, env);
    }
    else if (data.startsWith('selsite_')) {
        const index = parseInt(data.split('_')[1]);
        const selectedSite = DEFAULT_SITES[index];

        if (!selectedSite) return rp("❌ 站点异常");

        await env.GLADOS_DB.put(`STATE_${userId}`, 'AWAITING_ACCOUNT_INFO', { expirationTtl: 300 });
        await env.GLADOS_DB.put(`TEMP_${userId}`, selectedSite, { expirationTtl: 300 });
        const msg = `📝 您选择了站点: <b>${selectedSite}</b>\n\n<b>发送 Cookie 即可</b>，Bot 自动提取邮箱。\n\n手动格式：<code>邮箱:cookie</code>（一行一个）\n\n💡 浏览器 F12 → Application → Cookies → 复制完整 Cookie 发送。`;
        await rp(msg);
    }
    else if (data === 'clear_all_confirm') {
        const kb = { inline_keyboard: [[{ text: "⚠️ 确认清空 (不可恢复)", callback_data: "clear_all_yes" }], [{ text: "🔙 取消返回", callback_data: "list_manage" }]] };
        await tgEdit(chatId, messageId, "🗑️ <b>危险操作</b>\n\n确定要清空数据库中的所有账号吗？", kb, env);
    }
    else if (data === 'clear_all_yes') {
        await env.GLADOS_DB.put(`USER_${userId}`, JSON.stringify([]));
        await tgEdit(chatId, messageId, "✅ <b>已成功清空所有账号。</b>", { inline_keyboard: [[{ text: "🔙 返回主菜单", callback_data: "menu_main" }]] }, env);
    }
    else if (data.startsWith('list_')) {
        const action = data.split('_')[1]; 
        await showAccountList(chatId, messageId, userId, action, env);
    }
    else if (data.startsWith('sel_')) {
        const parts = data.split('_');
        const action = parts[1];
        const index = parseInt(parts[2]);
        const accounts = await getAccounts(userId, env);
        const acc = accounts[index];
        const pref = await getPref(userId, env);
        
        if (!acc) return rp("❌ 找不到该账号");

        if (action === 'manage') {
            const kb = {
                inline_keyboard: [
                    [{ text: "👁️ 查看此账户信息", callback_data: `view_acc_${index}` }, { text: "✅ 立即单独签到", callback_data: `chk_acc_${index}` }],
                    [{ text: "🔁 更新 Cookies", callback_data: `upd_acc_${index}` }, { text: "❌ 删除此账户", callback_data: `del_acc_${index}` }],
                    [{ text: "🔙 返回账号列表", callback_data: "list_manage" }]
                ]
            };
            await tgEdit(chatId, messageId, `⚙️ <b>管理账户</b>\n\n当前账户：<code>${maskEmail(acc.email || acc.username || '?', pref.showEmail)}</code>\n所属站点：<code>${acc.domain}</code>\n\n请选择操作：`, kb, env);
        } else if (action === 'exchange') {
            await showExchangePlans(chatId, messageId, index, acc, userId, env);
        } else if (action === 'sub') {
            await rp(`🔗 正在获取 <code>${maskEmail(acc.email, pref.showEmail)}</code> 的订阅，请稍候...`);
            const subData = await getSubAndHost(acc.domain, acc.cookie);
            await rp(subData);
        }
    }
    else if (data.startsWith('view_acc_')) {
        const index = parseInt(data.split('_')[2]);
        const accounts = await getAccounts(userId, env);
        const acc = accounts[index];
        if (!acc) return rp("❌ 账号不存在");
        
        await rp("⏳ 正在拉取该账号信息...");
        const pref = await getPref(userId, env);
        const accData = await getAccountDataObj(acc, false);
        const msgStr = formatAccountString(acc, index + 1, accounts.length, pref, accData, true, true);
        await rp(msgStr);
    }
    else if (data.startsWith('chk_acc_')) {
        const index = parseInt(data.split('_')[2]);
        const accounts = await getAccounts(userId, env);
        const acc = accounts[index];
        const pref = await getPref(userId, env);
        if (!acc) return rp("❌ 账号不存在");
        
        await rp("⏳ 正在为您单独执行签到，请稍候...");
        const accData = await getAccountDataObj(acc, true); // true 代表触发签到
        const msgStr = formatAccountString(acc, index + 1, accounts.length, pref, accData, true, true);
        await rp(msgStr);
    }
    else if (data.startsWith('del_acc_')) {
        const index = parseInt(data.split('_')[2]);
        let accounts = await getAccounts(userId, env);
        if (!accounts[index]) return rp("❌ 账号不存在");
        const deletedEmail = accounts[index].email;
        accounts.splice(index, 1);
        await env.GLADOS_DB.put(`USER_${userId}`, JSON.stringify(accounts));
        const pref = await getPref(userId, env);
        await tgEdit(chatId, messageId, `✅ 已成功删除账号：<code>${maskEmail(deletedEmail, pref.showEmail)}</code>`, { inline_keyboard: [[{ text: "🔙 返回账户管理", callback_data: "list_manage" }]] }, env);
    }
    else if (data.startsWith('upd_acc_')) {
        const index = parseInt(data.split('_')[2]);
        await env.GLADOS_DB.put(`STATE_${userId}`, 'AWAITING_UPDATE_COOKIE', { expirationTtl: 300 });
        await env.GLADOS_DB.put(`TEMP_${userId}`, index.toString(), { expirationTtl: 300 });
        await rp(`🔁 <b>请直接回复新的 Cookie 内容：</b>`);
    }
    else if (data.startsWith('doexch_')) {
        const parts = data.split('_');
        const index = parseInt(parts[1]);
        const plan = parts[2];
        const accounts = await getAccounts(userId, env);
        const acc = accounts[index];
        const pref = await getPref(userId, env);
        
        await rp(`⏳ 正在为您兑换套餐，请稍候...`);
        const result = await safeFetchJson(`https://${acc.domain}/api/user/exchange`, {
            method: 'POST', headers: { ...HEADERS, 'cookie': acc.cookie, 'origin': `https://${acc.domain}` },
            body: JSON.stringify({ planType: plan })
        });
        
        const accData = await getAccountDataObj(acc, false); 
        accData.statusMsg = (result && result.message) ? `✅ ${result.message}` : '✅ 兑换操作完成';
        const msgStr = formatAccountString(acc, index + 1, accounts.length, pref, accData, true, false);
        await rp(msgStr);
    }
}

// ================= 输入消息逻辑处理 =================
async function processAddAccountInfo(chatId, userId, text, env) {
    const state = await env.GLADOS_DB.get(`STATE_${userId}`);
    const domain = await env.GLADOS_DB.get(`TEMP_${userId}`);
    const msgId = await env.GLADOS_DB.get(`MSGID_${userId}`);
    await env.GLADOS_DB.delete(`STATE_${userId}`);
    await env.GLADOS_DB.delete(`TEMP_${userId}`);
    await env.GLADOS_DB.delete(`MSGID_${userId}`);
    const rp = function(t, k) { return tgEdit(chatId, parseInt(msgId), t, k || null, env); };
    if (!domain) return rp("❌ 会话过期，请重新选择站点。");

    // GLaDOS Cookie 支持单条和多条粘贴；按每组 koa:sess / koa:sess.sig 拆分并逐个验证。
    const suppliedCookies = extractGladosCookies(text);
    if (suppliedCookies.length > 0) {
        let accounts = await getAccounts(userId, env);
        let added = 0, updated = 0, failed = 0;
        for (const cookie of suppliedCookies) {
            let found = null;
            for (const domainCandidate of GLADOS_DOMAINS) {
                const data = await safeFetchJson(`https://${domainCandidate}/api/user/info`, { headers: { ...HEADERS, 'Cookie': cookie, 'Origin': `https://${domainCandidate}` } });
                const email = data && data.code === 0 && data.data && data.data.userInfo && data.data.userInfo.email;
                if (email) {
                    found = { email: email, sourceDomain: domainCandidate };
                    break;
                }
            }
            if (!found) { failed++; continue; }
            const emailKey = found.email.trim().toLowerCase();
            const existingIndex = accounts.findIndex(function(account) { return isGladosAccount(account) && String(account.email || '').trim().toLowerCase() === emailKey; });
            const account = { domain: GLADOS_DOMAIN, email: found.email, cookie: cookie };
            if (existingIndex >= 0) {
                accounts[existingIndex] = { ...accounts[existingIndex], ...account };
                updated++;
            } else {
                accounts.push(account);
                added++;
            }
        }
        if (added || updated) {
            await env.GLADOS_DB.put(`USER_${userId}`, JSON.stringify(accounts));
            await saveUserIdForCron(userId, env);
            const total = accounts.filter(isGladosAccount).length;
            const failedText = failed ? `\n❌ 无法验证: ${failed} 个` : '';
            return rp(`✅ <b>GLaDOS Cookie 导入完成！</b>\n\n➕ 新增: ${added} 个\n🔁 更新: ${updated} 个${failedText}\n📦 当前 GLaDOS 账号数: ${total} 个\n\n<i>已按域名优先级自动验证并保存为统一 GLaDOS 账户。</i>`);
        }
        return rp("❌ 无法验证 GLaDOS Cookie，请确认已登录后重新抓取。");
    }

    const lines = text.split('\n');
    let accounts = await getAccounts(userId, env);
    let accMap = new Map();
    accounts.forEach(acc => {
        const key = `${acc.domain}:${String(acc.email || '').trim().toLowerCase()}`;
        accMap.set(key, acc);
    });
    if (lines.some(line => line.includes('koa:sess='))) {
        const supplied = normalizeCookie(lines.map(line => line.split(':').slice(1).join(':')).join('; '));
        if (!getCookieValue(supplied, 'koa:sess') || !getCookieValue(supplied, 'koa:sess.sig')) {
            return rp("❌ GLaDOS Cookie 格式错误：需要同时包含 <code>koa:sess</code> 与 <code>koa:sess.sig</code>。");
        }
    }

    let added = 0, updated = 0;
    for (let line of lines) {
        const parts = line.trim().split(':');
        if (parts.length >= 2) {
            const email = parts[0].trim();
            const emailKey = email.toLowerCase();
            const cookie = parts.slice(1).join(':').trim();
            
            const accountKey = `${GLADOS_DOMAIN}:${emailKey}`;
            if (accMap.has(accountKey)) updated++;
            else added++;
            
            accMap.set(accountKey, { domain: GLADOS_DOMAIN, email, cookie });
        }
    }

    accounts = Array.from(accMap.values()).map(function(account) {
        return { ...account, domain: GLADOS_DOMAIN, cookie: normalizeCookie(account.cookie) };
    });
    await env.GLADOS_DB.put(`USER_${userId}`, JSON.stringify(accounts));
    await saveUserIdForCron(userId, env);

    let resultMsg = `✅ <b>导入完毕！(全局防重生效)</b>\n\n➕ 新增账号: ${added} 个\n🔁 覆盖更新: ${updated} 个\n📦 当前总账号数: ${accounts.length} 个`;
    await rp(resultMsg);
    await rp("👇", { inline_keyboard: [[{ text: "🔙 返回主菜单", callback_data: "menu_main" }]] });
}


async function processUpdateCookie(chatId, userId, text, env) {
    const indexStr = await env.GLADOS_DB.get(`TEMP_${userId}`);
    const msgId = await env.GLADOS_DB.get(`MSGID_${userId}`);
    await env.GLADOS_DB.delete(`STATE_${userId}`);
    await env.GLADOS_DB.delete(`TEMP_${userId}`);

    const rp = function(t, k) { return tgEdit(chatId, parseInt(msgId) || 0, t, k || null, env); };
    if (!indexStr) return rp("❌ 会话过期。");
    const index = parseInt(indexStr);
    const accounts = await getAccounts(userId, env);
    if (!accounts[index]) return rp("❌ 账号不存在");
    
    const newCookie = normalizeCookie(text);
    const account = accounts[index];
    if (!getCookieValue(newCookie, 'koa:sess')) {
        return rp("❌ GLaDOS Cookie 格式错误：需要包含 <code>koa:sess</code>。");
    }
    account.cookie = newCookie;
    account.domain = GLADOS_DOMAIN;
    await env.GLADOS_DB.put(`USER_${userId}`, JSON.stringify(accounts));
    
    await rp("✅ Cookie 更新成功！正在为您验证签到状态...");
    const pref = await getPref(userId, env);
    const data = await getAccountDataObj(accounts[index], true);
    const msgStr = formatAccountString(accounts[index], index + 1, accounts.length, pref, data, true, true);
    await rp(msgStr, { inline_keyboard: [[{ text: "🔙 返回账户管理", callback_data: "list_manage" }]] });
}


async function processCronTime(chatId, userId, text, env) {
    await env.GLADOS_DB.delete(`STATE_${userId}`);
    let hour = parseInt(text.trim());
    if (isNaN(hour) || hour < 0 || hour > 23) return tgSend(chatId, "❌ 输入无效，请输入 0 到 23。", env);
    const pref = await getPref(userId, env);
    pref.checkinHour = hour;
    await env.GLADOS_DB.put(`PREF_${userId}`, JSON.stringify(pref));
    await tgSend(chatId, `✅ 设置成功！以后将每天北京时间 <b>${hour}:00</b> 为您自动签到。`, env);
}

// ================= 核心：链式引擎驱动 =================
async function executeTask(task, env, origin) {
    const { type, chatId, userId, startIndex, plan, successList = [], resultList = [] } = task;
    const accounts = await getAccounts(userId, env);
    const pref = await getPref(userId, env);
    
    const batchSize = 6;
    const endIndex = Math.min(startIndex + batchSize, accounts.length);
    
    let msgs = [];
    let newSuccessList = [...successList];
    let newResultList = [...resultList];

    for (let i = startIndex; i < endIndex; i++) {
        const acc = accounts[i];
        
        if (type === 'checkin' || type === 'view_all') {
            const doCheckin = (type === 'checkin');
            const data = await getAccountDataObj(acc, doCheckin);
            const gladosMsg = formatAccountString(acc, i + 1, accounts.length, pref, data, true, false);
            msgs.push(gladosMsg);
            if (type === 'checkin') newResultList.push(gladosMsg);
        } 
        else if (type === 'batch_exchange') {
            const ptsRes = await safeFetchJson(`https://${acc.domain}/api/user/points`, { headers: { ...HEADERS, 'cookie': acc.cookie, 'origin': `https://${acc.domain}` }});
            let balanceNum = 0;
            if (ptsRes && ptsRes.code === 0) balanceNum = parseInt(ptsRes.points || 0);
            
            let reqPoints = plan === 'plan100' ? 100 : (plan === 'plan200' ? 200 : 500);

            if (balanceNum >= reqPoints) {
                const exchRes = await safeFetchJson(`https://${acc.domain}/api/user/exchange`, {
                    method: 'POST', headers: { ...HEADERS, 'cookie': acc.cookie, 'origin': `https://${acc.domain}` },
                    body: JSON.stringify({ planType: plan })
                });
                const data = await getAccountDataObj(acc, false); 
                data.statusMsg = (exchRes && exchRes.message) ? `✅ ${exchRes.message}` : '✅ 兑换成功';
                newSuccessList.push(formatAccountString(acc, i + 1, accounts.length, pref, data, true, false));
            }
        }
        else if (type === 'sub_all') {
            const link = await getSubAndHost(acc.domain, acc.cookie, true);
            if (link && !link.includes('xxxx')) {
                msgs.push(`<b>${i+1}. ${maskEmail(acc.email, pref.showEmail)}</b>\n<code>${link}</code>\n`);
            } else if (link && link.includes('xxxx')) {
                msgs.push(`<b>${i+1}. ${maskEmail(acc.email, pref.showEmail)}</b>\n❌ 提取失败：该账号订阅码被隐藏 (xxxx)\n`);
            } else {
                msgs.push(`<b>${i+1}. ${maskEmail(acc.email, pref.showEmail)}</b>\n❌ 提取失败：网络异常或账号受限\n`);
            }
        }
        await new Promise(r => setTimeout(r, 600));
    }

    if (type !== 'checkin' && (type === 'view_all' || type === 'sub_all') && msgs.length > 0 && chatId) {
        await tgSend(chatId, msgs.join("\n"), env);
    }

    if (endIndex < accounts.length) {
        await executeTask({ type, chatId, userId, startIndex: endIndex, plan, successList: newSuccessList, resultList: newResultList }, env, origin);
    } else {
        if (chatId) {
            const doneKb = { inline_keyboard: [[{ text: "🔙 返回主菜单", callback_data: "menu_main" }]] };
            if (type === 'checkin') {
                await tgSendResultList(chatId, `✅ <b>全部 ${accounts.length} 个账号签到处理完毕！</b>`, newResultList, env, doneKb);
            } else if (type === 'view_all') {
                await tgSend(chatId, `✅ <b>全部 ${accounts.length} 个账号查询处理完毕！</b>`, env, doneKb);
            } else if (type === 'batch_exchange') {
                if (newSuccessList.length > 0) {
                    for (let i = 0; i < newSuccessList.length; i += 8) {
                        await tgSend(chatId, newSuccessList.slice(i, i + 8).join("\n"), env);
                    }
                    await tgSend(chatId, `🎉 <b>批量兑换彻底完成！</b>\n共计 <b>${newSuccessList.length}</b> 个账号满足条件并成功进行了兑换。`, env, doneKb);
                } else {
                    await tgSend(chatId, `ℹ️ <b>批量兑换完成</b>\n未发现满足所需积分门槛的账号，因此跳过了所有账号。`, env, doneKb);
                }
            } else if (type === 'sub_all') {
                await tgSend(chatId, `✅ <b>全部 ${accounts.length} 个账号的订阅配置提取完毕！</b>`, env, doneKb);
            }
        }
    }
}

// ================= 定时任务 (CRON) =================
function getAdminUserId(env) {
    return String(env.ADMIN_ID || '').trim();
}

function getBeijingDateParts(now = new Date()) {
    const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23'
    }).formatToParts(now).reduce(function(result, part) {
        result[part.type] = part.value;
        return result;
    }, {});
    return { date: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour) };
}

async function claimScheduledCheckin(userId, date, env) {
    const key = `SCHEDULED_CHECKIN_${userId}_${date}`;
    if (await env.GLADOS_DB.get(key)) return false;
    // 先记录当天执行权，避免 Cloudflare Cron 重投或旧 ADMIN_ID 数据导致重复签到。
    await env.GLADOS_DB.put(key, 'started', { expirationTtl: 172800 });
    return true;
}

async function handleScheduled(env) {
    // 本 Bot 是单管理员设计：ADMIN_ID 变更后，只能给当前管理员执行/推送，
    // 绝不再遍历历史 ALL_USERS 中残留的旧管理员。
    const userId = getAdminUserId(env);
    if (!userId || !env.GLADOS_DB) return;

    const now = getBeijingDateParts();
    const pref = await getPref(userId, env);
    if (now.hour !== pref.checkinHour) return;
    if (!await claimScheduledCheckin(userId, now.date, env)) return;

    const accounts = await getAccounts(userId, env);
    const resultRows = [];
    for (const acc of accounts) {
        const response = await gladosFetchJson(acc, '/api/user/checkin', { method: 'POST', body: JSON.stringify({ token: GLADOS_DOMAIN }) });
        const result = response.data;
        acc.domain = GLADOS_DOMAIN;
        acc.cronSuccess = gladosCheckinSucceeded(result);
        acc.cronMsg = result ? escapeHtml(result.message || JSON.stringify(result).slice(0, 60)) : '超时/无响应';
        resultRows.push(`${acc.cronSuccess ? '✅' : '❌'} <b>GLaDOS</b> ${maskEmail(acc.email || '?', pref.showEmail)}: ${acc.cronSuccess ? '签到成功' : '签到失败'}：${acc.cronMsg}`);
        await new Promise(function(resolve) { setTimeout(resolve, 600); });
    }
    await env.GLADOS_DB.put('USER_' + userId, JSON.stringify(accounts));
    const gladosBad = accounts.filter(function(acc) { return isGladosAccount(acc) && acc.cronSuccess === false; });
    if (gladosBad.length > 0) {
        const names = gladosBad.map(function(acc) { return acc.email || acc.username || '?'; }).join(', ');
        fetch('https://api.telegram.org/bot' + env.BOT_TOKEN + '/sendMessage', {
            method: 'POST', headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({ chat_id: userId, text: '⚠️ <b>GLaDOS ' + gladosBad.length + ' 个账号签到失败</b>\n' + names, parse_mode: 'HTML' })
        }).catch(function(){});
    }
    await tgSendResultList(userId, '⏰ <b>定时签到自动完成</b>', resultRows, env);
    await tgSend(userId, await getHealthSummary(userId, env), env);
}

// ================= 数据解析与提取引擎 =================
async function safeFetchJson(url, options) {
    try {
        const controller = new AbortController();
        const id = setTimeout(() => controller.abort(), 6000);
        const res = await fetch(url, { ...options, signal: controller.signal });
        clearTimeout(id);
        if (!res.ok) return null;
        return await res.json();
    } catch (e) { return null; }
}

// 获取纯净版 Clash 订阅配置 (包含 302 拦截防丢策略与原生解析)
async function getSubAndHost(domain, cookie, returnRaw = false) {
    try {
        let subLink = null;
        let activeDomain = domain;
        const candidateDomains = GLADOS_DOMAINS.includes(domain) ? [domain].concat(GLADOS_DOMAINS.filter(function(d) { return d !== domain; })) : [domain];
        for (const candidate of candidateDomains) {
            activeDomain = candidate;
            const reqOpts = { headers: { ...HEADERS, 'cookie': cookie, 'origin': `https://${candidate}` } };
            // 1. 优先尝试拦截 302 真实重定向接口
            try {
                const redirectRes = await fetch(`https://${candidate}/api/listen/mihomo`, { headers: reqOpts.headers, redirect: 'manual' });
                if (redirectRes.status >= 300 && redirectRes.status < 400) {
                    const loc = redirectRes.headers.get('Location');
                    if (loc && (loc.includes('update.glados-config') || loc.includes('update.'))) subLink = loc;
                }
            } catch(e) {}

            // 2. 若没有重定向，回退 status 接口解析
            if (!subLink) {
                const statusRes = await safeFetchJson(`https://${candidate}/api/user/status`, reqOpts);
                if (statusRes && statusRes.code === 0 && statusRes.data) {
                    if (statusRes.data.subscriptions?.mihomo) subLink = statusRes.data.subscriptions.mihomo;
                    else if (statusRes.data.subscriptions?.clash) subLink = statusRes.data.subscriptions.clash;
                    else {
                        const userId = statusRes.data.userId || statusRes.data.configureId;
                        const code = statusRes.data.code;
                        const port = statusRes.data.port;
                        if (userId && code && port) subLink = `https://update.glados-config.com/mihomo/${userId}/${code}/${port}/glados.yaml`;
                    }
                }
            }
            if (subLink) break;
        }

        if (!subLink) return returnRaw ? null : `❌ <b>提取失败：无法获取账号状态</b>\n(提示：您的 Cookie 可能已失效，或 GLaDOS 接口访问受限)`;
        if (subLink.includes('xxxx')) {
            const errMsg = `❌ <b>提取失败：该账号订阅配置已被官方屏蔽隐藏 (xxxx)</b>\n\n原因：账号状态受限，或作为新账号从未激活过订阅。\n\n👉 <b>解决办法：</b>\n请在浏览器登录 <code>${activeDomain}</code>，进入【控制台】-【订阅管理】-【FLClash】页面强制激活一次即可恢复。`;
            return returnRaw ? subLink : errMsg;
        }
        return returnRaw ? subLink : `<b>✅ 获取成功</b>\n\n<b>Mihomo / Clash 订阅：</b>\n<code>${subLink}</code>`;
    } catch (e) {
        return returnRaw ? null : "❌ 提取失败：网络超时或发生系统异常。";
    }
}

async function getAccountDataObj(acc, doCheckin = false) {
    let data = {
        statusMsg: "❌ 获取超时或受限", trafficStr: "获取失败", medal: "🪙", 
        pointsStr: "0", timeLeft: "0", planStr: "未知", cookieValid: false
    };

    try {
        // GLaDOS 域名互通：每个接口均从可用域名回退，避免已统一的旧 Cookie 因单个域名故障失效。
        let checkinRes = null;
        if (doCheckin) {
            checkinRes = (await gladosFetchJson(acc, '/api/user/checkin', {
                method: 'POST', body: JSON.stringify({ token: GLADOS_DOMAIN })
            })).data;
        }

        const statusLookup = await gladosFetchJson(acc, '/api/user/status');
        const activeAcc = { ...acc, domain: statusLookup.domain };
        const statusRes = statusLookup.data;
        const trafficRes = (await gladosFetchJson(activeAcc, '/api/user/traffic')).data;
        const pointsRes = (await gladosFetchJson(activeAcc, '/api/user/points')).data;

        if (statusRes && statusRes.code === 0 && statusRes.data) {
            data.cookieValid = true;
            data.timeLeft = parseInt(statusRes.data.leftDays || 0).toString();
            data.planStr = VIP_MAP[statusRes.data.vip] || `VIP${statusRes.data.vip}`;

            if (trafficRes && trafficRes.code === 0 && trafficRes.data) {
                const usedGb = (trafficRes.data.today / 1073741824).toFixed(2);
                const limitGb = LIMIT_MAP[statusRes.data.vip] || '?';
                data.trafficStr = `${usedGb} GB / ${limitGb} GB`;
            }

            let balanceNum = 0;
            let changeStr = "0";
            let checkedInToday = false;
            
            // 【核心修复】强制使用系统时间+8小时算出准确的北京日期进行对比
            let serverTime = statusRes.data.system_time || Date.now();
            let bjDate = new Date(serverTime + 8 * 3600 * 1000);
            let todayStr = bjDate.toISOString().split('T')[0];

            if (pointsRes && pointsRes.code === 0) {
                balanceNum = parseInt(pointsRes.points || 0);
                if (pointsRes.history && pointsRes.history.length > 0) {
                    // 遍历历史，找今日第一条签到记录（history[0] 可能是兑换记录）
                    for (const record of pointsRes.history) {
                        if (record.business === 'system:checkin' && record.detail === todayStr) {
                            checkedInToday = true;
                            changeStr = parseInt(record.change || 0).toString();
                            if (!changeStr.startsWith('-') && changeStr !== '0') changeStr = '+' + changeStr;
                            break;
                        }
                    }
                }
            }

            if (balanceNum >= 500) data.medal = "🥇";
            else if (balanceNum >= 100) data.medal = "🥈";
            else data.medal = "🥉";

            if (checkedInToday) data.pointsStr = `${changeStr} / ${balanceNum}`;
            else data.pointsStr = `${balanceNum}`;

            if (doCheckin) {
                if (checkinRes) {
                    const rawMess = checkinRes.message || "";
                    if (rawMess.includes("Checkin")) data.statusMsg = "✅ 签到成功";
                    else if (rawMess.includes("observation logged") || rawMess.includes("Tomorrow")) data.statusMsg = "🔁 今日已签到";
                    else data.statusMsg = `❌ ${rawMess}`;
                } else {
                    data.statusMsg = "❌ 签到请求超时";
                }
            } else {
                data.statusMsg = checkedInToday ? "🔁 今日已签到" : "⚠️ 今日未签到";
            }
        } else {
            if (statusRes && statusRes.code !== 0) data.statusMsg = "❌ Cookie 失效";
        }
    } catch (e) {
        data.statusMsg = "❌ 运行异常";
    }
    return data;
}

function formatAccountString(acc, index, total, pref, data, includeStatus = true, isSingle = false) {
    let str = "";
    if (!isSingle) str += `〰️〰️〰️〰️〰️〰️〰️〰️〰️〰️〰️〰️\n[${index}/${total}] `;
    str += `📧 ${maskEmail(acc.email, pref.showEmail)}\n`;
    str += ` ├ 🌐 站点: glados\n`;
    str += ` ├ 🍪 Cookie: ${data.cookieValid ? '✅ 有效' : '❌ 已失效'}\n`;
    if (includeStatus) str += ` ├ 📝 状态: ${data.statusMsg}\n`;
    str += ` ├ 📊 流量: ${data.trafficStr}\n`;
    str += ` ├ ${data.medal} 积分: ${data.pointsStr}\n`;
    str += ` ├ ⏳ 剩余: ${data.timeLeft} 天 (${data.planStr})`;
    if (!isSingle) str += `\n〰️〰️〰️〰️〰️〰️〰️〰️〰️〰️〰️〰️`;
    return str;
}


// ================= 数据存取辅助 =================
async function getAccounts(userId, env) {
    const data = await env.GLADOS_DB.get(`USER_${userId}`);
    if (!data) return [];
    let accounts;
    try { accounts = JSON.parse(data); } catch(e) { return []; }
    let changed = false;
    accounts = accounts
        .filter(function(acc) {
            const keep = GLADOS_DOMAINS.includes(acc.domain);
            if (!keep) changed = true;
            return keep;
        })
        .map(function(acc) {
            if (acc.domain !== GLADOS_DOMAIN) { changed = true; return { ...acc, domain: GLADOS_DOMAIN }; }
            return acc;
        });
    // 合并历史数据中同一邮箱的 GLaDOS 多域名重复记录，保留最近一条 Cookie。
    const seen = new Map();
    const normalized = [];
    for (const acc of accounts) {
        const key = acc.email ? 'glados:' + acc.email.trim().toLowerCase() : '';
        if (key && seen.has(key)) {
            normalized[seen.get(key)] = acc;
            changed = true;
        } else {
            if (key) seen.set(key, normalized.length);
            normalized.push(acc);
        }
    }
    if (changed) await env.GLADOS_DB.put(`USER_${userId}`, JSON.stringify(normalized));
    return normalized;
}
async function getPref(userId, env) { const data = await env.GLADOS_DB.get(`PREF_${userId}`); return data ? JSON.parse(data) : { showEmail: false, checkinHour: 12 }; }
// 定时签到仅使用当前 ADMIN_ID；保留这个空操作兼容已有的账号导入调用，
// 不再向 ALL_USERS 写入历史管理员，从源头避免 ADMIN_ID 变更后串号。
async function saveUserIdForCron(userId, env) {}
function escapeHtml(value) {
    return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function maskEmail(email, show) {
    email = String(email || '?');
    if (show) return escapeHtml(email.replace('@', '@\u200b').replace(/\./g, '.\u200b'));
    if (email.includes('@')) {
        let [name, domain] = email.split('@');
        let masked = name.length <= 4 ? name + "****" : name.slice(0, 4) + "********";
        return escapeHtml(`${masked}@\u200b${domain.replace(/\./g, '.\u200b')}`);
    }
    return escapeHtml(email.replace(/\./g, '.\u200b'));
}

// ================= 菜单 UI =================
async function sendMainMenu(chatId, userId, env, messageId = null) {
    const pref = await getPref(userId, env);
    const health = await getHealthSummary(userId, env);
    const text = "🤖 <b>GLaDOS 机场管理助手</b>\n\n" + health + "\n\n请选择操作：";
    const kb = {
        inline_keyboard: [
            [{ text: "👤 1. 账户管理", callback_data: "account_mgr_menu" }],
            [{ text: "📅 2. 签到设置", callback_data: "checkin_menu" }],
            [{ text: "🔄 3. 积分兑换天数", callback_data: "exchange_menu" }],
            [{ text: "🔗 4. 获取订阅配置", callback_data: "sub_menu" }],
            [{ text: `👀 5. 邮箱状态: ${pref.showEmail ? "显示" : "隐藏"}`, callback_data: "toggle_email" }]
        ]
    };
    if (messageId) await tgEdit(chatId, messageId, text, kb, env);
    else await tgSend(chatId, text, env, kb);
}

async function showSiteListMenu(chatId, messageId, userId, env) {
    const kb = [
        [{ text: "🌐 glados", callback_data: 'selsite_0' }],
        [{ text: "🔙 返回上级", callback_data: "account_mgr_menu" }]
    ];
    await tgEdit(chatId, messageId, "🌐 <b>添加 GLaDOS 账号</b>\n\n点击下方按钮，然后发送完整 Cookie（支持一次粘贴多组）：", { inline_keyboard: kb }, env);
}

async function showAccountList(chatId, messageId, userId, action, env) {
    const accounts = await getAccounts(userId, env);
    if (accounts.length === 0) return tgEdit(chatId, messageId, "❌ 您还没添加任何账号！", { inline_keyboard: [[{ text: "🔙 返回", callback_data: "menu_main" }]] }, env);
    
    const titles = { manage: "⚙️ 选择要管理的账号", exchange: "🔄 选择账号兑换积分", sub: "🔗 选择要提取订阅的账号" };
    const pref = await getPref(userId, env);
    let kb = [];
    accounts.forEach((acc, i) => {
        const label = acc.email || acc.username || ('账号-' + (i+1));
        kb.push([{ text: `${i + 1}. ${maskEmail(label, pref.showEmail)}`, callback_data: `sel_${action}_${i}` }]);
    });
    
    if (action === 'manage') {
        kb.push([{ text: "🗑️ 清空账户", callback_data: "clear_all_confirm" }]);
        kb.push([{ text: "🔙 返回上级", callback_data: "account_mgr_menu" }]);
    } else if (action === 'sub') {
        kb.push([{ text: "🔙 返回上级", callback_data: "sub_menu" }]);
    } else if (action === 'exchange') {
        kb.push([{ text: "🔙 返回上级", callback_data: "exchange_menu" }]);
    } else {
        kb.push([{ text: "🔙 返回主菜单", callback_data: "menu_main" }]);
    }
    await tgEdit(chatId, messageId, `<b>${titles[action]}</b>`, { inline_keyboard: kb }, env);
}

async function showExchangePlans(chatId, messageId, index, acc, userId, env) {
    await tgEdit(chatId, messageId, `⏳ 正在获取账户状态，请稍候...`, null, env);
    const pref = await getPref(userId, env);
    const data = await getAccountDataObj(acc, false);

    const kb = {
        inline_keyboard: [
            [{ text: "1. 100积分 兑换 10天", callback_data: `doexch_${index}_plan100` }],
            [{ text: "2. 200积分 兑换 30天", callback_data: `doexch_${index}_plan200` }],
            [{ text: "3. 500积分 兑换 100天", callback_data: `doexch_${index}_plan500` }],
            [{ text: "🔙 取消返回", callback_data: `list_exchange` }]
        ]
    };

    const accInfo = formatAccountString(acc, index + 1, 0, pref, data, false, true).replace(/〰️〰️〰️〰️〰️〰️〰️〰️〰️〰️〰️〰️\n?/g, "");
    await tgSend(chatId, `🔄 <b>单账户积分兑换</b>\n\n${accInfo}\n\n👉 <b>请选择你要兑换的套餐：</b>`, env, kb);
}

async function tgSendResultList(chatId, heading, items, env, keyboard = null) {
    const chunks = [];
    let current = heading;
    for (const item of items) {
        const next = current + '\n\n' + item;
        if (next.length > 3500 && current !== heading) {
            chunks.push(current);
            current = item;
        } else {
            current = next;
        }
    }
    if (current) chunks.push(current);
    for (let i = 0; i < chunks.length; i++) {
        await tgSend(chatId, chunks[i], env, i === chunks.length - 1 ? keyboard : null);
    }
}

async function tgSend(chatId, text, env, keyboard = null) {
    const payload = { chat_id: chatId, text: text, parse_mode: 'HTML', disable_web_page_preview: true };
    if (keyboard) payload.reply_markup = keyboard;
    try { await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/sendMessage`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }); } catch (e) {}
}

async function tgEdit(chatId, msgId, text, keyboard, env) {
    const payload = { chat_id: chatId, message_id: msgId, text: text, parse_mode: 'HTML', disable_web_page_preview: true };
    if (keyboard) payload.reply_markup = keyboard;
    try { await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/editMessageText`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }); } catch (e) {}
}

