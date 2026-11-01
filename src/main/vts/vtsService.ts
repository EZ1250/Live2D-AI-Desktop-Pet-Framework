/**
 * vtsService.ts —— VTS「可选后端」的主进程服务（单例 VtsClient + 状态机）
 *
 * 定位：桌宠自己的 Live2D 渲染是**主后端**，本服务只是可选的第二后端——
 * 把桌宠的视线/口型/表情同步到「用户另外开着的 VTube Studio」里的模型。
 * 所以：
 *   - **连接/授权失败绝不阻塞应用启动**：start() 永不 reject，失败只写 lastError；
 *   - **追踪注入是高频、可丢的**：未连接/未授权时静默丢弃（只记 lastError），不抛给调用方；
 *   - **启动阶段绝不弹 VTS 授权窗**：只用磁盘上已保存的 token 认证（cachedOnly），
 *     真要授权由用户在设置页点「授权」显式触发；
 *   - 注入的是**追踪参数**（FaceAngleX / EyeLeftX / MouthOpen …），由 VTS 自己映射到模型参数，
 *     不是 ParamAngleX 这类模型参数（那会以 #453 被拒）。
 *
 * 与 vtsClient.ts 一样：纯 Node 模块，**不 import Electron**（脚本/测试可直接用）。
 */
import * as path from 'node:path';
import { DEFAULT_VTS_URL, VtsClient, normalizeTrackingValues } from './vtsClient';
import type { VtsClientOptions, VtsHotkey, VtsLogger, VtsTrackingValues } from './vtsClient';

/** VTS 插件 API 默认端口 */
export const DEFAULT_VTS_PORT = 8001;

/** 端口 → ws 地址（设置页只让用户填端口） */
export function vtsUrlForPort(port?: number): string {
  const p = typeof port === 'number' && Number.isFinite(port) ? Math.round(port) : DEFAULT_VTS_PORT;
  const safe = p >= 1 && p <= 65535 ? p : DEFAULT_VTS_PORT;
  return `ws://127.0.0.1:${safe}`;
}

/** token 固定放在 userData 下（设置里不暴露路径：用户不需要关心，也不该乱改） */
export function vtsTokenPath(userDataDir: string): string {
  return path.join(userDataDir || '.', 'vts-token.json');
}

/** 设置页/状态栏展示的快照（字段与 IPC_VTS_STATUS 的返回一致） */
export interface VtsStatus {
  /** 服务是否在跑（设置里启用 + 已 start） */
  enabled: boolean;
  connected: boolean;
  authenticated: boolean;
  modelName: string;
  modelLoaded: boolean;
  /** 最近一次失败的**可读**原因；成功后清空。可能来自连接/授权/注入 */
  lastError: string;
  /** 已成功注入 VTS 的追踪帧数（start/stop 时清零） */
  injectedCount: number;
  /** 最近一次成功注入的时刻（ISO 字符串；从未注入过为空串） */
  lastInjectedAt: string;
  /** 最近一次成功注入的追踪值（逻辑字段名，见 vtsClient.ts 的 VtsTrackingField） */
  lastTracking: VtsTrackingValues | null;
  /** 因未启用/未连接/未授权被丢弃的追踪帧数（验证"渲染层在发但主进程丢了"用） */
  droppedCount: number;
}

/** 「测试注入」用的固定一帧：不做视线换算，只验证主进程 → VTS 这条路 */
export const VTS_TEST_INJECT_VALUES: Readonly<VtsTrackingValues> = Object.freeze({
  faceAngleX: 15,
  eyeLeftX: 0.6,
  mouthOpen: 0.7,
});

/** 测试注入的保持时长（之后归零） */
export const VTS_TEST_INJECT_HOLD_MS = 1000;

/** start() 的入参：一个都不给就用构造时的默认值 */
export interface VtsStartOptions {
  /** false = 停掉（默认 true） */
  enabled?: boolean;
  url?: string;
  tokenStorePath?: string;
}

export interface VtsServiceOptions {
  url?: string;
  tokenStorePath?: string;
  clientName?: string;
  developer?: string;
  logger?: VtsLogger;
  /** 授权超时（首次弹窗要等用户点「允许」），默认交给 VtsClient */
  authTimeoutMs?: number;
  /** 测试注入：替换 VtsClient 的构造（默认 new VtsClient） */
  createClient?: (options: VtsClientOptions) => VtsClient;
}

