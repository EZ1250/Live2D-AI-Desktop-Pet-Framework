/**
 * PathResolver —— 模型资源根目录解析（三态优先级，注释与 CONTRACT.md L36-37 对齐）
 *
 *  状态 1 开发：!app.isPackaged → path.join(app.getAppPath(), 'public', 'assets')
 *            （即桌面工程内 public/assets，`electron .` 源码运行）
 *  状态 2 打包：app.isPackaged
 *            → path.join(process.resourcesPath, 'assets')（electron-builder extraResources 落点）
 *  状态 3 便携兜底：打包资源缺失
 *            → path.join(path.dirname(process.execPath), 'assets')（便携 exe 同目录 assets）
 *
 * 取第一个"适用且目录存在"者；全部缺失时仍返回兜底路径（不抛错），由 main.ts 启动日志暴露。
 * 只读 electron 的 app/process 元数据，不做任何 I/O 之外的副作用。
 */
import * as fs from 'fs';
import * as path from 'path';
import { app } from 'electron';

/** models.json 单条元数据（宽松解析：字段全部可选） */
export interface ModelMeta {
  name: string;
  type?: 'moc3' | 'portrait';
  /** models.json 显式指定的主资源文件（相对该模型目录，如 'x.model3.json' 或 'textures/p.png'） */
  file?: string;
}

/** 某模型的主资源描述，用于拼装 http://127.0.0.1:<port>/assets/<模型>/<file> */
export interface ModelDescriptor {
  name: string;
  /** 相对模型目录，正斜杠分隔，可能含子目录 */
  file: string;
  type: 'moc3' | 'portrait';
  /**
   * URL 前缀：
   *  - 'assets'       随包模型（resources/assets 或 public/assets）
   *  - 'user-models'  用户自己加进来的模型（userData/live2d-models 或登记的任意目录），
   *                   由 StaticServer 的额外挂载点提供，**不进打包产物**
   */
  base: 'assets' | 'user-models';
}

/**
 * 可选的模型预设 `pet-model.json`（放在模型目录里，用户/模型作者自填）。
 * 全部字段可选：没有这个文件时行为与从前完全一致（零副作用）。
 *
 * ```json
 * {
 *   "framing": "half",
 *   "emotionMap": { "happy": "拍照", "neutral": "呆猫" },
 *   "parameterMap": { "AngleX": "ParamAngleX" }
 * }
 * ```
 */
export interface ModelPreset {
  /** 建议取景（仅当用户设置里没选过 displayMode 时作为默认值） */
  framing?: 'full' | 'half';
  /** 情绪标签 → 该模型的表情名（优先于内置模糊匹配，名字不存在则忽略） */
  emotionMap?: Record<string, string>;
  /** 逻辑参数名 → 模型实际参数 ID（不同模型命名不一致时的兼容映射） */
  parameterMap?: Record<string, string>;
  /**
   * 自动识别出的能力归类（导入模型时写入 pet-model.json，设置页可手改）：
   *  - click：点击角色时触发（表情名或动作组名）
   *  - costume：服饰/道具列表（**非空时右键菜单才出现这一组**）
   *  - emotion：情绪 → 表情名（与 emotionMap 等价；识别时两个键都会写）
   *  - idle / motions：动作组名
   */
  capabilities?: {
    click?: string[];
    costume?: string[];
    emotion?: Record<string, string>;
    idle?: string[];
    motions?: string[];
  };
}

/** 预设解析结果：解析失败不算致命错误，收敛成可读 issues。 */
export interface ModelPresetResult {
  preset: ModelPreset;
  issues: string[];
}

const IMAGE_EXT = /\.(png|jpe?g|webp|gif)$/i;
const MOC3_EXT = /\.model3\.json$/i;

export class PathResolver {
  private static cached: PathResolver | null = null;

  private constructor(private readonly assetsRootPath: string) {}

  /** 单例（进程内只解析一次资源根） */
  static resolve(): PathResolver {
    if (PathResolver.cached) return PathResolver.cached;
    PathResolver.cached = new PathResolver(PathResolver.pickAssetsRoot());
    console.log(`[PathResolver] assetsRoot = ${PathResolver.cached.assetsRoot()}`);
    return PathResolver.cached;
  }

