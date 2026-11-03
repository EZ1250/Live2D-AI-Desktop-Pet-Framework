/**
 * fx.ts —— 点击星星特效（全局脚本，挂 window.PetFx）
 *
 * 为什么拆出来：纯 DOM 动画、零业务依赖；调用方只给坐标，不关心实现细节。
 */
(() => {
  'use strict';

  type Any = any;

  let lastSparkleAt = 0;
  const COOLDOWN_MS = 120; // 连点时不至于糊成一片
  const GLYPHS = ['★', '✦', '✧', '✩'];
  const PALETTE = ['#ffd6ea', '#ff9fd0', '#ff7fc0', '#9ecbff'];

  function ensureLayer(): HTMLElement {
    let layer = document.getElementById('fx-layer');
    if (!layer) {
      layer = document.createElement('div');
      layer.id = 'fx-layer';
      layer.className = 'fx-layer';
      layer.setAttribute('aria-hidden', 'true');
      document.body.appendChild(layer);
    }
    return layer;
  }

  /** 在 (x,y) 生成一小簇粉色星星（外加一圈极淡光晕），动画结束自动清理 */
  function spawnSparkles(x: number, y: number): void {
    const now = Date.now();
    if (now - lastSparkleAt < COOLDOWN_MS) return;
    lastSparkleAt = now;
    const layer = ensureLayer();
    if (layer.childElementCount > 80) return; // 极端情况防堆积

    // 光晕：极淡、快速淡出，仅增加设计感
    const halo = document.createElement('div');
    halo.className = 'sparkle-halo';
    halo.style.left = `${x}px`;
    halo.style.top = `${y}px`;
    layer.appendChild(halo);
    window.setTimeout(() => halo.remove(), 360);

    const count = 8 + Math.floor(Math.random() * 7); // 8~14 颗
    for (let i = 0; i < count; i++) {
      const angle = Math.random() * Math.PI * 2;
      const distance = 22 + Math.random() * 42; // 22~64px（整体 ≤70px，小范围不挡视野）
      const size = 7 + Math.random() * 7; // 7~14px
      const duration = 520 + Math.random() * 320;
      const delay = Math.random() * 90;
      const color = PALETTE[Math.floor(Math.random() * PALETTE.length)];

      const star = document.createElement('span');
      star.className = 'sparkle';
      star.textContent = GLYPHS[Math.floor(Math.random() * GLYPHS.length)];
      star.style.left = `${x}px`;
      star.style.top = `${y}px`;
      star.style.setProperty('--dx', `${Math.cos(angle) * distance}px`);
      star.style.setProperty('--dy', `${Math.sin(angle) * distance}px`);
      star.style.setProperty('--size', `${size}px`);
      star.style.setProperty('--color', color);
      star.style.setProperty('--rot', `${(Math.random() * 50 - 25).toFixed(1)}deg`);
      star.style.setProperty('--dur', `${duration}ms`);
      star.style.setProperty('--delay', `${delay}ms`);
      layer.appendChild(star);
      star.addEventListener('animationend', () => star.remove());
      window.setTimeout(() => star.remove(), duration + delay + 60);
    }
  }

  const g: Any = typeof globalThis !== 'undefined' ? globalThis : null;
  if (g) g.PetFx = { spawnSparkles };
})();
