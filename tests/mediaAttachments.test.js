/**
 * mediaAttachments.test.js —— 用户↔AI 媒体附件的纯逻辑单测（不联网、不 spawn）。
 */
'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const media = require('../dist/main/ai/mediaAttachments.js');
const {
  classifyAttachment,
  mimeForName,
  isVisionModelName,
  resolveVisionModel,
  resolveVisionTransport,
  pickVisionModelFromList,
  attachmentSizeError,
  checkMediaCompatibility,
  isPathInside,
  parseMediaMarkers,
  mediaPayloadForFile,
  stageAttachmentBuffer,
  resolveSafeSendFile,
  allowedSendRoots,
  isForbiddenSendFile,
  checkMediaCompatibilityCore,
  MAX_IMAGE_BYTES,
  MAX_TOTAL_ATTACHMENT_BYTES,
  MAX_ATTACHMENTS,
} = media;

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pet-media-test-'));

function settings(extra = {}) {
  return {
    aiMode: 'api',
    aiBaseUrl: 'https://example.com/v1',
    aiApiKey: 'sk-test',
    aiModel: 'deepseek-v4.1-flash',
    voiceBaseUrl: '',
    voiceApiKey: '',
    voiceModel: '',
    ...extra,
  };
}

function attachment(name, size = 1024, mime = '', kind = classifyAttachment(name, mime)) {
  return { path: path.join(tmpRoot, name), name, mime, size, kind };
}

describe('classifyAttachment / mimeForName', () => {
  it('classifies by extension and mime', () => {
    assert.equal(classifyAttachment('a.png', ''), 'image');
    assert.equal(classifyAttachment('a.JPG', ''), 'image');
    assert.equal(classifyAttachment('a.mp3', ''), 'audio');
    assert.equal(classifyAttachment('x', 'audio/wav'), 'audio');
    assert.equal(classifyAttachment('readme.md', ''), 'text');
    assert.equal(classifyAttachment('data.json', ''), 'text');
    assert.equal(classifyAttachment('archive.zip', ''), 'file');
    assert.equal(classifyAttachment('x', 'image/png'), 'image');
    assert.equal(mimeForName('a.png'), 'image/png');
    assert.equal(mimeForName('a.unknownext'), 'application/octet-stream');
  });
});

describe('isVisionModelName / resolveVisionModel', () => {
  it('recognizes vision-capable model names', () => {
    for (const name of ['qwen3-vl-plus', 'qwen-vl-max', 'gpt-4o', 'gemini-2.0-flash', 'glm-4v-plus', 'claude-3-5-sonnet', 'llava-1.6']) {
      assert.equal(isVisionModelName(name), true, name);
    }
    for (const name of ['deepseek-v4.1-flash', 'qwen3-coder-plus', 'text-embedding-3-small', '']) {
      assert.equal(isVisionModelName(name), false, name);
    }
  });

  it('uses explicit visionModel, otherwise defaults to qwen3-vl-plus', () => {
    assert.equal(resolveVisionModel(settings()), 'qwen3-vl-plus');
    assert.equal(resolveVisionModel(settings({ visionModel: 'gpt-4o' })), 'gpt-4o');
    assert.equal(resolveVisionModel(settings({ visionModel: '   ' })), 'qwen3-vl-plus');
  });

  it('visionRoute: auto / chat / custom + independent transport', () => {
    assert.equal(resolveVisionModel(settings({ aiModel: 'gpt-4o', visionModel: 'qwen3-vl-plus' })), 'gpt-4o');
    assert.equal(resolveVisionModel(settings({ aiModel: 'deepseek-v4.1-flash', visionRoute: 'chat' })), 'deepseek-v4.1-flash');
    assert.equal(resolveVisionModel(settings({ visionRoute: 'custom', visionModel: 'qwen3-vl-plus' })), 'qwen3-vl-plus');
    assert.equal(resolveVisionModel(settings({ visionRoute: 'custom', visionModel: '' })), '');
    assert.deepEqual(resolveVisionTransport(settings()), { baseUrl: 'https://example.com/v1', apiKey: 'sk-test' });
    assert.deepEqual(
      resolveVisionTransport(settings({ visionBaseUrl: 'https://vision.example/v1', visionApiKey: 'sk-vision' })),
      { baseUrl: 'https://vision.example/v1', apiKey: 'sk-vision' },
    );
  });
});

