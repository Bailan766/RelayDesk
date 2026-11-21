import { invoke, isTauri } from "@tauri-apps/api/core";
import { useEffect, useMemo, useState } from "react";
import { FolderOpen, Pause, Play, Search, Trash2 } from "lucide-react";

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
  const [query, setQuery] = useState("");
  const [paused, setPaused] = useState(false);
  const [error, setError] = useState("");
  const [clipboard, setClipboard] = useState("");

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return items
      .filter(item => (level === "all" || level === item.level) && (!q || item.message.toLowerCase().includes(q)))
      .slice()
      .reverse();
  }, [items, level, query]);

  useEffect(() => {
    if (!isTauri() || paused) return;
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
        if (mounted) timer = window.setTimeout(refresh, 1200);
      }
    }
    void refresh();
    return () => {
      mounted = false;
      window.clearTimeout(timer);
    };
  }, [paused]);

  async function copy() {
    try {
      await navigator.clipboard.writeText(visible.map(item =>
        `${new Date(item.timestamp * 1000).toISOString()} [${levelLabel[item.level]}] ${item.message}`,
      ).join("\n"));
      setClipboard("已复制");
    } catch { setClipboard("复制失败"); }
  }

  async function clear() {
    if (!isTauri()) return;
    try {
      await invoke("clear_proxy_events");
      setItems([]);
      setClipboard("");
    } catch (failure) {
      setError(typeof failure === "string" ? failure : "清空日志失败");
    }
  }

  return <section className="panel">
    <div className="panel-head">
      <h2>运行日志与网络事件</h2>
      <div className="event-controls">
        <label className="search" style={{ maxWidth: 210 }}>
          <Search size={14} />
          <input placeholder="筛选域名、错误或关键词" value={query} onChange={e => setQuery(e.target.value)} />
        </label>
        <select aria-label="网络事件级别" value={level} onChange={event => { setLevel(event.target.value); setClipboard(""); }}>
          <option value="all">全部级别</option>
          <option value="info">信息</option>
          <option value="warn">警告</option>
          <option value="error">错误</option>
        </select>
        <button className="mini-btn" type="button" onClick={() => setPaused(value => !value)}>
          {paused ? <><Play size={13} /> 继续</> : <><Pause size={13} /> 暂停</>}
        </button>
        <button className="mini-btn" type="button" disabled={!visible.length} onClick={() => void copy()}>复制</button>
        <button className="mini-btn" type="button" disabled={!isTauri()} onClick={() => void invoke("open_log_folder").catch(() => setError("无法打开日志目录"))}>
          <FolderOpen size={13} /> 日志目录
        </button>
        <button className="mini-btn" type="button" disabled={!items.length || !isTauri()} onClick={() => void clear()}>
          <Trash2 size={13} /> 清空
        </button>
        {clipboard && <span className="muted" role="status">{clipboard}</span>}
      </div>
    </div>
    {error && <p className="notice is-warn" role="status">{error}</p>}
    {visible.length ? <ul className="event-list">
      {visible.map(item => <li key={item.sequence} className={`event event-${item.level}`}>
        <time dateTime={new Date(item.timestamp * 1000).toISOString()}>{new Date(item.timestamp * 1000).toLocaleTimeString()}</time>
        <span>{levelLabel[item.level]}</span>
        <span>{item.message}</span>
      </li>)}
    </ul> : <p className="empty">{isTauri() ? "没有符合条件的日志或网络事件" : "请在桌面端查看运行日志"}</p>}
    <p className="rule-hint" style={{ marginTop: 10 }}>保留最近 160 条实时事件，并持久化脱敏日志至本机 %LOCALAPPDATA%\RelayDesk\logs\relaydesk.log。</p>
  </section>;
}
