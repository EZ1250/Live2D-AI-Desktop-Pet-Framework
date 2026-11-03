/** 主进程插件注册表与生命周期管理器。 */
import type { PluginManifest, WindowInfo } from '../shared/contracts';
import { EventBus } from './eventBus';
import type { PetPlugin, PluginContext, PluginEventMap } from './types';

export type ActionBridge = (
  action: 'speak' | 'motion' | 'expression',
  payload: any,
) => void;

type PluginState = 'registered' | 'starting' | 'started' | 'failed';

class PluginContextImpl implements PluginContext {
  constructor(
    private readonly owner: string,
    private readonly bus: EventBus<PluginEventMap>,
    private readonly actionBridge: ActionBridge,
  ) {}

  on<K extends keyof PluginEventMap>(
    event: K,
    callback: (payload: PluginEventMap[K]) => void,
  ): void {
    this.bus.on(event, callback, this.owner);
  }

  emit(action: 'speak' | 'motion' | 'expression', payload: any): void {
    this.actionBridge(action, payload);
  }

  dispose(): void {
    this.bus.offOwner(this.owner);
  }
}

interface RegisteredPlugin {
  manifest: PluginManifest;
  factory: () => PetPlugin;
  plugin: PetPlugin | null;
  context: PluginContextImpl | null;
  state: PluginState;
}

export class PluginRegistry {
  private readonly plugins = new Map<string, RegisteredPlugin>();
  private readonly bus = new EventBus<PluginEventMap>();
  private started = false;
  private actionBridge: ActionBridge = () => undefined;

  setActionBridge(bridge: ActionBridge): void {
    this.actionBridge = bridge;
  }

  register(manifest: PluginManifest, factory: () => PetPlugin): void {
    const name = manifest.name.trim();
    if (!name) throw new Error('PluginManifest.name is required');
    if (this.plugins.has(name)) throw new Error(`Plugin "${name}" is already registered`);

    const entry: RegisteredPlugin = {
      manifest: { ...manifest, name },
      factory,
      plugin: null,
      context: null,
      state: 'registered',
    };
    this.plugins.set(name, entry);
    if (this.started) {
      void this.startPlugin(name, new Set()).catch((error) => {
        console.error(`[plugin] "${name}" failed to start:`, error);
      });
    }
  }

  async start(): Promise<void> {
    this.started = true;
    for (const name of this.plugins.keys()) {
      await this.startPlugin(name, new Set());
    }
  }

  async unregister(name: string): Promise<boolean> {
    const entry = this.plugins.get(name);
    if (!entry) return false;

    const dependents = [...this.plugins.entries()].filter(([, candidate]) =>
      candidate.plugin?.dependencies?.includes(name) &&
      candidate.state !== 'failed',
    );
    if (dependents.length) {
      throw new Error(`Plugin "${name}" is required by: ${dependents.map(([key]) => key).join(', ')}`);
    }

    entry.context?.dispose();
    try {
      await entry.plugin?.teardown?.();
    } finally {
      this.plugins.delete(name);
    }
    return true;
  }

  tick(deltaTime: number): void {
    this.bus.emit('tick', deltaTime);
  }

  windowChange(info: WindowInfo | null): void {
    this.bus.emit('windowChange', info);
  }

  userInput(text: string): void {
    this.bus.emit('userInput', text);
  }

  list(): PluginManifest[] {
    return [...this.plugins.values()].map((entry) => entry.manifest);
  }

  private async startPlugin(name: string, starting: Set<string>): Promise<void> {
    const entry = this.plugins.get(name);
    if (!entry || entry.state === 'started') return;
    if (starting.has(name)) {
      entry.state = 'failed';
      console.error(`[plugin] dependency cycle detected at "${name}"`);
      return;
    }

    try {
      const plugin = entry.plugin ?? entry.factory();
      entry.plugin = plugin;
      const dependencies = plugin.dependencies ?? [];
      starting.add(name);
      for (const dependency of dependencies) {
        if (!this.plugins.has(dependency)) {
          starting.delete(name);
          entry.state = 'failed';
          console.error(`[plugin] "${name}" depends on missing plugin "${dependency}"`);
          return;
        }
        await this.startPlugin(dependency, starting);
        const dependencyEntry = this.plugins.get(dependency);
        if (!dependencyEntry || dependencyEntry.state !== 'started') {
          starting.delete(name);
          entry.state = 'failed';
          console.error(`[plugin] "${name}" dependency "${dependency}" did not start`);
          return;
        }
      }
      starting.delete(name);

      entry.state = 'starting';
      const context = new PluginContextImpl(name, this.bus, this.actionBridge);
      entry.context = context;
      await plugin.setup(context);
      entry.state = 'started';
      this.bus.emitTo(name, 'start', undefined);
    } catch (error) {
      entry.state = 'failed';
      entry.context?.dispose();
      entry.context = null;
      console.error(`[plugin] "${name}" failed to start:`, error);
    }
  }
}

const registry = new PluginRegistry();
export default registry;
