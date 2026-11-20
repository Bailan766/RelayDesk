import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { invoke, isTauri } from "@tauri-apps/api/core";
import {
  Activity,
  Boxes,
  CircleHelp,
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
import {
  parseSubscription,
  type ImportResult,
  type NodeProfile,
} from "./subscription";
import { buildConfig, connectionSupport, type RouteRule } from "./config";
import "./style.css";
import "./accessibility.css";
import "./rules.css";
import "./dashboard.css";

type Page = "概览" | "节点" | "订阅" | "连接" | "规则" | "日志" | "测试" | "诊断" | "设置";
type EntryMode = "system" | "tun" | "local";
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
  const [nodes, setNodes] = useState<NodeProfile[]>([]);
  const [selected, setSelected] = useState<string>();
  const [dialog, setDialog] = useState(false);
  const [text, setText] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ImportResult>();
  const [search, setSearch] = useState("");
  const file = useRef<HTMLInputElement>(null);
  const [running, setRunning] = useState(false);
  const [mode, setMode] = useState<EntryMode>("system");
  const [port, setPort] = useState<number>();
  const [connectionError, setConnectionError] = useState("");
  const [checkResult, setCheckResult] = useState("");
  const [checking, setChecking] = useState(false);
  const [rules, setRules] = useState<RouteRule[]>([]);
  const [latencies, setLatencies] = useState<Record<string, string>>({});
  const [testing, setTesting] = useState(false);
  const [exitIp, setExitIp] = useState("");
  const [localTcp, setLocalTcp] = useState("尚未测试");
  const [localTcpBusy, setLocalTcpBusy] = useState(false);
  const cancelTesting = useRef(false);
  const [savedContent, setSavedContent] = useState("");
  const [savedSource, setSavedSource] = useState("");
  const [storageError, setStorageError] = useState("");
  const [storageReady, setStorageReady] = useState(!isTauri());
  const saveQueue = useRef<Promise<void>>(Promise.resolve());
  function persist(data: string) {
    const next = saveQueue.current
      .catch(() => {})
      .then(() => invoke<void>("save_subscription", { data }));
    saveQueue.current = next;
    return next;
  }
  useEffect(() => {
    if (!isTauri()) return;
    let cancelled = false;
    invoke<string | null>("load_subscription")
      .then((raw) => {
        if (!raw || cancelled) return;
        const saved = JSON.parse(raw) as {
          content: string;
          source?: string;
          selected: number;
        };
        const parsed = parseSubscription(saved.content);
        setNodes(parsed.nodes);
        setResult(parsed);
        setSavedContent(saved.content);
        setSavedSource(saved.source || "");
        setSelected(
          parsed.nodes[saved.selected]?.id ||
            parsed.nodes.find((n) => !connectionSupport(n))?.id,
        );
      })
      .catch(() => {
        if (!cancelled) setStorageError("已保存的订阅读取失败，原数据仍保留。");
      })
      .finally(() => {
        if (!cancelled) setStorageReady(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);
  useEffect(() => {
    if (!isTauri() || busy) return;
    let cancelled = false;
    const timer = window.setInterval(() => {
      invoke<boolean>("proxy_running")
        .then((active) => {
          if (cancelled) return;
          setRunning(active);
          if (!active) setPort(undefined);
        })
        .catch(() => {
          if (cancelled) return;
          setRunning(false);
          setPort(undefined);
        });
    }, 2000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [busy]);
  const filtered = nodes.filter((n) =>
    `#${n.sourceIndex ?? ""} ${n.name} ${n.protocol} ${n.server}`
      .toLowerCase()
      .includes(search.trim().toLowerCase()),
  );
  async function add() {
    setBusy(true);
    setError("");
    try {
      if (!storageReady) throw new Error("正在读取本地订阅，请稍候");
      if (running) throw new Error("请先停止当前代理");
      let content = text.trim();
      const source = /^https?:\/\//i.test(content) ? content : "";
      if (source) {
        if (!isTauri()) throw new Error("订阅地址需要在桌面应用中下载");
        content = await invoke<string>("fetch_subscription", {
          address: source,
        });
      }
      const parsed = parseSubscription(content);
      const index = parsed.nodes.findIndex((n) => !connectionSupport(n));
      if (isTauri())
        await persist(JSON.stringify({ content, source, selected: index }));
      setNodes(parsed.nodes);
      setSelected(parsed.nodes[index]?.id);
      setResult(parsed);
      setSavedContent(content);
      setSavedSource(source);
      setStorageError("");
      setText("");
      setDialog(false);
      setPage("节点");
    } catch (e) {
      setError(
        typeof e === "string" ? e : e instanceof Error ? e.message : "导入失败",
      );
    } finally {
      setBusy(false);
    }
  }
  const current = nodes.find((n) => n.id === selected);
  useEffect(() => {
    if (!isTauri() || !savedContent || !selected) return;
    const index = nodes.findIndex((n) => n.id === selected);
    if (index < 0) return;
    persist(
      JSON.stringify({
        content: savedContent,
        source: savedSource,
        selected: index,
      }),
    ).catch(() => setStorageError("节点选择保存失败"));
  }, [selected, savedContent, savedSource, nodes]);
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
  async function selectNode(node: NodeProfile) {
    if (busy || testing || node.id === selected) return;
    if (!running || !port || !current) {
      setSelected(node.id);
      return;
    }
    setBusy(true);
    setConnectionError("");
    setCheckResult("");
    setExitIp("");
    try {
      const next = buildConfig(node, port, rules);
      const previous = buildConfig(current, port, rules);
      await invoke("stop_proxy");
      try {
        await invoke("start_proxy", { config: next, mode });
        setSelected(node.id);
        setRunning(true);
      } catch (failure) {
        try {
          await invoke("start_proxy", { config: previous, mode });
          setRunning(true);
        } catch {
          setRunning(false);
          setPort(undefined);
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
        setRunning(false);
        setPort(undefined);
        setExitIp("");
      } else {
        if (!current) throw new Error("请先导入并选择节点");
        const localPort = await invoke<number>("allocate_port");
        await invoke("start_proxy", {
          config: buildConfig(current, localPort, rules),
          mode,
        });
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
        <div className="side-bottom">
          <CircleHelp size={16} />
          <div>实时流量未接入<small>↑ —　↓ —</small></div>
        </div>
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
              <button className="primary" onClick={() => setDialog(true)}>
                <Plus size={16} />
                导入订阅
              </button>
            )}
          </div>
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
                    <select value={mode} disabled={busy || running} onChange={(e) => setMode(e.target.value as EntryMode)}>
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
              <TrafficDashboard />
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
                <div>
                  <span>本次上传</span>
                  <strong>—</strong>
                  <small>暂无流量数据</small>
                </div>
                <div>
                  <span>本次下载</span>
                  <strong>—</strong>
                  <small>暂无流量数据</small>
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
              {result?.warnings.length ? (
                <div className="notice">
                  {result.warnings.length} 项未导入，请检查订阅格式。
                </div>
              ) : null}
              <div className="node-grid">
                {filtered.map((n) => (
                  <div className={`node-card ${selected === n.id ? "selected" : ""}`} key={n.id}>
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
                        selected === n.id
                      }
                      title={connectionSupport(n) || undefined}
                      onClick={() => selectNode(n)}
                    >
                      {selected === n.id
                        ? "已选择"
                        : connectionSupport(n)
                          ? "不可用"
                          : "切换"}
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
            <><section className="panel">
              <div className="panel-head">
                <h2>订阅来源</h2>
              </div>
              <div className="empty">
                {storageError ||
                  (result
                    ? `已从 ${result.format} 导入 ${nodes.length} 个节点。订阅已加密保存在本机。`
                    : "尚未导入订阅。")}
                <button className="link" onClick={() => setDialog(true)}>
                  导入订阅 →
                </button>
              </div>
            </section><div className="extension-grid"><section className="panel"><h2>全局扩展覆写配置</h2><p>尚未接入</p></section><section className="panel"><h2>全局扩展脚本</h2><p>尚未接入</p></section></div></>
          )}
          {page === "测试" && <UnlockTests />}
          {page === "连接" && <section className="panel"><h2>连接监控</h2><p className="empty">连接列表尚未接入。</p></section>}
          {page === "日志" && <section className="panel"><h2>内核日志</h2><p className="empty">日志查看尚未接入。</p></section>}
          {page === "规则" && (
            <RulesEditor rules={rules} onChange={setRules} running={running} />
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
        <div className="overlay" onMouseDown={() => !busy && setDialog(false)}>
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
                disabled={busy}
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
              <button disabled={busy} onClick={() => file.current?.click()}>
                <Upload size={16} />
                选择文件
              </button>
              <span className="error">{error}</span>
              <button className="primary" disabled={busy} onClick={add}>
                {busy ? "正在导入…" : "解析并导入"}
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
function TrafficDashboard() {
  const metrics = ["上传速度", "下载速度", "活跃连接", "上传量", "下载量", "内核占用"];
  return <section className="panel traffic-panel"><div className="panel-head"><h2>流量统计</h2><span className="muted">上传 / 下载</span></div><div className="traffic-empty"><span>实时流量数据尚未接入</span></div><div className="metric-grid">{metrics.map(label => <div className="metric" key={label}><span>{label}</span><strong>—</strong></div>)}</div></section>;
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
  onChange: (rules: RouteRule[]) => void;
  running: boolean;
}) {
  const [type, setType] = useState<RouteRule["type"]>("domain_suffix");
  const [action, setAction] = useState<RouteRule["action"]>("direct");
  const [value, setValue] = useState("");
  return (
    <section className="panel">
      <div className="panel-head">
        <h2>路由规则</h2>
      </div>
      <p className="rule-hint">
        按顺序匹配，未命中时使用当前节点。
        {running ? "修改将在重新连接后生效。" : ""}规则仅保留到应用退出。
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
          onChange={(e) => setValue(e.target.value)}
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
            onChange([...rules, { type, value: value.trim(), action }]);
            setValue("");
          }}
        >
          添加
        </button>
      </div>
      {rules.map((rule, index) => (
        <div className="env-row" key={index}>
          <span>
            {rule.type} · {rule.value} · {rule.action}
          </span>
          <button
            className="link"
            onClick={() => onChange(rules.filter((_, i) => i !== index))}
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
