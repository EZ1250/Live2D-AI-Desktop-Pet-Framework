/**
 * modelTextureInfo.ts —— 纹理降采样相关的纯函数（无 Electron 依赖，便于单测）。
 */
export type ImageFormat = 'png' | 'jpeg' | 'webp' | 'gif' | 'unknown';

export interface ImageInfo {
  width: number;
  height: number;
  format: ImageFormat;
}

/** 纹理精度设置统一成 maxSize：0=原始（不降采样），其它为最长边上限（像素）。 */
export function normalizeTextureMax(value: unknown): number {
  const n = typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : 4096;
  if (n <= 0) return 0;
  return Math.max(256, Math.min(8192, n));
}

/** 缓存目录名（模型名可能含中文/特殊字符）。 */
export function sanitizeCacheKey(name: string): string {
  return (name || 'model').replace(/[^\w.\-\u4e00-\u9fa5]/g, '_').slice(0, 120) || 'model';
}

/** 从文件头解析图片尺寸（不全量解码，几十字节即可）。 */
export function readImageInfo(buf: Buffer): ImageInfo | null {
  if (!buf || buf.length < 10) return null;
  // PNG: 89 50 4E 47 0D 0A 1A 0A + IHDR
  if (buf.length >= 24 && buf.readUInt32BE(0) === 0x89504e47) {
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20), format: 'png' };
  }
  // GIF: GIF87a/GIF89a
  if (buf.slice(0, 6).toString('ascii').startsWith('GIF')) {
    return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8), format: 'gif' };
  }
  // JPEG: 找 SOFn
  if (buf.length >= 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2;
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) {
        i++;
        continue;
      }
      const marker = buf[i + 1];
      if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) {
        i += 2;
        continue;
      }
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { width: buf.readUInt16BE(i + 7), height: buf.readUInt16BE(i + 5), format: 'jpeg' };
      }
      if (i + 4 > buf.length) break;
      const len = buf.readUInt16BE(i + 2);
      if (len < 2) break;
      i += 2 + len;
    }
    return null;
  }
  // WebP: RIFF....WEBP
  if (buf.length >= 30 && buf.slice(0, 4).toString('ascii') === 'RIFF' && buf.slice(8, 12).toString('ascii') === 'WEBP') {
    const chunk = buf.slice(12, 16).toString('ascii');
    if (chunk === 'VP8X') {
      const w = 1 + (buf[24] | (buf[25] << 8) | (buf[26] << 16));
      const h = 1 + (buf[27] | (buf[28] << 8) | (buf[29] << 16));
      return { width: w, height: h, format: 'webp' };
    }
    if (chunk === 'VP8 ') {
      const w = buf.readUInt16LE(26) & 0x3fff;
      const h = buf.readUInt16LE(28) & 0x3fff;
      return { width: w, height: h, format: 'webp' };
    }
    if (chunk === 'VP8L' && buf.length >= 25) {
      const bits = buf.readUInt32LE(21);
      return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1, format: 'webp' };
    }
    return null;
  }
  return null;
}
