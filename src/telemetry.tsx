import { invoke, isTauri } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";

type Connection = {
  id: string;
  metadata: {
    host: string | null;
    sourceIP: string | null;
    sourcePort: string | null;
    destinationIP: string | null;
    destinationPort: string | null;
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
  const height = mini ? 24 : 132;
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
  return <div className="side-bottom traffic-sidebar">
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
      <h2>流量统计</h2>
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

export function ConnectionMonitor({ telemetry, running }: { telemetry: Telemetry; running: boolean }) {
  const { snapshot, message } = telemetry;
  return <section className="panel connection-monitor">
    <div className="panel-head">
      <h2>活跃连接</h2>
      {snapshot && <span className="muted">{snapshot.connections.length} 条</span>}
    </div>
    {snapshot?.connections.length ? (
      <div className="connection-table">
        <table>
          <thead><tr><th scope="col">目标</th><th scope="col">来源</th><th scope="col">规则 / 出站</th><th scope="col">上传</th><th scope="col">下载</th></tr></thead>
          <tbody>
            {snapshot.connections.map(({ id, metadata, chains, rule, upload, download }) => {
              const destination = endpoint(metadata.host || metadata.destinationIP, metadata.destinationPort);
              const source = endpoint(metadata.sourceIP, metadata.sourcePort);
              return <tr key={id}>
                <td><strong title={destination}>{destination}</strong><small>{metadata.network.toUpperCase()} · {metadata.type}</small></td>
                <td title={source}>{source}</td>
                <td><strong title={rule}>{rule === "final" ? "默认路由" : rule}</strong><small>{chains?.slice().reverse().join(" → ") || "—"}</small></td>
                <td>{formatBytes(upload)}</td>
                <td>{formatBytes(download)}</td>
              </tr>;
            })}
          </tbody>
        </table>
      </div>
    ) : <p className="empty">{snapshot ? "当前没有活跃连接" : running ? message : "启动代理后显示活跃连接"}</p>}
  </section>;
}
