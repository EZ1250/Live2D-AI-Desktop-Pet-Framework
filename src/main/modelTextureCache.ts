/**
 * modelTextureCache.ts —— Live2D 模型纹理降采样缓存（性能/内存优化）
 *
 * 背景（实测）：用户模型贴图常用 4096/8192 图集，例如 DeepSeek 6 张图共 148.7M 像素
 * （RGBA 解压后约 595MB，GPU 进程工作集实测 1.5GB）；而桌宠窗口通常只有 ~600px 宽，
 * 8192 贴图在显示尺寸下和 2048 没有肉眼差别。这里把超大贴图一次性降采样到
 * 「显示够用的分辨率」并缓存到 userData，静态服务优先返回缓存文件：显存/内存大降、
 * 模型切换更快，而画面质量在桌宠显示尺寸下保持一致（设置里可选 1024/2048/4096/原始）。
 *
 * 实现：
 *  - 只处理 userData 里的用户模型目录（/user-models/<名字>/…），不动用户原文件；
 *  - 缓存目录：<userData>/live2d-cache/<maxSize>/<模型名>/<原相对路径>；
 *  - 扫描模型目录里的图片，先用文件头解析尺寸（PNG/JPEG/WebP/GIF），只有超过 maxSize 的
 *    才用 Electron nativeImage 解码 → 等比缩小 → 存回同扩展名（PNG/JPEG；WebP 跳过以免 MIME 不符）；
 *  - meta.json 记录源文件 mtime/size，源文件变化或换设置会自动重建；
 *  - 构建在后台串行进行（模型挂载完成后延迟启动），不阻塞 UI。
 */
import * as fs from 'fs';
import * as path from 'path';
import { app, nativeImage } from 'electron';
import { findUserModel } from './assets/userAssets';
import { loadAppSettings } from './ai/chatClient';
import { normalizeTextureMax, readImageInfo, sanitizeCacheKey } from './modelTextureInfo';

export { normalizeTextureMax, sanitizeCacheKey, readImageInfo } from './modelTextureInfo';

/** 用户模型纹理缓存目录（含 maxSize，改设置自动换目录重建）。 */
export function userModelCacheDir(name: string, maxSizeOverride?: number): string {
  const max =
    maxSizeOverride === undefined ? normalizeTextureMax(loadAppSettings().textureMaxSize) : normalizeTextureMax(maxSizeOverride);
  return path.join(app.getPath('userData'), 'live2d-cache', String(max), sanitizeCacheKey(name));
}

interface CacheMeta {
  version: 1;
  maxSize: number;
  files: Record<string, { srcMtimeMs: number; srcSize: number; outSize: number }>;
}

function readMeta(file: string): CacheMeta | null {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as CacheMeta;
    if (raw && raw.version === 1 && raw.files && typeof raw.files === 'object') return raw;
  } catch {
    /* 无/坏 meta 视为未缓存 */
  }
  return null;
}

function writeMeta(file: string, meta: CacheMeta): void {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(meta, null, 2), 'utf8');
    fs.renameSync(tmp, file);
  } catch {
    /* 缓存写失败不影响主流程，下次再试 */
  }
}

