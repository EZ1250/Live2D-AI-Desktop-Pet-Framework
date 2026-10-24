import type { ToolDef } from '../types';

/** 网络/天气/翻译（拆分前同属 chatClient 的 TOOL_DEFS） */
export const tool_web_fetch: ToolDef = {
    type: 'function',
    function: {
      name: 'web_fetch',
      description:
        '抓取一个网页并转成纯文本阅读（查在线文档、看报错页面、核对 API 用法时用）。只支持 http/https 公网地址，不能访问本机/内网；单次正文最多约 6000 字符。只读，不会改文件；每次抓取前会请用户确认。',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: '完整网址，例如 https://nodejs.org/api/fs.html' },
          max_chars: { type: 'number', description: '正文最多取多少字符（默认 6000，范围 500~20000）' },
        },
        required: ['url'],
      },
    },
  };
export const tool_weather_get: ToolDef = {
    type: 'function',
    function: {
      name: 'weather_get',
      description:
        '查某个城市的实时天气与未来几天预报（数据来自 Open-Meteo，免费无需密钥）。用户问"今天天气怎么样""明天要带伞吗"时用。city 必填——你不知道用户在哪个城市就先问一句，别猜、也别拿模型训练数据里的旧天气糊弄。只读，不联网抓页面，不需要用户确认。',
      parameters: {
        type: 'object',
        properties: {
          city: { type: 'string', description: '城市名，例如 杭州 / 北京 / 上海（中文名即可，≤40 字）' },
          days: { type: 'number', description: '预报天数（默认 3，范围 1~7）' },
        },
        required: ['city'],
      },
    },
  };
export const tool_translate_text: ToolDef = {
    type: 'function',
    function: {
      name: 'translate_text',
      description:
        '把一段文本翻译成指定语言。长文用它比直接在对话里翻译更省上下文，术语也更统一。只输出译文，不含解释。',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', description: '要翻译的文本，≤8000 字' },
          to: { type: 'string', description: '目标语言，例如 英文 / 日语 / English' },
          from: { type: 'string', description: '可选：源语言；不填则自动识别' },
        },
        required: ['text', 'to'],
      },
    },
  };
