import type { ToolDef } from '../types';

/** 开发工作区文件操作（拆分前同属 chatClient 的 TOOL_DEFS） */
export const tool_workspace_file_read: ToolDef = { type: 'function', function: { name: 'workspace_file_read', description: '读取工作区内文本文件的一小段。仅接受相对路径。', parameters: { type: 'object', properties: { path: { type: 'string', description: '工作区内的相对路径，如 src/main/ai/chatClient.ts' }, startLine: { type: 'number', description: '起始行，从 1 开始（可省略）' }, endLine: { type: 'number', description: '结束行，含该行（可省略）' } }, required: ['path'] } } };
export const tool_workspace_search: ToolDef = { type: 'function', function: { name: 'workspace_search', description: '在工作区文本和代码中搜索：默认返回「文件:行号: 片段」；可用 mode 切换 files（只给命中的文件）/ count（每个文件的命中数），regex 用正则，glob 过滤文件名。', parameters: { type: 'object', properties: { query: { type: 'string', description: '关键词或正则（≤200 字符）' }, glob: { type: 'string', description: '可选文件名过滤，支持 * 与 **，例如 *.ts、src/**/*.ts' }, mode: { type: 'string', enum: ['content', 'files', 'count'], description: '输出模式：content=命中行（默认）；files=只列文件；count=每个文件命中数' }, regex: { type: 'boolean', description: '是否把 query 当正则（默认 false=普通文本）' }, ignore_case: { type: 'boolean', description: '是否忽略大小写（默认 true）' }, maxResults: { type: 'number', description: '最多返回条数，默认 20（上限 50）' } }, required: ['query'] } } };
export const tool_workspace_glob: ToolDef = {
    type: 'function',
    function: {
      name: 'workspace_glob',
      description: '按 glob 模式列出工作区里的文件（按最近修改排序，默认最多 100 个），用来先摸清项目里有哪些文件。例：**/*.ts、src/**、package.json。',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'glob 模式，如 **/*.ts（省略则列出全部文本文件）' },
          maxResults: { type: 'number', description: '最多返回多少个（默认 100，上限 500）' },
        },
      },
    },
  };
export const tool_workspace_set_root: ToolDef = {
    type: 'function',
    function: {
      name: 'workspace_set_root',
      description:
        '把某个绝对路径目录设为「开发工作区」（会弹一次确认框并保存到设置）。当用户明确说出要在哪个目录里建项目/文件夹时，先调用它；不要要求用户自己去设置面板填写。',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string', description: '完整的绝对路径，例如 C:\\Users\\you\\Desktop\\我的项目' } },
        required: ['path'],
      },
    },
  };
export const tool_workspace_mkdir: ToolDef = {
    type: 'function',
    function: {
      name: 'workspace_mkdir',
      description: '在开发工作区内创建目录（自动递归创建父目录）。仅在用户明确要求新建文件夹/项目目录时使用。每次执行都会先请用户确认。',
      parameters: { type: 'object', properties: { path: { type: 'string', description: '相对开发工作区的路径，如 my-app/src' } }, required: ['path'] },
    },
  };
export const tool_workspace_write: ToolDef = {
    type: 'function',
    function: {
      name: 'workspace_write',
      description: '在开发工作区内创建或覆盖一个文本文件（自动创建父目录；会覆盖同名文件；内容上限 2MB；每次执行都会先请用户确认）。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '相对开发工作区的路径，如 my-app/package.json' },
          content: { type: 'string', description: '完整文件内容（会原样写入，最多 2MB）' },
        },
        required: ['path', 'content'],
      },
    },
  };
export const tool_workspace_edit: ToolDef = {
    type: 'function',
    function: {
      name: 'workspace_edit',
      description: '对开发工作区内已有文件做精确字符串替换。old_string 必须在文件中唯一，否则请补足上下文或设置 replace_all。改文件前应先用 workspace_file_read 读过它。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '相对开发工作区的文件路径' },
          old_string: { type: 'string', description: '要被替换的原文（含缩进，必须与文件内容完全一致）' },
          new_string: { type: 'string', description: '替换成的新内容' },
          replace_all: { type: 'boolean', description: '是否替换所有匹配项（默认 false，只替换唯一的一处）' },
        },
        required: ['path', 'old_string', 'new_string'],
      },
    },
  };
