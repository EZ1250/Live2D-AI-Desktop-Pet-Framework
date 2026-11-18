/**
 * updateCheck.ts —— 启动时更新检测（GitHub Release）
 *
 * 为什么需要：应用没有代码签名、也没有自动更新通道，用户不知道有新版本时只能手动来仓库看。
 * 这里在启动后**异步检查一次** GitHub 最新 Release，把结果推给渲染层/托盘/设置页；
 * 发现比当前版本新时给"前往下载"的跳转入口（跳转到 GitHub Release 页，本模块不下载、不安装）。
 *
 * 设计要点：
 *  - 纯函数（版本解析/比较/URL 信任判断/错误分类）与网络请求分离，网络 fetcher 可注入，
 *    因此离线单测不需要联网、也不会消耗额度。
 *  - 启动检查不阻塞启动：`startAutoUpdateCheck()` fire-and-forget，失败只在设置页/日志留状态。
 *  - 不做重试风暴：一次启动最多两跳请求（API → HTML 兜底），超时 8s；GitHub 限流时静默。
 *  - 只信任 `https://github.com/EZ1250/Live2D-AI-Desktop-Pet-Framework/releases/...` 的链接，
 *    防止把用户带去别的地址。
 *  - `PET_UPDATE_FAKE_LATEST` 是**调试钩子**（仅开发态使用）：伪造远端版本号，用于肉眼验证
 *    "有更新"UI，不必改 package.json / 不必等真发版。
 */
import * as https from 'https';
import type { IncomingHttpHeaders } from 'http';
import { URL } from 'url';
import type {
  ReleaseInfo,
  ReleaseSource,
  UpdateErrorReason,
  UpdateSnapshot,
  UpdateState,
} from '../shared/contracts';

export const UPDATE_REPO = 'EZ1250/Live2D-AI-Desktop-Pet-Framework';
const API_URL = `https://api.github.com/repos/${UPDATE_REPO}/releases/latest`;
const FALLBACK_URL = `https://github.com/${UPDATE_REPO}/releases/latest`;
const RELEASE_PATH_PREFIX = `/${UPDATE_REPO}/releases/`;
const REQUEST_TIMEOUT_MS = 8000;
const USER_AGENT = `Pet-Desktop-App (+https://github.com/${UPDATE_REPO})`;

interface FetchResult {
  release: ReleaseInfo;
  source: ReleaseSource;
}

/** 网络层可注入：单测传假 fetcher，避免真实请求。 */
export type FetchLatest = () => Promise<FetchResult>;

interface RawResponse {
  status: number;
  headers: IncomingHttpHeaders;
  body: string;
}

function requestOnce(url: string, headers: Record<string, string>, timeoutMs: number): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const req = https.request(url, { method: 'GET', headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => {
        resolve({
          status: res.statusCode ?? 0,
          headers: res.headers,
          body: Buffer.concat(chunks).toString('utf8'),
        });
      });
    });
    const timer = setTimeout(() => {
      req.destroy(new Error('TIMEOUT'));
    }, timeoutMs);
    req.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    req.end();
  });
}

/** 跟随 3xx（GitHub 的 releases/latest 会 302 到 /releases/tag/vX.Y.Z）。 */
async function followRequest(startUrl: string, maxRedirects = 5): Promise<{ res: RawResponse; finalUrl: string }> {
  let url = startUrl;
  for (let i = 0; i <= maxRedirects; i++) {
    const res = await requestOnce(url, { 'User-Agent': USER_AGENT }, REQUEST_TIMEOUT_MS);
    if (res.status >= 300 && res.status < 400 && res.headers.location) {
      // 只跟随 github.com 的 https 重定向：防止被引到非可信域（只读，但也没必要给第三方发请求）
      const next = new URL(res.headers.location, url);
      if (next.protocol !== 'https:' || (next.hostname !== 'github.com' && next.hostname !== 'www.github.com')) {
        throw new Error('UNTRUSTED_REDIRECT');
      }
      url = next.href;
      continue;
    }
    return { res, finalUrl: url };
  }
  throw new Error('TOO_MANY_REDIRECTS');
}

