/**
 * emotion.ts —— 文本情感判定 + 表情映射（渲染层全局脚本，暴露 window.PetEmotion）
 *
 * 为什么放渲染层全局脚本：本工程没有打包器，渲染层不能 import 模块；
 * 这里刻意做成**纯函数 + 不碰 DOM**，这样既能在页面里直接用，也能在 Node 里被测试加载（见 test_emotion.js）。
 *
 * 定位：提供一条零依赖的“文本情感 → 表情”闭环；
 * 摄像头/语音情感后续作为 tracking source 推进来，最终都汇到同一个 label 上。
 */
(() => {
  'use strict';

  type Scores = Record<string, number>;
  interface EmotionResult {
    label: string;
    confidence: number;
    scores: Scores;
  }

  const LABELS: string[] = ['happy', 'sad', 'angry', 'surprised', 'anxious', 'neutral'];

  /** 关键词表（中英混合；命中即计分，越具体的词分越高） */
  const RULES: Array<{ label: string; weight: number; words: string[] }> = [
    { label: 'happy', weight: 1, words: ['开心', '高兴', '太好了', '哈哈', '嘿嘿', '喜欢', '谢谢', '谢谢啦', '棒', '赞', '好耶', '舒服', '满意', '愉快'] },
    { label: 'happy', weight: 1, words: ['happy', 'glad', 'great', 'thanks', 'thank you', 'love', 'nice', 'awesome', 'yay', 'wonderful'] },
    { label: 'sad', weight: 1, words: ['难过', '伤心', '失望', '不开心', '想哭', '委屈', '孤单', '低落'] },
    { label: 'sad', weight: 1, words: ['sad', 'unhappy', 'disappointed', 'lonely', 'depressed', 'cry'] },
    { label: 'angry', weight: 1, words: ['生气', '很气', '气死', '讨厌', '烦死', '火大', '愤怒', '滚'] },
    { label: 'angry', weight: 1, words: ['angry', 'annoyed', 'furious', 'hate', 'mad'] },
    { label: 'surprised', weight: 1, words: ['惊讶', '居然', '竟然', '没想到', '真的假的', '哇', '天啊', '诶'] },
    { label: 'surprised', weight: 1, words: ['surprised', 'shocked', 'wow', 'unbelievable', 'really?'] },
    { label: 'anxious', weight: 1, words: ['担心', '焦虑', '害怕', '紧张', '不安', '急死', '压力好大'] },
    { label: 'anxious', weight: 1, words: ['worried', 'anxious', 'nervous', 'afraid', 'scared', 'stressed'] },
  ];

  /** 否定/转折会把情绪翻面：出现这些词时，前面 6 个字内的正向词按负面算（简化处理） */
  const NEGATIONS = ['不', '没', '别', '无', 'not ', "n't", 'no '];

  /**
   * 判定一段文本的情绪。
   * @returns {{label: string, confidence: number, scores: Record<string, number>}}
   */
  function classify(text: unknown): EmotionResult {
    const raw = typeof text === 'string' ? text : '';
    const s = raw.toLowerCase();
    const scores: Scores = { happy: 0, sad: 0, angry: 0, surprised: 0, anxious: 0, neutral: 0 };
    if (!s.trim()) return { label: 'neutral', confidence: 0, scores };

    for (const rule of RULES) {
      for (const w of rule.words) {
        const needle = w.toLowerCase();
        let from = 0;
        for (;;) {
          const at = s.indexOf(needle, from);
          if (at < 0) break;
          // 前面 6 个字符里有否定词 → 正向情绪翻成中性（"不开心"已经在词表里，这里兜底其它组合）
          const before = s.slice(Math.max(0, at - 6), at);
          const negated = NEGATIONS.some((n) => before.includes(n));
          scores[rule.label] += negated ? 0 : rule.weight;
          from = at + needle.length;
        }
      }
    }

    let best = 'neutral';
    let bestScore = 0;
    for (const label of LABELS) {
      if (scores[label] > bestScore) {
        bestScore = scores[label];
        best = label;
      }
    }
    // 置信度：命中越多越自信，但封顶 0.95（规则法不该显得过于确定）
    const confidence = bestScore === 0 ? 0 : Math.min(0.95, bestScore / (bestScore + 1));
    return { label: best, confidence, scores };
  }

  /** 每种情绪对应的表情名匹配规则（模型的表情命名五花八门，用模糊匹配 + 找不到就返回 null 不报错） */
  const EXPRESSION_PATTERNS: Record<string, RegExp> = {
    happy: /smile|happy|joy|fun|good|笑|开心|喜|乐/i,
    sad: /sad|cry|tear|down|难|悲|哭|失落/i,
    angry: /angry|anger|mad|rage|怒|生气|火/i,
    surprised: /surpris|shock|wonder|惊|讶|呆/i,
    anxious: /fear|worr|anxious|nervous|紧张|害|慌/i,
    neutral: /neutral|default|normal|idle|平静|默认|普通/i,
  };

  /**
   * 在模型可用表情里挑一个匹配该情绪的。
   * @param {string} label 情绪标签
   * @param {string[]} available 模型的表情名列表（handle.listExpressions()）
   * @returns {string|null} 匹配到的表情名；模型没有对应表情时返回 null（调用方保持当前表情即可）
   */
  function expressionFor(label: string, available: unknown): string | null {
    const list: string[] = Array.isArray(available)
      ? (available as unknown[]).filter((x): x is string => typeof x === 'string' && !!x)
      : [];
    if (!list.length) return null;
    const key = Object.prototype.hasOwnProperty.call(EXPRESSION_PATTERNS, label) ? label : 'neutral';
    const pattern = EXPRESSION_PATTERNS[key];
    return list.find((name) => pattern.test(name)) || null;
  }

  const api = { LABELS, classify, expressionFor, EXPRESSION_PATTERNS };

  // 挂到 globalThis：浏览器里就是 window.PetEmotion；Node（无 window）里测试也能 require 后从 globalThis 取到。
  // 刻意不用 module.exports —— 渲染层必须是全局脚本，装配脚本会拒绝任何 CommonJS 垫片。
  const g: any = typeof globalThis !== 'undefined' ? (globalThis as any) : null;
  if (g) g.PetEmotion = api;
})();
