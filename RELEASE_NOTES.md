# RelayDesk 1.2.2

RelayDesk 1.2.2 重点解决断连恢复卡死、日志落盘缺失、长连接保活与 TUN/DNS 抗抖动问题：

- **真正可追溯的磁盘日志与内核错误捕获**：
  - 彻底告别以往仅保存在内存的日志策略：运行事件与核心告警现已自动脱敏并按 `1 MiB` 轮转写入 `%LOCALAPPDATA%\RelayDesk\logs\relaydesk.log`，重启应用仍可回溯历史记录。
  - 修复此前 `sing-box` / `mihomo` 标准错误被 `Stdio::null()` 丢弃导致“断连无原因可查”的盲区，并在「诊断 -> 运行日志」新增一键「日志目录」入口。
- **消除断连恢复 45 秒互斥锁卡死与误杀稳定连接**：
  - 重构 `Supervisor` 自动恢复状态机：崩溃重连不再长时间占用状态锁，保证断开代理、状态查询与日志读取随时秒响应。
  - 调整 `supervise_core` 路由守卫：容忍短时系统网络切换至 12 秒，且不再因临时 IPv6 链路波动强杀正常运行的 IPv4 TUN 虚拟网卡。
- **长连接保活与 TUN DNS 分流抗雪崩**：
  - 为 Mihomo 默认补齐 `keep-alive-idle: 15` / `keep-alive-interval: 15` 与 `tcp-concurrent` / `unified-delay` 稳定性参数，并移除 Mihomo TUN 桥接中的 `disable_cache: true`，避免 IDE、终端与长连接流式请求被中断。
  - sing-box TUN 模式下将直连域名与后缀（如 `.cn` 与国内直连规则）自动分流至本机 DNS 解析，防止代理节点短暂抖动引发全局 DoH 雪崩。
  - 自动换线候选过滤掉“剩余流量 / 官网”等信息展示节点并按历史最低延迟排序。
