/**
 * 插件注册表：管理插件注册、生命周期和事件分发，并将插件动作转发到主进程。
 */
import type { PluginManifest, WindowInfo } from '../shared/contracts';
import type { PetPlugin, PluginContext, PluginEventMap } from './types';

/** 主进程动作桥接回调：插件 emit('speak'|'motion'|'expression', payload)。 */
export type ActionBridge = (
  action: 'speak' | 'motion' | 'expression',
  payload: any,
) => void;

/** 内部回调存储单元：payload 用 any 集合保存，派发时按事件泛型收窄。 */
type AnyListener = (payload: any) => void;

/** 每个插件的独立 PluginContext 实现（对外仅按 PluginContext 窄接口使用）。 */
class PluginContextImpl implements PluginContext {
  /** 事件表：event 名 → 回调集合。 */
  private readonly listeners = new Map<keyof PluginEventMap, Set<AnyListener>>();

  constructor(private readonly actionBridge: ActionBridge) {}

  /**
   * on: 注册事件回调。event 键与 payload 类型均由 PluginEventMap 推导；
   * 同一实例重复注册同一函数引用会被 Set 去重。
   */
  on<K extends keyof PluginEventMap>(
    event: K,
    callback: (payload: PluginEventMap[K]) => void,
  ): void {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set<AnyListener>();
      this.listeners.set(event, set);
    }
    // 收窄为内部 AnyListener 存储；派发时按对应事件类型回读。
    set.add(callback as AnyListener);
  }

  /**
   * emit: 插件请求动作。不落入本地事件表，而是直接经构造时注入的
   * actionBridge 传出，由 registry 转交主进程（→ IPC_ACTION）。
   */
  emit(action: 'speak' | 'motion' | 'expression', payload: any): void {
    this.actionBridge(action, payload);
  }

  /** 供 registry 内部派发事件：按 PluginEventMap 对 K 收窄回调载荷类型。 */
  private dispatch<K extends keyof PluginEventMap>(event: K, payload: PluginEventMap[K]): void {
    const set = this.listeners.get(event);
    if (!set) return;
    for (const listener of set) {
      // 单个订阅者抛错不能中断其余订阅者（一个坏插件不该让其它插件收不到事件）
      try {
        (listener as (p: PluginEventMap[K]) => void)(payload);
      } catch (err) {
        console.error(`[plugin] 事件 "${String(event)}" 的订阅者抛错（已隔离）：`, err);
      }
    }
  }

  /** tick: 被 registry.tick 调用，把增量时间派发给本插件的 'tick' 订阅者。 */
  tick(deltaTime: number): void {
    this.dispatch('tick', deltaTime);
  }

  /** startEvent: 被 registry.start 调用，通知本插件已启动。 */
  startEvent(): void {
    this.dispatch('start', undefined);
  }

  /** windowChange: 被 registry.windowChange 调用，把活动窗口信息派发给订阅者。 */
  windowChange(info: WindowInfo | null): void {
    this.dispatch('windowChange', info);
  }

  /** userInput: 被 registry.userInput 调用，把输入文本派发给订阅者。 */
  userInput(text: string): void {
    this.dispatch('userInput', text);
  }
}

/** 已注册插件的内部记录：manifest 元数据 + 延迟工厂 + 实例化后的上下文。 */
interface RegisteredPlugin {
  manifest: PluginManifest;
  factory: () => PetPlugin;
  context: PluginContextImpl | null;
}

/**
 * 插件注册表。主进程创建一个实例：
 *  - 收到 IPC_PLUGIN_REGISTER → register()，成功/失败映射为 {ok,error}；
 *  - 应用启动 → start()；动画循环 → tick()；
 *  - setActionBridge() 注入的回调把插件动作转发为 IPC_ACTION 至渲染进程。
 */
export class PluginRegistry {
  /** 已注册插件，以 name 为唯一键。 */
  private readonly plugins = new Map<string, RegisteredPlugin>();
  /** 应用已启动；启动后新增插件需要立即执行 setup。 */
  private started = false;
  /** 动作桥接（默认 no-op，主进程不注入时插件 emit 静默丢弃）。 */
  private actionBridge: ActionBridge = () => undefined;

  /**
   * 注入主进程动作桥接：插件 emit 的动作经此回调传出
   * （主进程转发为 IPC_ACTION='pet:action'，渲染进程消费）。
   */
  setActionBridge(bridge: ActionBridge): void {
    this.actionBridge = bridge;
  }

  /**
   * register: 登记插件。name 必填且全局唯一，重复注册抛错
   * （主进程 plugin:register 处理器应捕获并返回 {ok:false, error}）。
   * factory 延迟执行：真正的 PetPlugin 实例在 start() 时才创建。
   */
  register(manifest: PluginManifest, factory: () => PetPlugin): void {
    const name = manifest.name;
    if (!name || !name.trim()) {
      throw new Error('PluginManifest.name is required');
    }
    if (this.plugins.has(name)) {
      throw new Error(`Plugin "${name}" is already registered`);
    }
    const entry = { manifest, factory, context: null };
    this.plugins.set(name, entry);
    if (this.started) void this.startPlugin(name, entry);
  }

  private async startPlugin(name: string, entry: RegisteredPlugin): Promise<void> {
    if (entry.context) return;
    const context = new PluginContextImpl(this.actionBridge);
    entry.context = context;
    try {
      const plugin = entry.factory();
      await plugin.setup(context);
      context.startEvent();
    } catch (error) {
      entry.context = null;
      console.error(`[plugin] "${name}" failed to start:`, error);
    }
  }

  /**
   * start: 逐个启动已注册插件。每个插件获得一个【独立】PluginContextImpl
   * （注入同一 actionBridge），随后调用其 setup(ctx)，并在 setup 完成后
   * 派发 'start' 事件（插件可在 setup 里 on('start')）。
   * 单个插件 setup 失败只影响它自己：记录错误并继续启动其余插件。
   */
  async start(): Promise<void> {
    this.started = true;
    for (const [name, entry] of this.plugins) {
      await this.startPlugin(name, entry);
    }
  }

  /**
   * tick: 外部驱动（主进程 rAF/setInterval 每帧调用），把距上一帧的
   * deltaTime 派发给所有已启动插件的 'tick' 订阅者。start() 前调用为安全空转。
   */
  tick(deltaTime: number): void {
    for (const entry of this.plugins.values()) {
      entry.context?.tick(deltaTime);
    }
  }

  /** windowChange: 主进程 windowMonitor 变化时调用，转发给已启动插件。 */
  windowChange(info: WindowInfo | null): void {
    for (const entry of this.plugins.values()) {
      entry.context?.windowChange(info);
    }
  }

  /** userInput: 主进程收到用户输入时调用，转发给已启动插件。 */
  userInput(text: string): void {
    for (const entry of this.plugins.values()) {
      entry.context?.userInput(text);
    }
  }

  /** 已注册插件清单（仅 manifest），供主进程查询/调试。 */
  list(): PluginManifest[] {
    return [...this.plugins.values()].map((entry) => entry.manifest);
  }
}

/** 全局默认 registry 实例（主进程直接 import default 使用；需要多实例时可 new PluginRegistry）。 */
const registry = new PluginRegistry();
export default registry;
