import type { ToolDef } from '../types';

/** 计划与任务（拆分前同属 chatClient 的 TOOL_DEFS） */
export const tool_plan_update: ToolDef = {
    type: 'function',
    function: {
      name: 'plan_update',
      description:
        '维护一份用户可见的任务进度清单：多步任务开工时先列清单（全部 pending），之后每完成一步就更新一次（做完的标 done、正在做的标 doing）。单步任务不要用；清单最多 20 项。',
      parameters: {
        type: 'object',
        properties: {
          items: {
            type: 'array',
            description: '完整清单（每次都要把全部项一起传，不是增量）',
            items: {
              type: 'object',
              properties: {
                text: { type: 'string', description: '这一步要做什么（≤120 字）' },
                status: { type: 'string', enum: ['pending', 'doing', 'done'], description: 'pending=待办、doing=进行中、done=已完成' },
              },
              required: ['text'],
            },
          },
        },
        required: ['items'],
      },
    },
  };
export const tool_agent_task: ToolDef = {
    type: 'function',
    function: {
      name: 'agent_task',
      description:
        '把「开放式探查/研究」交给一个独立上下文的子代理去做：它自己多轮读文件/搜代码，最后只回一段结论摘要（省上下文）。适合"摸清陌生项目结构""找出某功能实现在哪""多文件交叉验证"；一步能查完的不要用。默认只给只读工具，不会改文件。',
      parameters: {
        type: 'object',
        properties: {
          prompt: { type: 'string', description: '交给子代理的任务，写清楚要查清什么、输出什么（≤2000 字）' },
          tools: {
            type: 'array',
            items: { type: 'string' },
            description: '可选：允许子代理使用的工具名子集（默认只读：workspace_file_read/workspace_search/workspace_glob）',
          },
          max_rounds: { type: 'number', description: '子代理最多几轮工具调用（默认 4，范围 1~6）' },
        },
        required: ['prompt'],
      },
    },
  };
export const tool_plan_propose: ToolDef = {
    type: 'function',
    function: {
      name: 'plan_propose',
      description: '多步任务（建项目、改多个文件、装依赖、跑构建）动手前，先用它把计划交给用户批准。用户批准后再执行；被拒绝就问清楚要改什么。简单一步操作不要用。',
      parameters: {
        type: 'object',
        properties: { plan: { type: 'string', description: '实施计划：要创建/修改哪些文件、执行哪些命令、如何验证（分行写）' } },
        required: ['plan'],
      },
    },
  };
