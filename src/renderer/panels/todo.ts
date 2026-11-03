/**
 * panels/todo.ts —— 待办笔记本面板（全局脚本，挂 window.PetTodoPanel）
 *
 * 数据仍经 bridge 走 IPC 到主进程 ToolBox；这里只做 DOM 与交互。
 * 依赖由 install(deps) 注入，避免反向引用 renderer 内部实现。
 */
(() => {
  'use strict';

  type Any = any;
  type TodoDto = import('../../shared/contracts').TodoDto;

  interface TodoPanelDeps {
    byId<T extends HTMLElement = HTMLElement>(id: string): T | null;
    bridge: Any;
    hideContextMenu(): void;
  }

  let deps: TodoPanelDeps | null = null;

  function renderTodoList(): void {
    const d = deps;
    if (!d) return;
    const listEl = d.byId<HTMLElement>('todo-list');
    const emptyEl = d.byId<HTMLElement>('todo-empty');
    if (!listEl || !emptyEl) return;
    d.bridge
      .todoList()
      .then((todos: TodoDto[]) => {
        if (!todos.length) {
          listEl.replaceChildren();
          emptyEl.hidden = false;
          return;
        }
        emptyEl.hidden = true;
        listEl.replaceChildren();
        for (const todo of todos) {
          const li = document.createElement('div');
          li.className = 'todo-item';
          li.setAttribute('data-id', String(todo.id));
          const cb = document.createElement('input');
          cb.type = 'checkbox';
          cb.className = 'todo-item-checkbox';
          cb.checked = todo.done;
          const text = document.createElement('span');
          text.className = `todo-item-text${todo.done ? ' done' : ''}`;
          text.textContent = todo.text;
          const del = document.createElement('button');
          del.type = 'button';
          del.className = 'todo-item-delete';
          del.textContent = '×';
          del.setAttribute('aria-label', '删除待办');
          li.append(cb, text, del);
          listEl.appendChild(li);
        }
      })
      .catch((err: unknown) => console.warn('[renderer] 读取待办失败', err));
  }

  function open(): void {
    const d = deps;
    if (!d) return;
    const panel = d.byId<HTMLElement>('todo-panel');
    const chatBar = d.byId<HTMLElement>('chatbar');
    d.hideContextMenu();
    if (chatBar) chatBar.classList.remove('is-open');
    if (!panel) return;
    panel.hidden = false;
    renderTodoList();
    try {
      d.byId<HTMLInputElement>('todo-input')?.focus();
    } catch {
      /* ignore */
    }
  }

  function close(): void {
    const panel = deps?.byId<HTMLElement>('todo-panel');
    if (panel) panel.hidden = true;
  }

  function install(next: TodoPanelDeps): void {
    deps = next;
    const d = next;
    d.byId<HTMLButtonElement>('todo-close')?.addEventListener('click', close);
    d.byId<HTMLButtonElement>('todo-close2')?.addEventListener('click', close); // 页脚「关闭」按钮

    const refreshAfter = (p: Promise<unknown>): void => {
      p.then(() => renderTodoList()).catch((err: unknown) => console.warn('[renderer] 待办操作失败', err));
    };

    const addFromInput = (): void => {
      const input = d.byId<HTMLInputElement>('todo-input');
      const text = input?.value.trim();
      if (!text) return;
      if (input) input.value = '';
      refreshAfter(d.bridge.todoAdd(text));
    };
    d.byId<HTMLButtonElement>('todo-add')?.addEventListener('click', addFromInput);
    d.byId<HTMLInputElement>('todo-input')?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        addFromInput();
      }
    });

    // 列表事件委托：勾选 / 删除
    d.byId<HTMLElement>('todo-list')?.addEventListener('click', (e) => {
      const item = (e.target as HTMLElement).closest?.('.todo-item') as HTMLElement | null;
      const btn = (e.target as HTMLElement).closest?.('button') as HTMLElement | null;
      if (!item) return;
      const id = Number(item.getAttribute('data-id'));
      if (!Number.isFinite(id)) return;
      if (btn) {
        refreshAfter(d.bridge.todoDel(id));
      } else if ((e.target as HTMLInputElement).type === 'checkbox') {
        refreshAfter(d.bridge.todoToggle(id));
      }
    });

    // 聊天说「打开待办/笔记本」→ 主进程 push IPC_TODO_SHOW
    d.bridge.onTodoShow?.(() => open());
  }

  const g: Any = typeof globalThis !== 'undefined' ? globalThis : null;
  if (g) g.PetTodoPanel = { install, close };
})();
