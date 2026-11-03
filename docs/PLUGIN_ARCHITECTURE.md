# 微内核、事件总线与插件实现

> 状态：**P1 已实施，渲染层拆分仍未实施**。主进程已加入 typed EventBus、依赖启动顺序、
> 插件卸载和 owner 订阅清理；渲染层仍保持现有全局脚本与 `renderer.ts` 装配方式。
>
> 与既有文档的关系：IPC 通道与公共类型以 `src/shared/contracts.ts` 为唯一真源；
> 运行时边界以根目录 `CONTRACT.md` 为准；目录约定以 `docs/PROJECT_LAYOUT.md` 为准。
> 本文只描述**增量改造**，凡与上述文档冲突处，以现有代码与 CONTRACT 为准。

---

## 0. 结论摘要

> **实现状态（以代码为准）**：§4.5/§5.3 的代码块是设计稿，实际实现有出入 ——
> 渲染层插件用 `PetKernel.register(plugin)` 注册（没有 `define`；插件无 `version` 字段）；
> `ctx.service(name)` 缺失时**抛错**（不是返回 null）；同步能力用 `ctx.handle(name, fn)` +
> `PetKernel.call(name, …)`（没有 `ctx.provide`）；实际事件表是
> `chat:reply / tracking:emotion / behavior / behavior:config`（`window:change/cursor:global/emotion:detected`
> 未实现）；`PetKernel.provide` 有重名保护（保留先注册者并告警）。
> 见 `src/renderer/kernel.ts` 与 `tests/kernel.test.js`。

1. 现状不是"没有插件系统"，而是**插件宿主只在主进程**：`src/plugin-system/registry.ts`
   已具备 register/start/tick + 动作桥，但事件只有 4 个固定方向（内核 → 插件），没有卸载、
   没有依赖、插件之间没有协作通道；渲染层则完全没有模块系统，`renderer.ts` 同时扮演
   内核、UI 和业务策略。
2. 目标架构是**两个进程内各一个内核节点**：
   - 主进程内核 = `mainImpl.js`（装配）+ `src/plugin-system`（事件总线 + 插件宿主 + 动作桥）；
   - 渲染进程内核 = 新增 `src/renderer/kernel.ts`（事件总线 + 服务注册表 + 内置插件宿主），
     `renderer.ts` 收敛为"装配根 + UI 外壳"；
   - 两者之间**不新增干道**，仍然只走 `preload` 已暴露的 `window.electron` 窄接口。
3. "星型"落在**进程内**：内核向所有插件广播事件，插件只能通过内核服务/动作桥回核心；
   "树形"落在**依赖**：插件依赖只用于启动与卸载顺序，不产生插件之间的直接引用。
4. 最关键的约束：**渲染层没有打包器**（`index.html` 固定 `<script>` 顺序、`assemble-renderer.js`
   硬校验不能出现 CommonJS 垫片）。因此渲染层的"插件"是**编译期登记 + 运行期注册的内置
   功能模块**，不是第三方动态插件加载器；第三方插件仍然只跑在主进程（现状不变）。
5. 分 4 个落地阶段（P1–P4）实施，每阶段可独立编译、可单独回滚、不改任何持久化格式与 IPC 通道；
   第一、二阶段不产生任何行为变化。

---

## 1. 现状盘点：边界由事实决定

### 1.1 三层已有机制

| 层 | 已有机制 | 位置 |
|---|---|---|
| 主进程 | 插件注册表（register / start / tick / windowChange / userInput / list / 动作桥） | `src/plugin-system/registry.ts:96-189` |
| 主进程 | 插件对外契约（`PluginEventMap` 4 个事件、`PluginContext.on/emit`、`PetPlugin.setup`） | `src/plugin-system/types.ts:19-57` |
| 主进程 | 动态 import + 降级 no-op 的适配层；`register` 校验入口必须是 userData 下的 `.js/.cjs` | `src/main/mainImpl.js:1964-2058` |
| 主进程 | 启动 / 每 50ms tick / 窗口变化 / 用户输入 四处驱动 | `mainImpl.js:2347, 2352, 3058, 3067-3069`；`src/main/ipc.ts:514` |
| 主进程 | 插件资产发现与校验（`pet-plugin.json`：name/version/entry） | `src/main/assets/userAssets.ts:322-395, 450-...` |
| 主进程 | `plugin:register` IPC 归一化 `{ok,error?}` | `src/main/ipc.ts:95-103, 980-997` |
| preload | 唯一跨进程桥：`pluginRegister()` / `onAction()` 等窄接口 | `src/preload/preload.ts:138, 247-249` |
| 渲染层 | 全局脚本 + 固定加载顺序（`emotion → voicelab → gaze → ttsMouth → live2d → renderer`） | `src/renderer/index.html:354-371` |
| 渲染层 | 每个模块挂一个全局：`window.PetEmotion/PetLive2d/PetGaze/PetTtsMouth/PetVoiceLab` | `emotion.ts:104-110`、`live2d.ts:2146-2161`、`gazeController.ts:232-234`、`ttsMouth.ts:151-160` |
| 渲染层 | 装配 + UI + 业务全在 `renderer.ts`（5991 行）；另暴露 `window.petTracking` / `window.__petDebug` | `renderer.ts:1028-1097, 5730-5890` |
| 渲染层 | 装配脚本硬编码脚本清单，并拒绝 CommonJS 产物 | `scripts/assemble-renderer.js:72-75, 95-108` |
| 测试 | 在 Node 里用假 DOM 直接 `require` 编译后的 `renderer.js` / `gazeController.js` 等 | `tests/behaviorTriggers.test.js:274-280` |

### 1.2 必须保住的不变量（红线）

1. `window.electron` 的 `ElectronAPI` 形状与 `contracts.ts` 里的 IPC 通道常量（本次**不新增通道**）。
2. `window.PetEmotion` / `PetLive2d` / `PetGaze` / `PetTtsMouth` / `PetVoiceLab` / `window.petTracking` /
   `window.__petDebug` 的既有对外行为（加法可以有，减法不行）。
3. `pet-plugin.json` 结构（name / version / entry / description）与主进程的入口校验规则。
4. 用户插件契约：`ctx.on(event, cb)` / `ctx.emit('speak'|'motion'|'expression', payload)` 的签名与语义。
5. 渲染层"普通全局脚本"约束：不 import / 不 export、无 CommonJS 垫片、加载顺序固定。
6. 构建链 `npm run build:all` / `npm test` / `npm run assemble` 与回归套件的可运行性。
7. 无新增运行时依赖（`package.json` 的 dependencies 不变）。

### 1.3 三处真实耦合（为什么需要这次重构）

| 耦合 | 现状 | 影响 |
|---|---|---|
| 装配与策略混在一起 | `renderer.ts:973-995` 的 `applyEmotionFromText()` 同时做：总闸判断、规则调用、置信度门槛、模型预设映射、写表情、记调试状态 | 换情绪来源/规则要改渲染入口；无法单独测试 |
| 渲染层反向依赖情绪全局 | `live2d.ts:1476-1498` 的 `applyEmotionLabel()` 直接读 `window.PetEmotion.expressionFor()` | 情绪模块无法被替换/裁剪；`emotion.js` 缺失时模糊匹配静默失效 |
| 主进程插件总线单向且手工接线 | 事件由 `mainImpl.js:2037-2053` 逐个人工转发；`registry` 不持有总线，卸载/依赖无从谈起 | 新增事件要改多处；插件不能感知"模型已切换"等新事件；卸载只能重启 |

本次重构只解决以上三点，不重写 Electron 层、不重写 AI/语音/VTS/MCP 等功能。
P1 不改变 IPC 通道或渲染层行为；P2/P3 在完成独立回归测试前不应直接合并。

---

## 2. 目标架构：星型拓扑如何落在三层结构里

### 2.1 拓扑图

```
                          主进程（Main）
   ┌───────────────────────────────────────────────────────────────┐
   │  内核（微内核）                                                │
   │  ┌───────────────────────────┐   ┌──────────────────────────┐ │
   │  │ mainImpl.js 装配根         │   │ src/plugin-system        │ │
   │  │ PathResolver / staticServer│   │ PluginRegistry(=Manager) │ │
   │  │ ipc / chat / tools / ...   │◄──┤ EventBus（新）            │ │
   │  └──────────┬────────────────┘   │ ActionBridge（保留）      │ │
   │             │ 传感器事件          └────────────┬─────────────┘ │
   │             │ windowMonitor / chat / IPC       │ 广播 / 动作桥 │
   │             ▼                                  ▼               │
   │        ┌────────────────────────────────────────────┐          │
   │        │ 第三方插件（userData/plugins/*.js，叶子）    │          │
   │        │ 只订阅事件；只发 speak/motion/expression     │          │
   │        └────────────────────────────────────────────┘          │
   └───────────────────────────┬───────────────────────────────────┘
                               │  preload 窄接口（唯一跨进程干道：
                               │  plugin:register / pet:action / onChat / onWindowChange …）
   ┌───────────────────────────┴───────────────────────────────────┐
   │                       渲染进程（Renderer）                     │
   │  内核（微内核）                                                │
   │  ┌───────────────────────────┐   ┌──────────────────────────┐ │
   │  │ renderer.ts 装配根 + UI    │   │ kernel.ts（新，window.*） │ │
   │  │ DOM / 主循环 / 交互 / 聊天 │◄──┤ 事件总线 / 服务注册表     │ │
   │  │ currentHandle 所有权       │   │ 内置插件生命周期          │ │
   │  └──────────┬────────────────┘   └────────────┬─────────────┘ │
   │             │ 服务注入（render / emotionRules）│ 广播/服务调用 │
   │             ▼                                  ▼               │
   │        ┌────────────────────────────────────────────┐          │
   │        │ 内置功能插件（叶子）                        │          │
   │        │ emotion（本次）→ 后续：行为解析/视线/口型    │          │
   │        └────────────────────────────────────────────┘          │
   └────────────────────────────────────────────────────────────────┘
```

