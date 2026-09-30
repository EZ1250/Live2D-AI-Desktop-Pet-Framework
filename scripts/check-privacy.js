#!/usr/bin/env node
/**
 * scripts/check-privacy.js —— 打包隐私闸门（fail-closed）
 *
 * 目标：**个人隐私配置绝不进主包**（app.asar / resources/assets / resources/renderer / 便携 exe）。
 * 本机个人数据只允许待在 %APPDATA%\pet-desktop-app\ 下的 userData 里：settings.json（含 API Key）、
 * chat-log.json（聊天记录）、pet-tools.json（待办/笔记）、memory.md（长期偏好）。
 *
 * 检查两类东西：
 *   A. 打包输入/产物里**不允许出现的文件名**（配置文件、密钥、证书、数据库、日志…）；
 *   B. 打包输入/产物文本里**不允许出现的密钥样式**，以及"本机用户的实际 API Key / 用户名路径"。
 *
 * 用法：
 *   node scripts/check-privacy.js --inputs          # 打包前扫 dist/ public/ local-assets/ package.json
 *   node scripts/check-privacy.js --packed <目录>   # 打包后扫 release/win-unpacked（含 app.asar 二进制）
 *   node scripts/check-privacy.js --all             # 两者都扫（本地自查用）
 *
 * 退出码：0 干净；1 发现违规（build-portable 会据此中止打包）。
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const USER_DATA = path.join(os.homedir(), 'AppData', 'Roaming', 'pet-desktop-app');

/** A. 禁止进包的文件名（小写比对；可用 `*` 通配） */
const FORBIDDEN_NAMES = [
  'settings.json',
  'chat-log.json',
  'pet-tools.json',
  'memory.md',
  'agents.md',
  'pet.md',
  'claude.md',
  '.env',
  '.env.*',
  '*.key',
  '*.pem',
  '*.pfx',
  '*.p12',
  'id_rsa*',
  'id_ed25519*',
  '*apikey*',
  '*api_key*',
  '*secret*',
  '*token*',
  '密钥*',
  '*密钥*',
  '*.cookies',
  'cookies*',
  'sharedstorage',
  'preferences',
  'local state',
  'devtoolsactiveport',
  '*.sqlite',
  '*.db',
  '*.log',
];
/** 允许例外（同名但确实属于产品资源） */
const ALLOWED_NAMES = new Set(['models.json', 'package.json', 'tsconfig.json', 'package-lock.json', 'model-order.json']);

