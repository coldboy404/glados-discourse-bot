// GLaDOS / NodeLoc / NodeSeek 多站自动签到 Bot

const VIP_MAP = { 0: "Free", 10: "Free", 11: "Edu", 21: "Basic", 31: "Pro", 41: "Team", 51: "Enterprise" };
const LIMIT_MAP = { 0: 10, 10: 10, 11: 100, 21: 200, 31: 500, 41: 2000, 51: 5000 };

// GLaDOS 的几个旧域名共用同一套账号系统。对用户只保留一个入口；请求失败时再按旧域名回退。
const GLADOS_DOMAIN = 'glados.network';
const GLADOS_DOMAINS = [GLADOS_DOMAIN, 'glados.cloud', 'railgun.info', 'glados.rocks', 'glados.vip', 'glados.one', 'glados.space'];
const DEFAULT_SITES = [GLADOS_DOMAIN];
const NL_DOMAIN = 'nodeloc.com';
const NS_DOMAIN = 'nodeseek.com';

const HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Content-Type': 'application/json;charset=UTF-8',
    'Accept': 'application/json, text/plain, */*'
};


// 通用超时 fetch（Promise.race 实现，Workers 环境验证通过）
async function safeFetchTimeout(url, opts, ms = 12000) {
    try {
        return await Promise.race([
            fetch(url, opts || {}),
            new Promise((_, rj) => setTimeout(() => rj(new Error('TIMEOUT')), ms))
        ]);
    } catch(e) { return null; }
}

// ================= NodeLoc / NodeSeek 自动签到 =================
const NL_BASE = 'https://www.nodeloc.com';
// NodeSeek 主站是 nodeseek.com；不要把 Cookie 请求发到 www 子域名。
const NS_BASE = 'https://nodeseek.com';
// 获取/初始化站点签到状态
async function nlGetState(userId, env, prefix = 'NL') {
    const raw = await env.GLADOS_DB.get(`${prefix}_STATE_${userId}`);
    if (raw) {
        try {
            const p = JSON.parse(raw);
            if (p && typeof p === 'object') return p;
        } catch(e) {}
    }
    return { cookieError: '', failCount: 0, failAlerted: false };
}

async function nlSaveState(userId, state, env, prefix = 'NL') {
    await env.GLADOS_DB.put(`${prefix}_STATE_${userId}`, JSON.stringify(state));
}

function isNodeLocAccount(acc) { return acc && acc.domain === NL_DOMAIN; }
function isNodeSeekAccount(acc) { return acc && acc.domain === NS_DOMAIN; }
function isForumAccount(acc) { return isNodeLocAccount(acc) || isNodeSeekAccount(acc); }
function isGladosAccount(acc) { return acc && !isForumAccount(acc); }

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

// NodeSeek 的 Cookie 是 session=<id> + pjwt=<JWT>，不是 koa:sess。
// pjwt 是标准 base64url JWT，payload 里包含 id / name。
function decodeNodeseekJwt(cookie) {
    const pjwt = getCookieValue(cookie, 'pjwt');
    if (!pjwt) return null;
    try {
        const parts = pjwt.split('.');
        // NodeSeek 的 pjwt 为 payload.signature（无 header 段），而标准 JWT 为 header.payload.signature。
        const payloadSeg = parts.length === 2 ? parts[0] : parts[1];
        let payload = payloadSeg.replace(/-/g, '+').replace(/_/g, '/');
        while (payload.length % 4) payload += '=';
        const json = JSON.parse(atob(payload));
        return { id: json.id, name: json.name };
    } catch (e) { return null; }
}

function nodeseekIdentity(cookie) {
    const decoded = decodeNodeseekJwt(cookie);
    if (decoded && decoded.name) return String(decoded.name);
    return 'NodeSeek 账号';
}

function explainForumFailure(site, result) {
    const raw = String(result?.message || '').trim();
    const lower = raw.toLowerCase();
    if (result?.cookieError || /cookie|not_logged_in|需要登录|未登录|过期|失效|unauthorized|forbidden/.test(lower)) {
        return `Cookie 失效或未登录（${raw || '请重新复制完整 Cookie'}）`;
    }
    if (/bad csrf|csrf|无效的请求|invalid request/.test(lower)) {
        return '请求校验失败（CSRF 或请求参数无效，请重新复制 Cookie 后重试）';
    }
    if (/<!doctype html|<html|just a moment|cloudflare/i.test(raw)) {
        return `${site} 被 Cloudflare 拦截，请更新 cf_clearance 后重试`;
    }
    if (/timeout|超时/.test(lower)) return '请求超时，请稍后重试';
    if (/already|已签|重复|今天已|今日已/.test(lower)) return '今日已签到';
    return raw ? raw.slice(0, 180) : '站点返回未知响应';
}

