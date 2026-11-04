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
    click: ['click', 'motion:Tap', 'motion:TapBody'],
    multiClick: ['motion:wave', 'motion:Tap', 'click'],
    drag: ['motion:Idle', 'costume', 'motion:Tap'],
    mcp: ['motion:Idle', 'motion:Tap', 'costume'],
  };
  /** 同一行为的两次触发最小间隔 */
  const DEBOUNCE_MS: Record<string, number> = {
    user_message: 500,
    tool_call: 300,
    command_exec: 300,
    ai_start: 0,
    model_idle: 8000,
    error: 1000,
    click: 250,
    multiClick: 800,
    drag: 600,
    mcp: 300,
  };

  const plugin = {
    name: 'behavior',
    setup(ctx: Any): void {
      const model = () => ctx.service('model');
      const render = () => ctx.service('render');

      let byModel: Record<string, Record<string, string>> = {};
      let legacy: Record<string, string> = {};
      /** 行为 → 附加播放的目标（动作组或表情，编码 motion:/expr:；当前模型生效的那一份） */
      let pairedTargets: Record<string, string> = {};
      /** 行为 → 附加目标的播放方式：simultaneous（同时，默认）/ chain（衔接） */
      let pairModes: Record<string, string> = {};
      /** 衔接模式下的延时回调：换模型/重载配置时清掉，避免旧模型的目标打断新模型 */
      const chainTimers: Any[] = [];
      let modelName = '';
      let labels: Record<string, string> = {};
      let keys: string[] = [];
      let triggers: Record<string, string> = {};
      const lastAt: Record<string, number> = {};
      const warned = new Set<string>();
      /** 衔接等待时长：表情等它的保持时长前一点，动作按常见动作时长估 */
      const PAIR_CHAIN_EXPRESSION_MS = 2400;
      const PAIR_CHAIN_MOTION_MS = 1600;
      /** 测试/调试可用 config.chainDelayMs 覆盖衔接延时 */
      let chainDelayOverride = 0;

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

      /** 解析附加目标：动作/表情都允许；旧配置只存表情名（无前缀）时按表情兼容 */
      const resolvePairTarget = (behavior: string): Any => {
        const raw = typeof pairedTargets[behavior] === 'string' ? pairedTargets[behavior].trim() : '';
        if (!raw) return null;
        const direct = resolveCandidate(raw);
        if (direct) return direct;
        if (!raw.startsWith('motion:') && !raw.startsWith('expr:') && !raw.startsWith('emotion:')) {
          return resolveCandidate(`expr:${raw}`) ?? resolveCandidate(`motion:${raw}`);
        }
        return null;
      };

      /** 应用一个已解析目标（动作 → playMotion；表情 → holdExpression） */
      const applyAction = (target: Any): void => {
        if (target.kind === 'motion') render().playMotion(target.name);
        else render().holdExpression(target.name);
      };

      /** 触发一次行为：去抖 → 解析主目标 + 附加目标 → 按"同时/衔接"应用 */
      const fire = (behavior: string): boolean => {
        if (!render().ready()) return false;
        const now = Date.now();
        if (now - (lastAt[behavior] ?? 0) < (DEBOUNCE_MS[behavior] ?? 0)) return false;
        lastAt[behavior] = now;
        const target = resolveTarget(behavior);
        const pair = resolvePairTarget(behavior);
        if (!target && !pair) {
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
        // 主目标
        if (target) applyAction(target);
        // 附加目标：同时=立即一起应用；衔接=主目标之后再应用
        const sameTarget = Boolean(target && pair && target.kind === pair.kind && target.name === pair.name);
        if (pair && !sameTarget) {
          const mode = pairModes[behavior] === 'chain' ? 'chain' : 'simultaneous';
          if (mode === 'chain') {
            const delay = chainDelayOverride > 0
              ? chainDelayOverride
              : target
                ? (target.kind === 'expression' ? PAIR_CHAIN_EXPRESSION_MS : PAIR_CHAIN_MOTION_MS)
                : 0;
            if (delay <= 0) {
              applyAction(pair);
            } else {
              const timer = setTimeout(() => {
                if (render().ready()) {
                  try {
                    applyAction(pair);
                  } catch (err) {
                    console.warn('[renderer] 衔接目标播放失败：', err);
                  }
                }
              }, delay);
              chainTimers.push(timer);
            }
          } else {
            applyAction(pair);
          }
        }
        return true;
      };

      const state = (): Any => ({
        triggers: computeTriggers(),
        pairedTargets: { ...pairedTargets },
        pairModes: { ...pairModes },
        motions: motions(),
        expressions: expressions(),
        debounceMs: { ...DEBOUNCE_MS },
        resolved: Object.fromEntries(keys.map((key) => [key, resolveTarget(key)])),
      });

      ctx.on('behavior', (behavior: string) => fire(behavior));
      ctx.on('behavior:config', (config: Any) => {
        byModel = config?.byModel ?? {};
        legacy = config?.legacy ?? {};
        pairedTargets = config?.expressions ?? {};
        pairModes = config?.pairModes ?? {};
        chainDelayOverride = Number.isFinite(config?.chainDelayMs) ? Number(config.chainDelayMs) : 0;
        modelName = config?.modelName ?? '';
        labels = config?.labels ?? {};
        keys = Array.isArray(config?.keys) ? config.keys : [];
        // 换模型/重载配置：清掉尚未执行的"衔接"回调
        while (chainTimers.length) {
          try {
            clearTimeout(chainTimers.pop());
          } catch {
            /* ignore */
          }
        }
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