拓扑规则（本次改造的"宪法"）：

1. **只有内核知道全局**：插件拿不到另一个插件的引用，也拿不到内核的可变状态（只有事件、
   窄服务接口、动作请求）。
2. **依赖只排序不连线**：`dependencies` 只决定 setup 顺序与卸载顺序，插件之间没有任何
   import/require/全局互访。
3. **跨进程只有一条干道**：渲染层拿不到 `ipcRenderer`；主进程也不直接操作 DOM。需要新事件
   时先改 `contracts.ts` 四处同步，而不是插件自建通道。
4. **内核负责底线**：没有任何插件时，应用仍必须能渲染模型、对话、视线跟随
   （对应 §2.2 判定标准 4）。

### 2.2 微内核 vs 插件的边界（5 条判定标准）

1. **资源所有权**：谁拥有窗口/句柄/定时器/连接/文件句柄，谁就是内核。插件只拿"操作能力"，
   不拿资源本体。
2. **安全与跨进程**：文件系统、密钥、系统命令、`ipcRenderer`、`preload` 只能在核心里。
   插件不得直接获得这些入口。
3. **生命周期**：要随应用启停、会被其它模块依赖的 → 内核服务；可独立启停、可替换策略的 → 插件。
4. **底线能力**：插件全部缺失时仍必须具备的功能（模型渲染、气泡、对话、视线）不能只存在于插件里。
5. **数据归属**：插件不持有内核可变状态的可变引用（只能拿快照或走服务调用），否则插件卸载/
   替换后必然出现悬垂引用。

按这 5 条落地的归属表：

| 归属 | 内容 |
|---|---|
| 主进程内核 | 进程/窗口/托盘/快捷键/单实例；`PathResolver`、`staticServer`；`settings`/`chat-log`/资产注册表；AI 主循环与工具；`ipc.ts` 与 `preload` 契约；`windowMonitor`（传感器）；TTS/VTS/MCP 的进程内客户端；插件宿主（registry + eventBus） |
| 主进程插件（第三方） | 只订阅 `start/tick/windowChange/userInput`；只发 `speak/motion/expression` 动作；声明依赖用于排序；**约定**不 require 内核模块（Node 进程内无沙箱，见 §8-9） |
| 渲染层内核 | DOM 结构、`requestAnimationFrame` 主循环、窗口拖拽/缩放/点击穿透、聊天/设置/待办等 UI、`currentHandle` 与模型挂载生命周期、preload 接线；注册服务 `render` / `emotionRules`；内置插件宿主 |
| 渲染层内置插件 | 决策/策略类逻辑（情绪判定策略、行为触发解析、视线策略、口型节拍等）；只能通过 `ctx.on / ctx.emit / ctx.service()` 与外界交互 |

> 渲染层插件是**仓库内编译进包**的内置模块，不对第三方开放。原因是安全边界（`contextIsolation` +
> CSP `script-src 'self'`）与打包链路（`assemble-renderer.js` 白名单）；开放第三方渲染插件需要
> 新的 IPC、静态资源路由与权限模型，不在本次范围。

### 2.3 四种消息语义（不要混用）

| 方向 | 机制 | API | 适用范围 | 同步性 | 例子 |
|---|---|---|---|---|---|
| 内核 → 插件 | 事件广播 | `bus.emit` → `ctx.on` | 两个进程内 | 同步，顺序稳定 | 主进程 `tick/windowChange/userInput`；渲染层 `chat:reply` |
| 插件 → 内核（同步请求） | 内核服务 | `ctx.service('render')` | 仅渲染层 | 同步，可直接用返回值 | `applyEmotionLabel()` |
| 插件 → 内核（动作） | 动作桥（跨进程） | 主进程插件 `ctx.emit('speak', …)` → `IPC_ACTION` | 仅主进程 | 异步（IPC） | 说话/动作/表情 |
| 插件 ↔ 插件 | 只允许事件 | 渲染层 `ctx.emit` → 其它插件 `ctx.on` | 仅渲染层 | 同步 | `emotion:detected` |
| 跨进程 | preload 窄接口 | `window.electron.*` | 三层之间 | 既有语义 | `onChat` / `onAction` |

> 主进程插件目前**没有**插件间事件通道（`ctx.emit` 只接受三种动作），这是既有契约；本次不扩。
> 渲染层插件之间只通过 `KernelEventMap` 登记的事件协作，拿不到彼此的对象。

硬规则：事件名必须登记在内核的事件表里（主进程=`PluginEventMap`，渲染层=`KernelEventMap`）；
新增跨进程事件必须按 CONTRACT.md 的"四处同步"检查 `contracts.ts`、preload、主进程、渲染层。

### 2.4 生命周期与失败隔离

```
register/define ──► 实例化(仅构造，无副作用) ──► 依赖拓扑排序 ──► setup 按序 ──► started
                        │                              │
                        └── 失败 → failed（记日志）     └── 缺依赖/成环 → failed（跳过该插件及其依赖方）
unregister/stop：依赖检查（有存活依赖方 → 拒绝）→ 清订阅(offOwner) → 逆序 teardown → 移除登记
```

与现状保持一致的失败语义：

- 单个插件 `setup` 抛错只影响它自己，不影响其它插件启动与主循环（原 registry 已有此行为）。
- 事件订阅者抛错在总线里按订阅者隔离（原 `PluginContextImpl.dispatch` 的 try/catch 语义）。
- 总闸/`start()` 前调用 `tick()` 等安全空转（原行为）。

`start` 事件保持"只发给该插件自己"：主进程用 `emitTo(owner)`，不能广播——否则先启动的插件
会重复收到 `start`（原实现是逐个插件 `startEvent()`，这个语义必须保留）。

### 2.5 兼容性红线对照表

| 改动 | 原行为 | 新行为 |
|---|---|---|
| registry 内部派发改为 EventBus | 逐插件手工派发 | 事件名/负载/顺序/去重/异常隔离不变 |
| `PetPlugin` 增补可选字段 | 不存在 | 老插件（无 dependencies/teardown）行为完全不变 |
| `register/start/tick/windowChange/userInput/list/setActionBridge` | 现有签名 | **签名与语义不变** |
| 主进程插件动作 | `ctx.emit` → `IPC_ACTION` | 不变（仍经同一 ActionBridge） |
| 渲染层 `chat:reply` 取代直接调用 | `onChat` 回调里直接调 `applyEmotionFromText` | 同一时机同步 `emit`，插件同步处理，顺序仍在 `showBubble` 之后、聊天落盘之前 |
| `window.petTracking.emotion` / `__petDebug.emotion` | 直接调用渲染层函数 | 经内核服务转调插件，返回值语义不变 |
| 缺 `kernel.js` 或情绪插件 | 缺 `emotion.js` 时情绪静默不生效 | 同样静默降级（console.error 一次），其它功能不变 |

---

## 3. 目录结构重构方案

### 3.1 目标目录树（最小移动：既有文件一个都不移动/改名）

```
src/
├── shared/
│   └── contracts.ts                 不动（IPC 通道与公共类型唯一真源）
├── plugin-system/                   主进程内核（插件宿主；保持在 src 顶层）
│   ├── types.ts                     改造：PetPlugin + dependencies?/teardown?（纯增量）
│   ├── eventBus.ts                  新增：主进程事件总线（按 owner 管理订阅）
│   └── registry.ts                  主进程插件注册表（依赖/卸载/总线派发）
├── main/                            不动：main.ts 入口、mainImpl.js 装配、ipc/windowMonitor/ai/assets…
├── preload/
│   └── preload.ts                   不动（本次不新增 IPC 通道）
└── renderer/
    ├── kernel.ts                    新增：渲染层微内核（全局脚本 window.PetKernel）
    ├── plugins/
    │   └── emotion.ts               新增：情绪插件（从 renderer.ts 剥出的策略）
    ├── emotion.ts                   不动：规则库 window.PetEmotion（插件与 live2d 共用）
    ├── live2d.ts                    模型加载、参数和表情动作
    ├── gazeController.ts            不动
    ├── ttsMouth.ts                  不动
    ├── voicelab.ts                  不动
    └── renderer.ts                  改造：只加装配/转发，删掉情绪策略与直接依赖
```

配套文件改动：

```
scripts/assemble-renderer.js         改造：+ kernel.js；+ plugins/ 目录拷贝；CommonJS 守卫覆盖新脚本
src/renderer/index.html              改造：+ kernel.js、+ plugins/emotion.js（顺序固定）
tests/behaviorTriggers.test.js       改造：按 index.html 顺序多 require 两个编译产物
docs/PROJECT_LAYOUT.md               目录与构建说明
                                     实际在 src/ 顶层）
CONTRACT.md                          阶段 1/4 同步：插件可选字段说明
```