function formatForumResult(site, account, result, pref) {
    const icon = result.ok ? (result.already ? '🔁' : '✅') : '❌';
    const status = result.ok ? (result.already ? '今日已签到' : '签到成功') : '签到失败';
    const reason = explainForumFailure(site, result);
    const reward = result.points ? ` | 本次 +${escapeHtml(result.points)}` : '';
    const current = result.current ? ` | 当前 ${escapeHtml(result.current)}` : '';
    return `${icon} <b>${site}</b> ${maskEmail(account.email || account.username || '?', pref.showEmail)}\n└ ${status}：${escapeHtml(reason)}${reward}${current}`;
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

function nodelocToday() {
    const beijingNow = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Shanghai' }));
    return beijingNow.toISOString().slice(0, 10);
}

function nodelocNonce() {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, function(byte) { return byte.toString(36); }).join('').slice(0, 26);
}

async function runNodelocCheckin(cookie) {
    const cleanCookie = normalizeCookie(cookie);
    if (!getCookieValue(cleanCookie, '_forum_session')) return { ok: false, cookieError: '缺少 _forum_session', message: 'Cookie 格式不完整' };
    const csrfResponse = await safeFetchTimeout(NL_BASE + '/session/csrf.json', {
        headers: { 'User-Agent': HEADERS['User-Agent'], 'Cookie': cleanCookie, 'Accept': 'application/json', 'Referer': NL_BASE + '/' }
    }, 10000);
    if (!csrfResponse) return { ok: false, message: '获取 CSRF 超时' };
    if (csrfResponse.status === 401) return { ok: false, cookieError: '未登录', message: 'Cookie 已失效' };
    const csrfData = await csrfResponse.json().catch(function() { return {}; });
    const csrf = csrfData.csrf || '';
    if (!csrf) return { ok: false, message: '未取得 CSRF Token' };

    const nonce = nodelocNonce();
    const response = await safeFetchTimeout(NL_BASE + '/checkin.json', {
        method: 'POST',
        headers: {
            'User-Agent': HEADERS['User-Agent'],
            'Cookie': cleanCookie,
            'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
            'Accept': 'application/json, text/plain, */*',
            'Origin': NL_BASE,
            'Referer': NL_BASE + '/',
            'X-Discourse-Checkin': 'true',
            'X-Checkin-Nonce': nonce,
            'X-CSRF-Token': csrf,
            'X-Requested-With': 'XMLHttpRequest'
        },
        body: new URLSearchParams({ nonce: nonce, timestamp: String(Date.now()) }).toString()
    }, 12000);
    if (!response) return { ok: false, message: '签到请求超时' };
    const raw = await response.text();
    const data = (() => { try { return JSON.parse(raw); } catch(e) { return {}; } })();
    const errorType = String(data.error_type || '').toLowerCase();
    const message = data.message || data.msg || data.errors?.[0] || raw.slice(0, 120) || ('HTTP ' + response.status);
    // NodeLoc 的 403 可能是“已签到”、未登录或 BAD CSRF，必须看 body，不能按状态码一概而论。
    const already = /already|已签|重复|今天已|今日已|today/i.test(String(message)) || /already|已签|重复|今天已|今日已|today/i.test(raw);
    const notLoggedIn = response.status === 401 || errorType === 'not_logged_in' || /需要登录|not_logged_in|unauthorized/i.test(String(message)) || /需要登录|not_logged_in|unauthorized/i.test(raw);
    const badCsrf = /bad csrf|csrf/i.test(String(message)) || /bad csrf|csrf/i.test(raw);
    // Cloudflare HTML 403、未登录 JSON、BAD CSRF 都不能误判为“今日已签到”；只有明确的重复签到文案才算 already。
    const cookieError = notLoggedIn ? '未登录' : '';
    const ok = already || (response.ok && data.success !== false && !badCsrf && !notLoggedIn);
    return { ok, already, points: data.points || data.gain || '', message, cookieError };
}

async function runNodeseekCheckin(cookie) {
    const cleanCookie = normalizeCookie(cookie);
    // NodeSeek 真实 Cookie 形如 session=<id>; pjwt=<JWT>，不是 koa:sess。
    if (!getCookieValue(cleanCookie, 'session') || !getCookieValue(cleanCookie, 'pjwt')) {
        return { ok: false, cookieError: 'Cookie 格式不完整', message: '请复制完整 NodeSeek Cookie（需同时包含 session / pjwt）' };
    }
    const response = await safeFetchTimeout(NS_BASE + '/api/attendance?random=true', {
        method: 'POST',
        headers: {
            'User-Agent': HEADERS['User-Agent'],
            'Cookie': cleanCookie,
            'Accept': 'application/json, text/plain, */*',
            'Origin': NS_BASE,
            'Referer': NS_BASE + '/board',
            'Content-Length': '0'
        }
    }, 12000);
    if (!response) return { ok: false, message: '签到请求超时' };
    if (response.status === 401 || response.status === 403) return { ok: false, cookieError: '未登录或 Cloudflare 验证', message: 'Cookie 已失效或需刷新 cf_clearance' };
    const raw = await response.text();
    const data = (() => { try { return JSON.parse(raw); } catch(e) { return {}; } })();
    const message = data.message || data.msg || raw.slice(0, 120) || ('HTTP ' + response.status);
    const messageText = String(message).toLowerCase();
    const already = /已完成|已签到|重复|already|today/i.test(messageText);
    const successText = /成功|完成|签到|success|check.?in|observation logged|tomorrow/i.test(messageText);
    const failedText = /失败|错误|禁止|无权限|登录|过期|fail|error|unauthorized|forbidden/i.test(messageText);
    const ok = response.ok && (data.success === true || already || (!failedText && (successText || data.gain !== undefined || data.current !== undefined)));
    return { ok, already, points: data.gain || '', current: data.current || '', message, cookieError: '' };
}