  /** 三态优先级选择；见文件头注释 */
  private static pickAssetsRoot(): string {
    const isPackaged = app.isPackaged;

    const devRoot = path.join(app.getAppPath(), 'public', 'assets');
    const packagedRoot = path.join(process.resourcesPath, 'assets');
    const portableRoot = path.join(path.dirname(process.execPath), 'assets');

    const has = (dir: string): boolean => {
      try {
        return fs.existsSync(dir);
      } catch {
        return false;
      }
    };

    // 状态 1：开发（源码内运行 `electron .`）
    if (!isPackaged && has(devRoot)) return devRoot;
    // 打包资源统一由 electron-builder 放在 resources/assets；便携模式也必须优先使用它。
    if (isPackaged && has(packagedRoot)) return packagedRoot;
    // resources/assets 缺失时才回退到 exe 同目录，兼容手工便携目录结构。
    return portableRoot;
  }

  /** assets 根目录，例 …/DesktopPet-App/public/assets */
  assetsRoot(): string {
    return this.assetsRootPath;
  }

  /** 静态 HTTP 服务根目录 = assets 上一级（URL 形如 /assets/<模型>/xxx.model3.json） */
  staticRoot(): string {
    return path.dirname(this.assetsRootPath);
  }

  /** 知识库目录（语料注入用） */
  knowledgeDir(): string {
    return path.join(this.assetsRootPath, 'knowledge');
  }

  /**
   * 该模型自己的语料目录：`<模型目录>/knowledge/`（存在就用它）。
   * 模型搬进用户数据后，模型专属语料跟着模型走（一个模型一个文件夹、自给自足）；
   * 没有自己的语料目录时回落全局 knowledge（`character.offline.txt` 这类通用语料仍在随包资源里）。
   */
  knowledgeDirForModel(name: string): string {
    const dir = this.modelDirAbs(name);
    if (dir) {
      const own = path.join(dir, 'knowledge');
      try {
        if (fs.statSync(own).isDirectory()) return own;
      } catch {
        /* 没有就回落全局 */
      }
    }
    return this.knowledgeDir();
  }

  /** 模型目录；basename 过滤防路径穿越（name 可能来自 models.json / IPC 入参） */
  modelDir(name: string): string {
    return path.join(this.assetsRootPath, path.basename(name));
  }

  /** 可用模型名列表：用户加的模型优先（后加的排前面），随后 models.json，最后磁盘子目录扫描兜底 */
  modelList(): string[] {
    const names: string[] = [];
    const seen = new Set<string>();
    const add = (n: string): void => {
      if (!n || seen.has(n)) return;
      seen.add(n);
      names.push(n);
    };
    // 1) 用户模型（像插件一样可加可移除）
    for (const entry of PathResolver.userModels()) add(entry.name);
    // 2) 随包模型
    for (const meta of this.readModelsJson()) add(meta.name);
    // models.json 缺失时的兜底：assets 下一级子目录内含 *.model3.json 视为 moc3 模型；
    // 仅有图片无 moc3 视为 portrait 模型（静态形象）。
    for (const dir of PathResolver.listSubDirs(this.assetsRootPath)) {
      const dirAbs = path.join(this.assetsRootPath, dir);
      if (PathResolver.findFile(dirAbs, (n) => MOC3_EXT.test(n), 2)) add(dir);
      else if (PathResolver.findFile(dirAbs, (n) => IMAGE_EXT.test(n), 2)) add(dir);
    }
    return names;
  }

  /**
   * 用户模型列表（userData 里放入的 + 注册表登记的外部目录）。
   * 用函数注入而不是直接 import，避免 PathResolver 依赖 Electron 的 userData 生命周期。
   */
  private static userModelsProvider: () => Array<{ name: string; dir: string; kind: string }> = () => [];

  /**
   * 用户级预设文件提供者（由 main.ts 注入 userAssets.userPresetFile）：
   * 返回该模型在 userData 里的预设文件路径（不存在也返回路径，读取时会失败并回落）。
   * 用注入而不是 import，避免 PathResolver 依赖 assets 层（保持它"只做路径解析"）。
   */
  private static userPresetProvider: (modelName: string) => string = () => '';

