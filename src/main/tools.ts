// src/main/tools.ts —— 聊天→本地工具（待办清单 / 提醒闹钟）
// 数据存 app.getPath('userData')/pet-tools.json（个人配置留在本机，不随项目迁移）。
// 未识别的意图返回 null，交给原 AI 聊天流程。
import * as fs from 'fs';
import * as path from 'path';
import { app } from 'electron';
import type { TodoDto } from '../shared/contracts';

export interface TodoItem {
  id: number;
  text: string;
  done: boolean;
  createdAt: number;
}

export interface Reminder {
  id: number;
  text: string;
  atMs: number;
  /** once=一次性；daily=每天重复 */
  recur: 'once' | 'daily';
  createdAt: number;
}

export interface NoteItem {
  id: number;
  text: string;
  createdAt: number;
}

export class ToolBox {
  private todos: TodoItem[] = [];
  private reminders: Reminder[] = [];
  private notes: NoteItem[] = [];
  /** 每个提醒只保留一个活动 timer，避免重复调度和取消遗漏。 */
  private timers = new Map<number, ReturnType<typeof setTimeout>>();
  private nextId = 1;
  private sendBubble: ((text: string) => void) | null = null;

  init(sendBubble: (text: string) => void): void {
    this.sendBubble = sendBubble;
    this.load();
    this.scheduleReminders();
  }

  /** 意图路由：命中返回回执文案；未命中返回 null（交给 AI） */
  route(text: string): string | null {
    const trimmed = text.trim();
    if (!trimmed) return null;

    // ---------- 待办：添加 ----------
    const addMatch = trimmed.match(
      /^(?:请|帮我)?(?:添加|新增|加一个|建一个|新建|记一条)\s*(?:待办|任务|事项|清单|提醒事项)?[:：,，、]?\s*(.+)$/,
    );
    if (addMatch && /(待办|任务|事项|清单)/.test(trimmed)) {
      const todoText = addMatch[1].trim();
      if (todoText) {
        this.todos.push({ id: this.nextId++, text: todoText, done: false, createdAt: Date.now() });
        this.save();
        return `好的，已添加待办：${todoText}`;
      }
    }

    // ---------- 待办：查看 ----------
    if (/(查看|显示|列出|看看|有.*什么).*(待办|任务|事项|清单)/i.test(trimmed) || /待办|任务列表|事项列表/.test(trimmed)) {
      const pending = this.todos.filter((t) => !t.done);
      if (pending.length === 0) return '当前没有未完成的待办。';
      return `待办清单（${pending.length}）：\n${pending.map((t, i) => `${i + 1}) ${t.text}`).join('\n')}`;
    }

    // ---------- 待办：完成 / 删除（按序号或全部） ----------
    const finishMatch = trimmed.match(/^(?:请|帮我)?(?:完成|搞定|划掉)\s*(?:待办|任务|事项|第)?\s*(\d+|全部)/i);
    if (finishMatch) {
      if (finishMatch[1] === '全部') {
        const count = this.todos.filter((t) => !t.done).length;
        this.todos.forEach((t) => (t.done = true));
        this.save();
        return count ? `已完成全部 ${count} 项待办。` : '没有需要完成的待办。';
      }
      const idx = Number(finishMatch[1]) - 1;
      const todo = this.todos[idx];
      if (todo && !todo.done) {
        todo.done = true;
        this.save();
        return `已完成：${todo.text}`;
      }
      return todo ? '该项已完成过了。' : '没有这个序号的待办。';
    }

    const delMatch = trimmed.match(/^(?:请|帮我)?(?:删除|删掉|移除)\s*(?:待办|任务|事项|第)?\s*(\d+|全部)/i);
    if (delMatch) {
      if (delMatch[1] === '全部') {
        const count = this.todos.length;
        this.todos = [];
        this.save();
        return count ? `已删除全部 ${count} 项待办。` : '待办本来就是空的。';
      }
      const idx = Number(delMatch[1]) - 1;
      const removed = this.todos[idx];
      if (removed) {
        this.todos.splice(idx, 1);
        this.save();
        return `已删除待办：${removed.text}`;
      }
      return '没有这个序号的待办。';
    }