async function apiRequest(): Promise<FetchResult> {
  const res = await requestOnce(API_URL, { 'User-Agent': USER_AGENT, Accept: 'application/vnd.github+json' }, REQUEST_TIMEOUT_MS);
  if (res.status !== 200) {
    if (res.status === 429 || (res.status === 403 && res.headers['x-ratelimit-remaining'] === '0')) {
      throw new Error('RATE_LIMITED');
    }
    throw new Error(`HTTP ${res.status}`);
  }
  let data: unknown;
  try {
    data = JSON.parse(res.body);
  } catch {
    throw new Error('PARSE_ERROR');
  }
  if (!data || typeof data !== 'object') throw new Error('PARSE_ERROR');
  const dto = data as Record<string, unknown>;
  const tagName = typeof dto.tag_name === 'string' ? dto.tag_name : '';
  if (!tagName) throw new Error('MISSING_TAG');
  // 非 semver tag（如 nightly）不参与版本比较：归为解析失败，避免误报"有更新"
  if (!parseVersion(normalizeVersion(tagName))) throw new Error('MISSING_TAG');
  const release: ReleaseInfo = {
    version: normalizeVersion(tagName),
    tagName,
    name: typeof dto.name === 'string' && dto.name ? dto.name : tagName,
    htmlUrl: typeof dto.html_url === 'string' ? dto.html_url : releaseUrlForTag(tagName),
    publishedAt: typeof dto.published_at === 'string' ? dto.published_at : '',
    body: typeof dto.body === 'string' ? dto.body : '',
  };
  return { release, source: 'api' };
}

async function fallbackRequest(): Promise<FetchResult> {
  const { res, finalUrl } = await followRequest(FALLBACK_URL);
  if (res.status !== 200) {
    if (res.status === 429) throw new Error('RATE_LIMITED');
    throw new Error(`HTTP ${res.status}`);
  }
  const tag = extractTagFromUrl(finalUrl);
  if (!tag) throw new Error('MISSING_TAG');
  // 302 目标被改成非 tag 页（登录页/限流页）时不要把它当版本号
  if (!parseVersion(normalizeVersion(tag))) throw new Error('MISSING_TAG');
  const release: ReleaseInfo = {
    version: normalizeVersion(tag),
    tagName: tag,
    name: tag,
    htmlUrl: releaseUrlForTag(tag),
    publishedAt: '',
    body: '',
  };
  return { release, source: 'fallback' };
}

function releaseUrlForTag(tagName: string): string {
  return `https://github.com/${UPDATE_REPO}/releases/tag/${encodeURIComponent(tagName)}`;
}

function fakeRelease(version: string): ReleaseInfo {
  return {
    version: normalizeVersion(version),
    tagName: `v${normalizeVersion(version)}`,
    name: `v${normalizeVersion(version)}（调试）`,
    htmlUrl: `https://github.com/${UPDATE_REPO}/releases/latest`,
    publishedAt: '',
    body: '',
  };
}

/** 拉取远端最新 Release：先 API，失败再走 HTML 短链（两种都失败就抛原始错误）。 */
export async function fetchLatestRelease(): Promise<FetchResult> {
  // 调试钩子只在开发态生效（打包版 allowDebugOverride=false，防止本机环境变量伪造更新提示）
  const forced = debugOverride ? (process.env.PET_UPDATE_FAKE_LATEST || '').trim() : '';
  if (forced) return { release: fakeRelease(forced), source: 'api' };
  try {
    return await apiRequest();
  } catch {
    return await fallbackRequest();
  }
}

/** 去掉 `v` 前缀（`v1.0.3` → `1.0.3`）。 */
export function normalizeVersion(version: string): string {
  return String(version || '').trim().replace(/^[vV]/, '');
}

export interface ParsedVersion {
  parts: number[];
  /** semver 预发布标识（空数组 = 正式版） */
  prerelease: string[];
}

/**
 * 宽松解析版本号：支持 `1`、`1.2`、`1.2.3`、`v1.2.3`、`1.2.3-beta.1`；
 * `+build` 构建元数据直接忽略（不参与比较）；无法解析返回 null。
 */