  static setUserPresetProvider(fn: (modelName: string) => string): void {
    PathResolver.userPresetProvider = typeof fn === 'function' ? fn : () => '';
  }

  /** main 在启动时注入用户模型来源（见 main.ts） */
  static setUserModelsProvider(fn: () => Array<{ name: string; dir: string; kind: string }>): void {
    PathResolver.userModelsProvider = fn;
  }

  private static userModels(): Array<{ name: string; dir: string; kind: string }> {
    try {
      return PathResolver.userModelsProvider() ?? [];
    } catch {
      return [];
    }
  }

  /**
   * 模型主资源描述：类型以 models.json 声明为准（import-model 按 FileReferences.Moc
   * 判定，可正确区分真 moc3 与 portrait 描述文件）；models.json 缺失时退化为磁盘推断
   * （存在 *.model3.json → moc3，否则按图片 → portrait）。
   * 强健化：*.model3.json 仅是无 Moc 的描述文件（如 PortraitMode 立绘壳）时，
   * 目录内有图片则判 portrait——避免"伪 moc3"被 renderer 当 Live2D 加载而落到占位卡片。
   * 主文件按类型选择：moc3 → .model3.json；portrait → 立绘图片。找不到返回 null。
   */
  modelDescriptor(name: string): ModelDescriptor | null {
    const safe = path.basename(name);

    // 0) 用户模型（放入 userData/live2d-models 或注册过的外部目录）：直接按该目录解析，
    //    URL 走 /user-models/<名字>/…（静态服务的额外挂载点），不进打包产物。
    const userModel = PathResolver.userModels().find((m) => m.name === safe);
    if (userModel) {
      const dirAbs = userModel.dir;
      const model3Rel = PathResolver.findFile(dirAbs, (n) => MOC3_EXT.test(n), 2);
      const imgRel = PathResolver.findFile(dirAbs, (n) => IMAGE_EXT.test(n), 2);
      const mocReal = Boolean(model3Rel && PathResolver.hasMocReference(path.join(dirAbs, model3Rel)));
      const type: 'moc3' | 'portrait' =
        userModel.kind === 'portrait' || (!mocReal && imgRel) ? 'portrait' : 'moc3';
      const file = type === 'moc3' ? model3Rel : imgRel;
      if (!file) return null;
      return { name: safe, file: file.split(path.sep).join('/'), type, base: 'user-models' };
    }

    const meta = this.readModelsJson().find((m) => m.name === name || m.name === safe);
    const dirAbs = this.modelDir(safe);

    const model3Rel = PathResolver.findFile(dirAbs, (n) => MOC3_EXT.test(n), 2);
    const imgRel = PathResolver.findFile(dirAbs, (n) => IMAGE_EXT.test(n), 2);
    // “真 moc3”：存在 *.model3.json 且 FileReferences.Moc 非空
    const mocReal = Boolean(model3Rel && PathResolver.hasMocReference(path.join(dirAbs, model3Rel)));

    let type: 'moc3' | 'portrait';
    if (meta?.type === 'moc3') {
      type = mocReal ? 'moc3' : imgRel ? 'portrait' : 'moc3';
      if (!mocReal && imgRel) {
        console.warn(`[PathResolver] 模型 "${safe}" 声明 moc3 但缺少真实 Moc，已按 portrait 降级`);
      }
    } else if (meta?.type === 'portrait') {
      type = imgRel ? 'portrait' : mocReal ? 'moc3' : 'portrait';
    } else {
      // 无声明：有真实 Moc → moc3；仅有"伪 model3.json"+ 图片 → portrait；否则按图片
      type = mocReal ? 'moc3' : imgRel ? 'portrait' : 'moc3';
    }

    let file = type === 'moc3' ? model3Rel : imgRel;
    // 磁盘扫描落空时：仅当 models.json 显式给了 file 且该文件确实存在才可用
    if (!file && meta?.file) {
      try {
        if (fs.statSync(path.join(dirAbs, meta.file)).isFile()) file = meta.file;
      } catch {
        /* 忽略：视为不存在 */
      }
    }
    if (!file) return null;
    return { name: safe, file: file.split(path.sep).join('/'), type, base: 'assets' };
  }

