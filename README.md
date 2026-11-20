# RelayDesk

Windows 代理客户端项目，当前处于开发早期。已实现本地订阅内容预览、节点列表和 Tauri 窗口骨架。GitHub Actions 在 Windows 上运行测试并构建可执行文件。

## 开发

需要 Node.js 22 或更新版本：

```sh
npm ci
npm test
npm run dev
```

推送到 GitHub 后，Actions 的 Windows build 工作流生成可下载的 Windows x64 可执行文件。

## 当前限制

桌面应用支持下载 HTTPS 订阅，并可为 URI 格式的 VLESS 和 Hysteria2 节点生成 sing-box 配置、启动本地 HTTP/SOCKS5 代理。订阅和凭据仅保留在进程内存；启动内核时会短暂写入系统临时文件，加载后删除。尚未实现持久化、Mihomo、Windows 服务、系统代理自动设置、TUN、测速、规则、诊断或安装包。内核运行不代表远端节点已验证可用。请将需要使用代理的应用手动配置为界面显示的本地地址和端口。

## 许可

项目代码使用 MIT 许可证。尚未包含或分发任何代理内核，后续分发时需随附各内核的许可证及相应源码获取信息。
