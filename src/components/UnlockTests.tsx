import { invoke } from "@tauri-apps/api/core";
import { useRef, useState } from "react";
import { Loader2 } from "lucide-react";

const services = [
  "ChatGPT Web",
  "ChatGPT iOS",
  "Claude",
  "Gemini",
  "Netflix",
  "Disney+",
  "YouTube Premium",
  "Prime Video",
  "Spotify",
  "TikTok",
  "哔哩哔哩大陆",
  "哔哩哔哩港澳台",
  "Bahamut Anime",
] as const;

type UnlockResult = {
  service: string;
  status: "available" | "originals" | "blocked" | "error";
  region: string | null;
  detail: string;
  milliseconds: number;
};

const statusLabel: Record<UnlockResult["status"], { text: string; cls: string }> = {
  available: { text: "已解锁", cls: "is-good" },
  originals: { text: "仅自制剧", cls: "is-warn" },
  blocked: { text: "未解锁", cls: "is-bad" },
  error: { text: "检测异常", cls: "" },
};

export function UnlockTests({ port, disabled }: { port?: number; disabled: boolean }) {
  const [results, setResults] = useState<Record<string, UnlockResult>>({});
  const [pending, setPending] = useState<Record<string, boolean>>({});
  const [runningAll, setRunningAll] = useState(false);
  const cancelAll = useRef(false);

  async function testOne(serviceName: string) {
    if (!port || disabled) return;
    setPending(prev => ({ ...prev, [serviceName]: true }));
    try {
      const result = await invoke<UnlockResult>("check_unlock_service", { service: serviceName, port });
      setResults(prev => ({ ...prev, [serviceName]: result }));
    } catch (error) {
      setResults(prev => ({
        ...prev,
        [serviceName]: {
          service: serviceName,
          status: "error",
          region: null,
          detail: typeof error === "string" ? error : "检测失败",
          milliseconds: 0,
        },
      }));
    } finally {
      setPending(prev => ({ ...prev, [serviceName]: false }));
    }
  }

  async function testAll() {
    if (!port || disabled) return;
    if (runningAll) {
      cancelAll.current = true;
      return;
    }
    cancelAll.current = false;
    setRunningAll(true);
    let cursor = 0;
    async function worker() {
      while (cursor < services.length && !cancelAll.current) {
        const name = services[cursor++];
        await testOne(name);
      }
    }
    try {
      await Promise.all(Array.from({ length: 3 }, worker));
    } finally {
      setRunningAll(false);
    }
  }

  return (
    <section className="panel" style={{ marginTop: 16 }}>
      <div className="panel-head">
        <h2>流媒体与 AI 服务解锁检测</h2>
        <button
          type="button"
          className="mini-btn is-primary"
          disabled={!port || disabled}
          onClick={() => void testAll()}
        >
          {runningAll && <Loader2 size={13} className="spin" />}
          {runningAll ? "停止检测" : "检测全部"}
        </button>
      </div>
      <p className="rule-hint" style={{ marginBottom: 14 }}>
        {port ? "通过当前本地代理出口检测。" : "连接代理后可检测服务解锁状态。"}
      </p>
      <div className="unlock-grid">
        {services.map(serviceName => {
          const res = results[serviceName];
          const busy = !!pending[serviceName];
          const badge = res ? statusLabel[res.status] : undefined;
          return (
            <section className="test-card" key={serviceName}>
              <div className="test-card-head">
                <strong>{serviceName}</strong>
                <button
                  type="button"
                  className="mini-btn"
                  disabled={!port || disabled || busy}
                  onClick={() => void testOne(serviceName)}
                >
                  {busy && <Loader2 size={12} className="spin" />}
                  {busy ? "检测中" : "检测"}
                </button>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                <span className={`tag ${busy ? "is-busy" : badge?.cls ?? ""}`}>
                  {busy ? "正在请求…" : badge?.text ?? "未检测"}
                </span>
                {res?.region && <span className="tag is-accent">{res.region}</span>}
              </div>
              <footer>
                <span>{res?.detail ?? "—"}</span>
                <span>{res?.milliseconds ? `${res.milliseconds} ms` : ""}</span>
              </footer>
            </section>
          );
        })}
      </div>
    </section>
  );
}
