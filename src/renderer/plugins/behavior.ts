/**
 * plugins/behavior.ts —— 行为触发策略插件（行为 → 动作组 / 表情）
 *
 * 为什么拆出来：候选解析、按行为去抖、绑定失效告警都是策略；设置 UI 与模型能力留在渲染层，
 * 这里只通过内核事件（behavior / behavior:config）和两个服务（model / render）交互。
 */
(() => {
  'use strict';

  type Any = any;

  /** auto 模式的候选顺序：'motion:x' / 'expr:x' / 'emotion:标签' / 'click' / 'costume' */
  const AUTO: Record<string, string[]> = {
    user_message: ['click', 'motion:Tap', 'motion:TapBody', 'motion:wave'],
    tool_call: ['motion:Idle', 'motion:Tap', 'costume'],
    command_exec: ['motion:Idle', 'motion:Tap'],
    ai_start: ['motion:Idle'],
    model_idle: ['motion:Idle'],
    error: ['emotion:surprised', 'emotion:angry', 'emotion:sad', 'motion:Shake'],
  };
  /** 同一行为的两次触发最小间隔 */
  const DEBOUNCE_MS: Record<string, number> = {
    user_message: 500,
    tool_call: 300,
    command_exec: 300,
    ai_start: 0,
    model_idle: 8000,
    error: 1000,
  };

  const plugin = {
    name: 'behavior',
    setup(ctx: Any): void {
      const model = () => ctx.service('model');
      const render = () => ctx.service('render');

      let byModel: Record<string, Record<string, string>> = {};
      let legacy: Record<string, string> = {};
      let modelName = '';
      let labels: Record<string, string> = {};
      let keys: string[] = [];
      let triggers: Record<string, string> = {};
      const lastAt: Record<string, number> = {};
      const warned = new Set<string>();

      const motions = (): string[] => model().motions();
      const expressions = (): string[] => model().expressions();

      /** 能力别名 → 该模型真实拥有的动作组或表情名 */
      const aliasTarget = (alias: 'click' | 'costume'): Any => {
        const cap = model().capabilities();
        if (!cap) return null;
        const name = (alias === 'click' ? cap.click?.[0] ?? cap.costume?.[0] : cap.costume?.[0]) ?? '';
        if (!name) return null;
        if (motions().includes(name)) return { kind: 'motion', name };
        if (expressions().includes(name)) return { kind: 'expression', name };
        return null;
      };

      /** 解析一个候选；目标不存在返回 null */
      const resolveCandidate = (candidate: string): Any => {
        if (candidate === 'click' || candidate === 'costume') return aliasTarget(candidate);
        if (candidate.startsWith('motion:')) {
          const name = candidate.slice(7);
          return name && motions().includes(name) ? { kind: 'motion', name } : null;
        }
        if (candidate.startsWith('expr:')) {
          const name = candidate.slice(5);
          return name && expressions().includes(name) ? { kind: 'expression', name } : null;
        }
        if (candidate.startsWith('emotion:')) {
          const label = candidate.slice(8);
          const map = model().emotionMap();
          const cap = model().capabilities();
          const name = map?.[label] ?? cap?.emotion?.[label] ?? '';
          return name && expressions().includes(name) ? { kind: 'expression', name } : null;
        }
        return null;
      };

      /**
       * 当前模型的生效映射：优先按模型分桶；没有桶时才退回旧版全局映射，
       * 且**只在它的目标确实存在于当前模型上**时沿用（否则换个模型会整块失效）。
       */
      const computeTriggers = (): Record<string, string> => {
        const perModel = modelName ? byModel[modelName] : undefined;
        if (perModel) return perModel;
        if (!Object.keys(legacy).length) return {};
        const usable = Object.values(legacy).some((value) => resolveCandidate(String(value ?? '')) !== null);
        return usable ? legacy : {};
      };

      /** 解析某行为的触发目标；命中不了返回 null */
      const resolveTarget = (behavior: string): Any => {
        const raw = (triggers[behavior] ?? 'auto').trim();
        if (!raw) return null;
        const candidates = raw === 'auto' ? AUTO[behavior] ?? [] : [raw];
        for (const candidate of candidates) {
          const target = resolveCandidate(candidate);
          if (target) return target;
        }
        return null;
      };

      /** 触发一次行为：去抖 → 解析目标 → 没有就不播放 */
      const fire = (behavior: string): boolean => {
        if (!render().ready()) return false;
        const now = Date.now();
        if (now - (lastAt[behavior] ?? 0) < (DEBOUNCE_MS[behavior] ?? 0)) return false;
        lastAt[behavior] = now;
        const target = resolveTarget(behavior);
        if (!target) {
          // 明确配了目标却解析不出来（换了模型 / 名字写错）：提醒一次，否则就是"配了完全没反应"
          const raw = (triggers[behavior] ?? 'auto').trim();
          if (raw && raw !== 'auto' && !warned.has(behavior)) {
            warned.add(behavior);
            console.warn(
              `[renderer] 行为触发「${labels[behavior] ?? behavior}」配的目标 ${raw} 在当前模型上不存在（` +
                `动作组：${motions().join('/') || '无'}；表情：${expressions().join('/') || '无'}），已跳过`,
            );
          }
          return false;
        }
        if (target.kind === 'motion') render().playMotion(target.name);
        else render().holdExpression(target.name);
        return true;
      };

      const state = (): Any => ({
        triggers: computeTriggers(),
        motions: motions(),
        expressions: expressions(),
        debounceMs: { ...DEBOUNCE_MS },
        resolved: Object.fromEntries(keys.map((key) => [key, resolveTarget(key)])),
      });

      ctx.on('behavior', (behavior: string) => fire(behavior));
      ctx.on('behavior:config', (config: Any) => {
        byModel = config?.byModel ?? {};
        legacy = config?.legacy ?? {};
        modelName = config?.modelName ?? '';
        labels = config?.labels ?? {};
        keys = Array.isArray(config?.keys) ? config.keys : [];
        triggers = computeTriggers();
        warned.clear();
      });
      ctx.handle('behavior.triggers', () => computeTriggers());
      ctx.handle('behavior.state', () => state());
      ctx.handle('behavior.resolve', (candidate: string) => resolveCandidate(String(candidate ?? '')));
      ctx.handle('behavior.fire', (behavior: string) => {
        if (!keys.includes(behavior)) return { ok: false, error: `未知行为：${behavior}` };
        lastAt[behavior] = 0;
        fire(behavior);
        return { ok: true, state: { triggers: computeTriggers(), resolved: resolveTarget(behavior) } };
      });
    },
  };

  const g: Any = typeof globalThis !== 'undefined' ? globalThis : null;
  if (g && g.PetKernel) g.PetKernel.register(plugin);
})();
