/**
 * modelSources.ts —— 模型「动作 / 表情 / 参数映射」的通用来源扫描（纯文件逻辑，不依赖 Electron）。
 *
 * 为什么需要：外部模型的导出方式五花八门，动作/表情不一定写在哪：
 *   1. 标准导出：`model3.json` 的 `FileReferences.Motions` / `Expressions`；
 *   2. VTube Studio 导出：注册在 `.vtube.json` 的 `Hotkeys`（model3.json 常为空），
 *      参数映射在 `ParameterSettings`；
 *   3. 半套导出：动作/表情文件就在目录里（`Animation/`、`Exp3/`、`motions/`…），
 *      但 model3.json 和 vtube 都没引用它们。
 *
 * 只读 model3.json 会漏掉 2、3，用户看到的就是"模型能显示、动作/表情/绑定全是空的"。
 * 这个模块把三种来源统一扫成一份清单：
 *   - 主进程用它做能力归类 / 模型体检 / 预设模板（`detectModelCapabilities` 等）；
 *   - 渲染层挂载时用它把 model3 之外的条目补进运行库 settings（经 manifest 下发）。
 *
 * 约定：`file` 一律是**相对 model3.json 所在目录**的正斜杠路径，渲染层按静态资源 URL 直接取。
 */
import * as fs from 'fs';
import * as path from 'path';

export interface ModelMotionSource {
  /** 动作组名（菜单/绑定下拉里显示） */
  group: string;
  /** 相对 model3 目录的路径（正斜杠） */
  file: string;
}

export interface ModelExpressionSource {
  /** 表情名（菜单/绑定下拉里显示） */
  name: string;
  /** 相对 model3 目录的路径（正斜杠） */
  file: string;
}

/** VTS 参数映射行（与渲染层 live2d.ts 里归一化后的形状一致） */
export interface VtsParamRow {
  input: string;
  inLow: number;
  inHigh: number;
  outId: string;
  outLow: number;
  outHigh: number;
  clampInput: boolean;
  clampOutput: boolean;
  smoothing: number;
}

export interface ModelSourcesStats {
  model3Motions: number;
  model3Expressions: number;
  vtsMotions: number;
  vtsExpressions: number;
  vtsParamMappings: number;
  looseMotions: number;
  looseExpressions: number;
  /** 扫到的 .vtube.json（相对模型目录） */
  vtsFiles: string[];
}

export interface ModelSources {
  /** model3.json 没声明的额外动作（vtube 热键 + 目录里的松散文件） */
  motions: ModelMotionSource[];
  /** model3.json 没声明的额外表情 */
  expressions: ModelExpressionSource[];
  /** VTS 参数映射（渲染层自己没读到同名 vtube 时用这份兜底） */
  paramRows: VtsParamRow[];
  stats: ModelSourcesStats;
}

const MOTION_EXT = /\.motion3\.json$/i;
const EXPRESSION_EXT = /\.exp3\.json$/i;
const VTS_EXT = /\.vtube\.json$/i;
const MOTION_DIRS = ['', 'Animation', 'Motions', 'motion', 'motions'];
const EXPRESSION_DIRS = ['', 'Exp3', 'Expressions', 'exp3', 'expressions'];
const MAX_SCAN_DEPTH = 3;
const MAX_LOOSE_FILES = 400;

function readJson(file: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  } catch {
    /* 坏文件不参与扫描 */
  }
  return null;
}

function toPosix(p: string): string {
  return p.split(path.sep).join('/');
}

/** 收集 maxDepth 层内匹配的文件（相对 dirAbs，正斜杠）；跳过隐藏目录 */
function collectFiles(dirAbs: string, match: (name: string) => boolean, maxDepth: number, cap: number): string[] {
  const out: string[] = [];
  const walk = (current: string, depth: number): void => {
    if (out.length >= cap) return;
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (out.length >= cap) return;
      if (e.isFile() && match(e.name)) out.push(toPosix(path.relative(dirAbs, path.join(current, e.name))));
    }
    if (depth >= maxDepth) return;
    for (const e of entries) {
      if (e.isDirectory() && !e.name.startsWith('.')) walk(path.join(current, e.name), depth + 1);
    }
  };
  walk(dirAbs, 0);
  return out;
}

