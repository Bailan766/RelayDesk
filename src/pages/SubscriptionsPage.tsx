import { isTauri } from "@tauri-apps/api/core";
import { RefreshCw, SlidersHorizontal } from "lucide-react";
import { SubscriptionCard } from "../SubscriptionCard";
import { parseRefreshHours, refreshOptions, type RefreshHours, type Subscription, type SubscriptionRequest } from "../workspace";

export function SubscriptionsPage({
  subscriptions,
  refreshStatus,
  workReady,
  busy,
  recovering,
  originalProfileId,
  refreshHours,
  mihomoOverrideEnabled,
  onRefreshAll,
  onChangeDefaultRefreshHours,
  onSelectOriginal,
  onRefreshOne,
  onConfigure,
  onBrowseNodes,
  onRename,
  onRemove,
  onOpenOverrideModal,
}: {
  subscriptions: Subscription[];
  refreshStatus: Record<string, { pending: boolean; error?: string } | undefined>;
  workReady: boolean;
  busy: boolean;
  recovering: boolean;
  originalProfileId?: string;
  refreshHours: number;
  mihomoOverrideEnabled: boolean;
  onRefreshAll: () => void;
  onChangeDefaultRefreshHours: (hours: RefreshHours) => void;
  onSelectOriginal: (profileId: string) => void;
  onRefreshOne: (profileId: string) => void;
  onConfigure: (profileId: string, request: SubscriptionRequest, refreshHours?: RefreshHours) => Promise<void>;
  onBrowseNodes: (profileId: string) => void;
  onRename: (profileId: string, name: string) => void;
  onRemove: (profile: Subscription) => void;
  onOpenOverrideModal: () => void;
}) {
  const hasMihomo = subscriptions.some(profile => !!profile.parsed.mihomo);

  return (
    <section className="panel">
      <div className="panel-head">
        <h2>订阅来源</h2>
        <div className="event-controls">
          {hasMihomo && (
            <button
              type="button"
              className={`mini-btn ${mihomoOverrideEnabled ? "is-primary" : ""}`}
              disabled={!workReady}
              onClick={onOpenOverrideModal}
              title="订阅刷新后持久化保留自定义 DNS 与 Mihomo 附加规则"
            >
              <SlidersHorizontal size={13} />
              {mihomoOverrideEnabled ? "Mihomo 覆写已启用" : "Mihomo 持久化覆写"}
            </button>
          )}
          {subscriptions.some(s => !!s.source) && (
            <button
              type="button"
              className="mini-btn"
              disabled={!isTauri() || Object.values(refreshStatus).some(s => s?.pending)}
              onClick={onRefreshAll}
            >
              <RefreshCw size={13} className={Object.values(refreshStatus).some(s => s?.pending) ? "spin" : undefined} /> 更新全部
            </button>
          )}
          <label className="refresh-setting">默认自动更新
            <select
              value={refreshHours}
              disabled={!workReady || !isTauri()}
              onChange={event => onChangeDefaultRefreshHours(parseRefreshHours(Number(event.target.value)) ?? 0)}
            >
              {refreshOptions.map(([hours, label]) => <option key={hours} value={hours}>{label}</option>)}
            </select>
          </label>
        </div>
      </div>
      {subscriptions.length ? (
        <div className="subscription-grid">
          {subscriptions.map(profile => (
            <SubscriptionCard
              key={profile.id}
              profile={profile}
              pending={refreshStatus[profile.id]?.pending ?? false}
              error={refreshStatus[profile.id]?.error}
              refreshable={isTauri()}
              originalSelected={originalProfileId === profile.id}
              canSelectOriginal={isTauri() && !busy && !recovering}
              onSelectOriginal={() => onSelectOriginal(profile.id)}
              onRefresh={() => onRefreshOne(profile.id)}
              onConfigure={(request, hours) => onConfigure(profile.id, request, hours)}
              onBrowse={() => onBrowseNodes(profile.id)}
              onRename={name => onRename(profile.id, name)}
              onRemove={() => onRemove(profile)}
            />
          ))}
        </div>
      ) : (
        <p className="empty">{workReady ? "尚未导入订阅，点击右上角「导入订阅」开始。" : "正在读取本地加密工作区…"}</p>
      )}
    </section>
  );
}
