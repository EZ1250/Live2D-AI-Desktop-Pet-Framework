/**
 * userAssets.ts —— 可插拔资产注册表（Live2D 模型 + 插件共用一套）
 *
 * 设计目标（用户明确要求）：
 *  - 模型和插件都是"可加入/可移除的外部资产"，不再让用户在设置里手打路径；
 *  - 加入方式统一为：**点按钮打开对应文件夹** → 把东西放进去（或选一个现成文件夹）→ 应用自动扫描；
 *  - 每一个资产都要能给出**说得清的错误报告**（缺什么文件、版本不支持、语法错误在第几行）；
 *  - 全部落在 userData 下，**绝不会进打包产物**（配合 scripts/check-privacy.js 的构建期闸门）。
 *
 * 目录：
 *   %APPDATA%/pet-desktop-app/live2d-models/<名字>/     用户模型（放进文件夹即生效）
 *   %APPDATA%/pet-desktop-app/plugins/<名字>/           用户插件（需带 pet-plugin.json）
 *   %APPDATA%/pet-desktop-app/assets.user.json          外部路径注册表（模型/插件可以放在别处，登记后照样能用）
 */
import * as fs from 'fs';
import * as path from 'path';
import * as vm from 'vm';
import { app, shell } from 'electron';
import { inspectModelDir, type ModelCompat } from './modelCompat';

export type AssetKind = 'model' | 'plugin';

/** 一个用户模型的扫描结果（issues 为空 = 可用） */
export interface UserModelEntry {
  name: string;
  dir: string;
  /** moc3=真 Live2D；portrait=静态立绘；unknown=识别不了 */
  kind: 'moc3' | 'portrait' | 'unknown';
  /** 人类可读的问题清单（空数组=OK） */
  issues: string[];
  /** Cubism moc3 版本（3/4/5…）；拿不到为 null */
  mocVersion: number | null;
  /** 模型体检结果（能不能渲染 / 为什么 / 怎么办）——外部模型普适适配的落点 */
  compat: ModelCompat;
  /** 是否是"登记在别处的外部目录" */
  external: boolean;
  sizeMb: number;
}

/** 一个用户插件的扫描结果 */
export interface UserPluginEntry {
  name: string;
  dir: string;
  entry: string;
  version: string;
  description: string;
  issues: string[];
  external: boolean;
}

interface Registry {
  models: Array<{ name: string; dir: string }>;
  plugins: Array<{ name: string; dir: string }>;
}

// ------------------------------------------------------------------ 目录与注册表

export function userDataRoot(): string {
  return app.getPath('userData');
}

function ensureDir(dir: string): string {
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    /* 已存在/无权限：交给后续读写报错 */
  }
  return dir;
}

/** 用户模型目录：把模型文件夹丢进来就自动生效 */
export function userModelsDir(): string {
  return ensureDir(path.join(userDataRoot(), 'live2d-models'));
}

/** 用户插件目录 */
export function userPluginsDir(): string {
  return ensureDir(path.join(userDataRoot(), 'plugins'));
}

export function assetDir(kind: AssetKind): string {
  return kind === 'model' ? userModelsDir() : userPluginsDir();
}

/**
 * 模型预设（pet-model.json）的用户级目录。
 * 为什么放 userData 而不是模型目录：**随包模型目录是只读的**（打包后在 app.asar/resources 里），
 * 用户不可能往里写文件；把预设放 userData 后，内置模型也能被用户自定义（且不进包、符合隐私约定）。
 * 优先级：userData/live2d-presets/<模型名>.json > 模型目录里的 pet-model.json。
 */
export function userPresetsDir(): string {
  return ensureDir(path.join(userDataRoot(), 'live2d-presets'));
}

