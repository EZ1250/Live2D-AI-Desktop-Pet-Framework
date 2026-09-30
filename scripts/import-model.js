#!/usr/bin/env node
/**
 * import-model.js — 把"模型种子"导入 public/assets/，随后统一移交用户模型目录
 *
 * 模型只有一个来源：**工程内 `local-assets/live2d_models/<模型名>/`**。
 * 曾经还有一个指向工程外的"参考源"（`DesktopPet-main/assets`，可用 MODEL_SOURCE_ROOT /
 * KNOWLEDGE_SOURCE 环境变量覆盖）——**已废弃**：那等于把"素材在哪"写成机器相关的外部设置，
 * 换机就得改常量或设环境变量，且外部目录缺失会让 import 直接失败。现在工程自包含。
 *
 * 职责（防呆设计）：
 *   1. 收集种子模型：`local-assets/live2d_models/<模型名>/` 内含 *.model3.json 的目录。
 *      **种子为空不算错误**——模型通常已在用户模型目录里，这里只是可选的"内置种子"投放点；
 *      为空时只重建语料/资产并正常结束。
 *   2. 拷贝前清空 public/assets/（防残留旧文件导致幽灵模型）。
 *   3. 深拷贝：对每个种子模型目录整体拷贝（.model3.json / .moc3 / .cdi3.json /
 *      .physics3.json / motions / expressions / textures / 运行时附属文件 全部），目录名保持原名
 *      （含中文，Node fs 以 UTF-8 处理路径无问题）；随后清理建模/生成期的开发辅助文件
 *      （*.py / *.txt / *_plan / *_rig / *_prompt / *_recommendation 等，见 isDevArtifact）。
 *   4. 路径重写 + 校验：解析拷贝后每个 .model3.json 的 FileReferences（Moc / Textures / Physics /
 *      DisplayInfo / Expressions[].File / Motions[].File 等），确保引用是"相对 .model3.json 所在目录"
 *      的相对路径（整体拷贝后寻址天然不变；仅当出现反斜杠 / 绝对路径等异常时才重写为 ./ 相对形式），
 *      并逐一校验引用文件在 public/assets/<模型>/ 内真实存在；缺失打印 WARN（不删除已拷文件）。
 *   5. 生成 public/assets/models.json 运行时模型清单（{ models: [{name, dir, type, model3Path}] }）。
 *      type：含 .moc3 → 'moc3'；否则（只有一张立绘的 portrait 模型）→ 'portrait'。
 *   6. 知识语料：合并工程根 `personas/` 到 public/assets/knowledge/（人设与通用台词池，
 *      供 chatClient 按宠物模型注入）。knowledge 与模型目录并列、【不写入 models.json】。
 *   7. 本地资产覆盖层 `local-assets/`（最后合并、优先级最高）：
 *      - `live2d_models/` 已在第 1 步按"种子模型"处理；
 *      - `model-order.json` 是配置，不合并；
 *      - 其余条目 → 原样合并进 `public/assets/<同路径>`，覆盖同名文件
 *        （例如 knowledge/*.offline.txt 扩充语料、skills/*.md 技能、内置立绘）。
 *   8. 收尾把模型**移入用户模型目录**（见 migrate-models-to-userdata.js），
 *      并把 public/assets/models.json 清空——项目不内置模型。
 *
 * 纯 Node 实现，无第三方依赖；JSON 读写一律 utf8。
 */
'use strict';

const fs = require('fs');
const path = require('path');

const SCRIPT_DIR = __dirname;
const PROJECT_ROOT = path.join(SCRIPT_DIR, '..');

const PUBLIC_ASSETS = path.join(PROJECT_ROOT, 'public', 'assets');

// 模型种子目录（唯一来源）。把模型文件夹放进去即可在"全新机器上一键恢复"；
// 留空也完全正常 —— 模型通常已经在用户模型目录里。
const SEED_MODELS = path.join(PROJECT_ROOT, 'local-assets', 'live2d_models');

// 本地人设覆盖层：工程根 personas/*.md 会合并进 knowledge/（供 chatClient 按模型注入，
// knowledge/<模型名>.md）；重跑 import 不会丢失本地人设。
const PERSONAS_LOCAL = path.join(PROJECT_ROOT, 'personas');

// 记录 knowledge 拷贝结果，供末尾汇总输出
let knowledgeReport = null;

// ---------------------------------------------------------------- 小工具

/**
 * 目录体积（递归累计字节，统一在顶层换算 MB）：
 * 注意递归过程必须始终以【字节】累加，仅在返回时换算一次，
 * 否则子目录的 MB 返回值会被再次当作字节除以 1024²，导致体积被低估。
 */