export function parseVersion(version: string): ParsedVersion | null {
  const withoutBuild = normalizeVersion(version).split('+')[0].trim();
  const match = withoutBuild.match(/^(\d+(?:\.\d+)*)(?:-(.+))?$/);
  if (!match) return null;
  const parts = match[1].split('.').map((piece) => Number(piece));
  if (parts.some((piece) => !Number.isFinite(piece))) return null;
  const prerelease = (match[2] ?? '')
    .split('.')
    .map((piece) => piece.trim())
    .filter(Boolean);
  return { parts, prerelease };
}

function comparePrerelease(a: string[], b: string[]): number {
  if (!a.length && !b.length) return 0;
  if (!a.length) return 1; // 正式版 > 预发布
  if (!b.length) return -1;
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const av = a[i];
    const bv = b[i];
    if (av === undefined) return -1;
    if (bv === undefined) return 1;
    const an = /^\d+$/.test(av);
    const bn = /^\d+$/.test(bv);
    if (an && bn) {
      const diff = Number(av) - Number(bv);
      if (diff !== 0) return diff < 0 ? -1 : 1;
    } else if (an !== bn) {
      return an ? -1 : 1; // 数字标识 < 字母标识（semver §11）
    } else if (av !== bv) {
      return av < bv ? -1 : 1;
    }
  }
  return 0;
}

/** 比较两个版本：<0 = current 旧于 latest；0 = 相同/无法比较；>0 = current 更新。 */
export function compareVersion(current: string, latest: string): number {
  const a = parseVersion(current);
  const b = parseVersion(latest);
  if (!a || !b) return 0;
  const len = Math.max(a.parts.length, b.parts.length);
  for (let i = 0; i < len; i++) {
    const av = a.parts[i] ?? 0;
    const bv = b.parts[i] ?? 0;
    if (av !== bv) return av < bv ? -1 : 1;
  }
  return comparePrerelease(a.prerelease, b.prerelease);
}

export function isNewer(current: string, latest: string): boolean {
  return compareVersion(current, latest) < 0;
}

/** 从 `…/releases/tag/v1.2.3` 取 tag；取不到返回 null。 */
export function extractTagFromUrl(url: string): string | null {
  const match = String(url || '').match(/\/releases\/tag\/([^/]+)\/?$/);
  return match ? decodeURIComponent(match[1]) : null;
}

/** 只信任本仓库 release 页面链接（https + github.com + 仓库 releases 路径）。 */
export function isTrustedReleaseUrl(url: string): boolean {
  if (typeof url !== 'string' || !url) return false;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:') return false;
    if (parsed.hostname !== 'github.com' && parsed.hostname !== 'www.github.com') return false;
    return parsed.pathname.startsWith(RELEASE_PATH_PREFIX);
  } catch {
    return false;
  }
}

/** 把请求异常归类成设置页可读的原因；未知错误归 unknown。 */
export function classifyRequestError(err: unknown): UpdateErrorReason {
  const message = err instanceof Error ? err.message : String(err);
  if (message === 'TIMEOUT') return 'timeout';
  if (message === 'RATE_LIMITED') return 'rate-limited';
  if (
    message === 'MISSING_TAG' ||
    message === 'PARSE_ERROR' ||
    message === 'TOO_MANY_REDIRECTS' ||
    message === 'UNTRUSTED_REDIRECT'
  ) {
    return 'parse-error';
  }
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  if (
    code === 'ECONNREFUSED' ||
    code === 'ENOTFOUND' ||
    code === 'EAI_AGAIN' ||
    code === 'ENETUNREACH' ||
    code === 'ECONNRESET' ||
    code === 'ETIMEDOUT' ||
    code === 'EACCES'
  ) {
    return 'offline';
  }
  if (/^HTTP \d{3}/.test(message)) return 'http-error';
  return 'unknown';
}

