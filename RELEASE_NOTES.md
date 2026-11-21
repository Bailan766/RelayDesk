# RelayDesk 1.5.0

RelayDesk 1.5.0 全面补齐分流引擎、Mihomo 单核原生 TUN、DNS 可观测性与桌面系统集成：

- **节点模式远程规则集（`sing-box` `rule_set`）**：
  - 「规则」页新增远程规则集管理，内置 `geosite-cn`、`geoip-cn`、`geosite-geolocation-!cn`、`geosite-category-ads-all`、`geosite-openai` Preset，同时支持添加自定义 HTTPS `.srs`/`.json` 规则集，并在提权 TUN 配置校验中白名单放行。
- **Mihomo 持久化覆写**：
  - 「订阅」页新增「Mihomo 持久化覆写」弹窗，支持自定义 `dns.enable`、`enhanced-mode`、`nameserver`、`fallback`、`fake-ip-filter`、前置规则与高级 YAML 字段，订阅手动或定时刷新后仍自动保留。
- **Mihomo 单核原生 TUN 架构**：
  - 彻底移除旧版 `mihomo ← SOCKS5 → sing-box Bridge` 双内核桥接跳数，随包集成签名 `wintun.dll`（Wintun 0.14.1），由单一 `mihomo.exe` 进程原生接管 Wintun 虚拟网卡与 DNS，热重载与崩溃恢复同步保持单核状态。
- **DNS 查询观测面板**：
  - 「诊断 → DNS 观测」支持输入域名一键对照 **本机系统 DNS**、**Mihomo 内核 DNS（`/dns/query`）** 与 **远程 DoH（`1.1.1.1`）**（自动标记 Fake-IP），并支持按需实时抓包观测活跃 DNS 查询路径。
- **Windows 原生网卡变更与休眠唤醒监听**：
  - Rust 层注册 `NotifyIpInterfaceChange` 与 `WM_POWERBROADCAST` 电源事件，即使应用最小化到托盘，切换 Wi-Fi 或从睡眠/休眠唤醒后也能立即唤醒健康探测并校验系统代理状态。
- **Windows 全局快捷键**：
  - 「设置」页新增全局快捷键录制与冲突反馈（支持推荐组合 `Ctrl+Alt+P/M/R` 一键开关代理、循环切换路由模式、唤起主窗口）。
- **加密配置备份**：
  - 支持在「设置 → 备份与恢复」中输入密码，使用 Web Crypto `PBKDF2-SHA256 + AES-256-GCM` 加密导出 `.enc.json`（兼容原有明文 JSON 导入）。
- **工程模块化重构**：
  - 拆解精简 `src/main.tsx`，提取独立页面视图、节点工具库与覆写弹窗模块，保持清晰桌面风格与可维护性。
