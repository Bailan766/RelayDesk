import { useEffect, useState } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { Loader2, Search, Trash2 } from "lucide-react";
import { WebsiteChecks } from "../WebsiteChecks";
import { DownloadCheck } from "../DownloadCheck";
import { UnlockTests } from "../components/UnlockTests";
import { EventLog } from "../EventLog";

type DnsProbeBranch = {
  ok: boolean;
  answers: string[];
  isFakeIp: boolean;
  latencyMs: number;
  error?: string | null;
};

type DnsProbeReport = {
  domain: string;
  qtype: string;
  topologyHint: string;
  localOs: DnsProbeBranch;
  coreInternal?: DnsProbeBranch | null;
  remoteDoh: DnsProbeBranch;
};

type DnsLogEntry = {
  id: number;
  timestamp: number;
  domain: string;
  qtype: string;
  source: string;
  server: string;
  answer: string;
  raw: string;
};

function sourceBadge(source: string): { label: string; cls: string } {
  switch (source) {
    case "fake-ip":
      return { label: "Fake-IP", cls: "tag is-accent" };
    case "remote-doh":
      return { label: "远程 DoH", cls: "tag is-good" };
    case "local-bootstrap":
      return { label: "本机 / 直连", cls: "tag" };
    case "cache":
      return { label: "内核缓存", cls: "tag is-warn" };
    default:
      return { label: "其他解析", cls: "tag" };
  }
}

