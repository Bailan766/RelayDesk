# RelayDesk 0.1.9 Preview

- 支持从 Clash YAML 和 sing-box 的用户态端点导入 WireGuard 节点。节点可以用于本地端口、系统代理、TUN 和手动分流。
- WireGuard 握手经过独立的 UDP 出站。Windows TUN 保留默认网卡探测，并拒绝对端主动发起的新连接。
- 导入时校验密钥、CIDR 网段和保活配置。每次会话最多预加载 32 个 WireGuard 节点，选择其余节点时会重新连接。

预览版安装包未进行 Authenticode 签名。TUN 按启动会话申请管理员权限。
