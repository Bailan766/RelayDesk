import { invoke } from "@tauri-apps/api/core";
import { useState } from "react";

const websites = [
  ["apple", "Apple"],
  ["github", "GitHub"],
  ["google", "Google"],
  ["youtube", "YouTube"],
] as const;

type Site = (typeof websites)[number][0];
type Result = { status: number; milliseconds: number };

export function WebsiteChecks({ port, disabled }: { port?: number; disabled: boolean }) {
  const [pending, setPending] = useState<Partial<Record<Site, boolean>>>({});
  const [results, setResults] = useState<Partial<Record<Site, { text: string; ok: boolean }>>>({});
  const [testingAll, setTestingAll] = useState(false);

  async function test(site: Site) {
    if (!port || disabled || pending[site]) return;
    setPending(previous => ({ ...previous, [site]: true }));
    try {
      const { status, milliseconds } = await invoke<Result>("check_website", { site, port });
      setResults(previous => ({ ...previous, [site]: { text: `HTTP ${status} · ${milliseconds} ms`, ok: status < 500 } }));
    } catch (error) {
      setResults(previous => ({ ...previous, [site]: { text: typeof error === "string" ? error : "请求失败", ok: false } }));
    } finally {
      setPending(previous => ({ ...previous, [site]: false }));
    }
  }

  async function testAll() {
    if (!port || disabled || testingAll) return;
    setTestingAll(true);
    try {
      await Promise.all(websites.map(([site]) => test(site)));
    } finally {
      setTestingAll(false);
    }
  }

  return <section className="panel">
    <div className="panel-head">
      <h2>网站连通性</h2>
      <button type="button" className="mini-btn" disabled={!port || disabled || testingAll} onClick={() => void testAll()}>
        {testingAll ? "测试中…" : "测试全部"}
      </button>
    </div>
    <div className="site-grid">
      {websites.map(([id, title]) => {
        const res = results[id];
        return <div className="site-card" key={id}>
          <strong>{title}</strong>
          <button type="button" className="link" aria-label={`测试 ${title}`} disabled={!port || disabled || pending[id]}
            onClick={() => void test(id)}>{pending[id] ? "请求中…" : "测试"}</button>
          <span role="status" className={`latency ${res ? (res.ok ? "is-good" : "is-bad") : ""}`}>
            {res?.text ?? "未测试"}
          </span>
        </div>;
      })}
    </div>
    {!port && <p className="rule-hint" style={{ marginTop: 10 }}>连接代理后可测试常用站点连通性。</p>}
  </section>;
}
