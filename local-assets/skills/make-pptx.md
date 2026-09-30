---
name: make-pptx
description: 生成真正能双击打开的 .pptx 演示文稿（本机 PowerPoint COM 或 python-pptx 两条路都给了实测脚本）；用户说"做个PPT / 幻灯片 / 演示文稿"时用这个
---

# 做 PPT（.pptx）

## 环境事实（先看这个，别猜）
- 本机**装了 PowerPoint**（COM 可用，`PowerPoint.Application.16`）→ **首选 COM**：不需要联网、不需要装任何依赖。
- `python-pptx` **默认没装**；要走 Python 路线就先 `pip install python-pptx`（需要联网，装不上就回到 COM 路线）。
- 没有"PPT 专用工具"，用 `workspace_write` 写脚本 + `shell_run` 执行。

## 铁律（违反=任务失败）
1. 交付物必须是 **`.pptx` 文件**。不要用 `.md` 大纲冒充，也不要说"你自己复制粘贴到 PPT 里"。
2. 做完**必须验证**：文件存在、大小 > 10KB（正常演示文稿 20KB 以上），然后把**绝对路径**告诉用户。
3. 用户没要的文件别建（README、说明.md、大纲.md）。
4. 一次别贪多：先做 1 页标题 + 3~6 页内容，成了再往上加；页数多就分批，别把命令写成几千字。
5. 内容用用户给的主题；用户没给细节，就先在聊天里列 3~5 条大纲**并直接开工**，别停在提问上。

## 推荐流程（写脚本再跑，不要把长命令塞进一行）
1. `workspace_write` 把 `make_ppt.ps1` 写进工作区（**系统会给 .ps1 自动加 UTF-8 BOM，中文可以直接写**）。
2. `shell_run`：`powershell -NoProfile -ExecutionPolicy Bypass -File .\make_ppt.ps1`
   ⚠️ 本机**没有 pwsh**，用 `pwsh …` 会报"无法将 pwsh 项识别为 cmdlet"。
3. 验证：`shell_run` 执行 `Get-Item .\xxx.pptx | Select-Object FullName, Length`
4. 想直接给用户打开：`shell_run` 执行 `Invoke-Item 'C:\完整路径\xxx.pptx'`

## PowerShell + PowerPoint COM 模板（本机实测可用）
```powershell
$ErrorActionPreference = 'Stop'
$out = Join-Path (Get-Location) 'sleep.pptx'      # 输出文件（放工作区里）
$ppt = New-Object -ComObject PowerPoint.Application
$pres = $ppt.Presentations.Add($false)            # $false = 不显示窗口
# 版式：1=标题页  2=标题+内容  6=空白（自己加文本框）
$slides = @(
  @{ layout = 1; title = '睡眠与健康'; body = '睡眠科普 / 2026' },
  @{ layout = 2; title = '睡眠周期';   body = "90 分钟一个循环`n深睡：修复大脑、巩固记忆`nREM：稳定情绪" },
  @{ layout = 2; title = '健康影响';   body = "长期不足：免疫力下降、注意力变差`n规律作息 + 遮光 + 睡前 1 小时离屏" }
)
$i = 1
foreach ($s in $slides) {
  $slide = $pres.Slides.Add($i, $s.layout)
  try { $slide.Shapes.Title.TextFrame.TextRange.Text = [string]$s.title } catch {}
  try { $slide.Shapes.Item(2).TextFrame.TextRange.Text = [string]$s.body } catch {}
  $i++
}
$pres.SaveAs($out)
$pres.Close()
$ppt.Quit()
Get-Item $out | Select-Object FullName, Length
```

## 常见坑
- COM 报"无法创建对象"：PowerPoint 没装或被安全软件拦了 → 改用 Python 路线。
- `$slide.Shapes.Item(2)` 在空白版式上不存在 → 已用 try/catch 兜住；空白版式要自己 `Shapes.AddTextbox`。
- 脚本必须先把 `$out` 定成绝对路径（`Join-Path (Get-Location)`），否则可能存到别处。
- 生成后 PowerPoint 进程可能残留：脚本末尾一定要 `$pres.Close(); $ppt.Quit()`。
- 中文内容用 UTF-8 保存脚本；`shell_run` 已设置 UTF-8 输出，不乱码。

## Python 路线（装了 python-pptx 再用）
```python
from pptx import Presentation
from pptx.util import Inches, Pt
p = Presentation()
s = p.slides.add_slide(p.slide_layouts[0]); s.shapes.title.text = '睡眠与健康'
s.placeholders[1].text = '睡眠科普'
s2 = p.slides.add_slide(p.slide_layouts[1]); s2.shapes.title.text = '睡眠周期'
s2.placeholders[1].text = '90 分钟一个循环\n深睡修复大脑\nREM 稳定情绪'
p.save('sleep.pptx')
```
跑法：`workspace_write` 写 `make_ppt.py` → `shell_run: python make_ppt.py` → 同样验证文件。