/** 某个模型的用户级预设文件路径（不一定存在） */
export function userPresetFile(modelName: string): string {
  const safe = path.basename(modelName || '').replace(/[\\/:*?"<>|]/g, '_');
  return path.join(userPresetsDir(), `${safe}.json`);
}

function registryFile(): string {
  return path.join(userDataRoot(), 'assets.user.json');
}

function readRegistry(): Registry {
  try {
    const raw = JSON.parse(fs.readFileSync(registryFile(), 'utf8').replace(/^\uFEFF/, '')) as Partial<Registry>;
    return {
      models: Array.isArray(raw?.models) ? raw!.models.filter((m) => m && typeof m.dir === 'string' && m.dir) : [],
      plugins: Array.isArray(raw?.plugins) ? raw!.plugins.filter((p) => p && typeof p.dir === 'string' && p.dir) : [],
    };
  } catch {
    return { models: [], plugins: [] };
  }
}

function writeRegistry(reg: Registry): void {
  try {
    fs.writeFileSync(registryFile(), JSON.stringify(reg, null, 2), 'utf8');
  } catch (err) {
    console.warn('[userAssets] 写入注册表失败：', (err as Error).message);
  }
}

function rememberExternal(kind: AssetKind, name: string, dir: string): void {
  const reg = readRegistry();
  const list = kind === 'model' ? reg.models : reg.plugins;
  if (!list.some((it) => path.resolve(it.dir).toLowerCase() === path.resolve(dir).toLowerCase())) {
    list.push({ name, dir });
    writeRegistry(reg);
  }
}

function forgetExternal(kind: AssetKind, dir: string): void {
  const reg = readRegistry();
  const key = kind === 'model' ? 'models' : 'plugins';
  const next = reg[key].filter((it) => path.resolve(it.dir).toLowerCase() !== path.resolve(dir).toLowerCase());
  if (next.length !== reg[key].length) {
    reg[key] = next;
    writeRegistry(reg);
  }
}

// ------------------------------------------------------------------ 通用小工具

function readJson(file: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    return null;
  }
}

/** 在 dir 下（最多 2 层）找第一个匹配的文件，返回相对路径（正斜杠） */
function findFile(dir: string, test: (name: string) => boolean, depth = 2): string | null {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  const dirs: string[] = [];
  for (const e of entries) {
    if (e.isFile() && test(e.name)) return e.name;
    if (e.isDirectory()) dirs.push(e.name);
  }
  if (depth <= 1) return null;
  for (const d of dirs) {
    const sub = findFile(path.join(dir, d), test, depth - 1);
    if (sub) return `${d}/${sub}`;
  }
  return null;
}

function dirSizeBytes(dir: string): number {
  let total = 0;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    try {
      if (e.isDirectory()) total += dirSizeBytes(p);
      else total += fs.statSync(p).size;
    } catch {
      /* 忽略读不到的项 */
    }
  }
  return total;
}

/**
 * moc3 版本：文件头是 'MOC3' + 1 字节版本号。
 * cubism4 运行时只支持 3/4；Cubism 5 的模型加载会失败，这里提前判出来给用户看，
 * 而不是等渲染层落到占位卡片。
 */
