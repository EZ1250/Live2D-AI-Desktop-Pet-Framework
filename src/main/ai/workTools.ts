/**
 * workTools —— 工作区内的只读工具：读文件（带行号）/ 按模式找文件 / 搜代码
 *
 * 安全基线（三个工具共用）：
 *  - 路径只接受工作区内的相对路径；挡 `..` 逃逸、UNC、盘符绝对路径、反斜杠、通配符，
 *    并用 realpath 校验真实路径仍在工作区内（防符号链接逃逸）。
 *  - 只读白名单扩展名；单文件 ≤ 256 KB；跳过 .git/node_modules/dist/release/outputs/public/assets。
 *  - 一律不抛异常：失败返回中文说明，方便模型自行纠错。
 *  - app 只用于取默认工作区根目录（测试时可用 PET_WORKSPACE_ROOT 覆盖）。
 */
import * as fs from 'fs';
import * as path from 'path';
import { app } from 'electron';
import { getWorkspaceRoot } from './devTools';

const TEXT_EXTENSIONS = new Set(['.md', '.txt', '.json', '.ts', '.tsx', '.js', '.jsx', '.css', '.html', '.yml', '.yaml']);
const IGNORED_DIRS = new Set(['.git', 'node_modules', 'dist', 'release', 'outputs', 'public/assets']);
const MAX_FILE_BYTES = 256 * 1024;
const MAX_LINES = 2000;
const MAX_RESULTS = 50;
const GLOB_DEFAULT_LIMIT = 100;
const GLOB_SCAN_CAP = 2000; // 收集上限：超过这个数不再继续数，直接标记"截断"

/**
 * 工作区根目录 —— 必须和"写/改/建目录/执行命令"（devTools）用**同一个根**。
 * 这里以前是自己算 `PET_WORKSPACE_ROOT || app.getAppPath()`：主进程把用户选的工作区
 * 只设进了 devTools，于是"读文件/列目录/搜索"看的是 app 自己的目录，而"写/改"落在用户工作区——
 * 模型写完读不回来（ENOENT），"改前必须先读"的守卫也就永远读不到目标文件。
 * 用户侧的感受就是"AI 看不见我的项目、说什么都做不到"。
 */
export function workspaceRoot(): string {
  const root = getWorkspaceRoot();
  // 未配置工作区时退回 app 目录（老行为，保证只读工具仍可用）；配置了就一定用同一份根。
  return root || path.resolve(app.getAppPath());
}

/**
 * 工作区是不是"整个用户目录"级别的大目录（桌面/文档/下载…）。
 * 这种根做 glob/搜索会又慢又吵，目录列表还会把上下文挤爆 —— 命中时在结果里提醒一句。
 */
const HUGE_ROOT_NAMES = new Set(['desktop', 'documents', 'downloads', '桌面', '文档', '下载', 'pictures', 'music', 'videos']);
export function hugeRootHint(): string {
  const root = workspaceRoot();
  const base = path.basename(root).toLowerCase();
  if (!HUGE_ROOT_NAMES.has(base)) return '';
  return `\n（提示：当前工作区是整个「${path.basename(root)}」，文件非常多，结果可能又慢又杂；` +
    '建议在设置里把「开发工作区」改成具体的项目文件夹。）';
}

function resolveWorkspaceFile(input: string): string {
  if (!input || path.isAbsolute(input) || /^[a-zA-Z]:[\\/]/.test(input) || input.includes('\\')) {
    throw new Error('只允许使用工作区内的相对路径');
  }
  const root = workspaceRoot();
  const resolved = path.resolve(root, input);
  const relative = path.relative(root, resolved);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('路径超出工作区范围');
  const real = fs.realpathSync(resolved);
  const realRoot = fs.realpathSync(root);
  const realRelative = path.relative(realRoot, real);
  if (realRelative.startsWith('..') || path.isAbsolute(realRelative)) throw new Error('路径链接超出工作区范围');
  return real;
}

/** 读取文本文件片段；输出每行带行号（`1234→内容`），默认最多 2000 行 */
export function readWorkspaceFile(input: unknown): string {
  const args = (input ?? {}) as { path?: unknown; startLine?: unknown; endLine?: unknown };
  const relativePath = typeof args.path === 'string' ? args.path.trim() : '';
  try {
    const file = resolveWorkspaceFile(relativePath);
    const stat = fs.statSync(file);
    // 先判目录：目录没有扩展名，先走扩展名白名单会给出误导性的"只允许读取…"错误
    if (!stat.isFile()) return '错误：目标不是文件（想列目录请用 workspace_glob）';
    const ext = path.extname(file).toLowerCase();
    if (!TEXT_EXTENSIONS.has(ext)) return '错误：只允许读取 Markdown、文本、JSON、代码和配置文件';
    if (stat.size > MAX_FILE_BYTES) {
      return `错误：文件 ${Math.round(stat.size / 1024)} KB 超过 256KB 上限，请用 startLine/endLine 分段读取，或改用 workspace_search。`;
    }
    const start = Math.max(1, Number(args.startLine) || 1);
    const requestedEnd = Math.max(start, Number(args.endLine) || start + MAX_LINES - 1);
    const end = Math.min(requestedEnd, start + MAX_LINES - 1);
    const rawContent = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
    const lines = rawContent.split(/\r?\n/);
    const actualStart = Math.min(start, Math.max(1, lines.length));
    const actualEnd = Math.min(end, lines.length);
    const numbered = lines
      .slice(actualStart - 1, actualEnd)
      .map((line, idx) => `${String(idx + actualStart).padStart(5, ' ')}→${line}`);
    const more = actualEnd < lines.length ? `（还有 ${lines.length - actualEnd} 行未显示）` : '';
    return `文件：${relativePath}（第 ${actualStart}-${actualEnd} 行 / 共 ${lines.length} 行）${more}\n\n${numbered.join('\n')}`;
  } catch (err) {
    return `错误：${err instanceof Error ? err.message : String(err)}`;
  }
}

