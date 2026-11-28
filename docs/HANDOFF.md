# RelayDesk 项目交接报告

记录日期：2026-11-21。本文描述 `v1.0.0` 重构后的产品架构与待继续推进的事项。

## 版本与交付

- 仓库：`Bailan766/RelayDesk`，默认分支为 `main`。
- 版本：`1.7.1`（[tauri.conf.json](../src-tauri/tauri.conf.json)、[package.json](../package.json)、[Cargo.toml](../src-tauri/Cargo.toml)）。
- 产物：Windows x64 安装版和便携版，由 [Windows 工作流](../.github/workflows/windows.yml) 构建；非带 `-` 后缀的 `v*` 标签自动发布为正式 Release。
- 固定内核：sing-box `1.15.0-alpha.14` 和 Mihomo `1.19.34`。

## 架构与入口

前端使用 React、TypeScript 和 Tauri 2，Windows 后端使用 Rust。随包的 sing-box 和 Mihomo 作为独立进程运行。

| 模块 | 职责 |
| --- | --- |
| [src/main.tsx](../src/main.tsx) | 主工作台、连接控制、节点浏览、模式切换、托盘与主题同步。 |
| [src/MihomoGroups.tsx](../src/MihomoGroups.tsx) | Mihomo 策略组搜索、折叠胶囊面板与组内测速。 |
| [src/components/RulesEditor.tsx](../src/components/RulesEditor.tsx) | 分流规则预设、行内编辑、默认动作切换与重连提示。 |
| [src/components/UnlockTests.tsx](../src/components/UnlockTests.tsx) | 流媒体与 AI 服务解锁探测界面。 |
| [src/components/SettingsPage.tsx](../src/components/SettingsPage.tsx) | 外观主题、自启、入口、Allow LAN、Bypass、管理员重启与容灾设置。 |
| [src/components/ImportModal.tsx](../src/components/ImportModal.tsx) | 支持自定义名称与 HTTP 选项的订阅导入弹窗。 |
| [src/subscription.ts](../src/subscription.ts)、[src/outbound.ts](../src/outbound.ts) | 订阅解析、兼容字段映射与支持情况判定。 |
| [src/workspace.ts](../src/workspace.ts)、[src/useWorkspace.ts](../src/useWorkspace.ts) | 多订阅持久化、延迟缓存、扩展桌面设置与自动刷新。 |
| [src-tauri/src/main.rs](../src-tauri/src/main.rs) | Tauri 命令、增强托盘菜单、开机自启、提权重启与订阅下载。 |
| [src-tauri/src/network.rs](../src-tauri/src/network.rs) | 网络工作进程、自适应 IPv6 TUN 启停、Allow LAN、服务桥接与路由恢复。 |
| [src-tauri/src/service.rs](../src-tauri/src/service.rs) | Windows 常驻后台服务 `RelayDeskTunService`、命名管道与目录 ACL 隔离。 |
| [src-tauri/src/supervisor.rs](../src-tauri/src/supervisor.rs) | 会话状态、内核恢复、连接控制、测速接口与自动换线。 |
| [src-tauri/src/mihomo.rs](../src-tauri/src/mihomo.rs) | Mihomo 原配置准备、LAN 选项与策略恢复。 |
| [src-tauri/src/system_proxy.rs](../src-tauri/src/system_proxy.rs) | Windows 系统代理与自定义 Bypass 列表设置和恢复。 |
| [src-tauri/src/storage.rs](../src-tauri/src/storage.rs) | SQLite 工作区数据和 Windows DPAPI 加密。 |
| [src-tauri/src/probes.rs](../src-tauri/src/probes.rs) | 下载测速、出口 IP、服务解锁、单实例 Clash API 批量测速会话与 TCP 握手测速。 |
| [src-tauri/src/telemetry.rs](../src-tauri/src/telemetry.rs) | 实时流量、连接断开、脱敏日志流与延迟探测。 |

## 仍需持续完善

1. **一次授权 Windows TUN 服务**：当前已提供「以管理员身份重启」配合免重复 UAC 弹窗与自愈，并支持 IPv6 禁用环境下的自适应回退；如需普通用户无提权常驻服务，仍需参考 [OPEN_SOURCE_BENCHMARK.md](OPEN_SOURCE_BENCHMARK.md) 完成安装器权限隔离与管道令牌校验。
2. **极端网络环境实测**：补充休眠唤醒、Wi-Fi/有线切换、应用自带 DoH 与大型 Mihomo 远程规则集的长时压测。
3. **代码签名与多平台**：当前安装包未进行 Authenticode 签名；macOS/Linux 需要各自平台打包与权限适配。