async function runForumCheckin(acc) {
    return isNodeLocAccount(acc) ? runNodelocCheckin(acc.cookie) : runNodeseekCheckin(acc.cookie);
}


// ====== 健康状态系统 ======
const SITE_NAMES = { NL: 'NodeLoc', NS: 'NodeSeek' };

async function getHealthSummary(userId, env) {
    const lines = [];
    // GLaDOS
    const accts = await getAccounts(userId, env);
    const glados = accts.filter(function(a){ return a.domain !== 'nodeloc.com' && a.domain !== 'nodeseek.com'; });
    if (glados.length > 0) {
        const ok = glados.filter(function(a){ return a.cronSuccess !== false; }).length;
        const bad = glados.filter(function(a){ return a.cronSuccess === false; }).length;
        if (bad > 0) {
            lines.push('🟡 GLaDOS ' + ok + '/' + glados.length + ' 正常，' + bad + ' 失败');
        } else {
            lines.push('🟢 GLaDOS ' + glados.length + ' 个账号已绑定');
        }
    } else {
        lines.push('⚪ GLaDOS 未绑定账号');
    }
    // NodeLoc / NodeSeek 签到站点
    const sites = [
        { domain: 'nodeloc.com', pfx: 'NL', name: 'NodeLoc' },
        { domain: 'nodeseek.com', pfx: 'NS', name: 'NodeSeek' },
    ];
    for (const site of sites) {
        const siteAccts = accts.filter(function(a){ return a.domain === site.domain; });
        if (siteAccts.length === 0) {
            lines.push('⚪ ' + site.name + ' 未绑定');
            continue;
        }
        const s = await nlGetState(userId, env, site.pfx);
        const label = site.name + (siteAccts.length > 1 ? '(' + siteAccts.length + ')' : '');
        if (s.cookieError) {
            lines.push('🔴 ' + label + ' Cookie 失效');
        } else if ((s.failCount || 0) >= 5) {
            lines.push('🟡 ' + label + ' 连续 ' + s.failCount + ' 次失败');
        } else {
            const checked = s.lastCheckinDate === nodelocToday() ? '今日已签到' : '等待签到';
            lines.push('🟢 ' + label + ' 正常 | ' + checked);
        }
    }
    return lines.join('\n');
}

