/** 模型可见工具定义（OpenAI tools 格式） */
export interface ToolDef {
  type: string;
  function: Record<string, unknown>;
}
