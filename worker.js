// _worker.js - Cloudflare Pages 高级模式脚本 (修复多域名签到Token与时区对齐版)

const VIP_MAP = { 0: "Free", 10: "Free", 11: "Edu", 21: "Basic", 31: "Pro", 41: "Team", 51: "Enterprise" };
const LIMIT_MAP = { 0: 10, 10: 10, 11: 100, 21: 200, 31: 500, 41: 2000, 51: 5000 };
const DEFAULT_SITES = ["glados.network", "glados.cloud", "railgun.info", "glados.rocks"];

const HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Content-Type': 'application/json;charset=UTF-8',
    'Accept': 'application/json, text/plain, */*'
};


// ================= NodeLoc 自动阅读模块（v3 - 静默版） =================
const NL_BASE = 'https://www.nodeloc.com';
const NS_BASE = 'https://nodeseek.cc';
const NL_UAS = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0'
];
const NL_TOPICS_PER_RUN = 5;     // 每次 cron 读 5 帖
const NL_REST_CHANCE = 0.15;     // 读完一批后 15% 休息（原油猴 20-40 分钟）
const NL_REST_MIN = 20;           // 最短休息 20 分钟
const NL_REST_MAX = 40;           // 最长休息 40 分钟

function nlSleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function nlRand(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }

// 获取/初始化阅读状态
async function nlGetState(userId, env) {
    const raw = await env.GLADOS_DB.get(`NL_STATE_${userId}`);
    if (raw) return JSON.parse(raw);
    return { date: '', readsToday: 0, readTotal: 0, totalReadTime: 0, restUntil: 0, lastRead: 0, queue: [], cookieError: '' };
}

async function nlSaveState(userId, state, env) {
    await env.GLADOS_DB.put(`NL_STATE_${userId}`, JSON.stringify(state));
}

// 刷新话题队列
async function nlRefreshQueue(baseUrl, cookie) {
    const r = await fetch(baseUrl + '/latest.json?no_definitions=true', {
        headers: { 'User-Agent': NL_UAS[nlRand(0,NL_UAS.length-1)], 'Cookie': cookie, 'Accept': 'application/json' }
    });
    if (!r.ok) throw new Error('获取话题列表失败');
    const d = await r.json();
    const topics = (d.topic_list?.topics || []).filter(t => !t.pinned && t.id);
    return topics.map(t => ({ id: t.id, title: t.title || '话题#'+t.id }));
}

