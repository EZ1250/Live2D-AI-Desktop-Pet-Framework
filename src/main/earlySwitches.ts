/**
 * earlySwitches.ts —— 必须在「任何 app ready / 创建窗口之前」落到命令行上的开关
 *
 * 为什么单独一个模块：Chromium 只在**进程命令行**上读 autoplay-policy，一旦 app ready
 * （或已经创建过 window）再 appendSwitch 就不再生效。module 顶层副作用 + 被 main.ts /
 * mainImpl.js 在其它 import 之前 require，能保证时序最早且幂等。
 *
 * 注意（实测结论，别被"必须加开关"的说法带偏）：
 *   - Electron 31 的 `webPreferences.autoplayPolicy` 默认就是 no-user-gesture-required，
 *     所以这个开关本身**不是**"试听无声"的根因；
 *   - 真正的根因是 CSP：TTS 音频是 `data:audio/mpeg` 的 data URL，而页面 CSP 的
 *     media-src 只放了 'self' blob: —— 见 src/main/staticServer.ts 的 HTML_CSP 与
 *     src/renderer/index.html 的 meta CSP（两处都要允许 data:）。
 *   - 保留这个开关 + 每个窗口显式 autoplayPolicy，是给"将来收紧策略/别的运行环境"兜底。
 */
import { app } from 'electron';

export const AUTOPLAY_POLICY_SWITCH = 'autoplay-policy';
export const AUTOPLAY_POLICY_VALUE = 'no-user-gesture-required';

/** 本进程是否已经装过（appendSwitch 幂等，这里只是让日志/自检可读） */
let installed = false;

/**
 * 装自动播放开关；重复调用无副作用。
 * app ready 之后再调用不会抛错但也不再生效，所以要保证调用点在入口最前面。
 */
export function installEarlySwitches(): void {
  if (installed) return;
  installed = true;
  try {
    // 已经有同值开关（例如启动命令里带过 --autoplay-policy）就不重复加
    const current = app.commandLine.getSwitchValue(AUTOPLAY_POLICY_SWITCH);
    if (current !== AUTOPLAY_POLICY_VALUE) {
      app.commandLine.appendSwitch(AUTOPLAY_POLICY_SWITCH, AUTOPLAY_POLICY_VALUE);
    }
  } catch (err) {
    console.warn('[main] 设置自动播放策略失败（语音可能需要先点一下页面）：', err instanceof Error ? err.message : err);
  }
}

/** 自检用：本进程是否装过开关、当前命令行值 */
export function earlySwitchesState(): { installed: boolean; autoplayPolicy: string } {
  let autoplayPolicy = '';
  try {
    autoplayPolicy = app.commandLine.getSwitchValue(AUTOPLAY_POLICY_SWITCH);
  } catch {
    /* app 不可用（测试桩）时按空处理 */
  }
  return { installed, autoplayPolicy };
}

// 模块被 require 时立刻生效：这就是"最早"的那一步。
installEarlySwitches();