/** 按 glob 模式列出工作区内的文本文件，按修改时间从新到旧排序 */
export function findWorkspaceFiles(input: unknown): string {
  const args = (input ?? {}) as { pattern?: unknown; maxResults?: unknown };
  const pattern = typeof args.pattern === 'string' ? args.pattern.trim() : '';
  const maxResults = Math.max(1, Math.min(500, Number(args.maxResults) || GLOB_DEFAULT_LIMIT));
  const root = workspaceRoot();
  let realRoot = root;
  try {
    realRoot = fs.realpathSync(root);
  } catch {
    /* 根目录异常时退化为原值，后面 walk 会自然返回空 */
  }
  const matches: Array<{ path: string; size: number; mtimeMs: number }> = [];
  let capped = false;

  const walk = (dir: string): void => {
    if (matches.length >= GLOB_SCAN_CAP) {
      capped = true;
      return;
    }
    try {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (matches.length >= GLOB_SCAN_CAP) {
          capped = true;
          return;
        }
        const full = path.join(dir, entry.name);
        const relative = path.relative(root, full).split(path.sep).join('/');
        let real: string;
        try {
          real = fs.realpathSync(full);
          const realRelative = path.relative(realRoot, real);
          if (realRelative.startsWith('..') || path.isAbsolute(realRelative)) continue;
        } catch {
          continue;
        }
        const stat = fs.statSync(real);
        if (stat.isDirectory()) {
          if (IGNORED_DIRS.has(entry.name) || relative.startsWith('public/assets/')) continue;
          walk(real);
          continue;
        }
        if (!stat.isFile()) continue;
        if (!TEXT_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) continue;
        if (pattern && pattern !== '**' && !globMatches(relative, pattern)) continue;
        matches.push({ path: relative, size: stat.size, mtimeMs: stat.mtimeMs });
      }
    } catch {
      /* 忽略不可访问的目录 */
    }
  };

  walk(root);
  if (matches.length === 0) return '没有匹配的文件。';

  matches.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const shown = matches.slice(0, maxResults);
  const lines = shown.map((item) => {
    const date = new Date(item.mtimeMs);
    const stamp = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')} ${String(
      date.getHours(),
    ).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
    const size = item.size < 1024 ? `${item.size} B` : `${(item.size / 1024).toFixed(1)} KB`;
    return `${item.path}  (${size}, ${stamp})`;
  });
  if (matches.length > shown.length) {
    lines.push(
      capped
        ? `…（匹配过多，仅显示最近修改的 ${shown.length} 个；可加目录前缀缩小范围）`
        : `…（共 ${matches.length} 个匹配，已截断，仅显示前 ${shown.length} 个）`,
    );
  }
  return lines.join('\n') + hugeRootHint();
}