  /**
   * 模型目录绝对路径（用户模型优先，其次随包 assets）。
   * 用于读取模型自带的 pet-model.json 预设。
   */
  modelDirAbs(name: string): string | null {
    const safe = path.basename(name);
    if (!safe) return null;
    const userModel = PathResolver.userModels().find((m) => m.name === safe);
    if (userModel) return userModel.dir;
    const dir = this.modelDir(safe);
    try {
      return fs.statSync(dir).isDirectory() ? dir : null;
    } catch {
      return null;
    }
  }

  /**
   * 读取可选的 `pet-model.json`（模型级预设：取景 / 情绪→表情 / 参数映射）。
   * 查找顺序：**用户级预设**（userData/live2d-presets/<模型>.json，由 provider 提供）优先，
   * 其次是模型目录里的 pet-model.json —— 随包模型目录只读，用户只能通过用户级预设覆盖它。
   * - 文件不存在 → 空预设，零副作用（老模型完全不受影响）；
   * - JSON 坏 / 字段类型不对 → 收进 issues（设置页与启动日志能看到），不抛错。
   */
  modelPreset(name: string): ModelPresetResult {
    const preset: ModelPreset = {};
    const issues: string[] = [];
    let file = '';
    try {
      file = PathResolver.userPresetProvider(path.basename(name)) || '';
    } catch {
      file = '';
    }
    let fromUserData = false;
    if (file) {
      fromUserData = true;
    } else {
      const dir = this.modelDirAbs(name);
      if (!dir) return { preset, issues };
      file = path.join(dir, 'pet-model.json');
    }
    let raw = '';
    try {
      raw = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''); // 兼容带 BOM 的编辑器保存
    } catch {
      if (!fromUserData) return { preset, issues }; // 模型目录里没有这个文件是常态
      return { preset, issues: ['用户级预设文件读不出来（可能没有读取权限）'] };
    }
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      return { preset, issues: [`pet-model.json 不是合法 JSON：${(err as Error).message.slice(0, 80)}`] };
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { preset, issues: ['pet-model.json 顶层必须是对象'] };
    }
    const obj = parsed as Record<string, unknown>;
    if (obj.framing === 'full' || obj.framing === 'half') {
      preset.framing = obj.framing;
    } else if (obj.framing !== undefined) {
      issues.push(`pet-model.json framing 只能是 "full" 或 "half"（当前 ${JSON.stringify(obj.framing).slice(0, 24)}）`);
    }
    for (const key of ['emotionMap', 'parameterMap'] as const) {
      const val = obj[key];
      if (val === undefined) continue;
      if (!val || typeof val !== 'object' || Array.isArray(val)) {
        issues.push(`pet-model.json ${key} 必须是对象（键→字符串）`);
        continue;
      }
      const clean: Record<string, string> = {};
      for (const [k, v] of Object.entries(val as Record<string, unknown>)) {
        if (typeof v === 'string' && v.trim()) clean[k] = v.trim();
        else issues.push(`pet-model.json ${key}.${k} 必须是非空字符串`);
      }
      if (Object.keys(clean).length) preset[key] = clean;
    }
    // 能力归类（导入时自动写入）：数组字段要剔除非字符串，对象字段按 emotionMap 同样处理
    const capsRaw = obj.capabilities;
    if (capsRaw !== undefined) {
      if (!capsRaw || typeof capsRaw !== 'object' || Array.isArray(capsRaw)) {
        issues.push('pet-model.json capabilities 必须是对象');
      } else {
        const caps: NonNullable<ModelPreset['capabilities']> = {};
        for (const key of ['click', 'costume', 'idle', 'motions'] as const) {
          const list = (capsRaw as Record<string, unknown>)[key];
          if (list === undefined) continue;
          if (!Array.isArray(list)) { issues.push(`pet-model.json capabilities.${key} 必须是字符串数组`); continue; }
          const clean = list.filter((x): x is string => typeof x === 'string' && !!x.trim()).map((x) => x.trim());
          if (clean.length) caps[key] = clean;
        }
        const emo = (capsRaw as Record<string, unknown>).emotion;
        if (emo && typeof emo === 'object' && !Array.isArray(emo)) {
          const clean: Record<string, string> = {};
          for (const [k, v] of Object.entries(emo as Record<string, unknown>)) {
            if (typeof v === 'string' && v.trim()) clean[k] = v.trim();
          }
          if (Object.keys(clean).length) caps.emotion = clean;
        }
        if (Object.keys(caps).length) preset.capabilities = caps;
      }
    }
    return { preset, issues };
  }

  // ------------------------------------------------------------------ private
  /** 宽松解析 assetsRoot/models.json；支持数组或 {models:[...]}，元素为字符串或 {name,type?,file?} */
  private readModelsJson(): ModelMeta[] {
    const file = path.join(this.assetsRootPath, 'models.json');
    let raw: unknown;
    try {
      raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      return []; // 不存在或非法 JSON → 空，调用方走磁盘扫描
    }
    const box = raw as { models?: unknown } | null;
    const list = Array.isArray(raw) ? raw : box ? box.models : undefined;
    if (!Array.isArray(list)) return [];

    const out: ModelMeta[] = [];
    for (const item of list) {
      if (typeof item === 'string') {
        if (item) out.push({ name: item });
        continue;
      }
      const o = item as { name?: unknown; type?: unknown; file?: unknown } | null;
      if (o && typeof o.name === 'string' && o.name) {
        const meta: ModelMeta = { name: o.name };
        if (o.type === 'moc3' || o.type === 'portrait') meta.type = o.type;
        if (typeof o.file === 'string' && o.file) meta.file = o.file;
        out.push(meta);
      }
    }
    return out;
  }

  private static listSubDirs(dir: string): string[] {
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return [];
    }
    return entries.filter((e) => e.isDirectory()).map((e) => e.name);
  }

  /** model3.json 是否携带真实 Moc 引用（宽松解析；读取失败一律 false） */
  private static hasMocReference(model3File: string): boolean {
    try {
      const doc = JSON.parse(fs.readFileSync(model3File, 'utf8')) as {
        FileReferences?: { Moc?: unknown };
      } | null;
      const moc = doc?.FileReferences?.Moc;
      return typeof moc === 'string' && moc.trim().length > 0;
    } catch {
      return false;
    }
  }

  /**
   * 在 dir 内（含最多 maxDepth 层子目录）找首个匹配文件；
   * 返回相对 dir 的路径（平台分隔符）。readdir 失败返回 null（目录缺失容忍）。
   */
  private static findFile(
    dir: string,
    match: (name: string) => boolean,
    maxDepth: number,
    depth = 0
  ): string | null {
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return null;
    }
    for (const e of entries) {
      if (e.isFile() && match(e.name)) return path.relative(dir, path.join(dir, e.name));
    }
    if (depth < maxDepth) {
      for (const e of entries) {
        if (!e.isDirectory()) continue;
        const found = PathResolver.findFile(path.join(dir, e.name), match, maxDepth, depth + 1);
        if (found) return path.join(e.name, found);
      }
    }
    return null;
  }

  /** 模型 moc3 的 Cubism 版本：读 model3.json 的 Moc 文件头第 5~8 字节（LE uint32）；无法判定返回 null */
  modelMocVersion(name: string): number | null {
    try {
      const dirAbs = this.modelDir(path.basename(name));
      const model3Rel = PathResolver.findFile(dirAbs, (n) => MOC3_EXT.test(n), 2);
      if (!model3Rel) return null;
      const doc = JSON.parse(fs.readFileSync(path.join(dirAbs, model3Rel), 'utf8')) as {
        FileReferences?: { Moc?: string };
      } | null;
      const mocRel = doc?.FileReferences?.Moc;
      if (typeof mocRel !== 'string' || !mocRel) return null;
      const mocFile = path.join(dirAbs, mocRel.split('/').join(path.sep));
      if (!fs.existsSync(mocFile)) return null;
      const fd = fs.openSync(mocFile, 'r');
      try {
        const buf = Buffer.alloc(8);
        fs.readSync(fd, buf, 0, 8, 0);
        // 头 'MOC3' + uint32 版本
        if (buf[0] !== 0x4d || buf[1] !== 0x4f || buf[2] !== 0x43 || buf[3] !== 0x33) return null;
        return buf.readUInt32LE(4);
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      return null;
    }
  }
}
