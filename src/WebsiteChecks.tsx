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

export function WebsiteChecks({ port }: { port?: number }) {
  const [pending, setPending] = useState<Partial<Record<Site, boolean>>>({});
  const [results, setResults] = useState<Partial<Record<Site, string>>>({});

  async function test(site: Site) {
    if (!port || pending[site]) return;
    setPending(previous => ({ ...previous, [site]: true }));
    try {
      const { status, milliseconds } = await invoke<Result>("check_website", { site, port });
      setResults(previous => ({ ...previous, [site]: `HTTP ${status} · ${milliseconds} ms` }));
    } catch (error) {
      setResults(previous => ({ ...previous, [site]: typeof error === "string" ? error : "请求失败" }));
    } finally {
      setPending(previous => ({ ...previous, [site]: false }));
    }
  }

  return <section className="panel">
    <div className="panel-head"><h2>网站连通性</h2></div>
    <div className="site-grid">
      {websites.map(([id, title]) => <div key={id}>
        <strong>{title}</strong>
        <button type="button" className="link" aria-label={`测试 ${title}`} disabled={!port || pending[id]}
          onClick={() => void test(id)}>{pending[id] ? "请求中…" : "测试"}</button>
        <span role="status">{results[id]}</span>
      </div>)}
    </div>
    <p className="rule-hint">{port ? "按当前路由请求，耗时计算至收到 HTTP 响应头。" : "连接后可以测试。"}</p>
  </section>;
}
