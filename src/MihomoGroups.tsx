import { invoke } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";
import type { RoutingMode } from "./workspace";

type Group = { name: string; kind: string; selected: string; choices: string[]; manual: boolean };
const routeLabels = { rule: "规则", global: "全局", direct: "直连" };
const groupLabels: Record<string, string> = {
  Selector: "手动选择", URLTest: "自动测速", Fallback: "故障切换", LoadBalance: "负载均衡", Relay: "链式代理",
};

export function MihomoGroups({ mode, disabled, onMode, onChange }: {
  mode: RoutingMode;
  disabled: boolean;
  onMode: (mode: RoutingMode) => void;
  onChange: () => void;
}) {
  const [groups, setGroups] = useState<Group[]>();
  const [readError, setReadError] = useState("");
  const [switchError, setSwitchError] = useState("");
  const [pending, setPending] = useState<string>();

  useEffect(() => {
    if (disabled || pending) return;
    let cancelled = false;
    let timer: number;
    async function poll() {
      try {
        const next = await invoke<Group[]>("mihomo_groups");
        if (!cancelled) {
          setGroups(next);
          setReadError("");
        }
      } catch {
        if (!cancelled) setReadError("暂时无法获取策略组，正在重试。");
      } finally {
        if (!cancelled) timer = window.setTimeout(poll, 3000);
      }
    }
    void poll();
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [disabled, pending]);

  async function choose(group: Group, choice: string) {
    setPending(group.name);
    setSwitchError("");
    try {
      await invoke("switch_mihomo_group", { group: group.name, choice });
      setGroups(current => current?.map(item => item.name === group.name ? { ...item, selected: choice } : item));
      onChange();
    } catch (error) {
      setSwitchError(typeof error === "string" ? error : "策略组切换失败");
    } finally {
      setPending(undefined);
    }
  }

  const visible = groups?.filter(group => group.name !== "GLOBAL" || mode === "global");
  return <section className="panel mihomo-groups">
    <div className="panel-head">
      <h2>策略组</h2>
      <label>路由方式{" "}
        <select className="toolbar-select" value={mode} disabled={disabled || !!pending}
          onChange={event => onMode(event.target.value as RoutingMode)}>
          {Object.entries(routeLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select>
      </label>
    </div>
    {(switchError || readError) && <p className="error" role="status">{switchError || readError}</p>}
    {!visible?.length && <p className="muted">{visible ? "当前配置没有策略组。" : "正在读取策略组…"}</p>}
    {visible?.map(group => <div key={group.name} className="env-row mihomo-group">
      <div>
        <strong>{group.name}</strong>
        <small>{groupLabels[group.kind] ?? group.kind}</small>
      </div>
      {group.manual
        ? <select className="toolbar-select" aria-label={`选择 ${group.name} 的出站`}
          disabled={disabled || !!pending} value={group.selected} onChange={event => void choose(group, event.target.value)}>
          {!group.choices.includes(group.selected) && <option value={group.selected} disabled>{group.selected || "等待提供者"}</option>}
          {group.choices.map((choice, index) => <option key={`${index}:${choice}`} value={choice}>{choice}</option>)}
        </select>
        : <span title={group.selected}>{group.selected || "等待提供者"}</span>}
    </div>)}
  </section>;
}