function readMoc3Version(mocAbs: string): number | null {
  try {
    const fd = fs.openSync(mocAbs, 'r');
    const buf = Buffer.alloc(5);
    fs.readSync(fd, buf, 0, 5, 0);
    fs.closeSync(fd);
    if (buf.slice(0, 4).toString('latin1') !== 'MOC3') return null;
    return buf[4];
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------ 模型校验

const IMAGE_EXT = /\.(png|jpe?g|webp|gif)$/i;

/** 校验一个模型目录；返回可读的问题清单（空=可用） */
export function validateModelDir(dir: string): UserModelEntry {
  const name = path.basename(dir);
  const issues: string[] = [];
  // 先体检：目录不存在 / 只有图片 / Cubism 2 / moc3 版本超出运行库 / 引用文件缺失，
  // 全部由 modelCompat 给出「原因 + 怎么办」，下面的细节检查只做补充（不再自己写死版本号）。
  const compat = inspectModelDir(dir, name);
  const entry: UserModelEntry = {
    name,
    dir,
    kind: 'unknown',
    issues,
    mocVersion: compat.mocVersion,
    compat,
    external: true,
    sizeMb: Math.round((dirSizeBytes(dir) / 1024 / 1024) * 10) / 10,
  };
  if (compat.verdict !== 'ok') {
    if (compat.reason) issues.push(compat.reason);
    // 版本过高时给出可执行建议；其它情况 compat.issues 里已经有细节
    if (compat.verdict === 'unsupported' && compat.action) issues.push(`怎么办：${compat.action}`);
  }
  for (const extra of compat.issues) {
    if (!issues.includes(extra)) issues.push(extra);
  }

  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    issues.push('目录不存在或不是文件夹');
    return entry;
  }

  const model3Rel = findFile(dir, (n) => /\.model3\.json$/i.test(n));
  const imgRel = findFile(dir, (n) => IMAGE_EXT.test(n));

  if (!model3Rel) {
    if (imgRel) {
      entry.kind = 'portrait';
      issues.push('没有 .model3.json，将按静态立绘（portrait）显示');
      return entry;
    }
    issues.push('不是模型目录：既没有 *.model3.json，也没有立绘图片（png/jpg/webp/gif）');
    return entry;
  }

  const model3Abs = path.join(dir, model3Rel.split('/').join(path.sep));
  const json = readJson(model3Abs) as
    | { FileReferences?: { Moc?: unknown; Textures?: unknown; Physics?: unknown; Expressions?: unknown; Motions?: unknown } }
    | null;
  if (!json || typeof json !== 'object') {
    issues.push(`${model3Rel} 不是合法 JSON（可能文件损坏或被编辑器改坏）`);
    return entry;
  }
  const refs = json.FileReferences ?? {};
  const moc = typeof refs.Moc === 'string' ? refs.Moc : '';
  if (!moc) {
    // 只有描述没有 Moc：可能是"立绘壳"
    if (imgRel) {
      entry.kind = 'portrait';
      issues.push('.model3.json 里没有 FileReferences.Moc（无 Live2D 主体），按立绘显示');
      return entry;
    }
    issues.push('.model3.json 里缺少 FileReferences.Moc（模型主体），无法作为 Live2D 加载');
    return entry;
  }

  entry.kind = 'moc3';
  const baseDir = path.dirname(model3Abs);
  const mocAbs = path.resolve(baseDir, moc);
  if (!fs.existsSync(mocAbs)) {
    issues.push(`缺少模型主体文件：${moc}（.model3.json 指向它，但文件不在）`);
  } else {
    entry.mocVersion = readMoc3Version(mocAbs);
    if (entry.mocVersion === null) {
      issues.push(`${path.basename(mocAbs)} 不是有效的 moc3 文件（缺少 MOC3 文件头）`);
    } else if (entry.mocVersion > compat.coreMax) {
      // 版本上限来自随包运行库自身的 MocVersion 枚举（见 modelCompat.coreMaxMocVersion），
      // 换 Core 后自动跟着变，不再是写死的 Set([3,4])。
      issues.push(
        `该模型是 Cubism ${entry.mocVersion} 导出，随包运行库最高认到 Cubism 4.2（moc3 v${compat.coreMax}）—— 会显示为占位卡片`
      );
    }
  }

  const textures = Array.isArray(refs.Textures) ? refs.Textures.filter((t): t is string => typeof t === 'string') : [];
  if (textures.length === 0) {
    issues.push('没有声明任何纹理（FileReferences.Textures 为空）—— 模型会显示不出画面');
  } else {
    const missing = textures.filter((t) => !fs.existsSync(path.resolve(baseDir, t)));
    if (missing.length) {
      issues.push(`缺少 ${missing.length}/${textures.length} 张纹理：${missing.slice(0, 3).join('、')}${missing.length > 3 ? '…' : ''}`);
    }
  }
  if (!refs.Physics) issues.push('提示：没有物理文件（.physics3.json），头发/衣物不会摆动');
  const expCount = Array.isArray(refs.Expressions) ? refs.Expressions.length : 0;
  const motionGroups = refs.Motions && typeof refs.Motions === 'object' ? Object.keys(refs.Motions as object) : [];
  if (expCount === 0) issues.push('提示：该模型没有表情（Expressions），表情切换会无效');
  if (motionGroups.length === 0) issues.push('提示：该模型没有动作（Motions），动作菜单会无效');
  else if (!motionGroups.some((g) => /^idle$/i.test(g))) issues.push('提示：没有 Idle 动作组，待机时会用内置呼吸动画');

  return entry;
}

// ------------------------------------------------------------------ 插件校验

/** 插件清单文件名（放在插件目录里） */
export const PLUGIN_MANIFEST = 'pet-plugin.json';

export function validatePluginDir(dir: string): UserPluginEntry {
  const fallbackName = path.basename(dir);
  const entry: UserPluginEntry = {
    name: fallbackName,
    dir,
    entry: '',
    version: '',
    description: '',
    issues: [],
    external: true,
  };
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    entry.issues.push('目录不存在或不是文件夹');
    return entry;
  }

  const manifestAbs = path.join(dir, PLUGIN_MANIFEST);
  let manifest: Record<string, unknown> | null = null;
  if (fs.existsSync(manifestAbs)) {
    const parsed = readJson(manifestAbs);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      entry.issues.push(`${PLUGIN_MANIFEST} 不是合法 JSON（应是 {name, version, entry, description?}）`);
      return entry;
    }
    manifest = parsed as Record<string, unknown>;
  } else {
    entry.issues.push(`缺少 ${PLUGIN_MANIFEST}（插件目录里必须有这个清单：name / version / entry）`);
  }

  if (manifest) {
    const str = (key: string): string => (typeof manifest![key] === 'string' ? String(manifest![key]).trim() : '');
    const name = str('name');
    const version = str('version');
    const describe = str('description');
    const entryRel = str('entry');
    if (name) entry.name = name;
    else entry.issues.push(`${PLUGIN_MANIFEST} 缺少 name`);
    if (version) entry.version = version;
    else entry.issues.push(`${PLUGIN_MANIFEST} 缺少 version`);
    if (describe) entry.description = describe;
    if (entryRel) entry.entry = entryRel;
    else entry.issues.push(`${PLUGIN_MANIFEST} 缺少 entry（入口脚本相对路径，如 index.js）`);
  }

  // 入口文件：清单没写就找 index.js
  const entryRel = entry.entry || (fs.existsSync(path.join(dir, 'index.js')) ? 'index.js' : '');
  if (!entryRel) {
    entry.issues.push('找不到入口脚本（清单没写 entry，目录里也没有 index.js）');
    return entry;
  }
  const entryAbs = path.resolve(dir, entryRel);
  const rel = path.relative(dir, entryAbs);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    entry.issues.push(`entry 不能指向插件目录之外：${entryRel}`);
    return entry;
  }
  if (!fs.existsSync(entryAbs)) {
    entry.issues.push(`入口脚本不存在：${entryRel}`);
    return entry;
  }
  entry.entry = entryRel.split(path.sep).join('/');

  // 语法检查（只解析不执行）：比 require() 安全，又能精确报出第几行错
  try {
    const source = fs.readFileSync(entryAbs, 'utf8');
    // eslint-disable-next-line no-new
    new vm.Script(source, { filename: entryAbs });
  } catch (err) {
    entry.issues.push(`入口脚本语法错误：${(err as Error).message.split('\n')[0]}`);
  }
  return entry;
}

