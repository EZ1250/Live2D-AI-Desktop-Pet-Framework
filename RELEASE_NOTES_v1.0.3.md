# Pet v1.0.3

## Live2D 兼容性

- 读取 VTube Studio `.vtube.json` 里的 `ChangeIdleAnimation` 热键，把模型自带的多个待机动作注册成独立 Motion 组，右键菜单可直接切换。
- 支持 VTS `StopsOnLastFrame`：带停帧标记的动作播放结束后保持最后一帧姿势，不再自动回到待机。
- 用户触发的动作改为 FORCE 优先级，能正确打断当前待机/其它动作，接近 VTS 的 `TriggerAnimation` 行为。
- **修复 `.vtube.json` 参数映射读取**：带 `UseBreathing` / `UseBlinking` 的映射行交给引擎自动呼吸/眨眼，不再误占输出；本项目不提供的输入不再禁用标准眨眼，像 Ellen 这类模型不会再出现“眼睛不动/表情不自然”。
- 新增的待机组与停帧状态会在切换模型时随旧 handle 一起销毁，不残留定时器。

## 继承说明

- 参数映射仍优先使用模型自带 `.vtube.json` 的 `ParameterSettings`，自定义控制器参数（如 AngleX / PositionX）会按模型映射自动驱动。
- 当前支持的 VTS 动作类型：`ToggleExpression`、`TriggerAnimation`、`ChangeIdleAnimation`；`RemoveAllExpressions` 由框架的清空表情逻辑处理。

## 版本

- `1.0.3`