describe('checkMediaCompatibility', () => {
  it('API + text-only model + image → converted via vision model', () => {
    const r = checkMediaCompatibilityCore(settings(), [attachment('pic.png', 2048)]);
    assert.equal(r.mode, 'api');
    assert.equal(r.ok, true);
    assert.equal(r.items[0].status, 'converted');
    assert.match(r.items[0].route, /视觉模型转述/);
  });

  it('API + vision model + image → direct', () => {
    const r = checkMediaCompatibilityCore(settings({ aiModel: 'qwen3-vl-plus' }), [attachment('pic.png')]);
    assert.equal(r.ok, true);
    assert.equal(r.items[0].status, 'ok');
    assert.match(r.items[0].route, /直接发送/);
  });

  it('API 模式没配地址/Key 时图片直接判 unsupported（不假装能转述）', () => {
    const r = checkMediaCompatibilityCore(settings({ aiBaseUrl: '', aiApiKey: '', aiModel: '' }), [attachment('pic.png')]);
    assert.equal(r.ok, false);
    assert.equal(r.items[0].status, 'unsupported');
    assert.match(r.items[0].hint, /没有可用的视觉模型|未配置/);
  });

  it('audio: voice* 留空复用聊天 API → converted；连聊天 Key 都没有 → unsupported', () => {
    // 默认配置（有聊天 API Key）：ASR 复用聊天配置 → 可以转写
    const r = checkMediaCompatibilityCore(settings(), [attachment('voice.mp3')]);
    assert.equal(r.ok, true);
    assert.equal(r.items[0].status, 'converted');
    assert.match(r.items[0].route, /ASR/);
    // 明确配置了语音模型也走 ASR
    const r2 = checkMediaCompatibilityCore(settings({ voiceModel: 'qwen3-asr-flash' }), [attachment('voice.mp3')]);
    assert.equal(r2.items[0].status, 'converted');
    // 完全没配置 API（无地址/Key）→ 无法转写
    const r3 = checkMediaCompatibilityCore(settings({ aiBaseUrl: '', aiApiKey: '', aiModel: '' }), [attachment('voice.mp3')]);
    assert.equal(r3.ok, false);
    assert.equal(r3.items[0].status, 'unsupported');
    assert.match(r3.items[0].hint, /语音识别/);
  });

  it('DSH mode: image ok (read_image), text/file ok, audio via ASR', () => {
    const s = settings({ aiMode: 'dsh' });
    const r = checkMediaCompatibilityCore(s, [attachment('pic.png'), attachment('note.txt'), attachment('a.zip')]);
    assert.equal(r.mode, 'dsh');
    assert.equal(r.ok, true);
    assert.equal(r.items[0].status, 'ok');
    assert.match(r.items[0].route, /read_image/);
    assert.equal(r.items[1].status, 'ok');
    assert.equal(r.items[2].status, 'ok');
    const withAudio = checkMediaCompatibilityCore(s, [attachment('voice.mp3')]);
    assert.equal(withAudio.ok, true);
    assert.equal(withAudio.items[0].status, 'converted');
  });

  it('oversize image → unsupported with size hint', () => {
    const r = checkMediaCompatibilityCore(settings(), [attachment('huge.png', MAX_IMAGE_BYTES + 1)]);
    assert.equal(r.ok, false);
    assert.match(r.items[0].hint, /大小限制/);
  });

  it('附件合计超过 40MB → not ok（防上下文/内存爆）', () => {
    const list = [
      attachment('a.txt', 20 * 1024 * 1024),
      attachment('b.txt', 20 * 1024 * 1024),
      attachment('c.txt', MAX_TOTAL_ATTACHMENT_BYTES),
    ];
    const r = checkMediaCompatibilityCore(settings(), list);
    assert.equal(r.ok, false);
    assert.match(r.summary, /合计超过/);
  });

  it('too many attachments → not ok', () => {
    const list = Array.from({ length: MAX_ATTACHMENTS + 1 }, (_, i) => attachment(`f${i}.txt`, 10));
    const r = checkMediaCompatibilityCore(settings(), list);
    assert.equal(r.ok, false);
    assert.match(r.summary, /最多/);
  });
});