/** 搜索工作区文本：子串或正则；支持 content / files / count 三种输出模式 */
export function searchWorkspace(input: unknown): string {
  const args = (input ?? {}) as {
    query?: unknown;
    glob?: unknown;
    maxResults?: unknown;
    regex?: unknown;
    mode?: unknown;
    ignore_case?: unknown;
  };
  const query = typeof args.query === 'string' ? args.query.trim() : '';
  if (!query) return '错误：搜索词不能为空';
  if (query.length > 200) return '错误：搜索词不能超过 200 个字符';

  const mode = args.mode === 'files' || args.mode === 'count' ? args.mode : 'content';
  const ignoreCase = args.ignore_case !== false;
  const globPattern = typeof args.glob === 'string' ? args.glob.trim().toLowerCase() : '';
  const limit = Math.min(MAX_RESULTS, Math.max(1, Number(args.maxResults) || (mode === 'content' ? 20 : MAX_RESULTS)));

  let regexQuery: RegExp | null = null;
  let note = '';
  if (args.regex === true) {
    try {
      regexQuery = new RegExp(query, ignoreCase ? 'gi' : 'g');
    } catch (err) {
      // 正则写错不该让整次搜索失败：回退为字面量搜索，并把原因带回给模型
      note = `（正则无效，已按普通文本搜索：${err instanceof Error ? err.message : String(err)}）\n`;
    }
  }

  const root = workspaceRoot();
  let realRoot = root;
  try {
    realRoot = fs.realpathSync(root);
  } catch {
    /* 交给 walk 自然处理 */
  }
  const hits: Array<{ file: string; line: number; text: string }> = [];
  const counts = new Map<string, number>();

  const walk = (dir: string): void => {
    if (mode === 'content' ? hits.length >= limit : counts.size >= limit) return;
    try {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (mode === 'content' ? hits.length >= limit : counts.size >= limit) return;
        const full = path.join(dir, entry.name);
        const relative = path.relative(root, full).split(path.sep).join('/');
        let real: string;
        try {
          real = fs.realpathSync(full);
          const realRelative = path.relative(realRoot, real);
          if (realRelative.startsWith('..') || path.isAbsolute(realRelative)) continue;
        } catch {
          continue;
        }
        const stat = fs.statSync(real);
        if (stat.isDirectory()) {
          if (IGNORED_DIRS.has(entry.name) || relative.startsWith('public/assets/')) continue;
          walk(real);
          continue;
        }
        if (!stat.isFile()) continue;
        if (!TEXT_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) continue;
        if (globPattern && !globMatches(relative, globPattern)) continue;
        if (stat.size > MAX_FILE_BYTES) continue;

        let text: string;
        try {
          text = fs.readFileSync(real, 'utf8').replace(/^\uFEFF/, '');
        } catch {
          continue;
        }

        if (mode === 'content') {
          const lines = text.split(/\r?\n/);
          for (let i = 0; i < lines.length; i++) {
            if (hits.length >= limit) break;
            const line = lines[i];
            let matched: boolean;
            if (regexQuery) {
              regexQuery.lastIndex = 0;
              matched = regexQuery.test(line);
            } else {
              matched = (ignoreCase ? line.toLowerCase() : line).includes(ignoreCase ? query.toLowerCase() : query);
            }
            if (matched) hits.push({ file: relative, line: i + 1, text: line.trim().slice(0, 240) });
          }
        } else {
          let count = 0;
          if (regexQuery) {
            regexQuery.lastIndex = 0;
            count = (text.match(regexQuery) ?? []).length;
          } else {
            const haystack = ignoreCase ? text.toLowerCase() : text;
            const needle = ignoreCase ? query.toLowerCase() : query;
            let pos = 0;
            while ((pos = haystack.indexOf(needle, pos)) !== -1) {
              count += 1;
              pos += needle.length;
            }
          }
          if (count > 0) counts.set(relative, (counts.get(relative) ?? 0) + count);
        }
      }
    } catch {
      /* 忽略不可访问的目录 */
    }
  };

  walk(root);

  if (mode === 'content') {
    return (hits.length ? note + hits.map((h) => `${h.file}:${h.line}: ${h.text}`).join('\n') : `${note}没有找到匹配内容。`) + hugeRootHint();
  }
  const entries = Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit);
  if (!entries.length) return `${note}没有找到匹配${mode === 'files' ? '文件' : '内容'}。` + hugeRootHint();
  if (mode === 'files') return note + entries.map(([file, count]) => `${file}  (${count} 处)`).join('\n') + hugeRootHint();
  return note + entries.map(([file, count]) => `${file}: ${count} 处`).join('\n') + hugeRootHint();
}

/** glob 匹配：`*` 不跨目录、`**` 跨目录、`?` 单字符；大小写不敏感；带目录但没写 `**` 时按递归再试一次 */
function globMatches(relative: string, glob: string): boolean {
  const g = glob.trim().replace(/\\/g, '/');
  if (!g) return true;
  const rel = relative.replace(/\\/g, '/').toLowerCase();
  const pat = g.toLowerCase();
  if (pat.startsWith('*.') && !pat.includes('/')) return rel.endsWith(pat.slice(1)); // 常见形态：*.ts 按后缀匹配
  const toRegExp = (p: string): RegExp => {
    const GLOBSTAR_DIR = '\u0001';
    const body = p
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\?/g, '[^/]')
      .replace(/\*\*\//g, GLOBSTAR_DIR) // 占位，避免被 * 规则拆坏
      .replace(/\*\*/g, '.*')
      .replace(/\*/g, '[^/]*')
      .split(GLOBSTAR_DIR)
      .join('(?:.*/)?');
    return new RegExp(`(^|/)${body}$`);
  };
  const patterns = [pat];
  if (pat.includes('/') && !pat.includes('**')) {
    const i = pat.lastIndexOf('/');
    patterns.push(`${pat.slice(0, i)}/**${pat.slice(i)}`); // src/*.ts → src/**/*.ts
  }
  for (const p of patterns) {
    try {
      if (toRegExp(p).test(rel)) return true;
    } catch {
      if (rel.endsWith(p.replace(/^.*\//, ''))) return true;
    }
  }
  return false;
}