// ------------------------------------------------------------------ 扫描 / 注册 / 移除

/** 列出所有用户模型：userData 目录扫描 + 外部路径注册表 */
export function listUserModels(): UserModelEntry[] {
  const out: UserModelEntry[] = [];
  const seen = new Set<string>();
  const push = (dir: string, external: boolean): void => {
    const key = path.resolve(dir).toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    if (!fs.existsSync(dir)) return;
    const item = validateModelDir(dir);
    item.external = external;
    out.push(item);
  };
  for (const ent of fs.existsSync(userModelsDir()) ? fs.readdirSync(userModelsDir(), { withFileTypes: true }) : []) {
    if (ent.isDirectory()) push(path.join(userModelsDir(), ent.name), false);
  }
  for (const reg of readRegistry().models) push(reg.dir, true);
  // 顺序：优先 `.order.json`（迁移时按原顺序写入，避免"默认模型"变成另一个）；
  // 没有顺序文件时按中文名排序（稳定、可预期）
  return sortByOrder(out, out.slice().sort((a, b) => a.name.localeCompare(b.name, 'zh-CN')));
}

/**
 * 用户模型顺序文件（可选）：`live2d-models/.order.json` = `["模型名", …]`。
 * 存在的意义：模型从随包资源搬进用户数据后目录顺序会变，"默认模型"(列表第一项) 可能换人；
 * 用这个文件把顺序钉住（不列出的模型排在后面，保持原相对顺序）。
 */
export function readModelOrder(): string[] {
  try {
    const raw = JSON.parse(
      fs.readFileSync(path.join(userModelsDir(), '.order.json'), 'utf8').replace(/^\uFEFF/, '')
    ) as unknown;
    return Array.isArray(raw) ? raw.filter((x): x is string => typeof x === 'string' && !!x) : [];
  } catch {
    return [];
  }
}

/** 按 .order.json 重排（没有顺序文件就原样返回默认顺序） */
function sortByOrder(list: UserModelEntry[], fallback: UserModelEntry[]): UserModelEntry[] {
  const order = readModelOrder();
  if (!order.length) return fallback;
  const rank = new Map(order.map((n, i) => [n, i]));
  const base = new Map(fallback.map((m, i) => [m.name, i]));
  return list.slice().sort((a, b) => {
    const ra = rank.has(a.name) ? (rank.get(a.name) as number) : order.length + (base.get(a.name) ?? 0);
    const rb = rank.has(b.name) ? (rank.get(b.name) as number) : order.length + (base.get(b.name) ?? 0);
    return ra - rb;
  });
}

export function listUserPlugins(): UserPluginEntry[] {
  const out: UserPluginEntry[] = [];
  const seen = new Set<string>();
  const push = (dir: string, external: boolean): void => {
    const key = path.resolve(dir).toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    if (!fs.existsSync(dir)) return;
    const item = validatePluginDir(dir);
    item.external = external;
    out.push(item);
  };
  for (const ent of fs.existsSync(userPluginsDir()) ? fs.readdirSync(userPluginsDir(), { withFileTypes: true }) : []) {
    if (ent.isDirectory()) push(path.join(userPluginsDir(), ent.name), false);
  }
  for (const reg of readRegistry().plugins) push(reg.dir, true);
  return out.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
}

/** 用户模型目录查找（静态服务挂载用：/user-models/<名字>/… → 该目录） */
export function findUserModel(name: string): UserModelEntry | null {
  const safe = path.basename(name);
  return listUserModels().find((m) => m.name === safe) ?? null;
}

