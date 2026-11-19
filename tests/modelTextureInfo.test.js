/**
 * 纹理降采样单测：文件头尺寸解析 + 精度归一化 + 缓存 key。
 */
'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const info = require(path.join(__dirname, '..', 'dist', 'main', 'modelTextureInfo.js'));
const { normalizeTextureMax, sanitizeCacheKey, readImageInfo } = info;

describe('normalizeTextureMax', () => {
  it('defaults to 4096 and keeps 0 as original', () => {
    assert.equal(normalizeTextureMax(undefined), 4096);
    assert.equal(normalizeTextureMax(0), 0);
    assert.equal(normalizeTextureMax(1024), 1024);
    assert.equal(normalizeTextureMax(8192), 8192);
    assert.equal(normalizeTextureMax(99999), 8192);
    assert.equal(normalizeTextureMax(10), 256);
  });
});

describe('sanitizeCacheKey', () => {
  it('keeps chinese/word chars and strips path separators', () => {
    assert.equal(sanitizeCacheKey('神宫白子'), '神宫白子');
    assert.equal(sanitizeCacheKey('a/b\\c:d*e'), 'a_b_c_d_e');
    assert.equal(sanitizeCacheKey(''), 'model');
  });
});

describe('readImageInfo', () => {
  it('parses PNG dimensions', () => {
    // 1x1 PNG
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
      'base64',
    );
    assert.deepEqual(readImageInfo(png), { width: 1, height: 1, format: 'png' });
  });

  it('parses GIF dimensions', () => {
    const gif = Buffer.concat([
      Buffer.from('GIF89a', 'ascii'),
      Buffer.from([0x40, 0x01, 0xf0, 0x00]), // 320x240 little-endian
      Buffer.alloc(20),
    ]);
    assert.deepEqual(readImageInfo(gif), { width: 320, height: 240, format: 'gif' });
  });

  it('parses WebP (VP8X) dimensions', () => {
    const buf = Buffer.alloc(40);
    Buffer.from('RIFF', 'ascii').copy(buf, 0);
    buf.writeUInt32LE(32, 4);
    Buffer.from('WEBP', 'ascii').copy(buf, 8);
    Buffer.from('VP8X', 'ascii').copy(buf, 12);
    buf.writeUInt32LE(10, 16);
    // 宽-1 = 2047 → 2048；高-1 = 1023 → 1024
    buf[24] = 0xff;
    buf[25] = 0x07;
    buf[26] = 0x00;
    buf[27] = 0xff;
    buf[28] = 0x03;
    buf[29] = 0x00;
    assert.deepEqual(readImageInfo(buf), { width: 2048, height: 1024, format: 'webp' });
  });

  it('parses JPEG SOF dimensions', () => {
    // 构造一个最小的 JPEG 头：SOI + APP0(跳过) + SOF0(1080x1920)
    const app0 = Buffer.from([0xff, 0xe0, 0x00, 0x04, 0x00, 0x00]);
    const sof = Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08, 0x04, 0x38, 0x07, 0x80, 0x03, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);
    const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof, Buffer.alloc(10)]);
    assert.deepEqual(readImageInfo(jpeg), { width: 1920, height: 1080, format: 'jpeg' });
  });

  it('returns null for non-images/garbage', () => {
    assert.equal(readImageInfo(Buffer.from('hello world')), null);
    assert.equal(readImageInfo(Buffer.alloc(0)), null);
  });
});
