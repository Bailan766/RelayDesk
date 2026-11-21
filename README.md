# RelayDesk

Windows 代理客户端项目，当前处于开发早期。GitHub Actions 在 Windows 上运行测试并构建可执行文件。

## 开发

需要 Node.js 22 或更新版本：

```sh
npm ci
npm test
npm run dev
```

推送到 GitHub 后，Windows build 工作流生成 Windows x64 安装程序和免安装包。使用免安装版时，请完整解压到同一目录。导入订阅后，选择受支持的节点和首页的接管方式。系统代理适用于读取 Windows 代理设置的应用。TUN 适用于需要接管 TCP/UDP 的应用，启动时需要管理员授权。本地端口模式需在目标应用中配置界面显示的 HTTP/SOCKS5 地址。彻底退出请使用托盘菜单。

## 当前限制

桌面应用支持分别管理并更新多份 HTTPS 订阅，通过 sing-box 连接 VLESS、Hysteria2、VMess、Trojan、Shadowsocks、TUIC v5 和 WireGuard。节点模式可从分享链接、Clash YAML 和 sing-box JSON 提取连接参数。WireGuard 使用 Clash 节点配置或 sing-box 用户态端点。订阅、所选节点和工作区设置由 Windows DPAPI 加密后保存在 SQLite。域名、域名后缀、IP 网段和 Windows 进程规则按顺序匹配，支持直连、拦截或指定代理节点，修改在下次连接时生效。当前会话中已加载的节点支持热切换。

要使用 Clash 订阅自带的策略组、提供者、规则和 DNS，在「订阅」页选用 Mihomo 原配置。原配置支持系统代理、本地端口和 Windows TUN，远程与内联提供者可以直接使用。本地文件提供者需要改用内联或远程来源。TUN 按会话请求管理员权限，Mihomo 按内部转发连接的进程、来源地址、来源端口和入口名称匹配相应规则。

订阅请求可单独指定线路和 User-Agent。每份在线订阅可跟随默认刷新周期、指定自己的周期或关闭自动更新，手动更新仍可用。可在设置中开启节点失联自动换线，备用节点从同一订阅选取，收藏优先。「测试」页可对当前路由进行下载采样。

对标范围、源码证据与端到端验收场景见[开源代理工具对标审计](docs/OPEN_SOURCE_BENCHMARK.md)。

## 许可

项目代码使用 MIT 许可证。构建产物单独包含 sing-box 可执行文件及其许可证；来源和版本见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
