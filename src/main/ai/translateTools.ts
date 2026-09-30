// 翻译工具模块：调用 OpenAI 兼容接口完成文本翻译
// 为什么单独封装：避免占用主模型上下文、支持指定语言对、控制长文本风险
// 注意事项：
// - 所有外部输入必须严格校验，防止注入或非法访问
// - 网络请求需设置合理超时和体积限制
// - 不使用 ESM 特性，确保 CommonJS 兼容性

import { request, IncomingMessage } from 'http';
import { request as httpsRequest } from 'https';
import { URL } from 'url';

export interface TranslateConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
}

export interface TranslateArgs {
  text?: unknown;
  to?: unknown;
  from?: unknown;
}

export async function translateText(args: TranslateArgs, cfg: TranslateConfig): Promise<string> {
  if (!cfg.baseUrl || typeof cfg.baseUrl !== 'string') {
    return '还没配置 AI 接口，翻译用不了。请在设置里填好 API 地址、Key 和模型。';
  }
  if (!cfg.apiKey || typeof cfg.apiKey !== 'string') {
    return '还没配置 AI 接口，翻译用不了。请在设置里填好 API 地址、Key 和模型。';
  }
  if (!cfg.model || typeof cfg.model !== 'string') {
    return '还没配置 AI 接口，翻译用不了。请在设置里填好 API 地址、Key 和模型。';
  }

  const text = args.text;
  const to = args.to;
  const from = args.from;

  if (typeof text !== 'string' || text.length === 0) {
    return '请输入要翻译的文本内容。';
  }
  if (text.length > 8000) {
    return '文本太长了，请控制在 8000 字以内再试。';
  }

  if (typeof to !== 'string' || to.length === 0 || to.length > 30) {
    return '目标语言格式不对，请提供一个不超过 30 字的目标语言描述。';
  }

  let sourceLang = '自动识别';
  if (from !== undefined) {
    if (typeof from !== 'string' || from.length > 30) {
      return '源语言格式不对，请提供一个不超过 30 字的语言描述。';
    }
    sourceLang = from;
  }

  const systemPrompt = `你是专业翻译。只输出译文本身，不要输出解释、原文、音标、加注、Markdown 围栏。
保留原文的段落与换行结构；专有名词、代码、URL、数字原样保留。
拿不准的专有名词按行业惯例；不要意译成人名地名以外的内容。
源语言：${sourceLang}；目标语言：${to}`;

  const url = new URL(cfg.baseUrl.replace(/\/+$/, '') + '/chat/completions');

  const postData = JSON.stringify({
    model: cfg.model,
    temperature: 0.2,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: text }
    ]
  });

  const options = {
    hostname: url.hostname,
    port: url.port,
    path: url.pathname + url.search,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${cfg.apiKey}`,
      'Content-Length': Buffer.byteLength(postData)
    },
    timeout: 30000
  };

  const protocol = url.protocol === 'https:' ? httpsRequest : request;

  return new Promise((resolve) => {
    const req = protocol(options, (res: IncomingMessage) => {
      let data = '';
      res.setEncoding('utf8');

      res.on('data', chunk => {
        data += chunk;
        if (data.length > 1024 * 1024) {
          res.destroy();
          resolve('AI 返回内容过大，翻译失败。');
        }
      });

      res.on('end', () => {
        if (res.statusCode !== 200) {
          try {
            const errJson = JSON.parse(data);
            const msg = errJson.error?.message || '未知错误';
            return resolve(`翻译请求失败 (${res.statusCode}): ${msg.substring(0, 200)}`);
          } catch {
            return resolve(`翻译请求失败 (${res.statusCode})`);
          }
        }

        try {
          const result = JSON.parse(data);
          const translated = result.choices?.[0]?.message?.content?.trim();
          if (translated === undefined || translated === null) {
            return resolve('AI 返回的内容看不懂（缺少译文），换个说法再试。');
          }
          if (translated === '') {
            return resolve('翻译结果为空，可能原文没有可翻译的内容。');
          }
          resolve(translated);
        } catch {
          resolve('AI 返回的数据格式不正确，无法解析译文。');
        }
      });
    });

    req.on('error', () => {
      resolve('网络连接出错，翻译失败。');
    });

    req.on('timeout', () => {
      req.destroy();
      resolve('翻译超时了，可能是文本太长或网络慢，可以分段再试。');
    });

    req.write(postData);
    req.end();
  });
}
