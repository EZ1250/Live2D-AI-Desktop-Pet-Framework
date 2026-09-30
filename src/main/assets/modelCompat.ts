/**
 * modelCompat.ts —— 「这个外部模型能不能渲染」的体检层（普适适配）
 *
 * 背景：用户的模型来自四面八方（不同 Cubism 版本、不同目录结构、只给半套文件），
 * 以前遇到读不了的情况只会落成一张没有信息量的占位卡片。这一层负责在**主进程**里
 * 把每个模型体检一遍，产出人能看懂的原因 + 怎么办，供设置页、启动日志、桌宠窗口共用。
 *
 * 判定依据（全部是文件事实，不依赖渲染层）：
 *   - 描述文件：模型目录（含 3 层子目录）里的 *.model3.json，多个候选时挑最像的那个；
 *   - moc3 版本：读 .moc3 头部 'MOC3' + 版本号（3=4.0 / 4=4.2 / 5=Cubism 5）；
 *   - 运行库能力：直接解析随包的 lib/live2dcubismcore.min.js 里的 MocVersion_* 枚举，
 *     拿到"当前运行库最高能读哪一版"——不写死常量，换了 Core 立刻跟着变；
 *   - 引用完整性：model3.json 里的 Moc / Textures / Physics / Pose / Expressions / Motions
 *     逐个查文件是否真的存在（相对 model3.json 所在目录）。
 *
 * 刻意**不**做的事：不为了"能加载"去改写用户模型的 model3.json（那是用户资产）；
 * 不改目录名；不因为目录里有中文就报警（URL 各段都会 encodeURIComponent，中文是安全的）。
 */
import fs from 'fs';
import path from 'path';
import { app } from 'electron';

export type ModelCompatType = 'moc3' | 'portrait' | 'cubism2' | 'unknown';
export type ModelCompatVerdict = 'ok' | 'warn' | 'unsupported';

export interface ModelCompat {
  /** 实际按哪种方式挂载：moc3=Live2D 骨骼；portrait=静态立绘；cubism2/unknown=挂不了 */
  type: ModelCompatType;
  /** moc3 头部版本号（3=4.0、4=4.2、5=Cubism 5）；非 moc3 为 null */
  mocVersion: number | null;
  /** 当前随包运行库能读的最高 moc3 版本 */
  coreMax: number;
  verdict: ModelCompatVerdict;
  /** 一句话原因（中文，给用户看） */
  reason?: string;
  /** 一句话怎么办（中文，给用户看） */
  action?: string;
  /** 细节：缺哪些文件、有几个候选、命中哪个描述文件…… */
  issues: string[];
  /** 命中的描述文件（相对模型目录，正斜杠） */
  model3?: string;
}

const MODEL3_RE = /\.model3\.json$/i;
const IMAGE_RE = /\.(png|jpe?g|webp|gif|avif)$/i;
const CUBISM2_RE = /(\.moc$|\.model\.json$|\.mtn$|\.physics\.json$|\.pose\.json$)/i;

/** 运行库最高支持的 moc3 版本（解析 core 文件里的 MocVersion_* 枚举；解析不到就按 4 保守处理） */
let cachedCoreMax: number | null = null;
export function coreMaxMocVersion(): number {
  if (cachedCoreMax !== null) return cachedCoreMax;
  const candidates = [
    path.join(app.getAppPath(), 'public', 'renderer', 'lib', 'live2dcubismcore.min.js'),
    path.join(app.getAppPath(), 'dist', 'renderer', 'lib', 'live2dcubismcore.min.js'),
    path.join(app.getAppPath(), 'src', 'renderer', 'lib', 'live2dcubismcore.min.js'),
  ];
  cachedCoreMax = 4; // 保守默认：Cubism 4.2
  for (const file of candidates) {
    try {
      const text = fs.readFileSync(file, 'utf8');
      let max = 0;
      for (const m of text.matchAll(/MocVersion_[A-Za-z0-9_]+=(\d+)/g)) {
        const v = Number(m[1]);
        if (Number.isFinite(v) && v > max) max = v;
      }
      if (max > 0) {
        cachedCoreMax = max;
        break;
      }
    } catch {
      /* 继续找下一个候选路径 */
    }
  }
  return cachedCoreMax;
}

/** 读 moc3 头部版本；不是 moc3 或读不到返回 null */
export function readMocVersion(file: string): number | null {
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const buf = Buffer.alloc(8);
      if (fs.readSync(fd, buf, 0, 8, 0) < 8) return null;
      if (buf[0] !== 0x4d || buf[1] !== 0x4f || buf[2] !== 0x43 || buf[3] !== 0x33) return null;
      const v = buf.readUInt32LE(4);
      return v > 0 && v < 100 ? v : null;
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
}

interface FileRefs {
  Moc?: unknown;
  Textures?: unknown;
  Physics?: unknown;
  Pose?: unknown;
  DisplayInfo?: unknown;
  Expressions?: unknown;
  Motions?: unknown;
}

