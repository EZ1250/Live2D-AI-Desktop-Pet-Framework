/**
 * dshBridge.test.js —— DSH 桥接的纯逻辑单测（不 spawn 真实 dsh、不联网）。
 *
 * 覆盖：NDJSON 行解析容错、会话失效识别、dsh 命令解析（PATH/APPDATA/环境变量覆盖）、
 * Windows 下 .cmd/.ps1 的启动计划、错误文案。
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const bridge = require('../dist/main/ai/dshBridge.js');
const {
  parseDshLine,
  looksLikeInvalidSession,
  resolveDshCommand,
  buildDshSpawnPlan,
  formatDshError,
  decodeConsoleBytes,
  isValidSessionId,
  isSafeCommandPath,
  buildChildEnv,
  DshError,
} = bridge;

describe('parseDshLine', () => {
  it('parses typed NDJSON events', () => {
    assert.deepEqual(parseDshLine('{"type":"session","sessionId":"session-1"}'), {
      type: 'session',
      sessionId: 'session-1',
    });
    assert.deepEqual(parseDshLine('{"type":"final","text":"你好"}'), { type: 'final', text: '你好' });
  });

  it('returns null for blank/malformed/non-object lines', () => {
    for (const line of ['', '   ', 'not json', '[1,2]', 'null', '42', '{"noType":1}', '{"type":""}']) {
      assert.equal(parseDshLine(line), null, `应当忽略：${line}`);
    }
  });
});

describe('looksLikeInvalidSession', () => {
  it('detects common DSH session-invalid messages', () => {
    for (const text of ['unknown session id: session-x', 'Session not found', 'invalid session', 'No such session']) {
      assert.equal(looksLikeInvalidSession(text), true, text);
    }
  });

  it('ignores unrelated stderr', () => {
    assert.equal(looksLikeInvalidSession('some other error'), false);
    assert.equal(looksLikeInvalidSession(''), false);
    assert.equal(looksLikeInvalidSession(undefined), false);
  });
});

describe('resolveDshCommand', () => {
  const exists = (paths) => (p) => paths.includes(p);

  it('prefers PET_DSH_CMD override', () => {
    const got = resolveDshCommand({
      env: { PET_DSH_CMD: 'C:\\custom\\dsh.cmd' },
      platform: 'win32',
      pathExists: exists([]),
    });
    assert.equal(got, 'C:\\custom\\dsh.cmd');
  });

  it('finds dsh.cmd in PATH on Windows', () => {
    const dir = 'C:\\Users\\me\\AppData\\Roaming\\npm';
    const got = resolveDshCommand({
      env: { PATH: `C:\\Windows;${dir}`, APPDATA: 'C:\\Users\\me\\AppData\\Roaming' },
      platform: 'win32',
      pathExists: exists([`${dir}\\dsh.cmd`]),
    });
    assert.equal(got, `${dir}\\dsh.cmd`);
  });

  it('falls back to APPDATA npm dir', () => {
    const appData = 'C:\\Users\\me\\AppData\\Roaming';
    const got = resolveDshCommand({
      env: { PATH: 'C:\\Windows', APPDATA: appData },
      platform: 'win32',
      pathExists: exists([`${appData}\\npm\\dsh.cmd`]),
    });
    assert.equal(got, `${appData}\\npm\\dsh.cmd`);
  });

  it('keeps a plain command name when nothing is found', () => {
    const got = resolveDshCommand({
      env: { PATH: 'C:\\Windows', APPDATA: '' },
      platform: 'win32',
      pathExists: () => false,
    });
    assert.equal(got, 'dsh.cmd');
  });
});

describe('buildDshSpawnPlan', () => {
  it('builds a quoted shell command line for .cmd on Windows', () => {
    const plan = buildDshSpawnPlan('C:\\npm\\dsh.cmd', ['--profile', 'headless', '--json', '-'], 'win32');
    assert.equal(plan.shell, true);
    assert.deepEqual(plan.args, []);
    assert.equal(plan.command, '"C:\\npm\\dsh.cmd" --profile headless --json -');
  });

  it('uses powershell for .ps1', () => {
    const plan = buildDshSpawnPlan('C:\\npm\\dsh.ps1', ['-V'], 'win32');
    assert.equal(plan.command, 'powershell.exe');
    assert.deepEqual(plan.args.slice(0, 2), ['-NoProfile', '-ExecutionPolicy']);
  });

  it('runs directly for exe/other and non-Windows', () => {
    assert.deepEqual(buildDshSpawnPlan('dsh', ['-V'], 'linux'), { command: 'dsh', args: ['-V'] });
    assert.deepEqual(buildDshSpawnPlan('C:\\npm\\dsh.exe', ['-V'], 'win32'), {
      command: 'C:\\npm\\dsh.exe',
      args: ['-V'],
    });
  });
});

describe('decodeConsoleBytes', () => {
  it('decodes UTF-8 output as-is', () => {
    assert.equal(decodeConsoleBytes(Buffer.from('收到', 'utf8')), '收到');
  });

  it('falls back to GBK for Windows cmd error text (GBK bytes)', () => {
    // GBK 编码的「测试」
    const gbk = Buffer.from([0xb2, 0xe2, 0xca, 0xd4]);
    assert.equal(decodeConsoleBytes(gbk), '测试');
  });
});

describe('formatDshError', () => {
  it('keeps readable DshError message and normalizes other errors', () => {
    assert.equal(formatDshError(new DshError('TIMEOUT', 'DSH 超时（120s）')), 'DSH 超时（120s）');
    assert.equal(formatDshError(new Error('boom')), 'boom');
    assert.equal(formatDshError('plain'), 'plain');
  });
});


describe('session id / command path safety', () => {
  it('accepts normal DSH session ids and rejects cmd-metacharacter payloads', () => {
    assert.equal(isValidSessionId('session-3d33102b-ec6e-4b2c-8de1-e2982af417ed'), true);
    assert.equal(isValidSessionId('session_1.2-3'), true);
    for (const bad of [
      '',
      'session 1',
      'session&calc',
      'session|x',
      'session^y',
      'session"z"',
      'session%PATH%',
      'session;rm',
      '-session',
      'a'.repeat(200),
      null,
      42,
    ]) {
      assert.equal(isValidSessionId(bad), false, `应拒绝：${String(bad)}`);
    }
  });

  it('rejects unsafe command paths (quotes / percent / control chars)', () => {
    assert.equal(isSafeCommandPath('C:\\Users\\me\\AppData\\Roaming\\npm\\dsh.cmd'), true);
    assert.equal(isSafeCommandPath('C:\\Program Files\\dsh\\dsh.exe'), true);
    for (const bad of [
      'C:\\evil\\a"b\\dsh.cmd',
      "C:\\evil\\a'b\\dsh.cmd",
      'C:\\evil\\%TEMP%\\dsh.cmd',
      'C:\\evil\\a&b\\dsh.cmd',
      'C:\\evil\\a|b\\dsh.cmd',
      'C:\\evil\\a<b\\dsh.cmd',
      'C:\\evil\\a>b\\dsh.cmd',
      'C:\\evil\\a^b\\dsh.cmd',
      'C:\\evil\\a$b\\dsh.cmd',
      'C:\\evil\\a`b\\dsh.cmd',
      'C:\\evil\\a\r\ndsh.cmd',
      '',
    ]) {
      assert.equal(isSafeCommandPath(bad), false, `应拒绝命令路径：${JSON.stringify(bad)}`);
    }
  });

  it('strips BOM before JSON parsing', () => {
    const parsed = parseDshLine('\uFEFF{"type":"final","text":"ok"}');
    assert.deepEqual(parsed, { type: 'final', text: 'ok' });
  });

  it('builds a child env that carries DSH_* but drops pet AI secrets', () => {
    process.env.DEEPSEEK_API_KEY = 'sk-test';
    process.env.AI_API_KEY = 'ai-test';
    process.env.MAIL_PASS = 'mail-test';
    process.env.ANTHROPIC_API_KEY = 'anthropic-test';
    process.env.GITHUB_TOKEN = 'ghp-test';
    process.env.AWS_SECRET_ACCESS_KEY = 'aws-test';
    process.env.KEEP_ME = 'keep';
    const env = buildChildEnv({ DSH_PERMISSION_MODE: 'read-only' });
    assert.equal(env.DSH_PERMISSION_MODE, 'read-only');
    assert.equal(env.KEEP_ME, 'keep');
    for (const key of [
      'DEEPSEEK_API_KEY',
      'AI_API_KEY',
      'MAIL_PASS',
      'ANTHROPIC_API_KEY',
      'GITHUB_TOKEN',
      'AWS_SECRET_ACCESS_KEY',
    ]) {
      assert.equal(env[key], undefined, `${key} 不应传给 dsh 子进程`);
    }
    for (const key of [
      'DEEPSEEK_API_KEY',
      'AI_API_KEY',
      'MAIL_PASS',
      'ANTHROPIC_API_KEY',
      'GITHUB_TOKEN',
      'AWS_SECRET_ACCESS_KEY',
      'KEEP_ME',
    ]) {
      delete process.env[key];
    }
  });
});
