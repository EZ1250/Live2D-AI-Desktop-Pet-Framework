# CastCap.exe —— 手机投屏原生抓屏助手

- 源文件：`CastCap.cs`（本目录）
- 编译（Windows，.NET Framework 4.x）：
  ```bat
  C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe /nologo /target:exe /out:CastCap.exe /r:System.Drawing.dll /r:System.Windows.Forms.dll CastCap.cs
  ```
- 协议：stdout 连续输出 `[4 字节 little-endian 长度][JPEG]`；stderr 输出 `frames=... fps=...`。
- 运行时由 `src/main/ai/castCapture.ts` 启动；打包通过 `electron-builder.yml` 的 extraResources 放到
  `resources/cast-cap/CastCap.exe`。
- 实测：1280x800 JPEG q55，目标 30fps 调度，PC 端 MCP WS 收到约 **27.7fps**（帧 ~51KB，1280px q55）。
  比 renderer Canvas 编码（约 16~20fps）明显快；旧电脑端没有此助手时 App 会回退 renderer 抓屏。
