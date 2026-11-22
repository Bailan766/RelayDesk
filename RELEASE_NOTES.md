# RelayDesk 1.7.0

RelayDesk 1.7.0 完成 **Google Material Design 3 (M3)** 桌面端界面全面重构（完整继承 `v1.6.0` 核心稳定性与自愈能力）：

- **Material Design 3 语义色彩与表面阶梯**：
  - 基于 Teal-Cyan 品牌种子构建浅色 / 深色 / 跟随系统三态完整的 `--md-sys-color-*` 语义色板与 `surface` / `surface-container-*` 层级体系，取代原本密集边框与零散灰阶。
  - 配对优化选中行、次要信息、状态提示文本与错误容器的对比度，确保深浅主题与 Windows 高对比度模式（`forced-colors`）下均清晰可读。
- **M3 组件语义与自适应导航**：
  - 宽屏左侧采用 M3 Standard Navigation Drawer 胶囊选中态；窄窗口（`<= 800px`）自适应折叠为居中图标的 Navigation Rail，并保持屏幕阅读器完整标签。
  - 重构主连接 Filled Pill CTA、断开 Error-Container Pill 按钮、Single-Select Segmented Button（`.mode-switch`）、M3 搜索框与 Filter/Assist Chips、Settings 二元开关（M3 Switch）以及 `28px` 大圆角 M3 Dialog 弹窗。
- **M3 动效曲线与无障碍焦点**：
  - 统一采用 `--md-sys-motion-easing-standard` / `emphasized` 缓动、M3 State Layer 交互反馈与 4px/6px 线性进度条，并为全部交互控件补全 `:focus-visible` 焦点环与 `prefers-reduced-motion` 降噪支持。