不在树里的东西：**不新建** `src/main/kernel/` 之类的壳目录。`mainImpl.js` 已经是这个项目的
装配根（composition root），再包一层只会多一层转发；`PluginRegistry` 就是用户所说的
插件注册表，不新建平行管理器。

### 3.2 新增/改造文件清单

| 文件 | 性质 | 职责 | 行为影响 |
|---|---|---|---|
| `src/plugin-system/eventBus.ts` | 新增 | 主进程事件总线：按 owner 批量清理订阅、同步派发、异常隔离 | 无（替换内部派发实现） |
| `src/plugin-system/types.ts` | 改造 | `PetPlugin` 增加可选 `dependencies` / `teardown` | 无（可选字段） |
| `src/plugin-system/registry.ts` | 改造 | 依赖拓扑排序、卸载、总线派发、owner 清理 | 阶段 1 无 |
| `src/main/mainImpl.js` | 改造 | 适配层把 `dependencies/teardown` 透传给 registry | 无 |
| `src/renderer/kernel.ts` | 新增 | 渲染层微内核（总线 + 服务注册表 + 插件宿主） | 阶段 2 无（只接线） |
| `src/renderer/plugins/emotion.ts` | 新增 | 情绪策略插件 | 阶段 3 与旧逻辑等价 |
| `src/renderer/renderer.ts` | 改造 | 装配内核服务、启动内核、推送事件进总线、删除情绪策略 | 见 §2.5 |
| `src/renderer/index.html` | 改造 | 追加两个 `<script>`（顺序固定） | 无 |
| `scripts/assemble-renderer.js` | 改造 | 装配 kernel.js 与 plugins/ | 无 |

---

## 4. 核心代码骨架（TypeScript）

### 4.1 主进程事件总线 `src/plugin-system/eventBus.ts`（新增）

```ts
/**
 * src/plugin-system/eventBus.ts
 *
 * 主进程内核事件总线：内核 → 插件的广播统一走这里。
 *
 * 为什么自己写而不是直接用 Node EventEmitter：
 *   1) 订阅要按插件归属整体清理（启动失败/卸载），EventEmitter 没有 owner 概念；
 *   2) 事件名与负载类型由 PluginEventMap 收窄，EventEmitter 需要每处再包一层。
 * 为什么同步派发：事件顺序是行为的一部分（tick 紧跟 windowChange），异步化会改变
 * 插件观察到的顺序；单个订阅者抛错在这里隔离，不影响其它订阅者。
 */

/** 事件名 → 负载类型；用 unknown 兜底，具体映射由使用方（PluginEventMap）给出。 */
export type EventMap = Record<string, unknown>;

interface ListenerEntry {
  /** 订阅归属的插件名；null = 内核自身订阅（不随插件卸载清理）。 */
  readonly owner: string | null;
  readonly callback: (payload: any) => void;
}

export class EventBus<M extends EventMap> {
  private readonly listeners = new Map<keyof M, ListenerEntry[]>();

  /**
   * 订阅事件。同一 owner 重复注册同一个回调只保留一份（与旧 PluginContextImpl 的
   * Set 去重语义一致）。生命周期由 owner 统一管理，所以不返回取消函数。
   */
  on<K extends keyof M>(
    event: K,
    callback: (payload: M[K]) => void,
    owner: string | null = null,
  ): void {
    const list = this.listeners.get(event) ?? [];
    const exists = list.some((entry) => entry.owner === owner && entry.callback === callback);
    if (!exists) list.push({ owner, callback: callback as (payload: any) => void });
    this.listeners.set(event, list);
  }

  /** 广播给所有订阅者（内核 → 全部插件 + 内核自身订阅）。 */
  emit<K extends keyof M>(event: K, payload: M[K]): void {
    this.dispatch(event, payload, null);
  }

  /** 只发给指定插件：插件级事件（如 start）不能广播，否则先启动的插件会重复收到。 */
  emitTo<K extends keyof M>(owner: string, event: K, payload: M[K]): void {
    this.dispatch(event, payload, owner);
  }

  /** 插件启动失败/卸载：清掉它注册的全部订阅。 */
  offOwner(owner: string): void {
    for (const [event, list] of this.listeners) {
      const kept = list.filter((entry) => entry.owner !== owner);
      if (kept.length) this.listeners.set(event, kept);
      else this.listeners.delete(event);
    }
  }

  /** owner=null 表示广播，否则只派发给该 owner 的订阅。 */
  private dispatch<K extends keyof M>(event: K, payload: M[K], owner: string | null): void {
    const list = this.listeners.get(event);
    if (!list) return;
    // 先快照：订阅者在回调里增删订阅不能改变本轮派发集合（与旧实现一致）
    for (const entry of [...list]) {
      if (owner !== null && entry.owner !== owner) continue;
      try {
        entry.callback(payload);
      } catch (err) {
        console.error(`[plugin] 事件 "${String(event)}" 的订阅者抛错（已隔离）：`, err);
      }
    }
  }
}
```

### 4.2 插件契约增量 `src/plugin-system/types.ts`

只增加两个可选字段（`PluginEventMap` 与 `PluginContext` 完全不动）：

```ts
export interface PetPlugin {
  /** 插件名（须与 PluginManifest.name 一致）。 */
  name: string;
  /** 插件版本号。 */
  version: string;
  /**
   * 依赖的插件名（可选）：宿主按依赖拓扑序 setup、按逆序卸载；
   * 依赖缺失或成环时该插件不启动（只记日志，不影响其它插件）。
   * 为什么放插件对象而不放 PluginManifest：manifest 是对外注册契约
   * （pet-plugin.json 同构），加字段要同步扫描/校验/IPC/文档；依赖只是宿主调度信息。
   */
  dependencies?: readonly string[];
  /** 启动钩子：注册事件、做一次性初始化。可异步。 */
  setup(ctx: PluginContext): void | Promise<void>;
  /** 卸载钩子（可选）：释放宿主无法代管的资源（定时器/文件句柄/子进程）。 */
  teardown?(): void | Promise<void>;
}
```

### 4.3 插件注册表（`src/plugin-system/registry.ts`）

**保留类名 `PluginRegistry`**（`ipc.ts` 的 `PluginRegistryLike`、`mainImpl.js` 适配层都依赖它；
注册表负责依赖排序、启动、卸载和事件分发。以下是实现：