function DnsMonitorPanel({ running, recovering }: { running: boolean; recovering: boolean }) {
  const [domainInput, setDomainInput] = useState("api.openai.com");
  const [qtype, setQtype] = useState<"A" | "AAAA">("A");
  const [probing, setProbing] = useState(false);
  const [probeError, setProbeError] = useState("");
  const [report, setReport] = useState<DnsProbeReport>();

  const [capturing, setCapturing] = useState(false);
  const [entries, setEntries] = useState<DnsLogEntry[]>([]);
  const [filterText, setFilterText] = useState("");

  useEffect(() => {
    if (!isTauri() || !capturing || !running || recovering) {
      if (isTauri()) void invoke("set_dns_capture", { enabled: false }).catch(() => {});
      return;
    }
    let cancelled = false;
    void invoke("set_dns_capture", { enabled: true }).catch(() => {});
    async function refresh() {
      try {
        const list = await invoke<DnsLogEntry[]>("proxy_dns_queries");
        if (!cancelled) setEntries([...list].reverse());
      } catch { /* ignore transient poll failure */ }
    }
    void refresh();
    const timer = window.setInterval(() => void refresh(), 900);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      void invoke("set_dns_capture", { enabled: false }).catch(() => {});
    };
  }, [capturing, recovering, running]);

  async function runProbe() {
    if (!isTauri() || probing) return;
    setProbing(true);
    setProbeError("");
    try {
      const result = await invoke<DnsProbeReport>("probe_dns_resolution", {
        domain: domainInput,
        qtype,
      });
      setReport(result);
    } catch (e) {
      setProbeError(typeof e === "string" ? e : "DNS 对比查询失败");
    } finally {
      setProbing(false);
    }
  }

  const visibleEntries = entries.filter(item => {
    const q = filterText.trim().toLowerCase();
    if (!q) return true;
    return `${item.domain} ${item.server} ${item.answer} ${item.raw}`.toLowerCase().includes(q);
  });

  return (
    <div style={{ display: "grid", gap: 14 }}>
      <section className="panel">
        <div className="panel-head">
          <h2>域名解析对照探测</h2>
          <span className="muted" style={{ fontSize: 12 }}>区分本机解析、内核解析 / Fake-IP 与远程 DoH 真实结果</span>
        </div>
        <form
          className="rule-form"
          onSubmit={e => {
            e.preventDefault();
            void runProbe();
          }}
        >
          <input
            aria-label="待查询域名"
            value={domainInput}
            onChange={e => setDomainInput(e.target.value)}
            placeholder="输入域名，例如 api.openai.com / www.baidu.com"
          />
          <select aria-label="记录类型" value={qtype} onChange={e => setQtype(e.target.value as "A" | "AAAA")}>
            <option value="A">A (IPv4)</option>
            <option value="AAAA">AAAA (IPv6)</option>
          </select>
          <button type="submit" className="mini-btn is-primary" disabled={!isTauri() || probing || !domainInput.trim()}>
            {probing && <Loader2 size={12} className="spin" />}
            {probing ? "探测中…" : "查询对比"}
          </button>
        </form>
        {probeError && <p className="error" role="alert">{probeError}</p>}
        {report && (
          <div style={{ display: "grid", gap: 10 }}>
            <div className="notice" role="status">{report.topologyHint}</div>
            <div className="stats" style={{ marginTop: 0 }}>
              <div className="stat-card">
                <div className="stat-card-head">
                  <span>本机系统解析</span>
                  <span className={report.localOs.isFakeIp ? "tag is-accent" : "tag"}>
                    {report.localOs.isFakeIp ? "Fake-IP" : `${report.localOs.latencyMs} ms`}
                  </span>
                </div>
                <strong style={{ fontSize: 13, wordBreak: "break-all" }}>
                  {report.localOs.ok ? report.localOs.answers.join(", ") : report.localOs.error || "无记录"}
                </strong>
                <small>{report.localOs.isFakeIp ? `已命中虚假 IP 段 · ${report.localOs.latencyMs} ms` : "操作系统 DNS 返回地址"}</small>
              </div>

              {report.coreInternal && (
                <div className="stat-card">
                  <div className="stat-card-head">
                    <span>Mihomo 内核 DNS</span>
                    <span className={report.coreInternal.isFakeIp ? "tag is-accent" : "tag"}>
                      {report.coreInternal.isFakeIp ? "Fake-IP" : `${report.coreInternal.latencyMs} ms`}
                    </span>
                  </div>
                  <strong style={{ fontSize: 13, wordBreak: "break-all" }}>
                    {report.coreInternal.ok ? report.coreInternal.answers.join(", ") : report.coreInternal.error || "无记录"}
                  </strong>
                  <small>内核策略规则上游实际解析结果</small>
                </div>
              )}

              <div className="stat-card">
                <div className="stat-card-head">
                  <span>远程 DoH 对照 (1.1.1.1)</span>
                  <span className="tag is-good">{report.remoteDoh.latencyMs} ms</span>
                </div>
                <strong style={{ fontSize: 13, wordBreak: "break-all" }}>
                  {report.remoteDoh.ok ? report.remoteDoh.answers.join(", ") : report.remoteDoh.error || "无记录"}
                </strong>
                <small>{running ? "经当前代理通道查询真实海外解析" : "直连 1.1.1.1 DoH 结果"}</small>
              </div>
            </div>
          </div>
        )}
      </section>

      <section className="panel">
        <div className="panel-head">
          <h2>实时 DNS 查询观测 ({visibleEntries.length})</h2>
          <div className="event-controls">
            <label className="search" style={{ maxWidth: 210 }}>
              <Search size={14} />
              <input placeholder="筛选域名 / 上游" value={filterText} onChange={e => setFilterText(e.target.value)} />
            </label>
            <button
              type="button"
              className={`mini-btn ${capturing ? "is-primary" : ""}`}
              disabled={!isTauri() || !running || recovering}
              onClick={() => setCapturing(prev => !prev)}
            >
              {capturing ? "暂停抓包" : "开始实时抓包"}
            </button>
            <button
              type="button"
              className="mini-btn"
              disabled={!isTauri() || !entries.length}
              onClick={() => {
                setEntries([]);
                void invoke("clear_dns_queries").catch(() => {});
              }}
            >
              <Trash2 size={12} /> 清空
            </button>
          </div>
        </div>
        <p className="rule-hint">
          开启实时抓包后按需订阅内核 Debug DNS 日志（关闭本面板即自动停止，不额外占用日常性能）。
        </p>
        {visibleEntries.length ? (
          <div className="connection-table">
            <table>
              <thead>
                <tr>
                  <th>时间</th>
                  <th>域名 / 日志摘要</th>
                  <th>类型</th>
                  <th>解析路径</th>
                  <th>上游 / 结果</th>
                </tr>
              </thead>
              <tbody>
                {visibleEntries.map(item => {
                  const badge = sourceBadge(item.source);
                  return (
                    <tr key={item.id}>
                      <td className="muted" style={{ whiteSpace: "nowrap" }}>
                        {new Date(item.timestamp * 1000).toLocaleTimeString()}
                      </td>
                      <td>
                        <div style={{ fontWeight: 600 }}>{item.domain || "—"}</div>
                        <small className="muted">{item.raw}</small>
                      </td>
                      <td>{item.qtype || "—"}</td>
                      <td><span className={badge.cls}>{badge.label}</span></td>
                      <td style={{ wordBreak: "break-all" }}>
                        {item.answer || item.server || "—"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="empty">
            {!running
              ? "连接代理后可开始实时抓包观测 DNS 查询。"
              : capturing
                ? "正在监听内核 DNS 日志，请访问网页或执行网络请求…"
                : "点击右上角「开始实时抓包」观测实时 DNS 分流。"}
          </p>
        )}
      </section>
    </div>
  );
}

export function DiagnosticsPage({
  diagTab,
  setDiagTab,
  diagnosticsVersion,
  running,
  recovering,
  port,
  busy,
  localTcp,
  localTcpBusy,
  onTestLocalTcp,
}: {
  diagTab: "checks" | "dns" | "unlock" | "logs";
  setDiagTab: (tab: "checks" | "dns" | "unlock" | "logs") => void;
  diagnosticsVersion: number;
  running: boolean;
  recovering: boolean;
  port?: number;
  busy: boolean;
  localTcp: string;
  localTcpBusy: boolean;
  onTestLocalTcp: () => void;
}) {
  return (
    <>
      <div className="toolbar" style={{ marginBottom: 14 }}>
        <div className="mode-switch" role="tablist" aria-label="诊断分类">
          <button type="button" aria-pressed={diagTab === "checks"} onClick={() => setDiagTab("checks")}>
            测速与连通
          </button>
          <button type="button" aria-pressed={diagTab === "dns"} onClick={() => setDiagTab("dns")}>
            DNS 观测
          </button>
          <button type="button" aria-pressed={diagTab === "unlock"} onClick={() => setDiagTab("unlock")}>
            服务解锁
          </button>
          <button type="button" aria-pressed={diagTab === "logs"} onClick={() => setDiagTab("logs")}>
            运行日志
          </button>
        </div>
      </div>

      <div className="tab-view" key={diagTab}>
        {diagTab === "checks" && (
          <>
            <DownloadCheck key={diagnosticsVersion} port={running && !recovering ? port : undefined} disabled={busy} />
            <WebsiteChecks key={`site-${diagnosticsVersion}`} port={running && !recovering ? port : undefined} disabled={busy} />
            <section className="panel" style={{ marginTop: 16 }}>
              <div className="panel-head">
                <h2>本机直连诊断</h2>
                <button className="mini-btn" disabled={localTcpBusy || !isTauri()} onClick={onTestLocalTcp}>
                  {localTcpBusy && <Loader2 size={12} className="spin" />}
                  {localTcpBusy ? "测试中…" : "测试 TCP 443"}
                </button>
              </div>
              <div className="env-row">
                <span>Google TCP 443（含本机 DNS 解析）</span>
                <span className="tag">{localTcp}</span>
              </div>
              <p className="rule-hint">直接从本机发起连接，启用 TUN 时会经过虚拟网卡。</p>
            </section>
          </>
        )}

        {diagTab === "dns" && <DnsMonitorPanel running={running} recovering={recovering} />}

        {diagTab === "unlock" && (
          <UnlockTests port={running && !recovering ? port : undefined} disabled={busy} />
        )}

        {diagTab === "logs" && <EventLog />}
      </div>
    </>
  );
}
