import { invoke, isTauri } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";
import {
  defaultProbeUrl,
  defaultSystemProxyBypass,
  type CloseAction,
  type ThemeMode,
  type Workspace,
} from "../workspace";

export function SettingsPage({
  workspace,
  ready,
  busy,
  running,
  elevated,
  onSave,
}: {
  workspace: Workspace;
  ready: boolean;
  busy: boolean;
  running: boolean;
  elevated: boolean;
  onSave: (edit: (previous: Workspace) => Workspace) => Promise<void>;
}) {
  const [autostart, setAutostart] = useState(false);
  const [autostartBusy, setAutostartBusy] = useState(false);
  const [bypassDraft, setBypassDraft] = useState(workspace.systemProxyBypass);
  const [probeUrlDraft, setProbeUrlDraft] = useState(workspace.probeUrl);
  const [feedback, setFeedback] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    setBypassDraft(workspace.systemProxyBypass);
  }, [workspace.systemProxyBypass]);

  useEffect(() => {
    setProbeUrlDraft(workspace.probeUrl);
  }, [workspace.probeUrl]);

  useEffect(() => {
    if (!isTauri()) return;
    void invoke<boolean>("get_autostart").then(setAutostart).catch(() => {});
  }, []);

  async function toggleAutostart(next: boolean) {
    if (!isTauri() || autostartBusy) return;
    setAutostartBusy(true);
    setError("");
    try {
      await invoke("set_autostart", { enabled: next });
      setAutostart(next);
      setFeedback(next ? "已开启开机自启" : "已关闭开机自启");
    } catch (e) {
      setError(typeof e === "string" ? e : "修改开机自启失败");
    } finally {
      setAutostartBusy(false);
    }
  }

  async function elevate() {
    if (!isTauri()) return;
    setError("");
    try {
      await invoke("relaunch_elevated");
    } catch (e) {
      setError(typeof e === "string" ? e : "未完成管理员权限重启");
    }
  }

  return (
    <div className="settings-grid">
      {feedback && <div className="notice" role="status">{feedback}</div>}
      {error && <div className="notice is-error" role="alert">{error}</div>}

      <section className="panel">
        <div className="panel-head"><h2>外观与启动</h2></div>
        <div className="setting-item">
          <div className="setting-label">
            <strong>界面主题</strong>
            <small>支持浅色、深色或自动跟随 Windows 系统颜色模式</small>
          </div>
          <select
            aria-label="界面主题"
            className="toolbar-select"
            value={workspace.theme}
            disabled={!ready}
            onChange={e => void onSave(s => ({ ...s, theme: e.target.value as ThemeMode }))}
          >
            <option value="system">跟随系统</option>
            <option value="light">浅色</option>
            <option value="dark">深色</option>
          </select>
        </div>
        <div className="setting-item">
          <div className="setting-label">
            <strong>关闭主窗口时</strong>
            <small>选择隐藏到系统托盘继续代理，或直接停止并退出应用</small>
          </div>
          <select
            aria-label="关闭主窗口行为"
            className="toolbar-select"
            value={workspace.closeAction}
            disabled={!ready}
            onChange={e => void onSave(s => ({ ...s, closeAction: e.target.value as CloseAction }))}
          >
            <option value="tray">最小化到托盘</option>
            <option value="exit">直接彻底退出</option>
          </select>
        </div>
        <div className="setting-item">
          <div className="setting-label">
            <strong>开机自启</strong>
            <small>登录当前 Windows 账户时自动启动 RelayDesk</small>
          </div>
          <label className="checkbox-inline">
            <input
              type="checkbox"
              checked={autostart}
              disabled={!isTauri() || autostartBusy}
              onChange={e => void toggleAutostart(e.target.checked)}
            />
            <span>{autostart ? "已开启" : "未开启"}</span>
          </label>
        </div>
        <div className="setting-item">
          <div className="setting-label">
            <strong>启动后自动连接</strong>
            <small>打开应用时自动连接上次选中的节点或 Mihomo 原配置</small>
          </div>
          <label className="checkbox-inline">
            <input
              type="checkbox"
              checked={workspace.autoConnect}
              disabled={!ready}
              onChange={e => void onSave(s => ({ ...s, autoConnect: e.target.checked }))}
            />
            <span>启用</span>
          </label>
        </div>
      </section>

      <section className="panel">
        <div className="panel-head"><h2>网络与代理入口</h2></div>
        <div className="setting-item">
          <div className="setting-label">
            <strong>允许局域网连接（Allow LAN）</strong>
            <small>启用后本地 HTTP/SOCKS5 入口监听 0.0.0.0，供同局域网设备接入（重连生效）</small>
          </div>
          <label className="checkbox-inline">
            <input
              type="checkbox"
              checked={workspace.allowLan}
              disabled={!ready || busy || running}
              onChange={e => void onSave(s => ({ ...s, allowLan: e.target.checked }))}
            />
            <span>{workspace.allowLan ? "允许" : "仅本机"}</span>
          </label>
        </div>
        <FixedPortSetting
          key={String(workspace.proxyPort)}
          value={workspace.proxyPort}
          disabled={!ready || busy || running}
          onChange={changed => onSave(s => ({ ...s, proxyPort: changed }))}
        />
        <form
          className="rule-form"
          style={{ marginTop: 12, marginBottom: 4 }}
          onSubmit={e => {
            e.preventDefault();
            const value = bypassDraft.trim() || defaultSystemProxyBypass;
            void onSave(s => ({ ...s, systemProxyBypass: value })).then(() => setFeedback("已保存系统代理绕过列表"));
          }}
        >
          <label style={{ flex: "1 1 280px", display: "grid", gap: 4 }}>
            <span style={{ fontSize: 13, fontWeight: 600 }}>系统代理绕过列表（分号分隔）</span>
            <input
              value={bypassDraft}
              disabled={!ready || busy || running}
              onChange={e => setBypassDraft(e.target.value)}
            />
          </label>
          <button type="submit" className="mini-btn is-primary" disabled={!ready || busy || running || bypassDraft === workspace.systemProxyBypass}>
            保存绕过列表
          </button>
          <button
            type="button"
            className="mini-btn"
            disabled={!ready || busy || running || workspace.systemProxyBypass === defaultSystemProxyBypass}
            onClick={() => {
              setBypassDraft(defaultSystemProxyBypass);
              void onSave(s => ({ ...s, systemProxyBypass: defaultSystemProxyBypass }));
            }}
          >
            恢复默认
          </button>
        </form>
      </section>

      <section className="panel">
        <div className="panel-head"><h2>Windows TUN 与权限</h2></div>
        <div className="setting-item">
          <div className="setting-label">
            <strong>当前进程权限</strong>
            <small>
              {elevated
                ? "已以管理员身份运行：启动与自动恢复 TUN 不会再弹出 UAC 提示"
                : "当前为普通权限：启动 TUN 时会按会话请求管理员授权"}
            </small>
          </div>
          {elevated ? (
            <span className="badge is-good">管理员权限</span>
          ) : (
            <button type="button" className="mini-btn is-primary" disabled={!isTauri() || busy} onClick={() => void elevate()}>
              以管理员身份重启
            </button>
          )}
        </div>
        <div className="setting-item">
          <div className="setting-label">
            <strong>TUN 启用 IPv6 地址（双栈接管）</strong>
            <small>Windows 若未启用 IPv6 仍会自动回退 IPv4 就绪；关闭此项可强制仅分配 IPv4 虚拟网卡</small>
          </div>
          <label className="checkbox-inline">
            <input
              type="checkbox"
              checked={workspace.tunIpv6}
              disabled={!ready || busy || running}
              onChange={e => void onSave(s => ({ ...s, tunIpv6: e.target.checked }))}
            />
            <span>{workspace.tunIpv6 ? "双栈" : "仅 IPv4"}</span>
          </label>
        </div>
      </section>

      <section className="panel">
        <div className="panel-head"><h2>测速与容灾恢复</h2></div>
        <div className="setting-item">
          <div className="setting-label">
            <strong>内核意外退出时自动恢复</strong>
            <small>系统代理、本地端口以及管理员权限下的 TUN 均可在意外退出后自动拉起</small>
          </div>
          <label className="checkbox-inline">
            <input
              type="checkbox"
              checked={workspace.autoReconnect}
              disabled={!ready}
              onChange={e => void onSave(s => ({ ...s, autoReconnect: e.target.checked }))}
            />
            <span>开启</span>
          </label>
        </div>
        <div className="setting-item">
          <div className="setting-label">
            <strong>节点失联时自动换线（节点模式）</strong>
            <small>后台连续两次连通性探测失败后，自动尝试同订阅备用节点（收藏优先）</small>
          </div>
          <label className="checkbox-inline">
            <input
              type="checkbox"
              checked={workspace.autoFailover}
              disabled={!ready}
              onChange={e => void onSave(s => ({ ...s, autoFailover: e.target.checked }))}
            />
            <span>开启</span>
          </label>
        </div>
        <form
          className="rule-form"
          style={{ marginTop: 12, marginBottom: 0 }}
          onSubmit={e => {
            e.preventDefault();
            try {
              const parsed = new URL(probeUrlDraft.trim());
              if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
                throw new Error();
              }
              setError("");
              void onSave(s => ({ ...s, probeUrl: parsed.href })).then(() => setFeedback("已保存测速地址"));
            } catch {
              setError("请输入有效的 HTTP/HTTPS 测速 URL");
            }
          }}
        >
          <label style={{ flex: "1 1 280px", display: "grid", gap: 4 }}>
            <span style={{ fontSize: 13, fontWeight: 600 }}>延迟测速 URL</span>
            <input
              value={probeUrlDraft}
              disabled={!ready}
              onChange={e => setProbeUrlDraft(e.target.value)}
            />
          </label>
          <button type="submit" className="mini-btn is-primary" disabled={!ready || probeUrlDraft.trim() === workspace.probeUrl}>
            保存测速地址
          </button>
          <button
            type="button"
            className="mini-btn"
            disabled={!ready || workspace.probeUrl === defaultProbeUrl}
            onClick={() => {
              setProbeUrlDraft(defaultProbeUrl);
              void onSave(s => ({ ...s, probeUrl: defaultProbeUrl }));
            }}
          >
            恢复默认
          </button>
        </form>
      </section>
    </div>
  );
}