/** 注册一个模型目录（不拷贝文件；放在别处也能用，登记的是路径） */
export function registerModelDir(srcDir: string): {
  ok: boolean;
  entry?: UserModelEntry;
  error?: string;
  /** 导入即归类的结果（点击触发/服饰道具/情绪表情…），供 UI 立刻告诉用户"识别到了什么" */
  capabilities?: ModelCapabilities;
  /** 归类过程中要提醒用户的事（例如"有情绪参数但没有情绪表情，可手填映射"） */
  capabilityIssues?: string[];
  presetPath?: string;
} {
  const dir = path.resolve(srcDir);
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return { ok: false, error: '选择的不是文件夹' };
  const probe = validateModelDir(dir);
  if (probe.kind === 'unknown') {
    return { ok: false, error: `这个文件夹不像模型目录：${probe.issues.join('；')}` };
  }
  // 模型放在 userData 目录之外的 → 记进注册表，下次启动仍然认得
  const insideUserDir = path.resolve(dir).toLowerCase().startsWith(path.resolve(userModelsDir()).toLowerCase());
  if (!insideUserDir) rememberExternal('model', probe.name, dir);
  // **导入即能力归类**：识别动作/表情/参数，写进该模型目录的 pet-model.json（只填空缺、可手改）
  const applied = applyDetectedCapabilities(dir, probe.name);
  if (!applied.ok) console.warn(`[assets] 能力归类写入失败（${probe.name}）：${applied.error}`);
  return {
    ok: true,
    entry: probe,
    ...(applied.detection ? { capabilities: applied.detection.capabilities } : {}),
    ...(applied.detection && applied.detection.issues.length ? { capabilityIssues: applied.detection.issues } : {}),
    ...(applied.path ? { presetPath: applied.path } : {}),
  };
}

/** 移除用户模型：只从注册表/用户目录移除，不删用户原始文件（外部的） */
export function unregisterModel(name: string): { ok: boolean; error?: string; removedFiles?: boolean } {
  const safe = path.basename(name);
  const target = listUserModels().find((m) => m.name === safe);
  if (!target) return { ok: false, error: `没找到用户模型「${safe}」` };
  forgetExternal('model', target.dir);
  const insideUserDir = path.resolve(target.dir).toLowerCase().startsWith(path.resolve(userModelsDir()).toLowerCase());
  if (!insideUserDir) return { ok: true, removedFiles: false }; // 外部目录只做注销，不碰用户文件
  try {
    fs.rmSync(target.dir, { recursive: true, force: true });
    return { ok: true, removedFiles: true };
  } catch (err) {
    return { ok: false, error: `删除失败：${(err as Error).message}` };
  }
}

export function registerPluginDir(srcDir: string): { ok: boolean; entry?: UserPluginEntry; error?: string } {
  const dir = path.resolve(srcDir);
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return { ok: false, error: '选择的不是文件夹' };
  const probe = validatePluginDir(dir);
  if (!probe.entry) return { ok: false, error: probe.issues.join('；') || '这个文件夹里没有插件入口' };
  const insideUserDir = path.resolve(dir).toLowerCase().startsWith(path.resolve(userPluginsDir()).toLowerCase());
  if (!insideUserDir) rememberExternal('plugin', probe.name, dir);
  return { ok: true, entry: probe };
}

export function unregisterPlugin(name: string): { ok: boolean; error?: string; removedFiles?: boolean } {
  const safe = path.basename(name);
  const target = listUserPlugins().find((p) => p.name === safe);
  if (!target) return { ok: false, error: `没找到用户插件「${safe}」` };
  forgetExternal('plugin', target.dir);
  const insideUserDir = path.resolve(target.dir).toLowerCase().startsWith(path.resolve(userPluginsDir()).toLowerCase());
  if (!insideUserDir) return { ok: true, removedFiles: false };
  try {
    fs.rmSync(target.dir, { recursive: true, force: true });
    return { ok: true, removedFiles: true };
  } catch (err) {
    return { ok: false, error: `删除失败：${(err as Error).message}` };
  }
}

/** 用系统资源管理器打开资产目录（设置页的"打开文件夹"按钮） */
export async function openAssetDir(kind: AssetKind): Promise<string> {
  const dir = assetDir(kind);
  return await shell.openPath(dir);
}

/* ------------------------------------------------------------------ 模型预设（pet-model.json）

   预设 = 模型作者/用户给这个模型补的"适配信息"：取景建议、情绪→表情映射、逻辑参数→实际参数 ID。
   写模板时会把模型里**真实存在的表情名**列进 `_可用表情`，用户改起来不用去翻 model3.json。

   生成策略（不覆盖用户已有内容）：
   - userData/live2d-presets/<模型>.json 已存在 → 直接返回它（不覆盖，避免冲掉用户写的东西）
   - 否则写一份模板（`_` 开头的键只是提示，解析侧会忽略）                                 */