/** 相对 dir 收集最多 maxDepth 层内的匹配文件（返回**相对 dir** 的路径数组） */
function collect(dir: string, match: (name: string) => boolean, maxDepth: number): string[] {
  const out: string[] = [];
  const walk = (current: string, depth: number): void => {
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(current, e.name);
      if (e.isFile() && match(e.name)) out.push(path.relative(dir, full));
    }
    if (depth < maxDepth) {
      for (const e of entries) {
        if (e.isDirectory()) walk(path.join(current, e.name), depth + 1);
      }
    }
  };
  walk(dir, 0);
  return out;
}

function parseRefs(file: string): FileRefs | null {
  try {
    const doc = JSON.parse(fs.readFileSync(file, 'utf8')) as { FileReferences?: FileRefs } | null;
    return doc && typeof doc === 'object' ? (doc.FileReferences ?? {}) : null;
  } catch {
    return null;
  }
}

function strList(value: unknown): string[] {
  if (typeof value === 'string') return value.trim() ? [value] : [];
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    if (typeof item === 'string' && item.trim()) out.push(item);
    else if (item && typeof item === 'object' && typeof (item as { File?: unknown }).File === 'string') {
      out.push(String((item as { File: string }).File));
    }
  }
  return out;
}

/** 从 model3.json 的 Motions 里挖出所有动作文件路径 */
function motionFiles(motions: unknown): string[] {
  if (!motions || typeof motions !== 'object') return [];
  const out: string[] = [];
  for (const group of Object.values(motions as Record<string, unknown>)) out.push(...strList(group));
  return out;
}

/**
 * 挑描述文件：优先「文件名和目录同名」→「Moc 引用真实存在」→「目录层级最浅」。
 * 一个模型目录里塞多个 .model3.json 是常见的（多皮肤/多版本），不能随便挑第一个。
 */
function pickModel3(dirAbs: string, dirName: string): { rel: string; all: string[] } | null {
  const all = collect(dirAbs, (n) => MODEL3_RE.test(n), 3);
  if (!all.length) return null;
  const score = (rel: string): number => {
    const base = path.basename(rel, path.extname(rel)).toLowerCase();
    const name = dirName.toLowerCase();
    let s = 0;
    if (base === name || base.includes(name) || name.includes(base)) s += 100;
    const refs = parseRefs(path.join(dirAbs, rel));
    const moc = typeof refs?.Moc === 'string' ? refs.Moc : '';
    if (moc && fs.existsSync(path.join(path.dirname(path.join(dirAbs, rel)), moc.split('/').join(path.sep)))) s += 50;
    s -= rel.split(path.sep).length; // 越浅越优先
    return s;
  };
  const sorted = [...all].sort((a, b) => score(b) - score(a) || a.localeCompare(b));
  return { rel: sorted[0], all };
}