```ts
/**
 * 插件注册表：插件注册、依赖排序、启动、卸载与事件分发。
 *
 * 事件不再由本类逐个插件派发，而是进入 EventBus 后按 owner 分发；卸载/启动失败时
 * 按 owner 清订阅，避免残留回调。register/start/tick/windowChange/userInput/list/
 * setActionBridge 的签名与失败隔离语义保持不变（ipc.ts 的 PluginRegistryLike 依赖它们）。
 */
import type { PluginManifest, WindowInfo } from '../shared/contracts';
import type { PetPlugin, PluginContext, PluginEventMap } from './types';
import { EventBus } from './eventBus';

/** 主进程动作桥接回调：插件 emit('speak'|'motion'|'expression', payload)。 */
export type ActionBridge = (
  action: 'speak' | 'motion' | 'expression',
  payload: any,
) => void;

/** 插件状态：failed 的插件不再参与启动/事件派发。 */
type PluginState = 'registered' | 'starting' | 'started' | 'failed';

/** 每个插件的独立 PluginContext 实现（对外仅按 PluginContext 窄接口使用）。 */
class PluginContextImpl implements PluginContext {
  constructor(
    private readonly owner: string,
    private readonly bus: EventBus<PluginEventMap>,
    private readonly actionBridge: ActionBridge,
  ) {}

  /**
   * on: 注册事件回调。event 键与 payload 类型均由 PluginEventMap 推导；
   * 同一实例重复注册同一函数引用会被去重（EventBus 按 owner + 回调判断）。
   */
  on<K extends keyof PluginEventMap>(
    event: K,
    callback: (payload: PluginEventMap[K]) => void,
  ): void {
    this.bus.on(event, callback, this.owner);
  }

  /** emit: 动作请求经 actionBridge 转交主进程（→ IPC_ACTION），不进入本地事件表。 */
  emit(action: 'speak' | 'motion' | 'expression', payload: any): void {
    this.actionBridge(action, payload);
  }

  /** 卸载/启动失败：该插件注册的事件订阅一次性清除。 */
  dispose(): void {
    this.bus.offOwner(this.owner);
  }
}

/** 已注册插件的内部记录：manifest 元数据 + 延迟工厂 + 实例化后的上下文。 */
interface RegisteredPlugin {
  manifest: PluginManifest;
  factory: () => PetPlugin;
  plugin: PetPlugin | null;
  context: PluginContextImpl | null;
  state: PluginState;
}

/**
 * 插件注册表。主进程创建一个实例：
 *  - 收到 IPC_PLUGIN_REGISTER → register()，成功/失败映射为 {ok,error}；
 *  - 应用启动 → start()；动画循环 → tick()；
 *  - setActionBridge() 注入的回调把插件动作转发为 IPC_ACTION 至渲染进程；
 *  - 宿主需要停掉某个插件时 → unregister()（依赖它的插件还活着时拒绝）。
 */
export class PluginRegistry {
  /** 已注册插件，以 name 为唯一键。 */
  private readonly plugins = new Map<string, RegisteredPlugin>();
  /** 内核广播总线：插件订阅按 owner 归属，卸载时批量清理。 */
  private readonly bus = new EventBus<PluginEventMap>();
  /** 应用已启动；启动后新增插件需要立即执行 setup。 */
  private started = false;
  /** 动作桥接（默认 no-op，主进程不注入时插件 emit 静默丢弃）。 */
  private actionBridge: ActionBridge = () => undefined;

  setActionBridge(bridge: ActionBridge): void {
    this.actionBridge = bridge;
  }

  /**
   * register: 登记插件。name 必填且全局唯一，重复注册抛错
   * （主进程 plugin:register 处理器应捕获并返回 {ok:false, error}）。
   * factory 延迟执行：真正的 PetPlugin 实例在 start()/启动后注册时才创建。
   */
  register(manifest: PluginManifest, factory: () => PetPlugin): void {
    const name = manifest.name;
    if (!name || !name.trim()) {
      throw new Error('PluginManifest.name is required');
    }
    if (this.plugins.has(name)) {
      throw new Error(`Plugin "${name}" is already registered`);
    }
    const entry: RegisteredPlugin = {
      manifest,
      factory,
      plugin: null,
      context: null,
      state: 'registered',
    };
    this.plugins.set(name, entry);
    if (this.started) void this.startPlugin(name, entry);
  }

  /** 实例化插件对象。factory 只做构造，初始化副作用必须放 setup（依赖排序需要先读依赖）。 */
  private instantiate(entry: RegisteredPlugin): PetPlugin {
    if (entry.plugin) return entry.plugin;
    const plugin = entry.factory();
    if (!plugin || typeof plugin.setup !== 'function') {
      throw new Error('插件必须导出包含 setup(ctx) 的对象');
    }
    entry.plugin = plugin;
    return plugin;
  }

  /**
   * 启动单个插件。依赖必须已经 started（启动顺序由 resolveStartOrder 保证；
   * 启动后动态注册的插件在这里兜底检查）。setup 失败只标记该插件，不向上抛。
   */
  private async startPlugin(name: string, entry: RegisteredPlugin): Promise<void> {
    if (entry.context || entry.state === 'failed') return;
    try {
      const plugin = this.instantiate(entry);
      const missing = (plugin.dependencies ?? []).filter(
        (dep) => this.plugins.get(dep)?.state !== 'started',
      );
      if (missing.length) throw new Error(`依赖插件未启动：${missing.join(', ')}`);
      const context = new PluginContextImpl(
        name,
        this.bus,
        (action, payload) => this.actionBridge(action, payload),
      );
      entry.context = context;
      entry.state = 'starting';
      await plugin.setup(context);
      entry.state = 'started';
      this.bus.emitTo(name, 'start', undefined);
    } catch (error) {
      entry.context?.dispose();
      entry.context = null;
      entry.state = 'failed';
      console.error(`[plugin] "${name}" failed to start:`, error);
    }
  }

  /**
   * 依赖拓扑排序：返回可启动顺序。
   * 缺失依赖/成环时把该插件（及其依赖方）标记 failed 并跳过——与"坏插件不影响
   * 其它插件"的既有约定一致；依赖深度不受限，但只保证顺序，不产生直接引用。
   */
  private resolveStartOrder(): string[] {
    const order: string[] = [];
    const colors = new Map<string, 'visiting' | 'done'>();
    const visit = (name: string): boolean => {
      const entry = this.plugins.get(name);
      if (!entry) {
        console.error(`[plugin] 依赖的插件 "${name}" 未注册`);
        return false;
      }
      const color = colors.get(name);
      if (color === 'done') return entry.state !== 'failed';
      if (color === 'visiting') {
        entry.state = 'failed';
        console.error(`[plugin] "${name}" 存在循环依赖，跳过`);
        return false;
      }
      colors.set(name, 'visiting');
      try {
        this.instantiate(entry);
      } catch (error) {
        entry.state = 'failed';
        colors.set(name, 'done');
        console.error(`[plugin] "${name}" 实例化失败:`, error);
        return false;
      }
      let ok = true;
      for (const dep of entry.plugin?.dependencies ?? []) {
        if (!visit(dep)) {
          ok = false;
          console.error(`[plugin] "${name}" 依赖的 "${dep}" 无法启动，跳过`);
        }
      }
      colors.set(name, 'done');
      if (!ok) {
        entry.state = 'failed';
        return false;
      }
      order.push(name);
      return true;
    };
    for (const name of [...this.plugins.keys()]) visit(name);
    return order;
  }

  /**
   * start: 按依赖拓扑序逐个启动已注册插件。每个插件获得一个【独立】PluginContextImpl
   * （注入同一 actionBridge），setup 完成后只向该插件派发 'start' 事件。
   * 单个插件失败只影响它自己：记录错误并继续启动其余插件。
   */
  async start(): Promise<void> {
    this.started = true;
    for (const name of this.resolveStartOrder()) {
      const entry = this.plugins.get(name);
      if (entry) await this.startPlugin(name, entry);
    }
  }

  /**
   * unregister: 卸载插件（清订阅 → teardown → 移除登记）。
   * 仍被其它已启动插件依赖时拒绝卸载，避免调用方继续引用一个不再收事件的插件。
   * @returns 是否真的卸载了
   */
  async unregister(name: string): Promise<boolean> {
    const entry = this.plugins.get(name);
    if (!entry) return false;
    const dependents = [...this.plugins.entries()]
      .filter(([other, item]) =>
        other !== name &&
        item.state === 'started' &&
        (item.plugin?.dependencies ?? []).includes(name),
      )
      .map(([other]) => other);
    if (dependents.length) {
      console.error(`[plugin] "${name}" 仍被 ${dependents.join(', ')} 依赖，拒绝卸载`);
      return false;
    }
    const context = entry.context;
    entry.context = null;
    // 先清订阅再 teardown：避免 teardown 期间还被 tick/windowChange 回调打断
    context?.dispose();
    try {
      await entry.plugin?.teardown?.();
    } catch (error) {
      console.error(`[plugin] "${name}" teardown 抛错（已忽略）：`, error);
    }
    this.plugins.delete(name);
    return true;
  }

  /**
   * tick: 外部驱动（主进程 setInterval 每帧调用），把距上一帧的 deltaTime 派发给
   * 所有已启动插件的 'tick' 订阅者。start() 前调用时没有订阅者，安全空转。
   */
  tick(deltaTime: number): void {
    this.bus.emit('tick', deltaTime);
  }

  /** windowChange: 主进程 windowMonitor 变化时调用，广播给已启动插件。 */
  windowChange(info: WindowInfo | null): void {
    this.bus.emit('windowChange', info);
  }

  /** userInput: 主进程收到用户输入时调用，广播给已启动插件。 */
  userInput(text: string): void {
    this.bus.emit('userInput', text);
  }

  /** 已注册插件清单（仅 manifest），供主进程查询/调试。 */
  list(): PluginManifest[] {
    return [...this.plugins.values()].map((entry) => entry.manifest);
  }
}

/** 全局默认 registry 实例（主进程直接 import default 使用；需要多实例时可 new PluginRegistry）。 */
const registry = new PluginRegistry();
export default registry;
```

### 4.4 主进程接线改动 `src/main/mainImpl.js`

只需要让适配层把插件对象上的两个可选字段透传给 registry（`register` 的调用点，约 2009 行）：

```js
const dependencies = Array.isArray(plugin.dependencies)
    ? plugin.dependencies.filter((dep) => typeof dep === 'string' && dep.trim())
    : undefined;
inner.register(manifest, () => ({
    name: typeof plugin.name === 'string' ? plugin.name : manifest.name,
    version: typeof plugin.version === 'string' ? plugin.version : manifest.version,
    dependencies,
    teardown: typeof plugin.teardown === 'function' ? plugin.teardown.bind(plugin) : undefined,
    setup: plugin.setup.bind(plugin),
}));
```

其余不动：`loadRegistryAdapter()` 的降级 no-op、`main/build` 的 `start/tick/emitWindowChange/emitUserInput`
调用点、`ipc.ts:514` 的 `emitUserInput`、`ipc.ts:980-997` 的 `plugin:register` 处理器都保持现状。

> 卸载能力（`unregister`）本次只在主进程内部提供，不接到设置页"移除插件"按钮——
> 接 UI 需要新增一条 IPC 通道（四处同步），列为未决问题（§9-1）。

### 4.5 渲染层微内核 `src/renderer/kernel.ts`（新增）