/**
 * 把 vtube / 松散文件里写的文件名解析成「相对 model3 目录」的真实路径。
 * 依次尝试：原样（文件名里可能已带目录）→ 模型目录 → 相对 model3 目录的候选子目录。
 * @returns 命中时返回相对 baseDir 的正斜杠路径，否则 null
 */
function resolveModelFile(
  baseDirAbs: string,
  extraBaseDirs: string[],
  file: string,
  dirs: string[],
): string | null {
  const clean = file.trim().replace(/\\/g, '/').replace(/^\.\//, '');
  if (!clean) return null;
  const candidates: string[] = [];
  if (clean.includes('/')) candidates.push(path.join(baseDirAbs, clean.split('/').join(path.sep)));
  for (const dir of dirs) {
    candidates.push(path.join(baseDirAbs, dir ? path.join(dir, clean.split('/').join(path.sep)) : clean.split('/').join(path.sep)));
  }
  for (const extra of extraBaseDirs) {
    candidates.push(path.join(extra, clean.split('/').join(path.sep)));
    for (const dir of dirs) {
      candidates.push(path.join(extra, dir ? path.join(dir, clean.split('/').join(path.sep)) : clean.split('/').join(path.sep)));
    }
  }
  for (const abs of candidates) {
    try {
      if (fs.statSync(abs).isFile()) {
        const rel = path.relative(baseDirAbs, abs);
        // 不在 model3 目录树内（例如 vtube 引用了模型目录外的文件）时按原文件名回落，避免路径穿越
        if (rel.startsWith('..')) return toPosix(path.basename(abs));
        return toPosix(rel);
      }
    } catch {
      /* 继续试下一个候选 */
    }
  }
  return null;
}

function motionGroupNameFrom(file: string): string {
  return path.basename(file).replace(MOTION_EXT, '').trim() || 'Motion';
}

function expressionNameFrom(file: string): string {
  return path.basename(file).replace(EXPRESSION_EXT, '').trim() || 'Expression';
}

function isIdleName(name: string): boolean {
  return /^(idle|待机|呼吸|standing|default)/i.test(name);
}

/** 按 VTS ParameterSettings 归一化参数映射（规则与渲染层一致：空 Input / 呼吸眨眼 / 缺范围的行跳过） */
export function normalizeVtsParamRows(rows: unknown): VtsParamRow[] {
  if (!Array.isArray(rows)) return [];
  const out: VtsParamRow[] = [];
  for (const entry of rows) {
    if (!entry || typeof entry !== 'object') continue;
    const e = entry as Record<string, unknown>;
    if (typeof e.OutputLive2D !== 'string' || !e.OutputLive2D) continue;
    // Input 为空的是 VTS 自带的呼吸/眨眼等行为，由模型动画负责，不走映射
    if (typeof e.Input !== 'string' || !e.Input) continue;
    if (e.UseBreathing === true || e.UseBlinking === true) continue;
    const inLow = Number(e.InputRangeLower);
    const inHigh = Number(e.InputRangeUpper);
    const outLow = Number(e.OutputRangeLower);
    const outHigh = Number(e.OutputRangeUpper);
    if (![inLow, inHigh, outLow, outHigh].every(Number.isFinite)) continue;
    out.push({
      input: e.Input,
      inLow,
      inHigh,
      outId: e.OutputLive2D,
      outLow,
      outHigh,
      clampInput: e.ClampInput === true,
      clampOutput: e.ClampOutput === true,
      smoothing: Number(e.Smoothing) || 0,
    });
  }
  return out;
}

/**
 * 扫描一个模型目录里所有可用的动作/表情/参数映射。
 * @param modelDirAbs 模型目录绝对路径
 * @param model3Rel   `.model3.json` 相对模型目录的路径（正斜杠）
 */
export function scanModelSources(modelDirAbs: string, model3Rel: string): ModelSources {
  const emptyStats: ModelSourcesStats = {
    model3Motions: 0,
    model3Expressions: 0,
    vtsMotions: 0,
    vtsExpressions: 0,
    vtsParamMappings: 0,
    looseMotions: 0,
    looseExpressions: 0,
    vtsFiles: [],
  };
  const model3Posix = toPosix(model3Rel);
  const model3Abs = path.join(modelDirAbs, model3Posix.split('/').join(path.sep));
  const baseDirAbs = path.dirname(model3Abs);
  const model3 = readJson(model3Abs);
  if (!model3) return { motions: [], expressions: [], paramRows: [], stats: emptyStats };

  const refs = (model3.FileReferences && typeof model3.FileReferences === 'object'
    ? model3.FileReferences
    : {}) as Record<string, unknown>;
  const model3Motions = (refs.Motions && typeof refs.Motions === 'object' && !Array.isArray(refs.Motions)
    ? refs.Motions
    : {}) as Record<string, unknown>;
  const model3Expressions = Array.isArray(refs.Expressions) ? (refs.Expressions as Array<Record<string, unknown>>) : [];

  const groups = new Set<string>(Object.keys(model3Motions).filter((g) => g.trim()));
  const expressionNames = new Set<string>();
  /** 已被 model3 / vtube 用掉的资源文件（相对 baseDir），用于去重 */
  const usedFiles = new Set<string>();

  for (const list of Object.values(model3Motions)) {
    if (!Array.isArray(list)) continue;
    for (const item of list) {
      const file = item && typeof item === 'object' ? (item as Record<string, unknown>).File : undefined;
      if (typeof file === 'string' && file.trim()) {
        const rel = toPosix(path.normalize(file.trim().replace(/\\/g, '/')));
        usedFiles.add(rel);
      }
    }
  }
  for (const e of model3Expressions) {
    if (e && typeof e.Name === 'string' && e.Name.trim()) expressionNames.add(e.Name.trim());
    const file = e && typeof e === 'object' ? e.File : undefined;
    if (typeof file === 'string' && file.trim()) usedFiles.add(toPosix(path.normalize(file.trim().replace(/\\/g, '/'))));
  }

  const motions: ModelMotionSource[] = [];
  const expressions: ModelExpressionSource[] = [];
  const uniqueGroup = (raw: string): string => {
    const base = raw.trim() || 'Motion';
    if (!groups.has(base)) return base;
    let i = 2;
    while (groups.has(`${base} (${i})`)) i += 1;
    return `${base} (${i})`;
  };
  const uniqueExpression = (raw: string): string => {
    const base = raw.trim() || 'Expression';
    if (!expressionNames.has(base)) return base;
    let i = 2;
    while (expressionNames.has(`${base} (${i})`)) i += 1;
    return `${base} (${i})`;
  };
  const addMotion = (group: string, rel: string, bucket: 'vts' | 'loose'): void => {
    if (usedFiles.has(rel)) return;
    const finalGroup = uniqueGroup(group);
    groups.add(finalGroup);
    usedFiles.add(rel);
    motions.push({ group: finalGroup, file: rel });
    if (bucket === 'vts') emptyStats.vtsMotions += 1;
    else emptyStats.looseMotions += 1;
  };
  const addExpression = (name: string, rel: string, bucket: 'vts' | 'loose'): void => {
    if (usedFiles.has(rel)) return;
    const finalName = uniqueExpression(name);
    expressionNames.add(finalName);
    usedFiles.add(rel);
    expressions.push({ name: finalName, file: rel });
    if (bucket === 'vts') emptyStats.vtsExpressions += 1;
    else emptyStats.looseExpressions += 1;
  };

  // ① .vtube.json：Hotkeys 里的表情/动作；优先与 model3 同名的文件（渲染层也按同名找）
  const model3Base = path.basename(model3Abs).replace(/\.model3\.json$/i, '');
  const vtsCandidates = collectFiles(modelDirAbs, (n) => VTS_EXT.test(n), MAX_SCAN_DEPTH, 50);
  const sameName = vtsCandidates.filter((rel) => {
    const base = path.basename(rel).replace(/\.vtube\.json$/i, '');
    return base.toLowerCase() === model3Base.toLowerCase();
  });
  const vtsOrdered = [...sameName, ...vtsCandidates.filter((rel) => !sameName.includes(rel))];
  emptyStats.vtsFiles = vtsOrdered;
  let paramRows: VtsParamRow[] = [];
  for (const vtsRel of vtsOrdered) {
    const vtsAbs = path.join(modelDirAbs, vtsRel.split('/').join(path.sep));
    const vjson = readJson(vtsAbs);
    if (!vjson) continue;
    const vtsDirAbs = path.dirname(vtsAbs);
    const extraBaseDirs = vtsDirAbs === baseDirAbs ? [] : [vtsDirAbs];
    const hotkeys = Array.isArray(vjson.Hotkeys) ? (vjson.Hotkeys as Array<Record<string, unknown>>) : [];
    for (const h of hotkeys) {
      if (!h || typeof h !== 'object') continue;
      if (h.IsActive === false) continue;
      const file = typeof h.File === 'string' ? h.File : '';
      if (!file.trim()) continue;
      const action = typeof h.Action === 'string' ? h.Action : '';
      const name = typeof h.Name === 'string' && h.Name.trim() ? h.Name.trim() : '';
      if (action === 'ToggleExpression') {
        const rel = resolveModelFile(baseDirAbs, extraBaseDirs, file, EXPRESSION_DIRS);
        if (rel) addExpression(name || expressionNameFrom(rel), rel, 'vts');
      } else if (action === 'TriggerAnimation') {
        const rel = resolveModelFile(baseDirAbs, extraBaseDirs, file, MOTION_DIRS);
        if (rel) addMotion(name || motionGroupNameFrom(rel), rel, 'vts');
      } else if (action === 'ChangeIdleAnimation') {
        const rel = resolveModelFile(baseDirAbs, extraBaseDirs, file, MOTION_DIRS);
        if (!rel) continue;
        let seq = 1;
        while (groups.has(`Idle${seq}`)) seq += 1;
        addMotion(`Idle${seq}`, rel, 'vts');
      }
    }
    if (!paramRows.length) paramRows = normalizeVtsParamRows(vjson.ParameterSettings);
  }
  emptyStats.vtsParamMappings = paramRows.length;

  // ② 目录里的松散动作/表情文件（model3 与 vtube 都没引用的）
  const looseMotions = collectFiles(baseDirAbs, (n) => MOTION_EXT.test(n), MAX_SCAN_DEPTH, MAX_LOOSE_FILES);
  for (const rel of looseMotions) {
    if (usedFiles.has(rel)) continue;
    const guess = motionGroupNameFrom(rel);
    // 松散待机文件（IDLE.motion3.json 之类）优先归到 Idle；已被占用就按文件名成组
    const group = isIdleName(guess) && !groups.has('Idle') ? 'Idle' : guess;
    addMotion(group, rel, 'loose');
  }
  const looseExpressions = collectFiles(baseDirAbs, (n) => EXPRESSION_EXT.test(n), MAX_SCAN_DEPTH, MAX_LOOSE_FILES);
  for (const rel of looseExpressions) {
    if (usedFiles.has(rel)) continue;
    addExpression(expressionNameFrom(rel), rel, 'loose');
  }

  return {
    motions,
    expressions,
    paramRows,
    stats: {
      ...emptyStats,
      model3Motions: groups.size - emptyStats.vtsMotions - emptyStats.looseMotions,
      model3Expressions: expressionNames.size - emptyStats.vtsExpressions - emptyStats.looseExpressions,
    },
  };
}
