import { invoke, isTauri } from "@tauri-apps/api/core";
import { useEffect, useMemo, useState } from "react";
import { Search, Trash2, X } from "lucide-react";
import type { RouteRule } from "./config";

type Connection = {
  id: string;
  metadata: {
    host: string | null;
    sourceIP: string | null;
    sourcePort: string | null;
    destinationIP: string | null;
    destinationPort: string | null;
    process?: string | null;
    processPath?: string | null;
    network: string;
    type: string;
  };
  upload: number;
  download: number;
  chains: string[] | null;
  rule: string;
};

type Snapshot = {
  sessionId: string;
  uploadTotal: number;
  downloadTotal: number;
  memory: number | null;
  connections: Connection[];
};

type Sample = { time: number; upload: number; download: number };
type Telemetry = {
  snapshot: Snapshot | null;
  history: Sample[];
  rate?: Sample;
  message: string;
};

const historyDuration = 10 * 60 * 1000;
const idle: Telemetry = { snapshot: null, history: [], message: "连接后显示实时流量" };

export function useTelemetry(running: boolean): Telemetry {
  const [telemetry, setTelemetry] = useState(idle);

  useEffect(() => {
    if (!running || !isTauri()) {
      setTelemetry(idle);
      return;
    }

    let cancelled = false;
    let timer: number;
    let previous: { snapshot: Snapshot; time: number } | undefined;
    let sessionId: string | undefined;
    let history: Sample[] = [];
    setTelemetry({ ...idle, message: "正在读取内核数据…" });

    async function poll() {
      try {
        const snapshot = await invoke<Snapshot | null>("proxy_telemetry");
        if (cancelled) return;
        if (!snapshot) {
          previous = undefined;
          setTelemetry({ ...idle, message: "等待内核连接…" });
          return;
        }

        if (snapshot.sessionId !== sessionId) {
          sessionId = snapshot.sessionId;
          previous = undefined;
          history = [];
        }
        const time = performance.now();
        const elapsed = previous ? (time - previous.time) / 1000 : 0;
        let rate: Sample | undefined;
        if (previous && elapsed > 0 && elapsed <= 4) {
          const upload = snapshot.uploadTotal - previous.snapshot.uploadTotal;
          const download = snapshot.downloadTotal - previous.snapshot.downloadTotal;
          if (upload >= 0 && download >= 0) {
            rate = { time, upload: upload / elapsed, download: download / elapsed };
            history = [...history.filter(sample => sample.time > time - historyDuration), rate];
          }
        }
        previous = { snapshot, time };
        setTelemetry({ snapshot, rate, history, message: "正在采集速率…" });
      } catch (error) {
        if (cancelled) return;
        previous = undefined;
        setTelemetry({
          ...idle,
          message: typeof error === "string" ? error : "内核监控暂时不可用",
        });
      } finally {
        if (!cancelled) timer = window.setTimeout(poll, 1000);
      }
    }

    void poll();
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [running]);

  return running ? telemetry : idle;
}

export function formatBytes(bytes?: number | null, rate = false): string {
  if (bytes == null) return "—";
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  const exponent = Math.min(units.length - 1, Math.floor(Math.log2(Math.max(1, bytes)) / 10));
  const value = bytes / (1024 ** exponent);
  const formatted = value.toLocaleString(undefined, { maximumFractionDigits: exponent === 0 ? 0 : 1 });
  return `${formatted} ${units[exponent]}${rate ? "/s" : ""}`;
}

function TrafficChart({ history, mini = false }: { history: Sample[]; mini?: boolean }) {
  const width = mini ? 176 : 800;
  const height = mini ? 24 : 120;
  const last = history.at(-1)?.time ?? 0;
  const duration = mini ? 60_000 : historyDuration;
  const points = history.filter(sample => sample.time >= last - duration);
  const peak = Math.max(1, ...points.map(sample => Math.max(sample.upload, sample.download)));
  function path(series: "upload" | "download") {
    return points.map((sample, index) => {
      const x = width - (last - sample.time) / duration * (width - 2) - 1;
      const y = height - 2 - sample[series] / peak * (height - 4);
      const previous = points[index - 1];
      const join = previous && sample.time - previous.time < 4500;
      return `${join ? "L" : "M"} ${x.toFixed(2)} ${y.toFixed(2)}${join ? "" : " l 0.01 0"}`;
    }).join(" ");
  }

  return <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" aria-hidden="true">
    {!mini && [0, 0.5, 1].map(ratio => (
      <line className="traffic-guide" key={ratio} x1="0" x2={width} y1={2 + ratio * (height - 4)} y2={2 + ratio * (height - 4)} />
    ))}
    <path className="traffic-up" d={path("upload")} />
    <path className="traffic-down" d={path("download")} />
  </svg>;
}

export function TrafficSidebar({ telemetry }: { telemetry: Telemetry }) {
  const { rate, snapshot, history } = telemetry;
  return <div className="traffic-sidebar">
    <span className="traffic-up">↑ {formatBytes(rate?.upload, true)}</span>
    <span className="traffic-down">↓ {formatBytes(rate?.download, true)}</span>
    <TrafficChart history={history} mini />
    <small>本次流量 {snapshot ? formatBytes(snapshot.uploadTotal + snapshot.downloadTotal) : "—"}</small>
  </div>;
}

export function TrafficDashboard({ telemetry }: { telemetry: Telemetry }) {
  const { rate, snapshot, history, message } = telemetry;
  const metrics = [
    ["上传速度", formatBytes(rate?.upload, true)],
    ["下载速度", formatBytes(rate?.download, true)],
    ["活跃连接", snapshot?.connections.length ?? "—"],
    ["本次上传", formatBytes(snapshot?.uploadTotal)],
    ["本次下载", formatBytes(snapshot?.downloadTotal)],
    ["内核内存", formatBytes(snapshot?.memory)],
  ];
  const peak = Math.max(1, ...history.map(sample => Math.max(sample.upload, sample.download)));

  return <section className="panel traffic-panel">
    <div className="panel-head">
      <h2>实时流量</h2>
      <span className="traffic-legend"><span className="traffic-up">↑ 上传</span><span className="traffic-down">↓ 下载</span></span>
    </div>
    {rate ? (
      <div className="traffic-plot" aria-label="过去十分钟的上传和下载速率">
        <div className="traffic-scale"><span>{formatBytes(peak, true)}</span><span>0 B/s</span></div>
        <TrafficChart history={history} />
        <div className="traffic-times"><span>10 分钟前</span><span>5 分钟前</span><span>现在</span></div>
      </div>
    ) : <div className="traffic-empty">{message}</div>}
    <div className="metric-grid">
      {metrics.map(([label, value]) => <div className="metric" key={label}><span>{label}</span><strong>{value}</strong></div>)}
    </div>
  </section>;
}

function endpoint(host: string | null, port: string | null): string {
  if (!host) return "—";
  return port ? `${host.includes(":") ? `[${host}]` : host}:${port}` : host;
}

function processExeName(metadata: Connection["metadata"]): string | undefined {
  const raw = metadata.processPath?.trim() || metadata.process?.trim();
  if (!raw) return undefined;
  const base = raw.split(/[\\/]/).pop()?.trim();
  return base || undefined;
}

export type ProcessAggregate = {
  key: string;
  process: string;
  processPath?: string;
  canProcessRule: boolean;
  count: number;
  upload: number;
  download: number;
  ids: string[];
  topDestinations: string[];
  routes: string[];
};

export function aggregateConnectionsByProcess(
  items: Connection[],
  sortBy: "default" | "download" | "upload" = "download",
): ProcessAggregate[] {
  const groups = new Map<string, {
    process: string;
    processPath?: string;
    canProcessRule: boolean;
    count: number;
    upload: number;
    download: number;
    ids: string[];
    destinations: Map<string, number>;
    routes: Set<string>;
  }>();
  for (const conn of items) {
    const exe = processExeName(conn.metadata);
    const process = exe || "未知进程";
    const key = exe ? exe.toLowerCase() : "__unknown__";
    let entry = groups.get(key);
    if (!entry) {
      entry = {
        process,
        processPath: conn.metadata.processPath?.trim() || undefined,
        canProcessRule: !!exe && /^[^<>:"/\\|?*]+\.exe$/i.test(exe),
        count: 0,
        upload: 0,
        download: 0,
        ids: [],
        destinations: new Map(),
        routes: new Set(),
      };
      groups.set(key, entry);
    }
    entry.count += 1;
    entry.upload += conn.upload;
    entry.download += conn.download;
    entry.ids.push(conn.id);
    const dest = conn.metadata.host || conn.metadata.destinationIP || "—";
    entry.destinations.set(dest, (entry.destinations.get(dest) ?? 0) + conn.download + conn.upload);
    const chain = conn.chains?.slice().reverse().join(" → ") || (conn.rule === "final" ? "默认路由" : conn.rule);
    if (chain) entry.routes.add(chain);
  }
  const result: ProcessAggregate[] = Array.from(groups.entries()).map(([key, g]) => ({
    key,
    process: g.process,
    processPath: g.processPath,
    canProcessRule: g.canProcessRule,
    count: g.count,
    upload: g.upload,
    download: g.download,
    ids: g.ids,
    topDestinations: Array.from(g.destinations.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([dest]) => dest),
    routes: Array.from(g.routes).slice(0, 3),
  }));
  if (sortBy === "download") result.sort((a, b) => b.download - a.download || b.count - a.count);
  else if (sortBy === "upload") result.sort((a, b) => b.upload - a.upload || b.count - a.count);
  else result.sort((a, b) => b.count - a.count || b.download - a.download);
  return result;
}

export function ConnectionMonitor({
  telemetry,
  running,
  onQuickRule,
}: {
  telemetry: Telemetry;
  running: boolean;
  onQuickRule?: (rule: RouteRule) => void;
}) {
  const { snapshot, message } = telemetry;
  const [viewMode, setViewMode] = useState<"connections" | "processes">("connections");
  const [query, setQuery] = useState("");
  const [sortBy, setSortBy] = useState<"default" | "download" | "upload">("download");
  const [busyId, setBusyId] = useState<string>();
  const [actionMsg, setActionMsg] = useState("");

  const filtered = useMemo(() => {
    const items = snapshot?.connections ?? [];
    const q = query.trim().toLowerCase();
    const matched = q
      ? items.filter(({ metadata, chains, rule }) =>
          [metadata.host, metadata.destinationIP, metadata.sourceIP, metadata.process, metadata.processPath, rule, ...(chains ?? [])]
            .filter(Boolean)
            .join(" ")
            .toLowerCase()
            .includes(q))
      : [...items];
    if (sortBy === "download") matched.sort((a, b) => b.download - a.download);
    else if (sortBy === "upload") matched.sort((a, b) => b.upload - a.upload);
    return matched;
  }, [snapshot?.connections, query, sortBy]);

  const processGroups = useMemo(
    () => aggregateConnectionsByProcess(filtered, sortBy),
    [filtered, sortBy],
  );

  async function closeGroup(ids: string[], label: string) {
    if (!isTauri() || !ids.length) return;
    setBusyId(`group:${label}`);
    setActionMsg("");
    try {
      await Promise.all(ids.map(id => invoke("close_proxy_connection", { id })));
      setActionMsg(`已请求断开「${label}」的 ${ids.length} 条连接`);
    } catch (e) {
      setActionMsg(typeof e === "string" ? e : "批量关闭连接失败");
    } finally {
      setBusyId(undefined);
    }
  }

  async function closeOne(id: string) {
    if (!isTauri()) return;
    setBusyId(id);
    setActionMsg("");
    try {
      await invoke("close_proxy_connection", { id });
    } catch (e) {
      setActionMsg(typeof e === "string" ? e : "关闭连接失败");
    } finally {
      setBusyId(undefined);
    }
  }

  async function closeAll() {
    if (!isTauri()) return;
    setBusyId("*");
    setActionMsg("");
    try {
      await invoke("close_all_connections");
      setActionMsg("已请求断开全部活跃连接");
    } catch (e) {
      setActionMsg(typeof e === "string" ? e : "断开全部连接失败");
    } finally {
      setBusyId(undefined);
    }
  }

  return <section className="panel connection-monitor">
    <div className="panel-head">
      <h2>
        {viewMode === "processes"
          ? `按进程连接 (${processGroups.length} 个进程 · ${filtered.length} 条)`
          : `活跃连接 ${snapshot ? `(${filtered.length}/${snapshot.connections.length})` : ""}`}
      </h2>
      <div className="event-controls">
        <div className="mode-switch" role="tablist" aria-label="连接视图">
          <button type="button" aria-pressed={viewMode === "connections"} onClick={() => setViewMode("connections")}>
            明细
          </button>
          <button type="button" aria-pressed={viewMode === "processes"} onClick={() => setViewMode("processes")}>
            按进程
          </button>
        </div>
        <label className="search" style={{ maxWidth: 220 }}>
          <Search size={14} />
          <input
            placeholder="搜索域名、进程、IP、规则或出站"
            value={query}
            onChange={e => setQuery(e.target.value)}
          />
        </label>
        <select aria-label="连接排序" value={sortBy} onChange={e => setSortBy(e.target.value as typeof sortBy)}>
          <option value="download">按下载量</option>
          <option value="upload">按上传量</option>
          <option value="default">{viewMode === "processes" ? "按连接数" : "按内核顺序"}</option>
        </select>
        <button
          className="mini-btn"
          disabled={!running || !snapshot?.connections.length || busyId === "*"}
          onClick={() => void closeAll()}
        >
          <Trash2 size={13} /> 断开全部
        </button>
      </div>
    </div>
    {actionMsg && <p className="rule-hint" role="status" style={{ marginBottom: 10 }}>{actionMsg}</p>}
    {filtered.length ? (
      viewMode === "processes" ? (
        <div className="connection-table">
          <table>
            <thead>
              <tr>
                <th scope="col">进程 / 常访目标</th>
                <th scope="col" style={{ width: "6em", textAlign: "right" }}>连接数</th>
                <th scope="col">主要路由 / 出站</th>
                <th scope="col" style={{ width: "6.5em", textAlign: "right" }}>上传</th>
                <th scope="col" style={{ width: "6.5em", textAlign: "right" }}>下载</th>
                <th scope="col" style={{ width: "12.5em", textAlign: "right" }}>操作</th>
              </tr>
            </thead>
            <tbody>
              {processGroups.map(group => (
                <tr key={group.key}>
                  <td>
                    <strong title={group.processPath || group.process}>{group.process}</strong>
                    <small title={group.topDestinations.join(", ")}>
                      {group.topDestinations.join(" · ") || "—"}
                    </small>
                  </td>
                  <td style={{ textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
                    <strong>{group.count}</strong>
                  </td>
                  <td>
                    <strong title={group.routes.join(" / ")}>{group.routes[0] || "—"}</strong>
                    {group.routes.length > 1 && <small>{group.routes.slice(1).join(" · ")}</small>}
                  </td>
                  <td style={{ textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{formatBytes(group.upload)}</td>
                  <td style={{ textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{formatBytes(group.download)}</td>
                  <td style={{ textAlign: "right" }}>
                    <div style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
                      {group.canProcessRule && (
                        <button
                          type="button"
                          className="link"
                          onClick={() => {
                            setQuery(group.process);
                            setViewMode("connections");
                          }}
                        >
                          明细
                        </button>
                      )}
                      {onQuickRule && group.canProcessRule && (
                        <button
                          type="button"
                          className="link"
                          title={`将进程 ${group.process} 设为直连规则`}
                          onClick={() => {
                            onQuickRule({ type: "process_name", value: group.process, action: "direct" });
                            setActionMsg(`已添加进程直连：${group.process}（热重载或重连后生效）`);
                          }}
                        >
                          进程直连
                        </button>
                      )}
                      <button
                        type="button"
                        className="icon-button"
                        aria-label={`断开 ${group.process} 的全部连接`}
                        disabled={busyId === `group:${group.process}`}
                        onClick={() => void closeGroup(group.ids, group.process)}
                      >
                        <X size={14} />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
      <div className="connection-table">
        <table>
          <thead>
            <tr>
              <th scope="col">目标</th>
              <th scope="col">进程 / 来源</th>
              <th scope="col">规则 / 出站</th>
              <th scope="col" style={{ width: "6.5em", textAlign: "right" }}>上传</th>
              <th scope="col" style={{ width: "6.5em", textAlign: "right" }}>下载</th>
              <th scope="col" style={{ width: "10em", textAlign: "right" }}>操作</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map(({ id, metadata, chains, rule, upload, download }) => {
              const destination = endpoint(metadata.host || metadata.destinationIP, metadata.destinationPort);
              const source = endpoint(metadata.sourceIP, metadata.sourcePort);
              const proc = processExeName(metadata);
              const canProcessRule = !!proc && /^[^<>:"/\\|?*]+\.exe$/i.test(proc);
              const host = metadata.host?.trim();
              return <tr key={id}>
                <td><strong title={destination}>{destination}</strong><small>{metadata.network.toUpperCase()} · {metadata.type}</small></td>
                <td>
                  {proc ? (
                    <>
                      <strong title={metadata.processPath || proc}>{proc}</strong>
                      <small title={source}>{source}</small>
                    </>
                  ) : (
                    <span title={source}>{source}</span>
                  )}
                </td>
                <td><strong title={rule}>{rule === "final" ? "默认路由" : rule}</strong><small>{chains?.slice().reverse().join(" → ") || "—"}</small></td>
                <td style={{ textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{formatBytes(upload)}</td>
                <td style={{ textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{formatBytes(download)}</td>
                <td style={{ textAlign: "right" }}>
                  <div style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
                    {onQuickRule && canProcessRule && proc && (
                      <button
                        type="button"
                        className="link"
                        title={`将进程 ${proc} 设为直连规则`}
                        onClick={() => {
                          onQuickRule({ type: "process_name", value: proc, action: "direct" });
                          setActionMsg(`已添加进程直连：${proc}（热重载或重连后生效）`);
                        }}
                      >
                        进程直连
                      </button>
                    )}
                    {onQuickRule && host && (
                      <button
                        type="button"
                        className="link"
                        title={`将 ${host} 设为直连规则`}
                        onClick={() => {
                          onQuickRule({ type: "domain", value: host, action: "direct" });
                          setActionMsg(`已添加直连规则：${host}（热重载或重连后生效）`);
                        }}
                      >
                        域名直连
                      </button>
                    )}
                    <button
                      type="button"
                      className="icon-button"
                      aria-label={`断开连接 ${destination}`}
                      disabled={busyId === id}
                      onClick={() => void closeOne(id)}
                    >
                      <X size={14} />
                    </button>
                  </div>
                </td>
              </tr>;
            })}
          </tbody>
        </table>
      </div>
      )
    ) : <p className="empty">{snapshot ? (query ? "没有匹配的连接" : "当前没有活跃连接") : running ? message : "启动代理后显示活跃连接"}</p>}
  </section>;
}
