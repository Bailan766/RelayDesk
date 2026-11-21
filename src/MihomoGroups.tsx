import { invoke } from "@tauri-apps/api/core";
import { useEffect, useMemo, useState } from "react";
import { ChevronDown, ChevronRight, Gauge, Search } from "lucide-react";
import type { RoutingMode } from "./workspace";

type Group = { name: string; kind: string; selected: string; choices: string[]; manual: boolean };
const routeLabels = { rule: "规则", global: "全局", direct: "直连" };
const groupLabels: Record<string, string> = {
  Selector: "手动选择", URLTest: "自动测速", Fallback: "故障切换", LoadBalance: "负载均衡", Relay: "链式代理",
};

function delayClass(ms?: number) {
  if (ms == null) return "";
  if (ms < 180) return "is-good";
  if (ms < 400) return "is-warn";
  return "is-bad";
}

export function MihomoGroups({
  mode,
  disabled,
  probeUrl,
  onMode,
  onChange,
}: {
  mode: RoutingMode;
  disabled: boolean;
  probeUrl: string;
  onMode: (mode: RoutingMode) => void;
  onChange: (group: string, choice: string) => Promise<void>;
}) {
  const [groups, setGroups] = useState<Group[]>();
  const [readError, setReadError] = useState("");
  const [switchError, setSwitchError] = useState("");
  const [pending, setPending] = useState<string>();
  const [testingGroup, setTestingGroup] = useState<string>();
  const [delays, setDelays] = useState<Record<string, number | null>>({});
  const [query, setQuery] = useState("");
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});

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
      await onChange(group.name, choice);
    } catch (error) {
      setSwitchError(typeof error === "string" ? error : "策略组切换失败");
    } finally {
      setPending(undefined);
    }
  }

  async function testGroup(group: Group) {
    if (disabled || testingGroup) return;
    setTestingGroup(group.name);
    setSwitchError("");
    try {
      const result = await invoke<Record<string, number>>("probe_mihomo_group", {
        group: group.name,
        probeUrl,
        timeoutMs: 5000,
      });
      setDelays(prev => {
        const next = { ...prev };
        for (const choice of group.choices) {
          next[choice] = typeof result[choice] === "number" ? result[choice] : null;
        }
        return next;
      });
    } catch {
      const updates: Record<string, number | null> = {};
      await Promise.all(
        group.choices.slice(0, 24).map(async choice => {
          try {
            updates[choice] = await invoke<number>("probe_loaded_node", {
              tag: choice,
              probeUrl,
              timeoutMs: 4500,
            });
          } catch {
            updates[choice] = null;
          }
        }),
      );
      setDelays(prev => ({ ...prev, ...updates }));
    } finally {
      setTestingGroup(undefined);
    }
  }

  const visible = useMemo(() => {
    const list = groups?.filter(group => group.name !== "GLOBAL" || mode === "global") ?? [];
    const q = query.trim().toLowerCase();
    if (!q) return list;
    return list
      .map(group => {
        if (group.name.toLowerCase().includes(q)) return group;
        const choices = group.choices.filter(c => c.toLowerCase().includes(q));
        return choices.length ? { ...group, choices } : null;
      })
      .filter((item): item is Group => item !== null);
  }, [groups, mode, query]);

  return <section className="panel mihomo-groups">
    <div className="panel-head">
      <h2>Mihomo 策略组</h2>
      <div className="event-controls">
        <label className="search" style={{ maxWidth: 210 }}>
          <Search size={14} />
          <input placeholder="搜索策略组或节点" value={query} onChange={e => setQuery(e.target.value)} />
        </label>
        <div className="mode-switch" role="group" aria-label="Mihomo 路由方式">
          {Object.entries(routeLabels).map(([value, label]) => (
            <button
              key={value}
              type="button"
              aria-pressed={mode === value}
              disabled={disabled || !!pending}
              onClick={() => onMode(value as RoutingMode)}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
    </div>
    {(switchError || readError) && <p className="error" role="status">{switchError || readError}</p>}
    {!groups && <p className="muted">正在读取策略组…</p>}
    {groups && !visible.length && <p className="muted">{query ? "没有匹配的策略组或节点。" : "当前配置没有策略组。"}</p>}
    {visible.map(group => {
      const isCollapsed = collapsed[group.name] ?? false;
      return <div key={group.name} className="mihomo-group-card">
        <div className="mihomo-group-head">
          <div className="mihomo-group-title">
            <button
              type="button"
              className="icon-button"
              aria-label={isCollapsed ? `展开 ${group.name}` : `折叠 ${group.name}`}
              onClick={() => setCollapsed(prev => ({ ...prev, [group.name]: !isCollapsed }))}
            >
              {isCollapsed ? <ChevronRight size={16} /> : <ChevronDown size={16} />}
            </button>
            <strong>{group.name}</strong>
            <span className="badge">{groupLabels[group.kind] ?? group.kind}</span>
            <span className="badge is-accent">{group.selected || "等待提供者"}</span>
          </div>
          <button
            type="button"
            className="mini-btn"
            disabled={disabled || !!testingGroup}
            onClick={() => void testGroup(group)}
          >
            <Gauge size={13} /> {testingGroup === group.name ? "测速中…" : "组内测速"}
          </button>
        </div>
        {!isCollapsed && (
          <div className="mihomo-choices">
            {group.choices.map((choice, index) => {
              const selected = group.selected === choice;
              const delay = delays[choice];
              return (
                <button
                  key={`${index}:${choice}`}
                  type="button"
                  className={`mihomo-choice ${selected ? "is-selected" : ""}`}
                  disabled={disabled || !!pending || !group.manual}
                  title={choice}
                  onClick={() => void choose(group, choice)}
                >
                  <span>{choice}</span>
                  {delay !== undefined && (
                    <span className={`badge ${delay === null ? "is-bad" : delayClass(delay)}`}>
                      {delay === null ? "超时" : `${delay}ms`}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        )}
      </div>;
    })}
  </section>;
}
