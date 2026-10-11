'use strict';
/** 将随包模型迁移到用户数据目录。 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const ASSETS = path.join(ROOT, 'public', 'assets');
const LOCAL_MODELS = path.join(ROOT, 'local-assets', 'live2d_models');
const LOCAL_KNOWLEDGE = path.join(ROOT, 'local-assets', 'knowledge');
const DRY = process.argv.includes('--dry-run');
const udArg = process.argv.indexOf('--userdata');
const USER_DATA = udArg > 0 && process.argv[udArg + 1]
  ? process.argv[udArg + 1]
  : path.join(process.env.APPDATA || process.env.HOME || '.', 'pet-desktop-app');
const USER_MODELS = path.join(USER_DATA, 'live2d-models');

const actions = [];
const notes = [];
function log(msg) { console.log(msg); actions.push(msg); }

/** 目录里是否有真正的 Live2D 模型描述（*.model3.json） */
function isModelDir(dir) {
  try {
    return fs.readdirSync(dir).some((f) => /\.model3\.json$/i.test(f));
  } catch {
    return false;
  }
}
function dirSizeMb(dir) {
  let sum = 0;
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else { try { sum += fs.statSync(full).size; } catch { /* ignore */ } }
    }
  };
  try { walk(dir); } catch { /* ignore */ }
  return Math.round((sum / 1024 / 1024) * 10) / 10;
}

/** 递归复制（保留结构），不覆盖已存在文件（除非 overwrite） */
function copyDir(src, dst, overwrite = false) {
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name);
    const d = path.join(dst, e.name);
    if (e.isDirectory()) copyDir(s, d, overwrite);
    else if (overwrite || !fs.existsSync(d)) fs.copyFileSync(s, d);
  }
}
/** 递归移动（跨盘时退化为复制+删除） */
function moveDir(src, dst) {
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  if (fs.existsSync(dst)) { copyDir(src, dst); fs.rmSync(src, { recursive: true, force: true }); return; }
  try {
    fs.renameSync(src, dst);
  } catch {
    copyDir(src, dst);
    fs.rmSync(src, { recursive: true, force: true });
  }
}

log(`用户数据目录：${USER_DATA}`);
log(`用户模型目录：${USER_MODELS}${DRY ? '（dry-run，不改动）' : ''}`);