async function checkAndAlert(userId, state, prefix, env) {
    if ((state.failCount || 0) >= 5 && !state.failAlerted) {
        state.failAlerted = true;
        const name = SITE_NAMES[prefix] || prefix;
        fetch('https://api.telegram.org/bot' + env.BOT_TOKEN + '/sendMessage', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                chat_id: env.ADMIN_ID,
                text: '⚠️ <b>' + name + ' 连续 ' + state.failCount + ' 次签到失败</b>\n建议检查 Cookie 或站点状态。',
                parse_mode: 'HTML'
            })
        }).catch(function(){});
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
                const commands = [{ command: "start", description: "启动/重置机器人菜单" }];
                const [webhookRes, commandRes] = await Promise.all([
                    fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/setWebhook?url=${encodeURIComponent(webhookUrl)}`),
                    fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/setMyCommands`, {
                        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ commands })
                    })
                ]);
                const result = {
                    webhook: (await webhookRes.json()).ok === true,
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
    if (text === '/debug_ns' && chatId == env.ADMIN_ID) {
        await tgSend(chatId, "🔍 开始诊断 NodeSeek，请稍候...", env);
        await tgSend(chatId, await diagnoseNodeseek(userId, env), env);
        return;
    }

    const state = await env.GLADOS_DB.get(`STATE_${userId}`);
    if (state === 'AWAITING_ACCOUNT_INFO') await processAddAccountInfo(chatId, userId, text, env);
    else if (state === 'AWAITING_NODELOC_COOKIE') await processAddAccountInfo(chatId, userId, text, env);
    else if (state === 'AWAITING_NODESEEK_COOKIE') await processAddAccountInfo(chatId, userId, text, env);
    else if (state === 'AWAITING_LINUXDO_COOKIE') await processAddAccountInfo(chatId, userId, text, env);
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
        await rp("🌐 <b>请输入新增的网址</b>\n\n例如：<code>https://glados.network</code>");
    }
    else if (data === 'site_del_menu') {
        const customSites = await getCustomSites(userId, env);
        if (customSites.length === 0) {
            return rp("❌ 您还没有添加任何自定义网站。");
        }
        let msg = "🗑️ <b>请回复要删除的网站序号：</b>\n\n";
        customSites.forEach((site, i) => msg += `${i + 1}. <code>${site}</code>\n`);
        
        await env.GLADOS_DB.put(`STATE_${userId}`, 'AWAITING_DELETE_SITE', { expirationTtl: 120 });
        await rp(msg);
    }
    else if (data.startsWith('selsite_')) {
        const index = parseInt(data.split('_')[1]);
        const customSites = await getCustomSites(userId, env);
        const allSites = [...DEFAULT_SITES, ...customSites];
        const selectedSite = allSites[index];

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
        await env.GLADOS_DB.delete('NL_STATE_' + userId);
        await env.GLADOS_DB.delete('NS_STATE_' + userId);
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
            const isDiscourse = isForumAccount(acc);
            const kb = {
                inline_keyboard: [
                    [{ text: "👁️ 查看此账户信息", callback_data: `view_acc_${index}` },
                     { text: "✅ 立即单独签到", callback_data: isDiscourse ? `rd_acc_${index}` : `chk_acc_${index}` }],
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
        
        if (acc.domain === 'nodeloc.com') {
            const pref = await getPref(userId, env);
            const st = await env.GLADOS_DB.get('NL_STATE_' + userId, 'json') || {};
            let msg = `🌐 <b>NodeLoc 自动签到</b>\n\n`;
            msg += `👤 账号: ${maskEmail(acc.email || acc.username || '?', pref.showEmail)}\n`;
            msg += `━━━━━━━━━━━━━━━━\n`;
            msg += `📅 今日签到: ${st.lastCheckinDate === nodelocToday() ? (st.lastCheckinMessage || '已完成') : '尚未执行'}\n`;
            msg += `━━━━━━━━━━━━━━━━\n`;
            if (st.cookieError) {
                msg += `⚠️ Cookie 异常: ${st.cookieError}\n`;
            } else {
                msg += `✅ Cookie 状态: 正常\n`;
            }
            return rp(msg);
        }
        if (acc.domain === 'nodeseek.com') {
            const pref = await getPref(userId, env);
            const st = await env.GLADOS_DB.get('NS_STATE_' + userId, 'json') || {};
            let msg = `🔹 <b>NodeSeek 自动签到</b>\n\n`;
            msg += `👤 账号: ${escapeHtml(acc.username || '?')}\n`;
            msg += `━━━━━━━━━━━━━━━━\n`;
            msg += `📅 今日签到: ${st.lastCheckinDate === nodelocToday() ? (st.lastCheckinMessage || '已完成') : '尚未执行'}\n`;
            msg += `━━━━━━━━━━━━━━━━\n`;
            if (st.cookieError) {
                msg += `⚠️ Cookie 异常: ${st.cookieError}\n`;
            } else {
                msg += `✅ Cookie 状态: 正常\n`;
            }
            return rp(msg);
        }
        
        await rp("⏳ 正在拉取该账号信息...");
        const pref = await getPref(userId, env);
        const accData = await getAccountDataObj(acc, false);
        const msgStr = formatAccountString(acc, index + 1, accounts.length, pref, accData, true, true);
        await rp(msgStr);
    }
    else if (data.startsWith('rd_acc_') || data.startsWith('chk_acc_')) {
        const index = parseInt(data.split('_')[2]);
        const accounts = await getAccounts(userId, env);
        const acc = accounts[index];
        const pref = await getPref(userId, env);
        if (!acc) return rp("❌ 账号不存在");
        
        if (isForumAccount(acc)) {
            await rp(`⏳ 正在执行 ${isNodeLocAccount(acc) ? 'NodeLoc' : 'NodeSeek'} 签到，请稍候...`);
            const result = await runForumCheckin(acc);
            const prefix = isNodeLocAccount(acc) ? 'NL' : 'NS';
            const state = await nlGetState(userId, env, prefix);
            if (result.ok) {
                state.cookieError = '';
                state.failCount = 0;
                state.failAlerted = false;
                state.lastCheckinDate = nodelocToday();
                state.lastCheckinMessage = result.message;
            } else {
                state.cookieError = result.cookieError || '';
                state.failCount = (state.failCount || 0) + 1;
                state._lastError = result.message;
            }
            await nlSaveState(userId, state, env, prefix);
            await checkAndAlert(userId, state, prefix, env);
            return rp(formatForumResult(isNodeLocAccount(acc) ? 'NodeLoc' : 'NodeSeek', acc, result, pref));
        }
        await rp("⏳ 正在为您单独执行签到，请稍候...");
        const accData = await getAccountDataObj(acc, true); // true 代表触发签到
        const msgStr = formatAccountString(acc, index + 1, accounts.length, pref, accData, true, true);
        await rp(msgStr);
    }
    else if (data.startsWith('del_acc_')) {
        const index = parseInt(data.split('_')[2]);
        let accounts = await getAccounts(userId, env);
        if (!accounts[index]) return rp("❌ 账号不存在");
        const deletedAccount = accounts[index];
        const deletedEmail = deletedAccount.email;
        accounts.splice(index, 1);
        await env.GLADOS_DB.put(`USER_${userId}`, JSON.stringify(accounts));
        if (isNodeLocAccount(deletedAccount) && !accounts.some(isNodeLocAccount)) await env.GLADOS_DB.delete('NL_STATE_' + userId);
        if (isNodeSeekAccount(deletedAccount) && !accounts.some(isNodeSeekAccount)) await env.GLADOS_DB.delete('NS_STATE_' + userId);
        const pref = await getPref(userId, env);
        await tgEdit(chatId, messageId, `✅ 已成功删除账号：<code>${maskEmail(deletedEmail, pref.showEmail)}</code>`, { inline_keyboard: [[{ text: "🔙 返回账户管理", callback_data: "list_manage" }]] }, env);
    }
    else if (data.startsWith('upd_acc_')) {
        const index = parseInt(data.split('_')[2]);
        await env.GLADOS_DB.put(`STATE_${userId}`, 'AWAITING_UPDATE_COOKIE', { expirationTtl: 300 });
        await env.GLADOS_DB.put(`TEMP_${userId}`, index.toString(), { expirationTtl: 300 });
        await rp(`🔁 <b>请直接回复新的 Cookie 内容：</b>`);
    }
    else if (data === 'add_nodeloc') {
        await env.GLADOS_DB.put(`STATE_${userId}`, 'AWAITING_NODELOC_COOKIE', { expirationTtl: 300 });
        await env.GLADOS_DB.put(`TEMP_${userId}`, 'nodeloc.com', { expirationTtl: 300 });
        await rp("🌐 <b>绑定 NodeLoc 账号</b>\n\n打开 https://www.nodeloc.com → F12 → Application → Cookies → 右键复制全部 Cookie，直接粘贴发送。\n\nBot 会自动解析。", { inline_keyboard: [[{ text: "🔙 返回", callback_data: "list_manage" }]] });
    }
    else if (data === 'add_nodeseek') {
        await env.GLADOS_DB.put(`STATE_${userId}`, 'AWAITING_NODESEEK_COOKIE', { expirationTtl: 300 });
        await env.GLADOS_DB.put(`TEMP_${userId}`, 'nodeseek.com', { expirationTtl: 300 });
        await rp("🔹 <b>绑定 NodeSeek 账号</b>\n\n打开 https://nodeseek.com → F12 → Application → Cookies → 右键复制全部 Cookie，直接粘贴发送。\n\nBot 会自动解析。", { inline_keyboard: [[{ text: "🔙 返回", callback_data: "list_manage" }]] });
    }
    else if (data === 'bind_ns') {
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

// 通过 Discourse API / HTML 获取当前登录用户的用户名和邮箱
async function fetchDiscourseUser(cookie, baseUrl) {
    // Method 1: API
    try {
        const res = await fetch(baseUrl + '/session/current.json', {
            headers: { 'User-Agent': HEADERS['User-Agent'], 'Cookie': cookie }
        });
        if (res.ok) {
            const data = await res.json();
            const user = data && data.current_user;
            if (user && user.username) return { username: user.username, email: user.email || '' };
        }
    } catch(e) {}

    // Method 2: 从首页 HTML 解析 discourse-current-user
    try {
        const res = await fetch(baseUrl + '/', {
            headers: { 'User-Agent': HEADERS['User-Agent'], 'Cookie': cookie, 'Accept': 'text/html' }
        });
        if (res.ok) {
            const html = await res.text();
            const m = html.match(/<meta name="discourse-current-user" content="([^"]+)">/);
            if (m) {
                const raw = m[1].replace(/&quot;/g, '"');
                const data = JSON.parse(decodeURIComponent(raw));
                if (data && data.username) return { username: data.username, email: data.email || '' };
            }
        }
    } catch(e) {}

    return null;
}

// 诊断 NodeSeek 连通性（NodeSeek 不是 Discourse，用真实签到接口验证）
async function diagnoseNodeseek(userId, env) {
    const accounts = await getAccounts(userId, env);
    const nsAcc = accounts.find(a => a.domain === 'nodeseek.com');
    if (!nsAcc) return '没有 NodeSeek 账号';
    const rows = ['🔍 NodeSeek 诊断结果', '━━━━━━━━━━━'];
    rows.push('👤 身份: ' + nodeseekIdentity(nsAcc.cookie));
    async function t(label, url, extra) {
        try {
            const r = await Promise.race([
                fetch(url, extra || {}),
                new Promise((_, reject) => setTimeout(() => reject(new Error('TIMEOUT')), 12000))
            ]);
            rows.push(`✅ ${label} status=${r.status}`);
            return r;
        } catch(e) {
            rows.push(`❌ ${label} ${e.message?.includes('TIMEOUT') ? '超时' : e.name}`);
            return null;
        }
    }
    const r1 = await t('GET /', 'https://nodeseek.com/', {
        headers: { 'User-Agent': HEADERS['User-Agent'], 'Cookie': nsAcc.cookie }
    });
    if (r1) rows.push(`   cloudflare=${r1.headers.get('server') === 'cloudflare' ? '是' : (r1.headers.get('cf-mitigated') ? '挑战' : '否')}`);
    const r2 = await t('POST /api/attendance', NS_BASE + '/api/attendance?random=true', {
        method: 'POST',
        headers: { 'User-Agent': HEADERS['User-Agent'], 'Cookie': nsAcc.cookie, 'Accept': 'application/json, text/plain, */*', 'Origin': NS_BASE, 'Referer': NS_BASE + '/board', 'Content-Length': '0' }
    });
    if (r2) {
        const raw = await r2.text().catch(() => '');
        rows.push(`   body=${(raw || '').slice(0, 120)}`);
    }
    return rows.join('\n');
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

    // NodeLoc: 直接发 cookie，bot 自动提取用户名
    if (state === 'AWAITING_NODELOC_COOKIE') {
        const cookie = normalizeCookie(text);
        if (!getCookieValue(cookie, '_forum_session')) {
            return rp("❌ Cookie 格式错误！需要包含 <code>_forum_session</code>。");
        }
        const userInfo = await fetchDiscourseUser(cookie, NL_BASE);
        if (!userInfo) return rp("❌ 无法验证 Cookie，请确认已登录 NodeLoc 后重新抓取。");
        let accounts = await getAccounts(userId, env);
        // 去重：同一 _forum_session 不重复绑定
        const sessionMatch = cookie.match(/_forum_session=([^;]+)/);
        const sessionVal = sessionMatch ? sessionMatch[1] : null;
        const exists = accounts.some(a => a.domain === 'nodeloc.com' && a.cookie && a.cookie.includes(sessionVal));
        if (exists) return rp(`ℹ️ 该账号已绑定（<code>${userInfo.email || userInfo.username}</code>），无需重复操作。`);
        accounts.push({ email: userInfo.email, username: userInfo.username, domain: 'nodeloc.com', cookie: cookie });
        await env.GLADOS_DB.put(`USER_${userId}`, JSON.stringify(accounts));
        await saveUserIdForCron(userId, env);
        await clearDiscourseState(userId, 'nodeloc.com', env);
        const total = accounts.length;
        const nlTotal = accounts.filter(a => a.domain === 'nodeloc.com').length;
        await rp(`✅ <b>NodeLoc 绑定成功！</b>\n\n👤 账号: <code>${userInfo.email || userInfo.username}</code>\n🌐 NodeLoc 账号: ${nlTotal} 个\n📦 当前总账号数: ${total} 个`);
        return;
    }

    // NodeSeek 是独立站点，不是 Discourse：Cookie 形如 session=<id>; pjwt=<JWT>。
    if (state === 'AWAITING_NODESEEK_COOKIE') {
        const cookie = normalizeCookie(text);
        if (!getCookieValue(cookie, 'session') || !getCookieValue(cookie, 'pjwt')) {
            return rp("❌ Cookie 格式错误！需要同时包含 <code>session</code> 与 <code>pjwt</code>，请在 https://nodeseek.com 复制完整 Cookie。");
        }
        const identity = nodeseekIdentity(cookie);
        let accounts = await getAccounts(userId, env);
        const sessionVal = getCookieValue(cookie, 'session');
        const exists = accounts.some(function(a) { return isNodeSeekAccount(a) && getCookieValue(a.cookie, 'session') === sessionVal; });
        if (exists) return rp(`ℹ️ 该账号已绑定（<code>${identity}</code>），无需重复操作。`);
        accounts.push({ email: identity, username: identity, domain: NS_DOMAIN, cookie: cookie });
        await env.GLADOS_DB.put(`USER_${userId}`, JSON.stringify(accounts));
        await saveUserIdForCron(userId, env);
        await clearDiscourseState(userId, NS_DOMAIN, env);
        const total = accounts.length;
        const nsTotal = accounts.filter(isNodeSeekAccount).length;
        await rp(`✅ <b>NodeSeek 绑定成功！</b>\n\n👤 账号: <code>${identity}</code>\n🔹 NodeSeek 账号: ${nsTotal} 个\n📦 当前总账号数: ${total} 个\n\n⏰ 将按「签到设置」的时间自动签到。`);
        return;
    }

    // GLaDOS 裸 Cookie：多个官方域名账户互通，统一写入 glados.network；自动查询邮箱并按邮箱覆盖旧 Cookie。
    // 真实 GLaDOS Cookie 形如 koa:sess=...，不要把它误判成其它站点；同时排除 NodeLoc/NodeSeek 的标记。
    if (text.indexOf('=') > -1 && !/expires=|connect\.sid|_forum_session|session=|pjwt/.test(text)) {
        const cookie = normalizeCookie(text);
        let found = null;
        for (const domainCandidate of GLADOS_DOMAINS) {
            const data = await safeFetchJson(`https://${domainCandidate}/api/user/info`, { headers: { ...HEADERS, 'Cookie': cookie, 'Origin': `https://${domainCandidate}` } });
            const email = data && data.code === 0 && data.data && data.data.userInfo && data.data.userInfo.email;
            if (email) {
                found = { email: email, sourceDomain: domainCandidate };
                break;
            }
        }
        if (found) {
            let accounts = await getAccounts(userId, env);
            const emailKey = found.email.trim().toLowerCase();
            const existingIndex = accounts.findIndex(function(account) { return isGladosAccount(account) && String(account.email || '').trim().toLowerCase() === emailKey; });
            const account = { domain: GLADOS_DOMAIN, email: found.email, cookie: cookie };
            const updated = existingIndex >= 0;
            if (updated) accounts[existingIndex] = { ...accounts[existingIndex], ...account };
            else accounts.push(account);
            await env.GLADOS_DB.put(`USER_${userId}`, JSON.stringify(accounts));
            await saveUserIdForCron(userId, env);
            const total = accounts.filter(isGladosAccount).length;
            return rp(`✅ <b>GLaDOS ${updated ? 'Cookie 已更新' : '绑定成功'}！</b>\n\n👤 账号: <code>${found.email}</code>\n🌐 统一站点: <code>${GLADOS_DOMAIN}</code>\n📦 当前 GLaDOS 账号数: ${total} 个\n\n<i>Cookie 已从 ${found.sourceDomain} 验证；各 GLaDOS 域名共用同一账户。</i>`);
        }
        return rp("❌ 无法验证 GLaDOS Cookie，请确认已登录后重新抓取。\n\n也可以使用 <code>邮箱:cookie</code> 格式手动绑定。");
    }

    const lines = text.split('\n');
    let accounts = await getAccounts(userId, env);
    let accMap = new Map();
    accounts.forEach(acc => {
        const key = `${acc.domain}:${String(acc.email || '').trim().toLowerCase()}`;
        accMap.set(key, acc);
    });
    if (isGladosAccount({ domain }) && lines.some(line => line.includes('koa:sess='))) {
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
            
            const accountDomain = isGladosAccount({ domain }) ? GLADOS_DOMAIN : domain;
            const accountKey = `${accountDomain}:${emailKey}`;
            if (accMap.has(accountKey)) updated++;
            else added++;
            
            accMap.set(accountKey, { domain: accountDomain, email, cookie });
        }
    }

    accounts = Array.from(accMap.values()).map(function(account) {
        return isGladosAccount(account) ? { ...account, domain: GLADOS_DOMAIN, cookie: normalizeCookie(account.cookie) } : { ...account, cookie: normalizeCookie(account.cookie) };
    });
    await env.GLADOS_DB.put(`USER_${userId}`, JSON.stringify(accounts));
    await saveUserIdForCron(userId, env);
    if (domain === 'nodeloc.com' || domain === 'nodeseek.com') {
        await clearDiscourseState(userId, domain, env);
    }

    let resultMsg = `✅ <b>导入完毕！(全局防重生效)</b>\n\n➕ 新增账号: ${added} 个\n🔁 覆盖更新: ${updated} 个\n📦 当前总账号数: ${accounts.length} 个`;
    await rp(resultMsg);
    await rp("👇", { inline_keyboard: [[{ text: "🔙 返回主菜单", callback_data: "menu_main" }]] });
}

async function clearDiscourseState(userId, domain, env) {
    const prefix = domain === 'nodeloc.com' ? 'NL' : 'NS';
    let state = await env.GLADOS_DB.get(prefix + '_STATE_' + userId, 'json');
    if (state) {
        state.cookieError = '';
        state.failCount = 0;
        if (state._lastError) delete state._lastError;
        await env.GLADOS_DB.put(prefix + '_STATE_' + userId, JSON.stringify(state));
    }
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
    const domain = account.domain;
    const isDiscourse = isForumAccount(account);
    if (isNodeLocAccount(account) && !getCookieValue(newCookie, '_forum_session')) {
        return rp("❌ NodeLoc Cookie 格式错误：需要包含 <code>_forum_session</code>。");
    }
    if (isNodeSeekAccount(account) && (!getCookieValue(newCookie, 'session') || !getCookieValue(newCookie, 'pjwt'))) {
        return rp("❌ NodeSeek Cookie 格式错误：需要同时包含 <code>session</code> 与 <code>pjwt</code>。");
    }
    if (isGladosAccount(account) && !getCookieValue(newCookie, 'koa:sess')) {
        return rp("❌ GLaDOS Cookie 格式错误：需要包含 <code>koa:sess</code>。");
    }
    account.cookie = newCookie;
    if (isNodeSeekAccount(account)) {
        account.email = nodeseekIdentity(newCookie);
        account.username = account.email;
    }
    if (isGladosAccount(account)) account.domain = GLADOS_DOMAIN;
    await env.GLADOS_DB.put(`USER_${userId}`, JSON.stringify(accounts));
    if (isDiscourse) {
        await clearDiscourseState(userId, domain, env);
        await rp("✅ Cookie 更新成功！可使用「立即单独签到」验证。", { inline_keyboard: [[{ text: "🔙 返回账户管理", callback_data: "list_manage" }]] });
        return;
    }
    
    await rp("✅ Cookie 更新成功！正在为您验证签到状态...");
    const pref = await getPref(userId, env);
    const data = await getAccountDataObj(accounts[index], true);
    const msgStr = formatAccountString(accounts[index], index + 1, accounts.length, pref, data, true, true);
    await rp(msgStr, { inline_keyboard: [[{ text: "🔙 返回账户管理", callback_data: "list_manage" }]] });
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
            if (isForumAccount(acc)) {
                const prefix = isNodeLocAccount(acc) ? 'NL' : 'NS';
                if (type === 'checkin') {
                    const result = await runForumCheckin(acc);
                    const state = await nlGetState(userId, env, prefix);
                    if (result.ok) {
                        state.cookieError = '';
                        state.failCount = 0;
                        state.failAlerted = false;
                        state.lastCheckinDate = nodelocToday();
                        state.lastCheckinMessage = result.message;
                    } else {
                        state.cookieError = result.cookieError || '';
                        state.failCount = (state.failCount || 0) + 1;
                        state._lastError = result.message;
                    }
                    await nlSaveState(userId, state, env, prefix);
                    await checkAndAlert(userId, state, prefix, env);
                    const label = isNodeLocAccount(acc) ? 'NodeLoc' : 'NodeSeek';
                    const forumMsg = formatForumResult(label, acc, result, pref);
                    msgs.push(forumMsg);
                    if (type === 'checkin') newResultList.push(forumMsg);
                } else {
                    const state = await nlGetState(userId, env, prefix);
                    const label = isNodeLocAccount(acc) ? 'NodeLoc' : 'NodeSeek';
                    const last = state.lastCheckinDate === nodelocToday() ? (state.lastCheckinMessage || '已完成') : '今日尚未执行';
                    const cookieState = state.cookieError ? `❌ ${state.cookieError}` : '✅ 正常';
                    msgs.push(`🌐 ${label} (${maskEmail(acc.email || acc.username, pref.showEmail)})\n├ 📅 签到: ${last}\n└ 🍪 Cookie: ${cookieState}`);
                }
                continue;
            }
            const doCheckin = (type === 'checkin');
            const data = await getAccountDataObj(acc, doCheckin);
            const gladosMsg = formatAccountString(acc, i + 1, accounts.length, pref, data, true, false);
            msgs.push(gladosMsg);
            if (type === 'checkin') newResultList.push(gladosMsg);
        } 
        else if (type === 'batch_exchange') {
            if (acc.domain === 'nodeloc.com' || acc.domain === 'nodeseek.com') continue;
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
            if (acc.domain === 'nodeloc.com' || acc.domain === 'nodeseek.com') continue;
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
            const resultRows = [];
            for (const acc of accounts) {
                if (isForumAccount(acc)) {
                    const prefix = isNodeLocAccount(acc) ? 'NL' : 'NS';
                    const label = isNodeLocAccount(acc) ? 'NodeLoc' : 'NodeSeek';
                    const result = await runForumCheckin(acc);
                    const state = await nlGetState(userId, env, prefix);
                    if (result.ok) {
                        state.cookieError = '';
                        state.failCount = 0;
                        state.failAlerted = false;
                        state.lastCheckinDate = nodelocToday();
                        state.lastCheckinMessage = result.message;
                    } else {
                        state.cookieError = result.cookieError || '';
                        state.failCount = (state.failCount || 0) + 1;
                        state._lastError = result.message;
                    }
                    await nlSaveState(userId, state, env, prefix);
                    await checkAndAlert(userId, state, prefix, env);
                    resultRows.push(formatForumResult(label, acc, result, pref));
                    await new Promise(function(resolve) { setTimeout(resolve, 600); });
                    continue;
                }
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
                    body: JSON.stringify({ chat_id: env.ADMIN_ID, text: '⚠️ <b>GLaDOS ' + gladosBad.length + ' 个账号签到失败</b>\n' + names, parse_mode: 'HTML' })
                }).catch(function(){});
            }
            await tgSendResultList(userId, '⏰ <b>定时签到自动完成</b>', resultRows, env);
            await tgSend(userId, await getHealthSummary(userId, env), env);
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
    str += ` ├ 🌐 站点: ${acc.domain.replace(/\./g, '.\u200b')}\n`;
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
    accounts = accounts.map(function(acc) {
        if (acc.domain === 'nodeseek.cc') { changed = true; return { ...acc, domain: NS_DOMAIN }; }
        if (GLADOS_DOMAINS.includes(acc.domain) && acc.domain !== GLADOS_DOMAIN) { changed = true; return { ...acc, domain: GLADOS_DOMAIN }; }
        return acc;
    });
    // 合并历史数据中同一邮箱的 GLaDOS 多域名重复记录，保留最近一条 Cookie。
    const seen = new Map();
    const normalized = [];
    for (const acc of accounts) {
        const key = isGladosAccount(acc) && acc.email ? 'glados:' + acc.email.trim().toLowerCase() : '';
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
async function getCustomSites(userId, env) { const data = await env.GLADOS_DB.get(`SITES_${userId}`); return data ? JSON.parse(data) : []; }
async function saveUserIdForCron(userId, env) {
    let usersList = await env.GLADOS_DB.get("ALL_USERS");
    usersList = usersList ? JSON.parse(usersList) : [];
    if (!usersList.includes(userId)) { usersList.push(userId); await env.GLADOS_DB.put("ALL_USERS", JSON.stringify(usersList)); }
}
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
    const customSites = await getCustomSites(userId, env);
    const allSites = [...DEFAULT_SITES, ...customSites];
    let kb = [];
    allSites.forEach((site, index) => kb.push([{ text: `🌐 ${site}`, callback_data: `selsite_${index}` }]));
    kb.push([{ text: "🌐 NodeLoc 自动签到", callback_data: "add_nodeloc" }]);
    kb.push([{ text: "🔹 NodeSeek 自动签到", callback_data: "add_nodeseek" }]);
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
    // nodeseek 账号用 username，其他用 email
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

