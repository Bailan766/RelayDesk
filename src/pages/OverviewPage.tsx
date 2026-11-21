import { invoke, isTauri } from "@tauri-apps/api/core";
import { Globe2, Loader2, Star } from "lucide-react";
import { MihomoGroups } from "../MihomoGroups";
import { TrafficDashboard, formatBytes, type useTelemetry } from "../telemetry";
import type { NodeProfile } from "../subscription";
import type { EntryMode, LatencyRecord, RoutingMode, Workspace } from "../workspace";
import { entryModes, latencyClass, routingModes, type ExitIpDetail, type ProxyStatus } from "../utils/nodes";
import type { TunServiceStatus } from "../components/SettingsPage";

export function OverviewPage({
  running,
  recovering,
  busy,
  checking,
  testing,
  port,
  allowLan,
  mode,
  routingMode,
  connectionError,
  recoveryMessage,
  checkResult,
  originalName,
  current,
  runningOriginal,
  originalUpdated,
  proxyTampered,
  rulesDirtyWhileRunning,
  elevated,
  serviceStatus,
  serviceBusy,
  workReady,
  tunIpv6,
  probeUrl,
  activeSubUsed,
  activeSubTotal,
  activeSubExpiry,
  hasMihomoSub,
  firstMihomoSubId,
  nodeHealth,
  exitIp,
  exitIpError,
  mihomoDelays,
  telemetry,
  quickNodes,
  nodesCount,
  starred,
  probe,
  isSelected,
  onCheckProxy,
  onChangeEntryMode,
  onChangeRouting,
  onToggleProxy,
  onInstallService,
  onRepairSystemProxy,
  onApplyOriginalUpdate,
  onReconnectNodeSession,
  onSwitchBackToNodeMode,
  onSwitchToOriginal,
  onTestNode,
  onShowExitIp,
  onMihomoDelays,
  onOpenFullGroups,
  onSaveMihomoSelection,
  onResetDiagnostics,
  onOpenNodesPage,
  onSelectNode,
  onConnectNode,
  onOpenImport,
}: {
  running: boolean;
  recovering: boolean;
  busy: boolean;
  checking: boolean;
  testing: boolean;
  port?: number;
  allowLan: boolean;
  mode: EntryMode;
  routingMode: RoutingMode;
  connectionError: string;
  recoveryMessage: string;
  checkResult: string;
  originalName?: string;
  current?: NodeProfile;
  runningOriginal?: { id: string; name: string; content: string };
  originalUpdated: boolean | "" | undefined;
  proxyTampered: boolean;
  rulesDirtyWhileRunning: boolean;
  elevated: boolean;
  serviceStatus: TunServiceStatus | null;
  serviceBusy: boolean;
  workReady: boolean;
  tunIpv6: boolean;
  probeUrl: string;
  activeSubUsed: number | null;
  activeSubTotal?: number;
  activeSubExpiry?: string;
  hasMihomoSub: boolean;
  firstMihomoSubId?: string;
  nodeHealth: ProxyStatus["node_health"];
  exitIp?: ExitIpDetail;
  exitIpError: string;
  mihomoDelays: Record<string, number | null>;
  telemetry: ReturnType<typeof useTelemetry>;
  quickNodes: NodeProfile[];
  nodesCount: number;
  starred: Set<string>;
  probe: (node: NodeProfile) => LatencyRecord | undefined;
  isSelected: (node: NodeProfile) => boolean;
  onCheckProxy: () => void;
  onChangeEntryMode: (mode: EntryMode) => void;
  onChangeRouting: (mode: RoutingMode) => void;
  onToggleProxy: () => void;
  onInstallService: () => void;
  onRepairSystemProxy: () => void;
  onApplyOriginalUpdate: () => void;
  onReconnectNodeSession: () => void;
  onSwitchBackToNodeMode: () => void;
  onSwitchToOriginal: (id: string) => void;
  onTestNode: (node: NodeProfile) => void;
  onShowExitIp: () => void;
  onMihomoDelays: React.Dispatch<React.SetStateAction<Record<string, number | null>>>;
  onOpenFullGroups: () => void;
  onSaveMihomoSelection: (profileId: string, group: string, choice: string) => Promise<void>;
  onResetDiagnostics: () => void;
  onOpenNodesPage: () => void;
  onSelectNode: (node: NodeProfile) => void;
  onConnectNode: (node: NodeProfile) => void;
  onOpenImport: () => void;
}) {
  const statusStateClass = recovering ? "is-recovering" : running ? "is-running" : "";

  return (
    <>
      <section className="connection">
        <div className="connection-info">
          <div className={`status ${statusStateClass}`}>
            <span className="status-dot" />
            {recovering ? "正在恢复连接" : running ? "已连接" : "未连接"}
          </div>
          <p>
            {connectionError || recoveryMessage || (running
              ? `${allowLan ? "0.0.0.0" : "127.0.0.1"}:${port}`
              : originalName
                ? `Mihomo 原配置：${originalName}`
                : current
                  ? current.name
                  : "未选择节点或配置")}
            {running && !recovering && (
              <>
                {" · "}
                <span>{checkResult || "尚未检测"}</span>
                <button className="link inline-action" disabled={checking || busy} onClick={onCheckProxy}>
                  {checking ? "检测中…" : "测试"}
                </button>
              </>
            )}
          </p>
        </div>

        <div className="connection-actions">
          <div className="connection-controls">
            <label style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12 }}>
              <span className="muted">接管</span>
              <select
                aria-label="接管方式"
                value={mode}
                disabled={busy || running || !workReady}
                onChange={e => onChangeEntryMode(e.target.value as EntryMode)}
              >
                {entryModes.map(({ value, label }) => <option key={value} value={value}>{label}</option>)}
              </select>
            </label>

            <div className="mode-switch" role="group" aria-label="路由模式">
              {routingModes.map(option => (
                <button
                  key={option.value}
                  type="button"
                  aria-pressed={routingMode === option.value}
                  disabled={busy || recovering || !workReady}
                  onClick={() => onChangeRouting(option.value)}
                >
                  {option.label}
                </button>
              ))}
            </div>

            <button
              className={`connect ${running ? "is-stop" : ""}`}
              disabled={busy || (!running && !current && !originalName) || !isTauri()}
              onClick={onToggleProxy}
            >
              {busy && <Loader2 size={14} className="spin" />}
              {busy ? "处理中…" : running ? "断开" : "连接"}
            </button>
          </div>
          {mode === "tun" && !running && (
            serviceStatus?.running && serviceStatus.upToDate ? (
              <small className="muted">后台服务已就绪：开启 TUN 免 UAC 弹窗</small>
            ) : !elevated && (
              <small className="muted">
                TUN 需权限
                <button
                  type="button"
                  className="link inline-action"
                  disabled={serviceBusy || busy}
                  onClick={onInstallService}
                >
                  {serviceBusy ? "安装中…" : serviceStatus?.installed ? "更新后台服务" : "安装免 UAC 服务"}
                </button>
                {" · "}
                <button
                  type="button"
                  className="link inline-action"
                  onClick={() => void invoke("relaunch_elevated").catch(() => {})}
                >
                  管理员重启
                </button>
              </small>
            )
          )}
        </div>
      </section>

      {connectionError && <div className="notice is-error" role="alert">{connectionError}</div>}
      {running && mode === "system" && proxyTampered && (
        <div className="notice is-warn" role="status">
          <span>Windows 系统代理已被其他软件或系统改写，当前浏览器与系统请求可能未走 RelayDesk。</span>
          <button
            type="button"
            className="mini-btn is-primary"
            disabled={busy || recovering || !port}
            onClick={onRepairSystemProxy}
          >
            立即写回系统代理
          </button>
        </div>
      )}
      {rulesDirtyWhileRunning && (
        <div className="notice is-warn" role="status">
          <span>{runningOriginal ? "分流规则或 Mihomo 覆写已修改，点击热重载即时生效（不断网）。" : "分流规则或远程规则集已修改，重新连接后生效。"}</span>
          <button
            type="button"
            className="mini-btn is-primary"
            disabled={busy || recovering}
            onClick={() => (runningOriginal ? onApplyOriginalUpdate() : onReconnectNodeSession())}
          >
            {runningOriginal ? "立即热重载生效" : "立即重连应用"}
          </button>
        </div>
      )}
      {originalUpdated && (
        <div className="notice is-warn" role="status">
          <span>当前使用的 Mihomo 订阅内容已更新。</span>
          <button className="mini-btn is-primary" disabled={busy || recovering} onClick={onApplyOriginalUpdate}>
            立即热重载应用
          </button>
        </div>
      )}

      <div className="stats">
        <div className="stat-card">
          <div className="stat-card-head">
            <span>{originalName ? "当前配置（Mihomo）" : "当前节点（sing-box）"}</span>
            {originalName ? (
              <button type="button" className="link" disabled={busy || recovering} onClick={onSwitchBackToNodeMode}>
                切回节点模式
              </button>
            ) : hasMihomoSub && firstMihomoSubId ? (
              <button
                type="button"
                className="link"
                disabled={busy || recovering}
                onClick={() => onSwitchToOriginal(firstMihomoSubId)}
              >
                切到原配置
              </button>
            ) : null}
          </div>
          <strong title={originalName || current?.name}>{originalName || current?.name || "尚未选择"}</strong>
          <small>
            {originalName ? "单核原生保留策略组、完整规则与 TUN" : current ? `${current.protocol.toUpperCase()} · ${current.server}:${current.port}` : "导入订阅后选择节点"}
            {activeSubTotal && activeSubUsed != null
              ? ` · 已用 ${formatBytes(activeSubUsed)}/${formatBytes(activeSubTotal)}`
              : ""}
            {activeSubExpiry ? ` · 到期 ${activeSubExpiry}` : ""}
          </small>
        </div>

        <div className="stat-card">
          <div className="stat-card-head">
            <span>入口与路由</span>
            <span className="tag">{allowLan ? "允许局域网" : "仅本机"}</span>
          </div>
          <strong>{entryModes.find(e => e.value === mode)?.label} · {routingModes.find(r => r.value === routingMode)?.label}</strong>
          <small>{mode === "tun" ? (tunIpv6 ? "虚拟网卡双栈接管所有应用" : "虚拟网卡仅 IPv4 接管") : mode === "system" ? "WinINet 系统代理（部分 CLI/IDE 需用 TUN）" : "仅本地端口监听"}</small>
        </div>

        <div className="stat-card">
          <div className="stat-card-head">
            <span>节点与延迟</span>
            {!originalName && current && isTauri() && (
              <button type="button" className="link" disabled={testing} onClick={() => onTestNode(current)}>
                {testing && <Loader2 size={12} className="spin" />}
                {testing ? "测速中…" : "测速"}
              </button>
            )}
          </div>
          <strong style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span>{(!originalName && current && probe(current)?.label) || (running ? "运行中" : "待连接")}</span>
            {nodeHealth && (
              <span className={`tag ${nodeHealth === "healthy" ? "is-good" : nodeHealth === "unreachable" ? "is-bad" : nodeHealth === "checking" ? "is-warn is-busy" : "is-warn"}`}>
                {nodeHealth === "healthy" ? "正常" : nodeHealth === "checking" ? "探测中" : nodeHealth === "unreachable" ? "失联" : "未检测"}
              </span>
            )}
          </strong>
          <small>{checkResult || "连接后自动验证外网连通性"}</small>
        </div>

        <div className="stat-card">
          <div className="stat-card-head">
            <span>出口 IP</span>
            <button type="button" className="link" disabled={!running || recovering || checking || busy} onClick={onShowExitIp}>
              {checking && <Loader2 size={12} className="spin" />}
              {checking ? "查询中…" : "查询"}
            </button>
          </div>
          <strong title={exitIp?.ip}>{exitIp?.ip || exitIpError || (running ? "点击查询" : "未连接")}</strong>
          <small>
            {exitIp
              ? [exitIp.country, exitIp.city, exitIp.isp].filter(Boolean).join(" · ") || "已获取"
              : "未查询"}
          </small>
        </div>
      </div>

      {runningOriginal && (
        <MihomoGroups
          mode={routingMode}
          disabled={busy || recovering}
          probeUrl={probeUrl}
          delays={mihomoDelays}
          compact
          onDelays={onMihomoDelays}
          onOpenFull={onOpenFullGroups}
          onMode={onChangeRouting}
          onChange={async (group, choice) => {
            onResetDiagnostics();
            await onSaveMihomoSelection(runningOriginal.id, group, choice);
          }}
        />
      )}

      <TrafficDashboard telemetry={telemetry} />

      {!originalName && (
        <section className="panel" style={{ marginTop: 14 }}>
          <div className="panel-head">
            <h2>快捷切换节点</h2>
            <button className="link" onClick={onOpenNodesPage}>全部节点 ({nodesCount})</button>
          </div>
          {quickNodes.length ? (
            quickNodes.map(n => {
              const p = probe(n);
              const active = isSelected(n);
              return (
                <div
                  className={`node-row is-clickable ${active ? "is-selected" : ""}`}
                  key={n.id}
                  onClick={() => onSelectNode(n)}
                >
                  <div className="node-name">
                    <span className="node-icon">
                      {starred.has(n.id) ? <Star size={15} fill="#fbbf24" color="#d97706" /> : <Globe2 size={15} />}
                    </span>
                    <div>
                      <strong>{n.name}</strong>
                      <small>{n.protocol.toUpperCase()} · {n.transport}</small>
                    </div>
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
                    <span className={`latency ${p?.milliseconds != null ? latencyClass(p.milliseconds) : ""}`}>
                      {p?.label ?? "未测速"}
                    </span>
                    {active ? (
                      <span className="tag is-accent">{running ? "使用中" : "已选中"}</span>
                    ) : (
                      <button
                        type="button"
                        className="mini-btn"
                        disabled={busy || recovering}
                        onClick={e => {
                          e.stopPropagation();
                          onConnectNode(n);
                        }}
                      >
                        {running ? "切换" : "连接"}
                      </button>
                    )}
                  </div>
                </div>
              );
            })
          ) : (
            <div className="empty">
              还没有可用节点。
              <button className="link inline-action" onClick={onOpenImport}>导入订阅 →</button>
            </div>
          )}
        </section>
      )}
    </>
  );
}