// 模拟阅读一帖（静默，不抛消息）
async function nlReadTopic(baseUrl, cookie, topic) {
    await nlSleep(nlRand(5000, 15000));
    const ua = NL_UAS[nlRand(0, NL_UAS.length-1)];
    const hdrs = {
        'User-Agent': ua,
        'Cookie': cookie,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
        'Referer': baseUrl + '/',
        'Cache-Control': 'no-cache',
        'Pragma': 'no-cache'
    };
    const resp = await fetch(baseUrl + '/t/' + topic.id, { headers: hdrs });
    if (!resp.ok) return { ok: false, cookieError: '', readTime: 0 };

    // 检查 Cookie 是否失效
    if (resp.headers.get('x-discourse-logged-out') === '1') {
        return { ok: false, cookieError: 'Cookie 已失效，请重新添加', readTime: 0 };
    }

    const html = await resp.text();
    // 优先从 HTML meta 提取 CSRF，部分 Discourse 没有则从 /session/csrf API 获取
    let csrf = (html.match(/csrf-token" content="([^"]+)"/) || [])[1];
    if (!csrf) {
        try {
            const csrfResp = await fetch(baseUrl + '/session/csrf', {
                headers: { 'User-Agent': ua, 'Cookie': cookie, 'Accept': 'application/json' }
            });
            if (csrfResp.ok) {
                const csrfData = await csrfResp.json();
                csrf = csrfData.csrf || '';
            }
        } catch(e) {}
    }
    const readTime = nlRand(60000, 120000);
    await nlSleep(readTime);

    if (csrf) {
        try {
            await fetch(baseUrl + '/t/' + topic.id + '/timings', {
                method: 'POST',
                headers: {
                    'User-Agent': ua,
                    'Cookie': cookie,
                    'Content-Type': 'application/json',
                    'X-CSRF-Token': csrf,
                    'Accept': 'application/json, text/javascript, */*; q=0.01',
                    'X-Requested-With': 'XMLHttpRequest',
                    'Referer': baseUrl + '/t/' + topic.id,
                    'Origin': baseUrl
                },
                body: JSON.stringify({ timings: { 1: readTime }, topic_time: readTime })
            });
        } catch(e) {}
    }
    await fetch(baseUrl + '/', { headers: { ...hdrs, 'Referer': baseUrl + '/t/' + topic.id } });
    return { ok: true, cookieError: '', readTime };
}

// 获取今日 NodeLoc 统计
async function nlGetDailyStats(userId, env) {
    try {
        const state = await nlGetState(userId, env);
        const today = new Date().toISOString().slice(0,10);
        const isToday = state.date === today;
        return {
            readsToday: isToday ? state.readsToday : 0,
            readTotal: state.readTotal || 0,
            totalReadTime: Math.round((state.totalReadTime || 0) / 60000), // ms→分钟
            restUntil: (state.restUntil || 0) > Date.now() ? state.restUntil : 0,
            cookieError: state.cookieError || ''
        };
    } catch(e) {
        return { readsToday: 0, readTotal: 0, totalReadTime: 0, restUntil: 0, cookieError: '' };
    }
}

// 获取今日 NodeSeek 统计（复用 Discourse 阅读模块，只是不同 state key）
async function nsGetDailyStats(userId, env) {
    try {
        const state = JSON.parse(await env.GLADOS_DB.get('NS_STATE_' + userId) || '{}');
        const today = new Date().toISOString().slice(0,10);
        const isToday = state.date === today;
        return {
            readsToday: isToday ? state.readsToday : 0,
            readTotal: state.readTotal || 0,
            totalReadTime: Math.round((state.totalReadTime || 0) / 60000),
            restUntil: (state.restUntil || 0) > Date.now() ? state.restUntil : 0,
            cookieError: state.cookieError || ''
        };
    } catch(e) {
        return { readsToday: 0, readTotal: 0, totalReadTime: 0, restUntil: 0, cookieError: '' };
    }
}

// 主入口：每次 cron 触发，静默读多帖
async function runNodelocBatch(userId, cookie, env, baseUrl = NL_BASE) {
    if (!cookie) return;
    try {
        const state = await nlGetState(userId, env);
        const now = Date.now();
        const today = new Date().toISOString().slice(0,10);

        if (state.date !== today) {
            state.date = today;
            state.readsToday = 0;
        }

        // 休息期
        if (state.restUntil > now) return;

        // 按批次读
        let readCount = 0;
        for (let batch = 0; batch < NL_TOPICS_PER_RUN; batch++) {
            // 检查休息（每帖之间也要检查）
            if (state.restUntil > now) break;

            // 确保队列有话题
            if (state.queue.length === 0) {
                const topics = await nlRefreshQueue(baseUrl, cookie);
                if (topics.length === 0) break;
                // shuffle
                for (let i = topics.length - 1; i > 0; i--) {
                    const j = Math.floor(Math.random() * (i + 1));
                    [topics[i], topics[j]] = [topics[j], topics[i]];
                }
                state.queue = topics;
            }

            const topic = state.queue.shift();
            const result = await nlReadTopic(baseUrl, cookie, topic);
            if (!result.ok) {
                if (result.cookieError) state.cookieError = result.cookieError;
                break;
            }
            state.readsToday++;
            state.readTotal = (state.readTotal || 0) + 1;
            state.totalReadTime = (state.totalReadTime || 0) + result.readTime;
            state.lastRead = now;
            state.cookieError = '';
            readCount++;

            // 每帖后 12% 概率休息
            if (Math.random() < NL_REST_CHANCE) {
                state.restUntil = now + nlRand(NL_REST_MIN, NL_REST_MAX) * 60000;
                break;
            }
        }

        if (readCount > 0) await nlSaveState(userId, state, env);
    } catch(e) {
        // 静默失败，不影响签到
    }
}
// ================= End NodeLoc Module =================








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
        
        if (url.pathname === '/setup') {
            if (!env.BOT_TOKEN) return new Response('请先配置 BOT_TOKEN');
            const webhookUrl = `https://${url.hostname}/webhook`;
            await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/setWebhook?url=${webhookUrl}`);
            const commands = [{ command: "start", description: "启动/重置机器人菜单" }];
            const tgData = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/setMyCommands`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ commands })
            }).then(r => r.json());

            return new Response(JSON.stringify(tgData), { headers: { 'Content-Type': 'application/json' } });
        }
        
        if (url.pathname === '/debug') {
            const diag = {
                hasKV: typeof env.GLADOS_DB !== 'undefined',
                hasAdminID: typeof env.ADMIN_ID !== 'undefined',
                hasBotToken: typeof env.BOT_TOKEN !== 'undefined'
            };
            return new Response(JSON.stringify(diag, null, 2), { headers: { 'Content-Type': 'application/json' } });
        }
        // 根路径：自动激活 Webhook + 显示状态
        const setupResult = { webhook: false, commands: false };
        if (env.BOT_TOKEN) {
            try {
                const wh = `${url.protocol}//${url.hostname}/webhook`;
                const r1 = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/setWebhook?url=${wh}`);
                setupResult.webhook = (await r1.json()).ok === true;
                const commands = [{ command: "start", description: "启动/重置机器人菜单" }];
                const r2 = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/setMyCommands`, {
                    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ commands })
                });
                setupResult.commands = (await r2.json()).ok === true;
            } catch (e) { setupResult.error = e.message; }
        }
        return new Response(JSON.stringify({
            status: 'running',
            message: 'GLaDOS Bot 链式驱动引擎正常运行中。',
            webhook: setupResult.webhook ? '✅ 已激活' : '❌ 未激活（请配置 BOT_TOKEN）',
            commands: setupResult.commands ? '✅ 已注册' : '⚠️ 未注册',
            note: '发送 /start 开始使用'
        }, null, 2), { headers: { 'Content-Type': 'application/json; charset=utf-8' } });
    },

    async scheduled(event, env, ctx) {
        ctx.waitUntil(handleScheduled(env));
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
        await sendMainMenu(chatId, userId, env);
        return;
    }

    const state = await env.GLADOS_DB.get(`STATE_${userId}`);
    if (state === 'AWAITING_ACCOUNT_INFO') await processAddAccountInfo(chatId, userId, text, env);
    else if (state === 'AWAITING_NODELOC_COOKIE') await processAddAccountInfo(chatId, userId, text, env);
    else if (state === 'AWAITING_UPDATE_COOKIE') await processUpdateCookie(chatId, userId, text, env);
    else if (state === 'AWAITING_CRON_TIME') await processCronTime(chatId, userId, text, env);
    else if (state === 'AWAITING_NEW_SITE') await processNewSite(chatId, userId, text, env);
    else if (state === 'AWAITING_DELETE_SITE') await processDeleteSite(chatId, userId, text, env);
    else await sendMainMenu(chatId, userId, env);
}

