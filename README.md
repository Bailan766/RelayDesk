# RelayDesk

Windows 代理客户端项目，当前处于开发早期。GitHub Actions 在 Windows 上运行测试并构建可执行文件。

## 开发

需要 Node.js 22 或更新版本：

```sh
npm ci
npm test
npm run dev
```

推送到 GitHub 后，Actions 的 Windows build 工作流生成 Windows x64 安装程序和免安装包。免安装版解压后保留 `relaydesk.exe` 和 `sing-box.exe` 在同一目录。导入订阅并选择受支持的节点后启动代理，再将需要使用代理的应用配置为界面显示的本地 HTTP 或 SOCKS5 地址和端口。连接检查通过表示测试请求已通过当前代理到达检查地址，不保证其他目标均可访问。

## 当前限制

桌面应用支持下载 HTTPS 订阅，并可为 URI 格式的 VLESS 和 Hysteria2 节点生成 sing-box 配置、启动本地 HTTP/SOCKS5 代理。支持按顺序匹配的域名及域名后缀规则，支持直连、代理和拦截；修改在重新连接后生效。订阅、规则和凭据仅保留在进程内存；启动内核时会短暂写入系统临时文件，加载后删除。尚未实现持久化、Mihomo、Windows 服务、系统代理自动设置、TUN、测速和完整诊断。内核运行不代表远端节点已验证可用。

## 许可

项目代码使用 MIT 许可证。构建产物单独包含 sing-box 可执行文件及其许可证；来源和版本见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
