# RelayDesk

Windows 代理客户端项目，当前处于开发早期。GitHub Actions 在 Windows 上运行测试并构建可执行文件。

## 开发

需要 Node.js 22 或更新版本：

```sh
npm ci
npm test
npm run dev
```

推送到 GitHub 后，Windows build 工作流生成 Windows x64 安装程序和免安装包。免安装版解压后保留 `relaydesk.exe` 和 `sing-box.exe` 在同一目录。导入订阅后，选择受支持的节点和首页的接管方式。系统代理适用于读取 Windows 代理设置的应用。TUN 适用于需要接管 TCP/UDP 的应用，启动时需要管理员授权。本地端口模式需在目标应用中配置界面显示的 HTTP/SOCKS5 地址。彻底退出请使用托盘菜单。

## 当前限制

桌面应用支持分别管理并更新多份 HTTPS 订阅，可为 URI 格式的 VLESS 和 Hysteria2 节点生成 sing-box 配置。订阅、所选节点和工作区设置由 Windows DPAPI 加密后保存在本机 SQLite。启动期间会创建当前用户目录下的临时内核配置。域名及域名后缀规则按顺序匹配，支持直连、代理和拦截，修改在下次连接时生效。当前会话中已加载的节点支持热切换。尚未实现 Mihomo、一次安装授权的 Windows 服务、带宽测速和完整诊断。

对标范围、源码证据与端到端验收场景见[开源代理工具对标审计](docs/OPEN_SOURCE_BENCHMARK.md)。

## 许可

项目代码使用 MIT 许可证。构建产物单独包含 sing-box 可执行文件及其许可证；来源和版本见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
