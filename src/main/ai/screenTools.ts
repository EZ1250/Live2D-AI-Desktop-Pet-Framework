// 这个模块用于截取整个屏幕的内容，供桌面宠物应用调用。
// 使用 Electron 的 desktopCapturer API 实现全屏截图，支持多显示器。
// 设计上避免使用额外依赖，仅通过 Node.js 和 Electron 内置能力完成任务。
// 注意事项：
// - 必须指定 thumbnailSize 才能获取高清图像；
// - 要检查 source 是否为空或图像是否有效；
// - 用户输入不可信，需做参数校验和容错处理；
// - 文件保存要考虑路径合法性、重名处理及目录自动创建。

import { desktopCapturer, screen, app } from 'electron';
import * as fs from 'fs';
import * as path from 'path';

export interface CaptureArgs {
  save_path?: unknown;
  display?: unknown;
}

export async function captureScreen(args: CaptureArgs): Promise<string> {
  try {
    // 解析并验证 display 参数
    let displayIndex = 1;
    const rawDisplay = args.display;
    if (typeof rawDisplay === 'number' && Number.isInteger(rawDisplay) && rawDisplay >= 1) {
      displayIndex = rawDisplay;
    }

    const displays = screen.getAllDisplays();
    if (displays.length === 0) {
      return '无法获取屏幕信息，请确认连接了显示器。';
    }

    const targetDisplay = displays[displayIndex - 1] || displays[0];
    if (!targetDisplay) {
      return '未找到指定的屏幕设备。';
    }

    const width = Math.round(targetDisplay.size.width * targetDisplay.scaleFactor);
    const height = Math.round(targetDisplay.size.height * targetDisplay.scaleFactor);

    // 获取屏幕源数据
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width, height },
    });

    if (sources.length === 0) {
      return '未能捕获到屏幕画面，请检查权限或当前环境是否允许截屏。';
    }

    // 匹配对应 display_id 或默认第一个
    let matchedSource = sources.find(s => s.display_id === targetDisplay.id.toString());
    if (!matchedSource) {
      matchedSource = sources[0];
    }

    if (!matchedSource) {
      return '找不到可用的屏幕资源。';
    }

    const image = matchedSource.thumbnail;
    if (image.isEmpty()) {
      return '截取的图像为空，请稍后重试。';
    }

    const buffer = image.toPNG();

    // 处理保存路径
    let saveDir: string;
    // 必须先初始化：下面只在"给了完整 .png 路径"时赋值，其余分支靠空串走默认命名
    let fileName = '';

    const rawSavePath = args.save_path;
    if (typeof rawSavePath === 'string' && path.isAbsolute(rawSavePath)) {
      if (rawSavePath.endsWith('.png')) {
        saveDir = path.dirname(rawSavePath);
        fileName = path.basename(rawSavePath);
      } else {
        try {
          const stat = fs.statSync(rawSavePath);
          if (stat.isDirectory()) {
            saveDir = rawSavePath;
          } else {
            saveDir = path.join(app.getPath('pictures'), 'Pet截图');
          }
        } catch {
          saveDir = path.join(app.getPath('pictures'), 'Pet截图');
        }
      }
    } else {
      saveDir = path.join(app.getPath('pictures'), 'Pet截图');
    }

    if (!fileName) {
      const now = new Date();
      const dateStr = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;
      const timeStr = `${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}${String(now.getSeconds()).padStart(2, '0')}`;
      fileName = `桌宠截图-${dateStr}-${timeStr}.png`;
    }

    try {
      fs.mkdirSync(saveDir, { recursive: true });
    } catch (err: any) {
      return `无法创建截图目录 "${saveDir}"：${err.message || '未知错误'}`;
    }

    let finalPath = path.join(saveDir, fileName);
    let counter = 2;
    while (fs.existsSync(finalPath)) {
      const nameWithoutExt = path.parse(fileName).name;
      const ext = path.extname(fileName);
      finalPath = path.join(saveDir, `${nameWithoutExt}-${counter}${ext}`);
      counter++;
    }

    try {
      fs.writeFileSync(finalPath, buffer);
    } catch (err: any) {
      return `写入文件失败 "${finalPath}"：${err.message || '未知错误'}`;
    }

    const sizeInMB = (buffer.byteLength / (1024 * 1024)).toFixed(1);
    return `已截屏并保存：${finalPath}（${width}×${height}，${sizeInMB} MB）`;

  } catch (err: any) {
    return `执行截屏过程中发生异常：${err.message || '未知错误'}`;
  }
}
