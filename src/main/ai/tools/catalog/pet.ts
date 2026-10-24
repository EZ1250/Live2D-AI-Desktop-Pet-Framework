import type { ToolDef } from '../types';

/** 桌宠交互（表情/动作/设置/提问/技能）（拆分前同属 chatClient 的 TOOL_DEFS） */
export const tool_open_settings: ToolDef = { type: 'function', function: { name: 'open_settings', description: '打开 Pet 设置面板。仅在用户明确要求打开设置时使用。', parameters: { type: 'object', properties: {} } } };
export const tool_set_emotion: ToolDef = { type: 'function', function: { name: 'set_emotion', description: '切换桌宠表情。仅在用户明确要求时使用。', parameters: { type: 'object', properties: { name: { type: 'string', description: '表情名称；空字符串表示恢复默认' } }, required: ['name'] } } };
export const tool_play_motion: ToolDef = { type: 'function', function: { name: 'play_motion', description: '播放桌宠动作。仅在用户明确要求时使用。', parameters: { type: 'object', properties: { group: { type: 'string', enum: ['Idle', 'wave'], description: '动作组' } }, required: ['group'] } } };
export const tool_ask_user: ToolDef = {
    type: 'function',
    function: {
      name: 'ask_user',
      description: '向用户提一个问题并等待回答：信息不足、需要在若干方案中选择，或执行前征询许可时使用。',
      parameters: {
        type: 'object',
        properties: {
          question: { type: 'string', description: '完整问题，清晰具体，以问号结尾' },
          options: {
            type: 'array',
            description: '2~4 个互斥选项',
            items: { type: 'object', properties: { label: { type: 'string' }, description: { type: 'string' } }, required: ['label'] },
          },
        },
        required: ['question', 'options'],
      },
    },
  };
export const tool_skill_list: ToolDef = { type: 'function', function: { name: 'skill_list', description: '列出本机可用技能（名称+描述）', parameters: { type: 'object', properties: {} } } };
export const tool_skill_use: ToolDef = { type: 'function', function: { name: 'skill_use', description: '按名称获取某个技能的完整操作步骤，随后严格按其执行', parameters: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] } } };