describe('视觉模型可用性（/models 探测结果）', () => {
  it('resolveVisionModel：聊天模型是视觉模型直接用它；列表里有视觉模型就选；列表没有返回空', () => {
    assert.equal(resolveVisionModel(settings({ aiModel: 'qwen3-vl-plus' })), 'qwen3-vl-plus');
    assert.equal(resolveVisionModel(settings({ aiModel: 'qwen3-vl-plus' }), ['deepseek-v4.1-flash']), 'qwen3-vl-plus');
    assert.equal(resolveVisionModel(settings({}), ['deepseek-v4.1-flash', 'qwen3-vl-plus']), 'qwen3-vl-plus');
    assert.equal(resolveVisionModel(settings({}), ['deepseek-v4.1-flash', 'qwen3-coder-plus']), '');
    assert.equal(resolveVisionModel(settings({ visionModel: 'my-vl' }), ['deepseek-v4.1-flash']), 'my-vl');
  });

  it('pickVisionModelFromList：优先 qwen3-vl-plus/vl/vision，排除 omni-realtime/audio 等', () => {
    assert.equal(
      pickVisionModelFromList(['deepseek-v4.1-flash', 'qwen3.8-omni-flash-realtime', 'qwen3-vl-plus', 'qwen-vl-max']),
      'qwen3-vl-plus',
    );
    assert.equal(pickVisionModelFromList(['deepseek-v4.1-flash', 'gpt-4o-mini']), 'gpt-4o-mini');
    assert.equal(pickVisionModelFromList(['deepseek-v4.1-flash', 'qwen3-coder-plus']), '');
  });

  it('端点只有文本模型：图片判 unsupported，提示给出替代方案（换模型/填视觉模型/用 DSH）', () => {
    const r = checkMediaCompatibilityCore(settings(), [attachment('pic.png')], {
      availableModels: ['deepseek-v4.1-flash', 'qwen3-coder-plus'],
    });
    assert.equal(r.ok, false);
    assert.equal(r.items[0].status, 'unsupported');
    assert.match(r.items[0].hint, /没有可用的视觉模型/);
    assert.match(r.items[0].hint, /桥接 DSH/);
  });

  it('设置里填的视觉模型不在 /models 列表：判 unsupported 并指名该模型', () => {
    const r = checkMediaCompatibilityCore(settings({ visionModel: 'no-such-vl' }), [attachment('pic.png')], {
      availableModels: ['deepseek-v4.1-flash', 'qwen3-vl-plus'],
    });
    assert.equal(r.ok, false);
    assert.match(r.items[0].hint, /no-such-vl/);
    assert.match(r.items[0].hint, /桥接 DSH/);
  });

  it('列表里有视觉模型：图片判 converted 并用该模型名', () => {
    const r = checkMediaCompatibilityCore(settings(), [attachment('pic.png')], {
      availableModels: ['deepseek-v4.1-flash', 'qwen3-vl-plus'],
    });
    assert.equal(r.ok, true);
    assert.equal(r.items[0].status, 'converted');
    assert.match(r.items[0].route, /qwen3-vl-plus/);
  });

  it('/models 拉不到（unknown）：乐观放行 converted，并在提示里说明未确认', () => {
    const r = checkMediaCompatibilityCore(settings(), [attachment('pic.png')], { availableModels: null });
    assert.equal(r.ok, true);
    assert.equal(r.items[0].status, 'converted');
    assert.match(r.items[0].hint, /未能从 \/models 确认/);
  });
});

describe('isPathInside / parseMediaMarkers', () => {
  it('path containment rejects traversal and outside files', () => {
    const inside = path.join(tmpRoot, 'out', 'a.txt');
    assert.equal(isPathInside(tmpRoot, inside), true);
    assert.equal(isPathInside(tmpRoot, path.join(tmpRoot, '..', 'escape.txt')), false);
    assert.equal(isPathInside(tmpRoot, tmpRoot), false);
  });

  it('兼容 [[send:outbox/x]] 写法（都相对 outbox 解析）', () => {
    const outbox = path.join(tmpRoot, 'bridge2', 'outbox');
    fs.mkdirSync(outbox, { recursive: true });
    fs.writeFileSync(path.join(outbox, 'x.txt'), 'ok');
    for (const marker of ['[[send:x.txt]]', '[[send:outbox/x.txt]]']) {
      const r = parseMediaMarkers(`文件 ${marker}`, outbox);
      assert.equal(r.files.length, 1, marker);
      assert.equal(path.basename(r.files[0].path), 'x.txt');
    }
  });

  it('parses [[send:...]] markers, only inside allowed dir, strips markers', () => {
    const dir = path.join(tmpRoot, 'bridge');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'ok.txt'), 'hello');
    const text = '给你文件 [[send:ok.txt]] 和越权 [[send:../escape.txt]] 和不存在 [[send:nope.txt]]';
    const r = parseMediaMarkers(text, dir);
    assert.equal(r.files.length, 1);
    assert.equal(path.basename(r.files[0].path), 'ok.txt');
    assert.ok(r.text.includes('给你文件'));
    assert.ok(!r.text.includes('[[send:'));
    assert.equal(r.warnings.length, 2);
  });
});

