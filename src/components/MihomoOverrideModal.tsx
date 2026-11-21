import { useState } from "react";
import { X } from "lucide-react";
import { parseOverrideYaml, type MihomoOverride } from "../mihomoOverride";

function linesToArray(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line.length > 0 && !line.startsWith("#"));
}

export function MihomoOverrideModal({
  initial,
  runningOriginal,
  busy,
  onClose,
  onSave,
}: {
  initial: MihomoOverride;
  runningOriginal: boolean;
  busy: boolean;
  onClose: () => void;
  onSave: (next: MihomoOverride, reloadNow: boolean) => Promise<void>;
}) {
  const [enabled, setEnabled] = useState(initial.enabled);
  const [dnsEnabled, setDnsEnabled] = useState<MihomoOverride["dnsEnabled"]>(initial.dnsEnabled);
  const [enhancedMode, setEnhancedMode] = useState<MihomoOverride["enhancedMode"]>(initial.enhancedMode);
  const [nameservers, setNameservers] = useState(initial.nameservers.join("\n"));
  const [fallback, setFallback] = useState(initial.fallback.join("\n"));
  const [fakeIpFilter, setFakeIpFilter] = useState(initial.fakeIpFilter.join("\n"));
  const [extraRules, setExtraRules] = useState(initial.extraRules.join("\n"));
  const [extraYaml, setExtraYaml] = useState(initial.extraYaml);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  async function handleSave(reloadNow: boolean) {
    setError("");
    if (extraYaml.trim()) {
      try {
        parseOverrideYaml(extraYaml);
      } catch (e) {
        setError(e instanceof Error ? e.message : "YAML 覆写格式无效");
        return;
      }
    }
    const next: MihomoOverride = {
      enabled,
      dnsEnabled,
      enhancedMode,
      nameservers: linesToArray(nameservers),
      fallback: linesToArray(fallback),
      fakeIpFilter: linesToArray(fakeIpFilter),
      extraRules: linesToArray(extraRules),
      extraYaml,
    };
    setSaving(true);
    try {
      await onSave(next, reloadNow);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "保存 Mihomo 覆写失败");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="overlay" onMouseDown={() => !saving && onClose()}>
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        style={{ maxWidth: 680 }}
        onMouseDown={e => e.stopPropagation()}
      >
        <div className="modal-head">
          <div>
            <h2>Mihomo 持久化覆写</h2>
            <p>订阅自动更新或手动刷新后保留以下 DNS、前置规则与 YAML 深度合并配置。</p>
          </div>
          <button type="button" className="icon-button" aria-label="关闭覆写设置" disabled={saving} onClick={onClose}>
            <X size={18} />
          </button>
        </div>

        <div style={{ display: "grid", gap: 12 }}>
          <label className="checkbox-inline" style={{ fontSize: 13 }}>
            <input type="checkbox" checked={enabled} disabled={saving} onChange={e => setEnabled(e.target.checked)} />
            <span><strong>启用持久化覆写</strong>（作用于当前及后续刷新的 Mihomo 原配置）</span>
          </label>

          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 10 }}>
            <label style={{ display: "grid", gap: 4, fontSize: 12 }}>
              <span className="muted">DNS 模块开关</span>
              <select value={dnsEnabled} disabled={saving} onChange={e => setDnsEnabled(e.target.value as MihomoOverride["dnsEnabled"])}>
                <option value="inherit">跟随订阅默认</option>
                <option value="enable">强制开启 dns.enable</option>
                <option value="disable">强制关闭（仅非 TUN）</option>
              </select>
            </label>
            <label style={{ display: "grid", gap: 4, fontSize: 12 }}>
              <span className="muted">DNS 增强模式 (enhanced-mode)</span>
              <select value={enhancedMode} disabled={saving} onChange={e => setEnhancedMode(e.target.value as MihomoOverride["enhancedMode"])}>
                <option value="">跟随订阅默认</option>
                <option value="fake-ip">fake-ip（推荐，防泄漏、零延迟分配）</option>
                <option value="redir-host">redir-host（返回真实 IP）</option>
              </select>
            </label>
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: 10 }}>
            <label style={{ display: "grid", gap: 4, fontSize: 12 }}>
              <span className="muted">自定义主 DNS (nameserver，每行一条，留空继承)</span>
              <textarea
                rows={3}
                disabled={saving}
                value={nameservers}
                placeholder={"https://223.5.5.5/dns-query\nhttps://1.12.12.12/dns-query"}
                onChange={e => setNameservers(e.target.value)}
              />
            </label>
            <label style={{ display: "grid", gap: 4, fontSize: 12 }}>
              <span className="muted">自定义备用 DNS (fallback，每行一条，留空继承)</span>
              <textarea
                rows={3}
                disabled={saving}
                value={fallback}
                placeholder={"https://1.1.1.1/dns-query\ntls://8.8.8.8:853"}
                onChange={e => setFallback(e.target.value)}
              />
            </label>
          </div>

          <label style={{ display: "grid", gap: 4, fontSize: 12 }}>
            <span className="muted">追加 Fake-IP 白名单 (fake-ip-filter，自动去重合并)</span>
            <textarea
              rows={2}
              disabled={saving}
              value={fakeIpFilter}
              placeholder={"*.lan\n+.msftconnecttest.com\ntime.windows.com"}
              onChange={e => setFakeIpFilter(e.target.value)}
            />
          </label>

          <label style={{ display: "grid", gap: 4, fontSize: 12 }}>
            <span className="muted">附加 Mihomo 原始规则（每行一条 Clash 语法，将注入订阅规则头部）</span>
            <textarea
              rows={3}
              disabled={saving}
              value={extraRules}
              placeholder={"DOMAIN-SUFFIX,corp.example.com,DIRECT\nPROCESS-NAME,Code.exe,Proxy"}
              onChange={e => setExtraRules(e.target.value)}
            />
          </label>

          <label style={{ display: "grid", gap: 4, fontSize: 12 }}>
            <span className="muted">高级 YAML 片段（深度合并 sniffer / hosts / ipv6 / tcp-concurrent / rule-providers 等字段）</span>
            <textarea
              rows={4}
              disabled={saving}
              value={extraYaml}
              placeholder={"sniffer:\n  enable: true\nipv6: true"}
              onChange={e => {
                setExtraYaml(e.target.value);
                setError("");
              }}
            />
          </label>
        </div>

        {error && <p className="error" role="alert" style={{ marginTop: 10 }}>{error}</p>}

        <div className="modal-actions">
          <button type="button" className="btn" disabled={saving} onClick={onClose}>取消</button>
          <button type="button" className="btn" disabled={saving || busy} onClick={() => void handleSave(false)}>
            仅保存
          </button>
          {runningOriginal && (
            <button type="button" className="btn primary" disabled={saving || busy} onClick={() => void handleSave(true)}>
              {saving ? "应用中…" : "保存并热重载生效"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
