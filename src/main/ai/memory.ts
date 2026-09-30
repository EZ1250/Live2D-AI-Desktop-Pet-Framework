/**
 * memory —— 项目记忆与用户长期偏好（对齐成熟 CLI 助手的 CLAUDE.md / memdir 机制）
 *
 * 会话开始时把下面两类文本注入 system prompt，让 AI 知道"这个项目的约定"和"主人的长期偏好"：
 *  - 项目记忆：工作区根目录里的 AGENTS.md → PET.md → CLAUDE.md → README.md（取第一个存在的）
 *  - 用户记忆：<userData>/memory.md
 *
 * 单份最多 6000 字符、合计最多 12000 字符（超出加"已截断"标记）；任何错误都只是少给一段内容，绝不抛异常。
 * 不 import electron（路径由调用方传入，便于无头测试）。
 */
import * as fs from 'fs';
import * as path from 'path';

const PER_FILE_LIMIT = 6000;
const TOTAL_LIMIT = 12000;
const PROJECT_MEMORY_FILES = ['AGENTS.md', 'PET.md', 'CLAUDE.md', 'README.md'];

interface MemoryPart {
  label: string;
  file: string;
  text: string;
}

function readOne(dir: string, file: string): string {
  try {
    const full = path.join(dir, file);
    if (!fs.existsSync(full) || !fs.statSync(full).isFile()) return '';
    const raw = fs.readFileSync(full, 'utf8').replace(/^\uFEFF/, '').normalize('NFC').trim();
    if (!raw) return '';
    return raw.length > PER_FILE_LIMIT ? `${raw.slice(0, PER_FILE_LIMIT)}\n…（已截断）` : raw;
  } catch {
    return '';
  }
}

/** 读取并返回要注入 system prompt 的记忆文本（含来源标注）；没有则返回空串 */
export function loadMemoryText(workspaceRoot: string, userDataDir: string): string {
  const parts: MemoryPart[] = [];
  try {
    for (const file of PROJECT_MEMORY_FILES) {
      const text = readOne(workspaceRoot, file);
      if (text) {
        parts.push({ label: '项目记忆', file, text });
        break; // 只取第一个存在的项目记忆文件，避免 README 把 AGENTS.md 的约定淹掉
      }
    }
    const userText = readOne(userDataDir, 'memory.md');
    if (userText) parts.push({ label: '用户记忆', file: 'memory.md', text: userText });
  } catch {
    /* 下面按已拿到的部分拼 */
  }

  let out = '';
  for (const part of parts) {
    const segment = `【${part.label}：${part.file}】\n${part.text}\n`;
    if (out.length + segment.length > TOTAL_LIMIT) {
      const room = TOTAL_LIMIT - out.length;
      if (room > 200) out += `${segment.slice(0, room)}\n…（记忆总量已达上限，已截断）\n`;
      break;
    }
    out += segment;
  }
  return out;
}
