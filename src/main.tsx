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
  Upload,
  X,
} from "lucide-react";
import type { NodeProfile } from "./subscription";
import { buildConfig, buildSessionConfig, connectionSupport, normalizeRuleDomain, withSelectedOutbound, type RouteRule, type SessionPlan } from "./config";
import { ConnectionMonitor, TrafficDashboard, TrafficSidebar, useTelemetry } from "./telemetry";
import { SubscriptionCard } from "./SubscriptionCard";
import { useWorkspace } from "./useWorkspace";
import { preferredNode, type EntryMode, type Workspace } from "./workspace";
import "./style.css";
import "./accessibility.css";
import "./rules.css";
import "./dashboard.css";

type Page = "概览" | "节点" | "订阅" | "连接" | "规则" | "日志" | "测试" | "诊断" | "设置";
const entryModes: { value: EntryMode; label: string }[] = [
  { value: "system", label: "系统代理" },
  { value: "tun", label: "TUN" },
  { value: "local", label: "本地端口" },
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
  const { subscriptions, rules, selected, entryMode: mode } = work.workspace;
  const nodes = useMemo(() => subscriptions.flatMap(profile => profile.parsed.nodes), [subscriptions]);
  const [subscriptionFilter, setSubscriptionFilter] = useState("");
  const [dialog, setDialog] = useState(false);
  const [text, setText] = useState("");
  const [error, setError] = useState("");
  const [importing, setImporting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [settingsError, setSettingsError] = useState("");
  const [search, setSearch] = useState("");
  const file = useRef<HTMLInputElement>(null);
  const [running, setRunning] = useState(false);
  const [runningNode, setRunningNode] = useState<NodeProfile>();
  const session = useRef<SessionPlan>();
  const telemetry = useTelemetry(running);
  const [port, setPort] = useState<number>();
  const [connectionError, setConnectionError] = useState("");
  const [checkResult, setCheckResult] = useState("");
  const [checking, setChecking] = useState(false);
  const [latencies, setLatencies] = useState<Record<string, string>>({});
  const [testing, setTesting] = useState(false);
  const [exitIp, setExitIp] = useState("");
  const [localTcp, setLocalTcp] = useState("尚未测试");
  const [localTcpBusy, setLocalTcpBusy] = useState(false);
  const cancelTesting = useRef(false);
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
    setRunningNode(undefined);
    setPort(undefined);
    setExitIp("");
    setCheckResult("");
  }
  useEffect(() => {
    if (!isTauri() || busy || !running) return;
    let cancelled = false;
    const timer = window.setInterval(() => {
      invoke<boolean>("proxy_running")
        .then((active) => {
          if (cancelled) return;
          if (!active) clearSession();
        })
        .catch(() => { /* IPC failure does not prove that the core has stopped. */ });
    }, 2000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [busy, running]);
  const activeFilter = subscriptions.find(profile => profile.id === subscriptionFilter);
  const filtered = (activeFilter?.parsed.nodes ?? nodes).filter((n) =>
    `#${n.sourceIndex ?? ""} ${n.name} ${n.protocol} ${n.server}`
      .toLowerCase()
      .includes(search.trim().toLowerCase()),
  );
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
    ? runningNode?.id === node.id && runningNode.uri === node.uri
    : node.id === selected;
  async function checkProxy() {
    if (!port) return;
    setChecking(true);
    setCheckResult("");
    try {
      const ms = await invoke<number>("check_connection", { port });
      setCheckResult(`网络验证成功 · ${ms} ms`);
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
  async function selectNode(node: NodeProfile) {
    if (busy || testing || isSelected(node)) return;
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
      if (loaded && loaded.uri === node.uri) {
        await invoke("switch_proxy_node", { tag: loaded.tag });
        session.current = withSelectedOutbound(previous, loaded.tag);
        setRunningNode(node);
        await remember();
        return;
      }
      const next = await prepareSession(node, port);
      await invoke("stop_proxy");
      try {
        await invoke("start_proxy", { config: next.config, mode });
        session.current = next;
        setRunningNode(node);
        setRunning(true);
        await remember();
      } catch (failure) {
        try {
          await invoke("start_proxy", { config: previous.config, mode });
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
      const queue = items.filter((node) => !connectionSupport(node));
      let next = 0;
      async function testQueue() {
        while (next < queue.length && !cancelTesting.current) {
          const node = queue[next++];
          setLatencies((previous) => ({ ...previous, [node.id]: "测试中" }));
          let result: string;
          try {
            const localPort = await invoke<number>("allocate_port");
            const ms = await invoke<number>("probe_node", {
              config: buildConfig(node, localPort),
              port: localPort,
            });
            result = `${ms} ms`;
          } catch (e) {
            result = typeof e === "string" ? e : "代理请求失败";
          }
          setLatencies((previous) => ({
            ...previous,
            [node.id]: `${result} · ${new Date().toLocaleTimeString()}`,
          }));
        }
      }
      await Promise.all(Array.from({ length: Math.min(4, queue.length) }, testQueue));
    } finally {
      setTesting(false);
    }
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
    try {
      if (!isTauri()) throw new Error("请在桌面应用中连接");
      if (running) {
        await invoke("stop_proxy");
        clearSession();
      } else {
        if (!preferred) throw new Error("请先导入并选择节点");
        const localPort = await invoke<number>("allocate_port");
        const next = await prepareSession(preferred, localPort);
        await invoke("start_proxy", { config: next.config, mode });
        session.current = next;
        setRunningNode(preferred);
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
            {running ? "内核运行中" : "内核未运行"}
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
                    {running ? "内核运行中" : "未连接"}
                  </div>
                  <p>
                    {connectionError ||
                      (running
                        ? `本地 HTTP / SOCKS5：127.0.0.1:${port}`
                        : "代理未运行")}
                    {running && (
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
                  <small>HTTP / SOCKS5</small>
                </div>
              </div>
              <div className="columns">
                <section className="panel">
                  <div className="panel-head"><h2>网站测试</h2></div>
                  <div className="site-grid">{["Apple", "GitHub", "Google", "YouTube"].map(site => <div key={site}><strong>{site}</strong><span>测试未接入</span></div>)}</div>
                </section>
                <section className="panel">
                  <div className="panel-head"><h2>IP 信息</h2><button className="link" disabled={!running || checking} onClick={showExitIp}>刷新</button></div>
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
                <button
                  className="link"
                  disabled={busy || !filtered.length || !isTauri()}
                  onClick={() =>
                    testing
                      ? (cancelTesting.current = true)
                      : testNodes(filtered)
                  }
                >
                  {testing ? "取消测速" : "一键测试延迟"}
                </button>
                <span>{filtered.length} 个节点</span>
              </div>
              <div className="group-heading"><strong>已导入节点</strong><span>手动选择 · {filtered.length} 个节点</span></div>
              {connectionError && (
                <div className="notice" role="alert">
                  {connectionError}
                </div>
              )}
              {running && (
                <div className="notice">
                  当前出口 IP：{exitIp || "尚未检查"}{" "}
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
                    <span className="probe-result" title={connectionSupport(n) || latencies[n.id]}>
                      {connectionSupport(n)
                        ? "暂不支持"
                        : latencies[n.id] || "未测试"}
                    </span>
                    <button
                      className="link"
                      disabled={
                        busy ||
                        testing ||
                        !!connectionSupport(n) ||
                        isSelected(n)
                      }
                      title={connectionSupport(n) || undefined}
                      onClick={() => selectNode(n)}
                    >
                      {isSelected(n)
                        ? "已选择"
                        : connectionSupport(n)
                          ? "不可用"
                          : runningNode?.id === n.id ? "应用更新" : "切换"}
                    </button>
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
                  onBrowse={() => { setSubscriptionFilter(profile.id); setSearch(""); setPage("节点"); }}
                  onRename={name => void saveSettings(state => ({ ...state, subscriptions:
                    state.subscriptions.map(item => item.id === profile.id ? { ...item, name } : item) }))}
                  onRemove={() => void saveSettings(state => {
                    const remaining = state.subscriptions.filter(item => item.id !== profile.id);
                    return { ...state, subscriptions: remaining, selected: preferredNode(remaining, state.selected) };
                  })}
                />)}
              </div> : <p className="empty">{work.ready ? "尚未导入订阅" : "等待本地订阅读取"}</p>}
            </section>
          )}
          {page === "测试" && <UnlockTests />}
          {page === "连接" && <ConnectionMonitor telemetry={telemetry} running={running} />}
          {page === "日志" && <section className="panel"><h2>内核日志</h2><p className="empty">日志查看尚未接入。</p></section>}
          {page === "规则" && (
            <RulesEditor rules={rules} onChange={edit => void saveSettings(state => ({ ...state, rules: edit(state.rules) }))} running={running} />
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
function UnlockTests() {
  const services = ["哔哩哔哩大陆", "哔哩哔哩港澳台", "Bahamut Anime", "ChatGPT iOS", "ChatGPT Web", "Claude", "Disney+", "Gemini", "Netflix", "Prime Video", "Spotify", "TikTok", "YouTube Premium"];
  return <><div className="unlock-heading"><span>服务解锁测试</span><button disabled title="解锁检测尚未接入">测试全部</button></div><div className="unlock-grid">{services.map(service => <TestCard key={service} serviceName={service} />)}</div></>;
}
function TestCard({serviceName}:{serviceName:string}) {
  return <section className="test-card"><div><strong>{serviceName}</strong><button disabled aria-label={`${serviceName} 测试尚未接入`}>↻</button></div><span>尚未接入</span><footer>—</footer></section>;
}
function RulesEditor({
  rules,
  onChange,
  running,
}: {
  rules: RouteRule[];
  onChange: (edit: (rules: RouteRule[]) => RouteRule[]) => void;
  running: boolean;
}) {
  const [type, setType] = useState<RouteRule["type"]>("domain_suffix");
  const [action, setAction] = useState<RouteRule["action"]>("direct");
  const [value, setValue] = useState("");
  const [validationError, setValidationError] = useState("");
  return (
    <section className="panel">
      <div className="panel-head">
        <h2>路由规则</h2>
      </div>
      <p className="rule-hint">
        按顺序匹配，未命中时使用当前节点。
        {running ? "修改将在重新连接后生效。" : ""}
      </p>
      <div className="rule-form">
        <select
          aria-label="规则类型"
          value={type}
          onChange={(e) => setType(e.target.value as RouteRule["type"])}
        >
          <option value="domain">域名</option>
          <option value="domain_suffix">域名后缀</option>
        </select>
        <input
          aria-label="规则内容"
          placeholder="example.com"
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
        <button
          disabled={!value.trim()}
          onClick={() => {
            try {
              const domain = normalizeRuleDomain(value);
              onChange(current => [...current, { type, value: domain, action }]);
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
      {rules.map((rule, index) => (
        <div className="env-row" key={index}>
          <span>
            {rule.type} · {rule.value} · {rule.action}
          </span>
          <button
            className="link"
            onClick={() => onChange(current => current.filter(item => item !== rule))}
          >
            删除
          </button>
        </div>
      ))}
    </section>
  );
}
createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