/** 体检一个模型目录 */
export function inspectModelDir(dirAbs: string, name?: string): ModelCompat {
  const coreMax = coreMaxMocVersion();
  const dirName = name || path.basename(dirAbs);
  const issues: string[] = [];
  const base: ModelCompat = { type: 'unknown', mocVersion: null, coreMax, verdict: 'unsupported', issues };

  let isDir = false;
  try {
    isDir = fs.statSync(dirAbs).isDirectory();
  } catch {
    /* 不存在 */
  }
  if (!isDir) {
    return { ...base, reason: '模型目录不存在或读不了', action: '检查文件夹是否被移动/删除，重新「＋ 添加模型…」选一次' };
  }

  const picked = pickModel3(dirAbs, dirName);
  const images = collect(dirAbs, (n) => IMAGE_RE.test(n), 3);
  const cubism2 = collect(dirAbs, (n) => CUBISM2_RE.test(n), 3);

  if (!picked) {
    if (images.length) {
      return {
        ...base,
        type: 'portrait',
        verdict: 'ok',
        issues: ['没有 .model3.json，按静态立绘显示'],
      };
    }
    if (cubism2.length) {
      return {
        ...base,
        type: 'cubism2',
        verdict: 'unsupported',
        issues: cubism2.slice(0, 3),
        reason: '这是 Cubism 2 时代的老模型（.moc/.model.json），现在的运行库读不了',
        action: '用 Cubism Editor 打开后重新导出为 .moc3（目标版本 4.2），或换一个 .moc3 模型',
      };
    }
    return {
      ...base,
      reason: '这个文件夹里没有找到模型文件',
      action: '确认选中的是模型**文件夹本身**（里面有 .model3.json 或立绘图片）',
    };
  }

  if (picked.all.length > 1) {
    issues.push(`目录里有 ${picked.all.length} 个 .model3.json，已选 ${picked.rel}（想换的话把别的移出去）`);
  }
  const model3Abs = path.join(dirAbs, picked.rel);
  const dirOfModel3 = path.dirname(model3Abs);
  const refs = parseRefs(model3Abs);
  if (!refs) {
    return {
      ...base,
      model3: rel(picked.rel),
      verdict: 'unsupported',
      issues,
      reason: '模型描述文件（.model3.json）读不了或不是合法 JSON',
      action: '重新解压/拷贝一次这个模型；文件损坏的话从来源重新下载',
    };
  }

  const mocRel = typeof refs.Moc === 'string' ? refs.Moc.trim() : '';
  const mocAbs = mocRel ? path.join(dirOfModel3, mocRel.split('/').join(path.sep)) : '';
  const mocExists = Boolean(mocAbs) && fs.existsSync(mocAbs);
  const textures = strList(refs.Textures);
  const missingTextures = textures.filter((t) => !fs.existsSync(path.join(dirOfModel3, t.split('/').join(path.sep))));

  // 没有真实 Moc → 只能当静态立绘（很多「立绘壳」model3.json 就是这样）
  if (!mocRel || !mocExists) {
    if (images.length) {
      return {
        ...base,
        type: 'portrait',
        model3: rel(picked.rel),
        verdict: 'ok',
        issues: [...issues, mocRel ? `model3.json 声明的 ${mocRel} 不存在，已按静态立绘显示` : 'model3.json 里没有 Moc 引用，已按静态立绘显示'],
      };
    }
    return {
      ...base,
      model3: rel(picked.rel),
      verdict: 'unsupported',
      issues,
      reason: mocRel ? `模型描述里写的 ${mocRel} 不在了` : 'model3.json 里没有指向 .moc3 的引用',
      action: '补齐缺的 .moc3 / 贴图后再放进模型文件夹；或改用静态立绘（只放一张 PNG）',
    };
  }

  const mocVersion = readMocVersion(mocAbs);
  const compat: ModelCompat = { ...base, type: 'moc3', mocVersion, model3: rel(picked.rel), verdict: 'ok' };

  if (missingTextures.length) {
    compat.verdict = 'warn';
    compat.issues.push(`缺 ${missingTextures.length} 张贴图：${missingTextures.slice(0, 2).join('、')}`);
    compat.reason = '贴图没找齐，模型可能显示不全或发白';
    compat.action = '按 model3.json 里的 Textures 列表补齐贴图文件';
    return compat;
  }
  if (mocVersion === null) {
    compat.verdict = 'warn';
    compat.reason = '读不到 moc3 的版本号（文件可能损坏）';
    compat.action = '重新导出/重新解压这个模型；不行就换一个 .moc3';
    return compat;
  }
  if (mocVersion > coreMax) {
    const label = mocVersion >= 5 ? 'Cubism 5' : `moc3 v${mocVersion}`;
    compat.verdict = 'unsupported';
    compat.reason = `这个模型是 ${label} 导出的，随包的运行库最高只认到 Cubism 4.2`;
    compat.action = '两个办法：① 用 Cubism Editor 打开后「导出 → 目标版本 4.2」重新导出；② 把 Live2D 官方 SDK 里的 Core（含 .wasm）交给应用升级运行库';
    compat.issues.push(`moc3 v${mocVersion} > 运行库上限 v${coreMax}`);
    return compat;
  }

  // 非关键文件缺失：能渲染，但告诉用户缺什么（表情/物理/动作最常见）
  const missingOptional: string[] = [];
  const physics = typeof refs.Physics === 'string' ? refs.Physics : '';
  if (physics && !fs.existsSync(path.join(dirOfModel3, physics.split('/').join(path.sep)))) missingOptional.push('物理(physics3.json)');
  const pose = typeof refs.Pose === 'string' ? refs.Pose : '';
  if (pose && !fs.existsSync(path.join(dirOfModel3, pose.split('/').join(path.sep)))) missingOptional.push('姿势(pose3.json)');
  const exprs = strList(refs.Expressions).filter((f) => !fs.existsSync(path.join(dirOfModel3, f.split('/').join(path.sep))));
  if (exprs.length) missingOptional.push(`${exprs.length} 个表情文件`);
  const motions = motionFiles(refs.Motions).filter((f) => !fs.existsSync(path.join(dirOfModel3, f.split('/').join(path.sep))));
  if (motions.length) missingOptional.push(`${motions.length} 个动作文件`);
  if (missingOptional.length) {
    compat.verdict = 'warn';
    compat.issues.push(`缺：${missingOptional.join('、')}`);
    compat.reason = `能显示，但缺 ${missingOptional.join('、')}`;
    compat.action = '缺文件对应的功能会自动降级（没表情就只做呼吸/视线）；想完整就补齐这些文件';
  }
  return compat;
}

function rel(p: string): string {
  return p.split(path.sep).join('/');
}

/** 给日志/设置页用的一行摘要 */
export function describeCompat(name: string, c: ModelCompat): string {
  const type = c.type === 'moc3' ? `Live2D(moc3 v${c.mocVersion ?? '?'})` : c.type === 'portrait' ? '静态立绘' : c.type === 'cubism2' ? 'Cubism 2' : '未知';
  const tail = c.reason ? ` · ${c.reason}` : '';
  return `[模型体检] ${name}：${type} · ${c.verdict}${tail}`;
}