```ts
/**
 * kernel.ts —— 渲染层微内核（全局脚本，暴露 window.PetKernel）
 *
 * 为什么需要它：渲染层没有模块系统（见 index.html 注释），功能模块之间只能靠
 * window.PetXxx 互相引用，谁先加载、谁依赖谁、谁清理都散在 renderer.ts 里。
 * 内核把「事件总线 + 服务注册表 + 插件生命周期」集中到一处：功能插件在
 * kernel.js 之后、renderer.js 之前用 define() 登记，renderer.ts 装配完服务后 start()。
 *
 * 边界：内核只做装配与分发，不碰 DOM/模型；渲染能力（handle、模型预设、表情应用）
 * 由 renderer.ts 注册成服务，插件通过 service() 取用，不能直接引用 renderer.ts 的局部变量。
 */
(() => {
  'use strict';

  type Any = any;
  type WindowInfo = import('../shared/contracts').WindowInfo;

  /**
   * 内核事件表：只登记跨模块广播的事件。
   * 新增事件 = 这里加一行 + 发送方 emit；插件不能自造未登记的事件名。
   */
  interface KernelEventMap {
    /** preload 推送的 AI 回复全文（IPC_AI_DONE） */
    'chat:reply': string;
    /** 活动窗口变化（IPC_ON_WINDOW_CHANGE；null = 无活动窗口） */
    'window:change': WindowInfo | null;
    /** 全局光标推送（IPC_GLOBAL_CURSOR；null = 光标失效） */
    'cursor:global': { x: number; y: number } | null;
    /** 插件广播的情绪判定结果（供调试/其它插件观察，渲染动作已由 render 服务完成） */
    'emotion:detected': { label: string; confidence: number; expression: string };
  }

  /** 插件拿到的上下文：订阅事件、广播事件、取内核服务、注册同步能力。 */
  interface PluginContext {
    on<K extends keyof KernelEventMap>(event: K, callback: (payload: KernelEventMap[K]) => void): void;
    emit<K extends keyof KernelEventMap>(event: K, payload: KernelEventMap[K]): void;
    service<T = Any>(name: string): T | null;
    /** 注册一项同步能力（如 emotion.applyText），供内核/调试入口调用；随插件卸载移除。 */
    provide(name: string, api: unknown): void;
  }

  /** 渲染层插件：index.html 在 kernel.js 之后、renderer.js 之前按顺序加载并 define。 */
  interface RendererPlugin {
    name: string;
    version: string;
    /** 依赖的插件名：只用于保证 setup 顺序，不产生直接引用；缺失依赖时该插件不启动。 */
    dependencies?: readonly string[];
    setup(ctx: PluginContext): void | Promise<void>;
    /** 卸载时释放插件自管的资源（定时器/监听）。 */
    teardown?(): void | Promise<void>;
  }

  interface ServiceEntry {
    /** 归属：null = 内核/装配层注册；插件名 = 由该插件 provide。 */
    readonly owner: string | null;
    readonly api: unknown;
  }

  interface ListenerEntry {
    readonly owner: string | null;
    readonly callback: (payload: Any) => void;
  }

  interface PluginEntry {
    readonly plugin: RendererPlugin;
    readonly dependencies: readonly string[];
    state: 'registered' | 'starting' | 'started' | 'failed';
    context: PluginContext | null;
  }

  const listeners = new Map<keyof KernelEventMap, ListenerEntry[]>();
  const services = new Map<string, ServiceEntry>();
  const plugins = new Map<string, PluginEntry>();
  let started = false;

  function onEvent<K extends keyof KernelEventMap>(
    event: K,
    callback: (payload: KernelEventMap[K]) => void,
    owner: string | null,
  ): void {
    const list = listeners.get(event) ?? [];
    const exists = list.some((entry) => entry.owner === owner && entry.callback === callback);
    if (!exists) list.push({ owner, callback: callback as (payload: Any) => void });
    listeners.set(event, list);
  }

  function offOwner(owner: string): void {
    for (const [event, list] of listeners) {
      const kept = list.filter((entry) => entry.owner !== owner);
      if (kept.length) listeners.set(event, kept);
      else listeners.delete(event);
    }
    for (const [name, entry] of services) {
      if (entry.owner === owner) services.delete(name);
    }
  }

  /** owner=null 表示广播，否则只派发给该 owner 的订阅。 */
  function dispatch<K extends keyof KernelEventMap>(
    event: K,
    payload: KernelEventMap[K],
    owner: string | null,
  ): void {
    const list = listeners.get(event);
    if (!list) return;
    // 先快照：订阅者在回调里增删订阅不能改变本轮派发集合
    for (const entry of [...list]) {
      if (owner !== null && entry.owner !== owner) continue;
      try {
        entry.callback(payload);
      } catch (err) {
        console.error(`[kernel] 事件 "${String(event)}" 的订阅者抛错（已隔离）：`, err);
      }
    }
  }

  function createContext(owner: string): PluginContext {
    return {
      on: (event, callback) => { onEvent(event, callback, owner); },
      emit: (event, payload) => { dispatch(event, payload, null); },
      service: <T = Any>(name: string): T | null => {
        const entry = services.get(name);
        return entry ? (entry.api as T) : null;
      },
      provide(name: string, api: unknown): void {
        const existing = services.get(name);
        if (existing && existing.owner !== owner) {
          // 服务名冲突保留先注册者：装配层服务优先，插件不能覆盖内核能力
          console.error(
            `[kernel] 服务名冲突："${name}" 已被 ${existing.owner ?? '内核'} 注册，忽略插件 "${owner}" 的注册`,
          );
          return;
        }
        services.set(name, { owner, api });
      },
    };
  }

  async function setupPlugin(entry: PluginEntry): Promise<void> {
    if (entry.state === 'failed' || entry.context) return;
    const name = entry.plugin.name;
    const missing = entry.dependencies.filter((dep) => plugins.get(dep)?.state !== 'started');
    if (missing.length) {
      entry.state = 'failed';
      console.error(`[kernel] 插件 "${name}" 依赖未启动：${missing.join(', ')}`);
      return;
    }
    const context = createContext(name);
    entry.context = context;
    entry.state = 'starting';
    try {
      await entry.plugin.setup(context);
      entry.state = 'started';
    } catch (err) {
      offOwner(name);
      entry.context = null;
      entry.state = 'failed';
      console.error(`[kernel] 插件 "${name}" 启动失败：`, err);
    }
  }

  /** 依赖拓扑排序：缺失依赖/成环的插件（及其依赖方）标记 failed 并跳过。 */
  function resolveOrder(): PluginEntry[] {
    const order: PluginEntry[] = [];
    const colors = new Map<string, 'visiting' | 'done'>();
    const visit = (name: string): boolean => {
      const entry = plugins.get(name);
      if (!entry) {
        console.error(`[kernel] 依赖的插件 "${name}" 未登记`);
        return false;
      }
      const color = colors.get(name);
      if (color === 'done') return entry.state !== 'failed';
      if (color === 'visiting') {
        entry.state = 'failed';
        console.error(`[kernel] 插件 "${name}" 存在循环依赖，跳过`);
        return false;
      }
      colors.set(name, 'visiting');
      let ok = true;
      for (const dep of entry.dependencies) {
        if (!visit(dep)) {
          ok = false;
          console.error(`[kernel] 插件 "${name}" 依赖的 "${dep}" 无法启动，跳过`);
        }
      }
      colors.set(name, 'done');
      if (!ok) {
        entry.state = 'failed';
        return false;
      }
      order.push(entry);
      return true;
    };
    for (const name of [...plugins.keys()]) visit(name);
    return order;
  }

  const api = {
    /** 登记插件（脚本加载期调用）。重名只报错，不覆盖已登记的那个。 */
    define(plugin: RendererPlugin): void {
      if (!plugin || typeof plugin.setup !== 'function' || typeof plugin.name !== 'string' || !plugin.name.trim()) {
        console.error('[kernel] define 需要 {name, setup}');
        return;
      }
      if (plugins.has(plugin.name)) {
        console.error(`[kernel] 插件名重复："${plugin.name}"`);
        return;
      }
      const entry: PluginEntry = {
        plugin,
        dependencies: Array.isArray(plugin.dependencies) ? plugin.dependencies.filter((dep) => typeof dep === 'string' && !!dep) : [],
        state: 'registered',
        context: null,
      };
      plugins.set(plugin.name, entry);
      // 内核已启动后登记：立即启动（依赖未就绪会按失败隔离处理）
      if (started) void setupPlugin(entry);
    },

    /** 注册内核服务（renderer.ts 装配阶段调用）。同名以先注册者为准。 */
    provide(name: string, service: unknown): void {
      if (services.has(name)) {
        console.error(`[kernel] 服务名重复："${name}"`);
        return;
      }
      services.set(name, { owner: null, api: service });
    },

    service<T = Any>(name: string): T | null {
      const entry = services.get(name);
      return entry ? (entry.api as T) : null;
    },

    /** 内核/调试入口订阅事件（不随插件卸载清理）。 */
    on<K extends keyof KernelEventMap>(event: K, callback: (payload: KernelEventMap[K]) => void): void {
      onEvent(event, callback, null);
    },

    /** 广播事件（装配层把 preload 推送翻译成内核事件）。 */
    emit<K extends keyof KernelEventMap>(event: K, payload: KernelEventMap[K]): void {
      dispatch(event, payload, null);
    },

    /** 启动所有已登记插件（renderer.ts 装配完服务后调用一次）。 */
    async start(): Promise<void> {
      started = true;
      for (const entry of resolveOrder()) await setupPlugin(entry);
    },

    /** 逆序卸载（页面卸载/测试用）：先清订阅，再调插件自己的 teardown。 */
    async stop(): Promise<void> {
      for (const entry of [...plugins.values()].reverse()) {
        if (!entry.context) continue;
        offOwner(entry.plugin.name);
        entry.context = null;
        entry.state = 'registered';
        try {
          await entry.plugin.teardown?.();
        } catch (err) {
          console.error(`[kernel] 插件 "${entry.plugin.name}" teardown 抛错（已忽略）：`, err);
        }
      }
    },

    /** 已登记插件的状态快照（__petDebug.plugins() 与测试用）。 */
    status(): Array<{ name: string; version: string; state: string; dependencies: readonly string[] }> {
      return [...plugins.values()].map((entry) => ({
        name: entry.plugin.name,
        version: entry.plugin.version,
        state: entry.state,
        dependencies: entry.dependencies,
      }));
    },
  };

  const w = (typeof window !== 'undefined' ? window : globalThis) as unknown as Record<string, unknown>;
  w.PetKernel = api;
})();
```