/** 纯逻辑：给定当前版本与 fetcher，产出一次检查结果（不联网、可直接单测）。 */
export async function checkForUpdates(currentVersion: string, fetcher: FetchLatest): Promise<UpdateState> {
  // 版本号解析不了时给明确错误（否则 compareVersion 会静默返回 0 → 假装"已是最新"）
  if (!parseVersion(currentVersion)) {
    return { kind: 'error', reason: 'parse-error', detail: `当前版本号无法解析：${currentVersion}`, checkedAt: Date.now() };
  }
  try {
    const result = await fetcher();
    if (!parseVersion(result.release.version)) {
      return {
        kind: 'error',
        reason: 'parse-error',
        detail: `远端版本号无法解析：${result.release.version}`,
        checkedAt: Date.now(),
      };
    }
    if (isNewer(currentVersion, result.release.version)) {
      return { kind: 'update-available', release: result.release, checkedAt: Date.now(), source: result.source };
    }
    return { kind: 'no-update', checkedAt: Date.now(), source: result.source };
  } catch (err) {
    return {
      kind: 'error',
      reason: classifyRequestError(err),
      detail: err instanceof Error ? err.message : String(err),
      checkedAt: Date.now(),
    };
  }
}

interface UpdateHost {
  getVersion(): string;
  isEnabled(): boolean;
  onStatus(snapshot: UpdateSnapshot): void;
  /** 系统层在线判断（Electron net.isOnline）；未提供时跳过短路由真实请求去判断。 */
  isOnline?(): boolean;
  /** 是否允许 PET_UPDATE_FAKE_LATEST 调试钩子（仅开发态；打包版必须为 false）。 */
  allowDebugOverride?: boolean;
}

let host: UpdateHost | null = null;
let snapshot: UpdateSnapshot = { currentVersion: '', state: { kind: 'idle' } };
let started = false;
let debugOverride = false;
let inFlight: Promise<UpdateState> | null = null;

export function registerUpdateHost(next: UpdateHost): void {
  host = next;
  debugOverride = next.allowDebugOverride === true;
}

export function getCurrentUpdateSnapshot(): UpdateSnapshot {
  return snapshot;
}

function publish(next: UpdateState): void {
  if (!host) return;
  snapshot = { currentVersion: host.getVersion(), state: next };
  host.onStatus(snapshot);
}

/** 系统报告离线时直接给 offline 结果（不发起无谓请求）；判断本身抛错则继续走真实请求。 */
function offlineState(current: UpdateHost): UpdateState | null {
  try {
    if (typeof current.isOnline === 'function' && !current.isOnline()) {
      return { kind: 'error', reason: 'offline', detail: '系统报告当前离线（net.isOnline=false）', checkedAt: Date.now() };
    }
    return null;
  } catch {
    return null;
  }
}

function runCheck(current: UpdateHost): Promise<UpdateState> {
  // 防抖：启动检查与手动检查撞车、或用户连点"立即检查"时，复用同一次请求
  if (inFlight) return inFlight;
  publish({ kind: 'checking' });
  inFlight = (async (): Promise<UpdateState> => {
    let state: UpdateState;
    try {
      state = offlineState(current) ?? (await checkForUpdates(current.getVersion(), fetchLatestRelease));
    } catch (err) {
      state = { kind: 'error', reason: 'unknown', detail: err instanceof Error ? err.message : String(err), checkedAt: Date.now() };
    } finally {
      inFlight = null;
    }
    publish(state);
    return state;
  })();
  return inFlight;
}

/** 启动时自动检查一次（fire-and-forget；关闭开关时只标记 disabled，不联网）。 */
export function startAutoUpdateCheck(): void {
  const current = host;
  if (!current || started) return;
  started = true;
  if (!current.isEnabled()) {
    publish({ kind: 'disabled' });
    return;
  }
  void runCheck(current);
}

/** 设置页「立即检查」：忽略开关与缓存，强制联网检查一次。 */
export function triggerManualUpdateCheck(): Promise<UpdateState> {
  if (!host) {
    return Promise.resolve<UpdateState>({ kind: 'error', reason: 'unknown', detail: '更新检测未初始化' });
  }
  return runCheck(host);
}

/** 用户在设置里关闭"启动时检查更新"：把缓存状态置 disabled（撤掉旧的可更新提示）。 */
export function markUpdateCheckDisabled(): UpdateSnapshot {
  publish({ kind: 'disabled' });
  return snapshot;
}
