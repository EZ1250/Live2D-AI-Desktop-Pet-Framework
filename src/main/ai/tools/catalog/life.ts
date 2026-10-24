import type { ToolDef } from '../types';

/** 待办与笔记（拆分前同属 chatClient 的 TOOL_DEFS） */
export const tool_note_add: ToolDef = { type: 'function', function: { name: 'note_add', description: '保存用户明确要求记住的工作想法或个人笔记。', parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } } };
export const tool_note_list: ToolDef = { type: 'function', function: { name: 'note_list', description: '列出已保存的个人工作笔记。', parameters: { type: 'object', properties: {} } } };
export const tool_open_todo_panel: ToolDef = { type: 'function', function: { name: 'open_todo_panel', description: '打开“待办笔记本”面板（用户说 打开待办/笔记本/清单 时用）', parameters: { type: 'object', properties: {} } } };
export const tool_todo_add: ToolDef = { type: 'function', function: { name: 'todo_add', description: '添加一条待办事项', parameters: { type: 'object', properties: { text: { type: 'string', description: '待办内容' } }, required: ['text'] } } };
export const tool_todo_list: ToolDef = { type: 'function', function: { name: 'todo_list', description: '列出当前待办事项', parameters: { type: 'object', properties: {} } } };
export const tool_todo_toggle: ToolDef = { type: 'function', function: { name: 'todo_toggle', description: '把某条待办标记完成/取消（按 id）', parameters: { type: 'object', properties: { id: { type: 'number' } }, required: ['id'] } } };
export const tool_todo_remove: ToolDef = { type: 'function', function: { name: 'todo_remove', description: '删除某条待办（按 id）', parameters: { type: 'object', properties: { id: { type: 'number' } }, required: ['id'] } } };
export const tool_todo_update: ToolDef = { type: 'function', function: { name: 'todo_update', description: '修改某条待办的文字（保留完成状态）', parameters: { type: 'object', properties: { id: { type: 'number' }, text: { type: 'string' } }, required: ['id', 'text'] } } };
export const tool_todo_clear_done: ToolDef = { type: 'function', function: { name: 'todo_clear_done', description: '清除所有已完成的待办', parameters: { type: 'object', properties: {} } } };
export const tool_todo_add_many: ToolDef = { type: 'function', function: { name: 'todo_add_many', description: '一次添加多条待办（2~20 条，自动过滤空串与重复）', parameters: { type: 'object', properties: { texts: { type: 'array', items: { type: 'string' } } }, required: ['texts'] } } };