function emptyStatus(): VtsStatus {
  return {
    enabled: false,
    connected: false,
    authenticated: false,
    modelName: '',
    modelLoaded: false,
    lastError: '',
    injectedCount: 0,
    lastInjectedAt: '',
    lastTracking: null,
    droppedCount: 0,
  };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err ?? '未知错误');
}

export class VtsService {
  private readonly options: VtsServiceOptions;
  private readonly log: VtsLogger;

  private client: VtsClient | null = null;
  private current: VtsStatus = emptyStatus();
  /** 每次 start/stop 自增；异步回调回来时代数不一致就作废（避免停止后又被写状态） */
  private generation = 0;
  /** 有一帧注入在飞：后续帧先排队，只保留最后一帧（高频注入不能把请求堆起来） */
  private inflight = false;
  private queued: VtsTrackingValues | null = null;

  constructor(options: VtsServiceOptions = {}) {
    this.options = options;
    this.log = typeof options.logger === 'function'
      ? options.logger
      : (level, message) => {
        if (level === 'warn' || level === 'error') console.warn(`[vts] ${message}`);
      };
  }

  /** 当前状态快照（调用方拿到的是副本，改不到内部） */
  status(): VtsStatus {
    return { ...this.current };
  }

  /** 当前客户端（未启动时为 null；仅供诊断/脚本用） */
  get vtsClient(): VtsClient | null {
    return this.client;
  }

  /**
   * 启动（幂等；重复调用先停旧的再按新参数连）。
   *
   * **永不 reject**：连接/授权失败都只写 lastError —— 调用方（bootstrap）可以放心
   * `void service.start(...)`，不需要 await，也不会拖慢应用启动。
   * 已有 token 时顺带认证并读一次模型名；没有 token 则保持"未授权"等用户点「授权」。
   */
  async start(cfg: VtsStartOptions = {}): Promise<VtsStatus> {
    const enabled = cfg.enabled !== false;
    const url = typeof cfg.url === 'string' && cfg.url.trim()
      ? cfg.url.trim()
      : (this.options.url ?? DEFAULT_VTS_URL);
    const tokenStorePath = cfg.tokenStorePath ?? this.options.tokenStorePath;

    this.stop(); // 幂等：旧连接、排队帧、上一代异步结果全部作废
    if (!enabled) return this.status();

    this.generation += 1;
    const gen = this.generation;
    let client: VtsClient;
    try {
      client = this.buildClient({ url, tokenStorePath });
    } catch (err) {
      this.setStatus({ enabled: false, lastError: `VTS 客户端创建失败：${errorMessage(err)}` });
      return this.status();
    }
    this.client = client;
    this.setStatus({ enabled: true });

    try {
      await client.connect();
      if (!this.isCurrent(gen)) return this.status();
      this.setStatus({ connected: true });
      if (!client.hasCachedToken()) {
        this.setStatus({ lastError: '尚未授权：在设置页点「授权」，到 VTS 弹窗里点允许' });
        this.log('info', '没有已保存的 VTS token，等用户在设置页授权');
        return this.status();
      }
      await this.authenticateOn(gen, client, { cachedOnly: true });
      if (!this.isCurrent(gen) || !this.current.authenticated) return this.status();
      await this.readModel(gen, client);
    } catch (err) {
      this.fail(gen, `VTS 连接失败：${errorMessage(err)}`);
    }
    return this.status();
  }

  /** 停止：断开连接、作废在途请求（保留 lastError 供用户看清最后一条原因？——清掉，别留噪音） */
  stop(): void {
    this.generation += 1;
    this.inflight = false;
    this.queued = null;
    const client = this.client;
    this.client = null;
    if (client) {
      try {
        client.disconnect();
      } catch (err) {
        this.log('warn', `断开 VTS 连接失败：${errorMessage(err)}`);
      }
    }
    this.current = emptyStatus();
  }

  /** 与 stop() 同义（供 shutdown 里按 dispose 语义调用） */
  dispose(): void {
    this.stop();
  }

