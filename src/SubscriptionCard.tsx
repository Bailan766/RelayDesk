import { useState } from "react";
import { connectionSupport } from "./config";
import { formatBytes } from "./telemetry";
import {
  parseRefreshHours, refreshOptions, subscriptionHost,
  type RefreshHours, type Subscription, type SubscriptionRequest,
} from "./workspace";

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
    <label className="checkbox-inline" style={{ display: "inline-flex", flexDirection: "row", alignItems: "center", gap: 8 }}>
      <input type="checkbox" checked={!!value.allowHttp} disabled={disabled}
        onChange={event => onChange({ ...value, allowHttp: event.target.checked })} />
      <span>允许非本地的明文 HTTP 订阅地址</span>
    </label>
    {value.route === "relaydesk" && <small>需要先连接 RelayDesk，请求会应用当前分流规则。</small>}
    {value.route === "direct" && <small>TUN 开启时，系统仍会按 TUN 路由发送请求。</small>}
  </div>;
}

export function SubscriptionCard({ profile, pending, error, refreshable, originalSelected, canSelectOriginal, onRefresh, onRename, onConfigure, onRemove, onBrowse, onSelectOriginal }: {
  profile: Subscription;
  pending: boolean;
  error?: string;
  refreshable: boolean;
  originalSelected: boolean;
  canSelectOriginal: boolean;
  onRefresh: () => void;
  onRename: (name: string) => void;
  onConfigure: (request: SubscriptionRequest, refreshHours?: RefreshHours) => Promise<void>;
  onRemove: () => void;
  onBrowse: () => void;
  onSelectOriginal: () => void;
}) {
  const [name, setName] = useState<string>();
  const [draft, setDraft] = useState<{ request: SubscriptionRequest; refreshHours?: RefreshHours }>();
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
      await onConfigure({ ...draft.request, userAgent: draft.request.userAgent.trim() }, draft.refreshHours);
      setDraft(undefined);
    } catch {
      setRequestError("订阅设置保存失败");
    } finally {
      setSaving(false);
    }
  }

  return <article className={`subscription-card ${originalSelected ? "is-original" : ""}`}>
    <div className="panel-head">
      <h3>{profile.name}</h3>
      {!!profile.parsed.nodes.length && <button className="link" onClick={onBrowse}>查看节点 ({profile.parsed.nodes.length})</button>}
    </div>
    <div className="subscription-meta">
      <span>{subscriptionHost(profile.source) || "本地导入"} · {profile.parsed.format}</span>
      <span>{profile.updatedAt ? new Date(profile.updatedAt).toLocaleString() : "原有订阅"}</span>
    </div>
    <div className="subscription-meta">
      {!!profile.parsed.nodes.length && <span>可连接 {supported} / {profile.parsed.nodes.length}</span>}
      {expiry && <span className={expired ? "error" : undefined}>{expired ? "已过期" : "到期"} {expiry}</span>}
      {profile.source && profile.refreshHours !== undefined &&
        <span>自动更新 · {refreshOptions.find(([hours]) => hours === profile.refreshHours)?.[1]}</span>}
    </div>
    {profile.parsed.mihomo && <p className="rule-hint">
      <span className={`badge ${originalSelected ? "is-accent" : ""}`}>
        {originalSelected ? "当前选用 Mihomo 原配置" : "支持 Mihomo 原配置"}
      </span>
      {!!profile.parsed.policySections?.length && ` · ${profile.parsed.policySections.join("、")}`}
    </p>}
    {!profile.parsed.mihomo && !!profile.parsed.policySections?.length &&
      <p className="rule-hint">原配置另含{profile.parsed.policySections.join("、")}。节点模式提取独立节点。</p>}
    {quota !== undefined && <div className="subscription-quota">
      <progress max={100} value={quota} aria-label="已用流量比例" />
      <small>已用 {formatBytes(used)} / {formatBytes(usage?.total)} ({quota.toFixed(1)}%)</small>
    </div>}
    {error && <p className="error" role="status">更新失败，已保留原订阅。{error}</p>}
    {draft ? (
      <form className="subscription-request-form" onSubmit={event => {
        event.preventDefault();
        void saveRequest();
      }}>
        <SubscriptionRequestFields value={draft.request} disabled={saving}
          onChange={request => setDraft({ ...draft, request })} />
        <label className="refresh-setting">自动更新频率
          <select value={draft.refreshHours ?? ""} disabled={saving}
            onChange={event => setDraft({
              ...draft, refreshHours: event.target.value === "" ? undefined : parseRefreshHours(Number(event.target.value)),
            })}>
            <option value="">跟随默认设置</option>
            {refreshOptions.map(([hours, label]) => <option key={hours} value={hours}>{label}</option>)}
          </select>
        </label>
        {requestError && <p className="error" role="status">{requestError}</p>}
        <div className="subscription-actions">
          <button className="mini-btn is-primary" type="submit" disabled={saving}>保存设置</button>
          <button className="mini-btn" type="button" disabled={saving} onClick={() => setDraft(undefined)}>取消</button>
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
        <button className="mini-btn is-primary" type="submit">保存</button>
        <button className="mini-btn" type="button" onClick={() => setName(undefined)}>取消</button>
      </form>
    ) : (
      <div className="subscription-actions">
        {profile.parsed.mihomo && <button className="mini-btn" disabled={!canSelectOriginal} onClick={onSelectOriginal}>
          {originalSelected ? "前往概览" : "选用原配置"}
        </button>}
        {profile.source && <button className="mini-btn" disabled={pending || !refreshable} onClick={onRefresh}>{pending ? "更新中…" : "更新"}</button>}
        {profile.source && <button className="link" disabled={!refreshable} onClick={() => {
          setRequestError("");
          setDraft({ request: profile.request, refreshHours: profile.refreshHours });
        }}>设置</button>}
        <button className="link" onClick={() => setName(profile.name)}>重命名</button>
        {confirmRemove ? <>
          <button className="link error" onClick={onRemove}>确认移除</button>
          <button className="link" onClick={() => setConfirmRemove(false)}>保留</button>
        </> : <button className="link" onClick={() => setConfirmRemove(true)}>移除</button>}
      </div>
    )}
  </article>;
}