/** 读一份 JSON 并容忍 BOM（Windows 编辑器常见） */
function readJsonLoose(file: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    return null;
  }
}

/** 从 model3.json 里取表情名列表（拿不到就是空数组，绝不报错） */
export function readModelExpressionNames(modelDir: string): string[] {
  const rel = findFile(modelDir, (n) => /\.model3\.json$/i.test(n), 2);
  if (!rel) return [];
  const json = readJsonLoose(path.join(modelDir, rel)) as
    | { FileReferences?: { Expressions?: Array<{ Name?: unknown }> } }
    | null;
  const list = json?.FileReferences?.Expressions;
  if (!Array.isArray(list)) return [];
  return list
    .map((e) => (e && typeof e.Name === 'string' ? e.Name : ''))
    .filter((n): n is string => !!n)
    .slice(0, 40);
}

/** 预设模板内容（JSON 合法：提示键以 _ 开头，解析侧忽略） */
export function buildPresetTemplate(modelName: string, expressions: string[]): string {
  const first = expressions[0] ?? '这里填该模型的表情名';
  const template = {
    _说明: `「${modelName}」的模型预设。三个字段全部可选，删掉不需要的即可；改完保存，切换模型后生效。`,
    _framing: '取景建议：full 全身 / half 半身。只在设置里没选过取景时作为默认值。',
    framing: 'full',
    _emotionMap: '情绪标签（happy/sad/angry/surprised/anxious）→ 该模型的表情名；写不存在的名字会被忽略。',
    _可用表情: expressions.length ? expressions : ['（这个模型没有表情，emotionMap 写了也不会生效）'],
    emotionMap: { happy: first },
    _parameterMap: '逻辑参数 → 模型实际参数 ID（命名不标准的模型才需要；标准 Cubism 参数名可整段删除）。',
    parameterMap: {},
  };
  return `${JSON.stringify(template, null, 2)}\n`;
}

/** 预设文件当前落在哪、内容是什么（设置页展示用） */
export function readModelPresetFile(
  modelName: string,
  modelDir: string | null
): { path: string | null; exists: boolean; fromUserData: boolean; raw: unknown } {
  const userFile = userPresetFile(modelName);
  if (fs.existsSync(userFile)) {
    return { path: userFile, exists: true, fromUserData: true, raw: readJsonLoose(userFile) };
  }
  if (modelDir) {
    const inModel = path.join(modelDir, 'pet-model.json');
    if (fs.existsSync(inModel)) {
      return { path: inModel, exists: true, fromUserData: false, raw: readJsonLoose(inModel) };
    }
  }
  return { path: null, exists: false, fromUserData: false, raw: null };
}

/**
 * 生成（或复用）用户级预设模板。
 * @returns 写入/命中的文件路径；失败返回 error（不抛）
 */
export function writeModelPresetTemplate(
  modelName: string,
  expressions: string[]
): { ok: boolean; path?: string; created?: boolean; error?: string } {
  if (!modelName || !modelName.trim()) return { ok: false, error: '模型名为空' };
  const file = userPresetFile(modelName);
  try {
    if (fs.existsSync(file)) return { ok: true, path: file, created: false };
    fs.writeFileSync(file, buildPresetTemplate(modelName, expressions), 'utf8');
    return { ok: true, path: file, created: true };
  } catch (err) {
    return { ok: false, error: `写入预设失败：${(err as Error).message}` };
  }
}

/* ------------------------------------------------------------------ 模型能力自动识别与归类

   用户要求：导入模型时自动识别能力并归类 —— 有"点一点"这类动作就归到点击触发；
   有服饰/道具列表就在右键菜单里显示（没有就不显示）；有情绪表情/动作就在识别到对应情绪时触发。

   识别输入（都不依赖第三方库，纯读模型的描述文件）：
     - `<模型>.model3.json` 的 FileReferences.Motions（动作组名）与 Expressions（表情名）
     - `<模型>.cdi3.json` 的 Parameters[].Name / Parts[].Name（中文名，例如「脸红」「生气」「围裙」「点」）

   输出：写进该模型目录下的 `pet-model.json`（capabilities 字段 + emotionMap），
        并且**只填空缺**：用户已经手写过的值一律不动。                                        */

export interface ModelCapabilities {
  /** 点击角色时触发（表情名或动作组名） */
  click?: string[];
  /** 服饰 / 道具（非空时右键菜单才出现这一组） */
  costume?: string[];
  /** 情绪 → 表情名（happy/sad/angry/surprised/anxious/neutral；识别到用户对应情绪时触发） */
  emotion?: Record<string, string>;
  /** 待机动作组（用来确认这个模型"会动"） */
  idle?: string[];
  /** 其它动作组（右键「动作」组里展示） */
  motions?: string[];
}

