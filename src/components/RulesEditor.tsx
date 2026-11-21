import { useMemo, useState } from "react";
import { evaluateRuleMatch, normalizeRuleValue, rulePresets, ruleTypes, type RouteRule, type RuleDefaultAction } from "../config";

export function RulesEditor({
  rules,
  targets,
  defaultAction,
  dirtyWhileRunning,
  running,
  isMihomo = false,
  onDefaultAction,
  onChange,
  onApplyReconnect,
}: {
  rules: RouteRule[];
  targets: { id: string; label: string }[];
  defaultAction: RuleDefaultAction;
  dirtyWhileRunning: boolean;
  running: boolean;
  isMihomo?: boolean;
  onDefaultAction: (action: RuleDefaultAction) => void;
  onChange: (edit: (rules: RouteRule[]) => RouteRule[]) => void;
  onApplyReconnect: () => void;
}) {
  const [type, setType] = useState<RouteRule["type"]>("domain_suffix");
  const [action, setAction] = useState<RouteRule["action"]>("direct");
  const [target, setTarget] = useState("");
  const [value, setValue] = useState("");
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const [validationError, setValidationError] = useState("");
  const [presetHint, setPresetHint] = useState("");
  const [probeInput, setProbeInput] = useState("");

  const matchResult = useMemo(() => {
    if (!probeInput.trim()) return undefined;
    try {
      return { ok: true as const, value: evaluateRuleMatch(probeInput, rules, defaultAction) };
    } catch (error) {
      return { ok: false as const, message: error instanceof Error ? error.message : "测试目标格式无效" };
    }
  }, [probeInput, rules, defaultAction]);

  function move(index: number, offset: number) {
    onChange(current => {
      const destination = index + offset;
      if (index < 0 || destination < 0 || destination >= current.length) return current;
      const reordered = [...current];
      [reordered[destination], reordered[index]] = [reordered[index], reordered[destination]];
      return reordered;
    });
    if (editingIndex === index) setEditingIndex(index + offset);
  }

  function startEdit(rule: RouteRule, index: number) {
    setEditingIndex(index);
    setType(rule.type);
    setValue(rule.value);
    setAction(rule.action);
    setTarget(rule.target ?? "");
    setValidationError("");
  }

  function cancelEdit() {
    setEditingIndex(null);
    setValue("");
    setTarget("");
    setValidationError("");
  }

  function submitRule() {
    try {
      const match = normalizeRuleValue(type, value);
      if (action === "proxy" && target && !targets.some(node => node.id === target)) {
        throw new Error("请选择可用节点");
      }
      const nextRule: RouteRule = {
        type,
        value: match,
        action,
        target: action === "proxy" && target ? target : undefined,
      };
      if (editingIndex !== null) {
        onChange(current => current.map((item, idx) => (idx === editingIndex ? nextRule : item)));
        setEditingIndex(null);
      } else {
        onChange(current => [...current, nextRule]);
      }
      setValue("");
      setValidationError("");
    } catch (error) {
      setValidationError(error instanceof Error ? error.message : "规则格式有误");
    }
  }

  function applyPreset(presetId: string) {
    const preset = rulePresets.find(item => item.id === presetId);
    if (!preset) return;
    let added = 0;
    onChange(current => {
      const seen = new Set(current.map(r => `${r.type}:${r.value}:${r.action}:${r.target ?? ""}`));
      const extra = preset.rules.filter(r => {
        const key = `${r.type}:${r.value}:${r.action}:${r.target ?? ""}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
      added = extra.length;
      return [...current, ...extra];
    });
    setPresetHint(added > 0 ? `已添加 ${added} 条「${preset.label}」规则` : `「${preset.label}」已全部存在`);
  }

  return (
    <section className="panel">
      <div className="panel-head">
        <h2>分流规则 ({rules.length})</h2>
        <label className="refresh-setting">
          未命中时默认动作{isMihomo ? "（节点模式）" : ""}
          <select value={defaultAction} onChange={e => onDefaultAction(e.target.value as RuleDefaultAction)}>
            <option value="proxy">代理（当前节点）</option>
            <option value="direct">直连（仅命中规则走代理）</option>
          </select>
        </label>
      </div>
      <p className="rule-hint">
        按从上到下优先匹配，同时作用于节点模式与 Mihomo 原配置头部前置规则。
      </p>
      {dirtyWhileRunning && running && (
        <div className="notice is-warn" role="status">
          <span>{isMihomo ? "分流规则已修改，点击热重载即时生效（不断网）。" : "规则或默认动作已修改，重新连接后立即生效。"}</span>
          <button type="button" className="mini-btn is-primary" onClick={onApplyReconnect}>
            {isMihomo ? "立即热重载生效" : "立即重连应用"}
          </button>
        </div>
      )}
      <div className="rule-presets">
        {rulePresets.map(preset => (
          <button
            key={preset.id}
            type="button"
            className="mini-btn"
            title={preset.description}
            onClick={() => applyPreset(preset.id)}
          >
            + {preset.label}
          </button>
        ))}
        {!!rules.length && (
          <button
            type="button"
            className="mini-btn"
            onClick={() => {
              onChange(() => []);
              cancelEdit();
            }}
          >
            清空规则
          </button>
        )}
      </div>
      {presetHint && <p className="rule-hint" role="status" style={{ marginTop: 6 }}>{presetHint}</p>}
      <div className="rule-form">
        <select
          aria-label="规则类型"
          value={type}
          onChange={(e) => { setType(e.target.value as RouteRule["type"]); setValidationError(""); }}
        >
          {ruleTypes.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
        </select>
        <input
          aria-label="规则内容"
          placeholder={ruleTypes.find(option => option.value === type)?.example}
          value={value}
          onChange={(e) => { setValue(e.target.value); setValidationError(""); }}
          onKeyDown={e => { if (e.key === "Enter" && value.trim()) submitRule(); }}
        />
        <select
          aria-label="规则动作"
          value={action}
          onChange={(e) => setAction(e.target.value as RouteRule["action"])}
        >
          <option value="direct">直连</option>
          <option value="proxy">代理</option>
          <option value="reject">拦截</option>
        </select>
        {action === "proxy" && (
          <select
            aria-label="规则使用的节点"
            className="rule-target"
            value={target}
            onChange={event => setTarget(event.target.value)}
          >
            <option value="">当前节点</option>
            {targets.map(node => <option key={node.id} value={node.id}>{node.label}</option>)}
          </select>
        )}
        <button type="button" className="mini-btn is-primary" disabled={!value.trim()} onClick={submitRule}>
          {editingIndex !== null ? "保存修改" : "添加规则"}
        </button>
        {editingIndex !== null && (
          <button type="button" className="mini-btn" onClick={cancelEdit}>取消</button>
        )}
      </div>
      {validationError && <p className="error" role="alert">{validationError}</p>}

      <div className="rule-form" style={{ marginTop: 8, marginBottom: 12 }}>
        <input
          aria-label="规则命中演练"
          placeholder="规则命中演练：输入域名、URL、IP 或 .exe 进程名（如 api.openai.com）"
          value={probeInput}
          onChange={e => setProbeInput(e.target.value)}
        />
        {probeInput.trim() && (
          <button type="button" className="mini-btn" onClick={() => setProbeInput("")}>清空测试</button>
        )}
      </div>
      {matchResult && (
        matchResult.ok ? (
          <div className="notice" role="status" style={{ marginBottom: 12 }}>
            <span>
              目标 <strong>{matchResult.value.normalized}</strong>{" "}
              {matchResult.value.matchedIndex !== null && matchResult.value.matchedRule ? (
                <>
                  命中第 <strong>{matchResult.value.matchedIndex + 1}</strong> 条规则（
                  {ruleTypes.find(t => t.value === matchResult.value.matchedRule!.type)?.label}：
                  <code>{matchResult.value.matchedRule.value}</code>）→{" "}
                  <strong>
                    {matchResult.value.action === "direct"
                      ? "直连"
                      : matchResult.value.action === "reject"
                        ? "拦截"
                        : matchResult.value.target
                          ? targets.find(n => n.id === matchResult.value.target)?.label ?? "指定节点已不可用"
                          : "代理（当前节点）"}
                  </strong>
                </>
              ) : (
                <>
                  未命中上方规则，将走默认动作 →{" "}
                  <strong>{matchResult.value.action === "direct" ? "直连" : "代理（当前节点）"}</strong>
                </>
              )}
            </span>
          </div>
        ) : (
          <p className="error" role="alert" style={{ marginBottom: 12 }}>{matchResult.message}</p>
        )
      )}

      {rules.length ? (
        rules.map((rule, index) => {
          const label = ruleTypes.find(option => option.value === rule.type)?.label;
          const route = rule.action === "direct" ? "直连" : rule.action === "reject" ? "拦截"
            : rule.target ? targets.find(node => node.id === rule.target)?.label ?? "指定节点已不可用" : "当前节点";
          const badgeClass = rule.action === "direct" ? "is-good" : rule.action === "reject" ? "is-bad" : "is-accent";
          const isMatched = matchResult?.ok && matchResult.value.matchedIndex === index;
          return <div className={`env-row rule-row ${isMatched ? "is-matched" : ""}`} key={`${rule.type}:${rule.value}:${index}`}>
            <span>
              <span className="tag" style={{ marginRight: 8 }}>{label}</span>
              <strong>{rule.value}</strong>
              <span className={`tag ${badgeClass}`} style={{ marginLeft: 8 }}>{route}</span>
            </span>
            <div className="rule-actions">
              <button type="button" className="link" onClick={() => startEdit(rule, index)}>编辑</button>
              <button type="button" className="link" disabled={index === 0} onClick={() => move(index, -1)} aria-label={`上移规则 ${rule.value}`}>上移</button>
              <button type="button" className="link" disabled={index === rules.length - 1} onClick={() => move(index, 1)} aria-label={`下移规则 ${rule.value}`}>下移</button>
              <button
                type="button"
                className="link"
                onClick={() => {
                  onChange(current => current.filter((_, idx) => idx !== index));
                  if (editingIndex === index) cancelEdit();
                }}
              >
                删除
              </button>
            </div>
          </div>;
        })
      ) : (
        <p className="empty">暂无自定义规则。可上方一键导入“绕过局域网与保留地址”或“常见国内站点直连”。</p>
      )}
    </section>
  );
}
