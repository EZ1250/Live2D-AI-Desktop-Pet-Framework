/** 检测连续重复的工具调用并生成提醒。 */
export interface ToolLoopGuardState {
  key: string;
  count: number;
}

export function createToolLoopGuard(): ToolLoopGuardState {
  return { key: '', count: 0 };
}

/** 规范化参数，确保对象键顺序不影响调用判定。 */
export function toolCallKey(name: string, args: unknown): string {
  const canon = (value: unknown): string => {
    if (value === null || value === undefined) return '';
    if (Array.isArray(value)) return `[${value.map(canon).join(',')}]`;
    if (typeof value === 'object') {
      const obj = value as Record<string, unknown>;
      return `{${Object.keys(obj)
        .sort()
        .map((k) => `${JSON.stringify(k)}:${canon(obj[k])}`)
        .join(',')}}`;
    }
    return JSON.stringify(value);
  };
  return `${name}\u0000${canon(args)}`;
}

/** 返回新的状态和可选提醒。 */
export function nextToolLoopGuard(
  state: ToolLoopGuardState,
  name: string,
  args: unknown,
): { state: ToolLoopGuardState; reminder: string | null } {
  const key = toolCallKey(name, args);
  const count = state.key === key ? state.count + 1 : 1;
  const next: ToolLoopGuardState = { key, count };
  let reminder: string | null = null;
  if (count === 3) {
    reminder = `你正在连续第 3 次用相同参数调用工具「${name}」。请先分析已有结果，换一种做法或结束这次任务。`;
  } else if (count === 5) {
    let preview = '';
    try {
      preview = JSON.stringify(args ?? {}).slice(0, 200);
    } catch {
      preview = '(参数无法序列化)';
    }
    reminder =
      `同一工具与参数已连续调用 5 次（工具：${name}，参数：${preview}），没有得到新进展。` +
      '请停止重复，明确告诉用户当前阻塞点或换一个方案。';
  }
  return { state: next, reminder };
}