/** B. 密钥样式（正则） */
const SECRET_PATTERNS = [
  { name: 'sk- 形密钥', re: /sk-[A-Za-z0-9_-]{24,}/ },
  { name: 'Bearer 明文令牌', re: /Bearer\s+[A-Za-z0-9._-]{24,}/ },
  { name: 'aiApiKey 明文', re: /"?(?:ai)?api[_-]?key"?\s*[:=]\s*["'][A-Za-z0-9_\-.]{16,}["']/i },
  { name: 'password/secret 明文', re: /(?:password|secret|access[_-]?token)\s*[:=]\s*["'][^\s"']{12,}["']/i },
];

/** 只扫文本文件；超过这个大小跳过（避免读大二进制/模型文件） */
const MAX_TEXT_BYTES = 4 * 1024 * 1024;
const TEXT_EXT = new Set([
  '.js', '.mjs', '.cjs', '.ts', '.json', '.html', '.css', '.md', '.txt', '.yml', '.yaml',
  '.ps1', '.bat', '.cmd', '.xml', '.svg', '.map',
]);

const problems = [];
const warnings = [];
let scanned = 0;

function matchesAny(name, globs) {
  const n = name.toLowerCase();
  return globs.some((g) => {
    if (!g.includes('*')) return n === g;
    const re = new RegExp('^' + g.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$');
    return re.test(n);
  });
}

function checkFileName(rel) {
  const base = path.basename(rel);
  if (ALLOWED_NAMES.has(base.toLowerCase())) return;
  if (matchesAny(base, FORBIDDEN_NAMES)) {
    problems.push(`禁止进包的文件：${rel}（个人配置/密钥类文件只能待在 userData）`);
  }
}

function checkText(rel, text, liveKey, userName) {
  for (const p of SECRET_PATTERNS) {
    const m = text.match(p.re);
    if (m) problems.push(`疑似密钥进包（${p.name}）：${rel} → ${m[0].slice(0, 24)}…`);
  }
  if (liveKey && liveKey.length >= 16 && text.includes(liveKey)) {
    problems.push(`★ 本机真实 API Key 进包了：${rel}`);
  }
  if (userName && new RegExp(`[A-Za-z]:\\\\Users\\\\${userName}\\\\`, 'i').test(text)) {
    problems.push(`打包内容里含本机用户绝对路径（会泄露用户名）：${rel}`);
  }
}

function walk(dir, onFile) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const ent of entries) {
    const abs = path.join(dir, ent.name);
    if (ent.isDirectory()) walk(abs, onFile);
    else if (ent.isFile()) onFile(abs);
  }
}

function readLiveKey() {
  try {
    // 用户可能用记事本另存成 UTF-8 with BOM：先剥掉 BOM，否则 JSON.parse 直接失败、比对会静默失效
    const raw = fs.readFileSync(path.join(USER_DATA, 'settings.json'), 'utf8').replace(/^\uFEFF/, '');
    const parsed = JSON.parse(raw);
    const key = parsed?.ai?.aiApiKey || parsed?.aiApiKey || '';
    return typeof key === 'string' ? key.trim() : '';
  } catch {
    return '';
  }
}

function scanInputs(liveKey, userName) {
  const targets = [path.join(ROOT, 'dist'), path.join(ROOT, 'public'), path.join(ROOT, 'local-assets')];
  console.log('[privacy] 扫描打包输入：dist/ public/ local-assets/ + package.json');
  for (const dir of targets) {
    walk(dir, (abs) => {
      const rel = path.relative(ROOT, abs).split(path.sep).join('/');
      scanned++;
      checkFileName(rel);
      const ext = path.extname(abs).toLowerCase();
      if (!TEXT_EXT.has(ext)) return;
      try {
        if (fs.statSync(abs).size > MAX_TEXT_BYTES) return;
        checkText(rel, fs.readFileSync(abs, 'utf8'), liveKey, userName);
      } catch {
        /* 读不了就跳过（二进制等） */
      }
    });
  }
  const pkg = path.join(ROOT, 'package.json');
  if (fs.existsSync(pkg)) {
    scanned++;
    checkFileName('package.json');
    checkText('package.json', fs.readFileSync(pkg, 'utf8'), liveKey, userName);
  }
}

function scanPacked(dirAbs, liveKey, userName) {
  console.log(`[privacy] 扫描打包产物：${dirAbs}`);
  if (!fs.existsSync(dirAbs)) {
    warnings.push(`产物目录不存在（跳过）：${dirAbs}`);
    return;
  }
  walk(dirAbs, (abs) => {
    const rel = path.relative(ROOT, abs).split(path.sep).join('/');
    scanned++;
    checkFileName(rel);
    const ext = path.extname(abs).toLowerCase();
    // app.asar 当二进制整体扫（asar 不压缩，明文密钥一定搜得到）
    const isAsar = ext === '.asar';
    if (!isAsar && !TEXT_EXT.has(ext)) return;
    try {
      if (fs.statSync(abs).size > 64 * 1024 * 1024) return;
      checkText(rel, fs.readFileSync(abs, 'utf8'), liveKey, userName);
    } catch {
      /* 二进制按 utf8 读会得到替换字符，正则仍能命中 ASCII 密钥 */
    }
  });
}

function main() {
  const argv = process.argv.slice(2);
  const liveKey = readLiveKey();
  const userName = (os.userInfo().username || '').trim();
  console.log(`[privacy] userData=${USER_DATA}（本机真实 Key ${liveKey ? '已读取，将用于比对' : '未读取到'}）`);

  const wantAll = argv.includes('--all') || argv.length === 0;
  if (wantAll || argv.includes('--inputs')) scanInputs(liveKey, userName);
  const packedIdx = argv.indexOf('--packed');
  if (packedIdx >= 0 && argv[packedIdx + 1]) scanPacked(path.resolve(argv[packedIdx + 1]), liveKey, userName);
  if (wantAll && packedIdx < 0) {
    for (const cand of ['release/win-unpacked', 'release/win-unpacked/resources']) {
      const p = path.join(ROOT, cand);
      if (fs.existsSync(p)) {
        scanPacked(p, liveKey, userName);
        break;
      }
    }
  }

  for (const w of [...new Set(warnings)]) console.warn(`[privacy] 警告：${w}`);
  const uniq = [...new Set(problems)];
  if (uniq.length) {
    console.error(`\n[privacy] ✗ 发现 ${uniq.length} 项隐私风险（共扫描 ${scanned} 个文件）——已中止打包：`);
    for (const p of uniq) console.error(`  - ${p}`);
    console.error('\n处理办法：把个人配置移出打包目录（正确位置是 %APPDATA%\\pet-desktop-app\\），');
    console.error('          或在 electron-builder.yml 的 files/extraResources 里排除它。');
    process.exit(1);
  }
  console.log(`[privacy] ✓ 未发现隐私文件/密钥进包（扫描 ${scanned} 个文件）`);
}

main();