function walkImageFiles(dir: string, out: string[] = [], depth = 0): string[] {
  if (depth > 2 || out.length > 200) return out;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkImageFiles(full, out, depth + 1);
    } else if (entry.isFile() && /\.(png|jpe?g|webp|gif)$/i.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

export interface TextureCacheResult {
  built: number;
  skipped: number;
  failed: number;
  sourceBytes: number;
  outputBytes: number;
}

/**
 * 构建/更新一个用户模型的纹理缓存。耗时操作逐张让出事件循环；
 * 失败项只计数不抛错（模型仍可用原始纹理）。
 */
export async function ensureUserModelTextureCache(name: string, maxSizeOverride?: number): Promise<TextureCacheResult | null> {
  const max =
    maxSizeOverride === undefined ? normalizeTextureMax(loadAppSettings().textureMaxSize) : normalizeTextureMax(maxSizeOverride);
  if (max <= 0) return null; // 原始精度：不降采样
  const model = findUserModel(name);
  if (!model || !model.dir) return null;
  const cacheDir = userModelCacheDir(name, max);
  const metaFile = path.join(cacheDir, 'meta.json');
  const meta = readMeta(metaFile) ?? { version: 1 as const, maxSize: max, files: {} as CacheMeta['files'] };
  if (meta.maxSize !== max) {
    meta.maxSize = max;
    meta.files = {};
  }
  const result: TextureCacheResult = { built: 0, skipped: 0, failed: 0, sourceBytes: 0, outputBytes: 0 };
  const files = walkImageFiles(model.dir);
  for (const src of files) {
    let stat: fs.Stats;
    try {
      stat = fs.statSync(src);
    } catch {
      continue;
    }
    const rel = path.relative(model.dir, src);
    const ext = path.extname(src).toLowerCase();
    const format = ext === '.png' ? 'png' : ext === '.jpg' || ext === '.jpeg' ? 'jpeg' : ext === '.webp' ? 'webp' : ext === '.gif' ? 'gif' : 'unknown';
    if (format !== 'png' && format !== 'jpeg') {
      result.skipped++;
      continue; // webp/gif 不降采样：避免扩展名/MIME 不符或动图破坏
    }
    const prev = meta.files[rel];
    const dest = path.join(cacheDir, rel);
    if (prev && prev.srcMtimeMs === stat.mtimeMs && prev.srcSize === stat.size && fs.existsSync(dest)) {
      result.skipped++;
      continue;
    }
    let head: Buffer;
    try {
      const fd = fs.openSync(src, 'r');
      const buf = Buffer.alloc(64 * 1024);
      const read = fs.readSync(fd, buf, 0, buf.length, 0);
      fs.closeSync(fd);
      head = buf.subarray(0, read);
    } catch {
      result.failed++;
      continue;
    }
    const info = readImageInfo(head);
    if (!info || Math.max(info.width, info.height) <= max) {
      // 不需要缩小的图不缓存（静态服务直接回原图）
      if (fs.existsSync(dest)) {
        try {
          fs.unlinkSync(dest);
        } catch {
          /* ignore */
        }
      }
      meta.files[rel] = { srcMtimeMs: stat.mtimeMs, srcSize: stat.size, outSize: 0 };
      result.skipped++;
      continue;
    }
    const scale = max / Math.max(info.width, info.height);
    const targetW = Math.max(1, Math.round(info.width * scale));
    const targetH = Math.max(1, Math.round(info.height * scale));
    try {
      const img = nativeImage.createFromPath(src);
      if (img.isEmpty()) {
        result.failed++;
        continue;
      }
      const resized = img.resize({ width: targetW, height: targetH, quality: 'best' });
      const out = format === 'jpeg' ? resized.toJPEG(92) : resized.toPNG();
      if (!out || !out.length) {
        result.failed++;
        continue;
      }
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, out);
      meta.files[rel] = { srcMtimeMs: stat.mtimeMs, srcSize: stat.size, outSize: out.length };
      result.built++;
      result.sourceBytes += stat.size;
      result.outputBytes += out.length;
    } catch {
      result.failed++;
    }
    // 每张之间让出事件循环，避免一次卡住主进程
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  // 清理源文件已删除的缓存项
  for (const rel of Object.keys(meta.files)) {
    if (!fs.existsSync(path.join(model.dir, rel))) delete meta.files[rel];
  }
  writeMeta(metaFile, meta);
  return result;
}

// ---------------------------------------------------------------- 后台调度

const lastBuilt = new Map<string, number>();
let pendingTimer: NodeJS.Timeout | null = null;
let pendingName = '';
let running = false;

/**
 * 模型加载后调用：**等它稳定停留 20s 再构建**（只保留最后一个模型），
 * 避免"用户正在快速切模型/刚启动"时后台解码大图集拖慢切换。
 */
export function scheduleUserModelTextureCache(name: string | null | undefined): void {
  const modelName = (name ?? '').trim();
  if (!modelName) return;
  const max = normalizeTextureMax(loadAppSettings().textureMaxSize);
  if (max <= 0) return;
  const key = `${modelName}@${max}`;
  const last = lastBuilt.get(key) ?? 0;
  if (Date.now() - last < 30 * 60 * 1000) return; // 半小时内不重复构建
  pendingName = modelName;
  if (pendingTimer) clearTimeout(pendingTimer);
  pendingTimer = setTimeout(() => {
    pendingTimer = null;
    const target = pendingName;
    if (!target || running) return;
    running = true;
    void ensureUserModelTextureCache(target)
      .then((res) => {
        if (!res) {
          running = false;
          return;
        }
        lastBuilt.set(`${target}@${normalizeTextureMax(loadAppSettings().textureMaxSize)}`, Date.now());
        if (res.built > 0 || res.failed > 0) {
          const saved = Math.round(((res.sourceBytes - res.outputBytes) / 1024 / 1024) * 10) / 10;
          console.log(
            `[textureCache] ${target}: 重建 ${res.built} 张（跳过 ${res.skipped}，失败 ${res.failed}），源 ${Math.round(
              res.sourceBytes / 1024 / 1024,
            )}MB → 缓存 ${Math.round(res.outputBytes / 1024 / 1024)}MB（约省 ${saved}MB）`,
          );
        } else {
          console.log(`[textureCache] ${target}: 缓存已是最新（跳过 ${res.skipped} 张）`);
        }
      })
      .catch((err: unknown) => console.warn('[textureCache] 构建失败', (err as Error)?.message ?? err))
      .finally(() => {
        running = false;
      });
  }, 20000); // 停留 20s 才构建
  pendingTimer.unref?.();
}
