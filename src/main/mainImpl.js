"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
/**
 * main.ts —— Electron 主进程入口
 *
 * 启动顺序：
 *   1) loadAppSettings()：解析 userData/settings.json 的 AI 配置（chatClient 内实现）
 *   2) PathResolver.resolve()：解析模型资源根（开发 public/assets / 打包 resourcesPath/assets /
 *      资源缺失时兜底 exe 同目录 assets —— 见 PathResolver 文件头注释）
 *   3) StaticServer：127.0.0.1 随机端口，根 = assets 上一级（renderer 同源加载 + 模型 fetch）
 *   4) ChatClient：SSE 流式对话，回调 → IPC_AI_CHUNK / IPC_AI_DONE / IPC_AI_ERROR
 *   5) PluginRegistry 适配（动态 import，导出异常时降级为 no-op）
 *   6) WindowMonitor：2s 轮询活动窗口 → IPC_ON_WINDOW_CHANGE；触发器 → IPC_ACTION
 *   7) registerIpc：IPC_LOAD_MODEL / IPC_MODEL_LIST / IPC_SEND_MESSAGE / IPC_PLUGIN_REGISTER
 *   8) BrowserWindow（透明无框置顶 360x520）+ 加载 renderer
 *   9) 默认模型日志 + setInterval 50ms registry.tick(dt) 驱动插件
 *
 * 生命周期：单实例锁（后启动实例退出，second-instance 唤起既有窗口）→
 * window-all-closed → quit（非 darwin）；activate → 重建窗口（darwin）；
 * before-quit → 停止 monitor/tick、cancel 对话、关闭静态服务。
 *
 * 资源路径无需额外环境变量分支：PathResolver 按打包状态和目录存在性选择资源根。
 * DEVTOOLS=1 时开 devtools（detach）。
 */
const electron_1 = require("electron");
const fs = __importStar(require("fs"));
const os = __importStar(require("os"));
const path = __importStar(require("path"));
const contracts_1 = require("../shared/contracts");
const PathResolver_1 = require("./PathResolver");
const staticServer_1 = require("./staticServer");
const chatClient_1 = require("./ai/chatClient");
const skills_1 = require("./ai/skills");
const tools_1 = require("./tools");
const workTools_1 = require("./ai/workTools");
const devTools_1 = require("./ai/devTools");
const webTools_1 = require("./ai/webTools");
const weatherTools_1 = require("./ai/weatherTools");
const mediaTools_1 = require("./ai/mediaTools");
const screenTools_1 = require("./ai/screenTools");
const meetingTools_1 = require("./ai/meetingTools");
const translateTools_1 = require("./ai/translateTools");
const mailTools_1 = require("./ai/mailTools");
const windowMonitor_1 = require("./monitor/windowMonitor");
const userAssets_1 = require("./assets/userAssets");
const ipc_1 = require("./ipc");
// ------------------------------------------------------------------ 数据目录统一
// app.getPath('userData') 默认是 %APPDATA%\<productName>：
//   开发态 productName = package.json 的 name（pet-desktop-app）
//   打包态 productName = Pet
// 于是同一个应用在两种形态下读的是**两个不同目录**——打包版看不到用户已有的模型、
// 设置与聊天记录（表现为默认模型回退、API Key 丢失、配置对不上）。
// 这里在最早处把 userData 钉到固定目录名，两种形态共用一份数据。
// 必须放在任何 getPath('userData') 之前执行。
try {
    const os_1 = require("os");
    const path_1 = require("path");
    const unified = path_1.join(electron_1.app.getPath('appData'), 'pet-desktop-app');
    if (electron_1.app.getPath('userData') !== unified) {
        electron_1.app.setPath('userData', unified);
    }
}
catch (err) {
    // 失败不致命：沿用 Electron 默认目录，只是两种形态不互通
    console.warn('[main] 统一 userData 目录失败，沿用默认：', err && err.message);
}
const WINDOW_WIDTH = 360;
const WINDOW_HEIGHT = 520;
/** 对话气泡窗：小、无边框、透明，浮在桌宠上方（不是一个大窗口） */
const CHAT_WINDOW_WIDTH = 360;
const CHAT_WINDOW_HEIGHT = 270;
/** 思考浮窗：摆在桌宠旁边（原来那个大窗口的位置），提问时自动开、答完自动关 */
const THINK_WINDOW_WIDTH = 460;
const THINK_WINDOW_HEIGHT = 600;
/** 浮窗与桌宠之间的间距（DIP） */
const CHAT_BUBBLE_GAP = 8;
/** 摆到屏幕顶边时的容忍量：气泡窗实际尺寸会比设定值大 1~3px，差一点点就夹到顶边而不是换边 */
const CHAT_BUBBLE_TOP_TOLERANCE = 26;
const MONITOR_INTERVAL_MS = 2000;
const PLUGIN_TICK_MS = 50;
const CURSOR_POLL_MS = 80; // 全局光标轮询周期（视线自动跟随的平滑度）
// ------------------------------------------------------------------ 模块级状态
let mainWindow = null;
/** 对话气泡窗（?panel=chat 的同一个渲染页；小气泡，浮在桌宠上方） */
let chatWindow = null;
/** 思考浮窗（?panel=think；摆在桌宠旁边，提问自动开、答完自动关） */
let thinkWindow = null;
/** 气泡尾巴朝向：down=气泡在桌宠上方（尾巴朝下）/ up=在下方 / none=在旁边 */
let chatBubbleTail = 'down';
/** 气泡相对桌宠窗口左上角的偏移（DIP）：桌宠每动一下，气泡就按它同拍跟过去 */
let bubbleOffset = null;
/** 用户是否自己把气泡拖到过别处：拖过之后缩放模型不再重新贴锚点（但平移依然跟随） */
let bubbleAnchorManual = false;
/**
 * 角色在桌宠窗口里的可见顶部偏移（DIP）。渲染层挂好模型后会报上来（含滚轮缩放后的变化），
 * 气泡窗就贴在这条线之上——窗口顶部那一大段透明区不算"角色占的地方"。
 */