export interface ModelDetection {
  capabilities: ModelCapabilities;
  /** 识别依据（便于设置页向用户交代"凭什么这么归"） */
  hints: { expressions: string[]; motionGroups: string[]; parameterNames: string[]; parts: string[] };
  /** 识别过程中碰到的问题（例如 model3.json 读不出来） */
  issues: string[];
}

const CLICK_RE = /点|戳|tap|click|poke|touch|flick/i;
const COSTUME_RE = /服饰|服装|衣|裙|围裙|眼镜|帽|耳饰|项圈|领|饰|道具|滤镜|拍照|相机|拿笔|笔|书|伞|扇|翅膀|尾巴|outfit|costume|clothes|dress|glass|hat|prop|filter|^(black|red|white|blue|pink|green|purple|gold)$/i;
const IDLE_RE = /idle|待机|呼吸|standing|default/i;
const EMOTION_PATTERNS: Array<[string, RegExp]> = [
  ['happy', /笑|开心|喜|乐|愉快|happy|smile|joy|fun|good|laugh/i],
  ['sad', /哭|泪|悲|难|失落|委屈|sad|cry|tear|down/i],
  ['angry', /怒|生气|火|气|angry|anger|mad|rage/i],
  ['surprised', /惊|讶|呆|震|吓|shock|surpris|wonder|amaze/i],
  ['anxious', /紧张|害|慌|汗|不安|worr|anxi|nervous|fear|scared/i],
  ['neutral', /平静|默认|普通|neutral|normal|default/i],
];

function uniqueList(list: string[]): string[] {
  return [...new Set(list.filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim()))];
}

/** 读模型描述文件，识别能力并归类（纯函数式，读不到就返回空能力 + issues） */
export function detectModelCapabilities(modelDir: string): ModelDetection {
  const caps: ModelCapabilities = {};
  const hints: ModelDetection['hints'] = { expressions: [], motionGroups: [], parameterNames: [], parts: [] };
  const issues: string[] = [];

  const model3Rel = findFile(modelDir, (n) => /\.model3\.json$/i.test(n), 2);
  if (!model3Rel) {
    issues.push('没有找到 .model3.json，无法识别能力');
    return { capabilities: caps, hints, issues };
  }
  const model3 = readJsonLoose(path.join(modelDir, model3Rel)) as
    | { FileReferences?: { Motions?: Record<string, unknown>; Expressions?: Array<{ Name?: unknown }>; DisplayInfo?: string } }
    | null;
  hints.motionGroups = Object.keys(model3?.FileReferences?.Motions ?? {});
  hints.expressions = (model3?.FileReferences?.Expressions ?? [])
    .map((e) => (e && typeof e.Name === 'string' ? e.Name : ''))
    .filter((n): n is string => !!n);

  // cdi3（DisplayInfo）：参数/部件中文名，用来兜底识别"脸红/生气/围裙/点"这类意图
  const displayRel = model3?.FileReferences?.DisplayInfo;
  const cdiRel = typeof displayRel === 'string' && displayRel ? displayRel : findFile(modelDir, (n) => /\.cdi3\.json$/i.test(n), 2);
  if (cdiRel) {
    const cdi = readJsonLoose(path.join(modelDir, cdiRel)) as
      | { Parameters?: Array<{ Name?: unknown }>; Parts?: Array<{ Name?: unknown }> }
      | null;
    hints.parameterNames = uniqueList((cdi?.Parameters ?? []).map((p) => (typeof p?.Name === 'string' ? p.Name : '')));
    hints.parts = uniqueList((cdi?.Parts ?? []).map((p) => (typeof p?.Name === 'string' ? p.Name : '')));
  } else {
    issues.push('没有 DisplayInfo/.cdi3.json：只能用动作与表情名识别');
  }

  // ① 点击触发：表情名或动作组名命中"点/戳/tap…"
  const clickExpr = hints.expressions.filter((n) => CLICK_RE.test(n));
  const clickMotion = hints.motionGroups.filter((g) => CLICK_RE.test(g));
  const click = uniqueList([...clickExpr, ...clickMotion]);
  if (click.length) caps.click = click;

  // ② 服饰 / 道具：表情名命中服饰道具词（动作组也算）
  const costume = uniqueList([
    ...hints.expressions.filter((n) => COSTUME_RE.test(n)),
    ...hints.motionGroups.filter((g) => COSTUME_RE.test(g)),
  ]);
  if (costume.length) caps.costume = costume;

  // ③ 情绪 → 表情：按表情名（其次看 cdi3 参数中文名的提示）
  const emotion: Record<string, string> = {};
  for (const [label, re] of EMOTION_PATTERNS) {
    if (emotion[label]) continue;
    const hit = hints.expressions.find((n) => re.test(n));
    if (hit) emotion[label] = hit;
  }
  // cdi3 里出现"脸红/生气"这类参数但没有对应表情时，至少把提示记进 issues，让用户知道可以手填
  const paramEmotionHints = hints.parameterNames.filter((n) => /脸红|脸红|生气|怒|哭|笑|害羞|惊/.test(n));
  if (paramEmotionHints.length && Object.keys(emotion).length === 0) {
    issues.push(`模型有情绪相关参数（${paramEmotionHints.slice(0, 4).join('、')}）但没有情绪命名表情，可在 pet-model.json 的 emotionMap 里手填`);
  }
  if (Object.keys(emotion).length) caps.emotion = emotion;

  // ④ 待机 / 其它动作组
  const idle = hints.motionGroups.filter((g) => IDLE_RE.test(g));
  if (idle.length) caps.idle = idle;
  const others = hints.motionGroups.filter((g) => !idle.includes(g) && !click.includes(g));
  if (others.length) caps.motions = others;

  return { capabilities: caps, hints, issues };
}

