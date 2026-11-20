import { useState } from "react";
import { connectionSupport } from "./config";
import { formatBytes } from "./telemetry";
import { subscriptionHost, type Subscription } from "./workspace";

export function SubscriptionCard({ profile, pending, error, refreshable, onRefresh, onRename, onRemove, onBrowse }: {
  profile: Subscription;
  pending: boolean;
  error?: string;
  refreshable: boolean;
  onRefresh: () => void;
  onRename: (name: string) => void;
  onRemove: () => void;
  onBrowse: () => void;
}) {
  const [name, setName] = useState<string>();
  const [confirmRemove, setConfirmRemove] = useState(false);
  const supported = profile.parsed.nodes.filter(node => !connectionSupport(node)).length;
  const usage = profile.usage;
  const used = usage?.upload != null && usage.download != null ? usage.upload + usage.download : null;
  const quota = usage?.total && used != null ? Math.min(100, 100 * used / usage.total) : undefined;
  const expires = usage?.expire ? new Date(usage.expire * 1000) : undefined;
  const expiry = expires && Number.isFinite(expires.getTime()) ? expires.toLocaleDateString() : undefined;
  const expired = expires && expires.getTime() <= Date.now();

  return <article className="subscription-card">
    <div className="panel-head">
      <h3>{profile.name}</h3>
      <button className="link" onClick={onBrowse}>查看节点</button>
    </div>
    <div className="subscription-meta">
      <span>{subscriptionHost(profile.source) || "本地导入"} · {profile.parsed.format}</span>
      <span>{profile.updatedAt ? new Date(profile.updatedAt).toLocaleString() : "原有订阅"}</span>
    </div>
    <div className="subscription-meta">
      <span>{profile.parsed.nodes.length} 个节点 · {supported} 个可连接{profile.parsed.warnings.length ? ` · ${profile.parsed.warnings.length} 项跳过` : ""}</span>
      {expiry && <span className={expired ? "error" : undefined}>{expired ? "已过期" : "到期"} {expiry}</span>}
    </div>
    {!!profile.parsed.policySections?.length && <p className="rule-hint">原配置另含{profile.parsed.policySections.join("、")}。当前导入只提取独立节点。</p>}
    {quota !== undefined && <div className="subscription-quota">
      <progress max={100} value={quota} aria-label="已用流量比例" />
      <small>已用 {formatBytes(used)} / {formatBytes(usage?.total)}</small>
    </div>}
    {error && <p className="error" role="status">更新失败，已保留原订阅。{error}</p>}
    {name !== undefined ? (
      <form className="subscription-actions" onSubmit={event => {
        event.preventDefault();
        if (!name.trim()) return;
        onRename(name.trim());
        setName(undefined);
      }}>
        <input aria-label="订阅名称" value={name} onChange={event => setName(event.target.value)} autoFocus maxLength={80} required />
        <button className="link" type="submit">保存名称</button>
        <button className="link" type="button" onClick={() => setName(undefined)}>取消</button>
      </form>
    ) : (
      <div className="subscription-actions">
        {profile.source && <button className="link" disabled={pending || !refreshable} onClick={onRefresh}>{pending ? "更新中…" : "更新"}</button>}
        <button className="link" onClick={() => setName(profile.name)}>重命名</button>
        {confirmRemove ? <>
          <button className="link error" onClick={onRemove}>确认移除</button>
          <button className="link" onClick={() => setConfirmRemove(false)}>保留</button>
        </> : <button className="link" onClick={() => setConfirmRemove(true)}>移除</button>}
      </div>
    )}
  </article>;
}