async function handleCallback(callbackQuery, env, origin) {
    const chatId = callbackQuery.message.chat.id;
    const messageId = callbackQuery.message.message_id;
    const userId = String(callbackQuery.from.id);
    const data = callbackQuery.data;

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
        if (accounts.length === 0) return tgSend(chatId, "❌ 您还没添加任何账号。", env);
        await tgEdit(chatId, messageId, "⏳ <b>正在获取全部账户信息...</b>\n\n<i>(系统将全自动查询，请稍候)</i>", null, env);
        await executeTask({ type: 'view_all', chatId, userId, startIndex: 0, plan: null, successList: [] }, env, origin);
    }
    // --- 单个账户管理 ---
    else if (data === 'list_manage') {
        const accounts = await getAccounts(userId, env);
        if (accounts.length === 0) return tgSend(chatId, "❌ 您还没添加任何账号。", env);
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
        if (accounts.length === 0) return tgSend(chatId, "❌ 您还没添加任何账号。", env);
        
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
        if (accounts.length === 0) return tgSend(chatId, "❌ 您还没添加任何账号。", env);
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
        if (accounts.length === 0) return tgSend(chatId, "❌ 您还没添加任何账号。", env);
        await tgEdit(chatId, messageId, "⏳ <b>正在执行统一批量签到...</b>", null, env);
        await executeTask({ type: 'checkin', chatId, userId, startIndex: 0, plan: null, successList: [] }, env, origin);
    }
    else if (data === 'set_cron_time') {
        await env.GLADOS_DB.put(`STATE_${userId}`, 'AWAITING_CRON_TIME', { expirationTtl: 120 });
        await tgSend(chatId, "⏰ <b>请回复数字 (0-23)</b>\n\n⚠️ 必须为整点！\n例如输入 <code>12</code> 代表每天中午 12:00 左右签到\n<i>(系统具有±10分钟容错，防止漏签)</i>", env);
    }
    // --- 其他辅助 ---
    else if (data === 'add_account') {
        await showSiteListMenu(chatId, messageId, userId, env);
    }
    else if (data === 'site_mgr') {
        const kb = {
            inline_keyboard: [
                [{ text: "➕ 新增网站", callback_data: "site_add" }],
                [{ text: "🗑️ 删除网站", callback_data: "site_del_menu" }],
                [{ text: "🔙 返回上级", callback_data: "add_account" }]
            ]
        };
        await tgEdit(chatId, messageId, "🔧 <b>自定义网站管理</b>\n\n请选择您要进行的操作：", kb, env);
    }
    else if (data === 'site_add') {
        await env.GLADOS_DB.put(`STATE_${userId}`, 'AWAITING_NEW_SITE', { expirationTtl: 120 });
        await tgSend(chatId, "🌐 <b>请输入新增的网址</b>\n\n例如：<code>https://glados.network</code>", env);
    }
    else if (data === 'site_del_menu') {
        const customSites = await getCustomSites(userId, env);
        if (customSites.length === 0) {
            return tgSend(chatId, "❌ 您还没有添加任何自定义网站。", env);
        }
        let msg = "🗑️ <b>请回复要删除的网站序号：</b>\n\n";
        customSites.forEach((site, i) => msg += `${i + 1}. <code>${site}</code>\n`);
        
        await env.GLADOS_DB.put(`STATE_${userId}`, 'AWAITING_DELETE_SITE', { expirationTtl: 120 });
        await tgSend(chatId, msg, env);
    }
    else if (data.startsWith('selsite_')) {
        const index = parseInt(data.split('_')[1]);
        const customSites = await getCustomSites(userId, env);
        const allSites = [...DEFAULT_SITES, ...customSites];
        const selectedSite = allSites[index];

        if (!selectedSite) return tgSend(chatId, "❌ 站点异常", env);

        await env.GLADOS_DB.put(`STATE_${userId}`, 'AWAITING_ACCOUNT_INFO', { expirationTtl: 300 });
        await env.GLADOS_DB.put(`TEMP_${userId}`, selectedSite, { expirationTtl: 300 });
        const msg = `📝 您选择了站点: <b>${selectedSite}</b>\n\n<b>请发送账号信息</b>\n(支持多行，全局根据邮箱强制覆盖去重)，格式：\n<code>邮箱:cookie</code>`;
        await tgSend(chatId, msg, env);
    }
    else if (data === 'clear_all_confirm') {
        const kb = { inline_keyboard: [[{ text: "⚠️ 确认清空 (不可恢复)", callback_data: "clear_all_yes" }], [{ text: "🔙 取消返回", callback_data: "list_manage" }]] };
        await tgEdit(chatId, messageId, "🗑️ <b>危险操作</b>\n\n确定要清空数据库中的所有账号吗？", kb, env);
    }
    else if (data === 'clear_all_yes') {
        await env.GLADOS_DB.put(`USER_${userId}`, JSON.stringify([]));
        await env.GLADOS_DB.delete('NL_STATE_' + userId);
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
        
        if (!acc) return tgSend(chatId, "❌ 找不到该账号", env);

        if (action === 'manage') {
            const kb = {
                inline_keyboard: [
                    [{ text: "👁️ 查看此账户信息", callback_data: `view_acc_${index}` }, { text: "✅ 立即单独签到", callback_data: `chk_acc_${index}` }],
                    [{ text: "🔁 更新 Cookies", callback_data: `upd_acc_${index}` }, { text: "❌ 删除此账户", callback_data: `del_acc_${index}` }],
                    [{ text: "🔙 返回账号列表", callback_data: "list_manage" }]
                ]
            };
            await tgEdit(chatId, messageId, `⚙️ <b>管理账户</b>\n\n当前账户：<code>${maskEmail(acc.email, pref.showEmail)}</code>\n所属站点：<code>${acc.domain}</code>\n\n请选择操作：`, kb, env);
        } else if (action === 'exchange') {
            await showExchangePlans(chatId, messageId, index, acc, userId, env);
        } else if (action === 'sub') {
            await tgSend(chatId, `🔗 正在获取 <code>${maskEmail(acc.email, pref.showEmail)}</code> 的订阅，请稍候...`, env);
            const subData = await getSubAndHost(acc.domain, acc.cookie);
            await tgSend(chatId, subData, env);
        }
    }
    else if (data.startsWith('view_acc_')) {
        const index = parseInt(data.split('_')[2]);
        const accounts = await getAccounts(userId, env);
        const acc = accounts[index];
        if (!acc) return tgSend(chatId, "❌ 账号不存在", env);
        
        if (acc.domain === 'nodeloc.com') {
            const pref = await getPref(userId, env);
            const st = await env.GLADOS_DB.get('NL_STATE_' + userId, 'json') || { readsToday: 0 };
            return tgSend(chatId, `🌐 <b>NodeLoc 自动阅读</b>\n\n👤 账号: ${maskEmail(acc.email, pref.showEmail)}\n📊 今日已读: ${st.readsToday || 0} 帖`, env);
        }
        if (acc.domain === 'nodeseek.cc') {
            const pref = await getPref(userId, env);
            const st = await env.GLADOS_DB.get('NS_STATE_' + userId, 'json') || { readsToday: 0 };
            return tgSend(chatId, `🔹 <b>NodeSeek 自动阅读</b>\n\n👤 账号: ${acc.username || 'NodeSeek'}\n📊 今日已读: ${st.readsToday || 0} 帖`, env);
        }
        
        await tgSend(chatId, "⏳ 正在拉取该账号信息...", env);
        const pref = await getPref(userId, env);
        const accData = await getAccountDataObj(acc, false);
        const msgStr = formatAccountString(acc, index + 1, accounts.length, pref, accData, true, true);
        await tgSend(chatId, msgStr, env);
    }
    else if (data.startsWith('chk_acc_')) {
        const index = parseInt(data.split('_')[2]);
        const accounts = await getAccounts(userId, env);
        const acc = accounts[index];
        if (!acc) return tgSend(chatId, "❌ 账号不存在", env);
        
        if (acc.domain === 'nodeloc.com') {
            return tgSend(chatId, "❌ NodeLoc 账号无法单独签到，自动阅读由定时任务执行。", env);
        }
        if (acc.domain === 'nodeseek.cc') {
            return tgSend(chatId, "❌ NodeSeek 账号无法单独签到，自动阅读由定时任务执行。", env);
        }
        await tgSend(chatId, "⏳ 正在为您单独执行签到，请稍候...", env);
        const pref = await getPref(userId, env);
        const accData = await getAccountDataObj(acc, true); // true 代表触发签到
        const msgStr = formatAccountString(acc, index + 1, accounts.length, pref, accData, true, true);
        await tgSend(chatId, msgStr, env);
    }
    else if (data.startsWith('del_acc_')) {
        const index = parseInt(data.split('_')[2]);
        let accounts = await getAccounts(userId, env);
        if (!accounts[index]) return tgSend(chatId, "❌ 账号不存在", env);
        const deletedEmail = accounts[index].email;
        accounts.splice(index, 1);
        await env.GLADOS_DB.put(`USER_${userId}`, JSON.stringify(accounts));
        if (acc.domain === 'nodeloc.com') await env.GLADOS_DB.delete('NL_STATE_' + userId);
        if (acc.domain === 'nodeseek.cc') await env.GLADOS_DB.delete('NS_STATE_' + userId);
        const pref = await getPref(userId, env);
        await tgEdit(chatId, messageId, `✅ 已成功删除账号：<code>${maskEmail(deletedEmail, pref.showEmail)}</code>`, { inline_keyboard: [[{ text: "🔙 返回账户管理", callback_data: "list_manage" }]] }, env);
    }
    else if (data.startsWith('upd_acc_')) {
        const index = parseInt(data.split('_')[2]);
        await env.GLADOS_DB.put(`STATE_${userId}`, 'AWAITING_UPDATE_COOKIE', { expirationTtl: 300 });
        await env.GLADOS_DB.put(`TEMP_${userId}`, index.toString(), { expirationTtl: 300 });
        await tgSend(chatId, `🔁 <b>请直接回复新的 Cookie 内容：</b>`, env);
    }
    else if (data === 'add_nodeloc') {
        await env.GLADOS_DB.put(`STATE_${userId}`, 'AWAITING_NODELOC_COOKIE', { expirationTtl: 300 });
        await env.GLADOS_DB.put(`TEMP_${userId}`, 'nodeloc.com', { expirationTtl: 300 });
        await tgSend(chatId, "🌐 <b>绑定 NodeLoc 账号</b>\n\n直接发送 Cookie 即可，无需加任何前缀或名称。", env);
    }
    else if (data === 'add_nodeseek') {
        await env.GLADOS_DB.put(`STATE_${userId}`, 'AWAITING_NODESEEK_COOKIE', { expirationTtl: 300 });
        await env.GLADOS_DB.put(`TEMP_${userId}`, 'nodeseek.cc', { expirationTtl: 300 });
        await tgSend(chatId, "🔹 <b>绑定 NodeSeek 账号</b>\n\n直接发送 Cookie 即可，无需名称。\n\n格式：<code>_forum_session=xxx; _t=yyy</code>\n\n💡 先登录 NodeSeek，浏览器 F12 → Application → Cookies → 复制 <code>_forum_session</code> 和 <code>_t</code> 的值。", env);
    }
    else if (data.startsWith('doexch_')) {
        const parts = data.split('_');
        const index = parseInt(parts[1]);
        const plan = parts[2];
        const accounts = await getAccounts(userId, env);
        const acc = accounts[index];
        const pref = await getPref(userId, env);
        
        await tgSend(chatId, `⏳ 正在为您兑换套餐，请稍候...`, env);
        const result = await safeFetchJson(`https://${acc.domain}/api/user/exchange`, {
            method: 'POST', headers: { ...HEADERS, 'cookie': acc.cookie, 'origin': `https://${acc.domain}` },
            body: JSON.stringify({ planType: plan })
        });
        
        const accData = await getAccountDataObj(acc, false); 
        accData.statusMsg = (result && result.message) ? `✅ ${result.message}` : '✅ 兑换操作完成';
        const msgStr = formatAccountString(acc, index + 1, accounts.length, pref, accData, true, false);
        await tgSend(chatId, msgStr, env);
    }
}