function dirSizeBytes(dirPath) {
  let total = 0;
  for (const ent of fs.readdirSync(dirPath, { withFileTypes: true })) {
    const p = path.join(dirPath, ent.name);
    if (ent.isDirectory()) total += dirSizeBytes(p);
    else total += fs.statSync(p).size;
  }
  return total;
}

function dirSizeMb(dirPath) {
  return dirSizeBytes(dirPath) / 1024 / 1024;
}

/** 递归收集某目录下的全部 *.model3.json（按路径排序），供拷贝与校验使用。 */
function findModel3Files(dirPath) {
  const out = [];
  const walk = (d) => {
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); }
    catch { return; }
    for (const ent of entries) {
      const p = path.join(d, ent.name);
      if (ent.isDirectory()) walk(p);
      else if (ent.name.toLowerCase().endsWith('.model3.json')) out.push(p);
    }
  };
  walk(dirPath);
  return out.sort();
}

/**
 * 模型目录内"开发/管线辅助文件"（非运行时资产）判定：按扩展名或已知命名约定。
 * 此类文件是建模/生成过程的中间产物（脚本、规划 JSON、备份），不应作为模型资产
 * 打进 public/assets 与安装包。
 */
function isDevArtifact(relPath) {
  const base = path.basename(relPath);
  return /\.(py|txt|psd|zip|7z)$/i.test(base) ||
    /(ai_prompt_refined|layer_generation_prompt|layer_plan|split_layer_recommendation|rig_v\d|generate_|_old|backup|\.bak\d*|_check|_verify)/i.test(base);
}

/** 清理已拷贝模型目录中的开发辅助文件（建模工具常混入的生成脚本/规划 JSON）。 */
function pruneDevArtifacts(modelDir, modelName) {
  const walk = (d) => {
    for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, ent.name);
      if (ent.isDirectory()) walk(p);
      else if (isDevArtifact(path.relative(modelDir, p))) {
        fs.unlinkSync(p);
        const rel = path.relative(modelDir, p).split(path.sep).join('/');
        console.log(`[import-model]     清理开发辅助文件 ${modelName}/${rel}`);
      }
    }
  };
  walk(modelDir);
}

/** 统一分隔符；判断是否“外部/绝对”引用（URL、盘符、前导 /）。 */
function isExternalRef(ref) {
  return /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(ref) ||   // http:// https:// file:// ...
    /^[a-zA-Z]:[\\/]/.test(ref) ||                        // C:\ C:/
    ref.startsWith('/');                                  // /abs
}

// ---------------------------------------------------------------- 收集种子模型

console.log('[import-model] ===== 1/4 收集模型种子 =====');
console.log(`[import-model] 种子目录: ${SEED_MODELS}`);

