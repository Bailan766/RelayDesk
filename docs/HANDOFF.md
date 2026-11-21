# RelayDesk 项目交接报告

记录日期：2026-11-21。本文描述 `v0.1.20-preview.1` 发布时的产品状态及后续工作，功能验收以实际版本和测试场景为准。

## 版本与交付

- 仓库：`Bailan766/RelayDesk`，默认分支为 `main`。
- 发布版本：[v0.1.20-preview.1](https://github.com/Bailan766/RelayDesk/releases/tag/v0.1.20-preview.1)，产品代码提交为 `4e141395619790a53c0f73f07223e1e7f33b1129`。
- 产物：Windows x64 安装版和便携版，均为未签名预览构建。
- 固定内核：sing-box `1.14.4` 和 Mihomo `1.19.34`。下载地址及归档 SHA-256 见 [Windows 工作流](../.github/workflows/windows.yml)。
- [发布版构建和安装验收](https://github.com/Bailan766/RelayDesk/actions/runs/44855525577)通过，包含安装、重装和卸载测试。

| 发布文件 | SHA-256 |
| --- | --- |
| `relaydesk-windows-x64-setup.exe` | `83ad8e91cd2bedaccf5c9c64ecfa80f76f139802b7b6e50e299e9a333b92e81a` |
| `relaydesk-windows-x64-portable.zip` | `af6753dd024e30735f239fcb3358cce8b7f3c09dda12f2f608eb64d2089c70e4` |

以上哈希已与下载后的文件核对。后续发布需要重新核对对应版本，避免沿用旧哈希。

## 架构与入口

前端使用 React、TypeScript 和 Tauri 2，Windows 后端使用 Rust。随包的 sing-box 和 Mihomo 作为独立进程运行。

| 模块 | 职责 |
| --- | --- |
| [src/main.tsx](../src/main.tsx) | 页面、导入、连接、节点选择和设置入口。 |
| [src/subscription.ts](../src/subscription.ts)、[src/outbound.ts](../src/outbound.ts) | 订阅解析、节点参数转换及支持情况判断。 |
| [src/workspace.ts](../src/workspace.ts) | 多订阅、节点选择和工作区状态。 |
| [src-tauri/src/main.rs](../src-tauri/src/main.rs) | Tauri 命令、托盘、订阅下载和进程入口。 |
| [src-tauri/src/network.rs](../src-tauri/src/network.rs) | 网络工作进程、TUN 启停、路由检查与恢复。 |
| [src-tauri/src/supervisor.rs](../src-tauri/src/supervisor.rs) | 会话状态、内核恢复及自动换线。 |
| [src-tauri/src/mihomo.rs](../src-tauri/src/mihomo.rs) | Mihomo 原配置准备和策略配置。 |
| [src-tauri/src/system_proxy.rs](../src-tauri/src/system_proxy.rs) | Windows 系统代理设置、记录和恢复。 |
| [src-tauri/src/storage.rs](../src-tauri/src/storage.rs) | SQLite 工作区数据和 Windows DPAPI 加密。 |
| [src-tauri/src/telemetry.rs](../src-tauri/src/telemetry.rs)、[src-tauri/src/probes.rs](../src-tauri/src/probes.rs) | 连接统计、日志和探测。 |

节点模式以 sing-box 处理代理。Mihomo 原配置的 TUN 路径由接管进程将 TCP、UDP 和 DNS 交给普通权限的 Mihomo 策略进程；因此部分来源及进程元数据表现为内部连接。系统代理模式使用 Windows 代理设置，本地端口模式由应用自行配置入口。

持久化使用 Tauri 应用数据目录内的 `relaydesk.db`，内容通过当前 Windows 用户的 DPAPI 加密。运行时网络状态位于 `%LOCALAPPDATA%\RelayDesk\network-state`。迁移或排查时应保留用户数据，并避免将订阅地址、配置和日志中的敏感信息提交到仓库。

## 已验证范围

- 本地前端测试和构建通过。配置真实 sing-box 路径后，前端测试为 33 项通过、3 项跳过；跳过项需要 Mihomo 或安装后的应用。
- 发布工作流的 Rust 测试、Windows 安装包构建和安装后网络验收通过。验收覆盖系统代理恢复、TUN 双栈路由、Mihomo 原配置的 TCP/UDP/DNS、WireGuard，以及已覆盖的内核恢复和节点换线场景。
- `v0.1.20-preview.1` 的 TUN 就绪门槛包括 IPv4 和 IPv6 默认路由。安装测试在就绪后核对两条路由。
- 一次授权服务曾在本机使用独立临时原型验证受限用户流量、未登记身份拒绝、非法指令拒绝和客户端断开或服务异常退出后的测试网卡清理。该原型不在产品代码或安装器中，不能视为正式服务功能。

本机仓库父目录中留有 `RelayDeskServiceFixture.cs`、`RelayDeskServiceFixture.exe` 和 `RelayDeskServiceFixtureTest.ps1`。这些文件未纳入版本控制，其他工作区可能不存在。测试脚本会临时创建 Windows 服务、受保护目录和测试网卡，需要在合适的 Windows 测试环境中运行。

完整的版本证据、协议夹具和尚需覆盖的矩阵见 [OPEN_SOURCE_BENCHMARK.md](OPEN_SOURCE_BENCHMARK.md)。该文档的原始源码审计固定在较早基线，阅读时应同时查看开头的「基线之后的验证」和当前代码。

## 仍需处理

1. **TUN 授权体验。** 当前在启动 TUN 工作进程时自动请求管理员授权，手动重新连接可能再次弹窗。用户提出过启动客户端时自动申请管理员权限的方案，尚未改动。应先确认启动时授权、取消授权、不同 Windows 用户、普通模式和托盘行为，再确定实现方式。独立服务方案仍需完成用户及会话鉴别、受保护程序路径、安装升级卸载、启动竞态和异常清理的产品级验证。
2. **网络变化与失败恢复。** 补充真实休眠唤醒、Wi-Fi/有线切换、长时间断网重连和授权工作进程自身退出的测试。TUN 重建期间 Windows 可能恢复原网络路径，需按产品预期验证。
3. **DNS 和双栈。** 验证系统或应用仍缓存旧 Fake-IP 的恢复；覆盖 IPv6 真实上游、应用自带加密 DNS 和 IPv6 被系统禁用时的行为。当前就绪条件要求 IPv4、IPv6 默认路由均存在。
4. **Mihomo 原配置语义。** TUN 转发后的进程、来源地址、来源端口和入口名称规则使用内部连接元数据。本地文件提供者暂不支持，复杂配置及远程规则集还需增加实际流量验证。
5. **诊断和兼容性。** 服务解锁检测尚未接入。继续覆盖更多协议参数组合、不同服务商订阅、订阅定时刷新及长时间运行；检测结果应保持与实际测试范围一致。
6. **发布与平台。** 当前产物为 Windows x64 未签名预览版。签名、其他 Windows 环境和其他平台需要各自的构建与验收。

## 开发和验收

基础命令在仓库根目录执行：

```powershell
npm ci
npm test
npm run build
cargo test --manifest-path src-tauri/Cargo.toml
```

桌面构建需要 Windows Rust/C++ 工具链、WebView2，以及工作流中列出的两套内核和许可证资源。`SING_BOX`、`MIHOMO`、`RELAYDESK_INSTALLED_SMOKE_APP` 和 `RELAYDESK_WINDOWS_PROXY_SMOKE` 控制部分集成测试；未提供所需环境时，测试可能跳过。安装后的网络验收入口为 [.github/scripts/test-windows-network.ps1](../.github/scripts/test-windows-network.ps1)，完整执行顺序见 [Windows 工作流](../.github/workflows/windows.yml)。

近期本机的 Rust 离线检查因依赖缓存不完整未完成，本机缺少 MSVC 链接器。对应 Windows 原生编译与测试已在上述 GitHub Actions 构建中通过。修改 TUN、系统代理或恢复逻辑后，应以安装后的应用复测实际网络路径和清理，再发布新版本。
