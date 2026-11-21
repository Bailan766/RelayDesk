# RelayDesk 开源代理工具对标审计

审计日期为 2026-11-21。RelayDesk 基线为 `25bee9d322e13f4273f72f20f916dc04cce3d1c5`，提交记录中的桌面版本为 0.1.3 Preview。Windows CI 固定 sing-box 1.14.4 的 amd64 发布压缩包及 SHA-256，生成 NSIS 安装包和便携包。工作树中另有并行开发中的改动，本报告的产品现状统一以该提交为准。相对链接指向仓库文件，可用 `git show 25bee9d:路径` 查看对应的基线内容。 [版本配置](../src-tauri/tauri.conf.json#L2) · [Windows 构建](../.github/workflows/windows.yml#L23) · [构建依赖说明](../THIRD_PARTY_NOTICES.md) · [上游 1.14.4 发布](https://github.com/SagerNet/sing-box/releases/tag/v1.14.4)

**证据口径。** 【RD-源码】是该提交可追溯的 RelayDesk 代码或发布配置。【RD-测试定义】是仓库中已有的用例，本次只读核查未执行。【上游】是项目自身文档、源代码、版本页或平台 API 文档。文档和分支源码描述观察到的能力，具体平台、渠道和内核构建仍需按发行产物核实。【推断】是代码路径给出的风险，等候实测。【验收】是建议执行的场景及通过条件。此次只读源码和公开一手资料，未运行客户端、访问用户订阅或使用实际凭据。

## 基线之后的验证

| 场景 | 已收集的运行证据 | 仍需覆盖 |
| --- | --- | --- |
| A03 订阅在线更新与升级 | 旧版单订阅格式迁移、状态重启往返、多来源隔离、凭据轮换后保留选择、拒绝不可用的更新均有回归用例。桌面界面用模拟 IPC 验证更新期间持续连接、失败后保留旧订阅。 | 用现场 HTTPS 订阅验证服务商流量头、真实网络失败、定时触发和多次并发刷新。 |
| A04 Windows TUN | 固定名称在一台 Windows 实机上复现 Wintun 创建冲突。每次会话换用独立名称后，同一实机通过了第 1、9 条线路的 HTTPS、DNS 和出口比对。使用正式 Windows CI 构建出的网路进程再测第 9 条，HTTPS 返回 204，DNS 返回记录，出口与显式代理一致，停止后网卡地址消失。 | 冷启动驱动、休眠唤醒、切网、IPv6/UDP 业务及不同 Windows 版本。 |
| A06 路由和热切换 | 真实内核夹具通过持续 TCP 连接验证：热切换后旧连接走原节点，新连接走新节点。夹具也验证了全局进代理、直连出站及规则拦截。 | Windows 三种接管模式的真实网络数据路径、进程/CIDR/远程规则集、策略组和在线更新规则。 |
| A01/A02 协议与格式 | `v0.1.6-preview.1` 通过 [Windows 安装验收](https://github.com/Bailan766/RelayDesk/actions/runs/44823102754)。本地用真实内核验证 Clash YAML、sing-box JSON 的 VLESS 节点，以及分享链接的 VMess、Trojan、Shadowsocks，均传输了 TCP 数据。Hysteria2 与 TUIC v5 用自建 QUIC 对端验证认证、公钥固定及 HTTP 数据。正式包另复测了第 5、9 条线路的 TUN HTTPS、DNS 和退出恢复。 | WireGuard 和更多协议扩展，完整 Mihomo 配置与其中的 DNS、策略组、规则集和提供者，以及每个协议的 UDP、全部支持的传输和证书变体。 |
| A05/A06 崩溃恢复与分流 | `v0.1.7-preview.1` 的 [Windows 安装验收](https://github.com/Bailan766/RelayDesk/actions/runs/44825851263) 强制结束已安装的本地端口工作进程，恢复后再次成功转发，主动停止后监听消失。正式包实机区分了访问同一目标的两个 Windows 进程。CIDR 指定另一个节点的夹具通过连接详情确认出站。 | 网络仍运行但节点失联的健康检查与故障切换，切网、休眠唤醒、一次授权的 TUN 服务，原系统 PAC 和 WPAD 的完整恢复矩阵。 |
| A07/A08 连通性与诊断 | `v0.1.6-preview.1` 接入四个网站的 HTTP 状态和耗时。界面标注检查使用当前路由策略。用同一测量线路实际收到 Apple、GitHub、YouTube 的 200 及 Google 的 204。后续界面用模拟 IPC 复测固定端口、网站测试、事件筛选和复制。 | 吞吐测试、断网分层诊断、更多日志级别、解锁结果与登录验证，及诊断的跨平台实测。 |
| A01/A02 WireGuard | `v0.1.9-preview.1` 使用本机 WireGuard 对端跑通 IP 与域名握手和完整 HTTP 流量。由 Windows 安装包创建 TUN 后，未配置显式代理的 TCP 请求通过 WireGuard 对端，停止后清除 TUN 网卡地址。校验官方便携包哈希后在实机重跑通过。 [Windows 安装验收](https://github.com/Bailan766/RelayDesk/actions/runs/44831533299) | 远程服务商的双栈、UDP 和多对端组合，及不同 Windows 版本。 |
| A05/A09 节点自动换线 | `v0.1.10-preview.2` 通过安装后的进程验证。夹具模拟连续探测失败，确认同一会话切到可用备用节点，后续 HTTP 走备用出站，旧探测结果也未覆盖手动选择。真实内核的单节点探测另用两条 VLESS 路径验证，一条可达 HTTPS，另一条握手失败。 [Windows 安装验收](https://github.com/Bailan766/RelayDesk/actions/runs/44833248433) | 长时间全链路自动探测、切网和休眠，以及跨内核策略组。 |
| A02/A06/A09 Mihomo 原配置 | `v0.1.14-preview.2` 从仅含提供者的配置启动。已安装的 Windows 进程加载远程节点和规则、按原 DNS 查询，并改变策略组后实际转发或拒绝同一请求。重新启动前保存的提供者节点在入口就绪前恢复。 [Windows 安装验收](https://github.com/Bailan766/RelayDesk/actions/runs/44838304370) | TUN 原配置、文件型提供者、YAML 覆写、生产环境的大型远程规则集，以及其他桌面和移动平台。 |
| A04/A06 Mihomo 原配置接入 TUN | Windows 实机使用全量严格路由验证未手动设置代理的 TCP、Shadowsocks UDP 回显和按原配置解析的 DNS。复现了直接使用系统 DNS 时的解析回路，修正后在 TUN 启用时查询成功，真实 HTTPS 上游连接也从物理网卡出去。`v0.1.15-preview.3` 通过安装后的 TCP、UDP、DNS 测试，验证策略进程异常退出后释放网卡和 DNS 监听。 [Windows 安装验收](https://github.com/Bailan766/RelayDesk/actions/runs/44844993377) | 来源和进程规则的原始连接信息、切网和休眠唤醒、IPv6、应用自带加密 DNS。 |
| A03 按订阅设定刷新周期 | 工作区测试验证默认、独立周期、关闭、旧版数据和失败后的退避。模拟桌面下载的界面测试验证全局关闭时独立周期仍生效，以及单份订阅关闭后仍能手动刷新。 | 长时间后台运行与系统唤醒后的现场刷新。 |

## 优先解决的用户风险

| 优先级 | 用户代价 | 完成条件 |
| --- | --- | --- |
| P0 | 导入有节点却连不上，或丢掉端口、传输、证书校验参数后使用了错误配置 | 单独报告识别、可连接和原配置语义保留情况。对影响连接和证书校验的字段逐项验证，遇到未知或无法映射的有效字段就定位到具体节点与字段。按 A01、A02 验收。 |
| P0 | 开启代理后掉网、意外直连，或退出后仍指向已停监听端口 | 三种接管模式分别验证正常、失败和恢复路径。独立确认 TCP、UDP、IPv4、IPv6 与 DNS 的实际路径，以及既有 PAC、WPAD、绕过列表的恢复。按 A04、A05 验收。 |
| P0 | 刷新覆盖其他来源、误选同名节点，重启或升级后改变路由 | 作为多订阅和持久化工作验收项，验证来源隔离、身份稳定、旧数据迁移、单源原子更新和配置的预期生效时点。按 A03、A06 验收。 |
| P1 | 界面显示运行中却无法访问，或者用户把单次延迟、出口 IP、内核计数当成普遍结论 | 区分入口就绪、指定节点探测、当前规则路径验证和服务可达性。提供可脱敏的失败阶段和回滚状态。按 A07、A08 验收。 |
| P1 | 从 Clash 客户端迁移后策略组、规则集和 DNS 行为变化 | 用全配置夹具对比同一请求的实际出站。先声明节点提取保留的语义，再依据 A06、A09 决定完整 Mihomo 配置、规则子集或同内核策略组的支持顺序。 |
| P2 | 更换平台、分发渠道或使用高级功能后，入口与权限行为变化 | 以 Windows 安装包和便携包为首批。服务模式、LAN 共享、备份、外部控制器、移动端和路由器按各自场景单独立项，以矩阵收录。按 A10、A11 验收。 |

## RelayDesk 基线证据

| 范围 | 核查结果 |
| --- | --- |
| 导入与存储 | 【RD-源码】支持粘贴、读取本地文本文件和由桌面端发起 HTTPS 请求。基线请求超时 20 秒、禁止自动跟随重定向，下载上限 4 MiB，响应正文要求 UTF-8。SQLite 只有一条 DPAPI 加密记录，保存原内容、来源及选择的数组索引。新导入会替换该记录，运行代理时界面要求先停止。源里的同协议、主机、端口和显示名会去重，解析时生成随机 ID。共享端点或同名的不同连接参数可能被合并。 [HTTPS 请求](../src-tauri/src/main.rs#L307) · [数据保护与单条记录](../src-tauri/src/storage.rs#L6) · [导入与恢复](../src/main.tsx#L76) · [去重键](../src/subscription.ts#L46) |
| 配置与实际能力 | 【RD-源码】解析器读取 URI 列表、可解码的 Base64、YAML 的 `proxies` 或 `outbounds`、JSON 的 `outbounds` 或节点数组。对象节点仅抽取少数字段，缺少供生成器读取的 `uri`。VMess、Trojan、Shadowsocks、TUIC 可被识别并显示，当前构建器仅为带 URI 的 VLESS、Hysteria2 生成出站，其中 VLESS 传输限于 `tcp/ws/grpc`。节点可选判定调用配置生成器，启动时网络进程再以随包内核执行 `check`。 [解析器](../src/subscription.ts#L3) · [配置生成与判定](../src/config.ts#L5) · [内核检查](../src-tauri/src/network.rs#L445) |
| 路由与 DNS | 【RD-源码】本地端口与系统代理使用回环 mixed 入站，支持按序匹配精确域名或后缀，动作是直连、代理、拒绝，缺省走当前节点。规则留在前端会话内，运行时修改在下次连接时应用。TUN 从前端配置提取允许的字段，重建双栈虚拟网卡配置，开启自动和严格路由，先嗅探，再接管核心识别为 DNS 的流量。节点域名用本机解析器引导，普通 DNS 默认经代理访问固定 DoH。实际 DNS 出口、应用自带 DoH、LAN 和 IPv6 的表现仍需抓取实际路径。 [普通配置](../src/config.ts#L45) · [规则编辑](../src/main.tsx#L741) · [TUN 规则与 DNS](../src-tauri/src/network.rs#L207) |
| 接管与恢复 | 【RD-源码】Windows 系统代理通过 WinINet 设置，记录原值并条件恢复。启动、工作进程退出及安装器升级和卸载均存在恢复路径。正常就绪门槛为本地监听，TUN 额外验证 IPv4 虚拟网卡地址可绑定。TUN 启动使用 `runas`，运行中换节点停旧、启新，失败会尝试恢复旧节点。 [代理恢复记录](../src-tauri/src/system_proxy.rs#L159) · [授权与启动](../src-tauri/src/network.rs#L267) · [就绪与退出](../src-tauri/src/network.rs#L475) · [安装器钩子](../src-tauri/network-hooks.nsh) · [切换与回滚](../src/main.tsx#L207) |
| 测量与诊断 | 【RD-源码】本机 Google TCP 测试计入 DNS 与 TCP 建连。单节点探测用临时内核和独立配置向固定 HTTPS 端点请求并要求 204，界面最多并发四个，取消只停止继续取队列。当前会话连通性验证走当前本地 mixed 入口，会应用域名规则。IP 查询也经当前入口访问 ipify。日志及服务解锁有占位，内核进程的标准输出和标准错误被丢弃。 [本机 TCP、节点和 IP 探测](../src-tauri/src/main.rs#L46) · [会话探测](../src-tauri/src/main.rs#L282) · [批量与取消](../src/main.tsx#L245) · [日志与诊断界面](../src/main.tsx#L630) · [进程输出](../src-tauri/src/network.rs#L445) |
| 流量与连接 | 【RD-源码】每次会话生成随机凭据与独立回环控制端口，经 sing-box Clash API 读取 `/connections`。界面按会话差分取速率，显示近十分钟历史、已观测字节计数和活动连接的目标、来源、命中规则与出站等。切换内核会话会重置统计，订阅商流量、系统网卡流量和当前会话计数是三个口径。 [监控控制器](../src-tauri/src/telemetry.rs#L13) · [会话一致性](../src-tauri/src/main.rs#L254) · [采样与显示](../src/telemetry.tsx#L37) · [sing-box Clash API](https://sing-box.sagernet.org/configuration/experimental/clash-api/) |
| 已有验证 | 【RD-测试定义】单测覆盖部分订阅解析、字段映射和 DPAPI 存读，带 `SING_BOX` 时额外检查两种生成配置的语法。安装包冒烟以本地夹具检查监听、系统代理启停和模拟父进程退出后的恢复、TUN IPv4 网卡生命周期、控制接口鉴权、直连字节计数，以及安装、重装和卸载。脚本对系统代理恢复只断言开关与服务器，对 TUN 只断言 IPv4 网卡建立与删除。真实上游握手、DNS 去向、UDP 与 IPv6 数据路径仍是独立验收项。 [解析单测](../src/subscription.test.ts) · [配置单测](../src/config.test.ts) · [真实内核语法检查](../src/core-validation.test.ts) · [存储测试](../src-tauri/src/storage.rs#L58) · [网络冒烟](../.github/scripts/test-windows-network.ps1#L63) · [CI 安装验证](../.github/workflows/windows.yml#L55) |

## 代表产品与适用平台

| 家族 | 【上游】可追溯的差异 | 对标 RelayDesk 时要验证的行为 |
| --- | --- | --- |
| **Clash Verge Rev** · Windows、macOS、Linux | Tauri 客户端随包带 Mihomo，提供 Merge、Script、可视化规则、系统代理和 TUN。远程配置可设置刷新间隔、UA 和请求路径。Windows 文档区分服务模式、普通进程与管理员运行，并描述服务对内核安装路径权限的检查。 [项目说明](https://github.com/clash-verge-rev/clash-verge-rev/blob/dev/docs/README_en.md) · [配置更新说明](https://github.com/clash-verge-rev/clash-verge-rev/blob/dev/PRIVACY.md) · [Windows 服务与权限](https://www.clashverge.dev/faq/windows.html) | 同一份完整 YAML 的远程刷新、覆写后规则顺序和实际出口，Windows 下区分一次安装服务授权与按会话提权。A03、A04、A06、A10。 |
| **Clash Party（Mihomo Party）** · 桌面 | 项目源码提供配置级与全局覆写、YAML 合并、JS 脚本和规则增删，同时暴露 Sub-Store 订阅及合集、运行时配置、内核热重载和备份接口。源码观察基于 `smart_core` 分支，发布包需按标签核对。 [项目组织](https://github.com/mihomo-party-org) · [配置生成源代码](https://github.com/mihomo-party-org/clash-party/blob/smart_core/src/main/core/factory.ts) · [应用 IPC 源代码](https://github.com/mihomo-party-org/clash-party/blob/smart_core/src/main/utils/ipc.ts) · [发布](https://github.com/mihomo-party-org/clash-party/releases) | 给全局、单配置和规则覆写同一个字段，比较最终值、失败时保留项和会话是否重启。Sub-Store 合集刷新与内核 provider 健康检查分别记录。A03、A06、A09。 |
| **v2rayN** · Windows、Linux、macOS | 官方 Wiki 列出 Xray、v2fly、Mihomo、sing-box 及数个专用内核。订阅按分组管理，也能按特定约束合并同类型来源，提供自定义 UA、延迟和吞吐分批测试以及指定协议的 UDP 测试。单个发行包包含的内核和各节点分配到的内核需要实查。 [项目](https://github.com/2dust/v2rayN) · [内核清单](https://github.com/2dust/v2rayN/wiki/List-of-supported-cores) · [界面行为](https://github.com/2dust/v2rayN/wiki/Description-of-some-ui) | 以同协议不同传输、结构化配置和易混同名节点比较分组导入、内核选择及诊断粒度。A01、A03、A07。 |
| **NekoBox for Android** | sing-box 系移动端。README 明确 ClashMeta、v2rayN 等输入和 sing-box 出站只提取节点，原分流规则被忽略。NaïveProxy、Trojan-Go、Mieru 在其清单中标为插件能力。上游 README 将 GitHub Releases 与第三方控制的同名 Google Play 包区分开，盘点以官方 GitHub 渠道为准。 [订阅格式、插件和渠道](https://github.com/MatsuriDayo/NekoBoxForAndroid) | 作为节点提取型产品对照，核实完整配置被裁剪的反馈，以及缺失插件时列表、启动和报错的行为。A01、A02、A11。 |
| **Clash Meta for Android** | 官方仓库说明为 Clash.Meta Android GUI，记录含指定分支来源的 Android 内核、启动与停止 Intent 和配置导入 URI。网络设置源码有 VPN 接管、DNS 接管、IPv6、私网绕过、允许或拒绝选中的应用。 [项目与自动化](https://github.com/MetaCubeX/ClashMetaForAndroid) · [网络设置源码](https://github.com/MetaCubeX/ClashMetaForAndroid/blob/main/design/src/main/java/com/github/kr328/clash/design/NetworkSettingsDesign.kt) | 比较同一完整配置在桌面和 Android 的出口，以及应用名单与规则分流分别在哪里生效。系统常驻和断开阻断另测。A05、A06、A11。 |
| **FlClash** · Windows、macOS、Linux、Android | README 列出 Mihomo 规则、代理组、系统代理与 TUN，支持链接或文件配置、编辑及覆写，并同时呈现连接、请求、DNS 查询和日志。桌面 tray 与热键、Android 快捷设置与分应用、WebDAV 或本地备份分别有平台适用性。 [功能与发行平台](https://github.com/chen08209/FlClash#features) | 以一次失败请求串联命中规则、DNS 与日志，验证恢复包跨版本行为；分别验证 Windows 安装及便携包。A08、A10、A11。 |
| **Hiddify** · Windows、macOS、Linux、Android、iOS | README 以 sing-box 为基础，同时列出 Xray 特性，声明接受 sing-box、V2Ray、Clash 系输入，支持自动更新和选路、订阅用量与期限，以及 Android 分应用与 LAN 共享。格式声明需要展开到字段与实际构建。 [功能与平台](https://github.com/hiddify/hiddify-app#-main-features) | 用相同夹具检查自动选路与手选、失败来源的保留、用量缺失与到期、各平台入口以及 LAN 的监听范围。A01、A03、A09、A11。 |
| **v2rayNG 与 sing-box 官方客户端** | v2rayNG 是另一个 Android 样本，上游记录 Xray / v2fly、可导入 Geo 数据和发布包 GPG 签名。sing-box 列出 Android、Apple 与 Linux 桌面的官方客户端，Apple 平台功能单独列示。 [v2rayNG 项目与签名](https://github.com/2dust/v2rayNG) · [sing-box 官方客户端列表](https://sing-box.sagernet.org/clients/) · [Apple 客户端功能](https://sing-box.sagernet.org/clients/apple/features/) | 按本机实际构建的内核与包渠道记录。Android VPN 常驻、Apple Network Extension 和 Windows TUN 使用各自平台验收。A10、A11。 |

## 内核、配置与互操作边界

| 对照 | 【上游】能力和不同语义 | RelayDesk 的判断点 |
| --- | --- | --- |
| **sing-box** | 原生 JSON 中入站、出站、路由、DNS 和规则集各有作用域。规则集可独立交付，`selector`、`urltest` 属于出站。URLTest 提供间隔、容差和是否打断既有入站连接的设置。迁移文档记录旧 Geo 数据、DNS 配置和 TUN 栈切换，滚动文档可能覆盖比 1.14.4 更新的字段。 [规则集](https://sing-box.sagernet.org/configuration/rule-set/) · [Selector](https://sing-box.sagernet.org/configuration/outbound/selector/) · [URLTest](https://sing-box.sagernet.org/configuration/outbound/urltest/) · [迁移](https://sing-box.sagernet.org/migration/) · [TUN](https://sing-box.sagernet.org/configuration/inbound/tun/) | 【RD-源码】现有 JSON 导入抽取对象节点，没有运行原始 JSON，当前选节点是重启会话。内核升级要对锁定版本和目标版本分别进行 `check`、握手、路由和回滚验证。A01、A09、A10。 [解析器](../src/subscription.ts#L27) · [切换逻辑](../src/main.tsx#L207) |
| **Mihomo（Clash.Meta）** | YAML 的 `proxies` 定义具体节点，`proxy-providers` 管来源、更新与节点健康检查，`proxy-groups` 管手选、时延择优、优先顺序回退或负载均衡。`rule-providers` 承载规则输入，`rules` 决定匹配顺序与出口，并可表达 IP 段、进程、传输协议和规则集条件。DNS 含 fake-IP、按名称选择解析器等控制。 [代理来源](https://wiki.metacubex.one/en/config/proxy-providers/) · [代理组](https://wiki.metacubex.one/en/config/proxy-groups/) · [规则来源](https://wiki.metacubex.one/en/config/rule-providers/) · [路由](https://wiki.metacubex.one/en/config/rules/) · [DNS](https://wiki.metacubex.one/en/config/dns/) | 【RD-源码】只有单节点出站和自建域名规则。读取 `proxies` 字段、接入 Clash API 和按原语义运行完整 Mihomo 配置需要三种证据。供应商刷新、订阅聚合、规则来源更新和健康检查应各自有状态。A01、A03、A06、A09。 [解析器](../src/subscription.ts#L33) · [生成配置](../src/config.ts#L45) · [控制器](../src-tauri/src/telemetry.rs#L33) |
| **Xray 与 v2fly** | Xray 的 JSON 以出站标签、路由和 balancer 配合，Observatory 为出站探测提供数据。其传输文档和分享链接提案有 XHTTP 及相应字段。v2fly 是另一个有独立仓库与发布的内核，按产品绑定的内核和版本记录。 [Xray 传输](https://xtls.github.io/en/config/transport.html) · [路由与 balancer](https://xtls.github.io/en/config/routing.html) · [Observatory](https://xtls.github.io/en/config/observatory.html) · [分享链接提案](https://github.com/XTLS/Xray-core/discussions/716) · [v2fly 源码和发布](https://github.com/v2fly/v2ray-core) | 【RD-源码】VLESS 协议名可以识别，生成器只处理指定传输，拒绝非 `none` 的 `encryption`。解析器会读取 `network`，生成器只看 `type`。兼容矩阵应把 VLESS+WS、gRPC、Reality 和 XHTTP 展开，核实是否映射了每个有效参数。A02。 [解析参数](../src/subscription.ts#L23) · [传输与加密](../src/config.ts#L12) |
| **Hysteria 2 与 Shadowsocks URI** | Hysteria 2 官方 URI 的端口可省略并默认 443，端口部分可表达范围，支持用户密码组合、混淆和证书指纹等参数。sing-box 使用单个出站密码字段接收用户密码组合，端口范围另有字段。Shadowsocks SIP002 定义分享 URI、有条件的 userinfo 编码及插件字段。 [Hysteria 2 URI](https://v2.hysteria.network/docs/developers/URI-Scheme/) · [sing-box Hysteria2](https://sing-box.sagernet.org/configuration/outbound/hysteria2/) · [Shadowsocks SIP002](https://github.com/shadowsocks/shadowsocks-org/wiki/SIP002-URI-Scheme) | 【RD-源码】基线要求显式整数端口，用 `mport` 表达范围，只读 URL username，未映射 `obfs`、`obfs-password`、`pinSHA256`。证书指纹和跳过校验同现时尤其要明确拒绝或等价实现。识别 `ss://` 可列为导入证据，连接仍需握手证明。A02。 [URI 解析](../src/subscription.ts#L8) · [出站字段](../src/config.ts#L5) |

Windows 系统代理消费者包括使用当前设置的应用，WinHTTP 是否采用这些设置取决于应用选项。TUN 的工作范围须由路由表、应用行为及 TCP/UDP/DNS 观测来确定。本机引导解析、应用自带安全 DNS、直连规则和故障后的路径应在界面和测试中分别呈现。Android `VpnService` 在建立时配置允许或拒绝名单，系统常驻与阻断是单独的开关。Apple 的 Packet Tunnel 由 Network Extension 提供，受平台权限和按应用管理方式约束。 [Microsoft WinINet 到 WinHTTP](https://learn.microsoft.com/en-us/windows/win32/winhttp/setting-wininet-proxy-configurations-in-winhttp) · [WinHttpOpen 代理模式](https://learn.microsoft.com/en-us/windows/win32/api/winhttp/nf-winhttp-winhttpopen) · [Android VPN](https://developer.android.com/develop/connectivity/vpn) · [Apple VPN 路由](https://developer.apple.com/documentation/networkextension/routing-your-vpn-network-traffic)

## 相邻项目的独立能力

| 项目与角色 | 【上游】可借用的对照场景 |
| --- | --- |
| **Sub-Store** · 订阅管理 | 专职订阅管理与面向多客户端的输出，Clash Party 源码另有对其订阅和合集的集成。用两源同名节点、不同出站支持集合以及单源失败测试转换保真和来源归属。 [项目及文档入口](https://github.com/sub-store-org/Sub-Store) · [Clash Party 集成](https://github.com/mihomo-party-org/clash-party/blob/smart_core/src/main/utils/ipc.ts) |
| **metacubexd** · Mihomo 控制面 | 项目文档区分应用控制端点与 Clash API，描述回环端口、鉴权、跨源配置、内核版本面板和服务端部署。用独立端口、错误凭据及连接标识验证可观测性和控制面边界。 [项目运行与故障诊断](https://github.com/MetaCubeX/metacubexd) · [Mihomo API](https://wiki.metacubex.one/en/api/) |
| **Shadowsocks for Windows** · 专用客户端 | 官方仓库说明可用 GeoSite 生成 PAC，并有白名单、黑名单与域名组语义。用两条 URL 验证代理感知应用执行 PAC 后的实际选择，以及退出是否恢复用户原来的 PAC。 [PAC 说明](https://github.com/shadowsocks/shadowsocks-windows#pac) |
| **Outline** · 客户端与服务端管理 | 动态访问密钥引用可更新的远程连接信息，是连接配置轮换的独立参照。固定同一配置引用，先指向 A 再指向 B，观察轮换失败如何保留可用状态。 [客户端及管理端源码](https://github.com/OutlineFoundation/outline-apps) · [动态访问密钥](https://developer.getoutline.org/vpn/management/dynamic-access-keys/) |
| **WireGuard for Windows** · 三层隧道 | 官方实现文档写明管理服务、每个隧道服务、访问控制与管理接口，适合比较启动、权限、故障恢复。Windows 服务生命周期值得对照，WireGuard 的数据模型另计。 [Windows 企业部署](https://git.zx2c4.com/wireguard-windows/about/docs/enterprise.md) · [WireGuard 协议](https://www.wireguard.com/protocol/) |
| **OpenClash** · OpenWrt 网关 | 上游为 OpenWrt 提供 LuCI 安装包，以 Mihomo 为内核，文档区分 iptables 与 nftables 的透明代理依赖。两个 LAN 测试端、网关 WAN 与本机源流量应各自观测，归为路由器样本。 [项目、安装与 Wiki 入口](https://github.com/vernesong/OpenClash) |
| **hev-socks5-tunnel** · TUN 到 SOCKS5 组件 | 项目提供独立 tun2socks 组件，适合隔离测 TUN 到 SOCKS5 路径、分别确认 TCP 与 UDP。产品体验和 OS 代理恢复由宿主另行验收。 [组件源码与特性](https://github.com/heiher/hev-socks5-tunnel) |

## 可复现验收场景

【验收】在隔离的 Windows 虚拟机固定系统构建、安装渠道、应用版本、内核版本和构建来源。为网络用例搭建自管双栈实验网，限制出站只到夹具。让 `a.fixture.test` 和 `b.fixture.test` 分别提供可区分的出口 A、B，应用侧分别测试直连 `direct.fixture.test`、明确代理 `proxy.fixture.test`、拒绝 `blocked.fixture.test`，并用 `outside.test` 验证默认行为。每条 HTTP 或 UDP 请求带唯一运行标记。用可区分直连和两个代理出口来源的 HTTP 服务、UDP 回显、DNS 应答及夹具出口日志对账，TLS 使用实验环境内受信任的证书。所有用户名、节点 ID 和口令均为测试数据。仅解析的用例用保留域名，端到端用例把相同域名映射到实验网。若基线的固定探测或 DoH 端点无法在隔离夹具控制，记录为待验并用测试构建注入目标。每次记录预期和观测、出口 ID、命中规则、错误阶段和恢复结果。工件仅保存脱敏数据。

### A01 · 输入识别和完整配置保真 · P0

将同一合成 VLESS 节点分别做成 URI、Base64 包装的 URI 列表、含 `proxies` 的 YAML、含 `outbounds` 的 sing-box JSON。分别导入下方三个样本，另将第一段 UTF-8 文本编码为 Base64 后导入。基线预期四个输入各识别一个节点，URI 与包装后的 URI 可生成配置，YAML／JSON 对象显示暂不支持。然后为 YAML 加入带 `use` 的策略组、远程 provider、DNS 和三条有序规则，为 JSON 加入 `selector`、显式 DNS 和 `route.final`。一次导入各一份；批量样本中增加一条无效行及同名同端点但不同传输的第二条 URI。比对每源可识别数、可生成数、保留字段、无效原因。启用该产品声明支持的入口，发请求并由接收端确认原有各域规则及默认出口。在节点提取模式下常驻显示已裁剪的配置节。对照 Clash Verge Rev 或 FlClash 的完整配置，与 NekoBox 的节点提取预期分别验收。

```text
vless://00000000-0000-4000-8000-000000000000@a.fixture.test:443?security=tls&type=ws&path=%2Ffixture#A
```

```yaml
proxies:
  - name: A
    type: vless
    server: a.fixture.test
    port: 443
    uuid: '00000000-0000-4000-8000-000000000000'
    tls: true
    network: ws
    ws-opts: {path: /fixture}
```

```json
{"outbounds":[{"type":"vless","tag":"A","server":"a.fixture.test","server_port":443,"uuid":"00000000-0000-4000-8000-000000000000","tls":{"enabled":true},"transport":{"type":"ws","path":"/fixture"}}]}
```

### A02 · 参数映射、核心检查和真实握手 · P0

以 A01 的 URI 为起点，每次只换一项。VLESS 分别用 `type=tcp/ws/grpc/xhttp`，尝试仅提供 `network=ws`、有效与无效的 REALITY 参数及受测内核不支持的加密选项。Hysteria 2 分别做省略端口、在 authority 中提供范围、使用 `mport`、用户密码组合、混淆、证书 pin 和错误 pin 的样本。Shadowsocks 分别做 SIP002 的编码及插件样本。逐个记录解析结果、字段映射、内核检查退出码和握手结果。已承诺支持的用例必须走实际出站；不受支持的组合应在连接前给出具体原因。错误 pin 或不能落实的 pin 必须阻止连接，即使同一个输入还允许跳过普通证书验证。改错 WS 路径、SNI 或凭据时，保留本地入口就绪状态并单独显示上游握手失败。使用同一服务端顺序验证各内核的版本和参数。 [VLESS 分享链接提案](https://github.com/XTLS/Xray-core/discussions/716) · [Hysteria 2 URI](https://v2.hysteria.network/docs/developers/URI-Scheme/) · [SIP002](https://github.com/shadowsocks/shadowsocks-org/wiki/SIP002-URI-Scheme)

### A03 · 多来源刷新与旧数据迁移 · P0

用单条旧版记录启动升级，确认原来源、内容和选择都能恢复。添加由本地 HTTPS 服务提供的 A、B，以及一个文件来源 C。A 和 B 各有一个显示名一致但连接参数或来源不同的节点。选择 A 后让响应重排和改名，刷新 B 时让其先超时、后返回无效文本或超限响应，再恢复正常；另外交错发两次 A 刷新，让较旧请求最后返回。观察选中节点、活动会话、每源刷新时间和上次成功缓存。预期无跨来源覆盖、旧请求倒灌与静默换节点，当前节点消失时界面给出状态及明确的替换策略。再用 HTTPS 成功响应、302、401、304 和不同 UA 触发的内容跑一轮，逐一记录是否重定向、是否复用缓存与请求路径。出错时日志中无带查询参数的完整 URL。用自定义响应头分别给有效、缺失、畸形和过期用量，如界面提供用量展示，验证单位、未知状态及上次成功时间。重启后重复。 [v2rayN 订阅配置](https://github.com/2dust/v2rayN/wiki/Description-of-some-ui) · [Hiddify 配置详情](https://github.com/hiddify/hiddify-app#-main-features) · [Microsoft DPAPI 作用域](https://learn.microsoft.com/en-us/windows/win32/api/dpapi/nf-dpapi-cryptprotectdata)

### A04 · Windows 三种接管方式和恢复 · P0

在连接前分别准备原本直连、已有手动系统代理、带 PAC/绕过项的自动代理三组基线并记录 WinINet 设置。系统代理模式用读取当前 Windows 设置的应用和明确直连的原始 TCP 客户端各发一条请求，记录两条路径。本地端口模式用显式 HTTP 或 SOCKS5 客户端访问夹具，确认系统设置保持原值。TUN 模式另用不读系统代理的 TCP 客户端及 UDP 回显验证接管，取消管理员授权时复查原设置、进程与网卡。对三类模式执行停止、托盘退出、模拟 GUI 父进程退出、内核退出、启动失败、切换失败、安装包重装及卸载；有恢复延迟时记录耗时与界面状态。系统代理运行中用实验工具改为另一个代理，退出后以实际用户设置核对保留行为。同时比较服务器、开关、PAC、WPAD、绕过项和网络可达性。每组先用 PowerShell 7 执行仓库的网络冒烟脚本，并通过 `-App` 指向该组安装的 `relaydesk.exe`。再跑数据路径，捕捉监听仍在但上游失效的情况。 [本地网络冒烟入口](../.github/scripts/test-windows-network.ps1) · [Windows 代理配置](https://learn.microsoft.com/en-us/windows/win32/winhttp/setting-wininet-proxy-configurations-in-winhttp)

### A05 · DNS、IPv6、UDP 与 LAN · P0

在双栈 VM 清空测试缓存后，用每轮独立的域名发 A/AAAA 查询并进行 IPv4/IPv6 HTTP 流和 UDP 回显。分别让默认解析器正常或不可达，令代理节点域名触发引导解析，再测试应用自带 DoH、局域网私网段、切换 Wi-Fi/有线等价实验网卡及休眠唤醒。比对 DNS 与出站日志和接口路由，记录代理、直连、阻断、超时及实际出口。先写下故障时允许直连或应阻断的预期再运行；实际直连必须与模式、规则以及故障状态一致。将真实握手的 UDP 流与 DNS 查询拆开。Windows 严格路由、Android 常驻断开阻断和 Apple 全隧道按平台分别测。 [sing-box TUN 文档](https://sing-box.sagernet.org/configuration/inbound/tun/) · [Android VPN](https://developer.android.com/develop/connectivity/vpn) · [Apple VPN 路由](https://developer.apple.com/documentation/networkextension/routing-your-vpn-network-traffic)

### A06 · 路由顺序、覆写与配置生效 · P0／P1

将 `blocked.fixture.test` 精确拒绝放在 `fixture.test` 后缀直连之前，另选 `outside.test` 验证默认走代理；交换前两条规则再测。增加后缀边界 `notfixture.test` 和同目标的域名请求与 IP 直拨，记录规则命中和实测出口。运行中改规则，按界面声明观察生效时点，重连、重启、升级后再验证。将同样意图表达为 Mihomo rule-provider、sing-box rule-set 和 Xray 路由；对覆写声明支持的产品加入同键冲突、损坏的规则更新和脚本失败夹具，分别检查最终配置和是否保留上次可用版本。导入无法保留优先级或默认动作时直接显示损失。 [Mihomo 路由](https://wiki.metacubex.one/en/config/rules/) · [sing-box 规则集](https://sing-box.sagernet.org/configuration/rule-set/) · [Xray 路由](https://xtls.github.io/en/config/routing.html)

### A07 · 延迟、带宽、出口和失败语义 · P1

自管探测端点提供固定延迟的 204、302、200、超时、错误证书和指定大小的下载文件。配置一个“本地端口已监听但握手失败”的节点，并让活动规则把同一探测域名设为直连。比对本机 DNS/TCP、单节点端到端 HTTPS、当前路由下 HTTPS、带宽、UDP 和 IP 查询；所有耗时标注样本、目标、时间及实际出站。以两个出口的日志确认当前会话验证和 IP 查询是否真的命中代理，避免规则直连时显示成节点验证通过。加入批量取消，记录已发请求是否会完成、新任务停止取队列的边界及资源回收。第三方单次站点请求只证明该请求的观测结果。 [RelayDesk 探测源代码](../src-tauri/src/main.rs#L46) · [v2rayN 测试设置](https://github.com/2dust/v2rayN/wiki/Description-of-some-ui) · [Mihomo 健康检查](https://wiki.metacubex.one/en/config/proxy-providers/#health-check)

### A08 · 计数、日志与隐私 · P1

通过回环代理做一条持续连接，传两次已知大小的载荷，核对活动连接、命中规则、出站和统计变化。独立记录应用载荷与内核统计口径，确认计数单调并核对增量；模拟监控接口短暂不可用、快速切换节点及停止，观察状态、速率峰值和跨会话污染。失败时用缺内核、配置错误、监听冲突、DNS 超时和 TLS 错误分别走故障路径。导出诊断时用合成敏感标记检查 URL 查询、认证值、控制 API 凭据与临时配置原文是否暴露；验证控制端口回环绑定、无凭据请求被拒、停用后端口回收。用同一 Windows 用户的 DPAPI 读回验证本地数据和备份目标。 [RelayDesk 监控与测试](../src-tauri/src/telemetry.rs) · [Windows 冒烟](../.github/scripts/test-windows-network.ps1#L101) · [metacubexd 控制接口](https://github.com/MetaCubeX/metacubexd) · [Microsoft DPAPI](https://learn.microsoft.com/en-us/windows/win32/api/dpapi/nf-dpapi-cryptprotectdata)

### A09 · 策略组、故障转移和切换代价 · P1

令出口 A 稳定 30 ms、B 稳定 120 ms，然后让 A 超时，再恢复为 90 ms。固定探测间隔、容差、失败门限和规则组，分别运行手选、择优、优先回退、负载均衡。保留一条长连接，同时每隔一秒新建连接并记实际出口。验收手选是否保持、切换与恢复是否符合策略、新旧连接是否依约保留或重建，并统计断流与告警持续时间。把服务不可达、从 provider 删除节点和刷新失败作为独立刺激。当前基线可用同场景测手选重启与回滚。 [Mihomo 代理组](https://wiki.metacubex.one/en/config/proxy-groups/) · [sing-box URLTest](https://sing-box.sagernet.org/configuration/outbound/urltest/) · [Xray 路由与均衡](https://xtls.github.io/en/config/routing.html)

### A10 · Windows 分发、权限和内核更新 · P1／P2

在快照上分别用 x64 NSIS 与便携包启动、运行三入口，再从 0.1.3 基线升级并验证数据与网络设置。记录安装包签名、内核版本、哈希、缺内核和 WebView2 时的恢复提示。模拟新内核无法读取旧配置，验证旧版本仍可启动且应用能说明失败阶段。若加入常驻服务，分别测初装授权、普通用户重连、服务不可用和服务更新，普通权限账户不能替换系统服务实际执行的已验证内核。对备份或跨设备恢复，使用合成配置分别测口令化导出和仅当前 Windows 用户可解密的存储。 [RelayDesk 包与校验](../.github/workflows/windows.yml#L23) · [预览版签名说明](../RELEASE_NOTES.md) · [Clash Verge Rev Windows 服务](https://www.clashverge.dev/faq/windows.html) · [WireGuard Windows 服务](https://git.zx2c4.com/wireguard-windows/about/docs/enterprise.md)

### A11 · 平台扩展、外部控制与 LAN · P2

在 Android 上用两个应用和同一目标，分别验证允许/拒绝名单、VPN 授权撤销、系统常驻与断开阻断、Wi-Fi 与蜂窝切换。Apple 平台用相应签名及平台版本验证扩展安装、授权、休眠及按需重连，分应用场景记录设备是否受管。Linux 分开验证桌面系统代理与 TUN 权限，路由器以 LAN 客户端验证转发。对声明 LAN 共享的产品，用另一测试主机检查默认监听范围和显式开放后的接口、入站类型、访问控制，再关闭确保收回。外部仪表盘按控制器 API 和版本访问，验证正确来源下成功、无凭据及未允许来源请求被拒。 [Android VPN](https://developer.android.com/develop/connectivity/vpn) · [Apple 扩展](https://developer.apple.com/documentation/xcode/configuring-network-extensions/) · [OpenClash](https://github.com/vernesong/OpenClash) · [Mihomo API](https://wiki.metacubex.one/en/api/) · [Hiddify](https://github.com/hiddify/hiddify-app#-main-features)

## 可扩展盘点方法

1. **从一手索引扩展。** 先按 Windows GUI、跨平台 GUI、Android、Apple、Linux 桌面、路由器、内核、订阅处理、控制面和专用隧道建立项目清单。以 Mihomo 官方客户端清单、sing-box 官方 GUI 列表、v2rayN 核心清单和项目依赖或子模块拓展候选。记录仓库、许可证、维护组织、别名、上游与 fork 关系、发布渠道和安装形态。同一项目更名、镜像和包装复用记录；沿分叉补入有独立行为证据的产品。 [Mihomo 客户端索引](https://wiki.metacubex.one/en/startup/client/) · [sing-box GUI 列表](https://sing-box.sagernet.org/clients/) · [v2rayN 内核清单](https://github.com/2dust/v2rayN/wiki/List-of-supported-cores)
2. **每一行只有一个可验收主张。** 主键为「产品及版本 × OS 构建与架构 × 发行渠道 × 内核及版本 × 行为 × 夹具 ID」。字段包括核心角色、用户路径、输入与保留字段、接管方式、预计出站、失败阶段、证据链接、运行时间、结果与优先级。为每个输入分别填识别、转换、内核检查、实际连接、路由保真五列；依赖外部内核或插件时记组件与安装条件。按需增加性能和升级列，保留原始条件和计量单位。
3. **保留版本和证据层级。** 对上游先读对应发布版本的官方配置文档、固定提交源码和发布工件说明。滚动文档保留访问日期，适用版本存疑时标记待验。可从 GitHub 公共 Releases API 匿名读取标签、预发布标记、发布时间、资产名，并按 Git 标签或提交固定证据链接。功能页是声明，源码说明路径，语法检查证明该样本可装载，同平台端到端夹具通过后再给「已验证」。 [GitHub Releases API](https://docs.github.com/en/rest/releases/releases#list-releases)
4. **明示覆盖缺口。** 每格状态用「未调查」「上游声明」「源码证实」「仅语法验证」「实测通过」「实测失败」或「平台不适用」。例如，基线 Windows x64 的 VLESS/WS URI 在 A01 的转换格为「源码证实」，其握手格留待 A02 实测。关注已跑过夹具的 P0/P1 格数、未通过项和未知项。每次内核或接管路径变化优先重跑 A01、A02、A04、A05、A06；每次存储模型变动加跑 A03；每次探测或统计变动加跑 A07、A08。产品对标结论随发行渠道、版本和夹具结果更新。
5. **分轮扩展。** 首轮锁定 Windows x64 安装包与便携包，用 Clash Verge Rev 的完整配置、v2rayN 的多来源和内核覆盖、FlClash 的诊断做相同夹具对照。第二轮加入 Clash Party 覆写与订阅聚合并对照 Mihomo、sing-box、Xray 的语义。再加入移动、Linux、Apple 和网关，用平台专属夹具。版本跨度优先覆盖当前稳定版和一个正在使用的旧版本；发现影响连接或恢复的回归时再加版本切片。

首批发布门槛以 P0 场景的结果衡量。可以导入的内容应准确显示能运行的部分和保留下来的语义。连接要能验证实际出站，失败和退出要可恢复。后续策略组、第二内核或移动端的投资顺序由未通过场景触达的用户路径决定。