const seedEntries = (fs.existsSync(SEED_MODELS) && fs.statSync(SEED_MODELS).isDirectory())
  ? fs.readdirSync(SEED_MODELS, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort()
  : [];

const modelDirs = [];
for (const name of seedEntries) {
  const dir = path.join(SEED_MODELS, name);
  const m3 = findModel3Files(dir);
  if (m3.length > 0) modelDirs.push({ name, dir, model3Files: m3 });
}

if (modelDirs.length === 0) {
  // 不是错误：模型通常已经在用户模型目录（%APPDATA%/pet-desktop-app/live2d-models）。
  // 这一步只重建语料与本地资产，随后照常把 models.json 清空。
  console.log('[import-model]   种子目录里没有模型（正常：模型已在用户模型目录）。');
  console.log('[import-model]   要内置种子：把模型文件夹放进 local-assets/live2d_models/<模型名>/');
} else {
  console.log(`[import-model] 发现种子模型 ${modelDirs.length} 个: ${modelDirs.map((m) => m.name).join(' / ')}`);
}

// ---------------------------------------------------------------- 清空并拷贝

console.log('\n[import-model] ===== 2/4 清空目标并深拷贝 =====');
console.log(`[import-model] 目标: ${PUBLIC_ASSETS}`);

fs.rmSync(PUBLIC_ASSETS, { recursive: true, force: true });
fs.mkdirSync(PUBLIC_ASSETS, { recursive: true });

for (const m of modelDirs) {
  const dest = path.join(PUBLIC_ASSETS, m.name);
  fs.cpSync(m.dir, dest, { recursive: true }); // 深拷贝整个模型目录
  console.log(`[import-model]   已拷贝种子模型 ${m.name}/`);
  pruneDevArtifacts(dest, m.name); // 去掉建模/生成过程的开发辅助文件，只留运行时资产
}

// ---- 知识语料目录（与模型目录并列，不写入 models.json）----
// 来源：工程内 personas/（人设与通用台词池）。随后的 local-assets/ 合并步骤会再覆盖一层，
// 所以 local-assets/knowledge/ 里放同名文件即可扩充/覆盖语料。
const destKnow = path.join(PUBLIC_ASSETS, 'knowledge');
let knowledgeCopied = false;
if (fs.existsSync(PERSONAS_LOCAL) && fs.statSync(PERSONAS_LOCAL).isDirectory()) {
  if (path.resolve(PERSONAS_LOCAL) !== path.resolve(destKnow)) {
    fs.mkdirSync(destKnow, { recursive: true });
    fs.cpSync(PERSONAS_LOCAL, destKnow, { recursive: true }); // 合并覆盖
    knowledgeCopied = true;
  }
}
if (knowledgeCopied) {
  const files = fs.readdirSync(destKnow, { recursive: true }).filter((f) => fs.statSync(path.join(destKnow, f)).isFile());
  knowledgeReport = { fileCount: files.length, sizeMB: dirSizeMb(destKnow) };
  console.log(`[import-model]   已就绪 knowledge/（AI 语料 ${knowledgeReport.fileCount} 个文件，${knowledgeReport.sizeMB.toFixed(1)} MB；来自 personas/；不进 models.json）`);
} else {
  console.log('[import-model]   personas/ 不存在，知识语料跳过（不报错）。');
}

// ---- 本地资产覆盖层 local-assets/（最后合并，优先级最高）----
// 本脚本会先清空 public/assets/，所以"不来自种子模型"的资产都要放 local-assets/，否则重跑就丢：
//   local-assets/live2d_models/<模型名>/...  → 已在第 1 步按"种子模型"处理
//   local-assets/model-order.json            → 配置，不合并
//   local-assets/<其它路径>/...              → 原样合并进 public/assets/<同路径>（覆盖同名文件）
const LOCAL_ASSETS = path.join(PROJECT_ROOT, 'local-assets');
if (fs.existsSync(LOCAL_ASSETS) && fs.statSync(LOCAL_ASSETS).isDirectory()) {
  for (const ent of fs.readdirSync(LOCAL_ASSETS, { withFileTypes: true })) {
    if (ent.name === 'live2d_models') continue; // 已按"种子模型"处理
    if (ent.name === 'model-order.json') continue; // 配置文件，不合并进 public/assets
    fs.cpSync(path.join(LOCAL_ASSETS, ent.name), path.join(PUBLIC_ASSETS, ent.name), { recursive: true });
    console.log(`[import-model]   已合并本地资产 ${ent.name}（来自 local-assets，覆盖同名文件）`);
  }
}

// ---- 模型顺序：默认模型 = models.json 第一项，因此顺序要能显式控制 ----
// local-assets/model-order.json（可选）示例：["<模型名A>","<模型名B>"]
// 只写"种子目录里真实存在"的模型名；未列出的保持原有相对顺序、追加在后。
// 注意：种子为空时这里无事可做（顺序由运行期的用户模型 .order.json 决定）。
const orderPath = path.join(LOCAL_ASSETS, 'model-order.json');
if (fs.existsSync(orderPath) && modelDirs.length > 0) {
  try {
    const wanted = JSON.parse(fs.readFileSync(orderPath, 'utf8'));
    if (Array.isArray(wanted) && wanted.length > 0) {
      const rank = new Map(wanted.map((n, i) => [String(n), i]));
      modelDirs.sort((a, b) => {
        const ra = rank.has(a.name) ? rank.get(a.name) : wanted.length;
        const rb = rank.has(b.name) ? rank.get(b.name) : wanted.length;
        return ra - rb;
      });
      // 提示写了但实际不存在的模型名，避免"顺序没生效"却查不出原因
      const missing = wanted.filter((n) => !modelDirs.some((m) => m.name === String(n)));
      if (missing.length) {
        console.warn(`[import-model]   WARN: model-order.json 里的模型不在种子目录，已忽略：${missing.join(' / ')}`);
      }
      console.log(`[import-model]   已按 local-assets/model-order.json 排序模型：${modelDirs.map((m) => m.name).join(' > ')}`);
      console.log(`[import-model]   （默认模型 = 清单第一项 = ${modelDirs[0].name}）`);
    }
  } catch (err) {
    console.warn(`[import-model]   WARN: 读取 local-assets/model-order.json 失败，沿用默认顺序：${err.message}`);
  }
}

// ---------------------------------------------------------------- 引用校验/重写 + 生成 models.json

console.log('\n[import-model] ===== 3/4 校验并规范化 .model3.json 引用 =====');

/**
 * 处理单个 .model3.json（已拷贝到 public/assets/<模型>/ 下的那份）：
 *   - 读取 UTF-8 → JSON.parse
 *   - 遍历 FileReferences 里的文件引用（值非空字符串才处理）
 *   - 若引用含反斜杠/绝对路径等异常 → 重写为相对本目录的 ./ 形式；正常相对引用原样保留
 *     （模型目录被整体拷贝，相对关系不变即寻址正确）
 *   - 逐一校验解析后的文件真实存在
 * @returns {{name:string, file:string, type:'moc3'|'portrait', total:number, ok:number,
 *            missing:{source:string,ref:string}[] , external:string[]}}
 */
function processModel3(absModel3Path, displayName) {
  const dir = path.dirname(absModel3Path);
  const raw = fs.readFileSync(absModel3Path, 'utf8');
  const doc = JSON.parse(raw);
  const fr = (doc && typeof doc.FileReferences === 'object') ? doc.FileReferences : {};

  const refs = []; // { source, ref(原文), normalized, absolute, exists? }
  const apply = (container, key, source) => {
    const val = container && container[key];
    if (typeof val !== 'string' || val.trim() === '') return; // 如 DisplayInfo:"" 属正常缺省
    let normalized = val.replace(/\\/g, '/');
    const external = isExternalRef(normalized);
    const rec = { source, ref: val, external };
    if (external) {
      refs.push(rec);
      return; // 外部 URL / 绝对路径：无法按本地文件校验，仅记录
    }
    // 解析后相对本 .model3.json 所在目录；若解析异常则记录 external
    const resolved = path.resolve(dir, ...normalized.split('/'));
    rec.resolved = resolved;
    rec.exists = fs.existsSync(resolved);
    refs.push(rec);
    // 需要重写的情形：出现反斜杠分隔（统一为 /）。正常相对引用不动。
    if (normalized !== val) {
      container[key] = './' + normalized.replace(/^\.\//, '');
    }
  };

  apply(fr, 'Moc', 'FileReferences.Moc');
  apply(fr, 'Physics', 'FileReferences.Physics');
  apply(fr, 'DisplayInfo', 'FileReferences.DisplayInfo');
  apply(fr, 'UserData', 'FileReferences.UserData');
  if (Array.isArray(fr.Textures)) {
    fr.Textures.forEach((_, i) => apply(fr.Textures, i, `FileReferences.Textures[${i}]`));
  }
  if (Array.isArray(fr.Expressions)) {
    fr.Expressions.forEach((e, i) => apply(e, 'File', `FileReferences.Expressions[${i}].File`));
  }
  const motions = fr.Motions;
  if (motions && typeof motions === 'object') {
    for (const group of Object.keys(motions)) {
      const arr = motions[group];
      if (Array.isArray(arr)) {
        arr.forEach((m, i) => apply(m, 'File', `FileReferences.Motions.${group}[${i}].File`));
      }
    }
  }

  const missing = refs.filter((r) => !r.external && r.exists === false);
  const external = refs.filter((r) => r.external);
  const total = refs.length;
  const ok = refs.length - missing.length;
  const type = (typeof fr.Moc === 'string' && fr.Moc.trim() !== '') ? 'moc3' : 'portrait';

  // 仅在发生重写时回写（保持原文件字节，除非必要）
  // 注：JSON.stringify 会重新格式化（2 空格缩进），故仅当确有改动才写。
  const changed = refs.some((r) => r.external === false && r.ref !== r.ref.replace(/\\/g, '/'));
  if (changed) {
    fs.writeFileSync(absModel3Path, JSON.stringify(doc, null, 2) + '\n', 'utf8');
    console.log(`[import-model]   ${displayName}: 检测到异常引用，已重写为相对路径。`);
  }

  return { name: displayName, file: path.basename(absModel3Path), type, total, ok, missing, external };
}

const models = [];
const allReport = [];
let grandTotal = 0;
let grandOk = 0;

// 关键：校验/重写针对【拷贝后】public/assets/<模型>/ 下的 .model3.json（而非源目录那份），
// 保证引用解析与 model3Path 都落在打包/运行时可见的 public/assets 内。
for (const m of modelDirs) {
  const destDir = path.join(PUBLIC_ASSETS, m.name);
  const copied = findModel3Files(destDir); // 源目录已整体拷贝，结构应一致
  if (copied.length === 0) {
    console.warn(`[import-model]   WARN: 拷贝后的 ${m.name}/ 下未找到 .model3.json，跳过该模型记录。`);
    continue;
  }
  for (const absM3 of copied) {
    const rel = path.relative(PUBLIC_ASSETS, absM3); // 如 <模型名>/<模型名>.model3.json
    const r = processModel3(absM3, rel);
    r.absModel3 = absM3; // 留待末尾体积扫描
    allReport.push(r);
    grandTotal += r.total;
    grandOk += r.ok;
    // 每个 .model3.json 生成一条模型清单记录；model3Path 相对打包资源根 public/（运行时 assets/<模型>/...）
    models.push({
      name: m.name,
      dir: m.name,
      type: r.type,
      model3Path: 'assets/' + rel.split(path.sep).join('/'),
    });
  }
}

// 体积统一测量（拷贝完成后再算）
for (const r of allReport) {
  r.sizeMB = dirSizeMb(path.dirname(r.absModel3));
}

// 输出校验报告
for (const r of allReport) {
  const state = r.missing.length === 0 ? 'OK' : 'WARN';
  const missingTxt = r.missing.length
    ? '; 缺失 ' + r.missing.map((x) => `[${x.source}] ${x.ref}`).join(', ')
    : '';
  const extTxt = r.external.length ? `; 外部引用 ${r.external.length} 项(跳过本地校验)` : '';
  const sizeTxt = r.sizeMB != null ? ` (${r.sizeMB.toFixed(1)} MB)` : '';
  console.log(
    `[import-model]   [${state}] ${r.name}  type=${r.type}${sizeTxt}  引用 ${r.total} 项全部存在` +
    (r.ok === r.total ? '' : ` (缺失 ${r.total - r.ok})`) + missingTxt + extTxt
  );
}

// ---------------------------------------------------------------- models.json

console.log('\n[import-model] ===== 4/4 生成运行时模型清单 =====');
const manifestPath = path.join(PUBLIC_ASSETS, 'models.json');
const manifest = { models };
fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
console.log(`[import-model]   已生成 ${path.relative(PROJECT_ROOT, manifestPath)}`);
for (const m of manifest.models) {
  console.log(`[import-model]     - ${m.name}  (${m.type})  ${m.model3Path}`);
}

const missingAll = allReport.flatMap((r) => r.missing);
console.log('\n[import-model] ===== 汇总 =====');
console.log(
  `[import-model] 模型目录 ${modelDirs.length} 个 / 模型条目 ${allReport.length} 条` +
  ` / 引用共 ${grandTotal} 项，命中 ${grandOk} 项`
);
if (knowledgeReport) {
  console.log(`[import-model] 知识语料 knowledge/: ${knowledgeReport.fileCount} 个文件，${knowledgeReport.sizeMB.toFixed(1)} MB（独立于 models.json，由 chatClient 直读）`);
} else {
  console.log('[import-model] 知识语料 knowledge/: 未拷贝（personas/ 不存在，属正常跳过）');
}
if (modelDirs.length === 0) {
  console.log('[import-model] 本次没有种子模型（模型在用户模型目录里，属正常）。');
}
if (missingAll.length === 0) {
  console.log('[import-model] 全部引用校验 OK —— 导入完成。');
} else {
  console.warn(`[import-model] WARN: ${missingAll.length} 项引用缺失（已保留已拷贝文件，请人工核对源素材）。`);
}

// ---------------------------------------------------------------------------
// 收尾：项目**不内置模型**（用户 2026-09-21 确认）——导入完成后把模型搬到本机用户数据，
// 并把 public/assets/models.json 清空（新装用户初始模型表为空，靠"打开模型文件夹/添加模型"导入）。
// 这一步是幂等的：重复执行不会重复搬运。
// ---------------------------------------------------------------------------
try {
  const { spawnSync } = require('child_process');
  const mig = path.join(__dirname, 'migrate-models-to-userdata.js');
  if (fs.existsSync(mig)) {
    console.log('\n[import-model] 把模型交给用户数据（不再随包内置）…');
    const r = spawnSync(process.execPath, [mig], { stdio: 'inherit' });
    if (r.status !== 0) console.warn('[import-model] WARN: 模型迁移步骤退出码', r.status);
  }
} catch (err) {
  console.warn('[import-model] WARN: 模型迁移步骤失败：', err && err.message ? err.message : err);
}