// ================= 输入消息逻辑处理 =================
async function processAddAccountInfo(chatId, userId, text, env) {
    const state = await env.GLADOS_DB.get(`STATE_${userId}`);
    const domain = await env.GLADOS_DB.get(`TEMP_${userId}`);
    await env.GLADOS_DB.delete(`STATE_${userId}`);
    await env.GLADOS_DB.delete(`TEMP_${userId}`);
    if (!domain) return tgSend(chatId, "❌ 会话过期，请重新选择站点。", env);

    // NodeLoc: 格式是 名称:cookie
    if (state === 'AWAITING_NODELOC_COOKIE') {
        let cookie = text.trim();
        let name = cookie;
        const colonIdx = cookie.indexOf(':');
        if (colonIdx > 0 && cookie.indexOf('=') > colonIdx) {
            name = cookie.substring(0, colonIdx);
            cookie = cookie.substring(colonIdx + 1);
        } else {
            name = 'nodeloc';
        }
        let accounts = await getAccounts(userId, env);
        accounts = accounts.filter(a => a.domain !== 'nodeloc.com');
        accounts.push({ email: name, domain: 'nodeloc.com', cookie: cookie });
        await env.GLADOS_DB.put(`USER_${userId}`, JSON.stringify(accounts));
        await saveUserIdForCron(userId, env);
        const total = accounts.length;
        const nlTotal = accounts.filter(a => a.domain === 'nodeloc.com').length;
        await tgSend(chatId, `✅ <b>NodeLoc 绑定成功！</b>\n\n👤 账号: <code>${name}</code>\n🌐 NodeLoc 账号: ${nlTotal} 个\n📦 当前总账号数: ${total} 个`, env);
        return;
    }

    // NodeSeek: 格式是 名称:cookie（cookie 格式：_forum_session=xxx; _t=yyy）
    if (state === 'AWAITING_NODESEEK_COOKIE') {
        let cookie = text.trim();
        let name = cookie;
        const colonIdx = cookie.indexOf(':');
        if (colonIdx > 0 && cookie.indexOf('=') > colonIdx) {
            name = cookie.substring(0, colonIdx);
            cookie = cookie.substring(colonIdx + 1);
        } else {
            name = 'nodeseek';
        }
        // 验证 cookie 是否包含必要字段
        if (!/_forum_session=/.test(cookie)) {
            await tgSend(chatId, "❌ Cookie 格式错误！需要包含 <code>_forum_session</code>。\n\n完整格式：<code>名称:_forum_session=xxx; _t=yyy</code>", env);
            return;
        }
        let accounts = await getAccounts(userId, env);
        accounts = accounts.filter(a => a.domain !== 'nodeseek.cc');
        accounts.push({ username: name, domain: 'nodeseek.cc', cookie: cookie });
        await env.GLADOS_DB.put(`USER_${userId}`, JSON.stringify(accounts));
        await saveUserIdForCron(userId, env);
        const total = accounts.length;
        const nsTotal = accounts.filter(a => a.domain === 'nodeseek.cc').length;
        await tgSend(chatId, `✅ <b>NodeSeek 绑定成功！</b>\n\n👤 账号: <code>${name}</code>\n🔹 NodeSeek 账号: ${nsTotal} 个\n📦 当前总账号数: ${total} 个\n\n⏰ 自动阅读将在下次整点 cron 开始。`, env);
        return;
    }

    const lines = text.split('\n');
    let accounts = await getAccounts(userId, env);
    let accMap = new Map();
    accounts.forEach(acc => accMap.set(acc.email.trim().toLowerCase(), acc));

    let added = 0, updated = 0;
    for (let line of lines) {
        const parts = line.trim().split(':');
        if (parts.length >= 2) {
            const email = parts[0].trim();
            const emailKey = email.toLowerCase();
            const cookie = parts.slice(1).join(':').trim();
            
            if (accMap.has(emailKey)) updated++;
            else added++;
            
            accMap.set(emailKey, { domain, email, cookie });
        }
    }

    accounts = Array.from(accMap.values());
    await env.GLADOS_DB.put(`USER_${userId}`, JSON.stringify(accounts));
    await saveUserIdForCron(userId, env);

    let resultMsg = `✅ <b>导入完毕！(全局防重生效)</b>\n\n➕ 新增账号: ${added} 个\n🔁 覆盖更新: ${updated} 个\n📦 当前总账号数: ${accounts.length} 个`;
    await tgSend(chatId, resultMsg, env);
    await tgSend(chatId, "👇", env, { inline_keyboard: [[{ text: "🔙 返回主菜单", callback_data: "menu_main" }]] });
}

