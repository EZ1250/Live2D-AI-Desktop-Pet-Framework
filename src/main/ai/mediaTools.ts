/**
 * mediaTools.ts — 媒体控制（播放/暂停、切歌、音量、静音）
 *
 * **不针对任何具体播放器**：Spotify / 网易云 / B站 / 浏览器视频各不相同，而且用户可能同时开着几个。
 * 所以这里发的是**系统媒体键**——Windows 会把它交给当前正在播放的那个程序，
 * 于是对任何播放器都有效，代码里不需要知道用户开的是什么。
 *
 * 实现：PowerShell + user32.dll 的 keybd_event。
 * **安全**：VK 码只能来自下面的白名单常量表，绝不把入参拼进脚本——脚本内容对同一 action 是常量，
 * 不存在命令注入面。
 *
 * 纯 Node 标准库实现，无第三方依赖；失败一律返回中文说明，不抛异常。
 */
import { execFile } from 'child_process';
import { platform } from 'os';

export interface MediaArgs {
  action?: unknown;
}

const ACTION_MAP: Record<string, { vk: number; label: string }> = {
  play_pause: { vk: 0xb3, label: '播放/暂停' },
  next: { vk: 0xb0, label: '下一首' },
  prev: { vk: 0xb1, label: '上一首' },
  stop: { vk: 0xb2, label: '停止' },
  volume_up: { vk: 0xaf, label: '音量 +' },
  volume_down: { vk: 0xae, label: '音量 −' },
  mute: { vk: 0xad, label: '静音开关' },
};

export const MEDIA_ACTIONS = Object.keys(ACTION_MAP);

export async function mediaControl(args: MediaArgs): Promise<string> {
  if (platform() !== 'win32') {
    return `媒体控制目前只在 Windows 上实现（当前平台：${platform()}）。`;
  }

  const action = args.action;

  // 必须用 hasOwnProperty：`action in ACTION_MAP` 对 'toString'/'constructor' 也会返回 true，
  // 那是从 Object.prototype 继承来的，取出的 vk 是 undefined，会发一个非法按键。
  if (typeof action !== 'string' || !Object.prototype.hasOwnProperty.call(ACTION_MAP, action)) {
    return `不认识的媒体操作：${action}。可用的是：${MEDIA_ACTIONS.join('、')}。`;
  }

  const { vk, label } = ACTION_MAP[action];

  const script = `
Add-Type -Namespace PetMedia -Name Keys -MemberDefinition '[DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);'
[PetMedia.Keys]::keybd_event(${vk}, 0, 0, [UIntPtr]::Zero)
[PetMedia.Keys]::keybd_event(${vk}, 0, 2, [UIntPtr]::Zero)
`;

  return new Promise((resolve) => {
    const child = execFile(
      'powershell',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      { timeout: 5000 },
      (error) => {
        if (error) {
          if (error.killed) {
            resolve('媒体键发送失败：执行超时。');
          } else {
            resolve(`媒体键发送失败：${error.message}`);
          }
        } else {
          resolve(`已发送「${label}」`);
        }
      }
    );

    child.on('error', (err) => {
      resolve(`媒体键发送失败：无法启动 PowerShell，${err.message}`);
    });
  });
}
