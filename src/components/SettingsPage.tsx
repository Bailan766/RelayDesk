import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { decryptBackup, encryptBackup, isEncryptedBackup } from "../backupCrypto";
import {
  defaultHotkeys,
  defaultProbeUrl,
  defaultSystemProxyBypass,
  deserializeWorkspace,
  serializeWorkspace,
  type CloseAction,
  type GlobalHotkeys,
  type ThemeMode,
  type Workspace,
} from "../workspace";

type AppUpdateInfo = {
  current: string;
  latest: string;
  hasUpdate: boolean;
  releaseUrl: string;
  downloadUrl?: string | null;
  mirrorDownloadUrl?: string | null;
  expectedSha256?: string | null;
  notes: string;
};

type UpdateDownloadProgress = {
  downloaded: number;
  total?: number | null;
  stage: "downloading" | "verifying" | "installing";
};

export type TunServiceStatus = {
  installed: boolean;
  running: boolean;
  version: string | null;
  upToDate: boolean;
};

export type HotkeyErrors = {
  toggleProxy?: string | null;
  cycleRouting?: string | null;
  showWindow?: string | null;
};

function recordHotkeyFromEvent(e: KeyboardEvent<HTMLInputElement>): string | null {
  if (["Control", "Shift", "Alt", "Meta"].includes(e.key)) return null;
  const mods: string[] = [];
  if (e.ctrlKey) mods.push("Ctrl");
  if (e.altKey) mods.push("Alt");
  if (e.shiftKey) mods.push("Shift");
  if (e.metaKey) mods.push("Win");
  if (!mods.length) return null;

  let key = "";
  if (e.code.startsWith("Key") && e.code.length === 4) key = e.code.slice(3).toUpperCase();
  else if (e.code.startsWith("Digit") && e.code.length === 6) key = e.code.slice(5);
  else if (/^F([1-9]|1[0-2])$/.test(e.code)) key = e.code;
  else if (e.code === "Space") key = "Space";
  else if (e.code === "Tab") key = "Tab";
  else if (e.code === "Insert") key = "Insert";
  else if (e.code === "Delete") key = "Delete";
  else if (e.code === "Home") key = "Home";
  else if (e.code === "End") key = "End";
  else if (e.code === "PageUp") key = "PageUp";
  else if (e.code === "PageDown") key = "PageDown";
  else if (e.code === "ArrowUp") key = "Up";
  else if (e.code === "ArrowDown") key = "Down";
  else if (e.code === "ArrowLeft") key = "Left";
  else if (e.code === "ArrowRight") key = "Right";
  else return null;

  return `${mods.join("+")}+${key}`;
}

