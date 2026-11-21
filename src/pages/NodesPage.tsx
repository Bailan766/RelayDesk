import { isTauri } from "@tauri-apps/api/core";
import { Globe2, LayoutGrid, LayoutList, Loader2, Search, Star, Zap } from "lucide-react";
import { MihomoGroups } from "../MihomoGroups";
import type { NodeProfile } from "../subscription";
import type { LatencyRecord, RoutingMode, Subscription } from "../workspace";
import { latencyClass, nodeRegion, routingModes } from "../utils/nodes";

export function NodesPage({
  running,
  busy,
  recovering,
  workReady,
  runningOriginal,
  nodesTab,
  setNodesTab,
  routingMode,
  probeUrl,
  mihomoDelays,
  setMihomoDelays,
  onChangeRouting,
  onResetDiagnostics,
  onSaveMihomoSelection,
  search,
  setSearch,
  subscriptions,
  activeFilter,
  setSubscriptionFilter,
  protocols,
  protocolFilter,
  setProtocolFilter,
  nodeSort,
  setNodeSort,
  probeMode,
  setProbeMode,
  testing,
  onlyFavorites,
  setOnlyFavorites,
  onlySupported,
  setOnlySupported,
  groupBySub,
  setGroupBySub,
  nodeView,
  setNodeView,
  filtered,
  nodes,
  probeProgress,
  regionCounts,
  regionFilter,
  setRegionFilter,
  connectionError,
  unavailableNodes,
  nodeSubName,
  starred,
  probe,
  isSelected,
  onStopNodeTests,
  onTestNodes,
  onPickFastest,
  onConnectNode,
  onSelectNode,
  onShowDetail,
  onToggleFavorite,
}: {
  running: boolean;
  busy: boolean;
  recovering: boolean;
  workReady: boolean;
  runningOriginal?: { id: string; name: string; content: string };
  nodesTab: "groups" | "nodes";
  setNodesTab: (tab: "groups" | "nodes") => void;
  routingMode: RoutingMode;
  probeUrl: string;
  mihomoDelays: Record<string, number | null>;
  setMihomoDelays: React.Dispatch<React.SetStateAction<Record<string, number | null>>>;
  onChangeRouting: (mode: RoutingMode) => void;
  onResetDiagnostics: () => void;
  onSaveMihomoSelection: (profileId: string, group: string, choice: string) => Promise<void>;
  search: string;
  setSearch: (q: string) => void;
  subscriptions: Subscription[];
  activeFilter?: Subscription;
  setSubscriptionFilter: (id: string) => void;
  protocols: string[];
  protocolFilter: string;
  setProtocolFilter: (p: string) => void;
  nodeSort: string;
  setNodeSort: (sort: string) => void;
  probeMode: "url" | "tcp";
  setProbeMode: (mode: "url" | "tcp") => void;
  testing: boolean;
  onlyFavorites: boolean;
  setOnlyFavorites: React.Dispatch<React.SetStateAction<boolean>>;
  onlySupported: boolean;
  setOnlySupported: React.Dispatch<React.SetStateAction<boolean>>;
  groupBySub: boolean;
  setGroupBySub: React.Dispatch<React.SetStateAction<boolean>>;
  nodeView: "list" | "grid";
  setNodeView: (view: "list" | "grid") => void;
  filtered: NodeProfile[];
  nodes: NodeProfile[];
  probeProgress?: { done: number; total: number };
  regionCounts: [string, number][];
  regionFilter: string;
  setRegionFilter: React.Dispatch<React.SetStateAction<string>>;
  connectionError: string;
  unavailableNodes: Map<string, string | null>;
  nodeSubName: Map<string, string>;
  starred: Set<string>;
  probe: (node: NodeProfile) => LatencyRecord | undefined;
  isSelected: (node: NodeProfile) => boolean;
  onStopNodeTests: () => void;
  onTestNodes: (items: NodeProfile[]) => void;
  onPickFastest: () => void;
  onConnectNode: (node: NodeProfile) => void;
  onSelectNode: (node: NodeProfile) => void;
  onShowDetail: (node: NodeProfile) => void;
  onToggleFavorite: (id: string) => void;
}) {
  const renderNodeItem = (n: NodeProfile) => {
    const reason = unavailableNodes.get(n.id);
    const p = probe(n);
    const active = isSelected(n);
    const region = nodeRegion(n.name);
    const subLabel = !activeFilter && subscriptions.length > 1 && !groupBySub ? nodeSubName.get(n.id) : undefined;

    if (nodeView === "list") {
      return (
        <div
          className={`node-list-row ${active ? "selected" : ""} ${reason ? "is-unavailable" : ""}`}
          key={n.id}
          onDoubleClick={() => { if (!reason) onConnectNode(n); }}
        >
          <div className="node-list-main">
            <div className="node-list-title">
              <span className="tag">{region}</span>
              <span className="source-index">#{n.sourceIndex}</span>
              <strong>{n.name}</strong>
              {active && <span className="tag is-accent">{running ? "使用中" : "已选中"}</span>}
            </div>
            <div className="node-list-sub">
              <span>{n.server}:{n.port}</span>
              <span>· {n.protocol.toUpperCase()} / {n.transport}{n.security !== "none" ? ` / ${n.security}` : ""}</span>
              {subLabel && <span>· {subLabel}</span>}
              {reason && <span className="error">· {reason}</span>}
            </div>
          </div>
          <span className={`latency ${reason ? "is-bad" : p?.milliseconds != null ? latencyClass(p.milliseconds) : ""}`}>
            {reason ? "不可用" : p?.label || "未测速"}
          </span>
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            {!reason && (
              <>
                <button
                  type="button"
                  className={`mini-btn ${active ? "is-primary" : ""}`}
                  disabled={busy || recovering || (running && !runningOriginal && active)}
                  onClick={() => onSelectNode(n)}
                >
                  {active ? (running ? "使用中" : "已选中") : running ? "切换" : "选中"}
                </button>
                {(!running || runningOriginal) && (
                  <button
                    type="button"
                    className="mini-btn is-primary"
                    disabled={busy || recovering || !isTauri()}
                    onClick={() => onConnectNode(n)}
                  >
                    连接
                  </button>
                )}
              </>
            )}
            <button type="button" className="link" onClick={() => onShowDetail(n)}>详情</button>
            <button
              type="button"
              className="link node-favorite"
              aria-pressed={starred.has(n.id)}
              aria-label={starred.has(n.id) ? `取消收藏 ${n.name}` : `收藏 ${n.name}`}
              onClick={() => onToggleFavorite(n.id)}
            >
              <Star size={16} aria-hidden />
            </button>
          </div>
        </div>
      );
    }

    return (
      <div
        className={`node-card ${active ? "selected" : ""} ${reason ? "is-unavailable" : ""}`}
        key={n.id}
        onDoubleClick={() => { if (!reason) onConnectNode(n); }}
      >
        <div className="node-name">
          <span className="node-icon"><Globe2 size={17} /></span>
          <div>
            <strong title={n.name} style={{ whiteSpace: "normal", display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical" }}>
              <span className="source-index">#{n.sourceIndex}</span> {n.name}
            </strong>
            <small>{n.server}:{n.port}</small>
          </div>
        </div>
        <div className="node-meta-row">
          <span className="tag">{region} · {n.protocol.toUpperCase()} · {n.transport}</span>
          <span className={`latency ${reason ? "is-bad" : p?.milliseconds != null ? latencyClass(p.milliseconds) : ""}`}>
            {reason ? "不可用" : p?.label || "未测速"}
          </span>
        </div>
        {reason && <div className="error" style={{ lineHeight: 1.4 }}>{reason}</div>}
        <div className="node-actions">
          <div className="node-actions-left">
            {!reason && (
              <>
                <button
                  type="button"
                  className={`mini-btn ${active ? "is-primary" : ""}`}
                  disabled={busy || recovering || (running && !runningOriginal && active)}
                  onClick={() => onSelectNode(n)}
                >
                  {active ? (running ? "使用中" : "已选中") : running ? "切换" : "选中"}
                </button>
                {(!running || runningOriginal) && (
                  <button
                    type="button"
                    className="mini-btn is-primary"
                    disabled={busy || recovering || !isTauri()}
                    onClick={() => onConnectNode(n)}
                  >
                    连接
                  </button>
                )}
              </>
            )}
            <button type="button" className="link" onClick={() => onShowDetail(n)}>详情</button>
          </div>
          <button
            type="button"
            className="link node-favorite"
            aria-pressed={starred.has(n.id)}
            aria-label={starred.has(n.id) ? `取消收藏 ${n.name}` : `收藏 ${n.name}`}
            onClick={() => onToggleFavorite(n.id)}
          >
            <Star size={16} aria-hidden />
          </button>
        </div>
      </div>
    );
  };

  return (
    <section>
      {runningOriginal && (
        <div className="panel" style={{ marginBottom: 14, padding: "12px 16px" }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 10 }}>
            <span className="muted">
              当前正在运行 Mihomo 原配置「<strong>{runningOriginal.name}</strong>」
            </span>
            <div className="mode-switch" role="tablist" aria-label="节点页视图">
              <button type="button" aria-pressed={nodesTab === "groups"} onClick={() => setNodesTab("groups")}>
                Mihomo 策略组
              </button>
              <button type="button" aria-pressed={nodesTab === "nodes"} onClick={() => setNodesTab("nodes")}>
                提取节点（sing-box）
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="tab-view" key={runningOriginal ? nodesTab : "nodes"}>
        {runningOriginal && nodesTab === "groups" ? (
          <MihomoGroups
            mode={routingMode}
            disabled={busy || recovering}
            probeUrl={probeUrl}
            delays={mihomoDelays}
            onDelays={setMihomoDelays}
            onMode={onChangeRouting}
            onChange={async (group, choice) => {
              onResetDiagnostics();
              await onSaveMihomoSelection(runningOriginal.id, group, choice);
            }}
          />
        ) : (
          <>
            <div className="toolbar">
              <label className="search">
                <Search size={15} />
                <input placeholder="搜索节点名、序号、协议或域名" value={search} onChange={e => setSearch(e.target.value)} />
              </label>
              {subscriptions.length > 1 && (
                <select className="toolbar-select" aria-label="筛选订阅来源" value={activeFilter?.id ?? ""} onChange={e => setSubscriptionFilter(e.target.value)}>
                  <option value="">全部订阅</option>
                  {subscriptions.map(profile => <option key={profile.id} value={profile.id}>{profile.name}</option>)}
                </select>
              )}
              {protocols.length > 1 && (
                <select className="toolbar-select" aria-label="筛选协议" value={protocolFilter} onChange={e => setProtocolFilter(e.target.value)}>
                  <option value="">全部协议</option>
                  {protocols.map(p => <option key={p} value={p}>{p.toUpperCase()}</option>)}
                </select>
              )}
              <select className="toolbar-select" aria-label="排序节点" value={nodeSort} onChange={e => setNodeSort(e.target.value)}>
                <option value="source">订阅顺序</option>
                <option value="latency">延迟优先</option>
                <option value="name">名称排序</option>
              </select>
              <select className="toolbar-select" aria-label="测速模式" value={probeMode} disabled={testing} onChange={e => setProbeMode(e.target.value as "url" | "tcp")}>
                <option value="url">真连接延迟 (URL)</option>
                <option value="tcp">TCP 握手延迟</option>
              </select>
              <button type="button" className="toolbar-pill" aria-pressed={onlyFavorites} onClick={() => setOnlyFavorites(v => !v)}>
                收藏
              </button>
              <button type="button" className="toolbar-pill" aria-pressed={onlySupported} onClick={() => setOnlySupported(v => !v)}>
                仅可用
              </button>
              {subscriptions.length > 1 && !activeFilter && (
                <button type="button" className="toolbar-pill" aria-pressed={groupBySub} onClick={() => setGroupBySub(v => !v)}>
                  按订阅分组
                </button>
              )}
              <div className="mode-switch" role="group" aria-label="视图模式">
                <button type="button" aria-pressed={nodeView === "list"} onClick={() => setNodeView("list")} title="列表视图">
                  <LayoutList size={14} />
                </button>
                <button type="button" aria-pressed={nodeView === "grid"} onClick={() => setNodeView("grid")} title="卡片视图">
                  <LayoutGrid size={14} />
                </button>
              </div>
              <button
                type="button"
                className="mini-btn is-primary"
                disabled={(!testing && !filtered.length) || !isTauri()}
                onClick={() => (testing ? onStopNodeTests() : onTestNodes(filtered))}
              >
                {testing && <Loader2 size={13} className="spin" />}
                {testing ? `停止 (${probeProgress?.done ?? 0}/${probeProgress?.total ?? filtered.length})` : "一键测速"}
              </button>
              <button
                type="button"
                className="mini-btn"
                disabled={busy || recovering || !filtered.length || !isTauri()}
                onClick={onPickFastest}
                title="自动选择当前列表延迟最低的节点"
              >
                <Zap size={13} /> 选最快
              </button>
              <div className="mode-switch" role="group" aria-label="路由模式" style={{ marginLeft: "auto" }}>
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
            </div>

            {testing && probeProgress && probeProgress.total > 0 && (
              <div
                className="probe-progress"
                role="progressbar"
                aria-label="节点测速进度"
                aria-valuenow={probeProgress.done}
                aria-valuemin={0}
                aria-valuemax={probeProgress.total}
              >
                <div className="probe-progress-track">
                  <div
                    className="probe-progress-fill"
                    style={{ width: `${Math.round((probeProgress.done / probeProgress.total) * 100)}%` }}
                  />
                </div>
              </div>
            )}

            {regionCounts.length > 1 && (
              <div className="region-bar" role="group" aria-label="按地区筛选">
                <button
                  type="button"
                  className="toolbar-pill"
                  aria-pressed={regionFilter === ""}
                  onClick={() => setRegionFilter("")}
                >
                  全部 ({(activeFilter?.parsed.nodes ?? nodes).length})
                </button>
                {regionCounts.map(([reg, count]) => (
                  <button
                    key={reg}
                    type="button"
                    className="toolbar-pill"
                    aria-pressed={regionFilter === reg}
                    onClick={() => setRegionFilter(prev => (prev === reg ? "" : reg))}
                  >
                    {reg} ({count})
                  </button>
                ))}
              </div>
            )}

            {connectionError && <div className="notice is-error" role="alert" style={{ marginBottom: 12 }}>{connectionError}</div>}
            {activeFilter?.parsed.warnings.length ? (
              <div className="notice is-warn" style={{ marginBottom: 12 }}>
                <span>该订阅有 {activeFilter.parsed.warnings.length} 项因格式或协议不支持未导入。</span>
              </div>
            ) : null}

            {!filtered.length ? (
              <div className="empty">
                {nodes.length ? "没有符合筛选条件的节点" : "还没有节点，点击右上角「导入订阅」。"}
              </div>
            ) : groupBySub && subscriptions.length > 1 && !activeFilter ? (
              subscriptions.map(sub => {
                const filteredIds = new Set(filtered.map(n => n.id));
                const groupNodes = sub.parsed.nodes.filter(n => filteredIds.has(n.id));
                if (!groupNodes.length) return null;
                const sortedGroup = nodeSort === "latency"
                  ? [...groupNodes].sort((a, b) => (probe(a)?.milliseconds ?? Number.MAX_SAFE_INTEGER) - (probe(b)?.milliseconds ?? Number.MAX_SAFE_INTEGER))
                  : nodeSort === "name"
                    ? [...groupNodes].sort((a, b) => a.name.localeCompare(b.name, "zh-CN"))
                    : groupNodes;
                return (
                  <div className="node-group-box" key={sub.id}>
                    <div className="node-group-head">
                      <strong>{sub.name} ({sortedGroup.length})</strong>
                      <button type="button" className="mini-btn" disabled={testing || !isTauri()} onClick={() => onTestNodes(sortedGroup)}>
                        测本组
                      </button>
                    </div>
                    <div className={nodeView === "list" ? "node-list" : "node-grid"}>
                      {sortedGroup.map(renderNodeItem)}
                    </div>
                  </div>
                );
              })
            ) : (
              <div className={nodeView === "list" ? "node-list" : "node-grid"}>
                {filtered.map(renderNodeItem)}
              </div>
            )}
            <p className="rule-hint" style={{ marginTop: 12 }}>
              双击节点可连接或切换。
            </p>
          </>
        )}
      </div>
    </section>
  );
}
