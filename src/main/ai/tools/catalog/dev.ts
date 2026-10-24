import type { ToolDef } from '../types';

/** 命令执行与子代理（拆分前同属 chatClient 的 TOOL_DEFS） */
export const tool_shell_run: ToolDef = {
    type: 'function',
    function: {
      name: 'shell_run',
      description:
        '在开发工作区内执行一条 PowerShell 命令（如 mkdir、npm install、npm run build、git status、node script.js）。默认 60 秒超时（可调，上限 300 秒；装依赖这类慢命令请显式给 timeout_ms: 300000），危险命令会被拒绝，每次执行都会先请用户确认，输出会截断。命令之间会记住上次的工作目录（也可用 cwd 显式指定）。',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: '完整 PowerShell 命令' },
          cwd: { type: 'string', description: '工作目录（相对开发工作区，默认即工作区根目录）' },
          timeout_ms: { type: 'number', description: '超时毫秒数（默认 60000，最大 120000）' },
        },
        required: ['command'],
      },
    },
  };
export const tool_shell_bg: ToolDef = {
    type: 'function',
    function: {
      name: 'shell_bg',
      description:
        '把命令放到后台跑（装依赖、跑构建这类慢命令用），立刻返回任务 id，不阻塞对话；随后用 shell_output 查看进度/结果、shell_kill 终止。危险命令同样会被拒绝。',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: '完整 PowerShell 命令（必须非交互）' },
          cwd: { type: 'string', description: '工作目录（相对开发工作区，默认继承上一条命令的目录）' },
        },
        required: ['command'],
      },
    },
  };
export const tool_shell_output: ToolDef = {
    type: 'function',
    function: {
      name: 'shell_output',
      description: '查看后台任务：不传 id 列出全部任务，传 id 看该任务的 stdout/stderr 末尾与状态（running/done/failed/killed）。',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'shell_bg 返回的任务 id，如 bg-1' },
          maxChars: { type: 'number', description: '最多回显多少字符（默认 2000，范围 200~4000）' },
        },
      },
    },
  };
export const tool_shell_kill: ToolDef = {
    type: 'function',
    function: {
      name: 'shell_kill',
      description: '终止一个还在运行的后台任务。',
      parameters: { type: 'object', properties: { id: { type: 'string', description: '任务 id，如 bg-1' } }, required: ['id'] },
    },
  };