let petModelTop = 40;
let server = null;
let monitor = null;
let chat = null;
let registry = null;
let toolbox = null; // 聊天→本地工具（待办/提醒闹钟）
let skillBox = null; // 技能库（assets/skills + userData/skills）
let tickTimer = null;
/** activate（macOS）重建窗口所需 */
let bootRef = null;
let loadDone = false;
// chat/monitor 回调需要 pushToRenderer，而它由 registerIpc 返回（晚于两者构造），用可变引用承接
let sendToRenderer = () => { };
let cursorTimer = null;
let lastCursorSent = null;
/** 用户在确认框里选过"本次会话内不再询问写入类操作"后置为 true（仅内存，重启恢复） */
let devAutoAllowWrites = false;
/** 用户选过"本次会话内不再询问任何操作（含命令）"后置为 true（仅内存；危险命令仍会被拦） */
let devAutoAllowAll = false;
/** 应用正在退出：退出流程里不许再把窗口的 close 拦下来（否则 quit 会被卡住） */
let appQuitting = false;
/** 本次会话里 AI 已经读过的文件（相对工作区、正斜杠）——写/改这些文件之前要求先读 */
const devReadFiles = new Set();
/** 本次会话里 AI 建/写/改过的文件，用于汇报"改了哪些" */
const devChangedFiles = [];
/** 上一次的工作区根目录：只有切换工作区时才清空上面两个集合 */
let devRootSnapshot = '';
/** 规范化成「相对工作区、正斜杠」的路径；越界或非法返回空串 */
function devRelPath(input) {
    if (typeof input !== 'string' || !input.trim())
        return '';
    const root = (0, devTools_1.getWorkspaceRoot)();
    let p = input.trim().replace(/\\/g, '/');
    if (!root)
        return p;
    if (/^[a-zA-Z]:\//.test(p)) {
        const rel = path.relative(root, path.normalize(p)).split(path.sep).join('/');
        return rel.startsWith('..') || path.isAbsolute(rel) ? '' : rel;
    }
    p = p.replace(/^\.\//, '');
    return p.startsWith('..') ? '' : p;
}
/** 记录一次改动（去重，最多 50 条） */
function devRememberChange(rel, action) {
    if (!rel || devChangedFiles.length >= 50)
        return;
    const entry = `${action} ${rel}`;
    if (!devChangedFiles.includes(entry))
        devChangedFiles.push(entry);
}
/** 在工具结果后面附一句"本次会话已改动了哪些文件" */
function appendChangeSummary(text) {
    if (devChangedFiles.length === 0)
        return text;
    const recent = devChangedFiles.slice(-3).join('、');
    return `${text}\n（本次会话已改动 ${devChangedFiles.length} 处：${recent}）`;
}
/** 判断 devTools 的返回文本是否代表成功（失败文案不以这些前缀开头） */
function devSucceeded(text, kind) {
    if (kind === 'mkdir')
        return text.startsWith('已创建目录：');
    if (kind === 'write')
        return text.startsWith('已创建文件：') || text.startsWith('已覆盖文件：');
    return text.startsWith('已修改 ');
}
/**
 * AI 的 open_path 工具：用系统默认程序打开工作区里的文件/文件夹（做完 PPT 给用户看时用）。
 * 安全约束：只接受工作区**内**的路径；只放行文档/图片/网页类扩展名与目录，
 * 绝不打开 .exe/.bat/.ps1/.lnk 之类可执行文件（"用系统默认程序打开"对这些等于运行）。
 */
const OPENABLE_EXTENSIONS = new Set([
    '.pptx', '.ppt', '.xlsx', '.xls', '.docx', '.doc', '.pdf', '.csv',
    '.txt', '.md', '.json', '.html', '.htm', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.mp4', '.mp3',
]);
function openWorkspacePath(args) {
    const root = (0, devTools_1.getWorkspaceRoot)();
    if (!root)
        return '未配置开发工作区：请先在设置里选择「开发工作区」。';
    const input = typeof args?.path === 'string' ? args.path.trim() : '';
    if (!input)
        return '路径为空。';
    const abs = path.resolve(root, input.replace(/\\/g, '/'));
    const relToRoot = path.relative(root, abs);
    if (!relToRoot || relToRoot.startsWith('..') || path.isAbsolute(relToRoot)) {
        return `拒绝打开工作区之外的路径：${input}`;
    }
    let stat;
    try {
        stat = fs.statSync(abs);
    }
    catch {
        return `路径不存在：${input}（先用 workspace_glob 确认文件名）`;
    }
    if (!stat.isDirectory()) {
        const ext = path.extname(abs).toLowerCase();
        if (!OPENABLE_EXTENSIONS.has(ext)) {
            return `为安全起见不打开 ${ext || '（无扩展名）'} 文件（只放行文档/图片/网页类）。要执行它请用 shell_run。`;
        }
    }
    try {
        const err = electron_1.shell.openPath(abs);
        if (err)
            return `打开失败：${err}`;
        return `已用系统默认程序打开：${relToRoot.split(path.sep).join('/')}`;
    }
    catch (err) {
        return `打开失败：${err.message ?? String(err)}`;
    }
}
let offlinePool = [];
let bubbleTimer = null;
let lastBubbleText = '';
let lastBubblePushAt = 0;
/** 组级冷却时间戳（ms） */
const sceneCooldownMs = {};
const SCENE_BUBBLE_MIN_GAP_MS = 8000; // 任意两次气泡最小间隔
const SCENE_GROUP_GAP_MS = 25000; // 同组气泡最小间隔
/** 分组名同义回退：新命名找不到时尝试旧语料里的相近分组（避免老库触发不到） */
const GROUP_SYNONYMS = {
    游戏全屏: ['全屏游戏', '游戏'],
    健康护眼: ['提醒休息喝水护眼', '健康', '护眼'],
    网页浏览: ['网页', '摸鱼', '摸鱼调侃', '摸鱼提醒', '桌面日常'],
    代码陪伴: ['代码', '编程', '敲码', '鼓励加油'],
    文档写作: ['桌面日常'],
    视频媒体: ['视频', '媒体'],
    长时间工作: ['提醒休息喝水护眼', '效率与计划'],
    效率计划: ['效率与计划'],
    咖啡骑行: ['咖啡'],
    鼠标静止: [],
    鼠标活跃: [],
    会议场景: [],
    开机问候: [],
    桌面日常: [],
    彩蛋吐槽: [],
    早安问候: [],
    深夜护眼: [],
    周末放松: [],
    整点报时: [],
    社交聊天: [],
    设计创作: [],
    终端命令: [],
    邮件处理: [],
    音乐陪伴: [],
};
/** 从 knowledge/<模型名>.offline.txt（回退 character.offline.txt）加载台词池；按行 trim，保留 `## 小节` 分组 */
function loadOfflinePool(knowledgeDir, modelName) {
    const readFile = (file) => {
        try {
            const content = fs.readFileSync(file, 'utf8');
            const out = [];
            let group = '默认';
            for (const raw of content.split(/\r?\n/)) {
                const line = raw.trim();
                if (!line)
                    continue;
                if (line.startsWith('#') || line.startsWith('=====')) {
                    if (line.startsWith('#')) {
                        group = line.replace(/^#+\s*/, '').trim() || '默认';
                    }
                    continue; // 分组标题与 PART 分隔行都跳过
                }
                // 兜底清洗：剥离误混入的编号前缀（如 "1. " / "2、" / "3)" / "4："），避免台词里突然出现序号
                const cleaned = line.replace(/^\s*\d+\s*[.。、)）:：]\s*/, '').trim();
                if (!cleaned)
                    continue;
                out.push({ group, text: cleaned });
            }
            return out.length >= 3 ? out : null;
        }
        catch {
            return null;
        }
    };
    const safe = path.basename(modelName || 'character') || 'character';
    offlinePool =
        readFile(path.join(knowledgeDir, `${safe}.offline.txt`)) ??
            readFile(path.join(knowledgeDir, 'character.offline.txt')) ??
            [];
    return offlinePool.length > 0;
}
/** 随机闲聊更偏向这些“闲时/陪伴”分组（避免静默待机时抽到会议等场景专属语料显得突兀） */
const CHAT_GROUP_HINTS = ['待机', '桌面日常', '日常', '闲聊', '彩蛋', '问候', '咖啡', '冷知识', '小知识', '被夸', '效率计划', '摸鱼', '鼓励'];
function randomOfflineLine() {
    if (offlinePool.length === 0)
        return null;
    const chatty = offlinePool.filter((l) => CHAT_GROUP_HINTS.some((h) => l.group.includes(h)));
    const pool = chatty.length ? chatty : offlinePool;
    let pick = pool[Math.floor(Math.random() * pool.length)].text;
    if (pick === lastBubbleText && pool.length > 1) {
        pick = pool[Math.floor(Math.random() * pool.length)].text;
    }
    return pick;
}
/** 分组名归一化：去掉连接词/标点/空白，让「健康护眼」↔「健康与护眼」这类命名漂移能互相命中 */
function normalizeGroupName(name) {
    return name.replace(/[与和之的\s\-_·、，,。.；;：:！!？?（）()【】[\]「」『』]/g, '');
}
const pickRandom = (lines) => lines[Math.floor(Math.random() * lines.length)].text;
/** 按精确分组名取一句；无则沿同义组回退；仍无则做归一化包含匹配；再无返回 null */
function pickLineByGroup(group) {
    if (offlinePool.length === 0)
        return null;
    const tryGroup = (g) => {
        const hit = offlinePool.filter((l) => l.group === g);
        return hit.length ? hit : null;
    };
    const chain = [group, ...(GROUP_SYNONYMS[group] ?? [])];
    for (const g of chain) {
        const lines = tryGroup(g);
        if (lines)
            return pickRandom(lines);
    }
    // 兜底：语料小节命名与代码分组名漂移时（如「咖啡与骑行」「摸鱼提醒」），归一化后双向包含匹配
    const keys = chain.map(normalizeGroupName).filter((k) => k.length >= 2);
    if (keys.length === 0)
        return null;
    const fuzzy = offlinePool.filter((l) => {
        const n = normalizeGroupName(l.group);
        return !!n && keys.some((k) => n === k || n.includes(k) || k.includes(n));
    });
    return fuzzy.length ? pickRandom(fuzzy) : null;
}
/** 推送气泡（带 8s 最小间隔节流） */
function pushBubble(text) {
    if (!text)
        return;
    const now = Date.now();
    if (now - lastBubblePushAt < SCENE_BUBBLE_MIN_GAP_MS)
        return;
    lastBubblePushAt = now;
    sendToRenderer(contracts_1.IPC_UI_BUBBLE, { text });
    lastBubbleText = text;
}
/** 场景/事件入口：命中分组→按组冷却出气泡；组无台词则随机兜底 */
function handleSceneGroup(group) {
    if (!group)
        return;
    const now = Date.now();
    const last = sceneCooldownMs[group] ?? 0;
    if (now - last < SCENE_GROUP_GAP_MS)
        return;
    sceneCooldownMs[group] = now;
    const text = pickLineByGroup(group) ?? randomOfflineLine();
    if (text)
        pushBubble(text);
}
/** 随机冒泡定时器：首次 60–120s，此后每 60–150s 一句（闲时自言自语，去重上一句） */
function startOfflineBubbleTimer() {
    const tick = (delayMs) => {
        if (bubbleTimer !== null)
            clearTimeout(bubbleTimer);
        bubbleTimer = setTimeout(() => {
            const text = randomOfflineLine();
            if (text)
                pushBubble(text);
            tick(60000 + Math.random() * 90000);
        }, delayMs);
    };
    tick(60000 + Math.random() * 60000);
}
/** 模型切换时重载台词池（场景台词与当前人设一致） */
function reloadOfflinePoolForModel(modelName) {
    const resolver = bootRef?.resolver;
    if (!resolver)
        return;
    loadOfflinePool(resolver.knowledgeDirForModel(modelName || 'character'), modelName || 'character');
}
// —— 鼠标行为侦测（在光标轮询内累积）——
const MOUSE_IDLE_MS = 90000; // 静止 90s 视为“鼠标静止”事件
const MOUSE_SCENE_GAP_MS = 300000; // 鼠标类场景 5min 冷却
let lastMouseMovedAt = Date.now();
let lastMouseIdleSceneAt = 0;
let lastMouseActiveSceneAt = 0;
let mouseIdleFired = false;
/**
 * 全局光标轮询 → IPC_GLOBAL_CURSOR 推送（renderer 据此换算视线目标，
 * 实现"宠物望向鼠标"的自动视线跟随；鼠标移动时才推送，静止不发）。
 */
function startCursorTracking() {
    if (cursorTimer)
        return;
    const poll = () => {
        const win = mainWindow;
        if (!win || win.isDestroyed())
            return;
        const now = Date.now();
        try {
            const p = electron_1.screen.getCursorScreenPoint();
            const moved = !lastCursorSent || lastCursorSent.x !== p.x || lastCursorSent.y !== p.y;
            if (moved) {
                lastCursorSent = { x: p.x, y: p.y };
                lastMouseMovedAt = now;
                // 从“静止事件”恢复为活跃 → 触发一次“鼠标活跃”（与上次活跃气泡间隔 ≥5min）
                if (mouseIdleFired) {
                    mouseIdleFired = false;
                    if (now - lastMouseActiveSceneAt >= MOUSE_SCENE_GAP_MS) {
                        lastMouseActiveSceneAt = now;
                        handleSceneGroup('鼠标活跃');
                    }
                }
                sendToRenderer(contracts_1.IPC_GLOBAL_CURSOR, { x: p.x, y: p.y });
                // 点击穿透：把全局光标换算成"相对客户区"坐标交给渲染层做命中判定；
                // 光标离开窗口时立刻恢复可交互（否则移回来第一下会点不到）。
                if (clickThroughEnabled) {
                    try {
                        const b = win.getBounds();
                        const inside = p.x >= b.x && p.x < b.x + b.width && p.y >= b.y && p.y < b.y + b.height;
                        if (inside) {
                            const [cw, ch] = win.getContentSize();
                            // 客户区左上角的屏幕坐标 = 窗口左上角 + 边框内缩（无边框窗口通常为 0）
                            const cb = win.getContentBounds();
                            const relX = p.x - cb.x;
                            const relY = p.y - cb.y;
                            if (relX >= 0 && relY >= 0 && relX < cw && relY < ch) {
                                sendToRenderer(contracts_1.IPC_HIT_PROBE, { x: relX, y: relY });
                            }
                            else {
                                resetHitIgnore(win);
                            }
                        }
                        else {
                            resetHitIgnore(win);
                        }
                    }
                    catch {
                        /* 取几何失败时保守恢复可交互 */
                        resetHitIgnore(win);
                    }
                }
            }
            else if (!mouseIdleFired && now - lastMouseMovedAt >= MOUSE_IDLE_MS && now - lastMouseIdleSceneAt >= MOUSE_SCENE_GAP_MS) {
                // 静止超过 90s → “鼠标静止”事件
                mouseIdleFired = true;
                lastMouseIdleSceneAt = now;
                handleSceneGroup('鼠标静止');
            }
        }
        catch {
            /* screen 暂不可用等场景静默，下轮重试 */
        }
    };
    poll();
    cursorTimer = setInterval(poll, CURSOR_POLL_MS);
}
// ------------------------------------------------------------------ 点击穿透
/**
 * 点击穿透：透明区域不拦截鼠标，只有角色身体范围可交互。
 *
 * 判定分工：主进程知道窗口位置与全局光标 → 换算出**相对客户区**坐标发给渲染层；
 * 渲染层用命中遮罩（画布降采样出的 alpha 位图）判断该点是否在角色身上。
 * 为什么不让主进程判：只有渲染层拿得到最终合成后的像素，那才是用户看到/点到的东西。
 *
 * 三条安全约束：
 *   1. 默认**关闭**（设置项 clickThrough），未开启时窗口行为与从前完全一致；
 *   2. 渲染层报 ok=false（暂无可靠数据）时一律**不穿透**——宁可不生效，也不能让窗口
 *      变成看不见的挡板把桌面点击全吃掉；
 *   3. 状态从不跨窗口隐藏/显示保留，且托盘给了强制关闭的逃生口。
 */
let hitIgnoreActive = false;
let clickThroughEnabled = false;
/** 记录 enable 状态与上次探测时间，供调试与兜底 */
let lastHitProbeAt = 0;
function setHitIgnore(win, ignore) {
    if (!win || win.isDestroyed())
        return;
    if (ignore === hitIgnoreActive)
        return;
    hitIgnoreActive = ignore;
    try {
        // forward:true —— 穿透状态下仍然把鼠标移动事件转给本窗口，
        // 否则渲染层收不到探测、也就永远无法在移回角色身上时恢复可交互。
        win.setIgnoreMouseEvents(ignore, { forward: true });
    }
    catch (err) {
        console.warn('[main] 设置点击穿透失败：', err.message);
        hitIgnoreActive = false;
    }
}
/** 关闭穿透并把窗口恢复为可交互（隐藏/显示/退出/关设置时都要调） */
function resetHitIgnore(win) {
    hitIgnoreActive = false;
    if (!win || win.isDestroyed())
        return;
    try {
        win.setIgnoreMouseEvents(false);
    }
    catch {
        /* ignore */
    }
}
/** 只读：当前是否处于"忽略鼠标（即穿透）"状态 —— 供调试自检与自动化验证 */
function getHitIgnoreState() {
    return hitIgnoreActive;
}
/** 只读：设置里是否开启了点击穿透 */
function clickThroughEnabledOn() {
    return clickThroughEnabled;
}
function installClickThrough() {
    clickThroughEnabled = (0, chatClient_1.loadAppSettings)().clickThrough === true;
    electron_1.ipcMain.on(contracts_1.IPC_HIT_RESULT, (event, payload) => {
        const win = electron_1.BrowserWindow.fromWebContents(event.sender);
        if (!win || win !== mainWindow)
            return;
        if (!clickThroughEnabled) {
            // 设置被关掉后必须立刻恢复可交互，否则窗口会停在"穿透"状态点不动
            if (hitIgnoreActive)
                resetHitIgnore(win);
            return;
        }
        if (win.isDestroyed() || !win.isVisible())
            return;
        lastHitProbeAt = Date.now();
        // 覆盖层面板（设置/待办/右键菜单/思考浮窗）就在本窗口内部，而 setIgnoreMouseEvents
        // 是**整窗**生效的：面板打开时若仍按"光标是否在角色身上"判定，光标落到面板以外就会被
        // 判成可穿透，面板自己也点不动。所以这种情况一律强制保持可交互。
        if (payload && payload.overlay) {
            if (hitIgnoreActive)
                resetHitIgnore(win);
            return;
        }
        setHitIgnore(win, Boolean(payload && payload.ignore));
    });
    /**
     * 设置页可能在运行中改这一项。轮询本身很便宜（读一次小 JSON 也不贵，但没必要），
     * 所以按 2s 节流；关掉时立刻恢复可交互——否则窗口会停在"穿透"状态，用户点不动。
     */
    setInterval(() => {
        let next = false;
        try {
            next = (0, chatClient_1.loadAppSettings)().clickThrough === true;
        }
        catch {
            /* 读失败按关闭处理 */
        }
        if (next === clickThroughEnabled)
            return;
        clickThroughEnabled = next;
        const win = mainWindow;
        if (!next && win) {
            resetHitIgnore(win);
            console.log('[main] 点击穿透已关闭，窗口恢复可交互');
        }
        else {
            console.log('[main] 点击穿透已开启');
        }
    }, 2000);
}
// —— 时间型事件（每天去重触发；整点报时默认关闭）——
const ENABLE_HOURLY_REPORT = false; // 设 true 开启整点报时
const LONG_SESSION_MINUTES = 50; // 连续活跃满 50 分钟 → 起身/护眼提醒（轮流）
let timedEventTimer = null;
let lastMorningDate = '';
let lastNightDate = '';
let lastWeekendDate = '';
let lastHourDate = '';
let activeMinutes = 0; // 非鼠标静止状态下累计的活跃分钟数
let longSessionToggle = false; // 长时间工作 / 健康护眼 交替
function startTimedEvents() {
    if (timedEventTimer)
        return;
    timedEventTimer = setInterval(() => {
        try {
            const now = new Date();
            const dayStr = `${now.getFullYear()}-${now.getMonth() + 1}-${now.getDate()}`;
            const hour = now.getHours();
            const day = now.getDay();
            if (hour >= 5 && hour <= 9 && lastMorningDate !== dayStr) {
                lastMorningDate = dayStr;
                handleSceneGroup('早安问候');
            }
            if (hour >= 23 && lastNightDate !== dayStr) {
                lastNightDate = dayStr;
                handleSceneGroup('深夜护眼');
            }
            if ((day === 0 || day === 6) && lastWeekendDate !== dayStr) {
                lastWeekendDate = dayStr;
                handleSceneGroup('周末放松');
            }
            if (ENABLE_HOURLY_REPORT && now.getMinutes() <= 5 && lastHourDate !== `${dayStr}:${hour}`) {
                lastHourDate = `${dayStr}:${hour}`;
                handleSceneGroup('整点报时');
            }
            // 连续活跃计时：鼠标不在静止状态才累计，满 50 分钟提醒一次（长时间工作 / 健康护眼 交替）
            if (mouseIdleFired) {
                activeMinutes = 0;
            }
            else if (++activeMinutes >= LONG_SESSION_MINUTES) {
                activeMinutes = 0;
                longSessionToggle = !longSessionToggle;
                handleSceneGroup(longSessionToggle ? '长时间工作' : '健康护眼');
            }
        }
        catch {
            /* 时间事件异常不阻塞 */
        }
    }, 60000);
}
// ------------------------------------------------------------------ 单实例锁
// 多次双击 exe / 重复启动时只保留一个主进程：后启动的实例立即退出，
// 并通过 second-instance 事件唤起既有窗口（避免桌面出现多个宠物弹窗）。
if (!electron_1.app.requestSingleInstanceLock()) {
    electron_1.app.quit();
}
else {
    electron_1.app.on('second-instance', () => {
        // 已有实例收到"再次启动"：恢复最小化并聚焦既有主窗口
        if (mainWindow) {
            if (mainWindow.isMinimized())
                mainWindow.restore();
            if (!mainWindow.isVisible())
                mainWindow.show();
            mainWindow.focus();
        }
    });
}
// ------------------------------------------------------------------ 渲染入口
/** 优先用 staticServer 提供渲染入口（同源：模型 fetch / 纹理加载无 CORS 问题，契约建议） */
async function loadRenderer(win, staticRoot, baseUrl, 
/** 查询参数：{} = 完整桌宠页面；{panel:'chat'} = 对话气泡窗；{panel:'think'} = 思考浮窗 */
params = {}) {
    const debugEnabled = Object.keys(process.env).some((key) => key.startsWith('PET_'));
    const queryParams = debugEnabled ? { ...params, debug: '1' } : params;
    const qs = new URLSearchParams(queryParams).toString();
    const query = qs ? `?${qs}` : '';
    // 1) http：staticRoot 下 renderer/index.html 或 index.html（开发 public/、打包 resources/）
    for (const rel of ['renderer/index.html', 'index.html']) {
        if (fs.existsSync(path.join(staticRoot, rel))) {
            const url = `${baseUrl}/${rel}${query}`;
            try {
                await win.loadURL(url);
                return true;
            }
            catch (err) {
                console.warn(`[main] loadURL(${url}) 失败，尝试下一入口：`, err.message);
            }
        }
    }
    // 2) file：打包后 renderer 若在 asar 内（app.getAppPath()），退回 loadFile
    for (const file of [
        path.join(electron_1.app.getAppPath(), 'renderer', 'index.html'),
        path.join(electron_1.app.getAppPath(), 'public', 'renderer', 'index.html'),
        // 3) 兜底：dist/renderer（electron-builder files: dist/**，打包后常驻 asar 内）。
        //    便携/extraResources 任一环节缺失（exe 被移动、杀软隔离临时解包等）时仍能出界面，
        //    而不是让窗口显示裸 “404 Not Found”。
        path.join(electron_1.app.getAppPath(), 'dist', 'renderer', 'index.html'),
    ]) {
        if (fs.existsSync(file)) {
            try {
                await win.loadFile(file, qs ? { query: queryParams } : undefined);
                return true;
            }
            catch (err) {
                console.warn(`[main] loadFile(${file}) 失败：`, err.message);
            }
        }
    }
    // 4) 全部入口缺失：给出可读引导页（含修复指引），杜绝裸 404 白窗
    console.warn(`[main] renderer 入口全部缺失（staticRoot=${staticRoot}），显示引导页`);
    const guide = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><title>Pet 未就绪</title></head>
<body style="font-family:system-ui,sans-serif;background:#14171f;color:#e8ecf4;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0">
<div style="max-width:440px;text-align:center"><h2>🐾 Pet 渲染入口缺失</h2>
<p>未找到 <code>renderer/index.html</code>。</p>
<ul style="text-align:left;font-size:13px;line-height:1.8">
<li>开发运行：先执行 <code>npm run build:all</code> 生成 <code>public/renderer</code>。</li>
<li>便携版：确认 exe 未被移动/截断，且杀毒软件未隔离其临时解包内容；重新双击 exe 一次。</li>
</ul></div></body></html>`;
    try {
        await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(guide));
    }
    catch (err) {
        console.warn('[main] 引导页加载失败：', err.message);
    }
    return false;
}
/**
 * 取回上次的桌宠窗口位置/尺寸（位置记忆）。
 * 只在窗口与某个显示器工作区**确有重叠**时才沿用：换了显示器、拔了外接屏、或分辨率变小之后，
 * 旧坐标可能落在可见区域之外——那就当作没有记录，回落到默认位置，免得桌宠"消失"。
 */
/**
 * 这组矩形是否落在某个显示器工作区内（至少露出 minVisible × minVisible）。
 * 只压到一条边不算"看得见"，否则桌宠会贴到屏幕外侧、用户以为它没了。
 */
function isBoundsVisibleOnSomeDisplay(bounds, minVisible = 40) {
    try {
        return electron_1.screen.getAllDisplays().some((d) => {
            const a = d.workArea;
            const ow = Math.min(bounds.x + bounds.width, a.x + a.width) - Math.max(bounds.x, a.x);
            const oh = Math.min(bounds.y + bounds.height, a.y + a.height) - Math.max(bounds.y, a.y);
            return ow >= minVisible && oh >= minVisible;
        });
    }
    catch {
        return false;
    }
}
function restorePetBounds() {
    const cfg = (0, chatClient_1.loadAppSettings)();
    const { petX, petY, petW, petH } = cfg;
    if (![petX, petY, petW, petH].every((v) => typeof v === 'number' && Number.isFinite(v)))
        return null;
    const bounds = { x: petX, y: petY, width: petW, height: petH };
    if (!isBoundsVisibleOnSomeDisplay(bounds)) {
        console.warn('[main] 上次的桌宠位置已不在任何显示器内，回落到默认位置');
        return null;
    }
    return bounds;
}
/** 窗口移动/缩放后把位置写回设置（读-改-写：saveAppSettings 是整体覆盖，绝不能只传几何字段） */
let petBoundsSaveTimer = null;
function savePetBoundsSoon(win) {
    if (petBoundsSaveTimer)
        clearTimeout(petBoundsSaveTimer);
    // 防抖：拖动过程中 move 会高频触发，不必每一像素都落盘
    petBoundsSaveTimer = setTimeout(() => {
        petBoundsSaveTimer = null;
        if (!win || win.isDestroyed())
            return;
        try {
            const b = win.getBounds();
            (0, chatClient_1.saveAppSettings)({
                ...(0, chatClient_1.loadAppSettings)(),
                petX: b.x,
                petY: b.y,
                petW: b.width,
                petH: b.height,
            });
        }
        catch (err) {
            console.warn('[main] 保存桌宠窗口位置失败：', err.message);
        }
    }, 600);
}
function createWindow(resolver, srv) {
    const saved = restorePetBounds();
    const win = new electron_1.BrowserWindow({
        width: saved ? saved.width : WINDOW_WIDTH,
        height: saved ? saved.height : WINDOW_HEIGHT,
        // 有记录就按记录摆；否则不指定坐标，交给系统居中
        ...(saved ? { x: saved.x, y: saved.y } : {}),
        transparent: true,
        frame: false,
        alwaysOnTop: true,
        resizable: true,
        // 注：这里曾设 skipTaskbar: true（不占任务栏、不进 Alt-Tab）。已移除。
        // 原因：与 show:false 类的隐藏窗口叠加时，一旦窗口没能正常显示，用户不仅看不到窗口，
        // 连"程序在跑"的迹象都没有（任务栏与 Alt-Tab 里都找不到），只能靠任务管理器。
        // 桌宠是应用主窗口，保留任务栏存在感更安全——出问题时至少能找到它、能关掉它。
        // 关掉系统窗口阴影：透明无边框窗口上会渲染成角色外圈的灰色光晕，看起来就是毛边/脏边
        hasShadow: false,
        backgroundColor: '#00000000',
        webPreferences: {
            // 编译产物布局：main/main.js 与 preload/preload.js 同级目录
            preload: path.join(__dirname, '..', 'preload', 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: false, // preload 用 contextBridge；契约以 contextIsolation:true + nodeIntegration:false 为准
        },
    });
    mainWindow = win;
    // 位置记忆：移动或缩放后落盘（防抖）
    win.on('move', () => savePetBoundsSoon(win));
    win.on('resize', () => savePetBoundsSoon(win));
    win.on('closed', () => {
        if (mainWindow === win)
            mainWindow = null;
        // 桌宠窗口关闭 = 退出 Pet：捎带关掉浮窗，否则 window-all-closed 不会触发、进程残留
        closeChatWindowWindow();
        closeThinkWindowWindow();
    });
    if (process.env.DEVTOOLS === '1') {
        win.webContents.openDevTools({ mode: 'detach' });
    }
    const localOrigin = new URL(srv.baseUrl()).origin;
    win.webContents.on('will-navigate', (event, url) => {
        try {
            const target = new URL(url);
            // 只允许停留在本地静态服务；页面若试图跳到 file:/data:/about:/远程地址一律拦下
            // （启动期的引导页由 loadURL/loadFile 直接加载，不经过本事件，不受影响）
            if (target.origin !== localOrigin || target.hostname !== '127.0.0.1') {
                console.warn(`[main] 已拦截渲染器导航：${url}`);
                event.preventDefault();
            }
        }
        catch {
            event.preventDefault();
        }
    });
    win.webContents.setWindowOpenHandler(({ url }) => {
        console.warn(`[main] 拒绝渲染器打开新窗口：${url}`);
        return { action: 'deny' };
    });
    win.webContents.on('context-menu', (event, params) => {
        event.preventDefault();
        win.webContents.send(contracts_1.IPC_CONTEXT_MENU, { x: params.x, y: params.y });
    });
    // 渲染层每次加载完（含重载）同步一次「对话是否由独立窗口接管」，否则重载后状态丢失、
    // 桌宠窗口会把聊天窗口已经在落盘的回复再写一遍（同一条回复落两次）
    win.webContents.on('did-finish-load', () => {
        notifyChatWindowState(isChatWindowVisible());
    });
    // 桌宠被拖动时，气泡窗跟着走（用户自己拖过气泡则不再跟随）
    win.on('move', () => followPetForBubble());
    void loadRenderer(win, resolver.staticRoot(), srv.baseUrl());
    return win;
}
// ------------------------------------------------------------------ 对话气泡窗 / 思考浮窗
// 对话框不再盖在模型上，也不再用一个大窗口：改成
//   ① 对话气泡窗（?panel=chat）—— 340x240 无边框透明小窗，浮在桌宠正上方，底部有个指向桌宠的小尾巴；
//   ② 思考浮窗（?panel=think）—— 无边框透明面板，摆在桌宠旁边（原来那个大窗的位置），
//      向 AI 提问时自动打开、AI 答完自动收起。
/** 统一的安全推送（窗口可能正在关闭） */
function sendToWindow(win, channel, payload) {
    if (!win || win.isDestroyed() || win.webContents.isDestroyed())
        return false;
    try {
        win.webContents.send(channel, payload);
        return true;
    }
    catch {
        return false;
    }
}
function isChatWindowOpen() {
    return !!chatWindow && !chatWindow.isDestroyed();
}
/** 小工具：窗口引用可能为 null */
function isChatWindowDestroyed(win) {
    return !win || win.isDestroyed();
}
/** 真正"看得见"的聊天窗口（隐藏时不能往里弹提问框，否则用户看不到、AI 白等 120s） */
function isChatWindowVisible() {
    return isChatWindowOpen() && chatWindow.isVisible();
}
function isThinkWindowOpen() {
    return !!thinkWindow && !thinkWindow.isDestroyed();
}
function isThinkWindowVisible() {
    return isThinkWindowOpen() && thinkWindow.isVisible();
}
/** 通知桌宠窗口：对话气泡窗开了/关了（桌宠据此收起自己的输入条与浮窗） */
function notifyChatWindowState(open) {
    sendToWindow(mainWindow, contracts_1.IPC_CHAT_WINDOW_STATE, { open });
    sendToWindow(chatWindow, contracts_1.IPC_THINK_WINDOW_STATE, { open: isThinkWindowVisible() }); // 气泡窗里的菜单项状态
}
/** 通知相关窗口：思考浮窗开了/关了 */
function notifyThinkWindowState(open) {
    sendToWindow(mainWindow, contracts_1.IPC_THINK_WINDOW_STATE, { open });
    sendToWindow(chatWindow, contracts_1.IPC_THINK_WINDOW_STATE, { open });
}
/** 桌宠当前所在的显示器工作区（多显示器：按桌宠所在屏算，别跑到另一块屏上） */
function petWorkArea() {
    const pet = mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
    if (!pet)
        return null;
    const [px, py] = pet.getPosition();
    const [pw, ph] = pet.getSize();
    return electron_1.screen.getDisplayMatching({ x: px, y: py, width: pw, height: ph }).workArea;
}
/** 两个矩形重叠面积（0 = 不重叠） */
function overlapArea(a, b) {
    const ow = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
    const oh = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
    return ow > 0 && oh > 0 ? ow * oh : 0;
}
/** 取一个"看得见"的窗口矩形；隐藏/销毁时返回 null（=不参与避让） */
function windowRect(win) {
    if (!win || win.isDestroyed() || !win.isVisible())
        return null;
    try {
        const b = win.getBounds();
        return { x: b.x, y: b.y, width: b.width, height: b.height };
    }
    catch {
        return null;
    }
}
function clampToArea(value, min, max) {
    return Math.max(min, Math.min(value, max));
}
/**
 * 列出气泡可以待的位置（绝对坐标，优先级从高到低）：
 *   ① 角色头顶上方（居中）→ ② 桌宠下方 → ③ 左右侧面 → ④ 上方但左右让开一点
 * 侧面是"上方真的没空间"时的正确兜底；会不会压到别的浮窗由 pickBubbleSpot 负责筛。
 */
function bubbleSpots(px, py, pw, ph, w, h, area) {
    const headRel = Math.max(0, Math.min(petModelTop, ph - 40));
    const aboveY = py + headRel - h - CHAT_BUBBLE_GAP;
    const belowY = py + ph + CHAT_BUBBLE_GAP;
    const sideY = clampToArea(py + Math.round((ph - h) / 2), area.y, area.y + area.height - h);
    const centeredX = px + Math.round((pw - w) / 2);
    const aboveOk = aboveY + CHAT_BUBBLE_TOP_TOLERANCE >= area.y; // 夹到屏幕顶边后仍在角色头顶之上
    const belowOk = py + ph + CHAT_BUBBLE_GAP + h <= area.y + area.height;
    const spots = [];
    if (aboveOk)
        spots.push({ x: centeredX, y: aboveY, tail: 'down' });
    if (belowOk)
        spots.push({ x: centeredX, y: belowY, tail: 'up' });
    spots.push({ x: px + pw + CHAT_BUBBLE_GAP, y: sideY, tail: 'none' }); // 右侧
    spots.push({ x: px - CHAT_BUBBLE_GAP - w, y: sideY, tail: 'none' }); // 左侧
    if (aboveOk) {
        // 上方被别的浮窗占了时，往左右挪一挪仍然贴头顶（比直接跳侧面更贴近预期）
        const shift = Math.round(w * 0.5);
        spots.push({ x: centeredX - shift, y: aboveY, tail: 'down' });
        spots.push({ x: centeredX + shift, y: aboveY, tail: 'down' });
    }
    return spots;
}
/**
 * 从候选位里按**自然优先级**挑一个不压到 obstacles 的；全都压到才取重叠面积最小的那个。
 * 注意不能按"当前尾巴朝向优先"来排序——那样一旦退到侧面就再也回不到头顶上方了
 * （实测：放大到顶跳侧面后，缩回原大小仍赖在侧面）。优先级天然就是 上 > 下 > 侧。
 */
function pickBubbleSpot(spots, w, h, area, obstacles) {
    let best = spots[0];
    let bestScore = Number.POSITIVE_INFINITY;
    for (const spot of spots) {
        const rect = {
            x: clampToArea(spot.x, area.x, area.x + area.width - w),
            y: clampToArea(spot.y, area.y, area.y + area.height - h),
            width: w,
            height: h,
        };
        const score = obstacles.reduce((sum, o) => sum + overlapArea(rect, o), 0);
        if (score === 0)
            return { ...spot, x: rect.x, y: rect.y };
        if (score < bestScore) {
            bestScore = score;
            best = { ...spot, x: rect.x, y: rect.y };
        }
    }
    return best;
}
/**
 * 算气泡该待的绝对位置：候选位 → 避开另一个浮窗（思考浮窗）→ 夹进工作区。
 * 纯算术，不查屏幕、不打日志，所以滚轮缩放时可以每帧重算（跟手的关键）。
 */
function resolveBubbleSpot(pw, ph, w, h, area) {
    const pet = mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
    const [px, py] = pet ? pet.getPosition() : [area.x, area.y];
    const obstacles = [];
    const think = windowRect(thinkWindow);
    if (think)
        obstacles.push(think);
    return pickBubbleSpot(bubbleSpots(px, py, pw, ph, w, h, area), w, h, area, obstacles);
}
/**
 * 把对话气泡窗摆在角色"头顶上方"（放不下才依次退到下方 / 侧面），并返回尾巴朝向。
 * 摆好之后把"气泡相对桌宠的偏移"记下来，之后桌宠移动/模型缩放都靠这个偏移直接跟着走。
 */
function placeChatBubble(win) {
    const pet = mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
    const area = petWorkArea();
    if (!pet || !area)
        return 'down';
    try {
        const [px, py] = pet.getPosition();
        const [pw, ph] = pet.getSize();
        // 尺寸一律用配置值：拿 getSize() 会把操作系统的 1~2px 舍入误差滚雪球（实测 270 → 279）
        const w = CHAT_WINDOW_WIDTH;
        const h = CHAT_WINDOW_HEIGHT;
        const spot = resolveBubbleSpot(pw, ph, w, h, area);
        const x = clampToArea(spot.x, area.x, area.x + area.width - w);
        const y = clampToArea(spot.y, area.y, area.y + area.height - h);
        moveBubbleTo(win, x, y, w, h);
        setBubbleAnchor(spot.x - px, spot.y - py);
        console.log(`[main] 气泡窗定位：桌面工作区=(${area.x},${area.y} ${area.width}x${area.height}) ` +
            `桌宠=(${px},${py} ${pw}x${ph}) 角色顶=${Math.round(petModelTop)} 气泡=${w}x${h} → (${x},${y}) 尾巴=${spot.tail}`);
        return spot.tail;
    }
    catch (err) {
        console.warn('[main] 气泡窗定位失败（用系统默认位置）：', err.message);
        return 'down';
    }
}
/** 记下气泡相对桌宠的锚点偏移（"自动跟随"模式下的一切跟随都以它为准） */
function setBubbleAnchor(dx, dy) {
    bubbleOffset = { dx, dy };
    bubbleAnchorManual = false;
}
/**
 * 移动气泡窗：用 setBounds 固定宽高。
 * 只调 setPosition 时，Windows 在非整数缩放（如 150%）下会顺手把尺寸重算一次，
 * 拖久了气泡会一像素一像素地"长大"（实测 270 → 279），所以必须把尺寸钉死。
 *
 * 另外打个"这是我们在摆"的时间窗：窗口 'move' 事件里靠它区分"自己摆的"和"用户拖的"。
 * 不这么做的话，贴屏幕边缘被夹回来的那一下会被当成用户拖动，偏移量被越夹越小（实测会飘）。
 */
let bubbleSelfMoveUntil = 0;
function moveBubbleTo(win, x, y, w, h) {
    try {
        bubbleSelfMoveUntil = Date.now() + 150;
        win.setBounds({ x: Math.round(x), y: Math.round(y), width: Math.round(w), height: Math.round(h) });
    }
    catch (err) {
        console.warn('[main] 气泡窗移动失败：', err.message);
    }
}
/**
 * 把思考浮窗摆在桌宠旁边（右侧优先，放不下改左侧）——原来那个大窗口的位置。
 * 排布用"打分挑位"：**绝不允许压到对话气泡窗**（硬约束），其次尽量不压到桌宠。
 */
function placeThinkPanel(win) {
    const pet = mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
    const area = petWorkArea();
    if (!pet || !area)
        return;
    try {
        const [px, py] = pet.getPosition();
        const [pw, ph] = pet.getSize();
        const w = THINK_WINDOW_WIDTH;
        const h = THINK_WINDOW_HEIGHT;
        const petRect = { x: px, y: py, width: pw, height: ph };
        const bubble = windowRect(chatWindow);
        const bottomY = clampToArea(py + ph - h, area.y, area.y + area.height - h);
        const topY = clampToArea(py, area.y, area.y + area.height - h);
        const midY = clampToArea(py + Math.round((ph - h) / 2), area.y, area.y + area.height - h);
        const rightX = px + pw + CHAT_BUBBLE_GAP;
        const leftX = px - CHAT_BUBBLE_GAP - w;
        const candidates = [
            { x: rightX, y: bottomY }, // ① 右侧、底边对齐（原大窗口的位置）
            { x: leftX, y: bottomY }, // ② 左侧
            { x: rightX, y: topY }, // ③ 右侧、顶边对齐
            { x: leftX, y: topY }, // ④ 左侧、顶边对齐
            { x: rightX, y: midY },
            { x: leftX, y: midY },
            { x: area.x + area.width - w - 8, y: topY }, // ⑤ 屏幕右缘
            { x: area.x + 8, y: topY }, // ⑥ 屏幕左缘
        ];
        let best = candidates[0];
        let bestScore = Number.POSITIVE_INFINITY;
        for (const cand of candidates) {
            const rect = {
                x: clampToArea(cand.x, area.x, area.x + area.width - w),
                y: clampToArea(cand.y, area.y, area.y + area.height - h),
                width: w,
                height: h,
            };
            // 压到气泡 = 硬禁止（×1000）；压到桌宠只是不优先
            const score = (bubble ? overlapArea(rect, bubble) * 1000 : 0) + overlapArea(rect, petRect);
            if (score === 0) {
                best = { x: rect.x, y: rect.y };
                bestScore = 0;
                break;
            }
            if (score < bestScore) {
                bestScore = score;
                best = { x: rect.x, y: rect.y };
            }
        }
        movePanelWindow(win, best.x, best.y, w, h);
        console.log(`[main] 思考浮窗定位：→ (${best.x},${best.y}) ${w}x${h}` +
            (bestScore > 0 ? `（空间不足，仍与其它窗口重叠 ${bestScore}）` : '（与气泡/桌宠均不重叠）'));
    }
    catch (err) {
        console.warn('[main] 思考浮窗定位失败（用系统默认位置）：', err.message);
    }
}
/** 浮窗移动：同样用 setBounds 固定尺寸（避免非整数缩放下被系统重算尺寸） */
function movePanelWindow(win, x, y, w, h) {
    try {
        win.setBounds({ x: Math.round(x), y: Math.round(y), width: Math.round(w), height: Math.round(h) });
    }
    catch (err) {
        console.warn('[main] 浮窗移动失败：', err.message);
    }
}
/** 无边框透明小窗的公共配置（气泡窗 / 思考浮窗共用） */
function panelWindowOptions(width, height, title) {
    return {
        width,
        height,
        title,
        frame: false,
        transparent: true,
        backgroundColor: '#00000000',
        hasShadow: false,
        resizable: false,
        maximizable: false,
        minimizable: false,
        fullscreenable: false,
        skipTaskbar: true, // 只是贴纸式浮窗，不占任务栏
        autoHideMenuBar: true,
        show: false,
        // 桌宠窗口是置顶的：浮窗不置顶就会被动不动盖住，故同样置顶
        alwaysOnTop: true,
        webPreferences: {
            preload: path.join(__dirname, '..', 'preload', 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: false,
        },
    };
}
/** 浮窗共用的导航拦截（只允许停在本机静态服务里） */
function lockNavigation(win, srv, label) {
    const localOrigin = new URL(srv.baseUrl()).origin;
    win.webContents.on('will-navigate', (event, url) => {
        try {
            const target = new URL(url);
            if (target.origin !== localOrigin || target.hostname !== '127.0.0.1') {
                console.warn(`[main] 已拦截${label}导航：${url}`);
                event.preventDefault();
            }
        }
        catch {
            event.preventDefault();
        }
    });
    win.webContents.setWindowOpenHandler(({ url }) => {
        console.warn(`[main] 拒绝${label}打开新窗口：${url}`);
        return { action: 'deny' };
    });
}
function createChatWindow(resolver, srv) {
    const win = new electron_1.BrowserWindow(panelWindowOptions(CHAT_WINDOW_WIDTH, CHAT_WINDOW_HEIGHT, '对话气泡'));
    chatWindow = win;
    // 记住这次的尾巴朝向，等页面加载完再作为查询参数传给渲染层（决定 CSS 画朝上还是朝下的尾巴）
    chatBubbleTail = placeChatBubble(win);
    // 用户自己拖动气泡（顶栏 app-region 拖动）→ 更新"相对桌宠的偏移"，之后照旧跟随平移。
    // 注意 Electron 的 'moved' 只在 macOS 触发，Windows 上要听 'move'；
    // 自己 setBounds 也会触发它，所以用 6px 容差判断"是不是我们摆的"。
    win.on('move', () => {
        const pet = mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
        if (!pet || win.isDestroyed())
            return;
        if (Date.now() < bubbleSelfMoveUntil)
            return; // 我们自己 setBounds 引起的事件
        try {
            const [x, y] = win.getPosition();
            const [px, py] = pet.getPosition();
            const dx = x - px;
            const dy = y - py;
            const off = bubbleOffset;
            if (off && Math.abs(dx - off.dx) <= 6 && Math.abs(dy - off.dy) <= 6)
                return; // 我们摆的
            bubbleOffset = { dx, dy };
            bubbleAnchorManual = true; // 手动摆过之后，缩放模型不再把它吸回锚点
        }
        catch {
            /* ignore */
        }
    });
    // 用户点 × / Esc 只是隐藏：位置、对话渲染状态都留着，下次打开原样回来。
    // （真正销毁只发生在 closeChatWindowWindow()：IPC 关闭、桌宠退出、应用退出）
    win.on('close', (event) => {
        if (appQuitting || win.isDestroyed())
            return; // 退出流程：放行，否则 app.quit() 永远收不了尾
        event.preventDefault();
        win.hide();
        notifyChatWindowState(false);
    });
    win.on('closed', () => {
        if (chatWindow === win)
            chatWindow = null;
        notifyChatWindowState(false);
    });
    if (process.env.DEVTOOLS === '1') {
        win.webContents.openDevTools({ mode: 'detach' });
    }
    lockNavigation(win, srv, '气泡窗');
    return win;
}
/** 打开（不存在则创建）对话气泡窗；渲染入口缺失时返回 ok:false，渲染层回退窗口内输入条 */
async function openChatWindow(resolver, srv) {
    if (isChatWindowOpen()) {
        const win = chatWindow;
        if (win.isMinimized())
            win.restore();
        repositionBubble(win); // 桌宠可能被拖走了：重新贴着它上方出现
        win.show();
        win.focus();
        notifyChatWindowState(true);
        return { ok: true };
    }
    let win;
    try {
        win = createChatWindow(resolver, srv);
    }
    catch (err) {
        chatWindow = null;
        return { ok: false, error: `气泡窗创建失败：${err.message ?? String(err)}` };
    }
    const ok = await loadRenderer(win, resolver.staticRoot(), srv.baseUrl(), {
        panel: 'chat',
        tail: chatBubbleTail,
    });
    if (!ok) {
        try {
            win.destroy();
        }
        catch {
            /* ignore */
        }
        chatWindow = null;
        return { ok: false, error: '渲染入口缺失，已回退到窗口内对话条' };
    }
    win.show();
    win.focus();
    notifyChatWindowState(true);
    console.log(`[main] 对话气泡窗已打开（尾巴=${chatBubbleTail}，不遮挡桌宠）`);
    return { ok: true };
}
/** 气泡窗已存在时重新贴回桌宠上方（再次打开时） */
function repositionBubble(win) {
    const tail = placeChatBubble(win);
    if (tail !== chatBubbleTail) {
        chatBubbleTail = tail;
        sendToWindow(win, contracts_1.IPC_CHAT_WINDOW_STATE, { open: true, tail }); // 渲染层据此换尾巴朝向
    }
}
/**
 * 桌宠移动 / 模型缩放 → 气泡同拍跟着挪。
 * 关键点：
 *   1. 走候选位挑选（纯算术）+ 相对偏移，不做显示器查询、不重新测量、不打日志；
 *   2. 拖动时由拖动 IPC handler 在同一 tick 里直接调用（不等窗口 'move' 事件回传），否则会慢半拍；
 *   3. 每帧都会避开思考浮窗：两个浮窗永不互相遮挡。
 * 贴到屏幕边缘时只夹回显示位置，偏移本身保留，桌宠拖回来气泡会跟回来。
 */
function followPetForBubble() {
    if (!isChatWindowVisible())
        return;
    const win = chatWindow;
    const pet = mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
    const area = petWorkArea();
    if (!pet || !area)
        return;
    try {
        const [px, py] = pet.getPosition();
        const [pw, ph] = pet.getSize();
        const w = CHAT_WINDOW_WIDTH;
        const h = CHAT_WINDOW_HEIGHT;
        // 自动模式每帧重新挑候选位（避开思考浮窗）；手动摆过就按用户给的位置跟随
        let x;
        let y;
        let tail = chatBubbleTail;
        if (bubbleAnchorManual && bubbleOffset) {
            x = px + bubbleOffset.dx;
            y = py + bubbleOffset.dy;
            const relDy = bubbleOffset.dy;
            tail = relDy + h <= petModelTop ? 'down' : relDy >= ph ? 'up' : 'none';
        }
        else {
            const spot = resolveBubbleSpot(pw, ph, w, h, area);
            x = spot.x;
            y = spot.y;
            tail = spot.tail;
            setBubbleAnchor(spot.x - px, spot.y - py);
        }
        moveBubbleTo(win, clampToArea(x, area.x, area.x + area.width - w), clampToArea(y, area.y, area.y + area.height - h), w, h);
        if (tail !== chatBubbleTail) {
            chatBubbleTail = tail;
            sendToWindow(win, contracts_1.IPC_CHAT_WINDOW_STATE, { open: true, tail });
        }
        if (process.env.PET_ZOOM_TEST === '1') {
            const [bx, by] = win.getPosition();
            const think = windowRect(thinkWindow);
            const bubbleRect = { x: bx, y: by, width: w, height: h };
            const ov = think ? overlapArea(bubbleRect, think) : 0;
            console.log(`[main][debug] zoom 角色顶=${petModelTop} 气泡=(${bx},${by}) 尾巴=${chatBubbleTail} ` +
                `思考窗=${think ? `(${think.x},${think.y} ${think.width}x${think.height})` : '隐藏'} 与气泡重叠=${ov}`);
        }
    }
    catch (err) {
        console.warn('[main] 气泡跟随桌宠失败：', err.message);
    }
}
/** 关闭对话气泡窗（桌宠窗口关闭 / IPC 请求 / 应用退出时调用） */
function closeChatWindowWindow() {
    const win = chatWindow;
    chatWindow = null;
    if (win && !win.isDestroyed()) {
        try {
            win.destroy(); // destroy：不经过 beforeunload，避免渲染层卡住导致窗口关不掉
        }
        catch {
            /* ignore */
        }
    }
    notifyChatWindowState(false);
}
// ---------------------------------------------------------------- 思考浮窗
function createThinkWindow(resolver, srv) {
    const win = new electron_1.BrowserWindow(panelWindowOptions(THINK_WINDOW_WIDTH, THINK_WINDOW_HEIGHT, '思考过程'));
    thinkWindow = win;
    placeThinkPanel(win);
    win.on('close', (event) => {
        if (appQuitting || win.isDestroyed())
            return;
        event.preventDefault();
        win.hide();
        notifyThinkWindowState(false);
        followPetForBubble(); // 思考浮窗让开了 → 气泡可以回到更合适的位置
    });
    // 用户拖动思考浮窗时，气泡也要重新避让（纯算术，跟着拖也不卡）
    win.on('move', () => followPetForBubble());
    win.on('closed', () => {
        if (thinkWindow === win)
            thinkWindow = null;
        notifyThinkWindowState(false);
    });
    if (process.env.DEVTOOLS === '1') {
        win.webContents.openDevTools({ mode: 'detach' });
    }
    lockNavigation(win, srv, '思考浮窗');
    return win;
}
/** 打开思考浮窗（已存在则重新贴回桌宠旁边并显示）——showInactive：不抢气泡窗输入框的焦点 */
function showThinkWindowWindow(resolver, srv) {
    if (isThinkWindowOpen()) {
        const win = thinkWindow;
        if (!win.isVisible()) {
            placeThinkPanel(win);
            win.showInactive();
        }
        notifyThinkWindowState(true);
        followPetForBubble(); // 思考浮窗出现/归位 → 气泡重新避让
        return;
    }
    let win;
    try {
        win = createThinkWindow(resolver, srv);
    }
    catch (err) {
        thinkWindow = null;
        console.warn('[main] 思考浮窗创建失败：', err.message);
        return;
    }
    void loadRenderer(win, resolver.staticRoot(), srv.baseUrl(), { panel: 'think' }).then((ok) => {
        if (!ok) {
            try {
                win.destroy();
            }
            catch {
                /* ignore */
            }
            thinkWindow = null;
            return;
        }
        win.showInactive(); // 思考浮窗不抢焦点：用户可能正接着打字
        notifyThinkWindowState(true);
        followPetForBubble(); // 思考浮窗出现 → 气泡重新避让
    });
}
/** 收起思考浮窗（只隐藏，保留内容；下一条提问会自动再打开） */
function hideThinkWindowWindow() {
    const win = isThinkWindowOpen() ? thinkWindow : null;
    if (win && win.isVisible()) {
        win.hide();
        console.log('[main] 思考浮窗已自动收起（下一条提问会再打开）');
    }
    notifyThinkWindowState(false);
}
/** 关闭思考浮窗（退出时用：真正销毁） */
function closeThinkWindowWindow() {
    const win = thinkWindow;
    thinkWindow = null;
    if (win && !win.isDestroyed()) {
        try {
            win.destroy();
        }
        catch {
            /* ignore */
        }
    }
    notifyThinkWindowState(false);
}
// ---------------------------------------------------------------- 推送路由
/** 对话频道：桌宠窗口（出气泡）+ 气泡窗（出对话记录）都要收 */
const CHAT_MIRROR_CHANNELS = new Set([contracts_1.IPC_AI_CHUNK, contracts_1.IPC_AI_DONE, contracts_1.IPC_AI_ERROR]);
/** 思考频道：只发给思考浮窗（气泡窗很小，不显示思考流） */
const THINK_CHANNELS = new Set([contracts_1.IPC_THINK_PUSH, contracts_1.IPC_PLAN_PUSH]);
/** 推给桌宠窗口；对话频道镜像给气泡窗，思考频道发给思考浮窗 */
function pushToWindows(channel, payload) {
    if (THINK_CHANNELS.has(channel)) {
        sendToWindow(isThinkWindowVisible() ? thinkWindow : null, channel, payload);
        return;
    }
    sendToRenderer(channel, payload);
    if (CHAT_MIRROR_CHANNELS.has(channel))
        sendToWindow(chatWindow, channel, payload);
}
/** 提问/确认框的目标窗口：有可见的气泡窗就弹在对话里（用户正看着它），否则弹在桌宠窗口 */
function askTargetWindow() {
    return isChatWindowVisible() ? chatWindow : mainWindow;
}
/** 推送取消信号：所有窗口都发（只有持有该提问的那个会真的收起弹窗） */
function cancelAskEverywhere(id) {
    const payload = { id };
    sendToWindow(mainWindow, contracts_1.IPC_ASK_CANCEL, payload);
    sendToWindow(chatWindow, contracts_1.IPC_ASK_CANCEL, payload);
    sendToWindow(thinkWindow, contracts_1.IPC_ASK_CANCEL, payload);
}
// ---------------------------------------------------------------- 提问 → 思考浮窗自动开 / 答完自动关
/** 答完后延迟收起思考浮窗的定时器（期间又来新消息就取消，避免"刚关又被打开"的闪烁） */
let thinkAutoHideTimer = null;
const THINK_AUTO_HIDE_MS = 2500;
/** 未结束的对话轮次计数：并发/连发时只在全部结束后才收起浮窗 */
let activeChatRounds = 0;
/** 用户向 AI 提问：立刻打开思考浮窗（不抢焦点），并取消待执行的自动收起 */
function onChatRoundStarted(resolver, srv) {
    activeChatRounds++;
    if (thinkAutoHideTimer) {
        clearTimeout(thinkAutoHideTimer);
        thinkAutoHideTimer = null;
    }
    showThinkWindowWindow(resolver, srv);
}
/** AI 回答结束（成功或出错）：轮次归零后等 2.5s 自动收起思考浮窗，让用户来得及扫一眼 */
function onChatRoundFinished() {
    activeChatRounds = Math.max(0, activeChatRounds - 1);
    if (activeChatRounds > 0)
        return; // 还有一轮在跑：先别关
    if (thinkAutoHideTimer)
        clearTimeout(thinkAutoHideTimer);
    thinkAutoHideTimer = setTimeout(() => {
        thinkAutoHideTimer = null;
        hideThinkWindowWindow();
    }, THINK_AUTO_HIDE_MS);
}
// ------------------------------------------------------------------ 窗口拖拽（renderer 左键拖拽 → 整体移动窗口）
function registerWindowDragHandlers() {
    const enforceSize = (win) => {
        const [w, h] = win.getSize();
        if (w !== WINDOW_WIDTH || h !== WINDOW_HEIGHT)
            win.setSize(WINDOW_WIDTH, WINDOW_HEIGHT);
    };
    electron_1.ipcMain.on(contracts_1.IPC_WINDOW_DRAG, (event, payload) => {
        const win = electron_1.BrowserWindow.fromWebContents(event.sender);
        if (!win || win.isDestroyed())
            return;
        const dx = typeof payload?.dx === 'number' ? Math.round(payload.dx) : 0;
        const dy = typeof payload?.dy === 'number' ? Math.round(payload.dy) : 0;
        if (!dx && !dy)
            return;
        const [x, y] = win.getPosition();
        win.setPosition(x + dx, y + dy);
        enforceSize(win); // 防御任何路径把窗口改大：拖动过程持续回正为 360x520
        // 气泡必须"同拍"跟着走：在这里直接跟，而不是等窗口 'move' 事件回来再跟（那样会慢半拍）
        if (win === mainWindow) {
            followPetForBubble();
            if (process.env.PET_DRAG_TEST === '1') {
                const [nx, ny] = win.getPosition();
                const b = chatWindow && !isChatWindowDestroyed(chatWindow) ? chatWindow.getPosition() : null;
                console.log(`[main][debug] drag 桌宠=(${nx},${ny}) 气泡=${b ? `(${b[0]},${b[1]})` : '无'}`);
            }
        }
    });
    electron_1.ipcMain.on(contracts_1.IPC_WINDOW_DRAG_END, (event) => {
        const win = electron_1.BrowserWindow.fromWebContents(event.sender);
        if (win && !win.isDestroyed())
            enforceSize(win);
    });
    // 渲染层报告角色实际可见范围（挂模型后 / 滚轮缩放后）：气泡窗据此贴到头顶上方
    electron_1.ipcMain.on(contracts_1.IPC_PET_BOUNDS, (event, payload) => {
        if (event.sender !== mainWindow?.webContents)
            return; // 只认桌宠窗口
        const top = typeof payload?.top === 'number' && Number.isFinite(payload.top) ? Math.round(payload.top) : null;
        if (top === null)
            return;
        const next = Math.max(0, Math.min(top, WINDOW_HEIGHT - 40));
        if (next === petModelTop)
            return;
        petModelTop = next;
        // 滚轮缩放模型 → 角色可见顶部变了 → 气泡逐帧跟着贴（纯算术候选位挑选，不查屏幕、不打日志）
        followPetForBubble();
    });
}
const pendingAsks = new Map();
let askSeq = 0;
/** 推送一个问题给窗口并等待用户回答（点击选项或自由文本）；120s 超时。 */
function askUser(question, options) {
    const q = (question || '').trim();
    const opts = options
        .map((o) => ({
        label: typeof o?.label === 'string' ? o.label.trim() : '',
        description: typeof o?.description === 'string' ? o.description : '',
    }))
        .filter((o) => o.label);
    if (!q)
        return Promise.resolve('提问失败：问题为空。');
    if (opts.length < 2)
        return Promise.resolve('提问失败：至少需要 2 个选项。');
    const id = `ask-${Date.now()}-${++askSeq}`;
    return new Promise((resolve) => {
        const timer = setTimeout(() => {
            pendingAsks.delete(id);
            // 通知渲染层收起提问框并结束"等待确认"暂停态（否则超时后弹窗会一直留在屏幕上）
            cancelAskEverywhere(id);
            resolve('用户未在时限内回答。');
        }, 120000);
        pendingAsks.set(id, { resolve, timer });
        const target = askTargetWindow();
        if (target) {
            if (!sendToWindow(target, contracts_1.IPC_ASK_QUESTION, { id, question: q, options: opts.slice(0, 4) })) {
                clearTimeout(timer);
                pendingAsks.delete(id);
                resolve('提问发送失败。');
            }
        }
        else {
            clearTimeout(timer);
            pendingAsks.delete(id);
            resolve('提问失败：窗口不可用。');
        }
    });
}
/** 注册用户回答通道（只需一次） */
function registerAskAnswerHandler() {
    electron_1.ipcMain.handle(contracts_1.IPC_ASK_ANSWER, (_event, payload) => {
        const p = (payload ?? {});
        const id = typeof p.id === 'string' ? p.id : '';
        const pending = pendingAsks.get(id);
        if (!pending)
            return { ok: false, error: '未找到对应提问（可能已超时）' };
        clearTimeout(pending.timer);
        pendingAsks.delete(id);
        const selected = Array.isArray(p.selected) && typeof p.selected[0] === 'string' ? String(p.selected[0]) : '';
        const text = typeof p.text === 'string' ? p.text.trim() : '';
        pending.resolve(text || selected || '用户未提供有效回答');
        return { ok: true };
    });
}
/** 退出/关窗时清理挂起提问 */
function clearPendingAsks(reason) {
    for (const [, p] of pendingAsks) {
        clearTimeout(p.timer);
        p.resolve(reason);
    }
    pendingAsks.clear();
}
// ------------------------------------------------------------------ 跨形态单例守护
/**
 * Electron 自带单例锁只对“同一种部署形态”（同 userData）有效：win-unpacked 与
 * portable（userData/临时解包目录不同）可并存，桌面因此可能出现“两个宠物窗口”。
 * 这里用 os.tmpdir() 下的共享锁文件 + PID 存活探测补一刀：任一种形态已在运行时，
 * 后启动的实例直接退出。设置环境变量 PET_MULTI=1 可显式放行（调试用）。
 */
function enforceSingleInstanceAcrossVariants() {
    try {
        if (process.env.PET_MULTI === '1')
            return true;
        const lock = path.join(os.tmpdir(), 'pet-desktop-app.single.lock');
        if (fs.existsSync(lock)) {
            const pid = Number.parseInt(fs.readFileSync(lock, 'utf8').trim(), 10);
            if (Number.isInteger(pid) && pid > 0 && pid !== process.pid) {
                let alive = false;
                try {
                    process.kill(pid, 0);
                    alive = true;
                }
                catch {
                    alive = false;
                }
                if (alive) {
                    console.warn(`[main] 已有另一 Pet 实例在运行（pid=${pid}），本实例退出（PET_MULTI=1 可放行）`);
                    return false;
                }
            }
            // 进程已退出的残留锁：删除后重建
            try {
                fs.unlinkSync(lock);
            }
            catch {
                /* ignore */
            }
        }
        fs.writeFileSync(lock, String(process.pid), 'utf8');
        process.once('exit', () => {
            try {
                fs.unlinkSync(lock);
            }
            catch {
                /* ignore */
            }
        });
        return true;
    }
    catch {
        return true; // 锁不可用（只读盘等）时放行，交给 Electron 自带锁
    }
}
// ------------------------------------------------------------------ 插件 registry 适配
/** 加载插件注册表，并将其适配为主进程使用的窄接口。 */
async function loadRegistryAdapter() {
    let inst = null;
    try {
        // 使用独立插件模块，避免把插件生命周期耦合到主进程入口。
        const mod = (await Promise.resolve().then(() => __importStar(require('../plugin-system/registry.js'))));
        const emitAction = (type, payload) => {
            if (type === 'speak' || type === 'motion' || type === 'expression') {
                sendToRenderer(contracts_1.IPC_ACTION, { type, payload });
            }
        };
        // 支持类导出和默认实例两种形式。
        const candidate = (typeof mod.PluginRegistry === 'function' ? new mod.PluginRegistry() : null) ??
            (mod.default ?? null);
        if (candidate && typeof candidate.setActionBridge === 'function') {
            candidate.setActionBridge(emitAction);
        }
        inst = candidate;
    }
    catch (err) {
        console.warn('[main] plugin-system/registry 加载失败，插件降级为 no-op：', err.message);
    }
    const probe = inst;
    if (probe && typeof probe.register === 'function' && typeof probe.tick === 'function') {
        const inner = probe;
        return {
            register: async (manifest) => {
                try {
                    if (!manifest.name.trim() || !manifest.version.trim() || !manifest.entry.trim()) {
                        return { ok: false, error: '插件名称、版本和入口路径不能为空' };
                    }
                    if (/^(https?:|data:|file:)/i.test(manifest.entry)) {
                        return { ok: false, error: '插件入口必须是本地 JavaScript 文件路径' };
                    }
                    const entryPath = path.resolve(path.isAbsolute(manifest.entry) ? manifest.entry : path.join(electron_1.app.getPath('userData'), manifest.entry));
                    if (!/\.(?:cjs|js)$/i.test(entryPath)) {
                        return { ok: false, error: '插件入口必须是 .js 或 .cjs 文件' };
                    }
                    if (!fs.statSync(entryPath).isFile()) {
                        return { ok: false, error: `插件入口不存在：${entryPath}` };
                    }
                    const loaded = require(entryPath);
                    const plugin = (loaded.default ?? loaded.plugin ?? loaded);
                    if (!plugin || typeof plugin !== 'object' || typeof plugin.setup !== 'function') {
                        return { ok: false, error: '插件必须导出包含 setup(ctx) 的对象' };
                    }
                    inner.register(manifest, () => ({
                        name: typeof plugin.name === 'string' ? plugin.name : manifest.name,
                        version: typeof plugin.version === 'string' ? plugin.version : manifest.version,
                        setup: plugin.setup.bind(plugin),
                    }));
                    return { ok: true };
                }
                catch (err) {
                    return { ok: false, error: err.message ?? String(err) };
                }
            },
            start: async () => {
                try {
                    await inner.start();
                }
                catch (err) {
                    /* 插件启动异常不阻塞应用，但保留日志便于排查 */
                    console.warn('[main] 插件启动异常：', err);
                }
            },
            tick: (dt) => {
                try {
                    inner.tick(dt);
                }
                catch {
                    /* 插件 tick 异常不拖垮主循环 */
                }
            },
            emitWindowChange: (info) => {
                try {
                    // 事件对象由 WindowMonitor 生成，直接透传给插件。
                    inner.windowChange?.(info);
                }
                catch {
                    /* 单个插件事件异常不影响窗口监控 */
                }
            },
            emitUserInput: (text) => {
                try {
                    inner.userInput?.(text);
                }
                catch {
                    /* 单个插件输入处理异常不影响聊天 */
                }
            },
        };
    }
    console.warn('[main] plugin-system registry 无 register/tick，使用 no-op 实现');
    return { register: async () => ({ ok: true }), tick: () => { }, start: async () => { } };
}
// ------------------------------------------------------------------ 启动
/**
 * 浏览器权限闸门（最小授权）。
 *
 * 为什么必须有：渲染层的语音输入会调 `navigator.mediaDevices.getUserMedia()`。Electron **默认自动
 * 批准**媒体权限，且不弹系统提示——也就是任何跑在这个页面里的脚本都能静默打开麦克风。这里显式
 * 改成白名单：只放行"音频输入"，其余（摄像头、通知、定位、剪贴板读取、HID、串口…）一律拒绝。
 *
 * 注意这不能替代操作系统的隐私开关：Windows 的"麦克风访问"仍由系统设置决定，本闸门只是应用内的
 * 第二道门（放行 ≠ 一定能录到音）。
 */
function installPermissionGate() {
    const ses = electron_1.session.defaultSession;
    // 只有音频输入是合规用途；请求里一旦捎带 video，或 mediaTypes 不是纯 audio，都拒
    const allowMedia = (details) => {
        if (!details)
            return false;
        const types = details.mediaTypes;
        if (Array.isArray(types) && types.length) {
            return types.length === 1 && types[0] === 'audio';
        }
        // 没给 mediaTypes（旧版/异常）时按"允许但记录"处理：语音是核心功能，
        // 误拒会让按住说话直接报错；宁可放行音频这一项，其余权限仍然全拒。
        return true;
    };
    ses.setPermissionRequestHandler((_wc, permission, callback, details) => {
        if (permission === 'media') {
            const ok = allowMedia(details);
            if (!ok)
                console.warn('[main] 已拒绝媒体权限请求（仅允许音频输入）：', JSON.stringify(details ?? {}));
            callback(ok);
            return;
        }
        // 其余权限一律拒绝并留痕，方便排查"某个网页 API 为什么不好使"
        console.warn(`[main] 已拒绝权限请求：${permission}`);
        callback(false);
    });
    // 有些 API 只走 check 不触发 request（例如 enumerateDevices 后的细分判断），这里保持一致口径
    ses.setPermissionCheckHandler((_wc, permission, _origin, details) => {
        if (permission === 'media')
            return allowMedia(details);
        return false;
    });
}
async function bootstrap() {
    // 启动耗时观测（各阶段毫秒数写入控制台，便于定位“启动慢”在解包/主进程/模型哪一段）
    const bootT0 = Date.now();
    // 0. 跨形态单例守护（win-unpacked / portable 只允许一个实例）
    if (!enforceSingleInstanceAcrossVariants()) {
        electron_1.app.quit();
        return;
    }
    const settings = (0, chatClient_1.loadAppSettings)(); // 1. 先解析 settings（AI 配置）
    (0, chatClient_1.ensureAppSettingsFile)(); // 1.1 首次运行自动在本机创建默认配置文件（API 为空）
    installPermissionGate(); // 1.2 权限闸门：只放行音频输入，其余一律拒绝（必须在开窗/加载页面前挂上）
    const resolver = PathResolver_1.PathResolver.resolve(); // 2. 资源根（三态）
    // 3. 本地静态服务（额外挂载 /user-models/ → 用户自己加的模型目录：模型像插件一样可加可移除，不进包）
    PathResolver_1.PathResolver.setUserModelsProvider(() => (0, userAssets_1.listUserModels)().map((m) => ({ name: m.name, dir: m.dir, kind: m.kind })));
    // 模型预设（pet-model.json）：用户级预设优先（随包模型目录只读，用户只能这样覆盖它）
    PathResolver_1.PathResolver.setUserPresetProvider((modelName) => {
        try {
            return fs.existsSync((0, userAssets_1.userPresetFile)(modelName)) ? (0, userAssets_1.userPresetFile)(modelName) : '';
        }
        catch {
            return '';
        }
    });
    const srv = new staticServer_1.StaticServer(resolver.staticRoot(), [
        { prefix: 'user-models', resolve: (name) => (0, userAssets_1.findUserModel)(name)?.dir ?? null },
    ]);
    await srv.start();
    server = srv;
    bootRef = { resolver, server: srv };
    // 4. AI 对话（回调暂存 sendToRenderer，IPC 注册后生效）
    chat = new chatClient_1.ChatClient(settings, {
        onChunk: (delta) => pushToWindows(contracts_1.IPC_AI_CHUNK, { delta }),
        onDone: (full, usage) => {
            pushToWindows(contracts_1.IPC_AI_DONE, usage ? { full, usage } : { full });
            onChatRoundFinished(); // 答完 → 2.5s 后自动收起思考浮窗
        },
        onError: (message) => {
            pushToWindows(contracts_1.IPC_AI_ERROR, { message });
            onChatRoundFinished(); // 出错同样收尾，别让浮窗一直挂着
        },
        onThink: (evt) => pushToWindows(contracts_1.IPC_THINK_PUSH, evt), // 思考浮窗
    }, resolver.knowledgeDir());
    chat.setWorkspaceRoot(settings.devWorkspaceRoot ?? ''); // 让 system prompt 知道产物该放哪
    chat.setUserDataDir(electron_1.app.getPath('userData')); // 读 <userData>/memory.md 用户记忆
    // 5. 插件注册表
    registry = await loadRegistryAdapter();
    // 6. 活动窗口监测（回调推送 WindowInfo 与互动动作；speak 场景经离线台词池出气泡）
    monitor = new windowMonitor_1.WindowMonitor({
        onInfo: (info) => {
            sendToRenderer(contracts_1.IPC_ON_WINDOW_CHANGE, info);
            registry?.emitWindowChange?.(info);
            applyFullscreenPolicy(info); // 前台全屏 → 收起桌宠；退出全屏 → 自动回来
        },
        onAction: (action) => {
            if (action.type === 'scene' && typeof action.payload === 'string') {
                // 新事件引擎：直接按分组名出语料气泡
                handleSceneGroup(action.payload);
            }
            else if (action.type === 'speak') {
                // 兼容旧 payload（health/slacking/coding/random）→ 映射分组
                const s = typeof action.payload === 'string' ? action.payload : '';
                const g = s === 'health' ? '健康护眼' :
                    s === 'coding' ? '代码陪伴' :
                        s === 'slacking' ? '网页浏览' : '桌面日常';
                handleSceneGroup(g);
            }
            else {
                sendToRenderer(contracts_1.IPC_ACTION, action);
            }
        },
    }, { intervalMs: MONITOR_INTERVAL_MS });
    // 7. IPC 注册；注册后回填推送桥
    toolbox = new tools_1.ToolBox();
    const bridge = (0, ipc_1.registerIpc)({
        getWindow: () => mainWindow,
        pathResolver: resolver,
        chat,
        registry,
        staticBaseUrl: () => srv.baseUrl(),
        onModelChanged: (modelName) => reloadOfflinePoolForModel(modelName),
        toolbox,
        openChatWindow: () => openChatWindow(resolver, srv),
        closeChatWindow: () => closeChatWindowWindow(),
        showThinkWindow: () => showThinkWindowWindow(resolver, srv),
        hideThinkWindow: () => hideThinkWindowWindow(),
        onChatStarted: () => onChatRoundStarted(resolver, srv),
    });
    sendToRenderer = bridge.pushToRenderer;
    // 7.1 工具盒（待办/提醒闹钟）就绪：恢复持久化提醒并接管“到点提醒”气泡
    toolbox.init((text) => {
        if (mainWindow && !mainWindow.isDestroyed()) {
            try {
                mainWindow.webContents.send(contracts_1.IPC_UI_BUBBLE, { text });
            }
            catch {
                /* ignore */
            }
        }
    });
    // 7.2 AI 自主调用本地工具（function-calling）：模型按需执行待办/提醒/打开面板
    const toolExecutor = async (name, rawArgs) => {
        const box = toolbox;
        if (!box)
            return '工具尚未就绪';
        const args = (rawArgs ?? {});
        const s = (v, dflt = '') => (typeof v === 'string' ? v : dflt);
        const n = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : Number(s(v)));
        // 计划审批：多步任务先出方案，用户点头才动手（只读动作，无副作用）
        if (name === 'plan_propose') {
            const planText = s(args.plan).trim();
            if (!planText)
                return '计划内容为空，请写清楚要建/改哪些文件与要跑的命令。';
            const shown = planText.length > 1500 ? `${planText.slice(0, 1500)}…（计划已截断显示）` : planText;
            const verdict = await askUser(`是否按这个计划执行？\n\n${shown}`, [
                { label: '允许', description: '按计划开始动手' },
                { label: '拒绝', description: '先不执行，我要调整' },
            ]);
            return verdict === '允许'
                ? '用户已批准该计划，可以开始按步骤动手（每步仍会单独确认）。'
                : '用户没有批准这个计划。请先问清楚他想怎么调整，不要直接开工，也不要换个说法重试同一计划。';
        }
        // 任务进度清单：无副作用、不需要确认，只推给渲染层显示
        if (name === 'plan_update') {
            const rawItems = args.items;
            if (!Array.isArray(rawItems))
                return '任务清单格式不正确（items 必须是数组）。';
            const items = [];
            for (const raw of rawItems.slice(0, 20)) {
                if (!raw || typeof raw !== 'object')
                    continue;
                const row = raw;
                const text = typeof row.text === 'string' ? row.text.trim().slice(0, 120) : '';
                if (!text)
                    continue;
                const status = row.status === 'done' || row.status === 'doing' || row.status === 'pending' ? row.status : 'pending';
                items.push({ text, status });
            }
            if (items.length === 0)
                return '任务清单为空：请给出至少一项要做的步骤。';
            pushToWindows(contracts_1.IPC_PLAN_PUSH, { items });
            // 清单同时记进对话上下文：下一轮模型还能看到"做到哪一步了"，不会因为上下文滚动把目标忘掉
            chat?.setPlanSnapshot(items);
            const done = items.filter((i) => i.status === 'done').length;
            const doing = items.filter((i) => i.status === 'doing').length;
            const pending = items.filter((i) => i.status === 'pending').length;
            return `已更新任务清单：共 ${items.length} 项（完成 ${done} / 进行中 ${doing} / 待办 ${pending}）。`;
        }
        // 只读：按模式列文件（不需要确认）
        if (name === 'workspace_glob') {
            return (0, workTools_1.findWorkspaceFiles)(args);
        }
        // 护栏（按参考提示词）：改已有文件必须先读过；写已有非空文件也必须先读过
        {
            const guardRoot = (0, devTools_1.getWorkspaceRoot)();
            const relPath = devRelPath(args.path);
            if (name === 'workspace_edit' && relPath && !devReadFiles.has(relPath)) {
                return `还没读过这个文件，不能直接改。请先用 workspace_file_read 读取 ${relPath}，确认原文后再用 workspace_edit（这样也能避免改错地方）。`;
            }
            if (name === 'workspace_write' && relPath && !devReadFiles.has(relPath)) {
                try {
                    const target = path.resolve(guardRoot, relPath);
                    if (fs.statSync(target).size > 0) {
                        return `这个文件已存在，写之前请先用 workspace_file_read 读取 ${relPath}，确认内容后再覆盖（避免误删）。`;
                    }
                }
                catch {
                    /* 不存在/读不到 → 视为新建，放行（真正的错误交给 devWrite 报） */
                }
            }
        }
        // 开发动手能力：刷新工作区根目录 + 逐次确认（写文件/改文件/执行命令，按用户决策每次都问）
        const devCfg = (0, chatClient_1.loadAppSettings)();
        (0, devTools_1.setWorkspaceRoot)(devCfg.devWorkspaceRoot ?? '');
        // 只有切换了工作区才清空"已读文件/改动清单"（不能用每次调用都清，否则护栏永远失效）
        const rootNow = (0, devTools_1.getWorkspaceRoot)();
        if (rootNow !== devRootSnapshot) {
            devRootSnapshot = rootNow;
            devReadFiles.clear();
            devChangedFiles.length = 0;
            (0, devTools_1.clearBgTasks)(); // 换工作区：终止并清空后台任务，避免残留进程
        }
        // 权限模式（对齐成熟 CLI 助手的 permission mode）
        const permMode = devCfg.permissionMode ?? 'ask';
        const MUTATING_TOOLS = ['workspace_mkdir', 'workspace_write', 'workspace_edit', 'shell_run', 'shell_bg'];
        if (permMode === 'plan-only' && MUTATING_TOOLS.includes(name)) {
            return '当前是「只读/计划」权限模式，我不会改动任何文件或执行命令。需要动手时请在设置里把权限模式改成「每次询问」或「自动接受编辑」，或者先让我用 plan_propose 出个方案给你看。';
        }
        if (name === 'workspace_set_root') {
            // 用户在对话里直接给了目录：一次确认即可把它设为工作区（并持久化），不必让用户去设置里手填
            const rawPath = s(args.path).trim();
            // 绝对路径判定与 ipc.ts 的 sanitizeSettings 保持一致：
            // Windows 盘符带分隔符 (C:\) / UNC (\\server\share) / 类 Unix 的 / 开头；
            // 不用 path.isAbsolute —— 'C:foo' 是盘符相对路径，会被误判成绝对。
            const abs = rawPath && (/^[a-zA-Z]:[\\/]/.test(rawPath) || rawPath.startsWith('\\\\') || rawPath.startsWith('/'))
                ? path.normalize(rawPath)
                : '';
            if (!abs) {
                return '需要绝对路径（例如 C:\\Users\\you\\Desktop\\MyProject）。如果用户只说了相对位置，请先问清楚完整目录。';
            }
            const existed = fs.existsSync(abs);
            const verdict = await askUser(`是否把开发工作区设为这个目录？\n${abs}\n（${existed ? '目录已存在' : '目录不存在，将自动创建'}；之后所有建目录/写文件/执行命令都在这个目录内，且每次仍会单独确认）`, [
                { label: '允许', description: '设为开发工作区' },
                { label: '拒绝', description: '保持原样' },
            ]);
            if (verdict !== '允许')
                return '用户未同意切换开发工作区。可以问用户想在哪个目录干活。';
            try {
                fs.mkdirSync(abs, { recursive: true });
            }
            catch (err) {
                return `无法创建/访问该目录：${err.message ?? String(err)}`;
            }
            try {
                (0, chatClient_1.saveAppSettings)({ ...(0, chatClient_1.loadAppSettings)(), devWorkspaceRoot: abs });
            }
            catch (err) {
                return `目录可用，但保存设置失败：${err.message ?? String(err)}`;
            }
            (0, devTools_1.setWorkspaceRoot)(abs);
            chat?.setWorkspaceRoot(abs);
            sendToRenderer(contracts_1.IPC_UI_BUBBLE, { text: `开发工作区已设为 ${path.basename(abs)}` });
            return `已把开发工作区设为：${abs}（已保存到设置）。现在可以直接建目录/写文件/执行命令了，每一步都会再请你确认。`;
        }
        if (name === 'workspace_mkdir' ||
            name === 'workspace_write' ||
            name === 'workspace_edit' ||
            name === 'shell_run' ||
            name === 'shell_bg') {
            if (!(0, devTools_1.getWorkspaceRoot)()) {
                return ('还没配置开发工作区。如果用户已经在对话里说了目标目录（绝对路径），请直接调用 workspace_set_root 把那个目录设为工作区（会请用户点一次确认）；' +
                    '如果用户没说，先问一句"想建在哪个目录"，拿到绝对路径后再调用 workspace_set_root。不要要求用户自己去设置面板填写。');
            }
            // 命令执行总开关对前台/后台都生效
            if ((name === 'shell_run' || name === 'shell_bg') && devCfg.allowShell === false) {
                return '设置里已关闭命令执行，需要时请在设置中开启。';
            }
            // 用户若选过"本次会话内不再询问…"，或在 auto-edit 模式下，直接放行：
            //  · devAutoAllowWrites：只免写类（建目录/写/改）
            //  · devAutoAllowAll：写类 + 执行命令都免（危险命令仍被 isDangerousCommand 拦下）
            const isCommand = name === 'shell_run' || name === 'shell_bg';
            const skipAsk = isCommand
                ? devAutoAllowAll
                : devAutoAllowWrites || devAutoAllowAll || permMode === 'auto-edit';
            let question = '';
            let detail = '';
            if (name === 'workspace_mkdir') {
                question = `是否允许创建目录「${s(args.path)}」？`;
            }
            else if (name === 'workspace_write') {
                const content = s(args.content);
                const lines = content.split(/\r\n|\r|\n/).length;
                const bytes = Buffer.byteLength(content, 'utf8');
                const rel = s(args.path);
                const root = (0, devTools_1.getWorkspaceRoot)();
                const target = path.isAbsolute(rel) ? path.normalize(rel) : path.resolve(root, rel);
                const relToRoot = path.relative(root, target);
                const insideRoot = !relToRoot.startsWith('..') && !path.isAbsolute(relToRoot);
                const existed = insideRoot && fs.existsSync(target);
                const preview = content.length > 400 ? `${content.slice(0, 400)}…（已截断）` : content;
                question = `是否允许${existed ? '覆盖' : '创建'}文件「${rel}」？`;
                detail = `（${lines} 行 / ${bytes} 字节）\n${preview}`;
            }
            else if (name === 'workspace_edit') {
                const oldStr = s(args.old_string);
                const newStr = s(args.new_string);
                const cut = (t) => (t.length > 200 ? `${t.slice(0, 200)}…（已截断）` : t);
                question = `是否允许修改文件「${s(args.path)}」？`;
                detail = `${cut(oldStr)}\n  ↓ 替换为\n${cut(newStr)}`;
            }
            else {
                question = name === 'shell_bg' ? '是否允许在后台执行这条命令？' : '是否允许执行命令？';
                const cmd = s(args.command);
                detail = cmd.length > 300 ? `${cmd.slice(0, 300)}…（已截断）` : cmd;
            }
            const verdict = skipAsk
                ? '允许'
                : await askUser(`${question}\n${detail}`, [
                    { label: '允许', description: '继续执行该操作' },
                    {
                        label: '允许（本次会话内不再询问写入类操作）',
                        description: '只对建目录/写文件/改文件生效；执行命令仍会单独询问，重启后恢复询问',
                    },
                    {
                        label: '允许（本次会话内不再询问任何操作，含命令）',
                        description: '写文件与执行命令都不再问（危险命令仍会被拦截）；适合多步任务，重启后恢复询问',
                    },
                    { label: '拒绝', description: '取消本次操作' },
                ]);
            if (verdict === '允许（本次会话内不再询问写入类操作）')
                devAutoAllowWrites = true;
            if (verdict === '允许（本次会话内不再询问任何操作，含命令）') {
                devAutoAllowWrites = true;
                devAutoAllowAll = true;
                try {
                    sendToRenderer(contracts_1.IPC_UI_BUBBLE, {
                        text: '本次会话内不再询问：写文件与执行命令会直接进行（危险命令仍会被拦下）。',
                        ttlMs: 6000,
                    });
                }
                catch {
                    /* 气泡推不出去不影响流程 */
                }
            }
            const allowed = verdict === '允许' ||
                verdict === '允许（本次会话内不再询问写入类操作）' ||
                verdict === '允许（本次会话内不再询问任何操作，含命令）';
            if (!allowed) {
                return '用户已拒绝该操作，未执行。';
            }
        }
        // R2：写类工具需确认（设置里开启 confirmTools 时先问用户）
        const WRITE_TOOLS = new Set([
            'todo_add',
            'todo_remove',
            'todo_toggle',
            'todo_update',
            'todo_clear_done',
            'todo_add_many',
            'note_add',
            'set_reminder',
            'reminder_cancel',
            'open_settings',
            'set_emotion',
            'play_motion',
        ]);
        if (WRITE_TOOLS.has(name) && (0, chatClient_1.loadAppSettings)().confirmTools === true) {
            const verdict = await askUser(`是否允许执行「${name}」？`, [
                { label: '允许', description: '继续执行该操作' },
                { label: '拒绝', description: '取消本次操作' },
            ]);
            if (verdict !== '允许')
                return '用户已拒绝该操作，未执行。';
        }
        switch (name) {
            case 'get_time':
                return `当前时间：${new Date().toLocaleString('zh-CN', { dateStyle: 'full', timeStyle: 'short' })}`;
            case 'active_window_get': {
                const info = monitor?.getCurrentInfo() ?? null;
                if (!info)
                    return '暂时无法获取当前活动窗口。';
                return `当前窗口：${info.app || '未知应用'}\n标题：${info.title || '无标题'}\n全屏：${info.isFullscreen ? '是' : '否'}`;
            }
            case 'workspace_file_read': {
                const result = (0, workTools_1.readWorkspaceFile)(rawArgs);
                // 读成功（不是"错误："开头且带行号头）→ 记入已读，后续才允许改
                if (!result.startsWith('错误：') && result.includes('（第 ')) {
                    const rel = devRelPath(args.path);
                    if (rel)
                        devReadFiles.add(rel);
                }
                return result;
            }
            case 'workspace_search':
                return (0, workTools_1.searchWorkspace)(rawArgs);
            case 'workspace_glob':
                return (0, workTools_1.findWorkspaceFiles)(args);
            case 'open_path':
                return openWorkspacePath(args);
            case 'workspace_mkdir': {
                const result = (0, devTools_1.devMkdir)(args);
                if (devSucceeded(result, 'mkdir'))
                    devRememberChange(devRelPath(args.path), 'mkdir');
                return appendChangeSummary(result);
            }
            case 'workspace_write': {
                const rel = devRelPath(args.path);
                let existedBefore = false;
                try {
                    existedBefore = fs.statSync(path.resolve((0, devTools_1.getWorkspaceRoot)(), rel)).size > 0;
                }
                catch {
                    existedBefore = false;
                }
                const result = (0, devTools_1.devWrite)(args);
                if (devSucceeded(result, 'write')) {
                    devRememberChange(rel, existedBefore ? 'overwritten' : 'created');
                    if (rel)
                        devReadFiles.add(rel); // 自己刚写的文件视为已知内容
                }
                return appendChangeSummary(result);
            }
            case 'workspace_edit': {
                const result = (0, devTools_1.devEdit)(args);
                if (devSucceeded(result, 'edit'))
                    devRememberChange(devRelPath(args.path), 'edited');
                return appendChangeSummary(result);
            }
            case 'shell_run':
                return await (0, devTools_1.devShell)(args);
            case 'shell_bg':
                return (0, devTools_1.devShellStart)(args);
            case 'shell_output':
                return (0, devTools_1.devShellOutput)(args);
            case 'shell_kill':
                return (0, devTools_1.devShellKill)(args);
            case 'web_fetch': {
                const url = s(args.url).trim();
                if (!url)
                    return '请给出要抓取的网址。';
                const verdict = await askUser(`是否允许抓取这个网页？\n${url.length > 300 ? `${url.slice(0, 300)}…` : url}`, [
                    { label: '允许', description: '抓取并阅读该网页' },
                    { label: '拒绝', description: '不抓取' },
                ]);
                if (verdict !== '允许')
                    return '用户拒绝抓取这个网页，未执行。';
                return await (0, webTools_1.webFetch)(args);
            }
            case 'weather_get':
                // 查天气：只读公共气象数据，不改本机任何东西，因此不弹确认。
                return await (0, weatherTools_1.weatherGet)(args);
            case 'media_control':
                // 发系统媒体键：不改文件、不联网，用户明说才调，所以不弹确认。
                return await (0, mediaTools_1.mediaControl)(args);
            case 'screen_capture':
                // 截屏会把屏幕内容写进磁盘 → 属于"留下痕迹"的操作，先请用户点一次确认。
                {
                    const p = typeof args.save_path === 'string' && args.save_path.trim() ? `\n保存到：${args.save_path.trim()}` : '\n保存到：图片文件夹下的「Pet截图」';
                    const verdict = await askUser(`要截取整个屏幕吗？${p}`, [
                        { label: '允许', description: '截屏并保存成 PNG' },
                        { label: '拒绝', description: '不截屏' },
                    ]);
                    if (verdict !== '允许')
                        return '用户拒绝截屏，未执行。';
                    return await (0, screenTools_1.captureScreen)(args);
                }
            case 'meeting_create': {
                // 只写一个临时 .ics 并交给系统日历，不碰用户已有日程 → 不弹确认。
                return await (0, meetingTools_1.meetingCreate)(args);
            }
            case 'translate_text': {
                const s0 = (0, chatClient_1.loadAppSettings)();
                return await (0, translateTools_1.translateText)(args, {
                    baseUrl: s0.aiBaseUrl, apiKey: s0.aiApiKey, model: s0.aiModel,
                });
            }
            case 'mail_compose':
                // 只打开草稿，发送仍由用户在邮件客户端里确认 → 不弹确认。
                return await (0, mailTools_1.mailCompose)(args);
            case 'mail_check': {
                // 读邮件要账号密码：没配就如实说，配了才连。
                const s1 = (0, chatClient_1.loadAppSettings)();
                return await (0, mailTools_1.mailCheck)(args, {
                    host: s1.mailImapHost, port: s1.mailImapPort, user: s1.mailImapUser, pass: s1.mailImapPass,
                });
            }
            case 'agent_task':
                return await chat.runAgentTask(args);
            case 'note_add':
                return box.addNote(s(args.text));
            case 'note_list':
                return box.listNotes();
            case 'open_settings':
                if (mainWindow && !mainWindow.isDestroyed()) {
                    sendToRenderer(contracts_1.IPC_ACTION, { type: 'open-settings', payload: {} });
                }
                return '已打开 Pet 设置。';
            case 'set_emotion': {
                const emotion = s(args.name);
                if (emotion.length > 40)
                    return '表情名称过长，未执行。';
                sendToRenderer(contracts_1.IPC_ACTION, { type: 'expression', payload: { name: emotion } });
                return emotion ? `已切换到“${emotion}”表情。` : '已恢复默认表情。';
            }
            case 'play_motion': {
                const group = s(args.group);
                if (group !== 'Idle' && group !== 'idle' && group !== 'wave')
                    return '不支持这个动作。';
                sendToRenderer(contracts_1.IPC_ACTION, { type: 'motion', payload: { group } });
                return `已播放${group === 'wave' ? '挥手' : '待机'}动作。`;
            }
            case 'open_todo_panel':
                if (mainWindow && !mainWindow.isDestroyed()) {
                    try {
                        mainWindow.webContents.send(contracts_1.IPC_TODO_SHOW, {});
                    }
                    catch {
                        /* ignore */
                    }
                }
                return `已为你打开待办笔记本（当前未完成 ${box.getTodos().filter((t) => !t.done).length} 条）。`;
            case 'todo_add':
                box.addTodoRaw(s(args.text));
                return `已添加待办“${s(args.text)}”。当前待办：${box.getTodos().filter((t) => !t.done).length} 项未完成。`;
            case 'todo_list': {
                const list = box.getTodos();
                if (!list.length)
                    return '当前没有待办事项。';
                return `待办清单：\n${list.map((t, i) => `${i + 1}) ${t.text}${t.done ? ' [已完成]' : ''}`).join('\n')}`;
            }
            case 'todo_toggle': {
                const id = n(args.id);
                const after = box.toggleTodo(id);
                const item = after.find((t) => t.id === id);
                return item ? `已更新：${item.text}（${item.done ? '已完成' : '待办'}）` : '找不到该待办。';
            }
            case 'todo_remove': {
                const before = box.getTodos().length;
                box.delTodo(n(args.id));
                return before === box.getTodos().length ? '没有删除任何待办（序号不存在）。' : '已删除该待办。';
            }
            case 'todo_update': {
                const after = box.updateTodoText(n(args.id), s(args.text));
                if (!after)
                    return '未找到该待办（或新文字为空），未修改。';
                const item = after.find((t) => t.id === n(args.id));
                return `已更新待办：${item ? item.text : s(args.text)}`;
            }
            case 'todo_clear_done': {
                const cleared = box.clearDoneTodos();
                return cleared ? `已清除 ${cleared} 条已完成待办。` : '没有已完成待办需要清除。';
            }
            case 'todo_add_many': {
                const texts = Array.isArray(args.texts) ? args.texts.map((x) => (typeof x === 'string' ? x : '')) : [];
                if (!texts.length)
                    return '没有可添加的待办内容。';
                const beforeIds = new Set(box.getTodos().map((t) => t.id));
                const after = box.addTodosMany(texts);
                const added = after.filter((t) => !beforeIds.has(t.id)).length;
                return `已批量添加 ${added} 条待办（当前未完成 ${after.filter((t) => !t.done).length} 条）。`;
            }
            case 'set_reminder': {
                const text = s(args.text);
                const afterMinutes = n(args.after_minutes);
                const at = s(args.at_hhmm);
                const daily = args.daily === true;
                if (!text)
                    return '提醒内容为空。';
                let atMs;
                if (afterMinutes > 0) {
                    atMs = Date.now() + afterMinutes * 60000;
                }
                else if (/^\d{1,2}:\d{2}$/.test(at)) {
                    const [hh, mm] = at.split(':').map(Number);
                    if (hh > 23 || mm > 59)
                        return '时间不合法：小时需 0-23、分钟需 0-59（例如 07:30）。';
                    const now = new Date();
                    const target = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hh, mm, 0, 0);
                    if (target.getTime() <= now.getTime())
                        target.setDate(target.getDate() + 1);
                    atMs = target.getTime();
                }
                else {
                    return '无法解析时间：请用 after_minutes（相对分钟）或 at_hhmm（HH:MM）。';
                }
                box.addReminderRaw(text, atMs, daily ? 'daily' : 'once');
                return `已设置${daily ? '每日 ' : ''}提醒：${text}（${new Date(atMs).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}）。`;
            }
            case 'reminder_list':
                return box.listRemindersText() || '当前没有设置提醒/闹钟。';
            case 'reminder_cancel':
                if (args.all === true) {
                    box.cancelAllReminders();
                    return '已取消全部提醒/闹钟。';
                }
                box.cancelReminderById(n(args.id));
                return '已取消对应提醒（若无则可能序号不存在）。';
            case 'ask_user':
                return askUser(s(args.question), Array.isArray(args.options) ? args.options : []);
            case 'skill_list': {
                const skills = skillBox?.list() ?? [];
                if (!skills.length)
                    return '当前没有可用技能。';
                return `可用技能：\n${skills.map((x) => `- ${x.name}：${x.description}`).join('\n')}`;
            }
            case 'skill_use': {
                const skill = skillBox?.get(s(args.name));
                if (!skill)
                    return `未找到技能：${s(args.name)}`;
                return `技能「${skill.name}」的完整步骤：\n${skill.body}`;
            }
            default:
                return `未知工具：${name}`;
        }
    };
    chat?.setToolExecutor(toolExecutor);
    // 7.3 技能库：userData/skills（用户自定义，优先）→ <assetsRoot>/skills（随包）
    skillBox = new skills_1.SkillBox([path.join(electron_1.app.getPath('userData'), 'skills'), path.join(resolver.assetsRoot(), 'skills')]);
    skillBox.load();
    chat?.setSkillCatalog(skillBox.catalogText());
    // 8. 主窗口
    createWindow(resolver, srv);
    registerWindowDragHandlers(); // 拖拽移动窗口（renderer 左键拖动 → win:drag）
    registerAskAnswerHandler(); // AI 提问（ask_user）的用户回答通道
    createTray(resolver); // 托盘：桌宠不占任务栏，托盘是唯一的"找回/退出"入口
    registerGlobalShortcuts(resolver); // 全局快捷键：托盘也点不到时的兜底召回方式
    console.log(`[main][boot] 窗口已创建 +${Date.now() - bootT0}ms（renderer 开始加载）`);
    // 9. 启动轮询 + 插件 + 默认模型日志
    await monitor.start();
    await registry?.start?.(); // 启动所有已注册插件（无插件注册时为空转）
    const models = resolver.modelList();
    if (models.length > 0) {
        console.log(`[main] 默认模型 = ${models[0]}（共 ${models.length} 个；renderer 可 IPC_LOAD_MODEL 无参取第一项）`);
    }
    else {
        console.warn('[main] 未发现模型（public/assets 或 resources/assets 为空，需先跑 scripts/import-model.js）');
    }
    // 10. 待机 tick 驱动插件（rAF 的 setInterval 替代；生产可接入主循环，dt 单位=秒）
    tickTimer = setInterval(() => {
        registry?.tick(PLUGIN_TICK_MS / 1000);
    }, PLUGIN_TICK_MS);
    // 11. 全局光标轮询（宠物视线自动跟随鼠标，任意屏幕位置）
    startCursorTracking();
    installClickThrough(); // 11.1 点击穿透：透明区不拦截鼠标（默认关闭，见设置项 clickThrough）
    // 12. 离线台词池 + 随机冒泡定时器（提升互动频率；纯离线）
    const defaultModel = resolver.modelList()[0] || 'character';
    loadOfflinePool(resolver.knowledgeDirForModel(defaultModel), defaultModel);
    startOfflineBubbleTimer();
    startTimedEvents(); // 13. 时间型事件（早安/深夜/周末/整点，每天去重）
    loadDone = true;
    console.log(`[main][boot] 主进程就绪 +${Date.now() - bootT0}ms（模型/贴图加载在渲染进程继续进行）`);
    console.log(`[main] 就绪  url=${srv.baseUrl()}  packaged=${electron_1.app.isPackaged}`);
    // 14. 调试钩子（PET_*，实现见 src/main/devDebug.js）
    //     为什么条件 require：这些钩子有 700+ 行，正常运行时一行都不该加载。
    if (Object.keys(process.env).some((k) => k.startsWith('PET_'))) {
        const { installDevDebug } = require('./devDebug.js');
        await installDevDebug({
            contracts: contracts_1,
            userAssets: userAssets_1,
            resolver,
            srv,
            chat,
            registry,
            PathResolver: PathResolver_1,
            openChatWindow,
            showThinkWindowWindow,
            debugDragPet,
            debugZoomModel,
            debugSendChat,
            captureDebugScreenshots,
            getMainWindow: () => mainWindow,
            getChatWindow: () => chatWindow,
            getHitIgnoreState,
            clickThroughEnabledOn,
        });
    }
}
// ------------------------------------------------------------------ 托盘
/**
 * 托盘菜单。作用：桌宠是无边框透明置顶窗口，容易被别的东西盖住、也可能被拖到屏幕外，
 * 托盘是"把桌宠找回来 / 摆回屏幕内 / 改取景 / 开关点击穿透 / 打开设置 / 退出"的便捷入口。
 *
 * 注：主窗口曾设 skipTaskbar，那时托盘是**唯一**入口；该设置已移除（见 createWindow 的注释），
 * 现在任务栏里也能找到它，托盘是补充而非唯一退路。
 */
let tray = null;
function trayIconPath(resolver) {
    // import 已把 local-assets/tray-icon.png 复制进 assets 根；开发态与打包态路径不同（同静态服务规则）
    const name = 'tray-icon.png';
    const candidates = [
        path.join(resolver.assetsRoot(), name),
        path.join(electron_1.app.getAppPath(), 'public', 'assets', name),
    ];
    for (const p of candidates) {
        try {
            if (fs.existsSync(p))
                return p;
        }
        catch {
            /* 继续找下一个 */
        }
    }
    return null;
}
/** 把桌宠摆回"看得见"的位置（当前位置已不可见时用） */
function restorePetToVisible(resolver) {
    const win = mainWindow;
    if (!win || win.isDestroyed())
        return;
    const saved = restorePetBounds();
    if (saved) {
        win.setBounds(saved);
    }
    else {
        // 没有可用记录（或记录也不可见）→ 摆到主显示器工作区右下角内侧
        try {
            const area = electron_1.screen.getPrimaryDisplay().workArea;
            win.setBounds({
                x: area.x + area.width - WINDOW_WIDTH - 24,
                y: area.y + area.height - WINDOW_HEIGHT - 24,
                width: WINDOW_WIDTH,
                height: WINDOW_HEIGHT,
            });
        }
        catch {
            win.setBounds({ width: WINDOW_WIDTH, height: WINDOW_HEIGHT });
        }
    }
    // 走统一入口：清掉"用户主动隐藏/全屏自动隐藏"两个状态，否则全屏策略还会把它收回去
    setPetVisibleByUser(true);
    win.focus();
}
function createTray(resolver) {
    if (tray)
        return;
    try {
        const iconPath = trayIconPath(resolver);
        // 图标缺失也不影响启动：用空图标建托盘（菜单仍可用），并把原因写进日志
        const image = iconPath
            ? electron_1.nativeImage.createFromPath(iconPath).resize({ width: 16, height: 16 })
            : electron_1.nativeImage.createEmpty();
        if (!iconPath)
            console.warn('[main] 未找到 public/assets/tray-icon.png，托盘将使用空图标');
        tray = new electron_1.Tray(image);
        tray.setToolTip('Pet 桌宠');
        const rebuild = () => {
            if (!tray)
                return;
            const win = mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
            const visible = Boolean(win && win.isVisible());
            const framing = (0, chatClient_1.loadAppSettings)().displayMode === 'half' ? 'half' : 'full';
            tray.setContextMenu(electron_1.Menu.buildFromTemplate([
                {
                    label: visible ? '隐藏桌宠' : '显示桌宠',
                    click: () => {
                        const w = mainWindow;
                        if (!w || w.isDestroyed())
                            return;
                        if (w.isVisible()) {
                            // 经过 setPetVisibleByUser：记住"是用户主动隐藏"，全屏切换不会把它弹回来
                            setPetVisibleByUser(false);
                        }
                        else {
                            // 显示前先确认位置还在可见区内，否则先摆回来
                            const [x, y] = w.getPosition();
                            const [width, height] = w.getSize();
                            if (!isBoundsVisibleOnSomeDisplay({ x, y, width, height }))
                                restorePetToVisible(resolver);
                            else
                                setPetVisibleByUser(true);
                        }
                        rebuild();
                    },
                },
                { label: '把桌宠摆回屏幕内', click: () => { restorePetToVisible(resolver); rebuild(); } },
                {
                    // 逃生口：点击穿透一旦判定有偏差，用户会"点不动桌宠"，
                    // 必须能从这里一键关掉（同时也写回设置，重启后不再生效）。
                    label: clickThroughEnabled ? '点击穿透：已开启 ✓（点此关闭）' : '点击穿透：已关闭',
                    type: 'checkbox',
                    checked: clickThroughEnabled,
                    click: (item) => {
                        const next = item.checked;
                        try {
                            (0, chatClient_1.saveAppSettings)({ ...(0, chatClient_1.loadAppSettings)(), clickThrough: next });
                        }
                        catch (err) {
                            console.warn('[main] 托盘切换点击穿透失败：', err.message);
                        }
                        clickThroughEnabled = next;
                        const w = mainWindow;
                        if (!next && w)
                            resetHitIgnore(w);
                        rebuild();
                    },
                },
                { type: 'separator' },
                {
                    label: framing === 'half' ? '取景：半身 ✓' : '取景：全身 ✓',
                    // 复选式：点一下在全身/半身之间切换（与右键菜单的「全身/半身切换」同一条链路）
                    type: 'checkbox',
                    checked: framing === 'half',
                    click: (item) => {
                        const next = item.checked ? 'half' : 'full';
                        try {
                            (0, chatClient_1.saveAppSettings)({ ...(0, chatClient_1.loadAppSettings)(), displayMode: next });
                        }
                        catch (err) {
                            console.warn('[main] 托盘切换取景失败：', err.message);
                        }
                        sendToRenderer(contracts_1.IPC_ACTION, { type: 'framing', payload: { mode: next } });
                        rebuild();
                    },
                },
                {
                    label: '打开设置…',
                    click: () => {
                        const w = mainWindow;
                        if (!w || w.isDestroyed())
                            return;
                        w.show();
                        sendToRenderer(contracts_1.IPC_ACTION, { type: 'open-settings', payload: {} });
                    },
                },
                { type: 'separator' },
                { label: '退出 Pet', click: () => electron_1.app.quit() },
                // 快捷键提示：托盘是用户唯一能看到"有哪些组合键"的地方
                ...GLOBAL_SHORTCUTS.map(({ accel, label }) => ({
                    label: `${label}（${accel.replace('CommandOrControl', 'Ctrl')}）`,
                    enabled: false,
                })),
            ]));
        };
        rebuild();
        // 双击托盘 = 显示/隐藏（Windows 习惯）
        tray.on('double-click', () => {
            const w = mainWindow;
            if (!w || w.isDestroyed())
                return;
            if (w.isVisible())
                w.hide();
            else
                restorePetToVisible(resolver);
            rebuild();
        });
        console.log(`[main] 托盘已创建（图标=${iconPath ? path.basename(iconPath) : '空'}）`);
    }
    catch (err) {
        console.warn('[main] 托盘创建失败（不影响桌宠运行）：', err.message);
        tray = null;
    }
}
/**
 * 全局快捷键。为什么需要：桌宠不占任务栏、不进 Alt-Tab，若又被别的窗口完全盖住，
 * 用户既不能从任务栏找它、也可能点不到托盘——快捷键是"从任何地方把它叫回来"的兜底。
 *
 * 注册失败必须容忍：用户可能被别的软件占用了同样的组合键（例如截图/录屏工具），
 * 这时只打印警告并继续，绝不能因此让应用起不来。
 */
const GLOBAL_SHORTCUTS = [
    { accel: 'CommandOrControl+Alt+P', label: '显示 / 隐藏桌宠' },
    { accel: 'CommandOrControl+Alt+O', label: '打开设置' },
];
const registeredShortcuts = [];
function registerGlobalShortcuts(resolver) {
    for (const { accel, label } of GLOBAL_SHORTCUTS) {
        let ok = false;
        try {
            ok = electron_1.globalShortcut.register(accel, () => {
                if (accel.endsWith('+P')) {
                    // 与托盘同一个开关：走统一入口，全屏策略与用户意图不会互相打架
                    const win = mainWindow;
                    if (!win || win.isDestroyed())
                        return;
                    if (win.isVisible()) {
                        setPetVisibleByUser(false);
                    }
                    else {
                        const [x, y] = win.getPosition();
                        const [width, height] = win.getSize();
                        if (!isBoundsVisibleOnSomeDisplay({ x, y, width, height }))
                            restorePetToVisible(resolver);
                        else
                            setPetVisibleByUser(true);
                    }
                }
                else {
                    const win = mainWindow;
                    if (!win || win.isDestroyed())
                        return;
                    win.show();
                    sendToRenderer(contracts_1.IPC_ACTION, { type: 'open-settings', payload: {} });
                }
            });
        }
        catch (err) {
            console.warn(`[main] 注册全局快捷键 ${accel} 抛错：`, err.message);
        }
        if (ok)
            registeredShortcuts.push(accel);
        else
            console.warn(`[main] 全局快捷键 ${accel}（${label}）注册失败——可能已被其它软件占用，跳过`);
    }
    if (registeredShortcuts.length) {
        console.log(`[main] 全局快捷键已注册：${registeredShortcuts.join('、')}`);
    }
}
function unregisterGlobalShortcuts() {
    // 不注销的话，应用退出后这些组合键会一直被系统占着（用户会以为键盘坏了）
    for (const accel of registeredShortcuts) {
        try {
            electron_1.globalShortcut.unregister(accel);
        }
        catch {
            /* ignore */
        }
    }
    registeredShortcuts.length = 0;
    try {
        electron_1.globalShortcut.unregisterAll();
    }
    catch {
        /* ignore */
    }
}
function destroyTray() {
    if (!tray)
        return;
    try {
        tray.destroy();
    }
    catch {
        /* ignore */
    }
    tray = null;
}
/**
 * 前台全屏时自动收起桌宠（退出全屏再自动回来）。
 *
 * 为什么需要：桌宠是 alwaysOnTop，而全屏游戏/视频/演示会铺满整屏——桌宠压在上面非常碍事。
 * 两个状态必须分开记，否则会互相打架：
 *   - userHiddenPet：用户主动隐藏（托盘 / 关窗）。这种永不自动弹回来，必须用户自己叫出来。
 *   - petAutoHidden：本次隐藏是"因为全屏"触发的。只有它是 true 时才在退出全屏后自动恢复，
 *     并且恢复时要跳过一次 move 触发的几何落盘（隐藏期间窗口坐标可能是无意义的 0,0）。
 */
let userHiddenPet = false;
let petAutoHidden = false;
/** 当前前台是否全屏（策略生效时），供"用户手动显示"判断是否处于全屏中 */
let currentFullscreen = false;
/**
 * 用户在"当前这次全屏"里手动把桌宠叫出来过。
 * 活动窗口每 2s 轮询一次，若不记这一笔，用户刚点“显示桌宠”就会被下一次轮询按回隐藏——
 * 表现为“点了没用”。所以本次全屏期间一律尊重用户的选择，直到全屏状态结束才复位。
 */
let petShownDuringFullscreen = false;
function setPetVisibleByUser(visible) {
    const win = mainWindow;
    if (!win || win.isDestroyed())
        return;
    if (visible) {
        userHiddenPet = false;
        petAutoHidden = false;
        // 如果此刻正处在全屏里，记下"用户要求显示"，避免被轮询反复收起
        petShownDuringFullscreen = Boolean(currentFullscreen);
        win.show();
        resetHitIgnore(win); // 从"可交互"开始，下一次探测再决定是否穿透
    }
    else {
        userHiddenPet = true;
        petAutoHidden = false;
        petShownDuringFullscreen = false;
        resetHitIgnore(win);
        win.hide();
    }
}
/** 活动窗口变化 → 视全屏状态收放桌宠（设置里可关） */
function applyFullscreenPolicy(info) {
    const win = mainWindow;
    if (!win || win.isDestroyed())
        return;
    let enabled = true;
    try {
        enabled = (0, chatClient_1.loadAppSettings)().hideOnFullscreen !== false;
    }
    catch {
        /* 读设置失败时按默认（开启）处理 */
    }
    // 用户自己隐藏的：不因全屏状态变化而去动它
    if (userHiddenPet)
        return;
    const wasFullscreen = currentFullscreen;
    const fullscreen = Boolean(info && info.isFullscreen);
    currentFullscreen = fullscreen && enabled;
    // 退出全屏：复位"本次全屏内的用户选择"，下次再进全屏仍按默认收起
    if (wasFullscreen && !currentFullscreen && !fullscreen)
        petShownDuringFullscreen = false;
    if (!enabled) {
        // 关掉该功能时，若之前是自动收起的，应当放出来
        if (petAutoHidden) {
            petAutoHidden = false;
            win.show();
        }
        return;
    }
    if (fullscreen && win.isVisible()) {
        if (petShownDuringFullscreen)
            return; // 用户已明确要在这次全屏里看着桌宠
        petAutoHidden = true;
        // 隐藏前先恢复可交互：否则带着"穿透"状态再显示出来，会有一段时间点不到
        resetHitIgnore(win);
        win.hide();
    }
    else if (!fullscreen && petAutoHidden) {
        petAutoHidden = false;
        win.show();
        resetHitIgnore(win); // 显示后从"可交互"开始，下一次探测再决定是否穿透
    }
}
// ------------------------------------------------------------------ 生命周期
/**
 * 调试用：在桌宠窗口里合成一次"按住左键拖动"（只在 PET_DRAG_TEST 设置时调用）。
 * 走的是渲染层真实链路（pointerdown/move/up → win:drag IPC → 主进程移窗 + 气泡跟随），
 * 用来验证气泡是不是"同拍"跟着桌宠走。
 */
async function debugDragPet() {
    const win = mainWindow;
    if (!win || win.isDestroyed())
        return;
    const script = `(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const fire = (target, type, sx, sy, buttons) =>
      target.dispatchEvent(new PointerEvent(type, {
        bubbles: true, cancelable: true,
        clientX: sx, clientY: sy, screenX: sx, screenY: sy, button: 0, buttons,
      }));
    fire(document, 'pointerdown', 180, 300, 1);
    for (let i = 1; i <= 24; i++) {
      fire(document, 'pointermove', 180 + i * 6, 300 + i * 4, 1);
      await sleep(16);
    }
    fire(window, 'pointerup', 324, 396, 0);
    return 'dragged-24-steps';
  })()`;
    try {
        const r = await win.webContents.executeJavaScript(script);
        console.log(`[main][debug] 合成拖动：${r}`);
    }
    catch (err) {
        console.warn('[main][debug] 合成拖动失败：', err.message);
    }
}
/**
 * 调试用：在桌宠窗口里合成滚轮缩放（只在 PET_ZOOM_TEST 设置时调用）。
 * 用来验证"滚轮缩放模型时气泡逐帧跟着贴"是不是跟手、尾巴会不会闪。
 */
async function debugZoomModel() {
    const win = mainWindow;
    if (!win || win.isDestroyed())
        return;
    const script = `(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const wheel = (dy) => document.body.dispatchEvent(new WheelEvent('wheel', { deltaY: dy, bubbles: true, cancelable: true }));
    for (let i = 0; i < 6; i++) { wheel(-100); await sleep(35); }   // 放大 6 档
    await sleep(200);
    for (let i = 0; i < 12; i++) { wheel(100); await sleep(35); }   // 缩小 12 档
    await sleep(200);
    for (let i = 0; i < 6; i++) { wheel(-100); await sleep(35); }   // 再放大回 6 档
    return 'zoomed';
  })()`;
    try {
        const r = await win.webContents.executeJavaScript(script);
        console.log(`[main][debug] 合成缩放：${r}`);
    }
    catch (err) {
        console.warn('[main][debug] 合成缩放失败：', err.message);
    }
}
/** 调试用：在聊天窗口里填一条消息并点「发送」（只在 PET_CHAT_SEND 设置时调用） */ async function debugSendChat(text) {
    const win = chatWindow;
    if (!win || win.isDestroyed()) {
        console.warn('[main][debug] 聊天窗口未打开，跳过发送测试');
        return;
    }
    try {
        const script = `(() => {
      const input = document.getElementById('chat-input');
      const send = document.getElementById('chat-send');
      if (!input || !send) return 'missing-elements';
      input.value = ${JSON.stringify(text)};
      send.click();
      return 'sent';
    })()`;
        const result = await win.webContents.executeJavaScript(script);
        console.log(`[main][debug] 聊天窗口发送测试消息（${result}）：${text}`);
    }
    catch (err) {
        console.warn('[main][debug] 发送测试消息失败：', err.message);
    }
}
/** 调试用：把桌宠窗口与聊天窗口各截一张 PNG（只在 PET_SHOT_DIR 设置时调用） */
async function captureDebugScreenshots(dir, round = 0) {
    try {
        fs.mkdirSync(dir, { recursive: true });
    }
    catch (err) {
        console.warn('[main][debug] 截图目录创建失败：', err.message);
        return;
    }
    const shots = [
        ['pet', mainWindow],
        ['chat', chatWindow],
        ['think', thinkWindow],
    ];
    for (const [name, win] of shots) {
        if (!win || win.isDestroyed())
            continue;
        // 隐藏窗口不截：Chromium 对隐藏窗口的 capturePage 可能迟迟不返回，会把整个截图流程卡住
        if (!win.isVisible()) {
            console.log(`[main][debug] 跳过隐藏窗口 ${name}（未显示）`);
            continue;
        }
        try {
            const image = await win.webContents.capturePage();
            const suffix = round ? `_${round}` : '';
            const file = path.join(dir, `${name}${suffix}.png`);
            fs.writeFileSync(file, image.toPNG());
            console.log(`[main][debug] 截图已保存 ${file} （${win.getSize().join('x')}）`);
        }
        catch (err) {
            console.warn(`[main][debug] 截图失败 ${name}：`, err.message);
        }
    }
}
function shutdown() {
    if (tickTimer !== null) {
        clearInterval(tickTimer);
        tickTimer = null;
    }
    if (cursorTimer !== null) {
        clearInterval(cursorTimer);
        cursorTimer = null;
    }
    if (bubbleTimer !== null) {
        clearTimeout(bubbleTimer);
        bubbleTimer = null;
    }
    if (timedEventTimer !== null) {
        clearInterval(timedEventTimer);
        timedEventTimer = null;
    }
    lastCursorSent = null;
    if (thinkAutoHideTimer) {
        clearTimeout(thinkAutoHideTimer);
        thinkAutoHideTimer = null;
    }
    closeChatWindowWindow(); // 关掉浮窗（否则 window-all-closed 不触发、进程残留）
    closeThinkWindowWindow();
    destroyTray(); // 托盘不销毁会在退出时留一个僵尸图标
    unregisterGlobalShortcuts(); // 不注销会把组合键一直占着，用户会以为键盘坏了
    monitor?.stop();
    chat?.cancel();
    toolbox?.stop(); // 停止所有提醒定时器（数据已持久化，下次启动恢复）
    (0, devTools_1.clearBgTasks)(); // 杀掉仍在跑的后台命令，避免窗口关了进程还在（Electron 退出不会自动收子进程）
    clearPendingAsks('应用正在关闭');
    if (server) {
        const srv = server;
        server = null;
        void srv.close();
    }
}
electron_1.app.whenReady()
    .then(() => {
    // 双保险：未拿到单实例锁（后启动实例）不执行初始化，直接退出
    if (!electron_1.app.hasSingleInstanceLock()) {
        electron_1.app.quit();
        return;
    }
    return bootstrap();
})
    .catch((err) => {
    console.error('[main] 启动失败：', err);
    electron_1.app.quit();
});
electron_1.app.on('window-all-closed', () => {
    // win32/linux：全部窗口关闭即退出；darwin 惯例保留（activate 重建）
    if (process.platform !== 'darwin')
        electron_1.app.quit();
});
electron_1.app.on('activate', () => {
    // macOS：Dock 点击重建窗口（复用启动时的静态服务与资源解析）
    if (loadDone && electron_1.BrowserWindow.getAllWindows().length === 0 && bootRef) {
        createWindow(bootRef.resolver, bootRef.server);
    }
});
electron_1.app.on('before-quit', () => {
    appQuitting = true; // 先立旗标，再走 shutdown（shutdown 里的窗口操作需要它）
    shutdown();
});
process.on('uncaughtException', (err) => {
    console.error('[main] uncaughtException（不崩溃，继续运行）：', err);
});
process.on('unhandledRejection', (reason) => {
    console.error('[main] unhandledRejection：', reason);
});