### 4.6 渲染层插件契约说明

| 成员 | 语义 | 约束 |
|---|---|---|
| `name` / `version` | 插件标识；`name` 全局唯一（重名只报错，不覆盖） | 与主进程插件不同，渲染层插件没有 manifest 文件 |
| `dependencies` | 只影响启动顺序；缺依赖/成环 → `failed`（其余插件继续） | 不允许借此拿到其它插件对象 |
| `setup(ctx)` | 注册事件/服务；可异步 | 抛错被隔离，不影响其它插件和页面 |
| `teardown()` | 释放插件自管资源 | 内核先清订阅再调用，teardown 期间收不到事件 |
| `ctx.on` / `ctx.emit` | 内核事件表里的广播 | 只能使用 `KernelEventMap` 登记过的事件名 |
| `ctx.service(name)` | 同步取内核服务（缺失返回 null，调用方自行降级） | 典型：`render` / `emotionRules` |
| `ctx.provide(name, api)` | 注册同步能力供内核/调试入口调用 | 命名冲突保留先注册者（内核服务优先） |

---

## 5. 解耦示例：把 emotion 从渲染主流程剥离成插件

### 5.1 现状调用链（4 个入口，3 个出口）

```
入口 ① AI 回复完成   renderer.ts:2157-2162  onChat({full}) → applyEmotionFromText(full)
入口 ② 调试同步调用   renderer.ts:5765        __petDebug.emotion(text)
入口 ③ 追踪中枢同步   renderer.ts:1046-1047   window.petTracking.emotion(text)
入口 ④ 追踪帧情绪字段 renderer.ts:946-950     pushTrackingFrame(frame.emotion) → handle.applyEmotionLabel()
                                                （低置信过滤后直接应用，不经过 classify —— 本次保持不动）

出口 ① 规则判定       window.PetEmotion.classify()（emotion.ts）
出口 ② 表情写入       live2d handle.applyEmotionLabel(label, presetExpressionName)
出口 ③ 调试状态       lastEmotion → window.petTracking.state()
反向依赖：live2d.ts:1476-1498 的 applyEmotionLabel() 又反过来读 window.PetEmotion.expressionFor()
```

### 5.2 目标调用链

```
preload onChat(full)
   └─► renderer.ts（装配根）── emit('chat:reply', full) ──► kernel 事件总线
                                                             │
                                    ┌────────────────────────┘
                                    ▼
                     plugins/emotion.ts（策略插件，订阅 chat:reply）
                        │  ctx.service('render')   ← 渲染机制（内核服务）
                        │  ctx.service('emotionRules') ← 规则库（emotion.js）
                        ▼
                 render.applyEmotionLabel(label, presetExpressionName)
                        │
                        ▼
                 live2d handle.applyEmotionLabel()  +  lastEmotion（内核记录）
                        │
                        └─► ctx.emit('emotion:detected', {label, confidence, expression})
                                        │
                                        └─► 其它插件 / 调试入口可订阅观察

同步入口：window.petTracking.emotion() / __petDebug.emotion()
   └─► kernel.service('emotion').applyText(text) ──► 同一条 applyText 路径
```

职责划分（这是本示例的核心，不是"把文件挪个位置"）：

| 逻辑 | 拆分后归属 | 理由 |
|---|---|---|
| 文本规则判定（关键词/否定/置信度算法） | `emotion.ts`（规则库，保持纯函数、可单测） | 已由 `window.PetEmotion` 对外提供，且 `live2d.ts` 还在用，不能删 |
| 置信度门槛、neutral 跳过、预设映射选择 | `plugins/emotion.ts` | 属于"策略"，换判定规则不应改渲染入口 |
| 写哪个表情参数、字体/模糊匹配兜底 | `live2d.ts`（不动） | 属于渲染机制 |
| 记录 `lastEmotion`、总闸判断 | `renderer.ts` 的 `render` 服务 | 只有它持有 `currentHandle` 与模型预设 |
| 事件广播 | 内核总线 | 让其它模块可观察，不产生直接引用 |

### 5.3 情绪插件 `src/renderer/plugins/emotion.ts`（新增）

```ts
/**
 * plugins/emotion.ts —— 情绪插件（渲染层内置插件）
 *
 * 为什么拆出来：文本 → 情绪 → 表情这套策略原先生长在 renderer.ts 的推送回调里
 * （判定、置信度门槛、模型预设映射混在装配代码中），live2d.ts 也直接读
 * window.PetEmotion；策略和渲染机制耦合，换一套情绪来源要改三处。
 * 拆分后：规则库仍在 emotion.ts（纯函数、可单测），策略在这里，渲染机制在内核
 * 的 render 服务里；对外的 window.PetEmotion 与 window.petTracking.emotion 保持原样。
 *
 * 加载顺序：index.html 里 kernel.js → emotion.js → 本文件 → renderer.js。
 */
(() => {
  'use strict';

  type Any = any;

  /** 内核服务 'render' 的最小能力（结构类型，与 renderer.ts 注入的实现等价）。 */
  interface RenderService {
    trackingEnabled(): boolean;
    emotionMap(): Record<string, string> | null;
    applyEmotionLabel(label: string, expressionName?: string): string | null;
  }

  /** 内核服务 'emotionRules'：emotion.ts 暴露的分类器。 */
  interface EmotionRules {
    classify(text: unknown): { label?: string; confidence?: number } | null;
  }

  interface PluginContext {
    on(event: 'chat:reply', callback: (full: string) => void): void;
    emit(event: 'emotion:detected', payload: { label: string; confidence: number; expression: string }): void;
    service<T = Any>(name: string): T | null;
    provide(name: string, api: unknown): void;
  }

  /** 置信度门槛：低于它宁可不切表情（与拆分前 renderer.ts 内的判定一致）。 */
  const MIN_CONFIDENCE = 0.34;

  /**
   * 文本 → 情绪 → 表情，返回实际应用的表情名（未命中/模型无对应表情 → null）。
   * 机制（写哪个表情、记录最近情绪）由内核 render 服务负责；本插件只决定
   * "该不该切、切哪个"——换判定规则不需要动渲染层。
   */
  function applyText(ctx: PluginContext, text: unknown): string | null {
    const render = ctx.service<RenderService>('render');
    const rules = ctx.service<EmotionRules>('emotionRules');
    if (!render || !rules || !render.trackingEnabled()) return null;
    let result: { label?: string; confidence?: number } | null = null;
    try {
      result = rules.classify(text);
    } catch {
      return null;
    }
    if (!result || !result.label || result.label === 'neutral') return null;
    if (typeof result.confidence === 'number' && result.confidence < MIN_CONFIDENCE) return null;
    // 模型预设点名（pet-model.json 的 emotionMap）优先；live2d 侧会校验表情名真实存在
    const mapped = render.emotionMap()?.[result.label];
    const applied = render.applyEmotionLabel(result.label, typeof mapped === 'string' ? mapped : undefined);
    if (!applied) return null;
    ctx.emit('emotion:detected', {
      label: result.label,
      confidence: typeof result.confidence === 'number' ? result.confidence : 1,
      expression: applied,
    });
    return applied;
  }

  const kernel = (typeof window !== 'undefined' ? (window as Any).PetKernel : null);
  // 非完整页面（只加载规则库的单测/embed）没有内核：不登记插件，也不报错
  if (!kernel || typeof kernel.define !== 'function') return;
  kernel.define({
    name: 'emotion',
    version: '1.0.0',
    setup(ctx: PluginContext): void {
      ctx.on('chat:reply', (full: string) => {
        applyText(ctx, full);
      });
      // 同步能力：window.petTracking.emotion(text) / __petDebug.emotion(text) 走这里
      ctx.provide('emotion', { applyText: (text: string) => applyText(ctx, text) });
    },
  });
})();
```

### 5.4 `renderer.ts` 改动清单

**① 新增类型（放在 `RendererBridge` 之后）**

```ts
/** 渲染层微内核（见 ./kernel.ts 底部 window.PetKernel） */
interface PetKernelApi {
  provide(name: string, service: unknown): void;
  service<T = Any>(name: string): T | null;
  on(event: string, callback: (payload: Any) => void): void;
  emit(event: string, payload: Any): void;
  start(): Promise<void>;
  stop(): Promise<void>;
  status(): Array<{ name: string; version: string; state: string; dependencies: readonly string[] }>;
}

/** 内核服务 'render' 的实现：渲染机制留在渲染层，情绪策略在插件里 */
interface RenderService {
  trackingEnabled(): boolean;
  emotionMap(): Record<string, string> | null;
  applyEmotionLabel(label: string, expressionName?: string): string | null;
}

/** 内核服务 'emotionRules'：emotion.js 暴露的规则库 */
interface EmotionRules {
  classify(text: unknown): { label?: string; confidence?: number } | null;
}

/** 情绪插件对内暴露的同步能力（window.petTracking.emotion / __petDebug.emotion 用） */
interface EmotionApi {
  applyText(text: string): string | null;
}
```

**② 删除** `renderer.ts:973-995` 的 `applyEmotionFromText()`，替换为装配函数：

