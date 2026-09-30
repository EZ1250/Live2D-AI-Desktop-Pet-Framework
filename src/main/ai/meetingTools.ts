// 设计为无网络、无授权方式添加日程，适用于快速语音输入场景。
// 坑点：
// - 浮动时间必须用本地格式，不能带时区标识；
// - 文本需按 RFC 5545 转义；
// - 文件名要做安全处理防止非法字符导致写入失败；
// - openPath 返回非空字符串代表错误，要提示用户手动操作。

import { app, shell } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';

export interface MeetingArgs {
  title?: unknown;
  start?: unknown;
  duration_minutes?: unknown;
  location?: unknown;
  description?: unknown;
}

export async function meetingCreate(args: MeetingArgs): Promise<string> {
  // 校验标题
  if (typeof args.title !== 'string' || args.title.trim() === '' || args.title.length > 120) {
    return '会议标题不能为空且不超过120字';
  }
  const title = args.title.trim();

  // 解析开始时间
  let startDate: Date | null = null;
  if (typeof args.start === 'string') {
    if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(args.start)) {
      startDate = new Date(args.start.replace(' ', 'T'));
    } else {
      startDate = new Date(args.start);
    }
  }
  if (!startDate || isNaN(startDate.getTime())) {
    return `时间看不懂：${args.start}。请用 2026-09-30 15:00 这样的写法。`;
  }

  // 处理持续时间
  let durationMinutes = 60;
  if (typeof args.duration_minutes === 'number' && args.duration_minutes >= 5 && args.duration_minutes <= 480) {
    durationMinutes = Math.floor(args.duration_minutes);
  }

  // 构造结束时间
  const endDate = new Date(startDate.getTime() + durationMinutes * 60 * 1000);

  // 可选字段处理
  let locationStr = '';
  if (typeof args.location === 'string' && args.location.length <= 500) {
    locationStr = escapeIcsText(args.location);
  }

  let descriptionStr = '';
  if (typeof args.description === 'string' && args.description.length <= 500) {
    descriptionStr = escapeIcsText(args.description);
  }

  // 准备 ICS 内容
  const uid = crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).substring(2)}`;
  const dtstamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  const dtstart = formatFloatingTime(startDate);
  const dtend = formatFloatingTime(endDate);
  const summary = escapeIcsText(title);

  const icsContent =
    'BEGIN:VCALENDAR\r\n' +
    'VERSION:2.0\r\n' +
    'PRODID:-//PetDesktop//Meeting//CN\r\n' +
    'BEGIN:VEVENT\r\n' +
    `UID:${uid}@pet-desktop\r\n` +
    `DTSTAMP:${dtstamp}\r\n` +
    `DTSTART:${dtstart}\r\n` +
    `DTEND:${dtend}\r\n` +
    `SUMMARY:${summary}\r\n` +
    (locationStr ? `LOCATION:${locationStr}\r\n` : '') +
    (descriptionStr ? `DESCRIPTION:${descriptionStr}\r\n` : '') +
    'END:VEVENT\r\n' +
    // 结尾也要 CRLF：RFC 5545 的内容行以 CRLF 分隔，严格的解析器（Outlook 某些版本）
    // 对"最后一行没有换行"会报格式错误。多余一个换行是无害的。
    'END:VCALENDAR\r\n';

  // 创建保存路径
  const tempDir = path.join(app.getPath('temp'), 'Pet会议');
  try {
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }
  } catch (e) {
    return '无法创建临时目录，请检查权限';
  }

  // 安全化标题作为文件名
  const safeTitle = title.replace(/[\\/:*?"<>|]/g, '_') || 'meeting';
  const baseName = `${safeTitle}-${formatFilenameTime(startDate)}`;
  let fileName = `${baseName}.ics`;
  let fullPath = path.join(tempDir, fileName);
  let counter = 2;

  while (fs.existsSync(fullPath)) {
    fileName = `${baseName}-${counter}.ics`;
    fullPath = path.join(tempDir, fileName);
    counter++;
  }

  // 写入文件
  try {
    fs.writeFileSync(fullPath, icsContent, 'utf-8');
  } catch (e) {
    return `写入日程文件失败：${fullPath}`;
  }

  // 打开文件
  const result = await shell.openPath(fullPath);
  if (result) {
    return `日程已生成但没能自动打开（${result}）。文件在这里：${fullPath}，双击即可导入。`;
  }

  // 成功返回信息
  const formattedStart = startDate.toLocaleString('zh-CN', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  });

  return `已生成日程：${formattedStart}（${durationMinutes} 分钟）\n文件：${fullPath}\n已交给系统日历，确认导入即可。`;
}

function escapeIcsText(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/,/g, '\\,').replace(/;/g, '\\;').replace(/\n/g, '\\n');
}

function formatFloatingTime(date: Date): string {
  return date.getFullYear() +
    String(date.getMonth() + 1).padStart(2, '0') +
    String(date.getDate()).padStart(2, '0') +
    'T' +
    String(date.getHours()).padStart(2, '0') +
    String(date.getMinutes()).padStart(2, '0') +
    String(date.getSeconds()).padStart(2, '0');
}

function formatFilenameTime(date: Date): string {
  return date.getFullYear() +
    String(date.getMonth() + 1).padStart(2, '0') +
    String(date.getDate()).padStart(2, '0') +
    '-' +
    String(date.getHours()).padStart(2, '0') +
    String(date.getMinutes()).padStart(2, '0') +
    String(date.getSeconds()).padStart(2, '0');
}
