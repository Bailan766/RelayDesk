import { useState } from "react";
import { connectionSupport } from "./config";
import { formatBytes } from "./telemetry";
import { subscriptionHost, type Subscription, type SubscriptionRequest } from "./workspace";

export function SubscriptionRequestFields({ value, disabled, onChange }: {
  value: SubscriptionRequest;
  disabled?: boolean;
  onChange: (value: SubscriptionRequest) => void;
}) {
  return <div className="subscription-request">
    <label>订阅请求线路
      <select value={value.route} disabled={disabled}
        onChange={event => onChange({ ...value, route: event.target.value as SubscriptionRequest["route"] })}>
        <option value="automatic">自动</option>
        <option value="direct">绕过 HTTP 代理</option>
        <option value="relaydesk">通过当前 RelayDesk 入口</option>
      </select>
    </label>
    <label>客户端标识（User-Agent）
      <input value={value.userAgent} disabled={disabled}
        placeholder="留空使用默认值" maxLength={256} pattern="[ -~]{0,256}"
        onChange={event => onChange({ ...value, userAgent: event.target.value })} />
    </label>
    {value.route === "relaydesk" && <small>需要先连接 RelayDesk，请求会应用当前分流规则。</small>}
    {value.route === "direct" && <small>TUN 开启时，系统仍会按 TUN 路由发送请求。</small>}
  </div>;
}

export function SubscriptionCard({ profile, pending, error, refreshable, onRefresh, onRename, onConfigure, onRemove, onBrowse }: {
  profile: Subscription;
  pending: boolean;
  error?: string;
  refreshable: boolean;
  onRefresh: () => void;
  onRename: (name: string) => void;
  onConfigure: (request: SubscriptionRequest) => Promise<void>;
  onRemove: () => void;
  onBrowse: () => void;
}) {
  const [name, setName] = useState<string>();
  const [draft, setDraft] = useState<SubscriptionRequest>();
  const [saving, setSaving] = useState(false);
  const [requestError, setRequestError] = useState("");
  const [confirmRemove, setConfirmRemove] = useState(false);
  const supported = profile.parsed.nodes.filter(node => !connectionSupport(node)).length;
  const usage = profile.usage;
  const used = usage?.upload != null && usage.download != null ? usage.upload + usage.download : null;
  const quota = usage?.total && used != null ? Math.min(100, 100 * used / usage.total) : undefined;
  const expires = usage?.expire ? new Date(usage.expire * 1000) : undefined;
  const expiry = expires && Number.isFinite(expires.getTime()) ? expires.toLocaleDateString() : undefined;
  const expired = expires && expires.getTime() <= Date.now();

  async function saveRequest() {
    if (!draft) return;
    setSaving(true);
    setRequestError("");
    try {
      await onConfigure({ ...draft, userAgent: draft.userAgent.trim() });
      setDraft(undefined);
    } catch {
      setRequestError("请求设置保存失败");
    } finally {
      setSaving(false);
    }
  }

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
    {draft ? (
      <form className="subscription-request-form" onSubmit={event => {
        event.preventDefault();
        void saveRequest();
      }}>
        <SubscriptionRequestFields value={draft} disabled={saving} onChange={setDraft} />
        {requestError && <p className="error" role="status">{requestError}</p>}
        <div className="subscription-actions">
          <button className="link" type="submit" disabled={saving}>保存请求设置</button>
          <button className="link" type="button" disabled={saving} onClick={() => setDraft(undefined)}>取消</button>
        </div>
      </form>
    ) : name !== undefined ? (
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
        {profile.source && <button className="link" disabled={!refreshable} onClick={() => {
          setRequestError("");
          setDraft(profile.request);
        }}>请求设置</button>}
        <button className="link" onClick={() => setName(profile.name)}>重命名</button>
        {confirmRemove ? <>
          <button className="link error" onClick={onRemove}>确认移除</button>
          <button className="link" onClick={() => setConfirmRemove(false)}>保留</button>
        </> : <button className="link" onClick={() => setConfirmRemove(true)}>移除</button>}
      </div>
    )}
  </article>;
}