```ts
/** 渲染层微内核入口（kernel.js 缺失时为 null：情绪插件不启动，其余功能不受影响） */
function petKernel(): PetKernelApi | null {
  const kernel = (window as Any).PetKernel;
  return kernel && typeof kernel.start === 'function' ? (kernel as PetKernelApi) : null;
}

/**
 * 装配内核服务：内核只负责分发，渲染机制（当前 handle / 模型预设 / 表情应用）
 * 仍归渲染层所有，插件通过 service() 取用，不能直接引用 renderer.ts 的局部变量。
 */
function installKernelServices(): void {
  const kernel = petKernel();
  if (!kernel) {
    console.error('[renderer] 未加载 kernel.js —— 情绪插件不会启动');
    return;
  }
  const renderService: RenderService = {
    trackingEnabled: () => trackingEnabled,
    emotionMap: () => activeModelPreset?.emotionMap ?? null,
    applyEmotionLabel(label: string, expressionName?: string): string | null {
      const h = trackingHandle();
      if (!h || typeof h.applyEmotionLabel !== 'function') return null;
      const applied = h.applyEmotionLabel(label, expressionName);
      if (applied) lastEmotion = { label, expression: applied, at: Date.now() };
      return applied;
    },
  };
  kernel.provide('render', renderService);
  const rules = (window as Any).PetEmotion as EmotionRules | undefined;
  if (rules && typeof rules.classify === 'function') kernel.provide('emotionRules', rules);
}

/** 启动内核里的内置插件；页面卸载时逆序 teardown，避免定时器/监听残留 */
async function startKernel(): Promise<void> {
  const kernel = petKernel();
  if (!kernel) return;
  window.addEventListener('pagehide', () => {
    void kernel.stop();
  });
  await kernel.start();
}

/** 文本 → 情绪 → 表情：策略在情绪插件里，这里只做同步调用与降级 */
function applyEmotionText(text: string): string | null {
  const emotion = petKernel()?.service<EmotionApi>('emotion');
  return emotion ? emotion.applyText(text) : null;
}
```

**③ 三个调用点替换**

```diff
  // renderer.ts:2157-2162（onChat 的 full 分支）
- // 文本情感 → 表情（emotion.js 规则判定；模型没有对应表情就保持原样）
- applyEmotionFromText(payload.full);
+ // 文本情感 → 表情：情绪插件订阅内核事件后处理（模型没有对应表情就保持原样）
+ petKernel()?.emit('chat:reply', payload.full);

  // renderer.ts:1046-1047（window.petTracking 的 emotion 入口）
- /** 文本情感 → 表情，返回应用到的表情名 */
- emotion: applyEmotionFromText,
+ /** 文本情感 → 表情，返回应用到的表情名 */
+ emotion: applyEmotionText,

  // renderer.ts:5764-5765（__petDebug 的 emotion 入口）
- emotion: (text: string) => applyEmotionFromText(text),
+ emotion: applyEmotionText,
+ /** 渲染层插件状态（内核登记的插件与启动结果）：排查"插件没生效"用 */
+ plugins: () => petKernel()?.status() ?? null,
```

**④ 其余事件也送进总线（适配层职责，插件因此不用各自去 `window.electron` 打洞）**

```diff
  // renderer.ts:424 handleWindowChange 首行
  function handleWindowChange(info: WindowInfo | null): void {
+   petKernel()?.emit('window:change', info);
    if (!info) { … }
  }

  // renderer.ts:2243-2248 onGlobalCursor 回调首行
      bridge.onGlobalCursor((pos) => {
+       petKernel()?.emit('cursor:global', pos ?? null);
        if (pos && typeof pos.x === 'number' && typeof pos.y === 'number') {
          gazeApi()?.setGlobal(pos.x, pos.y);
        }
      });
```

**⑤ `init()` 里装配顺序（`renderer.ts:5922` 附近，bridge 就绪之后）**

```ts
  // 渲染层内核：先装配服务再启动插件（插件 setup 里要 service() 取 render/emotionRules）
  installKernelServices();
  await startKernel();
  installDebugHooks(bridge);
```

> 顺序要求：`installKernelServices()` 必须在 `startKernel()` 之前；`startKernel()` 必须在
> `subscribeOptionalPushes()` 之前（事件可能在任何时刻到来）。`CHAT_PANEL_MODE` / `THINK_PANEL_MODE`
> 分支在更早处 return，不启动内核（那两个窗口不渲染模型，不需要情绪插件）。

### 5.5 刻意不动的部分（及其原因）

| 不动的东西 | 原因 |
|---|---|
| `emotion.ts`（规则库 `window.PetEmotion`） | 纯函数、零依赖、被单测/Node 直接加载；且 `live2d.ts:1476-1498` 仍在读它——删掉就是破坏公共全局 API |
| `live2d.ts` 的 `applyEmotionLabel()` | 属渲染机制，保留在模型渲染模块 |
| `pushTrackingFrame()` 里的 `frame.emotion` 分支（`renderer.ts:946-950`） | 这是"外部追踪帧"域，语义是"数据源已经给出标签、直接应用"，与文本判定不是同一条链路；强行统一会改变低置信帧的处理时机 |
| `IPC_ACTION` 的 `emotion` 分支（`renderer.ts:2196-2199`） | 主进程/外部脚本直接推标签（非文本），行为保持不变 |
| `window.petTracking` / `__petDebug` 的既有字段 | 公共调试/自动化接口；本次只在 `__petDebug` 上追加 `plugins()` |
| `preload.ts` / `contracts.ts` | 本次不新增 IPC 通道与类型 |

### 5.6 装配与测试同步改动

**`src/renderer/index.html`（脚本顺序固定）**

```html
  <script src="./lib/live2d-engine.min.js"></script>
  <!-- 渲染层微内核：必须在所有功能插件之前加载（插件在加载期向内核登记；renderer.js 负责装配服务并启动） -->
  <script src="./kernel.js"></script>
  <!-- ② 渲染辅助层：情感判定（全局脚本，暴露 window.PetEmotion；纯函数，无依赖） -->
  <script src="./emotion.js"></script>
  …
  <!-- 内置功能插件：kernel.js 之后、renderer.js 之前加载（renderer.js 启动内核） -->
  <script src="./plugins/emotion.js"></script>
  <!-- ③ 渲染辅助层：moc3/portrait/placeholder 挂载（全局脚本，暴露 window.PetLive2d） -->
  <script src="./live2d.js"></script>
  <!-- ④ 渲染入口 -->
  <script src="./renderer.js"></script>
```

**`scripts/assemble-renderer.js`**

```js
  // 3) tsc 产物（都是全局脚本：内核 / renderer 主逻辑 / Live2D 层 / 情感判定 / 声纹显示 / 视线控制器）
  for (const f of ['kernel.js', 'renderer.js', 'live2d.js', 'emotion.js', 'voicelab.js', 'gazeController.js', 'ttsMouth.js']) {
    if (copyFile(path.join(DIST, f), path.join(DST, f))) ok.push(f);
  }
  // 3.1) 渲染层内置插件（目录整体拷贝：index.html 里在 kernel.js 之后、renderer.js 之前加载）
  if (fs.existsSync(path.join(DIST, 'plugins'))) {
    fs.cpSync(path.join(DIST, 'plugins'), path.join(DST, 'plugins'), { recursive: true });
    ok.push('plugins/ (渲染层内置插件)');
  }

  …
  // 硬性校验：CommonJS 垫片检查同样覆盖 kernel.js 与 plugins/*.js
  const commonScripts = ['kernel.js', 'renderer.js', 'live2d.js', 'emotion.js', 'voicelab.js', 'gazeController.js', 'ttsMouth.js'];
  for (const f of fs.existsSync(path.join(DST, 'plugins')) ? fs.readdirSync(path.join(DST, 'plugins')) : []) {
    if (f.endsWith('.js')) commonScripts.push(path.join('plugins', f));
  }
  for (const f of commonScripts) { … }
```

**`tests/behaviorTriggers.test.js`（假 DOM 必须按 index.html 顺序加载）**

```js
const KERNEL = path.join(APP, 'dist', 'renderer', 'kernel.js');
const EMOTION_PLUGIN = path.join(APP, 'dist', 'renderer', 'plugins', 'emotion.js');
…
  delete require.cache[require.resolve(KERNEL)];
  delete require.cache[require.resolve(EMOTION_PLUGIN)];
  …
  require(GAZE);
  require(KERNEL); // 渲染层内核：renderer 初始化时装配服务并 start
  require(EMOTION_PLUGIN); // 内置插件：加载期向内核登记（index.html 里同样先于 renderer.js）
  require(RENDERER);
```

> 注意：假 DOM 里的假 handle 要补 `applyTrackingFrame() {}` 才能走到情绪通道——这暴露了一个既有事实：
> `trackingHandle()` 要求 handle 具备追踪层入口（真实 moc3/portrait handle 都有）。这不是本次引入的约束。

---

## 6. 实施记录