    // ---------- 提醒/闹钟：相对时间（X分钟后提醒我 …） ----------
    const relMatch = trimmed.match(
      /^(?:请|帮我)?(?:设|定|来)?\s*(\d+)\s*(秒|分钟|小时)s?后\s*(?:提醒|闹钟|叫我|喊我|提醒我)?\s*(?:我|你)?\s*[:：,，]?\s*(.+)$/,
    );
    if (relMatch) {
      const amount = Number(relMatch[1]);
      const unit = relMatch[2];
      const msg = relMatch[3].trim();
      if (amount > 0 && msg && !/(待办|任务)/.test(msg)) {
        const ms = unit === '秒' ? amount * 1000 : unit === '小时' ? amount * 3600 * 1000 : amount * 60 * 1000;
        const rem: Reminder = { id: this.nextId++, text: msg, atMs: Date.now() + ms, recur: 'once', createdAt: Date.now() };
        this.reminders.push(rem);
        this.save();
        this.scheduleSingleReminder(rem);
        return `好的，${amount}${unit}后提醒你：${msg}`;
      }
    }

    // ---------- 提醒/闹钟：定点时间（今天/明天 12:30 提醒我 …） ----------
    const clockMatch = trimmed.match(
      /^(?:请|帮我)?(?:设|定|来)?\s*(今天|明天|明早|今晚)?\s*(\d{1,2})\s*[点时:：]\s*(\d{0,2})\s*(?:提醒|闹钟|叫我|喊我|提醒我)?\s*(?:我|你)?\s*[:：,，]?\s*(.+)$/,
    );
    if (clockMatch) {
      const dayWord = clockMatch[1] ?? '';
      const hour = Number(clockMatch[2]);
      const minute = clockMatch[3] ? Number(clockMatch[3]) : 0;
      const msg = clockMatch[4].trim();
      if (hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59 && msg && !/(待办|任务)/.test(msg)) {
        const now = new Date();
        const target = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hour, minute, 0, 0);
        if (dayWord === '明天' || dayWord === '明早' || (dayWord !== '今天' && target.getTime() <= now.getTime())) {
          target.setDate(target.getDate() + 1);
        }
        const rem: Reminder = { id: this.nextId++, text: msg, atMs: target.getTime(), recur: 'once', createdAt: Date.now() };
        this.reminders.push(rem);
        this.save();
        this.scheduleSingleReminder(rem);
        const fmt = `${target.getMonth() + 1}/${target.getDate()} ${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
        return `好的，${fmt} 提醒你：${msg}`;
      }
    }

    // ---------- 提醒：每天重复 ----------
    const dailyMatch = trimmed.match(
      /^(?:请|帮我)?(?:设|定)?\s*(?:每天|每日)\s*(\d{1,2})\s*[点时:：]\s*(\d{0,2})\s*(?:提醒|闹钟|叫我|提醒我)\s*(?:我|你)?\s*[:：,，]?\s*(.+)$/,
    );
    if (dailyMatch) {
      const hour = Number(dailyMatch[1]);
      const minute = dailyMatch[2] ? Number(dailyMatch[2]) : 0;
      const msg = dailyMatch[3].trim();
      if (hour <= 23 && minute <= 59 && msg) {
        const now = new Date();
        const target = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hour, minute, 0, 0);
        if (target.getTime() <= now.getTime()) target.setDate(target.getDate() + 1);
        const rem: Reminder = { id: this.nextId++, text: msg, atMs: target.getTime(), recur: 'daily', createdAt: Date.now() };
        this.reminders.push(rem);
        this.save();
        this.scheduleSingleReminder(rem);
        return `好的，每天 ${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')} 提醒你：${msg}`;
      }
    }