function FixedPortSetting({ value, disabled, onChange }: {
  value: number | null;
  disabled: boolean;
  onChange: (port: number | null) => Promise<void>;
}) {
  const [port, setPort] = useState(value == null ? "" : String(value));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const isUnchanged = port.trim() === (value == null ? "" : String(value));
  return <form className="rule-form" onSubmit={event => {
    event.preventDefault();
    const input = port.trim();
    const number = input ? Number(input) : null;
    if (number != null && (!/^\d{1,5}$/.test(input) || number < 1024 || number > 65535)) {
      setError("端口须为 1024 至 65535 的整数");
      return;
    }
    setError("");
    setSaving(true);
    void onChange(number).finally(() => setSaving(false));
  }}>
    <label className="port-setting"><span>本地 HTTP / SOCKS5 端口</span>
      <input inputMode="numeric" value={port} disabled={disabled || saving} placeholder="自动分配"
        aria-describedby="proxy-port-note" onChange={event => { setPort(event.target.value); setError(""); }} />
    </label>
    <button className="mini-btn is-primary" disabled={disabled || saving || isUnchanged}>保存端口</button>
    <p className="rule-hint port-setting-note" id="proxy-port-note">留空自动分配可用端口。停止代理后可更改。</p>
    {error && <span className="error" role="alert">{error}</span>}
  </form>;
}