async function processUpdateCookie(chatId, userId, text, env) {
    const indexStr = await env.GLADOS_DB.get(`TEMP_${userId}`);
    await env.GLADOS_DB.delete(`STATE_${userId}`);
    await env.GLADOS_DB.delete(`TEMP_${userId}`);

    if (!indexStr) return tgSend(chatId, "❌ 会话过期。", env);
    const index = parseInt(indexStr);
    const accounts = await getAccounts(userId, env);
    if (!accounts[index]) return tgSend(chatId, "❌ 账号不存在", env);
    
    accounts[index].cookie = text.trim();
    await env.GLADOS_DB.put(`USER_${userId}`, JSON.stringify(accounts));
    await tgSend(chatId, "✅ Cookie 更新成功！正在为您验证签到状态...", env);
    
    const pref = await getPref(userId, env);
    const data = await getAccountDataObj(accounts[index], true);
    const msgStr = formatAccountString(accounts[index], index + 1, accounts.length, pref, data, true, true);
    await tgSend(chatId, msgStr, env, { inline_keyboard: [[{ text: "🔙 返回账户管理", callback_data: "list_manage" }]] });
}

async function processNewSite(chatId, userId, text, env) {
    await env.GLADOS_DB.delete(`STATE_${userId}`);
    let newSite = text.trim();
    if (newSite.startsWith('http')) {
        try { newSite = new URL(newSite).hostname; } catch (e) { newSite = newSite.replace(/^https?:\/\//, '').split('/')[0]; }
    } else { newSite = newSite.split('/')[0]; }

    const customSites = await getCustomSites(userId, env);
    if (!customSites.includes(newSite) && !DEFAULT_SITES.includes(newSite)) {
        customSites.push(newSite);
        await env.GLADOS_DB.put(`SITES_${userId}`, JSON.stringify(customSites));
    }
    await tgSend(chatId, `✅ 自定义站点 <code>${newSite}</code> 添加成功！`, env);
    await showSiteListMenu(chatId, null, userId, env);
}

async function processDeleteSite(chatId, userId, text, env) {
    await env.GLADOS_DB.delete(`STATE_${userId}`);
    const index = parseInt(text.trim()) - 1;
    const customSites = await getCustomSites(userId, env);

    if (isNaN(index) || index < 0 || index >= customSites.length) return tgSend(chatId, "❌ 输入序号无效。", env);
    const deleted = customSites.splice(index, 1);
    await env.GLADOS_DB.put(`SITES_${userId}`, JSON.stringify(customSites));
    await tgSend(chatId, `✅ 已删除站点 <code>${deleted[0]}</code>`, env);
    await showSiteListMenu(chatId, null, userId, env);
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
    const { type, chatId, userId, startIndex, plan, successList = [] } = task;
    const accounts = await getAccounts(userId, env);
    const pref = await getPref(userId, env);
    
    const batchSize = 6;
    const endIndex = Math.min(startIndex + batchSize, accounts.length);
    
    let msgs = [];
    let newSuccessList = [...successList];

    for (let i = startIndex; i < endIndex; i++) {
        const acc = accounts[i];
        
        if (type === 'checkin' || type === 'view_all') {
            if (acc.domain === 'nodeloc.com') {
                if (type === 'view_all') {
                    const s = await nlGetDailyStats(userId, env);
                    let nlInfo = `├ 🌐 NodeLoc 自动阅读\n├ 📝 今日已读 ${s.readsToday} 帖`;
                    if (s.totalReadTime > 0) nlInfo += `\n├ ⏱ 累计阅读 ${s.totalReadTime} 分钟`;
                    if (s.readTotal > 0) nlInfo += `\n├ 📚 累计阅读 ${s.readTotal} 帖`;
                    if (s.restUntil > 0) {
                        const mins = Math.ceil((s.restUntil - Date.now()) / 60000);
                        nlInfo += `\n├ 💤 休息中（剩余 ${mins} 分钟）`;
                    }
                    if (s.cookieError) {
                        nlInfo += `\n├ ❌ ${s.cookieError}`;
                    }
                    msgs.push(`〰️〰️〰️〰️〰️〰️〰️〰️〰️〰️〰️〰️\n[${i+1}/${accounts.length}] 👤 ${maskEmail(acc.email, pref.showEmail)}\n${nlInfo}`);
                }
                continue;
            }
            if (acc.domain === 'nodeseek.cc') {
                if (type === 'view_all') {
                    const s = await nsGetDailyStats(userId, env);
                    let nsInfo = `├ 🔹 NodeSeek 自动阅读\n├ 📝 今日已读 ${s.readsToday} 帖`;
                    if (s.totalReadTime > 0) nsInfo += `\n├ ⏱ 累计阅读 ${s.totalReadTime} 分钟`;
                    if (s.readTotal > 0) nsInfo += `\n├ 📚 累计阅读 ${s.readTotal} 帖`;
                    if (s.restUntil > 0) {
                        const mins = Math.ceil((s.restUntil - Date.now()) / 60000);
                        nsInfo += `\n├ 💤 休息中（剩余 ${mins} 分钟）`;
                    }
                    if (s.cookieError) {
                        nsInfo += `\n├ ❌ ${s.cookieError}`;
                    }
                    msgs.push(`〰️〰️〰️〰️〰️〰️〰️〰️〰️〰️〰️〰️\n[${i+1}/${accounts.length}] 👤 ${maskEmail(acc.username || acc.email, pref.showEmail)}\n${nsInfo}`);
                }
                continue;
            }
            const doCheckin = (type === 'checkin');
            const data = await getAccountDataObj(acc, doCheckin);
            msgs.push(formatAccountString(acc, i + 1, accounts.length, pref, data, true, false));
        } 
        else if (type === 'batch_exchange') {
            if (acc.domain === 'nodeloc.com' || acc.domain === 'nodeseek.cc') continue;
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
            if (acc.domain === 'nodeloc.com' || acc.domain === 'nodeseek.cc') continue;
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

    if ((type === 'checkin' || type === 'view_all' || type === 'sub_all') && msgs.length > 0 && chatId) {
        await tgSend(chatId, msgs.join("\n"), env);
    }

    if (endIndex < accounts.length) {
        await executeTask({ type, chatId, userId, startIndex: endIndex, plan, successList: newSuccessList }, env, origin);
    } else {
        if (chatId) {
            const doneKb = { inline_keyboard: [[{ text: "🔙 返回主菜单", callback_data: "menu_main" }]] };
            if (type === 'checkin' || type === 'view_all') {
                const actName = type === 'checkin' ? "签到" : "查询";
                await tgSend(chatId, `✅ <b>全部 ${accounts.length} 个账号${actName}处理完毕！</b>`, env, doneKb);
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
async function handleScheduled(env) {
    let usersList = await env.GLADOS_DB.get("ALL_USERS");
    if (!usersList) return;
    usersList = JSON.parse(usersList);

    const bjDate = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Shanghai" }));
    const h = bjDate.getHours();
    const m = bjDate.getMinutes();

    for (let userId of usersList) {
        const pref = await getPref(userId, env);
        const target = pref.checkinHour;
        let isTrigger = false;
        if (h === target && m <= 10) isTrigger = true;
        if (h === (target - 1 + 24) % 24 && m >= 50) isTrigger = true;

        const accounts = await getAccounts(userId, env);
        if (isTrigger) {
            let nlAcc = null;
            for (let acc of accounts) {
                if (acc.domain === 'nodeloc.com') { nlAcc = acc; continue; }
                const reqOpts = { headers: { ...HEADERS, 'cookie': acc.cookie, 'origin': `https://${acc.domain}` } };
                await safeFetchJson(`https://${acc.domain}/api/user/checkin`, {
                    ...reqOpts, method: 'POST', body: JSON.stringify({ token: acc.domain })
                });
                await new Promise(r => setTimeout(r, 600));
            }
            const gladosCount = accounts.filter(a => a.domain !== 'nodeloc.com' && a.domain !== 'nodeseek.cc').length;
            const nlStats = await nlGetDailyStats(userId, env);
            const nsStats = await nsGetDailyStats(userId, env);
            let extraLine = '';
            if (nlStats.readsToday > 0) {
                extraLine += `\n🌐 NodeLoc 今日已阅读 ${nlStats.readsToday} 帖`;
                if (nlStats.totalReadTime > 0) extraLine += `（${nlStats.totalReadTime} 分钟）`;
            }
            if (nlStats.cookieError) {
                extraLine += `\n⚠️ NodeLoc: ${nlStats.cookieError}`;
            }
            if (nsStats.readsToday > 0) {
                extraLine += `\n🔹 NodeSeek 今日已阅读 ${nsStats.readsToday} 帖`;
                if (nsStats.totalReadTime > 0) extraLine += `（${nsStats.totalReadTime} 分钟）`;
            }
            if (nsStats.cookieError) {
                extraLine += `\n⚠️ NodeSeek: ${nsStats.cookieError}`;
            }
            await tgSend(userId, `⏰ <b>定时签到自动完成</b>\n已在后台成功向 ${gladosCount} 个账号发送了签到指令。${extraLine}`, env);
        }
        // NodeLoc 静默阅读（每次 cron 触发都跑，独立于签到）
        const nlAcc = accounts.find(a => a.domain === 'nodeloc.com' && a.cookie);
        if (nlAcc) {
            try {
                await runNodelocBatch(userId, nlAcc.cookie, env);
            } catch(e) {}
        }
        // NodeSeek 静默阅读（每次 cron 触发都跑，独立于签到）
        const nsAcc = accounts.find(a => a.domain === 'nodeseek.cc' && a.cookie);
        if (nsAcc) {
            try {
                await runNodelocBatch(userId, nsAcc.cookie, env, NS_BASE);
            } catch(e) {}
        }
    }
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
        const reqOpts = { headers: { ...HEADERS, 'cookie': cookie, 'origin': `https://${domain}` } };
        
        // 1. 优先尝试拦截 302 真实重定向接口 (完美应对部分隐藏站)
        try {
            const redirectRes = await fetch(`https://${domain}/api/listen/mihomo`, {
                headers: reqOpts.headers,
                redirect: 'manual' 
            });
            if (redirectRes.status >= 300 && redirectRes.status < 400) {
                const loc = redirectRes.headers.get('Location');
                if (loc && (loc.includes('update.glados-config') || loc.includes('update.'))) {
                    subLink = loc;
                }
            }
        } catch(e) {}

        // 2. 如果拦截失败，回退使用 status 接口解析
        if (!subLink) {
            const statusRes = await safeFetchJson(`https://${domain}/api/user/status`, reqOpts);
            if (statusRes && statusRes.code === 0 && statusRes.data) {
                if (statusRes.data.subscriptions && statusRes.data.subscriptions.mihomo) {
                    subLink = statusRes.data.subscriptions.mihomo;
                } else if (statusRes.data.subscriptions && statusRes.data.subscriptions.clash) {
                    subLink = statusRes.data.subscriptions.clash;
                } 
                else {
                    const userId = statusRes.data.userId || statusRes.data.configureId;
                    const code = statusRes.data.code;
                    const port = statusRes.data.port;
                    if (userId && code && port) {
                        subLink = `https://update.glados-config.com/mihomo/${userId}/${code}/${port}/glados.yaml`;
                    }
                }
            }
        }

        if (!subLink) {
            return returnRaw ? null : `❌ <b>提取失败：无法获取账号状态</b>\n(提示：您的 Cookie 可能已失效，或 <code>${domain}</code> 接口访问受限)`;
        }

        if (subLink.includes('xxxx')) {
            const errMsg = `❌ <b>提取失败：该账号订阅配置已被官方屏蔽隐藏 (xxxx)</b>\n\n原因：账号状态受限，或作为新账号从未激活过订阅。\n\n👉 <b>解决办法：</b>\n请在浏览器登录 <code>${domain}</code>，进入【控制台】-【订阅管理】-【FLClash】页面强制激活一次即可恢复。`;
            return returnRaw ? subLink : errMsg;
        }

        if (returnRaw) return subLink;

        return `<b>✅ 获取成功</b>\n\n<b>Mihomo / Clash 订阅：</b>\n<code>${subLink}</code>`;
    } catch (e) {
        return returnRaw ? null : "❌ 提取失败：网络超时或发生系统异常。";
    }
}

async function getAccountDataObj(acc, doCheckin = false) {
    const reqOpts = { headers: { ...HEADERS, 'cookie': acc.cookie, 'origin': `https://${acc.domain}` } };
    let data = {
        statusMsg: "❌ 获取超时或受限", trafficStr: "获取失败", medal: "🪙", 
        pointsStr: "0", timeLeft: "0", planStr: "未知"
    };

    try {
        let checkinRes = null;
        if (doCheckin) {
            checkinRes = await safeFetchJson(`https://${acc.domain}/api/user/checkin`, { 
                ...reqOpts, method: 'POST', body: JSON.stringify({ token: acc.domain }) 
            });
        }

        let statusRes = await safeFetchJson(`https://${acc.domain}/api/user/status`, reqOpts);
        let trafficRes = await safeFetchJson(`https://${acc.domain}/api/user/traffic`, reqOpts);
        let pointsRes = await safeFetchJson(`https://${acc.domain}/api/user/points`, reqOpts);

        if (statusRes && statusRes.code === 0 && statusRes.data) {
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
    str += ` ├ 🌐 站点: ${acc.domain.replace(/\./g, '.\u200b')}\n`;
    if (includeStatus) str += ` ├ 📝 状态: ${data.statusMsg}\n`;
    str += ` ├ 📊 流量: ${data.trafficStr}\n`;
    str += ` ├ ${data.medal} 积分: ${data.pointsStr}\n`;
    str += ` ├ ⏳ 剩余: ${data.timeLeft} 天 (${data.planStr})`;
    if (!isSingle) str += `\n〰️〰️〰️〰️〰️〰️〰️〰️〰️〰️〰️〰️`;
    return str;
}


// ================= 数据存取辅助 =================
async function getAccounts(userId, env) { const data = await env.GLADOS_DB.get(`USER_${userId}`); return data ? JSON.parse(data) : []; }
async function getPref(userId, env) { const data = await env.GLADOS_DB.get(`PREF_${userId}`); return data ? JSON.parse(data) : { showEmail: false, checkinHour: 12 }; }
async function getCustomSites(userId, env) { const data = await env.GLADOS_DB.get(`SITES_${userId}`); return data ? JSON.parse(data) : []; }
async function saveUserIdForCron(userId, env) {
    let usersList = await env.GLADOS_DB.get("ALL_USERS");
    usersList = usersList ? JSON.parse(usersList) : [];
    if (!usersList.includes(userId)) { usersList.push(userId); await env.GLADOS_DB.put("ALL_USERS", JSON.stringify(usersList)); }
}
function maskEmail(email, show) {
    if (show) return email.replace('@', '@\u200b').replace(/\./g, '.\u200b');
    if (email.includes('@')) {
        let [name, domain] = email.split('@');
        let masked = name.length <= 4 ? name + "****" : name.slice(0, 4) + "********";
        return `${masked}@\u200b${domain.replace(/\./g, '.\u200b')}`;
    }
    return email.replace(/\./g, '.\u200b');
}

// ================= 菜单 UI =================
async function sendMainMenu(chatId, userId, env, messageId = null) {
    const pref = await getPref(userId, env);
    const text = "🤖 <b>GLaDOS 机场管理助手</b>\n\n请选择操作：";
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
    const customSites = await getCustomSites(userId, env);
    const allSites = [...DEFAULT_SITES, ...customSites];
    let kb = [];
    allSites.forEach((site, index) => kb.push([{ text: `🌐 ${site}`, callback_data: `selsite_${index}` }]));
    kb.push([{ text: "🌐 NodeLoc 自动阅读", callback_data: "add_nodeloc" }]);
    kb.push([{ text: "🔹 NodeSeek 自动阅读", callback_data: "add_nodeseek" }]);
    kb.push([{ text: "🔧 自定义网站管理", callback_data: "site_mgr" }]);
    kb.push([{ text: "🔙 返回上级", callback_data: "account_mgr_menu" }]);
    await tgEdit(chatId, messageId, "🌐 <b>选择要添加账号的站点</b>\n\n点击下方站点按钮，或者进入自定义管理：", { inline_keyboard: kb }, env);
}

async function showAccountList(chatId, messageId, userId, action, env) {
    const accounts = await getAccounts(userId, env);
    if (accounts.length === 0) return tgEdit(chatId, messageId, "❌ 您还没添加任何账号！", { inline_keyboard: [[{ text: "🔙 返回", callback_data: "menu_main" }]] }, env);
    
    const titles = { manage: "⚙️ 选择要管理的账号", exchange: "🔄 选择账号兑换积分", sub: "🔗 选择要提取订阅的账号" };
    const pref = await getPref(userId, env);
    let kb = [];
    accounts.forEach((acc, i) => kb.push([{ text: `${i + 1}. ${maskEmail(acc.email, pref.showEmail)}`, callback_data: `sel_${action}_${i}` }]));
    
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

