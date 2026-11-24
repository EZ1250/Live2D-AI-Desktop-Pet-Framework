import type { ToolDef } from '../types';

/** 内置 Windows 电脑控制工具（不依赖 DSH 插件；UIA + PetMouse 助手） */
export const tool_computer_list_windows: ToolDef = {
  type: 'function',
  function: {
    name: 'computer_list_windows',
    description: '列出当前 Windows 顶层窗口（标题/类名/进程/坐标/是否前台）。只读；可先用它拿 hwnd 再做 UI 操作。',
    parameters: {
      type: 'object',
      properties: {
        filter: { type: 'string', description: '可选：窗口标题包含的文本' },
        limit: { type: 'number', description: '最多返回多少个窗口（默认 30，最大 100）' },
      },
    },
  },
};

export const tool_computer_ui_tree: ToolDef = {
  type: 'function',
  function: {
    name: 'computer_ui_tree',
    description: '读取指定窗口的 UI Automation 控件树（简化 JSON：名称/类型/automationId/类/边界/是否可用）。用于定位按钮、输入框等。',
    parameters: {
      type: 'object',
      properties: {
        hwnd: { type: 'number', description: '窗口句柄（computer_list_windows 返回）' },
        depth: { type: 'number', description: '最大深度，默认 4' },
        max_nodes: { type: 'number', description: '最多节点数，默认 500' },
      },
      required: ['hwnd'],
    },
  },
};

const selectorProps = {
  hwnd: { type: 'number', description: '目标窗口句柄' },
  name: { type: 'string', description: '控件显示名（Name），可空' },
  control_type: { type: 'string', description: '控件类型，如 Edit/Button/Text/Document，可空' },
  automation_id: { type: 'string', description: 'AutomationId，可空' },
  class_name: { type: 'string', description: '类名，可空' },
  index: { type: 'number', description: '同类匹配的第几个（从 0 开始，默认 0）' },
};

export const tool_computer_ui_find: ToolDef = {
  type: 'function',
  function: {
    name: 'computer_ui_find',
    description: '在指定窗口里查找 UI 控件，返回匹配控件的名称/类型/边界/可用操作（invoke/value/scroll 等）。只读。',
    parameters: {
      type: 'object',
      properties: { ...selectorProps, limit: { type: 'number', description: '最多返回几个，默认 10' } },
      required: ['hwnd'],
    },
  },
};

export const tool_computer_window_activate: ToolDef = {
  type: 'function',
  function: {
    name: 'computer_window_activate',
    description: '把指定窗口恢复并切到前台（用于后续键盘/鼠标操作）。会弹确认。',
    parameters: { type: 'object', properties: { hwnd: selectorProps.hwnd }, required: ['hwnd'] },
  },
};

export const tool_computer_ui_click: ToolDef = {
  type: 'function',
  function: {
    name: 'computer_ui_click',
    description: '点击指定窗口里的控件：优先 InvokePattern，否则切前台后点击控件中心。会弹确认。',
    parameters: {
      type: 'object',
      properties: { ...selectorProps, button: { type: 'string', enum: ['left', 'right'], description: '默认 left' } },
      required: ['hwnd'],
    },
  },
};

export const tool_computer_ui_type: ToolDef = {
  type: 'function',
  function: {
    name: 'computer_ui_type',
    description: '向指定输入框写入文字（优先 ValuePattern，否则聚焦后用剪贴板输入）；不传 selector 时输入到当前焦点。会弹确认。',
    parameters: {
      type: 'object',
      properties: { ...selectorProps, text: { type: 'string', description: '要输入的文字' } },
      required: ['text'],
    },
  },
};

export const tool_computer_key_press: ToolDef = {
  type: 'function',
  function: {
    name: 'computer_key_press',
    description: '发送键盘按键/组合键，例如 "ctrl+a"、"alt+tab"、"enter"、"f5"。会弹确认。',
    parameters: {
      type: 'object',
      properties: { keys: { type: 'string', description: '组合键字符串，+ 连接' } },
      required: ['keys'],
    },
  },
};

export const tool_computer_mouse_scroll: ToolDef = {
  type: 'function',
  function: {
    name: 'computer_mouse_scroll',
    description: '在指定 DIP 坐标（或当前鼠标位置）滚动鼠标滚轮；delta>0 向上，<0 向下。会弹确认。',
    parameters: {
      type: 'object',
      properties: {
        x: { type: 'number', description: '可选 DIP x' },
        y: { type: 'number', description: '可选 DIP y' },
        delta: { type: 'number', description: '滚动格数，默认 3' },
        horizontal: { type: 'boolean', description: '是否横向滚动' },
      },
    },
  },
};

export const tool_computer_screen_click: ToolDef = {
  type: 'function',
  function: {
    name: 'computer_screen_click',
    description: '按屏幕 DIP 坐标单击/双击/右键（适合截图后视觉定位）。会弹确认。',
    parameters: {
      type: 'object',
      properties: {
        x: { type: 'number' },
        y: { type: 'number' },
        button: { type: 'string', enum: ['left', 'right'] },
        double: { type: 'boolean' },
      },
      required: ['x', 'y'],
    },
  },
};
