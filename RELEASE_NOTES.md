# RelayDesk 0.1.6 Preview

- 增加 VMess、Trojan、Shadowsocks 和 TUIC v5，继续支持 VLESS 与 Hysteria2。分享链接、Clash YAML 和 sing-box JSON 支持的节点可以直接建立连接。
- 导入会保留支持的认证、TLS、传输和端口跳跃配置，并在节点上提示当前无法转换的字段。结构化导入使用节点列表，策略组、DNS 与分流仍使用 RelayDesk 的设置。
- 同名且服务器相同、但连接配置不同的节点可以分别保留。升级会迁移此前选择和收藏。
- 概览加入 Apple、GitHub、Google 和 YouTube 的 HTTP 连通性测试，按当前路由返回状态码和耗时。

预览版安装包未进行 Authenticode 签名。TUN 按启动会话申请管理员权限。
