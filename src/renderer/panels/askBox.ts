/**
 * panels/askBox.ts —— AI 提问框（全局脚本，挂 window.PetAskBox）
 *
 * ask_user 工具的问题/确认弹窗：只做 DOM 与交互，思考浮窗的状态联动经注入回调完成，
 * 这样它不需要知道 renderer 内部有哪些状态。
 */
(() => {
  'use strict';

  type Any = any;

  type AskQuestionPayload = {
    id: string;
    question: string;
    options: Array<{ label: string; description?: string }>;
  };

  interface AskBoxDeps {
    byId<T extends HTMLElement = HTMLElement>(id: string): T | null;
    bridge: Any;
    hideContextMenu(): void;
    installDragScroll(el: HTMLElement | null): void;
    setThinkWaiting(on: boolean): void;
    pushThinkLine(evt: { kind: 'tool'; text: string }): void;
    expandThinkPanel(): void;
    isChatPanel: boolean;
    isThinkPanel: boolean;
    setChatCollapsed(collapsed: boolean): void;
    isChatCollapsed(): boolean;
  }

  let deps: AskBoxDeps | null = null;

  function hide(): void {
    const d = deps;
    if (!d) return;
    const box = d.byId<HTMLElement>('ask-box');
    if (!box) return;
    box.hidden = true;
    box.setAttribute('aria-hidden', 'true');
    delete box.dataset.questionId;
    d.setThinkWaiting(false); // 用户已作答 → 结束「暂停」状态，思考浮窗恢复
  }

  function show(payload: AskQuestionPayload): void {
    const d = deps;
    if (!d) return;
    const box = d.byId<HTMLElement>('ask-box');
    const questionEl = d.byId<HTMLElement>('ask-question');
    const optionsEl = d.byId<HTMLElement>('ask-options');
    const input = d.byId<HTMLInputElement>('ask-input');
    if (!box || !questionEl || !optionsEl || !input) return;
    // 折叠态看不到提问框 → 先展开
    if (d.isChatPanel && d.isChatCollapsed()) d.setChatCollapsed(false);
    // 思考浮窗里提问 = "思考到一半停下来问你"：面板必须展开着，否则问题被折叠藏住
    if (d.isThinkPanel) d.expandThinkPanel();
    d.hideContextMenu();
    const chatBar = d.byId<HTMLElement>('chatbar');
    if (chatBar) chatBar.classList.remove('is-open'); // 只收输入条，保留思考浮窗
    box.dataset.questionId = payload.id;
    questionEl.textContent = payload.question;
    optionsEl.replaceChildren();
    for (const opt of payload.options.slice(0, 4)) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'ask-option-btn';
      const label = document.createElement('span');
      label.className = 'ask-option-label';
      label.textContent = opt.label;
      btn.appendChild(label);
      if (opt.description) {
        const desc = document.createElement('span');
        desc.className = 'ask-option-desc';
        desc.textContent = opt.description;
        btn.appendChild(desc);
      }
      btn.addEventListener('click', () => {
        void d.bridge.askAnswer({ id: payload.id, selected: [opt.label] }).catch(() => undefined);
        hide();
      });
      optionsEl.appendChild(btn);
    }
    input.value = '';
    box.hidden = false;
    box.setAttribute('aria-hidden', 'false');
    // 弹窗即"暂停"：思考浮窗切成等待态，并在记录里留一行，避免看起来还在自顾自思考
    d.setThinkWaiting(true);
    d.pushThinkLine({ kind: 'tool', text: `⏸ 暂停，等待你确认：${String(payload.question ?? '').split('\n')[0]}` });
    window.setTimeout(() => {
      try {
        input.focus();
      } catch {
        /* ignore */
      }
    }, 60);
  }

  function install(next: AskBoxDeps): void {
    deps = next;
    const d = next;
    d.installDragScroll(d.byId<HTMLElement>('ask-question'));
    d.bridge.onAskQuestion?.((payload: AskQuestionPayload) => {
      show(payload);
      return hide;
    });
    // 提问超时/失效：主进程会推 cancel，这里收起弹窗并结束等待态（否则弹窗会一直留在屏幕上）
    d.bridge.onAskCancel?.(() => hide());
    const input = d.byId<HTMLInputElement>('ask-input');
    input?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        const box = d.byId<HTMLElement>('ask-box');
        const id = box?.dataset.questionId;
        const text = input.value.trim();
        if (id && text) {
          void d.bridge.askAnswer({ id, text }).catch(() => undefined);
          hide();
        }
      }
    });
  }

  const g: Any = typeof globalThis !== 'undefined' ? globalThis : null;
  if (g) g.PetAskBox = { install };
})();
