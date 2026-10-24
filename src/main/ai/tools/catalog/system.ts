import type { ToolDef } from '../types';

/** 系统/桌面/打开路径（拆分前同属 chatClient 的 TOOL_DEFS） */
export const tool_get_time: ToolDef = { type: 'function', function: { name: 'get_time', description: '获取当前本地日期和时间。用户询问现在几点、今天日期时使用。', parameters: { type: 'object', properties: {} } } };
export const tool_active_window_get: ToolDef = { type: 'function', function: { name: 'active_window_get', description: '查看当前活动窗口的应用、标题和是否全屏，用于了解用户正在做什么。只在用户询问当前工作状态时使用。', parameters: { type: 'object', properties: {} } } };
export const tool_open_path: ToolDef = {
    type: 'function',
    function: {
      name: 'open_path',
      description:
        '用系统默认程序打开工作区里的一个文件或文件夹（做完 PPT/文档后给用户看，或打开项目目录时用）。只允许工作区内的相对路径；为了安全，只放行文档/图片/网页类扩展名与目录，不会启动 .exe/.bat 之类可执行文件。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '工作区内的相对路径，如 sleep.pptx 或 dist/' },
        },
        required: ['path'],
      },
    },
  };