| 阶段 | 改动范围 | 行为影响 | 回滚 |
|---|---|---|---|
| P0 基线 | 无（记录 `npm test` 结果） | 无 | — |
| P1 主进程内核化 | `eventBus.ts` 新增；`types.ts` 增量；`registry.ts` 改造；`mainImpl.js` 透传；新增 `tests/pluginRegistry.test.js` | 无（事件名/顺序/去重/失败隔离与旧实现一致） | 还原 3 个文件、删 `eventBus.ts` |
| P2 渲染层内核 | `kernel.ts` 新增；`renderer.ts` 装配/转发/`plugins()`；`index.html`；`assemble-renderer.js`；测试 harness 加载顺序 | 无（只接线，不迁逻辑；`window.PetKernel.status()` 显示 0 插件） | 同上 |
| P3 情绪插件化 | `plugins/emotion.ts` 新增；`renderer.ts` 删策略/换 3 个调用点；新增 `tests/emotionPlugin.test.js`；harness 加载插件 | 与旧逻辑等价（§2.5 对照表） | 还原 `renderer.ts`、删插件目录 |
| P4 收尾（可选） | `CONTRACT.md` 插件可选字段；`PROJECT_LAYOUT.md` §2 目录树与 `plugin-system` 位置修正；评估 gaze/ttsMouth/voicelab 是否也变成插件/服务；评估 `live2d.ts` 改为经内核服务取规则 | 无（文档/评估） | 单独提交 |

每阶段提交一串独立 commit（`refactor(plugin): …`），P1/P2 必须能在不完成 P3 的情况下长期停留。

---

## 7. 验证与验收

### 7.1 自动验证命令

```powershell
cd Live2D-AI-Desktop-Pet-Framework-main
npm run build:all            # tsc + 装配（含 assemble 的全局脚本/CommonJS 守卫）
npm test                     # tsc + assemble + 全部 node --test
node --test tests/behaviorTriggers.test.js   # 渲染层 vm 集成测试（最接近真实初始化）
node --test tests/pluginRegistry.test.js tests/emotionPlugin.test.js   # P1/P3 实施后新增的用例

# 回归套件
$env:PET_APP_ROOT=(Get-Location).Path
node "<本机工作目录>\run_all_checks.js"
```

P3 之后的通过标准：`npm test` 中 `behaviorTriggers` 的 4 条全绿（已知的 4 条过期测试不因本次
改造恶化）；`pluginRegistry` / `emotionPlugin` 新增用例全绿；`npm run check:privacy` 通过。

### 7.2 验证记录

1. **类型检查**：把两个内核、情绪插件、改造后的 `registry.ts`/`types.ts`/`renderer.ts` 放进
   临时镜像目录，用与项目相同的编译选项跑 `tsc`——通过（含 `renderer.ts` 全文件约 6000 行）。
2. **主进程骨架自检**（Node 直接跑编译产物）：乱序注册 A/B（B 依赖 A）、C（缺依赖）、D/E（循环依赖）：
   - 启动顺序 A→B；C/D/E 未 setup；每个插件只收到 1 次自己的 `start`；动作桥转发正确；
   - `tick/windowChange/userInput` 广播正确；同一回调重复注册只收到一次；
   - `unregister('A')` 被依赖保护拒绝；先卸 B 再卸 A 成功；`teardown` 被调用；卸载后不再收到事件。
3. **渲染层内核 + 情绪插件自检**：
   - `define` → `start` 状态正确；服务缺失时 `service()` 返回 null 并可降级；
   - `kernel.emit('chat:reply', '我今天很开心')` → 插件 classify → `render.applyEmotionLabel` 被调用；
   - `kernel.service('emotion').applyText()` 返回表情名；neutral 不切表情；`stop()` 后服务被移除、事件不再派发。
4. **仓库内临时集成（改完后已 `git checkout` 还原）**：
   - `npm run build:all` 通过；`assemble` 输出包含 `kernel.js`、`plugins/emotion.js`，CommonJS 守卫通过；
   - `node --test tests/behaviorTriggers.test.js`：4/4 通过；
   - 追加的临时集成用例通过：`__petDebug.plugins()` 显示 `emotion/started`、`__petDebug.emotion('今天真开心')`
     返回假 handle 的表情名、`onChat({full})` 推入后 `window.petTracking.state().lastEmotion` 被写入；
   - 还原后重跑基线 `behaviorTriggers` 仍 4/4 通过，`git status` 仅剩用户原有的 `src/main/ai/mcpClient.ts` 改动。

### 7.3 建议新增的测试

| 文件 | 覆盖点 |
|---|---|
| `tests/pluginRegistry.test.js` | 依赖拓扑/缺失/成环；`start` 只发自己；`tick/windowChange/userInput` 广播；重复回调去重；订阅者抛错隔离；动作桥；卸载依赖保护；`teardown`；卸载后无事件 |
| `tests/rendererKernel.test.js` | `define` 重名；依赖缺失/成环；服务冲突（内核优先）；`service()` 缺失返回 null；`stop()` 清订阅与插件服务；`status()` |
| `tests/emotionPlugin.test.js` | `applyText` 六条分支（总闸关闭/无规则/neutral/低置信/预设映射命中/模型无对应表情）；`emotion:detected` 载荷 |

### 7.4 手工冒烟清单

1. AI 回复里带"开心/难过/生气" → 模型表情按原行为切换（三处入口任一）。
2. 控制台 `__petDebug.emotion('今天真开心')` 返回表情名；`__petDebug.plugins()` 显示 `emotion: started`。
3. `window.petTracking.emotion('...')` 返回值与改造前一致；`window.petTracking.state().lastEmotion` 有记录。
4. 换成没有表情的模型 / 立绘模型：不报错、不切表情（原有降级）。
5. 切模型后，`pet-model.json` 的 `emotionMap` 仍然生效。
6. 主进程装一个最小用户插件：`start/tick/windowChange/userInput` 都收到；`ctx.emit('speak', …)` 能出气泡。
7. 故意让插件 `setup` 抛错：其它插件与应用功能不受影响（日志有 `[plugin] … failed to start`）。
8. 刷新页面（devtools）后不出现重复 tick/chat 处理（订阅清理正确）。

---

## 8. 关键决策记录（为什么这样，不那样）

| # | 决策 | 理由 / 被否方案 |
|---|---|---|
| 1 | 不引入打包器、不改渲染层为 ESM | `assemble-renderer.js`、`index.html`、vm 测试都依赖"全局脚本 + 固定顺序"；引打包器属于另一场重构，且违反"不改依赖/构建链"的约束 |
| 2 | 不开放第三方渲染层插件 | `contextIsolation` + CSP `script-src 'self'`；动态加载需要新 IPC、静态路由与权限模型（安全边界），本次不做 |
| 3 | 保留 `PluginRegistry` | 注册表已承担插件管理职责，不再增加平行管理器或别名 |
| 4 | 依赖声明放 `PetPlugin` 而非 `PluginManifest`/`pet-plugin.json` | manifest 是对外注册契约，加字段要同步扫描/校验/IPC/preload/文档五处；依赖只是宿主调度信息。代价：资产面板看不到依赖（目前也不需要） |
| 5 | 总线自己写（约 70 行）而不用 Node `EventEmitter` | 需要按插件归属批量清理订阅 + `PluginEventMap` 类型收窄；EventEmitter 两者都要额外包一层 |
| 6 | 总线同步派发 | 事件顺序是行为的一部分（`windowChange` 后紧跟 `tick`）；异步化会改变插件观察顺序，也把错误挪到无法归属的位置 |
| 7 | 渲染层插件用静态 `<script>` 登记 | 与现有模块加载方式完全一致；代价是新增插件要改 `index.html`/assemble/测试三处，这是无打包器的固有成本 |
| 8 | `emotion.ts` 规则库保留，只迁"策略/流程" | `window.PetEmotion` 是既有公共全局（`live2d.ts` 仍在用），删或改签名违反"不改公共 API" |
| 9 | 用户插件信任模型不变 | Node 进程内插件天然能 `require` 任意模块（现状即如此）；沙箱化需要 worker/子进程 + 能力白名单，属独立课题 |
| 10 | 不新增 IPC 通道 | 展开 IPC 就要按 CONTRACT.md 四处同步并更新契约文档；本次先把进程内内核建好 |
| 11 | `start` 事件用 `emitTo` 而不是广播 | 保持"每个插件只收到一次自己的 start"的旧语义（否则先启动的插件会重复收到） |
| 12 | `mainImpl.js` 继续做装配根 | 它已经是组合根；再造 `main/kernel/` 只会多一层转发，且 `main.ts` 是刻意保留的薄壳 |

---

## 9. 后续可选工作

1. **「移除插件」按钮要不要真正卸载运行中的插件？** 要的话需要新增 `IPC_PLUGIN_UNREGISTER`
   通道（`contracts.ts` + preload + `ipc.ts` + `renderer.ts` 四处同步 + CONTRACT/文档），并把
   `assetRemove('plugin')` 与 `unregister()` 串起来。本方案只提供主进程内部 `unregister()`。
2. **是否接受 `PetPlugin` 增加两个可选字段**（`dependencies` / `teardown`）？向后兼容，但属于
   插件公共契约的增量，需要你在 CONTRACT.md 的"插件"一节确认措辞。
3. **渲染层是否接受新增 2 个脚本文件**（`kernel.js`、`plugins/emotion.js`）及其三处装配/测试改动？
   （这是本方案对"无打包器"约束的直接代价。）
4. **后续范围**：`gazeController`、`ttsMouth` 和 `voicelab` 当前保持独立全局脚本，不纳入插件系统。
5. **主进程事件表是否扩展**（如 `model:changed` / `chat:done`）供第三方插件使用？扩展要改
   `PluginEventMap` + CONTRACT + 文档，并评估对现有插件的兼容性。
6. **`__petDebug` 追加 `plugins()`** 是否可以（调试 API 的增量）？

> 后续扩展需同步更新实现、契约、装配清单和测试。