/**
 * 把识别结果写进**模型目录**下的 pet-model.json（只填空缺，绝不覆盖用户已写的值）。
 * 这是"导入即归类"的落点：以后设置页也能手动改同一个文件。
 */
export function applyDetectedCapabilities(
  modelDir: string,
  modelName: string,
  detection?: ModelDetection
): { ok: boolean; path?: string; created?: boolean; changed?: boolean; detection?: ModelDetection; error?: string } {
  try {
    const det = detection ?? detectModelCapabilities(modelDir);
    const file = path.join(modelDir, 'pet-model.json');
    const existing = (readJsonLoose(file) as Record<string, unknown> | null) ?? {};
    const next: Record<string, unknown> = { ...existing };

    // capabilities：只补空缺的条目
    const existingCaps = (typeof existing.capabilities === 'object' && existing.capabilities
      ? { ...(existing.capabilities as Record<string, unknown>) }
      : {}) as Record<string, unknown>;
    for (const [k, v] of Object.entries(det.capabilities)) {
      const cur = existingCaps[k];
      const isEmpty = cur === undefined || cur === null || (Array.isArray(cur) && cur.length === 0)
        || (typeof cur === 'object' && !Array.isArray(cur) && Object.keys(cur as object).length === 0);
      if (isEmpty) existingCaps[k] = v;
    }
    if (Object.keys(existingCaps).length) next.capabilities = existingCaps;

    // emotionMap：与 capabilities.emotion 双向补齐（渲染层读的是顶层 emotionMap）
    const emo = (typeof existing.emotionMap === 'object' && existing.emotionMap ? { ...(existing.emotionMap as Record<string, unknown>) } : {}) as Record<string, unknown>;
    const capsEmo = (existingCaps.emotion as Record<string, string> | undefined) ?? det.capabilities.emotion ?? {};
    for (const [label, name] of Object.entries(capsEmo)) {
      if (!emo[label]) emo[label] = name;
    }
    if (Object.keys(emo).length) next.emotionMap = emo;

    // 写入识别依据（供设置页解释"凭什么这么归"），保留用户自己的 _ 键。
    // 注意：这里**先不带时间戳**算一次"要不要写"——否则每次调用都会因为时间戳变化而重写文件（幂等性会被破坏）。
    next['_识别依据'] = {
      动作组: det.hints.motionGroups,
      表情: det.hints.expressions,
      参数中文名: det.hints.parameterNames.slice(0, 40),
    };
    if (det.issues.length) next['_识别问题'] = det.issues;
    next['_说明'] = `「${modelName}」的模型预设（含自动识别的能力归类）。值都可手改；改完切换模型后生效。`;

    const created = !fs.existsSync(file);
    // 比较时沿用文件里已有的识别时间：否则时间戳一变就被判定成"有变化"，幂等性失效
    const prevStamp = existing['_识别依据'] && typeof existing['_识别依据'] === 'object'
      ? (existing['_识别依据'] as Record<string, unknown>)['识别时间']
      : undefined;
    if (typeof prevStamp === 'string') (next['_识别依据'] as Record<string, unknown>)['识别时间'] = prevStamp;
    const before = JSON.stringify(existing);
    if (JSON.stringify(next) === before) return { ok: true, path: file, created: false, changed: false, detection: det };

    // 真正要写时才补时间戳
    (next['_识别依据'] as Record<string, unknown>)['识别时间'] = new Date().toISOString();
    fs.writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
    return { ok: true, path: file, created, changed: true, detection: det };
  } catch (err) {
    return { ok: false, error: `写入能力归类失败：${(err as Error).message}` };
  }
}
