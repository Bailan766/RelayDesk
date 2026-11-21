import { invoke, isTauri } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";

type Event = {
  sequence: number;
  timestamp: number;
  level: "info" | "warn" | "error";
  message: string;
};

const levelLabel = { info: "信息", warn: "警告", error: "错误" };

export function EventLog() {
  const [items, setItems] = useState<Event[]>([]);
  const [level, setLevel] = useState("all");
  const [error, setError] = useState("");
  const [clipboard, setClipboard] = useState("");
  const visible = items.filter(item => level === "all" || level === item.level).slice().reverse();

  useEffect(() => {
    if (!isTauri()) return;
    let mounted = true;
    let timer: number | undefined;
    async function refresh() {
      try {
        const events = await invoke<Event[]>("proxy_events");
        if (mounted) {
          setItems(events);
          setError("");
        }
      } catch (failure) {
        if (mounted) setError(typeof failure === "string" ? failure : "读取网络事件失败");
      } finally {
        if (mounted) timer = window.setTimeout(refresh, 1500);
      }
    }
    void refresh();
    return () => {
      mounted = false;
      window.clearTimeout(timer);
    };
  }, []);

  async function copy() {
    try {
      await navigator.clipboard.writeText(visible.map(item =>
        `${new Date(item.timestamp * 1000).toISOString()} [${levelLabel[item.level]}] ${item.message}`,
      ).join("\n"));
      setClipboard("已复制");
    } catch { setClipboard("复制失败"); }
  }

  return <section className="panel">
    <div className="panel-head">
      <h2>网络事件</h2>
      <div className="event-controls">
        <select aria-label="网络事件级别" value={level} onChange={event => { setLevel(event.target.value); setClipboard(""); }}>
          <option value="all">全部级别</option>
          <option value="info">信息</option>
          <option value="warn">警告</option>
          <option value="error">错误</option>
        </select>
        <button className="link" disabled={!visible.length} onClick={() => void copy()}>复制</button>
        <span className="muted" role="status">{clipboard}</span>
      </div>
    </div>
    {error && <p className="rule-hint" role="status">{error}</p>}
    {visible.length ? <ul className="event-list">
      {visible.map(item => <li key={item.sequence} className={`event event-${item.level}`}>
        <time dateTime={new Date(item.timestamp * 1000).toISOString()}>{new Date(item.timestamp * 1000).toLocaleTimeString()}</time>
        <span>{levelLabel[item.level]}</span>
        <span>{item.message}</span>
      </li>)}
    </ul> : <p className="empty">{isTauri() ? "没有符合条件的网络事件" : "请在桌面端查看网络事件"}</p>}
    <p className="rule-hint">本次应用运行期间保留最近 160 条事件。</p>
  </section>;
}
