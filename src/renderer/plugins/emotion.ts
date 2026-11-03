/**
 * plugins/emotion.ts —— 情绪策略插件（全局脚本，由 kernel.js 载入后注册）
 *
 * 为什么拆出来：情绪判定是策略，不该继续长在 renderer.ts 的 UI 主流程里；
 * 插件只决定情绪标签，"标签 → 模型表情"的映射与应用由内核 render 服务负责。
 */
(() => {
  'use strict';

  type Any = any;

  /** 与拆分前 renderer 里的阈值保持一致：低于它不切表情 */
  const THRESHOLD = 0.34;

  const plugin = {
    name: 'emotion',
    setup(ctx: Any): void {
      const rules = (globalThis as Any).PetEmotion;
      if (!rules || typeof rules.classify !== 'function') {
        console.warn('[emotion] 规则库 emotion.js 未加载：情绪表情功能停用，其余功能不受影响');
        return;
      }

      const applyText = (text: string): string | null => {
        const result = rules.classify(text);
        if (!result || !result.label || result.label === 'neutral') return null;
        if (typeof result.confidence === 'number' && result.confidence < THRESHOLD) return null;
        const render = ctx.service('render');
        return render && typeof render.applyEmotion === 'function' ? render.applyEmotion(result.label) : null;
      };

      ctx.on('chat:reply', (text: string) => {
        applyText(text);
      });
      // 外部追踪帧里的情绪（摄像头/语音等来源）：保留拆分前"直接按 label 切表情"的语义
      ctx.on('tracking:emotion', (frame: Any) => {
        if (!frame || typeof frame.label !== 'string' || !frame.label) return;
        if (typeof frame.confidence === 'number' && frame.confidence < THRESHOLD) return;
        ctx.emit('expression', { label: frame.label });
      });
      ctx.handle('emotion.applyText', applyText);
    },
  };

  const g: Any = typeof globalThis !== 'undefined' ? globalThis : null;
  if (g && g.PetKernel) g.PetKernel.register(plugin);
})();
