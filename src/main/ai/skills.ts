// src/main/ai/skills.ts —— 技能库（参考 ClaudeCode SkillTool 的 prompt 型技能）
// 技能 = 一份 Markdown（可选 front-matter：name / description），正文是给模型的步骤提示词。
// 搜索顺序：userData/skills（用户自定义，优先）→ <assetsRoot>/skills（随包分发）。
import * as fs from 'fs';
import * as path from 'path';

export interface SkillMeta {
  name: string;
  description: string;
}

export interface SkillFull extends SkillMeta {
  body: string;
  file: string;
}

export class SkillBox {
  private cache: SkillFull[] = [];

  constructor(private readonly dirs: string[]) {}

  /** 确保用户目录存在并载入技能（容错：目录不存在/文件非法都跳过） */
  load(): void {
    const found: SkillFull[] = [];
    const seen = new Set<string>();
    for (const dir of this.dirs) {
      try {
        if (!fs.existsSync(dir)) {
          if (dir === this.dirs[0]) fs.mkdirSync(dir, { recursive: true });
          continue;
        }
      } catch {
        continue;
      }
      let files: string[] = [];
      try {
        files = fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.md'));
      } catch {
        continue;
      }
      for (const file of files) {
        const full = path.join(dir, file);
        try {
          const parsed = parseSkill(fs.readFileSync(full, 'utf8'), path.basename(file, '.md'));
          if (!parsed.name || seen.has(parsed.name)) continue; // 用户目录优先（先遍历先占位）
          seen.add(parsed.name);
          found.push({ ...parsed, file: full });
        } catch {
          /* 单个技能文件损坏不影响其它 */
        }
      }
    }
    this.cache = found;
  }

  list(): SkillMeta[] {
    return this.cache.map((s) => ({ name: s.name, description: s.description }));
  }

  get(name: string): SkillFull | null {
    const key = name.trim();
    return this.cache.find((s) => s.name === key) ?? null;
  }

  /** 注入 system prompt 的技能清单（无技能返回空串） */
  catalogText(): string {
    if (!this.cache.length) return '';
    return `\n\n可用技能（需要时用 skill_use 获取完整步骤）：\n${this.cache
      .map((s) => `- ${s.name}：${s.description}`)
      .join('\n')}`;
  }
}

/** 解析技能 Markdown：支持 --- front-matter 的 name/description；否则用文件名与首行 */
function parseSkill(content: string, defaultName: string): SkillMeta & { body: string } {
  const lines = content.replace(/^\uFEFF/, '').split(/\r?\n/);
  let name = defaultName;
  let description = '';
  let bodyStart = 0;
  if (lines[0]?.trim() === '---') {
    let i = 1;
    for (; i < lines.length; i++) {
      const line = lines[i].trim();
      if (line === '---') {
        i++;
        break;
      }
      const m = /^(name|description)\s*[:：]\s*(.+)$/i.exec(line);
      if (m) {
        const val = m[2].trim().replace(/^["']|["']$/g, '');
        if (m[1].toLowerCase() === 'name') name = val || name;
        else description = val;
      }
    }
    bodyStart = i;
  }
  if (!description) {
    for (let i = bodyStart; i < lines.length; i++) {
      const line = lines[i].trim();
      if (line && !line.startsWith('#')) {
        description = line.slice(0, 80);
        break;
      }
    }
  }
  return { name, description: description || '（无描述）', body: lines.slice(bodyStart).join('\n').trim() };
}
