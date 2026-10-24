import type { ToolDef } from '../types';

/** 提醒与日程（拆分前同属 chatClient 的 TOOL_DEFS） */
export const tool_meeting_create: ToolDef = {
    type: 'function',
    function: {
      name: 'meeting_create',
      description:
        '把一件日程写进用户日历（用户说"记个会""明天三点开会"时用）。生成标准 .ics 文件并交给系统默认日历程序导入——不需要任何账号授权。时间要问清楚，不要自己编。',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: '日程标题，≤120 字' },
          start: { type: 'string', description: '开始时间，写成 2026-09-30 15:00（本地时间）或完整 ISO8601' },
          duration_minutes: { type: 'number', description: '时长（分钟），默认 60，范围 5~480' },
          location: { type: 'string', description: '可选：地点，≤500 字' },
          description: { type: 'string', description: '可选：说明，≤500 字' },
        },
        required: ['title', 'start'],
      },
    },
  };
export const tool_set_reminder: ToolDef = {
    type: 'function',
    function: {
      name: 'set_reminder',
      description: '设置提醒/闹钟。可相对时间(after_minutes)或定点(at_hhmm 如 "20:30")，daily=true 表示每天重复',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', description: '提醒内容' },
          after_minutes: { type: 'number', description: '多少分钟后提醒' },
          at_hhmm: { type: 'string', description: '今日该时刻提醒（HH:MM），已过则次日' },
          daily: { type: 'boolean', description: '每天重复' },
        },
        required: ['text'],
      },
    },
  };
export const tool_reminder_list: ToolDef = { type: 'function', function: { name: 'reminder_list', description: '列出已设置的提醒/闹钟', parameters: { type: 'object', properties: {} } } };
export const tool_reminder_cancel: ToolDef = { type: 'function', function: { name: 'reminder_cancel', description: '取消提醒（id 或 all）', parameters: { type: 'object', properties: { id: { type: 'number' }, all: { type: 'boolean' } } } } };
