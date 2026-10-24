import type { ToolDef } from '../types';

/** 媒体与截屏（拆分前同属 chatClient 的 TOOL_DEFS） */
export const tool_media_control: ToolDef = {
    type: 'function',
    function: {
      name: 'media_control',
      description:
        '控制当前正在播放的音乐/视频：播放暂停、上一首下一首、停止、音量增减、静音。发的是**系统媒体键**，所以对任意播放器都有效（含浏览器里的视频），你不需要知道用户在用什么软件。只在用户明确要求控制播放时用（"暂停一下""下一首""声音小一点"），不要主动调音量。',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            description: 'play_pause（播放/暂停）/ next（下一首）/ prev（上一首）/ stop / volume_up / volume_down / mute',
          },
        },
        required: ['action'],
      },
    },
  };
export const tool_screen_capture: ToolDef = {
    type: 'function',
    function: {
      name: 'screen_capture',
      description:
        '截取整个屏幕并保存成 PNG（用户说"截个图""把屏幕拍下来"时用）。默认存到图片文件夹下的「Pet截图」。多显示器可以用 display 指定第几块屏。截的是屏幕，不是应用自己的窗口。',
      parameters: {
        type: 'object',
        properties: {
          display: { type: 'number', description: '第几块屏幕，从 1 开始（默认 1）' },
          save_path: { type: 'string', description: '可选：绝对路径。给目录则自动命名，给 .png 结尾的完整路径则用它' },
        },
      },
    },
  };
