import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { invoke, isTauri } from "@tauri-apps/api/core";
import {
  Activity,
  Boxes,
  Cat,
  Link2,
  List,
  FlaskConical,
  FileText,
  Globe2,
  LayoutDashboard,
  Plus,
  Search,
  Settings2,
  Shield,
  Star,
  Upload,
  X,
} from "lucide-react";
import { nodeRevision, type NodeProfile } from "./subscription";
import { buildConfig, buildSessionConfig, connectionSupport, normalizeRuleValue, ruleTypes, withSelectedOutbound, type RouteRule, type SessionPlan } from "./config";
import { ConnectionMonitor, TrafficDashboard, TrafficSidebar, useTelemetry } from "./telemetry";
import { SubscriptionCard } from "./SubscriptionCard";
import { WebsiteChecks } from "./WebsiteChecks";
import { EventLog } from "./EventLog";
import { useWorkspace } from "./useWorkspace";
import { preferredNode, type EntryMode, type RoutingMode, type Workspace } from "./workspace";
import "./style.css";
import "./accessibility.css";
import "./rules.css";
import "./dashboard.css";

type Page = "概览" | "节点" | "订阅" | "连接" | "规则" | "日志" | "测试" | "诊断" | "设置";
type Probe = { revision: string; label: string; milliseconds?: number };
type ProxyStatus = { phase: "running" | "recovering" | "stopped" | "busy"; message: string | null };
const entryModes: { value: EntryMode; label: string }[] = [
  { value: "system", label: "系统代理" },
  { value: "tun", label: "TUN" },
  { value: "local", label: "本地端口" },
];
const routingModes: { value: RoutingMode; label: string }[] = [
  { value: "rule", label: "规则" },
  { value: "global", label: "全局" },
  { value: "direct", label: "直连" },
];
const nav: { name: Page; icon: typeof Activity }[] = [
  { name: "概览", icon: LayoutDashboard },
  { name: "节点", icon: Globe2 },
  { name: "订阅", icon: Boxes },
  { name: "连接", icon: Link2 },
  { name: "规则", icon: Shield },
  { name: "日志", icon: List },
  { name: "测试", icon: FlaskConical },
  { name: "诊断", icon: Activity },
  { name: "设置", icon: Settings2 },
];
function App() {
  const [page, setPage] = useState<Page>("概览");
  const work = useWorkspace();
  const { subscriptions, rules, selected, favorites, autoReconnect, proxyPort, entryMode: mode } = work.workspace;
  const nodes = useMemo(() => subscriptions.flatMap(profile => profile.parsed.nodes), [subscriptions]);
  const unavailableNodes = useMemo(() => new Map(nodes.map(node => [node.id, connectionSupport(node)])), [nodes]);
  const ruleTargets = useMemo(() => subscriptions.flatMap(profile => profile.parsed.nodes
    .filter(node => !unavailableNodes.get(node.id))
    .map(node => ({ id: node.id, label: `${profile.name} · #${node.sourceIndex} ${node.name}` }))), [subscriptions, unavailableNodes]);
  const [subscriptionFilter, setSubscriptionFilter] = useState("");
  const [nodeSort, setNodeSort] = useState("source");
  const [onlyFavorites, setOnlyFavorites] = useState(false);
  const [dialog, setDialog] = useState(false);
  const [text, setText] = useState("");
  const [error, setError] = useState("");
  const [importing, setImporting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [settingsError, setSettingsError] = useState("");
  const [search, setSearch] = useState("");
  const file = useRef<HTMLInputElement>(null);
  const [running, setRunning] = useState(false);
  const [recovering, setRecovering] = useState(false);
  const [recoveryMessage, setRecoveryMessage] = useState("");
  const [runningNode, setRunningNode] = useState<NodeProfile>();
  const [liveRouting, setLiveRouting] = useState<RoutingMode>();
  const routingMode = running ? liveRouting ?? work.workspace.routingMode : work.workspace.routingMode;
  const session = useRef<SessionPlan>();
  const telemetry = useTelemetry(running && !recovering);
  const [port, setPort] = useState<number>();
  const [connectionError, setConnectionError] = useState("");
  const [checkResult, setCheckResult] = useState("");
  const [checking, setChecking] = useState(false);
  const [latencies, setLatencies] = useState<Record<string, Probe>>({});
  const [testing, setTesting] = useState(false);
  const [exitIp, setExitIp] = useState("");
  const [localTcp, setLocalTcp] = useState("尚未测试");
  const [localTcpBusy, setLocalTcpBusy] = useState(false);
  const cancelTesting = useRef(false);
  const probeBatch = useRef<string>();
  async function saveSettings(edit: (previous: Workspace) => Workspace) {
    setSettingsError("");
    try {
      await work.commit(edit);
    } catch (error) {
      setSettingsError(typeof error === "string" ? error : error instanceof Error ? error.message : "设置保存失败");
    }
  }
  function clearSession() {
    session.current = undefined;
    setRunning(false);
    setRecovering(false);
    setRecoveryMessage("");
    setRunningNode(undefined);
    setLiveRouting(undefined);
    setPort(undefined);
    setExitIp("");
    setCheckResult("");
  }
  useEffect(() => {
    if (!isTauri() || busy || !running) return;
    let cancelled = false;
    let timer: number;
    async function poll() {
      try {
        const status = await invoke<ProxyStatus>("proxy_status");
        if (cancelled || status.phase === "busy") return;
        if (status.phase === "stopped") clearSession();
        setRecovering(status.phase === "recovering");
        setRecoveryMessage(status.message ?? "");
        if (status.phase === "recovering") {
          setCheckResult("");
          setExitIp("");
        }
      } catch {
        // A transient IPC failure leaves the last confirmed status visible.
      } finally {
        if (!cancelled) timer = window.setTimeout(poll, 1000);
      }
    }
    timer = window.setTimeout(poll, 600);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [busy, running]);
  useEffect(() => {
    if (!isTauri() || !work.ready) return;
    void invoke("configure_recovery", { enabled: autoReconnect }).catch(() =>
      setSettingsError("无法更新当前会话的自动恢复设置"));
  }, [autoReconnect, work.ready]);
  const activeFilter = subscriptions.find(profile => profile.id === subscriptionFilter);
  const starred = useMemo(() => new Set(favorites), [favorites]);
  function probe(node: NodeProfile) {
    const value = latencies[node.id];
    return value?.revision === nodeRevision(node) ? value : undefined;
  }
  const filtered = (activeFilter?.parsed.nodes ?? nodes).filter((n) =>
    (!onlyFavorites || starred.has(n.id)) && `#${n.sourceIndex ?? ""} ${n.name} ${n.protocol} ${n.server}`
      .toLowerCase()
      .includes(search.trim().toLowerCase()),
  );
  if (nodeSort === "latency") {
    filtered.sort((a, b) => (probe(a)?.milliseconds ?? Number.MAX_SAFE_INTEGER)
      - (probe(b)?.milliseconds ?? Number.MAX_SAFE_INTEGER));
  }
  async function add() {
    setImporting(true);
    setError("");
    try {
      await work.add(text);
      setSubscriptionFilter("");
      setText("");
      setDialog(false);
      setPage("节点");
    } catch (e) {
      setError(
        typeof e === "string" ? e : e instanceof Error ? e.message : "导入失败",
      );
    } finally {
      setImporting(false);
    }
  }
  const preferred = nodes.find(n => n.id === selected);
  const current = running ? runningNode ?? preferred : preferred;
  const isSelected = (node: NodeProfile) => running
    ? runningNode?.id === node.id && nodeRevision(runningNode) === nodeRevision(node)
    : node.id === selected;
  async function checkProxy() {
    if (!port) return;
    setChecking(true);
    setCheckResult("");
    try {
      const ms = await invoke<number>("check_connection", { port });
      setCheckResult(`当前路由可达 · ${ms} ms`);
    } catch (e) {
      setCheckResult(typeof e === "string" ? e : "网络验证失败");
    } finally {
      setChecking(false);
    }
  }
  async function prepareSession(node: NodeProfile, localPort: number): Promise<SessionPlan> {
    const candidate = buildSessionConfig(node, nodes, localPort, rules);
    if (await invoke<boolean>("validate_proxy_config", { config: candidate.config })) return candidate;
    const single = buildConfig(node, localPort, rules);
    if (!await invoke<boolean>("validate_proxy_config", { config: single })) {
      throw new Error("所选节点或规则未通过内核配置检查");
    }
    return { config: single, loaded: new Map() };
  }
  async function changeRouting(value: RoutingMode) {
    if (busy || recovering || value === routingMode) return;
    setBusy(true);
    setConnectionError("");
    try {
      if (running) {
        await invoke("set_routing_mode", { mode: value });
        setLiveRouting(value);
        setCheckResult("");
        setExitIp("");
      }
      await saveSettings(state => ({ ...state, routingMode: value }));
    } catch (error) {
      setConnectionError(typeof error === "string" ? error : "路由模式切换失败");
    } finally {
      setBusy(false);
    }
  }
  async function selectNode(node: NodeProfile) {
    if (busy || recovering || testing || isSelected(node)) return;
    const remember = () => saveSettings(state => ({ ...state,
      selected: preferredNode(state.subscriptions, node.id),
    }));
    const previous = session.current;
    if (!running || !port || !previous) {
      await remember();
      return;
    }
    setBusy(true);
    setConnectionError("");
    setCheckResult("");
    setExitIp("");
    try {
      const loaded = previous.loaded.get(node.id);
      if (loaded && loaded.revision === nodeRevision(node)) {
        await invoke("switch_proxy_node", { tag: loaded.tag });
        session.current = withSelectedOutbound(previous, loaded.tag);
        setRunningNode(node);
        await remember();
        return;
      }
      const next = await prepareSession(node, port);
      await invoke("stop_proxy");
      try {
        await invoke("start_proxy", { config: next.config, mode, routingMode, autoReconnect });
        session.current = next;
        setRunningNode(node);
        setRunning(true);
        await remember();
      } catch (failure) {
        try {
          await invoke("start_proxy", { config: previous.config, mode, routingMode, autoReconnect });
          setRunning(true);
        } catch {
          clearSession();
        }
        throw failure;
      }
    } catch (e) {
      setConnectionError(
        `切换失败：${typeof e === "string" ? e : e instanceof Error ? e.message : "未知错误"}`,
      );
    } finally {
      setBusy(false);
    }
  }
  async function testNodes(items: NodeProfile[]) {
    if (!isTauri() || testing || busy) return;
    cancelTesting.current = false;
    setTesting(true);
    try {
      const batch = await invoke<string>("begin_probe_batch");
      probeBatch.current = batch;
      const queue = items.filter(node => !unavailableNodes.get(node.id));
      let next = 0;
      async function testQueue() {
        while (next < queue.length && !cancelTesting.current) {
          const node = queue[next++];
          setLatencies((previous) => ({ ...previous, [node.id]: { revision: nodeRevision(node), label: "测试中" } }));
          let label: string;
          let milliseconds: number | undefined;
          try {
            const localPort = await invoke<number>("allocate_port");
            if (cancelTesting.current) {
              label = "已取消";
            } else {
              const ms = await invoke<number>("probe_node", { config: buildConfig(node, localPort), port: localPort, batch });
              milliseconds = ms;
              label = `${ms} ms`;
            }
          } catch (e) {
            label = typeof e === "string" ? e : "代理请求失败";
          }
          setLatencies((previous) => ({
            ...previous,
            [node.id]: { revision: nodeRevision(node), label: `${label} · ${new Date().toLocaleTimeString()}`, milliseconds },
          }));
        }
      }
      await Promise.all(Array.from({ length: Math.min(4, queue.length) }, testQueue));
    } catch (error) {
      setConnectionError(typeof error === "string" ? error : "启动测速失败");
    } finally {
      const batch = probeBatch.current;
      probeBatch.current = undefined;
      if (batch) await invoke("cancel_probe_batch", { batch }).catch(() => {});
      setTesting(false);
    }
  }
  function stopNodeTests() {
    cancelTesting.current = true;
    const batch = probeBatch.current;
    if (batch) void invoke("cancel_probe_batch", { batch }).catch(() => setConnectionError("无法取消正在运行的测速"));
  }
  async function showExitIp() {
    if (!port) return;
    setChecking(true);
    setExitIp("查询中");
    try {
      setExitIp(await invoke<string>("check_exit_ip", { port }));
    } catch (e) {
      setExitIp(typeof e === "string" ? e : "查询失败");
    } finally {
      setChecking(false);
    }
  }
  async function testLocalTcp() {
    setLocalTcpBusy(true);
    try {
      const ms = await invoke<number>("local_tcp_google");
      setLocalTcp(`${ms} ms · ${new Date().toLocaleTimeString()}`);
    } catch (e) {
      setLocalTcp(typeof e === "string" ? e : "测试失败");
    } finally {
      setLocalTcpBusy(false);
    }
  }
  async function toggleProxy() {
    setBusy(true);
    setConnectionError("");
    setCheckResult("");
    setRecoveryMessage("");
    try {
      if (!isTauri()) throw new Error("请在桌面应用中连接");
      if (running) {
        await invoke("stop_proxy");
        clearSession();
      } else {
        if (!preferred) throw new Error("请先导入并选择节点");
        const localPort = proxyPort ?? await invoke<number>("allocate_port");
        const next = await prepareSession(preferred, localPort);
        await invoke("start_proxy", { config: next.config, mode, routingMode, autoReconnect });
        session.current = next;
        setRunningNode(preferred);
        setLiveRouting(routingMode);
        setPort(localPort);
        setRunning(true);
      }
    } catch (e) {
      setConnectionError(
        typeof e === "string" ? e : e instanceof Error ? e.message : "连接失败",
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="app">
      <aside>
        <div className="brand">
          <Cat size={30} />
          <div>
            <strong>RelayDesk</strong>
            <small>代理工作台</small>
          </div>
        </div>
        <div className="side-label">工作区</div>
        <nav>
          {nav.map(({ name, icon: Icon }) => (
            <button
              className={page === name ? "active" : ""}
              onClick={() => setPage(name)}
              key={name}
            >
              <Icon size={17} />
              {name}
            </button>
          ))}
        </nav>
        <TrafficSidebar telemetry={telemetry} />
      </aside>
      <div className="workspace">
        <header>
          <span>个人工作区</span>
          <span className="header-right">
            <span className="dot" />
            {recovering ? "正在恢复代理" : running ? "内核运行中" : "内核未运行"}
          </span>
        </header>
        <main>
          <div className="title">
            <div>
              <h1>{page}</h1>
              <p>
                {page === "概览"
                  ? "管理连接、节点和本地代理状态"
                  : page === "节点"
                    ? "查看和选择导入的代理节点"
                    : page === "订阅"
                      ? "导入和管理节点来源"
                      : page === "规则"
                        ? "管理流量的路由方式"
                        : page === "诊断"
                          ? "检查代理服务与连接状态"
                          : "管理应用与运行环境"}
              </p>
            </div>
            {["概览", "节点", "订阅"].includes(page) && (
              <button className="primary" disabled={!work.ready} onClick={() => setDialog(true)}>
                <Plus size={16} />
                导入订阅
              </button>
            )}
          </div>
          {(work.storageError || settingsError) && <p className="notice" role="alert">{work.storageError || settingsError}</p>}
          {page === "概览" && (
            <>
              <section className="connection">
                <div>
                  <div className="section-label">连接状态</div>
                  <div className="status">
                    <span className="status-dot" />
                    {recovering ? "正在恢复代理" : running ? "内核运行中" : "未连接"}
                  </div>
                  <p>
                    {connectionError || recoveryMessage ||
                      (running
                        ? `本地 HTTP / SOCKS5：127.0.0.1:${port}`
                        : "代理未运行")}
                    {running && !recovering && (
                      <>
                        <br />
                        {checkResult || "尚未验证远程连接"}{" "}
                        <button
                          className="link"
                          disabled={checking}
                          onClick={checkProxy}
                        >
                          {checking ? "检查中…" : "检查连接"}
                        </button>
                      </>
                    )}
                  </p>
                </div>
                <div className="connection-actions">
                  <label>
                    <span>接管方式</span>
                    <select value={mode} disabled={busy || running || !work.ready} onChange={(e) => {
                      const entryMode = e.target.value as EntryMode;
                      void saveSettings(state => ({ ...state, entryMode }));
                    }}>
                      {entryModes.map(({ value, label }) => <option key={value} value={value}>{label}</option>)}
                    </select>
                  </label>
                  {mode === "tun" && !running && <small>启动时需要管理员授权</small>}
                  <button
                    className="connect"
                    disabled={busy || (!running && (!current || testing)) || !isTauri()}
                    onClick={toggleProxy}
                  >
                    {busy ? "处理中…" : running ? "停止" : "连接"}
                  </button>
                </div>
              </section>
              <TrafficDashboard telemetry={telemetry} />
              <div className="stats">
                <div>
                  <span>当前节点</span>
                  <strong>{current?.name || "尚未选择"}</strong>
                  <small>
                    {current
                      ? current.protocol.toUpperCase()
                      : "导入订阅后选择节点"}
                  </small>
                </div>
                <div>
                  <span>代理模式</span>
                  <strong>{entryModes.find((entry) => entry.value === mode)?.label}</strong>
                  <small>{routingModes.find(entry => entry.value === routingMode)?.label}路由</small>
                </div>
              </div>
              <div className="columns">
                <WebsiteChecks key={JSON.stringify([telemetry.snapshot?.sessionId, current?.id, routingMode])} port={running && !recovering ? port : undefined} />
                <section className="panel">
                  <div className="panel-head"><h2>当前路由出口 IP</h2><button className="link" disabled={!running || recovering || checking} onClick={showExitIp}>刷新</button></div>
                  <div className="empty">{exitIp || (running ? "尚未检查出口 IP" : "连接后可检查出口 IP")}</div>
                </section>
                <section className="panel">
                  <div className="panel-head">
                    <h2>节点</h2>
                    <button className="link" onClick={() => setPage("节点")}>
                      查看全部
                    </button>
                  </div>
                  {nodes.length ? (
                    nodes.slice(0, 4).map((n) => (
                      <div className="node-row" key={n.id}>
                        <div className="node-name">
                          <span className="node-icon">
                            <Globe2 size={17} />
                          </span>
                          <div>
                            <strong>{n.name}</strong>
                            <small>
                              {n.protocol.toUpperCase()} · {n.transport}
                            </small>
                          </div>
                        </div>
                        <span className="muted">未测速</span>
                      </div>
                    ))
                  ) : (
                    <div className="empty">
                      还没有节点。导入订阅后，节点会显示在这里。
                      <button className="link" onClick={() => setDialog(true)}>
                        导入订阅 →
                      </button>
                    </div>
                  )}
                </section>
                <section className="panel">
                  <div className="panel-head">
                    <h2>运行环境</h2>
                  </div>
                  <div className="env-row">
                    <span>sing-box</span>
                    <span className="muted">
                      {running ? "运行中" : "未运行"}
                    </span>
                  </div>
                  <div className="env-row">
                    <span>Mihomo</span>
                    <span className="muted">未接入</span>
                  </div>
                  <div className="env-row">
                    <span>接管方式</span>
                    <span className="muted">{running ? entryModes.find((entry) => entry.value === mode)?.label : "未启用"}</span>
                  </div>
                  <div className="notice">
                    点击窗口关闭后继续在托盘运行。停止代理或从托盘彻底退出会结束网络接管。
                  </div>
                </section>
              </div>
            </>
          )}
          {page === "节点" && (
            <section>
              <div className="toolbar">
                <label className="search">
                  <Search size={16} />
                  <input
                    placeholder="搜索节点、序号、协议或地址"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                  />
                </label>
                {subscriptions.length > 1 && <select className="toolbar-select" aria-label="筛选订阅来源" value={activeFilter?.id ?? ""} onChange={event => setSubscriptionFilter(event.target.value)}>
                  <option value="">全部订阅</option>
                  {subscriptions.map(profile => <option key={profile.id} value={profile.id}>{profile.name}</option>)}
                </select>}
                <select className="toolbar-select" aria-label="排序节点" value={nodeSort} onChange={event => setNodeSort(event.target.value)}>
                  <option value="source">订阅顺序</option>
                  <option value="latency">延迟优先</option>
                </select>
                <button className="link" aria-pressed={onlyFavorites} onClick={() => setOnlyFavorites(value => !value)}>
                  {onlyFavorites ? "显示全部" : "仅看收藏"}
                </button>
                <button
                  className="link"
                  disabled={busy || (!testing && !filtered.length) || !isTauri()}
                  onClick={() =>
                    testing
                      ? stopNodeTests()
                      : testNodes(filtered)
                  }
                >
                  {testing ? "取消测速" : "一键测试延迟"}
                </button>
                <span>{filtered.length} 个节点</span>
                <div className="mode-switch" role="group" aria-label="路由模式">
                  {routingModes.map(option => <button className="link" key={option.value}
                    aria-pressed={routingMode === option.value} disabled={busy || recovering || !work.ready}
                    onClick={() => void changeRouting(option.value)}>{option.label}</button>)}
                </div>
              </div>
              <div className="group-heading"><strong>已导入节点</strong><span>手动选择 · {filtered.length} 个节点</span></div>
              {connectionError && (
                <div className="notice" role="alert">
                  {connectionError}
                </div>
              )}
              {running && (
                <div className="notice">
                  当前路由出口 IP：{exitIp || "尚未检查"}{" "}
                  <button
                    className="link"
                    disabled={checking}
                    onClick={showExitIp}
                  >
                    检查出口 IP
                  </button>
                </div>
              )}
              {activeFilter?.parsed.warnings.length ? (
                <div className="notice">
                  {activeFilter.parsed.warnings.length} 项未导入，请检查订阅格式。
                </div>
              ) : null}
              <div className="node-grid">
                {filtered.map((n) => (
                  <div className={`node-card ${isSelected(n) ? "selected" : ""}`} key={n.id}>
                    <div className="node-name">
                      <span className="node-icon">
                        <Globe2 size={17} />
                      </span>
                      <div>
                          <strong title={n.name}><span className="source-index">#{n.sourceIndex}</span> {n.name}</strong>
                        <small>
                          {n.server}:{n.port}
                        </small>
                      </div>
                    </div>
                    <span>
                      {n.protocol.toUpperCase()} · {n.transport}
                    </span>
                    <span className="probe-result" title={unavailableNodes.get(n.id) || probe(n)?.label}>
                      {unavailableNodes.get(n.id)
                        ? "暂不支持"
                        : probe(n)?.label || "未测试"}
                    </span>
                    <div className="node-actions">
                      <button
                      className="link"
                      disabled={
                        busy ||
                        recovering ||
                        testing ||
                        !!unavailableNodes.get(n.id) ||
                        isSelected(n)
                      }
                      title={unavailableNodes.get(n.id) || undefined}
                      onClick={() => selectNode(n)}
                    >
                      {isSelected(n)
                        ? "已选择"
                        : unavailableNodes.get(n.id)
                          ? "不可用"
                          : runningNode?.id === n.id ? "应用更新" : "切换"}
                      </button>
                      <button className="link node-favorite" aria-pressed={starred.has(n.id)}
                        aria-label={starred.has(n.id) ? `取消收藏 ${n.name}` : `收藏 ${n.name}`}
                        onClick={() => void saveSettings(state => ({
                          ...state,
                          favorites: state.favorites.includes(n.id) ? state.favorites.filter(id => id !== n.id) : [...state.favorites, n.id],
                        }))}>
                        <Star size={16} aria-hidden />
                      </button>
                    </div>
                  </div>
                ))}
                {!filtered.length && (
                  <div className="empty">
                    {nodes.length
                      ? "没有匹配的节点"
                      : "还没有节点，先导入订阅。"}
                  </div>
                )}
              </div>
              <p className="rule-hint">
                编号对应订阅源顺序。延迟为代理请求总耗时，最多同时测试四个节点。
              </p>
            </section>
          )}
          {page === "订阅" && (
            <section className="panel">
              <div className="panel-head">
                <h2>订阅来源</h2>
                <label className="refresh-setting">自动更新
                  <select value={work.workspace.refreshHours} disabled={!work.ready || !isTauri()} onChange={event => {
                    const refreshHours = Number(event.target.value);
                    void saveSettings(state => ({ ...state, refreshHours }));
                  }}>
                    <option value="0">关闭</option>
                    <option value="1">每小时</option>
                    <option value="6">每 6 小时</option>
                    <option value="24">每天</option>
                  </select>
                </label>
              </div>
              {subscriptions.length ? <div className="subscription-grid">
                {subscriptions.map(profile => <SubscriptionCard key={profile.id} profile={profile}
                  pending={work.refreshStatus[profile.id]?.pending ?? false}
                  error={work.refreshStatus[profile.id]?.error}
                  refreshable={isTauri()}
                  onRefresh={() => void work.refresh(profile.id).catch(() => {})}
                  onBrowse={() => { setSubscriptionFilter(profile.id); setSearch(""); setOnlyFavorites(false); setPage("节点"); }}
                  onRename={name => void saveSettings(state => ({ ...state, subscriptions:
                    state.subscriptions.map(item => item.id === profile.id ? { ...item, name } : item) }))}
                  onRemove={() => void saveSettings(state => {
                    const remaining = state.subscriptions.filter(item => item.id !== profile.id);
                    const nodeIds = new Set(profile.parsed.nodes.map(node => node.id));
                    return { ...state, subscriptions: remaining, selected: preferredNode(remaining, state.selected),
                      favorites: state.favorites.filter(id => !nodeIds.has(id)) };
                  })}
                />)}
              </div> : <p className="empty">{work.ready ? "尚未导入订阅" : "等待本地订阅读取"}</p>}
            </section>
          )}
          {page === "测试" && <UnlockTests />}
          {page === "连接" && <ConnectionMonitor telemetry={telemetry} running={running} />}
          {page === "日志" && <EventLog />}
          {page === "规则" && (
            <RulesEditor rules={rules} targets={ruleTargets} onChange={edit => void saveSettings(state => ({ ...state, rules: edit(state.rules) }))} running={running} />
          )}
          {page === "诊断" && (
            <section className="panel">
              <div className="panel-head">
                <h2>本地网络测试</h2>
              </div>
              <div className="env-row">
                <span>Google TCP 443（含 DNS 解析）</span>
                <span>{localTcp}</span>
                <button
                  className="link"
                  disabled={localTcpBusy || !isTauri()}
                  onClick={testLocalTcp}
                >
                  {localTcpBusy ? "测试中…" : "测试"}
                </button>
              </div>
              <p className="rule-hint">
                此测试不经过 RelayDesk 的代理入口；若已启用其他 TUN
                或系统级代理，结果可能受其影响。
              </p>
            </section>
          )}
          {page === "设置" && (
            <section className="panel">
              <div className="panel-head">
                <h2>设置</h2>
              </div>
              <div className="empty">
                系统代理适用于遵循 Windows 代理设置的应用。TUN 接管 TCP/UDP 和 DNS，启动时需要管理员授权。本地端口模式需要在目标应用中手动填写代理地址。
              </div>
              <div className="env-row">
                <label>
                  <input type="checkbox" checked={autoReconnect} disabled={!work.ready} onChange={event => {
                    const enabled = event.target.checked;
                    void saveSettings(state => ({ ...state, autoReconnect: enabled }));
                  }} />
                  内核意外退出时自动恢复
                </label>
              </div>
              <p className="rule-hint">适用于系统代理和本地端口。TUN 重新连接时需要管理员授权。</p>
              <FixedPortSetting key={String(proxyPort)} value={proxyPort} disabled={!work.ready || busy || running}
                onChange={changed => saveSettings(state => ({ ...state, proxyPort: changed }))} />
            </section>
          )}
        </main>
      </div>
      {dialog && (
        <div className="overlay" onMouseDown={() => !importing && setDialog(false)}>
          <div
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="dialog-title"
            onMouseDown={(e) => e.stopPropagation()}
          >
            <div className="modal-head">
              <div>
                <h2 id="dialog-title">导入订阅</h2>
                <p>
                  粘贴 HTTPS 订阅地址、节点链接、Base64、Clash YAML 或 sing-box
                  JSON。
                </p>
              </div>
              <button
                className="icon-button"
                aria-label="关闭"
                disabled={importing}
                onClick={() => setDialog(false)}
              >
                <X size={18} />
              </button>
            </div>
            <textarea
              autoFocus
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="粘贴订阅地址、内容或节点链接"
            />
            <input
              hidden
              ref={file}
              type="file"
              accept=".txt,.yaml,.yml,.json"
              onChange={async (e) => {
                const f = e.target.files?.[0];
                if (f) setText(await f.text());
              }}
            />
            <div className="modal-actions">
              <button disabled={importing} onClick={() => file.current?.click()}>
                <Upload size={16} />
                选择文件
              </button>
              <span className="error">{error}</span>
              <button className="primary" disabled={importing || !work.ready} onClick={add}>
                {importing ? "正在导入…" : "解析并导入"}
              </button>
            </div>
            <p className="privacy">
              <FileText size={14} />
              订阅内容使用 Windows 数据保护加密保存在本机。
            </p>
          </div>
        </div>
      )}
    </div>
  );
}

function FixedPortSetting({ value, disabled, onChange }: {
  value: number | null;
  disabled: boolean;
  onChange: (port: number | null) => Promise<void>;
}) {
  const [port, setPort] = useState(value == null ? "" : String(value));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const isUnchanged = port.trim() === (value == null ? "" : String(value));
  return <form className="rule-form" onSubmit={event => {
    event.preventDefault();
    const input = port.trim();
    const number = input ? Number(input) : null;
    if (number != null && (!/^\d{1,5}$/.test(input) || number < 1024 || number > 65535)) {
      setError("端口须为 1024 至 65535 的整数");
      return;
    }
    setError("");
    setSaving(true);
    void onChange(number).finally(() => setSaving(false));
  }}>
    <label className="port-setting"><span>本地 HTTP / SOCKS5 端口</span>
      <input inputMode="numeric" value={port} disabled={disabled || saving} placeholder="自动分配"
        aria-describedby="proxy-port-note" onChange={event => { setPort(event.target.value); setError(""); }} />
    </label>
    <button disabled={disabled || saving || isUnchanged}>保存端口</button>
    <p className="rule-hint port-setting-note" id="proxy-port-note">留空自动分配。停止代理后可更改。</p>
    {error && <span className="error" role="alert">{error}</span>}
  </form>;
}
function UnlockTests() {
  const services = ["哔哩哔哩大陆", "哔哩哔哩港澳台", "Bahamut Anime", "ChatGPT iOS", "ChatGPT Web", "Claude", "Disney+", "Gemini", "Netflix", "Prime Video", "Spotify", "TikTok", "YouTube Premium"];
  return <><div className="unlock-heading"><span>服务解锁测试</span><button disabled title="解锁检测尚未接入">测试全部</button></div><div className="unlock-grid">{services.map(service => <TestCard key={service} serviceName={service} />)}</div></>;
}
function TestCard({serviceName}:{serviceName:string}) {
  return <section className="test-card"><div><strong>{serviceName}</strong><button disabled aria-label={`${serviceName} 测试尚未接入`}>↻</button></div><span>尚未接入</span><footer>—</footer></section>;
}
function RulesEditor({
  rules,
  targets,
  onChange,
  running,
}: {
  rules: RouteRule[];
  targets: { id: string; label: string }[];
  onChange: (edit: (rules: RouteRule[]) => RouteRule[]) => void;
  running: boolean;
}) {
  const [type, setType] = useState<RouteRule["type"]>("domain_suffix");
  const [action, setAction] = useState<RouteRule["action"]>("direct");
  const [target, setTarget] = useState("");
  const [value, setValue] = useState("");
  const [validationError, setValidationError] = useState("");
  function move(rule: RouteRule, offset: number) {
    onChange(current => {
      const index = current.indexOf(rule);
      const destination = index + offset;
      if (index < 0 || destination < 0 || destination >= current.length) return current;
      const reordered = [...current];
      [reordered[destination], reordered[index]] = [reordered[index], reordered[destination]];
      return reordered;
    });
  }
  return (
    <section className="panel">
      <div className="panel-head">
        <h2>路由规则</h2>
      </div>
      <p className="rule-hint">
        规则模式按顺序匹配，未命中时使用当前节点。指定的节点无法加载时，匹配该规则的流量会被拦截。
        {running ? "修改将在重新连接后生效。" : ""}
      </p>
      <div className="rule-form">
        <select
          aria-label="规则类型"
          value={type}
          onChange={(e) => { setType(e.target.value as RouteRule["type"]); setValidationError(""); }}
        >
          {ruleTypes.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
        </select>
        <input
          aria-label="规则内容"
          placeholder={ruleTypes.find(option => option.value === type)?.example}
          value={value}
          onChange={(e) => { setValue(e.target.value); setValidationError(""); }}
        />
        <select
          aria-label="规则动作"
          value={action}
          onChange={(e) => setAction(e.target.value as RouteRule["action"])}
        >
          <option value="direct">直连</option>
          <option value="proxy">代理</option>
          <option value="reject">拦截</option>
        </select>
        {action === "proxy" && <select aria-label="规则使用的节点" className="rule-target" value={target}
          onChange={event => setTarget(event.target.value)}>
          <option value="">当前节点</option>
          {targets.map(node => <option key={node.id} value={node.id}>{node.label}</option>)}
        </select>}
        <button
          disabled={!value.trim()}
          onClick={() => {
            try {
              const match = normalizeRuleValue(type, value);
              if (action === "proxy" && target && !targets.some(node => node.id === target)) throw new Error("请选择可用节点");
              onChange(current => [...current, { type, value: match, action, target: action === "proxy" && target ? target : undefined }]);
              setValue("");
              setValidationError("");
            } catch (error) {
              setValidationError(error instanceof Error ? error.message : "规则格式有误");
            }
          }}
        >
          添加
        </button>
      </div>
      {validationError && <p className="error" role="alert">{validationError}</p>}
      {rules.map((rule, index) => {
        const label = ruleTypes.find(option => option.value === rule.type)?.label;
        const route = rule.action === "direct" ? "直连" : rule.action === "reject" ? "拦截"
          : rule.target ? targets.find(node => node.id === rule.target)?.label ?? "指定节点已不可用" : "当前节点";
        return <div className="env-row rule-row" key={index}>
          <span>{label} · {rule.value} · {route}</span>
          <div className="rule-actions">
            <button className="link" disabled={index === 0} onClick={() => move(rule, -1)} aria-label={`上移规则 ${rule.value}`}>上移</button>
            <button className="link" disabled={index === rules.length - 1} onClick={() => move(rule, 1)} aria-label={`下移规则 ${rule.value}`}>下移</button>
            <button className="link" onClick={() => onChange(current => current.filter(item => item !== rule))}>删除</button>
          </div>
        </div>;
      })}
    </section>
  );
}
createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