export function SettingsPage({
  workspace,
  ready,
  busy,
  running,
  elevated,
  serviceStatus,
  serviceBusy,
  hotkeyErrors,
  onInstallService,
  onUninstallService,
  onSave,
}: {
  workspace: Workspace;
  ready: boolean;
  busy: boolean;
  running: boolean;
  elevated: boolean;
  serviceStatus: TunServiceStatus | null;
  serviceBusy: boolean;
  hotkeyErrors?: HotkeyErrors;
  onInstallService: () => void;
  onUninstallService: () => void;
  onSave: (edit: (previous: Workspace) => Workspace) => Promise<void>;
}) {
  const [autostart, setAutostart] = useState(false);
  const [autostartBusy, setAutostartBusy] = useState(false);
  const [bypassDraft, setBypassDraft] = useState(workspace.systemProxyBypass);
  const [probeUrlDraft, setProbeUrlDraft] = useState(workspace.probeUrl);
  const [feedback, setFeedback] = useState("");
  const [repoCopied, setRepoCopied] = useState(false);
  const [updateChecking, setUpdateChecking] = useState(false);
  const [updateInfo, setUpdateInfo] = useState<AppUpdateInfo>();
  const [updateInstalling, setUpdateInstalling] = useState(false);
  const [updateProgress, setUpdateProgress] = useState<UpdateDownloadProgress>();
  const [exportPassword, setExportPassword] = useState("");
  const [pendingEncryptedImport, setPendingEncryptedImport] = useState<{ name: string; raw: string }>();
  const [importPassword, setImportPassword] = useState("");
  const [cryptoBusy, setCryptoBusy] = useState(false);
  const [error, setError] = useState("");
  const backupInputRef = useRef<HTMLInputElement>(null);

  function saveHotkey(field: keyof GlobalHotkeys, value: string) {
    void onSave(s => ({
      ...s,
      hotkeys: { ...(s.hotkeys ?? defaultHotkeys), [field]: value },
    }));
  }

  useEffect(() => {
    if (!isTauri() || !updateInstalling) return;
    let unlisten: (() => void) | undefined;
    void listen<UpdateDownloadProgress>("update-download-progress", event => {
      setUpdateProgress(event.payload);
    }).then(fn => {
      unlisten = fn;
    });
    return () => {
      unlisten?.();
    };
  }, [updateInstalling]);

  async function installUpdate(useMirror: boolean) {
    if (!updateInfo?.downloadUrl || updateInstalling) return;
    setUpdateInstalling(true);
    setUpdateProgress({ downloaded: 0, total: null, stage: "downloading" });
    setError("");
    try {
      await invoke<boolean>("download_and_install_update", {
        downloadUrl: updateInfo.downloadUrl,
        expectedSha256: updateInfo.expectedSha256 ?? null,
        useMirror,
      });
    } catch (failure) {
      setError(typeof failure === "string" ? failure : "下载或安装更新失败");
      setUpdateInstalling(false);
      setUpdateProgress(undefined);
    }
  }

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
            <strong>后台服务模式（免 UAC 开 TUN）</strong>
            <small>
              {serviceStatus?.installed && serviceStatus.running && serviceStatus.upToDate
                ? `服务已运行（v${serviceStatus.version}）：开启 TUN 无需再次提权或弹 UAC`
                : serviceStatus?.installed
                  ? "服务已安装但未启动或版本过期，建议更新后即可免 UAC 开 TUN"
                  : "一次授权安装 Windows 后台服务，之后普通权限启停 TUN 零弹窗"}
            </small>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            {serviceStatus?.installed ? (
              <>
                <span className={`tag ${serviceStatus.running && serviceStatus.upToDate ? "is-good" : "is-warn"}`}>
                  {serviceStatus.running && serviceStatus.upToDate ? "运行中 · 免 UAC" : "需更新 / 未启动"}
                </span>
                {(!serviceStatus.running || !serviceStatus.upToDate) && (
                  <button
                    type="button"
                    className="mini-btn is-primary"
                    disabled={!isTauri() || serviceBusy || busy}
                    onClick={onInstallService}
                  >
                    {serviceBusy ? "处理中…" : "更新并启动服务"}
                  </button>
                )}
                <button
                  type="button"
                  className="mini-btn"
                  disabled={!isTauri() || serviceBusy || busy}
                  onClick={onUninstallService}
                >
                  {serviceBusy ? "处理中…" : "卸载服务"}
                </button>
              </>
            ) : (
              <button
                type="button"
                className="mini-btn is-primary"
                disabled={!isTauri() || serviceBusy || busy}
                onClick={onInstallService}
              >
                {serviceBusy ? "安装中…" : "安装并启用服务"}
              </button>
            )}
          </div>
        </div>
        <div className="setting-item">
          <div className="setting-label">
            <strong>当前进程权限</strong>
            <small>
              {elevated
                ? "已以管理员身份运行，TUN 模式无需再次授权"
                : "普通权限：启动 TUN 时会弹出 UAC 授权"}
            </small>
          </div>
          {elevated ? (
            <span className="tag is-good">管理员权限</span>
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

      <section className="panel">
        <div className="panel-head">
          <h2>全局快捷键（Windows）</h2>
          <div style={{ display: "flex", gap: 6 }}>
            <button
              type="button"
              className="mini-btn"
              disabled={!ready || !isTauri()}
              onClick={() =>
                void onSave(s => ({
                  ...s,
                  hotkeys: {
                    toggleProxy: "Ctrl+Alt+P",
                    cycleRouting: "Ctrl+Alt+M",
                    showWindow: "Ctrl+Alt+R",
                  },
                })).then(() => setFeedback("已应用推荐全局快捷键（Ctrl+Alt+P/M/R）"))
              }
            >
              填入推荐组合
            </button>
            <button
              type="button"
              className="mini-btn"
              disabled={!ready || (!workspace.hotkeys.toggleProxy && !workspace.hotkeys.cycleRouting && !workspace.hotkeys.showWindow)}
              onClick={() => void onSave(s => ({ ...s, hotkeys: { ...defaultHotkeys } }))}
            >
              全部清空
            </button>
          </div>
        </div>
        {(
          [
            ["toggleProxy", "一键开关代理", "在后台或最小化时快速连接 / 断开当前代理", hotkeyErrors?.toggleProxy],
            ["cycleRouting", "循环切换路由模式", "按「规则 → 全局 → 直连」循环切换", hotkeyErrors?.cycleRouting],
            ["showWindow", "显示 / 唤起主窗口", "从系统托盘恢复并前置 RelayDesk 窗口", hotkeyErrors?.showWindow],
          ] as const
        ).map(([field, title, desc, fieldError]) => (
          <div className="setting-item" key={field}>
            <div className="setting-label">
              <strong>{title}</strong>
              <small>{desc}</small>
              {fieldError && <small className="error">{fieldError}</small>}
            </div>
            <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
              <input
                aria-label={title}
                readOnly
                style={{ width: 170, textAlign: "center", fontFamily: "ui-monospace, Consolas, monospace" }}
                value={workspace.hotkeys[field] || ""}
                placeholder="点击后按下组合键"
                disabled={!ready || !isTauri()}
                onKeyDown={e => {
                  if (e.key === "Escape") {
                    e.currentTarget.blur();
                    return;
                  }
                  if ((e.key === "Backspace" || e.key === "Delete") && !e.ctrlKey && !e.altKey && !e.shiftKey) {
                    e.preventDefault();
                    saveHotkey(field, "");
                    return;
                  }
                  const combo = recordHotkeyFromEvent(e);
                  if (combo) {
                    e.preventDefault();
                    e.stopPropagation();
                    saveHotkey(field, combo);
                  }
                }}
              />
              {workspace.hotkeys[field] && (
                <button type="button" className="mini-btn" onClick={() => saveHotkey(field, "")}>清除</button>
              )}
            </div>
          </div>
        ))}
      </section>

      <section className="panel">
        <div className="panel-head"><h2>备份与恢复</h2></div>
        <div className="setting-item" style={{ alignItems: "flex-start" }}>
          <div className="setting-label">
            <strong>导出 / 导入工作区配置</strong>
            <small>支持可选 AES-256-GCM 密码加密备份；未输入密码则导出普通 JSON</small>
          </div>
          <div style={{ display: "grid", gap: 8, justifyItems: "end" }}>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
              <input
                type="password"
                aria-label="导出备份加密密码"
                placeholder="可选加密密码（≥4位）"
                value={exportPassword}
                disabled={!ready || cryptoBusy}
                style={{ width: 190 }}
                onChange={e => setExportPassword(e.target.value)}
              />
              <button
                type="button"
                className="mini-btn"
                disabled={!ready || cryptoBusy}
                onClick={async () => {
                  setError("");
                  setCryptoBusy(true);
                  try {
                    const plain = serializeWorkspace(workspace);
                    const useEncrypt = exportPassword.length > 0;
                    const output = useEncrypt ? await encryptBackup(plain, exportPassword) : plain;
                    const blob = new Blob([output], { type: "application/json;charset=utf-8" });
                    const url = URL.createObjectURL(blob);
                    const link = document.createElement("a");
                    link.href = url;
                    const date = new Date().toISOString().slice(0, 10);
                    link.download = useEncrypt ? `relaydesk-backup-${date}.enc.json` : `relaydesk-backup-${date}.json`;
                    link.click();
                    URL.revokeObjectURL(url);
                    setFeedback(useEncrypt ? "已加密导出工作区备份（AES-256-GCM）" : "已导出明文工作区备份 JSON");
                  } catch (failure) {
                    setError(failure instanceof Error ? failure.message : "导出备份失败");
                  } finally {
                    setCryptoBusy(false);
                  }
                }}
              >
                {exportPassword.length > 0 ? "加密导出备份" : "导出备份 JSON"}
              </button>
              <input
                ref={backupInputRef}
                type="file"
                accept=".json,application/json"
                hidden
                onChange={async e => {
                  const file = e.target.files?.[0];
                  e.target.value = "";
                  if (!file) return;
                  try {
                    const text = await file.text();
                    if (isEncryptedBackup(text)) {
                      setPendingEncryptedImport({ name: file.name, raw: text });
                      setImportPassword("");
                      setError("");
                      setFeedback(`检测到加密备份「${file.name}」，请输入密码解密后恢复`);
                      return;
                    }
                    const parsed = JSON.parse(text) as unknown;
                    if (
                      !parsed ||
                      typeof parsed !== "object" ||
                      Array.isArray(parsed) ||
                      (!("subscriptions" in parsed) && !("rules" in parsed))
                    ) {
                      throw new Error("备份文件不是有效的 RelayDesk 工作区 JSON");
                    }
                    const restored = deserializeWorkspace(text);
                    await onSave(() => restored);
                    setPendingEncryptedImport(undefined);
                    setError("");
                    setFeedback(`已恢复备份（含 ${restored.subscriptions.length} 份订阅与 ${restored.rules.length} 条规则）`);
                  } catch (failure) {
                    setError(failure instanceof Error ? failure.message : "导入备份失败，请确认文件格式");
                  }
                }}
              />
              <button
                type="button"
                className="mini-btn is-primary"
                disabled={!ready || busy || running || cryptoBusy}
                onClick={() => backupInputRef.current?.click()}
              >
                从备份恢复
              </button>
            </div>
            {pendingEncryptedImport && (
              <form
                className="rule-form"
                style={{ margin: 0 }}
                onSubmit={async e => {
                  e.preventDefault();
                  setCryptoBusy(true);
                  setError("");
                  try {
                    const plain = await decryptBackup(pendingEncryptedImport.raw, importPassword);
                    const restored = deserializeWorkspace(plain);
                    await onSave(() => restored);
                    setPendingEncryptedImport(undefined);
                    setImportPassword("");
                    setFeedback(`已解密并恢复备份（含 ${restored.subscriptions.length} 份订阅与 ${restored.rules.length} 条规则）`);
                  } catch (failure) {
                    setError(failure instanceof Error ? failure.message : "解密备份失败");
                  } finally {
                    setCryptoBusy(false);
                  }
                }}
              >
                <input
                  type="password"
                  aria-label="解密备份密码"
                  placeholder={`输入「${pendingEncryptedImport.name}」的解密密码`}
                  value={importPassword}
                  disabled={cryptoBusy}
                  onChange={e => setImportPassword(e.target.value)}
                />
                <button type="submit" className="mini-btn is-primary" disabled={cryptoBusy || !importPassword}>
                  解密并恢复
                </button>
                <button
                  type="button"
                  className="mini-btn"
                  disabled={cryptoBusy}
                  onClick={() => {
                    setPendingEncryptedImport(undefined);
                    setImportPassword("");
                  }}
                >
                  取消
                </button>
              </form>
            )}
          </div>
        </div>
      </section>

      <section className="panel">
        <div className="panel-head">
          <h2>关于与开源</h2>
          <button
            type="button"
            className="mini-btn"
            disabled={!isTauri() || updateChecking}
            onClick={() => {
              setUpdateChecking(true);
              setError("");
              void invoke<AppUpdateInfo>("check_app_update")
                .then(info => {
                  setUpdateInfo(info);
                  setFeedback(info.hasUpdate ? `发现新版本 v${info.latest}` : `当前已是最新版本 v${info.current}`);
                })
                .catch(failure => setError(typeof failure === "string" ? failure : "检查更新失败"))
                .finally(() => setUpdateChecking(false));
            }}
          >
            {updateChecking ? "检查中…" : "检查更新"}
          </button>
        </div>
        {updateInfo?.hasUpdate && (
          <div className="notice is-warn" role="status" style={{ marginBottom: 12, display: "grid", gap: 8 }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, flexWrap: "wrap" }}>
              <span>
                发现新版本 <strong>v{updateInfo.latest}</strong>（当前 v{updateInfo.current}）
                {updateInfo.expectedSha256 ? " · 支持 SHA-256 校验安装" : ""}
              </span>
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                {updateInfo.downloadUrl && (
                  <button
                    type="button"
                    className="mini-btn is-primary"
                    disabled={updateInstalling}
                    onClick={() => void installUpdate(true)}
                  >
                    {updateInstalling ? "升级准备中…" : "国内加速一键升级"}
                  </button>
                )}
                {updateInfo.downloadUrl && (
                  <button
                    type="button"
                    className="mini-btn"
                    disabled={updateInstalling}
                    onClick={() => void installUpdate(false)}
                  >
                    GitHub 一键升级
                  </button>
                )}
                <button
                  type="button"
                  className="mini-btn"
                  disabled={updateInstalling}
                  onClick={() =>
                    void invoke("open_release_page", { url: updateInfo.mirrorDownloadUrl ?? updateInfo.releaseUrl }).catch(() =>
                      setError("无法打开更新发布页"),
                    )
                  }
                >
                  浏览器下载
                </button>
              </div>
            </div>
            {updateInstalling && updateProgress && (
              <div className="probe-progress" style={{ marginBottom: 0 }}>
                <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12 }}>
                  <span>
                    {updateProgress.stage === "verifying"
                      ? "正在校验安装包 SHA-256 指纹…"
                      : updateProgress.stage === "installing"
                        ? "校验通过，正在启动静默覆盖安装并重启…"
                        : "正在下载更新包…"}
                  </span>
                  <span>
                    {(updateProgress.downloaded / (1024 * 1024)).toFixed(1)}
                    {updateProgress.total ? ` / ${(updateProgress.total / (1024 * 1024)).toFixed(1)}` : ""} MiB
                  </span>
                </div>
                <div className="probe-progress-track">
                  <div
                    className="probe-progress-fill"
                    style={{
                      width: updateProgress.stage !== "downloading"
                        ? "100%"
                        : updateProgress.total
                          ? `${Math.min(100, Math.round((updateProgress.downloaded / updateProgress.total) * 100))}%`
                          : "45%",
                    }}
                  />
                </div>
              </div>
            )}
          </div>
        )}
        <div className="setting-item">
          <div className="setting-label">
            <strong>作者</strong>
            <small>Bailan233</small>
          </div>
          <span className="tag">MIT License</span>
        </div>
        <div className="setting-item">
          <div className="setting-label">
            <strong>开源地址</strong>
            <small>https://github.com/Bailan766/RelayDesk</small>
          </div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button
              type="button"
              className="mini-btn"
              onClick={() => {
                void navigator.clipboard.writeText("https://github.com/Bailan766/RelayDesk").then(() => {
                  setRepoCopied(true);
                  window.setTimeout(() => setRepoCopied(false), 1600);
                }).catch(() => {});
              }}
            >
              {repoCopied ? "已复制地址" : "复制地址"}
            </button>
            <button
              type="button"
              className="mini-btn is-primary"
              disabled={!isTauri()}
              onClick={() => void invoke("open_project_repo").catch(() => setError("无法打开项目主页"))}
            >
              打开 GitHub
            </button>
          </div>
        </div>
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
      <input inputMode="numeric" value={port} disabled={disabled || saving} placeholder="默认 17890"
        aria-describedby="proxy-port-note" onChange={event => { setPort(event.target.value); setError(""); }} />
    </label>
    <button className="mini-btn is-primary" disabled={disabled || saving || isUnchanged}>保存端口</button>
    <p className="rule-hint port-setting-note" id="proxy-port-note">留空固定优先 17890（被占自动顺延），避免重启或重连后终端与 IDE 端口失联。</p>
    {error && <span className="error" role="alert">{error}</span>}
  </form>;
}
