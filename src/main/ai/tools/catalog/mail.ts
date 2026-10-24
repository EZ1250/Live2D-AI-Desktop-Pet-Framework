import type { ToolDef } from '../types';

/** 邮件(IMAP)（拆分前同属 chatClient 的 TOOL_DEFS） */
export const tool_mail_compose: ToolDef = {
    type: 'function',
    function: {
      name: 'mail_compose',
      description:
        '起草一封邮件并打开用户的默认邮件客户端（不需要任何邮箱配置）。只负责把收件人/主题/正文填进去，发送由用户在客户端里自己确认——你不会替用户发信。',
      parameters: {
        type: 'object',
        properties: {
          to: { type: 'string', description: '可选：收件人，多个用逗号分隔；不填则打开空白草稿' },
          subject: { type: 'string', description: '可选：主题，≤200 字' },
          body: { type: 'string', description: '可选：正文，≤4000 字' },
        },
      },
    },
  };
export const tool_mail_check: ToolDef = {
    type: 'function',
    function: {
      name: 'mail_check',
      description:
        '查看收件箱里最近的未读邮件（标题/发件人/时间）。需要用户先在设置里配好 IMAP 服务器与授权码；没配就如实说明，不要假装看过。只读，而且用 BODY.PEEK 取信头，不会把邮件标记成已读。',
      parameters: {
        type: 'object',
        properties: {
          limit: { type: 'number', description: '最多列几封，默认 10，范围 1~30' },
          unseen_only: { type: 'boolean', description: '只看未读（默认 true）' },
        },
      },
    },
  };