    // ---------- 提醒：查看 / 取消 ----------
    if (/(查看|显示|列出|有.*什么).*(提醒|闹钟)/i.test(trimmed) || /提醒列表|闹钟列表/.test(trimmed)) {
      if (this.reminders.length === 0) return '当前没有设置提醒/闹钟。';
      return `提醒列表：\n${this.reminders
        .map(
          (r, i) =>
            `${i + 1}) ${r.text}（${r.recur === 'daily' ? '每日 ' : ''}${new Date(r.atMs).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}）`,
        )
        .join('\n')}`;
    }

    const cancelMatch = trimmed.match(/^(?:请|帮我)?(?:取消|删除|关掉)\s*(?:第|序号)?\s*(\d+|全部)?\s*(?:个)?\s*(?:提醒|闹钟|提醒事项)/i);
    if (cancelMatch) {
      const which = cancelMatch[1] ?? '';
      if (which === '全部' || which === '') {
        // “取消全部提醒” 与 “取消提醒”（空=全部取消）
        const count = this.reminders.length;
        this.reminders = [];
        this.clearTimers();
        this.save();
        return count ? `已取消全部 ${count} 个提醒/闹钟。` : '没有可取消的提醒。';
      }
      const idx = Number(which) - 1;
      const removed = this.reminders[idx];
      if (removed) {
        this.reminders.splice(idx, 1);
        this.clearTimer(removed.id);
        this.save();
        return `已取消提醒：${removed.text}`;
      }
      return '没有这个序号的提醒。';
    }

    return null;
  }

  // ------------------------------------------------------------------ 待办笔记本 IPC 数据入口

  getTodos(): TodoDto[] {
    return this.todos.map((t) => ({ id: t.id, text: t.text, done: t.done })).sort((a, b) => a.id - b.id);
  }

  addTodoRaw(text: string): TodoDto[] {
    const todo = text.trim();
    if (!todo) return this.getTodos();
    this.todos.push({ id: this.nextId++, text: todo, done: false, createdAt: Date.now() });
    this.save();
    return this.getTodos();
  }

  toggleTodo(id: number): TodoDto[] {
    const todo = this.todos.find((t) => t.id === id);
    if (todo) {
      todo.done = !todo.done;
      this.save();
    }
    return this.getTodos();
  }

  delTodo(id: number): TodoDto[] {
    const idx = this.todos.findIndex((t) => t.id === id);
    if (idx !== -1) {
      this.todos.splice(idx, 1);
      this.save();
    }
    return this.getTodos();
  }

  /** 修改待办文字（保留完成状态）；id 不存在或文字为空返回 null */
  updateTodoText(id: number, text: string): TodoDto[] | null {
    const todo = this.todos.find((t) => t.id === id);
    const next = text.trim();
    if (!todo || !next) return null;
    todo.text = next;
    this.save();
    return this.getTodos();
  }

  /** 清除已完成待办，返回清除条数 */
  clearDoneTodos(): number {
    const before = this.todos.length;
    this.todos = this.todos.filter((t) => !t.done);
    const removed = before - this.todos.length;
    if (removed) this.save();
    return removed;
  }

  /** 批量添加待办（去空/去重/上限 20 条），返回最新列表 */
  addTodosMany(texts: string[]): TodoDto[] {
    const seen = new Set<string>();
    const list: string[] = [];
    for (const raw of texts) {
      const t = typeof raw === 'string' ? raw.trim() : '';
      if (!t || seen.has(t)) continue;
      seen.add(t);
      list.push(t);
      if (list.length >= 20) break;
    }
    for (const text of list) {
      this.todos.push({ id: this.nextId++, text, done: false, createdAt: Date.now() });
    }
    if (list.length) this.save();
    return this.getTodos();
  }

  stop(): void {
    this.clearTimers();
  }

  // ------------------------------------------------------------------ AI 工具桥（供模型 function-calling 调用）

  addReminderRaw(text: string, atMs: number, recur: 'once' | 'daily'): void {
    const rem: Reminder = { id: this.nextId++, text, atMs, recur, createdAt: Date.now() };
    this.reminders.push(rem);
    this.save();
    this.scheduleSingleReminder(rem);
  }

  listRemindersText(): string {
    if (this.reminders.length === 0) return '';
    return `提醒列表：\n${this.reminders
      .map(
        (r, i) =>
          `${i + 1}) ${r.text}（${r.recur === 'daily' ? '每日 ' : ''}${new Date(r.atMs).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}）`,
      )
      .join('\n')}`;
  }

  cancelReminderById(id: number): void {
    const idx = this.reminders.findIndex((r) => r.id === id);
    if (idx !== -1) {
      this.reminders.splice(idx, 1);
      this.clearTimer(id);
      this.save();
    }
  }

  cancelAllReminders(): void {
    this.reminders = [];
    this.clearTimers();
    this.save();
  }

  addNote(text: string): string {
    const value = text.trim();
    if (!value) return '笔记内容为空。';
    if (value.length > 2000) return '笔记不能超过 2000 字。';
    const note = { id: this.nextId++, text: value, createdAt: Date.now() };
    this.notes.push(note);
    this.save();
    return `已保存笔记 #${note.id}：${note.text}`;
  }

  listNotes(): string {
    if (!this.notes.length) return '当前没有保存的笔记。';
    return `笔记：\n${this.notes.map((note) => `#${note.id} ${note.text}`).join('\n')}`;
  }

  // ------------------------------------------------------------------ private

  private scheduleReminders(): void {
    const now = Date.now();
    this.reminders = this.reminders.filter((r) => r.recur === 'daily' || r.atMs > now);
    let changed = false;
    for (const reminder of this.reminders) {
      if (reminder.recur === 'daily' && reminder.atMs <= now) {
        const next = new Date(reminder.atMs);
        while (next.getTime() <= now) next.setDate(next.getDate() + 1);
        reminder.atMs = next.getTime();
        changed = true;
      }
      this.scheduleSingleReminder(reminder);
    }
    if (changed) this.save();
  }

  /** Node setTimeout 的最大延时（2^31-1 ms ≈ 24.8 天）；更远的提醒必须分段等待，否则会被当成 1ms 立即触发 */
  private static readonly MAX_TIMER_DELAY = 2_147_483_647;

  private scheduleSingleReminder(reminder: Reminder): void {
    const delay = reminder.atMs - Date.now();
    if (delay <= 0) return;
    this.clearTimer(reminder.id);
    const timer = setTimeout(() => {
      this.timers.delete(reminder.id);
      if (Date.now() < reminder.atMs) {
        // 只是长延时被截断的一段：继续等剩余时间，不提前提醒
        this.scheduleSingleReminder(reminder);
        return;
      }
      this.sendBubble?.(`🔔 提醒：${reminder.text}`);
      if (reminder.recur === 'daily') {
        const next = new Date(reminder.atMs);
        next.setDate(next.getDate() + 1);
        reminder.atMs = next.getTime();
        this.save();
        this.scheduleSingleReminder(reminder);
      } else {
        const idx = this.reminders.findIndex((r) => r.id === reminder.id);
        if (idx !== -1) {
          this.reminders.splice(idx, 1);
          this.save();
        }
      }
    }, Math.min(delay, ToolBox.MAX_TIMER_DELAY));
    this.timers.set(reminder.id, timer);
  }

  private clearTimers(): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }

  private clearTimer(id: number): void {
    const timer = this.timers.get(id);
    if (timer === undefined) return;
    clearTimeout(timer);
    this.timers.delete(id);
  }

  private file(): string {
    return path.join(app.getPath('userData'), 'pet-tools.json');
  }

  private save(): void {
    const file = this.file();
    const tmp = `${file}.tmp`;
    const json = JSON.stringify(
      { todos: this.todos, reminders: this.reminders, notes: this.notes, nextId: this.nextId },
      null,
      2,
    );
    try {
      // 先写临时文件再 rename 覆盖：写入中途崩溃也不会留下半截 JSON 把历史数据全毁掉
      fs.writeFileSync(tmp, json, 'utf8');
      fs.renameSync(tmp, file);
      return;
    } catch (err) {
      console.warn('[ToolBox] 原子保存失败，回退直接写入：', err);
    }
    try {
      fs.writeFileSync(file, json, 'utf8');
    } catch (err) {
      console.error('[ToolBox] 保存失败：', err);
    }
  }

  private load(): void {
    try {
      const f = this.file();
      if (!fs.existsSync(f)) return;
      // 用户可能手工编辑过这个文件（记事本存成 UTF-8 with BOM）→ 先剥 BOM，否则待办/笔记会被静默清空
      const data = JSON.parse(fs.readFileSync(f, 'utf8').replace(/^\uFEFF/, '')) as {
        todos?: TodoItem[];
        reminders?: Reminder[];
        notes?: NoteItem[];
        nextId?: number;
      } | null;
      this.todos = Array.isArray(data?.todos) ? data.todos : [];
      this.reminders = Array.isArray(data?.reminders) ? data.reminders : [];
      this.notes = Array.isArray(data?.notes) ? data.notes : [];
      this.nextId = typeof data?.nextId === 'number' ? data.nextId : 1;
      const all = [...this.todos.map((t) => t.id), ...this.reminders.map((r) => r.id), ...this.notes.map((n) => n.id)];
      if (all.length) this.nextId = Math.max(...all, this.nextId) + 1;
    } catch (err) {
      console.error('[ToolBox] 加载失败，重置为空：', err);
      this.todos = [];
      this.reminders = [];
      this.notes = [];
      this.nextId = 1;
    }
  }
}
