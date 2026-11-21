# PetMouse.exe（仅鼠标定位）

用于手机打开对话页时，把电脑鼠标移动到桌宠视线原点。

- 命令：PetMouse.exe move <x> <y>（屏幕 DIP 坐标）
- 已移除：点击/右键/键盘注入/UIAutomation（v0.4.3 不再需要）
- 构建：
  csc /nologo /target:exe /out:PetMouse.exe PetMouse.cs
