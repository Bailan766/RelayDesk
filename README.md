# RelayDesk

RelayDesk 是一款 Windows 代理客户端，提供节点管理、订阅更新、系统代理、TUN 和本地代理端口。项目仍处于预览阶段，当前发布版本为 `v0.1.20-preview.1`。

## 下载和安装

从 [GitHub Releases](https://github.com/Bailan766/RelayDesk/releases/tag/v0.1.20-preview.1) 下载 Windows x64 安装包 `relaydesk-windows-x64-setup.exe`，或下载免安装包 `relaydesk-windows-x64-portable.zip`。免安装包需要完整解压后使用，保留程序、内核及附带许可文件在同一目录。

预览版尚未进行 Authenticode 签名。安装程序按当前 Windows 用户安装。

## 快速开始

1. 打开 RelayDesk，点击「导入订阅」。粘贴 HTTPS 订阅地址、节点链接、Base64、Clash YAML 或 sing-box JSON，也可以选择本地文本文件。
2. 在「节点」页选择一个可连接节点，或在「订阅」页为支持的 Clash 配置选择「选用原配置」。
3. 在「概览」选择接管方式，点击「连接」。TUN 启动时会自动发起 Windows 管理员授权请求。
4. 在「节点」页执行延迟测试，在「概览」检查连接或出口 IP。连接后的实际访问结果取决于所选节点和当前路由规则。
5. 点击「停止」结束代理；彻底退出可使用托盘菜单中的「彻底退出」。

三种接管方式各有适用场景。

| 方式 | 使用场景 |
| --- | --- |
| 系统代理 | 由遵循 Windows 系统代理设置的应用使用。 |
| TUN | 通过虚拟网卡接管 TCP、UDP 和 DNS，适合不读取系统代理设置的应用。 |
| 本地端口 | 不修改系统代理，在目标应用中手动填写界面显示的 HTTP/SOCKS5 地址。 |

## 已有功能

- 多订阅管理。支持设置请求线路、User-Agent 和每份订阅的自动更新周期，手动更新始终可用。
- 节点连接。节点模式使用 sing-box，支持 VLESS、VMess、Trojan、Shadowsocks、Hysteria2、TUIC v5 和 WireGuard 的已实现配置组合。界面会标识当前无法连接的节点。
- 分流和切换。节点模式支持域名、域名后缀、IP 网段和 Windows 进程规则，规则动作包括直连、拦截或指定节点。规则修改在重新连接后生效，当前会话中已加载的节点支持热切换。
- Mihomo 原配置。支持保留原配置中的策略组、远程或内联提供者、规则和 DNS，可在运行中切换手动策略组及应用有效的原配置更新。
- 运行监控。提供连接与流量信息、日志、节点延迟、网站连通性、出口 IP 和下载采样。节点延迟反映代理请求耗时。
- 自动恢复。可启用内核异常退出恢复和同订阅备用节点自动换线。TUN 接管内核恢复使用本次授权，Mihomo 策略内核恢复期间保留接管网卡。

订阅地址、节点及工作区设置通过 Windows DPAPI 加密保存在本机 SQLite 数据库。订阅更新和诊断记录应避免公开链接、口令等敏感信息。

## 当前限制

- Windows TUN 按会话申请管理员权限，手动重新连接时可能再次弹出授权。一次授权的后台服务尚未接入。
- TUN 就绪检查要求 IPv4 和 IPv6 默认路由均建立。系统禁用 IPv6 时的启动表现尚未验证。
- Mihomo 原配置经 TUN 转发时，进程、来源地址、来源端口及入口名称规则匹配的是内部转发连接的信息。本地文件提供者需要改用内联或远程来源。
- Mihomo 恢复后，新 DNS 查询会获取当前内核的 Fake-IP；应用或系统仍持有旧 Fake-IP 时，连接可能需要等待重新解析。
- TUN 接管内核重建网卡期间，Windows 可能恢复原有网络路径。休眠唤醒、切换网络和不同 Windows 版本仍需进一步现场验证。
- 「测试」页中的服务解锁检测尚未接入。协议扩展、各类传输参数及不同服务商配置的兼容性仍在持续验证。

## 开发与测试

Windows 桌面开发需要 Node.js 22、Rust 工具链、Windows C++ 构建工具和 WebView2。前端开发与基础测试：

```powershell
npm ci
npm test
npm run build
npm run dev
```

`npm run dev` 启动浏览器前端预览，桌面能力需要 Tauri 应用。准备好 [Windows 构建流程](.github/workflows/windows.yml)所列的内核与许可资源后，可运行：

```powershell
npm run tauri -- dev
cargo test --manifest-path src-tauri/Cargo.toml
npm run tauri -- build --bundles nsis
```

部分集成测试依赖 `SING_BOX`、`MIHOMO` 或安装后的应用路径，未配置时会跳过相应测试。GitHub Actions 下载并校验固定版本内核，执行 Windows 测试、构建、安装和网络验收。具体环境变量及步骤见工作流。

开发接续信息见[交接报告](docs/HANDOFF.md)，更详细的功能对标、证据和验收场景见[开源代理工具对标审计](docs/OPEN_SOURCE_BENCHMARK.md)。

## 许可

RelayDesk 项目代码使用 [MIT 许可证](LICENSE)。发行包中的 sing-box 和 Mihomo 是独立进程，分别遵循其上游许可。版本、来源及许可信息见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
