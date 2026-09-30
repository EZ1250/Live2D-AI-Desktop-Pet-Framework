/**
 * src/plugin-system/types.ts
 *
 * 插件系统对外类型契约。
 * Types a third-party plugin author needs to write a PetPlugin.
 *
 * 只 import 类型：避免把 shared/contracts 的运行时代码拖入纯类型文件。
 */
import type { WindowInfo } from '../shared/contracts';

/**
 * 插件事件负载映射表（泛型友好：新增事件只需扩展此表，on/emit 自动获得类型）。
 * Map of every plugin event name to the payload its callbacks receive.
 *   - start:        插件随应用启动（payload 为 void）
 *   - tick:         主进程动画循环驱动，payload = 距上一帧的增量时间
 *   - windowChange: 活动窗口变化（null = 无活动窗口）
 *   - userInput:    用户在桌面端的输入文本
 */
export type PluginEventMap = {
  start: void;
  tick: number;
  windowChange: WindowInfo | null;
  userInput: string;
};

/**
 * 注入给每个插件的运行上下文。
 * A plugin receives its own private context instance in setup().
 */
export interface PluginContext {
  /**
   * 订阅插件事件。event 与 payload 类型由 PluginEventMap 推导；
   * 同一事件可注册多个回调，同实例同回调注册两次无副作用（Set 去重）。
   * Subscribe to a plugin event with type-safe payload narrowing.
   */
  on<K extends keyof PluginEventMap>(
    event: K,
    callback: (payload: PluginEventMap[K]) => void,
  ): void;
  /**
   * 插件发出动作请求（走主进程桥接转发为 IPC_ACTION='pet:action'，渲染进程消费）。
   * Request a pet action; routed to the main process via the registry bridge.
   */
  emit(action: 'speak' | 'motion' | 'expression', payload: any): void;
}

/**
 * 一个宠物插件：setup 在应用启动时被调用一次。
 * Contract every plugin module must export.
 */
export interface PetPlugin {
  /** 插件名（须与 PluginManifest.name 一致）。 */
  name: string;
  /** 插件版本号。 */
  version: string;
  /** 启动钩子：注册事件、做一次性初始化。可异步。 */
  setup(ctx: PluginContext): void | Promise<void>;
}