  /**
   * 授权：连不上就失败；连上后用已保存 token 重试，仍不通就**弹 VTS 授权窗**
   * （这是唯一会弹窗的入口，由用户在设置页显式点击触发）。
   * 永不 reject —— 结果看返回的 status（lastError 里有原因）。
   */
  async authorize(options: { force?: boolean } = {}): Promise<VtsStatus> {
    const client = this.client;
    if (!client) {
      this.setStatus({ lastError: 'VTS 未启用：先勾选「启用 VTS」并保存设置，再点「连接」' });
      return this.status();
    }
    const gen = this.generation;
    try {
      if (!client.isConnected) {
        await client.connect();
        if (!this.isCurrent(gen)) return this.status();
        this.setStatus({ connected: true });
      }
    } catch (err) {
      this.fail(gen, `VTS 连接失败：${errorMessage(err)}`);
      return this.status();
    }
    await this.authenticateOn(gen, client, { force: options.force === true });
    if (this.isCurrent(gen) && this.current.authenticated) await this.readModel(gen, client);
    return this.status();
  }

  /** 重新读一次当前模型（用户在 VTS 里换了模型后刷新状态用） */
  async refresh(): Promise<VtsStatus> {
    const client = this.client;
    if (!client || !client.isConnected) {
      this.setStatus({ connected: false });
      return this.status();
    }
    await this.readModel(this.generation, client);
    return this.status();
  }

  /**
   * 注入一帧追踪值（高频调用；**永不抛**）。
   *
   * 未启用/未连接/未授权时丢弃并记 lastError + droppedCount；在途时只留最后一帧，
   * 所以 30fps 调用也不会把 websocket 请求堆起来。
   */
  injectTracking(values: unknown): void {
    const client = this.client;
    if (!client || !this.current.enabled || !this.current.connected || !this.current.authenticated) {
      const reason = !this.current.enabled || !client
        ? 'VTS 未启用，追踪已丢弃'
        : !this.current.connected
          ? 'VTS 未连接，追踪已丢弃'
          : 'VTS 未授权，追踪已丢弃';
      this.setStatus({
        ...(this.current.lastError !== reason ? { lastError: reason } : {}),
        droppedCount: this.current.droppedCount + 1,
      });
      return;
    }
    const cleaned = normalizeTrackingValues(values);
    if (Object.keys(cleaned).length === 0) return; // 这帧没有可注入的东西：不算错误
    if (this.inflight) {
      this.queued = cleaned;
      return;
    }
    this.sendFrame(client, cleaned);
  }

