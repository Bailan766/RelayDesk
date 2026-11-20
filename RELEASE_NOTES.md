# RelayDesk 0.1.11 Preview

- 可以为每条 HTTPS 订阅单独设置请求线路和 User-Agent，导入、手动更新和定时刷新共用其设置。
- 请求线路支持自动、绕过 HTTP 代理、通过当前 RelayDesk 入口。经过 RelayDesk 时应用当前分流。开启 TUN 时系统仍按 TUN 路由发送请求。
- 刷新途中变更请求设置时，保留上一次成功的订阅，等待使用新设置更新。

预览版安装包未进行 Authenticode 签名。TUN 按启动会话申请管理员权限。
