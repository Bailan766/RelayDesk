# RelayDesk

RelayDesk 是一款 Windows 代理客户端，提供节点管理、订阅更新、系统代理、TUN（含免 UAC 后台服务）和本地代理端口，当前正式版本为 `v1.4.0`。

- **作者**：Bailan233
- **开源地址**：https://github.com/Bailan766/RelayDesk
- **许可证**：MIT License

## 下载和安装

从 [GitHub Releases](https://github.com/Bailan766/RelayDesk/releases) 下载 Windows x64 安装包 `relaydesk-windows-x64-setup.exe`，或下载免安装包 `relaydesk-windows-x64-portable.zip`。免安装包需要完整解压后使用，保留程序、内核及附带许可文件在同一目录。

安装包尚未进行 Authenticode 签名。安装程序按当前 Windows 用户安装。

## 快速开始

1. 打开 RelayDesk，点击「导入订阅」。粘贴订阅地址（支持 HTTPS 及本机/内网 HTTP）、节点链接、Base64、Clash YAML 或 sing-box JSON，也可以选择本地文本文件并自定义订阅名称。
2. 在「节点」页双击节点卡片或点击「连接」，或在「订阅」页为支持的 Clash 配置选择「选用原配置」。
3. 在「概览」选择接管方式（系统代理 / TUN / 本地端口）和路由模式（规则 / 全局 / 直连），点击「立即连接」。
4. 连接后可在「概览」查看实时流量、快捷切换收藏节点或 Mihomo 策略组、查询出口 IP 归属地；在「测试」页检测网站连通性、下载速度与流媒体/AI 解锁状态。
5. 点击「断开连接」结束代理；通过窗口关闭或托盘菜单中的「彻底退出」退出应用。

## 主要功能

- **多订阅与兼容性**：支持 HTTPS 与本机/局域网 HTTP 订阅（可选允许外部 HTTP）、自定义请求线路与 User-Agent、独立自动更新周期，订阅用量与到期展示。
- **节点模式（sing-box）**：支持 VLESS、VMess、Trojan、Shadowsocks、Hysteria2、TUIC v5 与 WireGuard，提供节点筛选、持久化测速、Clash API 快速测速与分流规则编辑。
- **Mihomo 原配置**：保留原配置策略组、远程或内联提供者、规则与 DNS，支持可搜索折叠策略组面板与组内测速、热重载应用更新。
- **运行观测与测试**：实时流量图、活跃连接搜索/排序/断开与一键加规则、脱敏实时日志、网站连通性批量测试、Cloudflare 下载测速、出口 IP 归属地与服务解锁检测。
- **桌面与系统集成**：浅色/深色/跟随系统主题、Windows 开机自启、启动后自动连接、托盘状态与模式快捷切换、Allow LAN、系统代理绕过列表编辑、可选以管理员身份重启以简化 TUN 授权。

## 开发与测试

Windows 桌面开发需要 Node.js 22、Rust 工具链、Windows C++ 构建工具和 WebView2。前端开发与测试：

```powershell
npm ci
npm test
npm run build
npm run dev
```

桌面构建与验收（需按 [.github/workflows/windows.yml](.github/workflows/windows.yml) 准备内核与许可资源）：

```powershell
npm run tauri -- build --bundles nsis
cargo test --manifest-path src-tauri/Cargo.toml
```

开发接续信息见 [交接报告](docs/HANDOFF.md)，功能对标审计见 [开源代理工具对标审计](docs/OPEN_SOURCE_BENCHMARK.md)。

## 许可

RelayDesk 项目代码使用 [MIT 许可证](LICENSE)。发行包中的 sing-box 和 Mihomo 是独立进程，分别遵循其上游许可。版本、来源及许可信息见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