  /**
   * 「测试注入」：主进程**绕过渲染层**直接注入一帧固定追踪值（faceAngleX=15 /
   * eyeLeftX=0.6 / mouthOpen=0.7），保持 1 秒后归零。
   *
   * 用途：设置页点一下就能判断"主进程 → VTS"这条路通不通——不依赖渲染层是否在发视线。
   * 返回 ok=true 只代表 VTS **接受了请求**（真实生效与否要用 scripts/check-vts.js 读回模型参数）。
   * 永不 reject。
   */
  async testInject(): Promise<{ ok: boolean; error?: string; status: VtsStatus }> {
    let client: VtsClient;
    try {
      client = this.requireReadyClient();
    } catch (err) {
      const message = errorMessage(err);
      this.setStatus({ lastError: message });
      return { ok: false, error: message, status: this.status() };
    }
    const values: VtsTrackingValues = { ...VTS_TEST_INJECT_VALUES };
    try {
      await client.injectTracking(values);
      this.markInjected(values);
    } catch (err) {
      const message = `VTS 测试注入失败：${errorMessage(err)}`;
      this.setStatus({ lastError: message });
      return { ok: false, error: message, status: this.status() };
    }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, VTS_TEST_INJECT_HOLD_MS);
      if (typeof timer.unref === 'function') timer.unref();
    });
    const zero: VtsTrackingValues = {};
    for (const key of Object.keys(values) as Array<keyof VtsTrackingValues>) zero[key] = 0;
    try {
      // 客户端可能在 1 秒里断开（用户点了「断开」/VTS 退出）
      if (client !== this.client) return { ok: false, error: 'VTS 在测试注入期间断开，未能归零', status: this.status() };
      await client.injectTracking(zero);
      this.markInjected(zero);
    } catch (err) {
      const message = `VTS 测试注入归零失败：${errorMessage(err)}`;
      this.setStatus({ lastError: message });
      return { ok: false, error: message, status: this.status() };
    }
    return { ok: true, status: this.status() };
  }

  /** 触发热键（按名字）；失败抛错（调用方要看到"为什么没触发"） */
  async triggerHotkeyByName(name: string): Promise<string> {
    const wanted = typeof name === 'string' ? name.trim() : '';
    if (!wanted) throw new TypeError('热键名不能为空');
    const client = this.requireReadyClient();
    try {
      await client.triggerHotkeyByName(wanted);
    } catch (err) {
      this.setStatus({ lastError: `触发 VTS 热键失败：${errorMessage(err)}` });
      throw err;
    }
    return `已触发 VTS 热键「${wanted}」`;
  }

  /** 当前模型的热键列表（诊断/未来设置页下拉用） */
  async listHotkeys(): Promise<VtsHotkey[]> {
    const client = this.requireReadyClient();
    try {
      return await client.listHotkeys();
    } catch (err) {
      this.setStatus({ lastError: `读取 VTS 热键失败：${errorMessage(err)}` });
      throw err;
    }
  }

  /* ---------------------------------------------------------------- 内部实现 */

  private buildClient(overrides: { url: string; tokenStorePath?: string }): VtsClient {
    const clientOptions: VtsClientOptions = {
      url: overrides.url,
      clientName: this.options.clientName ?? 'Pet',
      developer: this.options.developer ?? 'EZ1250',
      logger: this.log,
      ...(overrides.tokenStorePath ? { tokenStorePath: overrides.tokenStorePath } : {}),
      ...(typeof this.options.authTimeoutMs === 'number' ? { authTimeoutMs: this.options.authTimeoutMs } : {}),
    };
    return typeof this.options.createClient === 'function'
      ? this.options.createClient(clientOptions)
      : new VtsClient(clientOptions);
  }

  /** 已连接 + 已授权才把客户端交出去，否则抛出可读原因 */
  private requireReadyClient(): VtsClient {
    const client = this.client;
    if (!client || !this.current.connected) throw new Error('VTS 未连接：先点「连接」');
    if (!this.current.authenticated) throw new Error('VTS 未授权：先点「授权」');
    return client;
  }

  private sendFrame(client: VtsClient, values: VtsTrackingValues): void {
    this.inflight = true;
    void client.injectTracking(values)
      .then(() => {
        if (client !== this.client) return;
        this.markInjected(values);
      })
      .catch((err: unknown) => {
        if (client !== this.client) return;
        this.setStatus({ lastError: `VTS 追踪注入失败：${errorMessage(err)}` });
      })
      .finally(() => {
        if (client !== this.client) {
          this.inflight = false;
          return;
        }
        this.inflight = false;
        const next = this.queued;
        this.queued = null;
        if (next) this.sendFrame(client, next);
      });
  }

  /** 记一笔"VTS 已接受这一帧"（设置页的 injectedCount / lastInjectedAt / lastTracking 用它） */
  private markInjected(values: VtsTrackingValues): void {
    this.setStatus({
      injectedCount: this.current.injectedCount + 1,
      lastInjectedAt: new Date().toISOString(),
      lastTracking: { ...values },
      ...(this.current.lastError.includes('追踪注入失败') || this.current.lastError.includes('测试注入失败')
        ? { lastError: '' }
        : {}),
    });
  }

  private async authenticateOn(
    gen: number,
    client: VtsClient,
    options: { force?: boolean; cachedOnly?: boolean },
  ): Promise<void> {
    try {
      const result = await client.authenticate(options);
      if (!this.isCurrent(gen)) return;
      this.setStatus({
        connected: client.isConnected,
        authenticated: result.authenticated === true,
        lastError: result.authenticated === true ? '' : '授权未通过',
      });
    } catch (err) {
      if (!this.isCurrent(gen)) return;
      this.setStatus({ connected: client.isConnected, authenticated: false, lastError: `VTS 授权失败：${errorMessage(err)}` });
      this.log('warn', `授权失败：${errorMessage(err)}`);
    }
  }

  private async readModel(gen: number, client: VtsClient): Promise<void> {
    try {
      const model = await client.getModel();
      if (!this.isCurrent(gen)) return;
      const name = typeof model.modelName === 'string' ? model.modelName : '';
      this.setStatus({ modelName: name, modelLoaded: model.modelLoaded === true, lastError: '' });
    } catch (err) {
      if (!this.isCurrent(gen)) return;
      this.setStatus({ lastError: `读取 VTS 模型失败：${errorMessage(err)}` });
    }
  }

  private isCurrent(gen: number): boolean {
    return gen === this.generation;
  }

  private fail(gen: number, message: string): void {
    if (!this.isCurrent(gen)) return;
    this.setStatus({ connected: false, authenticated: false, lastError: message });
    this.log('warn', message);
  }

  private setStatus(patch: Partial<VtsStatus>): void {
    this.current = { ...this.current, ...patch };
  }
}

export default VtsService;
