# Pet 便携版运行说明

本文档由 `scripts/build-portable.js` 自动生成（对应版本 **1.0.0**）。

## 怎么用

1. 找到便携 exe：`release/Pet-1.0.0-portable.exe`（构建产物仅在 release/，不再自动复制到桌面）。
2. **U 盘即插即用**：把整个 exe 拷进 U 盘，在任意 Windows 电脑上双击即可运行——
   无需安装 Node / npm / 任何运行时依赖，也无需安装（portable 免安装）。

## 三个产物，按需选

| 产物 | 体积 | 启动 | 要不要装 | 用途 |
|---|---|---|---|---|
| `release/Pet-1.0.0-setup.exe` | 约 71 MB | **最快**（装完 ≈0.5s） | 要装一次 | **默认推荐**：本机长期用；会自动建桌面/开始菜单快捷方式 |
| `release/Pet-1.0.0-portable.exe` | 约 71 MB | **慢**（每次启动解包） | 不用装 | 只有一个文件、可拷 U 盘时用 |
| `release/win-unpacked/` | 约 232 MB | **双击秒开**（不用解包） | 不用装 | 免安装；整个文件夹拷走即可用（比便携单文件快） |

> **便携单文件为什么慢**：它是 NSIS 自解压包，**每次启动**都要把整个应用解包到 `%TEMP%`、
> 退出时再删掉，这份解压**无法缓存复用**（项目文档实测"出现窗口"约 9.7 秒）。
> 而且应用**没有启动闪屏**，解包那十几秒屏幕上什么都没有，很容易被当成卡死 —— 看任务管理器里
> `Pet-*.exe` 有没有 CPU 占用即可分辨。慢的是解包，**不是程序本身**（主进程启动只要约 124ms）。

## 关于 compression（影响 portable 体积）

`electron-builder.yml` 里的 `compression` 对 portable 单 exe 体积影响很大（本机各跑两次，结果稳定）：

| 设置 | portable.exe | 说明 |
|---|---|---|
| `normal`（当前值） | 约 71 MB | 体积优先 |
| `store` | 约 233 MB | 不压缩，解包≈拷贝 |

当前取 `normal`：解包耗时的大头是"把约 232MB 落盘"，压缩设置只影响其中解压那一段（量级 1~3s），
却让文件大 3 倍多。

## 为什么 setup 启动快

主进程本身很快：实测窗口创建 +72ms、主进程就绪 +124ms。慢的全在"解包 / 冷启动"这一段，
而安装版把应用**预先落在磁盘上**，启动时不需要任何解包，所以快。

## 未签名的提示

exe 没有代码签名，Windows SmartScreen 会弹「无法验证发布者 / 未知发布者」。
这是**预期行为**，点「更多信息 → 仍要运行」即可；消除它需要购买代码签名证书。

## 模型资源在哪里

- 模型**没有**打包进 ASAR。构建时 `public/assets` 被 electron-builder 的 extraResources
  整体映射到便携包内 `resources/assets`（含 `models.json` 清单、`knowledge/` 语料、`skills/` 技能，
  以及随包的内置模型目录）。**当前随包的只有一个静态立绘内置模型「大肥鱼」**：
  没有随包骨骼模型（骨骼模型体积大、且版本兼容性因机器而异，一律由用户放本机用户数据）。
- **骨骼模型放在本机用户数据**：`%APPDATA%\pet-desktop-app\live2d-models\<模型名>\`
  （应用启动时按"用户模型优先、内置模型兜底"排序，清单里没有骨骼模型时也会扫这个目录）。
  想内置/留种子：把模型放进 `local-assets/live2d_models/<模型名>/` 再 `npm run import`
  （只有放在 `local-assets/` 才能活过构建；`public/assets` 每次 import 都会被清空重建）。
  详见 `local-assets/README.md` 与 `docs/MODEL_COMPAT.md`。
- 应用启动时会优先从打包资源路径读取模型（`process.resourcesPath/assets`，
  兜底为 exe 同目录的 `assets/`），因此随包资源无需联网、无需额外放置。
- 判断某个模型能不能被当前运行库渲染：`node scripts/check-model.js "<模型文件夹>"`。

## 常见问题

- 杀毒软件误报：Electron 便携 exe 首次运行可能被 SmartScreen/杀软拦截，选"仍要运行"即可。
- 运行报缺 DLL / 白屏：确认系统为 64 位 Windows 10/11，并保持 exe 所在目录可写（需要临时解包空间）。
- 本文件与 exe 版本严格对应；重新打包后会自动刷新。