describe('回发文件安全白名单', () => {
  it('resolveSafeSendFile：只在白名单根内、必须是普通文件', () => {
    const root = path.join(tmpRoot, 'safe-root');
    fs.mkdirSync(root, { recursive: true });
    const good = path.join(root, 'ok.png');
    fs.writeFileSync(good, 'x');
    const ok = resolveSafeSendFile(good, [root]);
    assert.equal(ok.ok, true);
    assert.equal(path.basename(ok.real), 'ok.png');
    assert.equal(resolveSafeSendFile(path.join(tmpRoot, 'outside.png'), [root]).ok, false);
    assert.equal(resolveSafeSendFile(path.join(root, 'missing.png'), [root]).ok, false);
    assert.equal(resolveSafeSendFile(root, [root]).ok, false); // 目录不行
  });

  it('allowedSendRoots：只包含媒体区/暂存区/DSH outbox/开发工作区，不包含 userData 根', () => {
    const ud = path.join(tmpRoot, 'ud');
    const roots = allowedSendRoots(ud, 'C:\\work', path.join(ud, 'dsh-bridge'));
    assert.ok(roots.includes(path.join(ud, 'chat-media')));
    assert.ok(roots.includes(path.join(ud, 'uploads')));
    assert.ok(roots.includes(path.join(ud, 'dsh-bridge', 'outbox')));
    assert.ok(!roots.includes(ud));
  });

  it('isForbiddenSendFile：拒绝配置/密钥与可执行文件', () => {
    for (const name of ['settings.json', 'chat-log.json', 'mcp.json', 'token.json', 'evil.exe', 'run.bat', 'a.ps1']) {
      assert.equal(isForbiddenSendFile(name), true, name);
    }
    for (const name of ['pic.png', 'note.txt', 'voice.mp3']) {
      assert.equal(isForbiddenSendFile(name), false, name);
    }
  });
});

describe('mediaPayloadForFile / stageAttachmentBuffer', () => {
  it('builds image payload with dataUrl and file payload without', () => {
    const png = path.join(tmpRoot, 'tiny.png');
    // 1x1 透明 PNG
    fs.writeFileSync(png, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64'));
    const payload = mediaPayloadForFile(png, '一张图');
    assert.equal(payload.kind, 'image');
    assert.equal(payload.mime, 'image/png');
    assert.match(payload.dataUrl, /^data:image\/png;base64,/);
    assert.equal(payload.caption, '一张图');

    const txt = path.join(tmpRoot, 'note.txt');
    fs.writeFileSync(txt, 'hi');
    const filePayload = mediaPayloadForFile(txt);
    assert.equal(filePayload.kind, 'file');
    assert.equal(filePayload.dataUrl, undefined);
    assert.equal(mediaPayloadForFile(path.join(tmpRoot, 'missing.txt')), null);
  });

  it('stages bytes into uploads dir and persists them', () => {
    const uploads = path.join(tmpRoot, 'uploads');
    const r = stageAttachmentBuffer(uploads, new Uint8Array([1, 2, 3]), 'clip.png', 'image/png');
    assert.equal(r.ok, true);
    assert.ok(r.path && fs.existsSync(r.path));
    assert.equal(fs.readFileSync(r.path).length, 3);
    assert.equal(fs.readdirSync(uploads).length, 1);
    const empty = stageAttachmentBuffer(uploads, new Uint8Array([]), 'x', '');
    assert.equal(empty.ok, false);
  });
});

process.on('exit', () => {
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});
