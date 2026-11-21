import { invoke } from "@tauri-apps/api/core";
import { useState } from "react";

type Measurement = { bytes: number; milliseconds: number; megabits_per_second: number };

export function DownloadCheck({ port, disabled }: { port?: number; disabled: boolean }) {
  const [pending, setPending] = useState(false);
  const [sample, setSample] = useState<Measurement>();
  const [error, setError] = useState("");

  async function measure() {
    if (!port || disabled || pending) return;
    setPending(true);
    setSample(undefined);
    setError("");
    try {
      setSample(await invoke<Measurement>("measure_download", { port }));
    } catch (failure) {
      setError(typeof failure === "string" ? failure : "下载测速失败");
    } finally {
      setPending(false);
    }
  }

  return <section className="panel" style={{ marginBottom: 16 }}>
    <div className="panel-head">
      <h2>当前路由下载速度</h2>
      <button type="button" className="mini-btn is-primary" disabled={!port || disabled || pending} onClick={() => void measure()}>
        {pending ? "正在测速…" : "开始测速"}
      </button>
    </div>
    {sample && <div role="status" style={{ marginBottom: 8 }}>
      <strong className="latency is-good" style={{ fontSize: 15 }}>
        {sample.megabits_per_second.toLocaleString("zh-CN", { maximumFractionDigits: 2 })} Mbps
      </strong>
      <span className="muted" style={{ marginLeft: 10 }}>
        {(sample.bytes / (1024 * 1024)).toFixed(2)} MiB · {(sample.milliseconds / 1000).toFixed(2)} 秒
      </span>
    </div>}
    {error && <p className="error" role="status">{error}</p>}
    <p className="rule-hint">{port ? "通过 Cloudflare 下载单次样本（上限 8 MiB）。" : "连接代理后可测试下载吞吐。"}</p>
  </section>;
}
