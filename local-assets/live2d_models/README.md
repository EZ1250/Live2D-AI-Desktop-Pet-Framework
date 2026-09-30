# 内置 / 种子模型投放点（当前为空）

把**模型文件夹整个**放进这里（`live2d_models/<模型名>/`，里面要有 `*.model3.json` + `.moc3` + 贴图），
`npm run import` 就会：

1. 把它合并进 `public/assets/<模型名>/` 并写进 `public/assets/models.json`（→ 打包进安装包，成为**内置模型**）；
2. 再跑迁移脚本，把它**复制**到 `%APPDATA%/pet-desktop-app/live2d-models/<模型名>/`
   （内置模型同时变成用户自己的模型；`public/assets` 里的那份会被移走，不再随包）。

为什么要有这个目录：`public/assets/` 每次 `npm run import` 都会被**清空重建**，
所以"想内置/想留种子"的东西**只能**放在 `local-assets/` 下 —— 这是唯一能活过构建的位置。

## 当前状态

**没有随包骨骼模型**（本目录为空）。骨骼模型体积大、moc3 版本兼容性又因运行库而异，
所以一律由用户放在**本机用户数据**里（`%APPDATA%/pet-desktop-app/live2d-models/`），
安装包里只留一个静态立绘内置模型（`大肥鱼`）。

这里的**能力**（目录 + import 合并 + 迁移复制 + 体检）全部保留，随时放回即可——
但请只在**临时验证**时放，别把某台机器的模型长期留在工程里：
工程应当是"不含模型、填入模型即可运行"的框架。

## 恢复办法

**唯一来源就是本目录**（工程外的"参考源"已废弃，见 `docs/PROJECT_LAYOUT.md` §5.2）。

- 从本机用户数据复制回来：把 `%APPDATA%\pet-desktop-app\live2d-models\<模型名>\` 整个目录
  复制到本目录（`local-assets\live2d_models\<模型名>\`）。
- 放回后先体检再打包：

```bash
node scripts/check-model.js "local-assets\live2d_models\<模型名>"
npm run import && npm run build
```

体检结论若是 `unsupported`（moc3 v5 > 运行库上限 v4），渲染时会明确提示"需要 Cubism 5 运行库或改导出目标 4.2"
（见 `docs/MODEL_COMPAT.md`）。