/* 1) 收集要搬的模型：public/assets/<模型> + local-assets/live2d_models/<模型> */
const sources = [];
if (fs.existsSync(ASSETS)) {
  for (const e of fs.readdirSync(ASSETS, { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    const full = path.join(ASSETS, e.name);
    if (isModelDir(full)) sources.push({ name: e.name, dir: full, from: 'public/assets' });
  }
}
if (fs.existsSync(LOCAL_MODELS)) {
  for (const e of fs.readdirSync(LOCAL_MODELS, { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    const full = path.join(LOCAL_MODELS, e.name);
    if (isModelDir(full)) sources.push({ name: e.name, dir: full, from: 'local-assets/live2d_models' });
  }
}
log(`\n发现候选模型 ${sources.length} 个：` + (sources.map((s) => `${s.name}(${s.from} ${dirSizeMb(s.dir)}MB)`).join('、') || '（无）'));

/* 2) 搬到用户数据（同名已存在则合并，不覆盖已有文件）
      - public/assets 里的模型：**移动**（必须离开随包资源，否则又变回"内置模型"）
      - local-assets/live2d_models 里的：**只复制**（种子投放点；当前为空，机制保留 ——
        见 local-assets/live2d_models/README.md，随时放进去就能在全新机器一键恢复） */
let moved = 0;
let copied = 0;
for (const s of sources) {
  const dst = path.join(USER_MODELS, s.name);
  const isSeed = s.from === 'local-assets/live2d_models';
  if (!DRY) {
    if (isSeed) copyDir(s.dir, dst);
    else moveDir(s.dir, dst);
    // 随包资源里搬空后，删掉空壳目录
    try {
      if (!isSeed && fs.existsSync(s.dir) && fs.readdirSync(s.dir).length === 0) fs.rmSync(s.dir, { recursive: true, force: true });
    } catch { /* ignore */ }
  }
  if (isSeed) copied += 1;
  else moved += 1;
  log(`  ${isSeed ? '复制种子' : '搬入'}用户模型：${s.name}  ←  ${s.from}`);
}
if (!moved && !copied) log('  没有需要处理的模型（可能已经搬过了）');

/* 3) 模型专属语料：<模型名>.offline.txt 跟随模型目录；character.offline.txt 留在全局 */
const knowledgeDirs = [path.join(ASSETS, 'knowledge'), LOCAL_KNOWLEDGE].filter((d) => fs.existsSync(d));
for (const kd of knowledgeDirs) {
  for (const f of fs.readdirSync(kd)) {
    if (!/\.offline\.txt$/i.test(f)) continue;
    const base = f.replace(/\.offline\.txt$/i, '');
    if (base === 'character') { log(`  通用语料保留在全局：${path.relative(ROOT, path.join(kd, f))}`); continue; }
    const modelDir = path.join(USER_MODELS, base);
    if (!fs.existsSync(modelDir)) { notes.push(`语料 ${f} 没有同名模型目录，暂留原处（${path.relative(ROOT, kd)}）`); continue; }
    const dst = path.join(modelDir, 'knowledge', f);
    if (!DRY) {
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      // 每次覆盖，确保用户目录同步最新语料。
      const existed = fs.existsSync(dst);
      fs.copyFileSync(path.join(kd, f), dst);
      fs.rmSync(path.join(kd, f), { force: true }); // 原处删掉，避免两处不一致
      log(`  语料${existed ? '已更新' : '跟随模型'}：${f} → live2d-models/${base}/knowledge/`);
    } else {
      log(`  语料（dry-run）：${f} → live2d-models/${base}/knowledge/`);
    }
  }
}

/* 4) 随包模型表清空（"初始模型表应该是空"） */
const modelsJson = path.join(ASSETS, 'models.json');
if (fs.existsSync(modelsJson)) {
  if (!DRY) fs.writeFileSync(modelsJson, `${JSON.stringify({ models: [] }, null, 2)}\n`, 'utf8');
  log('  已清空 public/assets/models.json（初始模型表为空）');
}

/* 5) 旧的用户级预设：改名备份，让位于"模型目录里的 pet-model.json"（识别结果写在那里） */
const presetsDir = path.join(USER_DATA, 'live2d-presets');
if (fs.existsSync(presetsDir)) {
  for (const f of fs.readdirSync(presetsDir)) {
    if (!f.endsWith('.json')) continue;
    const from = path.join(presetsDir, f);
    const to = path.join(presetsDir, `${f}.migrated-bak`);
    if (!DRY && !fs.existsSync(to)) fs.renameSync(from, to);
    log(`  旧用户级预设改名（不再遮蔽模型目录内的预设）：${f} → ${f}.migrated-bak`);
  }
}

/* 6) 对每个用户模型做能力识别并写入 <模型>/pet-model.json */
let detected = 0;
if (!DRY) {
  let detect;
  try {
    // 在纯 Node 测试中将 userData 指向迁移目录。
    const Module = require('module');
    const origLoad = Module._load;
    Module._load = function (request) {
      if (request === 'electron') {
        return {
          app: { getPath: (n) => (n === 'userData' ? USER_DATA : USER_DATA), getAppPath: () => ROOT },
          shell: { openPath: async () => '' },
        };
      }
      return origLoad.apply(this, arguments);
    };
    detect = require(path.join(ROOT, 'dist', 'main', 'assets', 'userAssets.js'));
    Module._load = origLoad;
  } catch (err) {
    notes.push(`未能加载识别模块（先跑一次 tsc）：${err.message}`);
  }
  if (detect && typeof detect.listUserModels === 'function') {
    for (const m of detect.listUserModels()) {
      const r = detect.applyDetectedCapabilities(m.dir, m.name);
      if (r.ok && r.changed) {
        const caps = r.detection ? r.detection.capabilities : {};
        log(`  能力归类写入：${m.name} → ${JSON.stringify(caps)}`);
        detected += 1;
      } else if (!r.ok) {
        notes.push(`能力归类失败（${m.name}）：${r.error}`);
      } else {
        log(`  能力归类已是最新：${m.name}`);
      }
    }
  }
}

console.log('\n===== 迁移结果 =====');
console.log(`模型搬入：${moved} 个；能力归类写入：${detected} 个`);
if (notes.length) { console.log('注意：'); notes.forEach((n) => console.log('  - ' + n)); }
console.log(DRY ? '（dry-run：没有改动任何文件）' : '完成。');
