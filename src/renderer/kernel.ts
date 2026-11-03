/**
 * kernel.ts —— 渲染层微内核（全局脚本，挂 window.PetKernel）
 *
 * 为什么需要：渲染层没有模块系统，策略类逻辑继续堆进 renderer.ts 会互相纠缠；
 * 这里提供「内核广播事件 → 插件订阅 → 插件经服务/动作桥回核心」的单向依赖。
 *
 * 与主进程 src/plugin-system 的分工：那边管第三方插件（Node 动态加载），这边只管
 * 渲染层内置策略；事件面不同，且渲染层不能 require，故各自维护一套总线。
 */
(() => {
  'use strict';

  type Any = any;
  type Listener = (payload: Any) => void;

  interface PluginEventMap {
    'chat:reply': string;
    'tracking:emotion': { label?: string; confidence?: number };
    behavior: string;
    'behavior:config': {
      byModel?: Record<string, Record<string, string>>;
      legacy?: Record<string, string>;
      modelName?: string;
      labels?: Record<string, string>;
      keys?: string[];
    };
  }

  interface PluginContext {
    on<K extends keyof PluginEventMap>(event: K, callback: (payload: PluginEventMap[K]) => void): void;
    emit(action: 'expression' | 'motion' | 'speak', payload: Any): void;
    service<T = Any>(name: string): T;
    handle(name: string, fn: (...args: Any[]) => Any): void;
  }

  interface RendererPlugin {
    name: string;
    dependencies?: readonly string[];
    setup(ctx: PluginContext): void | Promise<void>;
    teardown?(): void | Promise<void>;
  }

  type ActionBridge = (action: 'expression' | 'motion' | 'speak', payload: Any) => void;
  type PluginState = 'registered' | 'starting' | 'started' | 'failed';

  /** 按 owner 隔离：插件卸载时一次清掉它的监听，不残留回调 */
  class Bus {
    private readonly listeners = new Map<keyof PluginEventMap, Array<{ owner: string; callback: Listener }>>();

    on(event: keyof PluginEventMap, callback: Listener, owner: string): void {
      const list = this.listeners.get(event) ?? [];
      if (!list.some((entry) => entry.owner === owner && entry.callback === callback)) {
        list.push({ owner, callback });
      }
      this.listeners.set(event, list);
    }

    emit(event: keyof PluginEventMap, payload: Any): void {
      // 快照遍历：订阅者在回调里注册/卸载不影响本轮派发
      for (const entry of [...(this.listeners.get(event) ?? [])]) {
        try {
          entry.callback(payload);
        } catch (error) {
          console.error(`[kernel] 事件 "${String(event)}" 的订阅者抛错（已隔离）：`, error);
        }
      }
    }

    offOwner(owner: string): void {
      for (const [event, listeners] of this.listeners) {
        const remaining = listeners.filter((entry) => entry.owner !== owner);
        if (remaining.length) this.listeners.set(event, remaining);
        else this.listeners.delete(event);
      }
    }
  }

  class Kernel {
    private readonly plugins = new Map<string, { plugin: RendererPlugin; state: PluginState; context: PluginContext | null }>();
    private readonly bus = new Bus();
    private readonly services = new Map<string, Any>();
    private readonly handlers = new Map<string, { owner: string; fn: (...args: Any[]) => Any }>();
    private actionBridge: ActionBridge = () => undefined;
    private started = false;

    /** 注册核心服务（装配层调用）。同名只保留先注册者，后注册的忽略并告警，避免静默覆盖。 */
    provide(name: string, impl: Any): void {
      if (this.services.has(name)) {
        console.warn(`[kernel] 服务名冲突："${name}" 已注册，忽略本次注册`);
        return;
      }
      this.services.set(name, impl);
    }

    service<T = Any>(name: string): T {
      if (!this.services.has(name)) throw new Error(`[kernel] 未注册服务：${name}`);
      return this.services.get(name) as T;
    }

    setActionBridge(bridge: ActionBridge): void {
      this.actionBridge = bridge;
    }

    register(plugin: RendererPlugin): void {
      const name = plugin && typeof plugin.name === 'string' ? plugin.name.trim() : '';
      if (!name) throw new Error('[kernel] 插件 name 不能为空');
      if (this.plugins.has(name)) throw new Error(`[kernel] 插件 "${name}" 已注册`);
      this.plugins.set(name, { plugin, state: 'registered', context: null });
      // 启动后再注册的插件立刻补启动，语义与主进程 plugin-system 的 register 一致
      if (this.started) void this.startPlugin(name, new Set());
    }

    async start(): Promise<void> {
      this.started = true;
      for (const name of [...this.plugins.keys()]) {
        await this.startPlugin(name, new Set());
      }
    }

    async unregister(name: string): Promise<boolean> {
      const entry = this.plugins.get(name);
      if (!entry) return false;
      const dependents = [...this.plugins.entries()].filter(
        ([key, candidate]) =>
          key !== name &&
          (candidate.plugin.dependencies ?? []).includes(name) &&
          candidate.state !== 'failed',
      );
      if (dependents.length) {
        throw new Error(`[kernel] 插件 "${name}" 仍被依赖：${dependents.map(([key]) => key).join(', ')}`);
      }
      this.dispose(name);
      try {
        await entry.plugin.teardown?.();
      } finally {
        this.plugins.delete(name);
      }
      return true;
    }

    emit(event: keyof PluginEventMap, payload: Any): void {
      this.bus.emit(event, payload);
    }

    call(name: string, ...args: Any[]): unknown {
      const handler = this.handlers.get(name);
      if (!handler) return undefined;
      try {
        return handler.fn(...args);
      } catch (error) {
        console.error(`[kernel] 同步入口 "${name}" 抛错（已隔离）：`, error);
        return undefined;
      }
    }

    private createContext(owner: string): PluginContext {
      return {
        on: (event, callback) => this.bus.on(event, callback as Listener, owner),
        emit: (action, payload) => {
          try {
            this.actionBridge(action, payload);
          } catch (error) {
            console.error(`[kernel] 插件 "${owner}" 的动作 ${action} 被核心拒绝：`, error);
          }
        },
        service: (name) => this.service(name),
        handle: (name, fn) => {
          if (this.handlers.has(name)) throw new Error(`[kernel] 同步入口重复注册：${name}`);
          this.handlers.set(name, { owner, fn });
        },
      };
    }

    /** 卸载时的统一清理：监听 + 同步入口（teardown 由 unregister 负责调用） */
    private dispose(owner: string): void {
      this.bus.offOwner(owner);
      for (const [name, entry] of this.handlers) {
        if (entry.owner === owner) this.handlers.delete(name);
      }
      const entry = this.plugins.get(owner);
      if (entry) entry.context = null;
    }

    private async startPlugin(name: string, starting: Set<string>): Promise<void> {
      const entry = this.plugins.get(name);
      if (!entry || entry.state === 'started') return;
      if (starting.has(name)) {
        entry.state = 'failed';
        console.error(`[kernel] 插件依赖成环：${name}`);
        return;
      }

      try {
        starting.add(name);
        for (const dependency of entry.plugin.dependencies ?? []) {
          if (!this.plugins.has(dependency)) {
            entry.state = 'failed';
            console.error(`[kernel] 插件 "${name}" 依赖缺失：${dependency}`);
            return;
          }
          await this.startPlugin(dependency, starting);
          const dependencyEntry = this.plugins.get(dependency);
          if (!dependencyEntry || dependencyEntry.state !== 'started') {
            entry.state = 'failed';
            console.error(`[kernel] 插件 "${name}" 的依赖 "${dependency}" 未启动`);
            return;
          }
        }
        entry.state = 'starting';
        const context = this.createContext(name);
        entry.context = context;
        await entry.plugin.setup(context);
        entry.state = 'started';
      } catch (error) {
        entry.state = 'failed';
        this.dispose(name);
        console.error(`[kernel] 插件 "${name}" 启动失败（已隔离）：`, error);
      } finally {
        starting.delete(name);
      }
    }
  }

  const kernel = new Kernel();
  const g: Any = typeof globalThis !== 'undefined' ? globalThis : null;
  if (g) g.PetKernel = kernel;
  // 浏览器里 globalThis 就是 window；测试用假 window 时也要能取到
  if (typeof window !== 'undefined' && (window as Any)) (window as Any).PetKernel = kernel;
})();
