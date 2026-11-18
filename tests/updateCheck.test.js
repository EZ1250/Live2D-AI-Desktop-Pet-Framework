/**
 * updateCheck.test.js —— 更新检测的纯逻辑单测（不联网、不依赖 Electron）。
 *
 * 全部读 dist 产物（npm test 会先 build:tsc），与仓库其它测试一致。
 * 覆盖：版本规范化/解析/比较（含预发布、build 元数据、非法版本）、release URL 解析、
 *       失败原因分类、checkForUpdates 的四种结果、更新链接信任判断。
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const updateCheck = require('../dist/main/updateCheck.js');

const {
  normalizeVersion,
  parseVersion,
  compareVersion,
  isNewer,
  extractTagFromUrl,
  isTrustedReleaseUrl,
  classifyRequestError,
  checkForUpdates,
} = updateCheck;

function makeRelease(version) {
  return {
    version,
    tagName: `v${version}`,
    name: `Release ${version}`,
    htmlUrl: `https://github.com/EZ1250/Live2D-AI-Desktop-Pet-Framework/releases/tag/v${version}`,
    publishedAt: '2026-11-17T00:00:00Z',
    body: 'notes',
  };
}

describe('version normalize/parse', () => {
  it('strips leading v/V', () => {
    assert.equal(normalizeVersion('v1.2.3'), '1.2.3');
    assert.equal(normalizeVersion('V1.2.3'), '1.2.3');
    assert.equal(normalizeVersion(' 1.0.3 '), '1.0.3');
  });

  it('parses numeric segments and prerelease', () => {
    assert.deepEqual(parseVersion('1.0.3'), { parts: [1, 0, 3], prerelease: [] });
    assert.deepEqual(parseVersion('v1.0.4-beta.1'), { parts: [1, 0, 4], prerelease: ['beta', '1'] });
    assert.deepEqual(parseVersion('1.2'), { parts: [1, 2], prerelease: [] });
  });

  it('ignores build metadata instead of treating it as prerelease', () => {
    assert.deepEqual(parseVersion('1.0.3+build.7'), { parts: [1, 0, 3], prerelease: [] });
    assert.equal(compareVersion('1.0.3', '1.0.3+build.7'), 0);
  });

  it('rejects malformed versions', () => {
    assert.equal(parseVersion('latest'), null);
    assert.equal(parseVersion(''), null);
    assert.equal(compareVersion('1.0.3', 'latest'), 0);
    assert.equal(isNewer('1.0.3', 'garbage'), false);
  });
});

describe('version compare', () => {
  it('compares numeric segments', () => {
    assert.equal(compareVersion('1.0.3', '1.0.4'), -1);
    assert.equal(compareVersion('1.0.3', '1.0.2'), 1);
    assert.equal(compareVersion('1.0.3', '1.0.3'), 0);
    assert.equal(compareVersion('1.0', '1.0.0'), 0);
  });

  it('treats prerelease as smaller than release', () => {
    assert.equal(compareVersion('1.0.3', '1.0.3-beta'), 1);
    assert.equal(compareVersion('1.0.3-alpha', '1.0.3'), -1);
    assert.equal(compareVersion('1.0.3-beta.2', '1.0.3-beta.10'), -1); // 数字标识按数值比较
  });

  it('compares prerelease labels', () => {
    assert.equal(compareVersion('1.0.3-alpha', '1.0.3-beta'), -1);
    assert.equal(compareVersion('1.0.3-alpha.1', '1.0.3-alpha'), 1);
  });
});

describe('release url helpers', () => {
  it('extracts tag from release url', () => {
    assert.equal(extractTagFromUrl('https://github.com/EZ1250/Live2D-AI-Desktop-Pet-Framework/releases/tag/v1.0.4'), 'v1.0.4');
    assert.equal(extractTagFromUrl('https://github.com/owner/repo/releases/tag/1.0.0/'), '1.0.0');
    assert.equal(extractTagFromUrl('https://github.com/EZ1250/Live2D-AI-Desktop-Pet-Framework/releases/latest'), null);
  });

  it('only trusts this repo release page over https', () => {
    const ok = 'https://github.com/EZ1250/Live2D-AI-Desktop-Pet-Framework/releases/tag/v1.0.4';
    assert.equal(isTrustedReleaseUrl(ok), true);
    assert.equal(isTrustedReleaseUrl('https://github.com/EZ1250/Live2D-AI-Desktop-Pet-Framework/releases/latest'), true);
    assert.equal(isTrustedReleaseUrl('https://www.github.com/EZ1250/Live2D-AI-Desktop-Pet-Framework/releases/tag/v1.0.4'), true);
    assert.equal(isTrustedReleaseUrl('https://github.com/evil/repo/releases/tag/v1.0.4'), false);
    assert.equal(isTrustedReleaseUrl('http://github.com/EZ1250/Live2D-AI-Desktop-Pet-Framework/releases/tag/v1.0.4'), false);
    // 域名欺骗：子域 / 用户信息绕过
    assert.equal(isTrustedReleaseUrl('https://github.com.evil.com/EZ1250/Live2D-AI-Desktop-Pet-Framework/releases/tag/v1.0.4'), false);
    assert.equal(isTrustedReleaseUrl('https://github.com@evil.com/EZ1250/Live2D-AI-Desktop-Pet-Framework/releases/tag/v1.0.4'), false);
    assert.equal(isTrustedReleaseUrl('https://evil.com/github.com/EZ1250/Live2D-AI-Desktop-Pet-Framework/releases/tag/v1.0.4'), false);
    assert.equal(isTrustedReleaseUrl('javascript:alert(1)'), false);
    assert.equal(isTrustedReleaseUrl(''), false);
  });
});

describe('error classification', () => {
  it('maps timeout/rate-limit/http/parse errors', () => {
    assert.equal(classifyRequestError(new Error('TIMEOUT')), 'timeout');
    assert.equal(classifyRequestError(new Error('RATE_LIMITED')), 'rate-limited');
    assert.equal(classifyRequestError(new Error('HTTP 500')), 'http-error');
    assert.equal(classifyRequestError(new Error('PARSE_ERROR')), 'parse-error');
    assert.equal(classifyRequestError(new Error('MISSING_TAG')), 'parse-error');
    assert.equal(classifyRequestError(new Error('什么鬼')), 'unknown');
  });

  it('maps network errno codes to offline', () => {
    for (const code of ['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ETIMEDOUT', 'ENETUNREACH', 'ECONNRESET']) {
      const err = new Error('network');
      err.code = code;
      assert.equal(classifyRequestError(err), 'offline', `${code} 应归为 offline`);
    }
  });

  it('maps untrusted redirect to parse-error', () => {
    assert.equal(classifyRequestError(new Error('UNTRUSTED_REDIRECT')), 'parse-error');
  });
});

describe('checkForUpdates', () => {
  const fetcherOf = (release) => async () => ({ release, source: 'api' });

  it('reports update-available when remote is newer', async () => {
    const state = await checkForUpdates('1.0.3', fetcherOf(makeRelease('1.0.4')));
    assert.equal(state.kind, 'update-available');
    assert.equal(state.release.version, '1.0.4');
    assert.equal(state.source, 'api');
    assert.ok(state.checkedAt > 0);
  });

  it('reports no-update when remote equals current', async () => {
    const state = await checkForUpdates('1.0.3', fetcherOf(makeRelease('1.0.3')));
    assert.equal(state.kind, 'no-update');
  });

  it('does not treat a prerelease of the same version as newer', async () => {
    const state = await checkForUpdates('1.0.3', fetcherOf(makeRelease('1.0.3-beta.1')));
    assert.equal(state.kind, 'no-update');
  });

  it('reports error with reason when fetch throws', async () => {
    const timeout = await checkForUpdates('1.0.3', async () => {
      throw new Error('TIMEOUT');
    });
    assert.equal(timeout.kind, 'error');
    assert.equal(timeout.reason, 'timeout');

    const offlineErr = new Error('offline');
    offlineErr.code = 'ENOTFOUND';
    const offline = await checkForUpdates('1.0.3', async () => {
      throw offlineErr;
    });
    assert.equal(offline.kind, 'error');
    assert.equal(offline.reason, 'offline');
  });

  it('reports parse-error instead of silently "up to date" for bad versions', async () => {
    const fetcher = fetcherOf(makeRelease('1.0.4'));
    const badCurrent = await checkForUpdates('latest', fetcher);
    assert.equal(badCurrent.kind, 'error');
    assert.equal(badCurrent.reason, 'parse-error');

    const badRemote = await checkForUpdates('1.0.3', fetcherOf(makeRelease('nightly')));
    assert.equal(badRemote.kind, 'error');
    assert.equal(badRemote.reason, 'parse-error');
  });
});

describe('startup check (host wiring)', () => {
  it('short-circuits to offline when system reports offline (no network request)', async () => {
    const seen = [];
    updateCheck.registerUpdateHost({
      getVersion: () => '1.0.3',
      isEnabled: () => true,
      isOnline: () => false,
      onStatus: (snapshot) => seen.push(snapshot),
    });
    updateCheck.startAutoUpdateCheck();
    await new Promise((resolve) => setTimeout(resolve, 30));
    const states = seen.map((item) => item.state);
    assert.ok(states.length >= 1, '应当至少推送一次状态');
    const last = states[states.length - 1];
    assert.equal(last.kind, 'error');
    assert.equal(last.reason, 'offline');
    // 快照里的当前版本也要正确（设置页依赖它显示 v1.0.3）
    assert.equal(seen[seen.length - 1].currentVersion, '1.0.3');
  });
});
