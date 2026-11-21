/**
 * castCapture.ts —— 手机投屏的 Windows 原生抓屏助手（CastCap.exe）封装。
 *
 * 为什么不用 renderer/desktopCapturer：
 * - desktopCapturer.getSources 单次约 300ms（~3fps）；
 * - renderer 的 Canvas getImageData / OffscreenCanvas JPEG 编码在本机约 65~75ms/帧（~16fps）；
 * - 本进程内的 .NET GDI 抓屏 + JPEG 编码实测可到 24fps+（1280x800 q55，目标 30fps 调度）。
 *
 * 协议：子进程 stdout 连续输出 [4 字节 little-endian 长度][JPEG 字节]；stderr 写诊断信息。
 */
import { spawn, type ChildProcess } from 'child_process';

export interface CastCaptureOptions {
  exePath: string;
  width: number;
  fps: number;
  quality: number;
  /** 1-based 显示器序号（传给 CastCap） */
  display?: number;
  onFrame: (jpeg: Buffer) => void;
  onError?: (message: string) => void;
  onExit?: (code: number | null) => void;
}

export class CastCapture {
  private child: ChildProcess | null = null;
  private buffer: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  private stopped = false;
  private generation = 0;
  private restarts = 0;
  private restartTimer: NodeJS.Timeout | null = null;
  private watchdogTimer: NodeJS.Timeout | null = null;
  private lastFrameAt = 0;
  private readonly opts: CastCaptureOptions;

  constructor(opts: CastCaptureOptions) {
    this.opts = opts;
  }

  get running(): boolean {
    return this.child !== null && !this.stopped;
  }

  start(): void {
    this.stop();
    this.stopped = false;
    this.restarts = 0;
    this.spawn();
  }

  private spawn(): void {
    if (this.stopped) return;
    const generation = ++this.generation;
    this.buffer = Buffer.alloc(0);
    this.lastFrameAt = Date.now();
    const args = [
      String(Math.max(320, Math.min(1920, Math.round(this.opts.width)))),
      String(Math.max(1, Math.min(30, Math.round(this.opts.fps)))),
      String(Math.max(35, Math.min(95, Math.round(this.opts.quality)))),
      '3600',
      String(Math.max(1, Math.min(8, Math.round(this.opts.display ?? 1)))),
    ];
    let child: ChildProcess;
    try {
      child = spawn(this.opts.exePath, args, {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      this.opts.onError?.(`投屏抓屏助手启动失败：${(err as Error).message}`);
      return;
    }
    this.child = child;
    child.stdout?.on('data', (chunk: Buffer) => {
      // 代际/实例校验：旧进程残留数据绝不进入新流
      if (generation !== this.generation || this.child !== child || this.stopped) return;
      this.onStdout(chunk);
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      if (generation !== this.generation || this.child !== child) return;
      const text = chunk.toString('utf8').trim();
      if (text) this.opts.onError?.(text);
    });
    child.on('error', (err) => {
      if (generation !== this.generation) return;
      this.opts.onError?.(`投屏抓屏助手异常：${err.message}`);
    });
    child.on('exit', (code) => {
      if (generation !== this.generation || this.child !== child) return;
      this.child = null;
      if (this.stopped) return;
      this.opts.onError?.(`投屏抓屏助手已退出（code=${code ?? 'null'}），尝试重启（${this.restarts + 1}/3）`);
      this.scheduleRestart();
    });

    // 帧看门狗：5s 无帧视为挂死，重启（最多 3 次），避免一直黑屏
    if (this.watchdogTimer) clearInterval(this.watchdogTimer);
    this.watchdogTimer = setInterval(() => {
      if (this.stopped || this.child !== child) return;
      if (Date.now() - this.lastFrameAt > 5000) {
        this.opts.onError?.('投屏抓屏助手 5s 无帧，重启');
        this.killCurrent();
        this.scheduleRestart();
      }
    }, 2000);
    this.watchdogTimer.unref?.();
  }

  private scheduleRestart(): void {
    if (this.stopped || this.restarts >= 3) {
      if (this.restarts >= 3) this.opts.onError?.('投屏抓屏助手连续失败 3 次，停止自动重启');
      return;
    }
    this.restarts += 1;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      if (!this.stopped) this.spawn();
    }, 600);
    this.restartTimer.unref?.();
  }

  /** 只杀当前进程，不改变 stopped/generation（供看门狗重启） */
  private killCurrent(): void {
    const child = this.child;
    this.child = null;
    if (!child) return;
    try { child.kill(); } catch { /* ignore */ }
  }

  stop(): void {
    this.stopped = true;
    this.generation += 1;
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    if (this.watchdogTimer) {
      clearInterval(this.watchdogTimer);
      this.watchdogTimer = null;
    }
    this.buffer = Buffer.alloc(0);
    this.killCurrent();
    this.child = null;
  }

  /** 解析 [len][jpeg] 帧；容忍 pipe 任意分片；缓冲超限时丢弃并等待重启 */
  private onStdout(chunk: Buffer): void {
    if (this.stopped) return;
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
    if (this.buffer.length > 4 * 1024 * 1024) {
      this.opts.onError?.('投屏帧缓冲超过 4MB，丢弃并准备重启');
      this.buffer = Buffer.alloc(0);
      this.killCurrent();
      this.scheduleRestart();
      return;
    }
    for (;;) {
      if (this.buffer.length < 4) return;
      const len = this.buffer.readUInt32LE(0);
      if (len < 2 || len > 8 * 1024 * 1024) {
        this.opts.onError?.(`投屏帧长度异常：${len}，重启助手`);
        this.buffer = Buffer.alloc(0);
        this.killCurrent();
        this.scheduleRestart();
        return;
      }
      if (this.buffer.length < 4 + len) return;
      const jpeg = this.buffer.subarray(4, 4 + len);
      this.buffer = this.buffer.subarray(4 + len);
      this.lastFrameAt = Date.now();
      try {
        this.opts.onFrame(Buffer.from(jpeg));
      } catch (err) {
        this.opts.onError?.(`投屏帧回调失败：${(err as Error).message}`);
      }
    }
  }
}
