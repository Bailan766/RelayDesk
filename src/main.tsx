import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  Activity,
  Boxes,
  Cat,
  Check,
  Copy,
  FlaskConical,
  Globe2,
  LayoutDashboard,
  Link2,
  Moon,
  Plus,
  Settings2,
  Shield,
  ShieldAlert,
  ShieldCheck,
  Sun,
  SunMoon,
  Terminal,
  X,
} from "lucide-react";
import { nodeRevision, type NodeProfile } from "./subscription";
import {
  buildConfig,
  buildSessionConfig,
  connectionSupport,
  withMihomoCustomRules,
  withSelectedOutbound,
  type SessionPlan,
} from "./config";
import { applyMihomoOverride, type MihomoOverride } from "./mihomoOverride";
import { ConnectionMonitor, TrafficSidebar, useTelemetry } from "./telemetry";
import { RulesEditor } from "./components/RulesEditor";
import { SettingsPage, type HotkeyErrors, type TunServiceStatus } from "./components/SettingsPage";
import { ImportModal } from "./components/ImportModal";
import { MihomoOverrideModal } from "./components/MihomoOverrideModal";
import { OverviewPage } from "./pages/OverviewPage";
import { NodesPage } from "./pages/NodesPage";
import { SubscriptionsPage } from "./pages/SubscriptionsPage";
import { DiagnosticsPage } from "./pages/DiagnosticsPage";
import { useWorkspace } from "./useWorkspace";
import {
  fallbackGroups,
  nodeRegion,
  type ExitIpDetail,
  type ProxyStatus,
} from "./utils/nodes";
import {
  isInfoNodeName,
  preferredNode,
  type EntryMode,
  type LatencyRecord,
  type RoutingMode,
  type SubscriptionRequest,
  type ThemeMode,
  type Workspace,
} from "./workspace";
import "./style.css";
import "./accessibility.css";
import "./rules.css";
import "./dashboard.css";
import "./motion.css";

type Page = "概览" | "节点" | "订阅" | "连接" | "规则" | "诊断" | "设置";

const pageIcons: Record<Page, typeof Activity> = {
  概览: LayoutDashboard,
  节点: Globe2,
  订阅: Boxes,
  连接: Link2,
  规则: Shield,
  诊断: FlaskConical,
  设置: Settings2,
};

const navOrder: Page[] = ["概览", "节点", "订阅", "连接", "规则", "诊断", "设置"];

type HotkeyApplyResult = {
  toggleProxyError?: string | null;
  cycleRoutingError?: string | null;
  showWindowError?: string | null;
};

function App() {
  const [page, setPage] = useState<Page>("概览");
  const work = useWorkspace();
  const {
    subscriptions,
    rules,
    ruleSets,
    mihomoOverride,
    hotkeys,
    selected,
    favorites,
    autoReconnect,
    autoFailover,
    proxyPort,
    entryMode: mode,
    theme,
    autoConnect,
    closeAction,
    allowLan,
    systemProxyBypass,
    probeUrl,
    tunIpv6,
    ruleDefaultAction,
    nodeLatencies,
  } = work.workspace;

  const starred = useMemo(() => new Set(favorites), [favorites]);
  const nodes = useMemo(() => subscriptions.flatMap(profile => profile.parsed.nodes), [subscriptions]);
  const unavailableNodes = useMemo(() => new Map(nodes.map(node => [node.id, connectionSupport(node)])), [nodes]);
  const protocols = useMemo(() => Array.from(new Set(nodes.map(n => n.protocol))).sort(), [nodes]);
  const ruleTargets = useMemo(
    () =>
      subscriptions.flatMap(profile =>
        profile.parsed.nodes
          .filter(node => !unavailableNodes.get(node.id))
          .map(node => ({ id: node.id, label: `${profile.name} · #${node.sourceIndex} ${node.name}` })),
      ),
    [subscriptions, unavailableNodes],
  );
  const ruleNodeNameMap = useMemo(() => new Map(nodes.map(n => [n.id, n.name])), [nodes]);

  const [subscriptionFilter, setSubscriptionFilter] = useState("");
  const [protocolFilter, setProtocolFilter] = useState("");
  const [regionFilter, setRegionFilter] = useState("");
  const [nodeSort, setNodeSort] = useState("source");
  const [nodeView, setNodeView] = useState<"list" | "grid">("list");
  const [groupBySub, setGroupBySub] = useState(false);
  const [onlyFavorites, setOnlyFavorites] = useState(false);
  const [onlySupported, setOnlySupported] = useState(false);
  const [nodesTab, setNodesTab] = useState<"groups" | "nodes">("groups");
  const [diagTab, setDiagTab] = useState<"checks" | "dns" | "unlock" | "logs">("checks");
  const [envCopied, setEnvCopied] = useState(false);
  const [dialog, setDialog] = useState(false);
  const [overrideModal, setOverrideModal] = useState(false);
  const [detailNode, setDetailNode] = useState<NodeProfile>();
  const [detailCopied, setDetailCopied] = useState(false);
  const [error, setError] = useState("");
  const [importing, setImporting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [settingsError, setSettingsError] = useState("");
  const [search, setSearch] = useState("");

  const [running, setRunning] = useState(false);
  const [recovering, setRecovering] = useState(false);
  const [recoveryMessage, setRecoveryMessage] = useState("");
  const [nodeHealth, setNodeHealth] = useState<ProxyStatus["node_health"]>(null);
  const [runningNode, setRunningNode] = useState<NodeProfile>();
  const [runningOriginal, setRunningOriginal] = useState<{ id: string; name: string; content: string }>();
  const [liveRouting, setLiveRouting] = useState<RoutingMode>();
  const [appliedRulesKey, setAppliedRulesKey] = useState("");

  const originalProfile = subscriptions.find(profile => profile.id === work.workspace.mihomoProfile && profile.parsed.mihomo);
  const liveOriginalProfile = runningOriginal && subscriptions.find(profile => profile.id === runningOriginal.id);
  const originalName = running ? (liveOriginalProfile?.name ?? runningOriginal?.name) : originalProfile?.name;
  const originalUpdated = runningOriginal && liveOriginalProfile && runningOriginal.content !== liveOriginalProfile.content;

  const preferredOriginalMode: RoutingMode | undefined = originalProfile?.parsed.mihomo
    ? (originalProfile.mihomoMode ??
      (originalProfile.parsed.mihomo.mode === "global" || originalProfile.parsed.mihomo.mode === "direct"
        ? originalProfile.parsed.mihomo.mode
        : "rule"))
    : undefined;

  const routingMode = running
    ? (liveRouting ?? work.workspace.routingMode)
    : (preferredOriginalMode ?? work.workspace.routingMode);

  const session = useRef<SessionPlan>();
  const telemetry = useTelemetry(running && !recovering);
  const [port, setPort] = useState<number>();
  const [portCopied, setPortCopied] = useState(false);
  const [connectionError, setConnectionError] = useState("");
  const [checkResult, setCheckResult] = useState("");
  const [checking, setChecking] = useState(false);
  const diagnosticsEpoch = useRef(0);
  const [diagnosticsVersion, setDiagnosticsVersion] = useState(0);
  const confirmedSession = useRef<string | null>(null);

  const [latencies, setLatencies] = useState<Record<string, LatencyRecord>>({});
  const [mihomoDelays, setMihomoDelays] = useState<Record<string, number | null>>({});
  const [testing, setTesting] = useState(false);
  const [probeMode, setProbeMode] = useState<"url" | "tcp">("url");
  const [probeProgress, setProbeProgress] = useState<{ done: number; total: number }>();
  const [exitIp, setExitIp] = useState<ExitIpDetail>();
  const [exitIpError, setExitIpError] = useState("");
  const [localTcp, setLocalTcp] = useState("尚未测试");
  const [localTcpBusy, setLocalTcpBusy] = useState(false);
  const [elevated, setElevated] = useState(false);
  const [serviceStatus, setServiceStatus] = useState<TunServiceStatus | null>(null);
  const [serviceBusy, setServiceBusy] = useState(false);
  const [proxyTampered, setProxyTampered] = useState(false);
  const [trayMihomoGroup, setTrayMihomoGroup] = useState<{ name: string; selected: string; choices: string[] }>();
  const [hotkeyErrors, setHotkeyErrors] = useState<HotkeyErrors>({});
  const cancelTesting = useRef(false);
  const probeBatch = useRef<string>();
  const probeSessionId = useRef<string>();
  const autoConnectRan = useRef(false);
  const lastProbeAt = useRef(0);
  const trayPickRef = useRef<(() => void)[]>([]);

  const currentRulesKey = useMemo(
    () => JSON.stringify({ rules, ruleDefaultAction, ruleSets, mihomoOverride }),
    [mihomoOverride, ruleDefaultAction, ruleSets, rules],
  );
  const rulesDirtyWhileRunning = running && appliedRulesKey !== "" && appliedRulesKey !== currentRulesKey;

  function buildMihomoConfig(raw: Record<string, unknown>, overrideConfig: MihomoOverride = mihomoOverride) {
    return withMihomoCustomRules(applyMihomoOverride(raw, overrideConfig), rules, ruleNodeNameMap);
  }

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  useEffect(() => {
    setLatencies(prev => ({ ...nodeLatencies, ...prev }));
  }, [nodeLatencies]);

  async function refreshServiceStatus() {
    if (!isTauri()) return;
    try {
      const next = await invoke<TunServiceStatus>("get_tun_service_status");
      setServiceStatus(next);
    } catch { /* ignore on unsupported platforms */ }
  }

  useEffect(() => {
    if (!isTauri() || !work.ready) return;
    void invoke<boolean>("is_elevated").then(setElevated).catch(() => {});
    void refreshServiceStatus();
    void invoke("set_close_action", { exitOnClose: closeAction === "exit" }).catch(() => {});
  }, [closeAction, work.ready]);

  useEffect(() => {
    if (!isTauri() || !work.ready) return;
    void invoke<HotkeyApplyResult>("set_global_hotkeys", { config: hotkeys })
      .then(result => {
        setHotkeyErrors({
          toggleProxy: result.toggleProxyError,
          cycleRouting: result.cycleRoutingError,
          showWindow: result.showWindowError,
        });
      })
      .catch(() => {});
  }, [hotkeys.cycleRouting, hotkeys.showWindow, hotkeys.toggleProxy, work.ready]);

  async function handleInstallService() {
    if (!isTauri() || serviceBusy) return;
    setServiceBusy(true);
    setSettingsError("");
    setConnectionError("");
    try {
      await invoke("install_tun_service");
      if (running) clearSession();
      await refreshServiceStatus();
    } catch (e) {
      const msg = typeof e === "string" ? e : e instanceof Error ? e.message : "安装后台服务失败";
      setSettingsError(msg);
      setConnectionError(msg);
    } finally {
      setServiceBusy(false);
    }
  }

  async function handleUninstallService() {
    if (!isTauri() || serviceBusy) return;
    setServiceBusy(true);
    setSettingsError("");
    setConnectionError("");
    try {
      await invoke("uninstall_tun_service");
      if (running) clearSession();
      await refreshServiceStatus();
    } catch (e) {
      const msg = typeof e === "string" ? e : e instanceof Error ? e.message : "卸载后台服务失败";
      setSettingsError(msg);
      setConnectionError(msg);
    } finally {
      setServiceBusy(false);
    }
  }

  async function saveSettings(edit: (previous: Workspace) => Workspace) {
    setSettingsError("");
    try {
      await work.commit(edit);
    } catch (e) {
      setSettingsError(typeof e === "string" ? e : e instanceof Error ? e.message : "设置保存失败");
    }
  }

  function resetDiagnostics() {
    diagnosticsEpoch.current += 1;
    setDiagnosticsVersion(diagnosticsEpoch.current);
    setChecking(false);
    setExitIp(undefined);
    setExitIpError("");
    setCheckResult("");
  }

  function clearSession() {
    session.current = undefined;
    confirmedSession.current = null;
    setRunning(false);
    setRecovering(false);
    setRecoveryMessage("");
    setNodeHealth(null);
    setRunningNode(undefined);
    setRunningOriginal(undefined);
    setLiveRouting(undefined);
    setPort(undefined);
    setProxyTampered(false);
    setTrayMihomoGroup(undefined);
    setAppliedRulesKey("");
    resetDiagnostics();
  }

  useEffect(() => {
    if (!isTauri() || busy || !running) return;
    let cancelled = false;
    let timer: number;
    let ticks = 0;
    async function poll() {
      try {
        const status = await invoke<ProxyStatus>("proxy_status");
        if (cancelled || status.phase === "busy") return;
        if (status.phase === "stopped") clearSession();
        if (status.phase === "running" && status.session_id) {
          if (confirmedSession.current && confirmedSession.current !== status.session_id) resetDiagnostics();
          confirmedSession.current = status.session_id;
          const plan = session.current;
          if (plan && status.node_tag && plan.config.outbounds[0].default !== status.node_tag) {
            const standby = Array.from(plan.loaded.values()).find(node => node.tag === status.node_tag);
            if (standby) {
              session.current = withSelectedOutbound(plan, standby.tag);
              setRunningNode(standby.node);
              resetDiagnostics();
            }
          }
          if (mode === "system" && port && ticks % 3 === 0) {
            void invoke<boolean>("check_system_proxy_active", { port })
              .then(active => { if (!cancelled) setProxyTampered(!active); })
              .catch(() => {});
          } else if (mode !== "system") {
            setProxyTampered(false);
          }
          if (runningOriginal && ticks % 5 === 0) {
            void invoke<{ name: string; kind: string; selected: string; choices: string[]; manual: boolean }[]>("mihomo_groups")
              .then(groups => {
                if (cancelled) return;
                const primary = groups.find(g => g.manual && g.name !== "GLOBAL" && g.choices.length > 0)
                  ?? groups.find(g => g.manual && g.choices.length > 0);
                if (primary) {
                  setTrayMihomoGroup({ name: primary.name, selected: primary.selected, choices: primary.choices });
                }
              })
              .catch(() => {});
          }
          ticks++;
        }
        setRecovering(status.phase === "recovering");
        setRecoveryMessage(status.message ?? "");
        setNodeHealth(status.node_health ?? null);
        if (status.phase === "recovering" && confirmedSession.current) {
          confirmedSession.current = null;
          resetDiagnostics();
        }
      } catch {
        // Keep last confirmed UI state during transient IPC stalls.
      } finally {
        if (!cancelled) timer = window.setTimeout(poll, 1000);
      }
    }
    timer = window.setTimeout(poll, 600);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [busy, mode, port, running, runningOriginal]);

  useEffect(() => {
    if (!isTauri() || !work.ready) return;
    void invoke("configure_recovery", { enabled: autoReconnect }).catch(() =>
      setSettingsError("无法更新当前会话的自动恢复设置"),
    );
  }, [autoReconnect, work.ready]);

  useEffect(() => {
    if (!isTauri() || !running || runningOriginal || !work.ready) return;
    void invoke("configure_failover", { enabled: autoFailover, fallbackGroups: fallbackGroups(session.current, subscriptions, starred, latencies) })
      .catch(() => setSettingsError("无法更新当前会话的自动换线设置"));
  }, [autoFailover, running, runningOriginal, starred, subscriptions, work.ready]);

  const preferred = nodes.find(n => n.id === selected);
  const current = running ? runningNode ?? preferred : preferred;

  useEffect(() => {
    if (!isTauri() || !work.ready) return;
    const base = originalName
      ? `${originalName} (Mihomo)`
      : current?.name ?? "未选择节点";
    const summary = running && port ? `${base} · 127.0.0.1:${port}` : base;

    const actions: (() => void)[] = [];
    let quickChoices: { id: string; label: string; selected: boolean }[] = [];
    if (runningOriginal && trayMihomoGroup && liveOriginalProfile) {
      const skip = new Set(["DIRECT", "REJECT", "REJECT-DROP", "PASS"]);
      const ranked = trayMihomoGroup.choices
        .filter(c => c === trayMihomoGroup.selected || (!skip.has(c) && !isInfoNodeName(c)))
        .sort((a, b) => {
          if (a === trayMihomoGroup.selected) return -1;
          if (b === trayMihomoGroup.selected) return 1;
          const da = mihomoDelays[a];
          const db = mihomoDelays[b];
          return (typeof da === "number" && da > 0 ? da : 999_999) - (typeof db === "number" && db > 0 ? db : 999_999);
        })
        .slice(0, 8);
      quickChoices = ranked.map((choice, index) => {
        const delay = mihomoDelays[choice];
        const suffix = typeof delay === "number" && delay > 0 ? ` (${delay} ms)` : "";
        actions.push(() => {
          void invoke("switch_mihomo_group", { group: trayMihomoGroup.name, choice })
            .then(async () => {
              setTrayMihomoGroup(prev => (prev ? { ...prev, selected: choice } : prev));
              resetDiagnostics();
              await saveSettings(state => ({
                ...state,
                subscriptions: state.subscriptions.map(profile =>
                  profile.id === runningOriginal.id
                    ? { ...profile, mihomoSelections: { ...profile.mihomoSelections, [trayMihomoGroup.name]: choice } }
                    : profile,
                ),
              }));
            })
            .catch(() => {});
        });
        return {
          id: String(index),
          label: `${choice.slice(0, 36)}${suffix}`,
          selected: choice === trayMihomoGroup.selected,
        };
      });
    } else {
      const candidates = nodes
        .filter(n => !unavailableNodes.get(n.id) && !isInfoNodeName(n.name))
        .sort((a, b) => {
          const aSel = current?.id === a.id ? 1 : 0;
          const bSel = current?.id === b.id ? 1 : 0;
          if (aSel !== bSel) return bSel - aSel;
          const starDiff = Number(starred.has(b.id)) - Number(starred.has(a.id));
          if (starDiff !== 0) return starDiff;
          return (latencies[a.id]?.milliseconds ?? Number.MAX_SAFE_INTEGER)
            - (latencies[b.id]?.milliseconds ?? Number.MAX_SAFE_INTEGER);
        })
        .slice(0, 8);
      quickChoices = candidates.map((node, index) => {
        const rec = latencies[node.id];
        const suffix = rec?.milliseconds != null ? ` (${rec.milliseconds} ms)` : "";
        actions.push(() => {
          void selectNode(node);
        });
        return {
          id: String(index),
          label: `${node.name.slice(0, 36)}${suffix}`,
          selected: current?.id === node.id,
        };
      });
    }
    trayPickRef.current = actions;
    void invoke("update_tray_state", {
      running,
      summary,
      routingMode,
      entryMode: mode,
      quickChoices,
    }).catch(() => {});
  }, [current?.id, current?.name, latencies, liveOriginalProfile, mihomoDelays, mode, nodes, originalName, port, routingMode, running, runningOriginal, starred, trayMihomoGroup, unavailableNodes, work.ready]);

  const activeFilter = subscriptions.find(profile => profile.id === subscriptionFilter);
  function probe(node: NodeProfile) {
    const value = latencies[node.id];
    return value?.revision === nodeRevision(node) ? value : undefined;
  }

  const nodeSubName = useMemo(() => {
    const map = new Map<string, string>();
    for (const sub of subscriptions) {
      for (const n of sub.parsed.nodes) map.set(n.id, sub.name);
    }
    return map;
  }, [subscriptions]);

  const regionCounts = useMemo(() => {
    const source = activeFilter?.parsed.nodes ?? nodes;
    const counts = new Map<string, number>();
    for (const n of source) {
      const reg = nodeRegion(n.name);
      counts.set(reg, (counts.get(reg) ?? 0) + 1);
    }
    return Array.from(counts.entries());
  }, [activeFilter, nodes]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const list = (activeFilter?.parsed.nodes ?? nodes).filter(n => {
      if (onlyFavorites && !starred.has(n.id)) return false;
      if (onlySupported && unavailableNodes.get(n.id)) return false;
      if (protocolFilter && n.protocol !== protocolFilter) return false;
      if (regionFilter && nodeRegion(n.name) !== regionFilter) return false;
      if (!q) return true;
      return `#${n.sourceIndex ?? ""} ${n.name} ${n.protocol} ${n.server}`.toLowerCase().includes(q);
    });
    if (nodeSort === "latency") {
      return [...list].sort(
        (a, b) => (probe(a)?.milliseconds ?? Number.MAX_SAFE_INTEGER) - (probe(b)?.milliseconds ?? Number.MAX_SAFE_INTEGER),
      );
    }
    if (nodeSort === "name") {
      return [...list].sort((a, b) => a.name.localeCompare(b.name, "zh-CN"));
    }
    return list;
  }, [activeFilter, latencies, nodeSort, nodes, onlyFavorites, onlySupported, protocolFilter, regionFilter, search, starred, unavailableNodes]);

  const quickNodes = useMemo(() => {
    const usable = nodes.filter(n => !unavailableNodes.get(n.id));
    const sorted = [...usable].sort((a, b) => {
      const activeDiff = Number(b.id === (runningNode?.id ?? selected)) - Number(a.id === (runningNode?.id ?? selected));
      if (activeDiff !== 0) return activeDiff;
      const starDiff = Number(starred.has(b.id)) - Number(starred.has(a.id));
      if (starDiff !== 0) return starDiff;
      return (probe(a)?.milliseconds ?? Number.MAX_SAFE_INTEGER) - (probe(b)?.milliseconds ?? Number.MAX_SAFE_INTEGER);
    });
    return sorted.slice(0, 6);
  }, [latencies, nodes, runningNode?.id, selected, starred, unavailableNodes]);

  async function importSubscription(text: string, request?: SubscriptionRequest, customName?: string) {
    setImporting(true);
    setError("");
    try {
      const original = await work.add(text, request, customName);
      setSubscriptionFilter("");
      setDialog(false);
      setPage(original ? "概览" : "节点");
    } catch (e) {
      setError(typeof e === "string" ? e : e instanceof Error ? e.message : "导入失败");
    } finally {
      setImporting(false);
    }
  }

  const isSelected = (node: NodeProfile) =>
    !originalName &&
    (running
      ? runningNode?.id === node.id && nodeRevision(runningNode) === nodeRevision(node)
      : node.id === selected);

  async function repairSystemProxy() {
    if (!port || busy || recovering) return;
    setBusy(true);
    setConnectionError("");
    try {
      await invoke("repair_system_proxy", { port, bypass: systemProxyBypass });
      setProxyTampered(false);
      void checkProxy(port, true);
    } catch (e) {
      setConnectionError(typeof e === "string" ? e : "恢复系统代理失败");
    } finally {
      setBusy(false);
    }
  }

  async function checkProxy(targetPort = port, automatic = false) {
    if (!targetPort || (!automatic && (busy || recovering))) return;
    lastProbeAt.current = Date.now();
    const epoch = diagnosticsEpoch.current;
    setChecking(true);
    setCheckResult(automatic ? "正在验证外网连通性…" : "");
    try {
      const ms = await invoke<number>("check_connection", { port: targetPort, probeUrl });
      if (epoch === diagnosticsEpoch.current) setCheckResult(`连通正常 · ${ms} ms`);
    } catch (e) {
      if (epoch !== diagnosticsEpoch.current) return;
      const loaded = session.current?.loaded;
      if (automatic && runningOriginal && routingMode !== "direct") {
        setCheckResult("当前 Mihomo 出口无响应，正在自动测速并切线…");
        try {
          type MGroup = { name: string; kind: string; selected: string; choices: string[]; manual: boolean };
          const groups = await invoke<MGroup[]>("mihomo_groups");
          if (epoch !== diagnosticsEpoch.current) return;
          const skipNames = new Set(["DIRECT", "REJECT", "REJECT-DROP", "PASS"]);
          const primary = groups.find(g => g.manual && g.name !== "GLOBAL" && g.choices.some(c => !skipNames.has(c)))
            ?? groups.find(g => g.manual && g.choices.some(c => !skipNames.has(c)));
          if (primary) {
            const delays = await invoke<Record<string, number>>("probe_mihomo_group", {
              group: primary.name,
              probeUrl,
              timeoutMs: 4200,
            });
            if (epoch !== diagnosticsEpoch.current) return;
            setMihomoDelays(prev => ({ ...prev, ...delays }));
            const ranked = primary.choices
              .filter(c => !skipNames.has(c) && !isInfoNodeName(c) && typeof delays[c] === "number" && delays[c] > 0)
              .sort((a, b) => delays[a] - delays[b]);
            const bestChoice = ranked[0];
            if (bestChoice && bestChoice !== primary.selected) {
              await invoke("switch_mihomo_group", { group: primary.name, choice: bestChoice });
              await saveSettings(state => ({
                ...state,
                subscriptions: state.subscriptions.map(profile =>
                  profile.id === runningOriginal.id
                    ? { ...profile, mihomoSelections: { ...profile.mihomoSelections, [primary.name]: bestChoice } }
                    : profile,
                ),
              }));
              const verifiedMs = await invoke<number>("check_connection", { port: targetPort, probeUrl });
              if (epoch === diagnosticsEpoch.current) {
                setCheckResult(`已自动在「${primary.name}」切至「${bestChoice}」· ${verifiedMs} ms`);
              }
              return;
            }
          }
        } catch { /* fall through to error status */ }
        if (epoch === diagnosticsEpoch.current) {
          setCheckResult("Mihomo 当前出口无法访问外网，请在策略组切换可用节点");
        }
        return;
      }
      if (automatic && !runningOriginal && routingMode !== "direct" && loaded && loaded.size > 1) {
        setCheckResult("当前节点无响应，正在自动匹配可用节点…");
        const candidates = Array.from(loaded.values())
          .filter(entry => entry.tag !== "node-0")
          .sort((a, b) => {
            const starDiff = Number(starred.has(b.node.id)) - Number(starred.has(a.node.id));
            if (starDiff !== 0) return starDiff;
            return (probe(a.node)?.milliseconds ?? Number.MAX_SAFE_INTEGER)
              - (probe(b.node)?.milliseconds ?? Number.MAX_SAFE_INTEGER);
          })
          .slice(0, 24);
        const reachable: { entry: (typeof candidates)[number]; ms: number }[] = [];
        let cursor = 0;
        async function rescueWorker() {
          while (cursor < candidates.length && epoch === diagnosticsEpoch.current) {
            const entry = candidates[cursor++];
            try {
              const ms = await invoke<number>("probe_loaded_node", {
                tag: entry.tag,
                probeUrl,
                timeoutMs: 3800,
              });
              reachable.push({ entry, ms });
              if (reachable.length >= 3) break;
            } catch { /* skip unreachable */ }
          }
        }
        await Promise.all(Array.from({ length: Math.min(6, candidates.length) }, rescueWorker));
        if (epoch !== diagnosticsEpoch.current) return;
        reachable.sort((a, b) => a.ms - b.ms);
        const best = reachable[0];
        if (best) {
          try {
            await invoke("switch_proxy_node", { tag: best.entry.tag });
            session.current = withSelectedOutbound(session.current!, best.entry.tag);
            setRunningNode(best.entry.node);
            const rev = nodeRevision(best.entry.node);
            const record: LatencyRecord = { revision: rev, label: `${best.ms} ms`, milliseconds: best.ms, testedAt: Date.now() };
            setLatencies(prev => ({ ...prev, [best.entry.node.id]: record }));
            await saveSettings(state => ({
              ...state,
              selected: preferredNode(state.subscriptions, best.entry.node.id),
              nodeLatencies: { ...state.nodeLatencies, [best.entry.node.id]: record },
            }));
            const verifiedMs = await invoke<number>("check_connection", { port: targetPort, probeUrl });
            if (epoch === diagnosticsEpoch.current) {
              setCheckResult(`已自动切至「${best.entry.node.name}」· ${verifiedMs} ms`);
            }
            return;
          } catch { /* fall through to failure display */ }
        }
        if (epoch === diagnosticsEpoch.current) {
          setCheckResult("当前节点及备用节点均无法访问外网，请检查网络或订阅");
        }
        return;
      }
      const message = typeof e === "string" ? e : "网络验证失败";
      setCheckResult(automatic ? `端口已就绪但无法出站：${message}` : message);
    } finally {
      if (epoch === diagnosticsEpoch.current) setChecking(false);
    }
  }

  async function prepareSession(node: NodeProfile, localPort: number): Promise<SessionPlan> {
    const candidate = buildSessionConfig(node, nodes, localPort, rules, ruleDefaultAction, ruleSets);
    if (await invoke<boolean>("validate_proxy_config", { config: candidate.config })) return candidate;
    const single = buildConfig(node, localPort, rules, ruleDefaultAction, ruleSets);
    if (!(await invoke<boolean>("validate_proxy_config", { config: single }))) {
      throw new Error("所选节点、分流规则或远程规则集未通过内核配置检查");
    }
    return { config: single, loaded: new Map() };
  }

  function startProxy(plan: SessionPlan) {
    return invoke("start_proxy", {
      config: plan.config,
      mode,
      routingMode,
      autoReconnect,
      autoFailover,
      fallbackGroups: fallbackGroups(plan, subscriptions, starred, latencies),
      allowLan,
      bypass: systemProxyBypass,
      tunIpv6,
    });
  }

  async function changeRouting(value: RoutingMode) {
    if (busy || recovering || value === routingMode) return;
    setBusy(true);
    setConnectionError("");
    try {
      if (running) {
        await invoke("set_routing_mode", { mode: value });
        setLiveRouting(value);
        resetDiagnostics();
      }
      const targetOriginalId = running ? runningOriginal?.id : originalProfile?.id;
      await saveSettings(state =>
        targetOriginalId
          ? {
              ...state,
              subscriptions: state.subscriptions.map(profile =>
                profile.id === targetOriginalId ? { ...profile, mihomoMode: value } : profile,
              ),
            }
          : { ...state, routingMode: value },
      );
    } catch (e) {
      setConnectionError(typeof e === "string" ? e : "路由模式切换失败");
    } finally {
      setBusy(false);
    }
  }

  async function connectNode(node: NodeProfile) {
    if (busy || recovering || !isTauri() || unavailableNodes.get(node.id)) return;
    const remember = () =>
      saveSettings(state => ({
        ...state,
        selected: preferredNode(state.subscriptions, node.id),
        mihomoProfile: undefined,
      }));
    const previous = session.current;
    if (running && !runningOriginal && port && previous) {
      if (isSelected(node)) return;
      setBusy(true);
      setConnectionError("");
      resetDiagnostics();
      try {
        const loaded = previous.loaded.get(node.id);
        if (loaded && loaded.revision === nodeRevision(node)) {
          await invoke("switch_proxy_node", { tag: loaded.tag });
          session.current = withSelectedOutbound(previous, loaded.tag);
          setRunningNode(node);
          await remember();
          void checkProxy(port, true);
          return;
        }
        const next = await prepareSession(node, port);
        confirmedSession.current = null;
        await invoke("stop_proxy");
        try {
          await startProxy(next);
          session.current = next;
          setRunningNode(node);
          setRunning(true);
          setAppliedRulesKey(currentRulesKey);
          await remember();
          void checkProxy(port, true);
        } catch (failure) {
          try {
            await startProxy(previous);
            setRunning(true);
          } catch {
            clearSession();
          }
          throw failure;
        }
      } catch (e) {
        setConnectionError(`切换失败：${typeof e === "string" ? e : e instanceof Error ? e.message : "未知错误"}`);
      } finally {
        setBusy(false);
      }
      return;
    }

    setBusy(true);
    setConnectionError("");
    resetDiagnostics();
    setRecoveryMessage("");
    try {
      if (running) {
        await invoke("stop_proxy");
        clearSession();
      }
      await remember();
      const localPort = proxyPort ?? (await invoke<number>("allocate_stable_port"));
      const next = await prepareSession(node, localPort);
      await invoke("start_proxy", {
        config: next.config,
        mode,
        routingMode: work.workspace.routingMode,
        autoReconnect,
        autoFailover,
        fallbackGroups: fallbackGroups(next, subscriptions, starred, latencies),
        allowLan,
        bypass: systemProxyBypass,
        tunIpv6,
      });
      session.current = next;
      setRunningNode(node);
      setLiveRouting(work.workspace.routingMode);
      setAppliedRulesKey(currentRulesKey);
      setPort(localPort);
      setRunning(true);
      void checkProxy(localPort, true);
    } catch (e) {
      setConnectionError(typeof e === "string" ? e : e instanceof Error ? e.message : "连接失败");
    } finally {
      setBusy(false);
    }
  }

  async function selectNode(node: NodeProfile) {
    if (busy || recovering || unavailableNodes.get(node.id)) return;
    if (running) {
      await connectNode(node);
      return;
    }
    await saveSettings(state => ({
      ...state,
      selected: preferredNode(state.subscriptions, node.id),
      mihomoProfile: undefined,
    }));
  }

  async function switchToOriginal(profileId: string) {
    const profile = subscriptions.find(item => item.id === profileId && item.parsed.mihomo);
    if (!profile?.parsed.mihomo || busy || recovering) return;
    if (!running) {
      await saveSettings(state => ({ ...state, mihomoProfile: profile.id }));
      setPage("概览");
      return;
    }
    setBusy(true);
    setConnectionError("");
    resetDiagnostics();
    try {
      await invoke("stop_proxy");
      clearSession();
      await saveSettings(state => ({ ...state, mihomoProfile: profile.id }));
      const localPort = proxyPort ?? (await invoke<number>("allocate_stable_port"));
      const originalMode =
        profile.mihomoMode ??
        (profile.parsed.mihomo.mode === "global" || profile.parsed.mihomo.mode === "direct"
          ? profile.parsed.mihomo.mode
          : "rule");
      await invoke("start_mihomo", {
        config: buildMihomoConfig(profile.parsed.mihomo),
        port: localPort,
        mode,
        routingMode: originalMode,
        autoReconnect,
        selections: profile.mihomoSelections,
        allowLan,
        bypass: systemProxyBypass,
        tunIpv6,
      });
      setRunningOriginal({ id: profile.id, name: profile.name, content: profile.content });
      setLiveRouting(originalMode);
      setAppliedRulesKey(currentRulesKey);
      setPort(localPort);
      setRunning(true);
      setPage("概览");
      void checkProxy(localPort, true);
    } catch (e) {
      setConnectionError(typeof e === "string" ? e : e instanceof Error ? e.message : "切换原配置失败");
    } finally {
      setBusy(false);
    }
  }

  async function switchBackToNodeMode() {
    if (busy || recovering) return;
    const fallbackNode = preferred ?? nodes.find(n => !unavailableNodes.get(n.id));
    if (!running) {
      await saveSettings(state => ({ ...state, mihomoProfile: undefined }));
      return;
    }
    if (!fallbackNode) {
      await invoke("stop_proxy");
      clearSession();
      await saveSettings(state => ({ ...state, mihomoProfile: undefined }));
      return;
    }
    await connectNode(fallbackNode);
  }

  async function testNodes(items: NodeProfile[]): Promise<Record<string, LatencyRecord>> {
    if (!isTauri() || testing) return {};
    if (probeMode === "url" && running && runningOriginal && mode === "tun") {
      setConnectionError("Mihomo TUN 运行期间不支持直接对 sing-box 节点做 URL 测速（会产生回环延迟）。请使用「Mihomo 策略组」测速，或切换为「TCP 握手延迟」。");
      return {};
    }
    cancelTesting.current = false;
    setTesting(true);
    setConnectionError("");
    const queue = items.filter(node => !unavailableNodes.get(node.id));
    if (!queue.length) {
      setTesting(false);
      return {};
    }
    setProbeProgress({ done: 0, total: queue.length });
    const updates: Record<string, LatencyRecord> = {};
    let doneCount = 0;

    try {
      const loadedMap = running && !runningOriginal ? session.current?.loaded : undefined;
      let tempSessionId: string | undefined;
      let tempTags = new Map<string, string>();

      if (probeMode === "url") {
        const unloaded = queue.filter(node => {
          const loaded = loadedMap?.get(node.id);
          return !(loaded && loaded.revision === nodeRevision(node) && !recovering);
        });
        if (unloaded.length > 0) {
          const plan = buildSessionConfig(unloaded[0], unloaded, 18080, []);
          tempSessionId = await invoke<string>("start_probe_session", { config: plan.config });
          probeSessionId.current = tempSessionId;
          for (const [id, info] of plan.loaded.entries()) {
            tempTags.set(id, info.tag);
          }
        }
      }

      let next = 0;
      const concurrency = probeMode === "tcp" ? 10 : 6;

      async function testQueue() {
        while (next < queue.length && !cancelTesting.current) {
          const node = queue[next++];
          const rev = nodeRevision(node);
          setLatencies(previous => ({ ...previous, [node.id]: { revision: rev, label: "测试中…" } }));
          let label: string;
          let milliseconds: number | undefined;
          try {
            if (probeMode === "tcp") {
              const ms = await invoke<number>("probe_tcp_latency", {
                server: node.server,
                port: node.port,
                timeoutMs: 3500,
              });
              milliseconds = ms;
              label = `${ms} ms (TCP)`;
            } else {
              const loaded = loadedMap?.get(node.id);
              if (loaded && loaded.revision === rev && !recovering) {
                const ms = await invoke<number>("probe_loaded_node", {
                  tag: loaded.tag,
                  probeUrl,
                  timeoutMs: 5000,
                });
                milliseconds = ms;
                label = `${ms} ms`;
              } else if (tempSessionId && tempTags.has(node.id)) {
                const ms = await invoke<number>("probe_session_node", {
                  session: tempSessionId,
                  tag: tempTags.get(node.id)!,
                  probeUrl,
                  timeoutMs: 5000,
                });
                milliseconds = ms;
                label = `${ms} ms`;
              } else {
                const batch = probeBatch.current ?? (await invoke<string>("begin_probe_batch"));
                probeBatch.current = batch;
                const localPort = await invoke<number>("allocate_port");
                const ms = await invoke<number>("probe_node", {
                  config: buildConfig(node, localPort),
                  port: localPort,
                  batch,
                  probeUrl,
                });
                milliseconds = ms;
                label = `${ms} ms`;
              }
            }
          } catch (e) {
            label = cancelTesting.current ? "已取消" : typeof e === "string" ? e : "测速失败";
          }
          const record: LatencyRecord = {
            revision: rev,
            label,
            milliseconds,
            testedAt: Date.now(),
          };
          updates[node.id] = record;
          doneCount += 1;
          setProbeProgress({ done: doneCount, total: queue.length });
          setLatencies(previous => ({ ...previous, [node.id]: record }));
        }
      }

      await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, testQueue));
      if (Object.keys(updates).length) {
        await saveSettings(state => ({
          ...state,
          nodeLatencies: { ...state.nodeLatencies, ...updates },
        }));
      }
    } catch (e) {
      setConnectionError(typeof e === "string" ? e : "启动测速失败");
    } finally {
      const sid = probeSessionId.current;
      probeSessionId.current = undefined;
      if (sid) await invoke("stop_probe_session", { session: sid }).catch(() => {});
      const batch = probeBatch.current;
      probeBatch.current = undefined;
      if (batch) await invoke("cancel_probe_batch", { batch }).catch(() => {});
      setProbeProgress(undefined);
      setTesting(false);
    }
    return updates;
  }

  function stopNodeTests() {
    cancelTesting.current = true;
    const sid = probeSessionId.current;
    if (sid) void invoke("stop_probe_session", { session: sid }).catch(() => {});
    const batch = probeBatch.current;
    if (batch) void invoke("cancel_probe_batch", { batch }).catch(() => setConnectionError("无法取消正在运行的测速"));
  }

  async function pickFastestNode() {
    let candidates = filtered
      .filter(n => !unavailableNodes.get(n.id))
      .map(n => ({ node: n, ms: probe(n)?.milliseconds }))
      .filter((item): item is { node: NodeProfile; ms: number } => typeof item.ms === "number")
      .sort((a, b) => a.ms - b.ms);
    if (!candidates.length && !testing) {
      const updates = await testNodes(filtered);
      candidates = filtered
        .filter(n => !unavailableNodes.get(n.id))
        .map(n => ({ node: n, ms: updates[n.id]?.milliseconds ?? probe(n)?.milliseconds }))
        .filter((item): item is { node: NodeProfile; ms: number } => typeof item.ms === "number")
        .sort((a, b) => a.ms - b.ms);
    }
    if (!candidates.length) {
      setConnectionError("未测出可用节点，请检查网络或订阅内容。");
      return;
    }
    void connectNode(candidates[0].node);
  }

  async function refreshAllSubscriptions() {
    const remote = subscriptions.filter(s => !!s.source);
    await Promise.all(remote.map(s => work.refresh(s.id).catch(() => {})));
  }

  async function showExitIp() {
    if (!port || busy || recovering) return;
    const epoch = diagnosticsEpoch.current;
    setChecking(true);
    setExitIpError("");
    try {
      const detail = await invoke<ExitIpDetail>("check_exit_ip_detail", { port });
      if (epoch === diagnosticsEpoch.current) setExitIp(detail);
    } catch (e) {
      if (epoch === diagnosticsEpoch.current) setExitIpError(typeof e === "string" ? e : "查询失败");
    } finally {
      if (epoch === diagnosticsEpoch.current) setChecking(false);
    }
  }

  async function testLocalTcp() {
    setLocalTcpBusy(true);
    try {
      const ms = await invoke<number>("local_tcp_google");
      setLocalTcp(`${ms} ms · ${new Date().toLocaleTimeString()}`);
    } catch (e) {
      setLocalTcp(typeof e === "string" ? e : "测试失败");
    } finally {
      setLocalTcpBusy(false);
    }
  }

  async function applyOriginalUpdate(overrideOverride?: MihomoOverride) {
    const next = liveOriginalProfile;
    if (busy || recovering || !runningOriginal || !next?.parsed.mihomo) return;
    setBusy(true);
    setConnectionError("");
    try {
      const usedOverride = overrideOverride ?? mihomoOverride;
      await invoke("reload_mihomo", {
        config: buildMihomoConfig(next.parsed.mihomo, usedOverride),
      });
      setRunningOriginal({ id: next.id, name: next.name, content: next.content });
      setAppliedRulesKey(JSON.stringify({ rules, ruleDefaultAction, ruleSets, mihomoOverride: usedOverride }));
      resetDiagnostics();
    } catch (failure) {
      setConnectionError(typeof failure === "string" ? failure : "配置更新失败");
    } finally {
      setBusy(false);
    }
  }

  async function startActiveWithEntry(entryModeOverride?: EntryMode) {
    const targetMode = entryModeOverride ?? mode;
    const original = originalProfile?.parsed.mihomo;
    if (!original && !preferred) throw new Error("请先导入并选择节点或原配置");
    const localPort = proxyPort ?? (await invoke<number>("allocate_stable_port"));
    if (original && originalProfile) {
      const originalMode =
        originalProfile.mihomoMode ??
        (original.mode === "global" || original.mode === "direct" ? original.mode : "rule");
      await invoke("start_mihomo", {
        config: buildMihomoConfig(original),
        port: localPort,
        mode: targetMode,
        routingMode: originalMode,
        autoReconnect,
        selections: originalProfile.mihomoSelections,
        allowLan,
        bypass: systemProxyBypass,
        tunIpv6,
      });
      setRunningOriginal({ id: originalProfile.id, name: originalProfile.name, content: originalProfile.content });
      setLiveRouting(originalMode);
      setAppliedRulesKey(currentRulesKey);
    } else if (preferred) {
      const next = await prepareSession(preferred, localPort);
      await invoke("start_proxy", {
        config: next.config,
        mode: targetMode,
        routingMode,
        autoReconnect,
        autoFailover,
        fallbackGroups: fallbackGroups(next, subscriptions, starred, latencies),
        allowLan,
        bypass: systemProxyBypass,
        tunIpv6,
      });
      session.current = next;
      setRunningNode(preferred);
      setLiveRouting(routingMode);
      setAppliedRulesKey(currentRulesKey);
    }
    setPort(localPort);
    setRunning(true);
    void checkProxy(localPort, true);
  }

  async function switchEntryFromTray(nextEntry: EntryMode) {
    if (busy || recovering || !work.ready || nextEntry === mode) return;
    await saveSettings(state => ({ ...state, entryMode: nextEntry }));
    if (!running) return;
    setBusy(true);
    setConnectionError("");
    resetDiagnostics();
    try {
      await invoke("stop_proxy");
      clearSession();
      await startActiveWithEntry(nextEntry);
    } catch (e) {
      clearSession();
      setConnectionError(typeof e === "string" ? e : e instanceof Error ? e.message : "切换接管模式失败");
    } finally {
      setBusy(false);
    }
  }

  async function toggleProxy() {
    setBusy(true);
    setConnectionError("");
    resetDiagnostics();
    setRecoveryMessage("");
    try {
      if (!isTauri()) throw new Error("请在桌面应用中连接");
      if (running) {
        await invoke("stop_proxy");
        clearSession();
      } else {
        await startActiveWithEntry();
      }
    } catch (e) {
      setConnectionError(typeof e === "string" ? e : e instanceof Error ? e.message : "连接失败");
    } finally {
      setBusy(false);
    }
  }

  async function reconnectNodeSession() {
    if (!running || runningOriginal || !current) return;
    setBusy(true);
    setConnectionError("");
    resetDiagnostics();
    try {
      await invoke("stop_proxy");
      const localPort = proxyPort ?? (await invoke<number>("allocate_stable_port"));
      const next = await prepareSession(current, localPort);
      await startProxy(next);
      session.current = next;
      setRunningNode(current);
      setLiveRouting(routingMode);
      setAppliedRulesKey(currentRulesKey);
      setPort(localPort);
      setRunning(true);
      void checkProxy(localPort, true);
    } catch (e) {
      clearSession();
      setConnectionError(typeof e === "string" ? e : e instanceof Error ? e.message : "重连失败");
    } finally {
      setBusy(false);
    }
  }

  const toggleProxyRef = useRef(toggleProxy);
  toggleProxyRef.current = toggleProxy;
  const changeRoutingRef = useRef(changeRouting);
  changeRoutingRef.current = changeRouting;
  const switchEntryRef = useRef(switchEntryFromTray);
  switchEntryRef.current = switchEntryFromTray;
  const checkProxyRef = useRef(checkProxy);
  checkProxyRef.current = checkProxy;
  const routingModeRef = useRef(routingMode);
  routingModeRef.current = routingMode;
  const runningStateRef = useRef({ running, recovering, busy, port, mode });
  runningStateRef.current = { running, recovering, busy, port, mode };

  useEffect(() => {
    if (!isTauri()) return;
    let unlistenTray: (() => void) | undefined;
    let unlistenHotkey: (() => void) | undefined;
    let unlistenNetWatch: (() => void) | undefined;

    void listen<string>("tray-action", event => {
      const action = event.payload;
      if (action === "toggle") void toggleProxyRef.current();
      else if (action === "mode:rule") void changeRoutingRef.current("rule");
      else if (action === "mode:global") void changeRoutingRef.current("global");
      else if (action === "mode:direct") void changeRoutingRef.current("direct");
      else if (action === "entry:system") void switchEntryRef.current("system");
      else if (action === "entry:tun") void switchEntryRef.current("tun");
      else if (action === "entry:local") void switchEntryRef.current("local");
      else if (action.startsWith("pick:")) {
        const idx = Number(action.slice(5));
        if (Number.isInteger(idx) && trayPickRef.current[idx]) {
          trayPickRef.current[idx]();
        }
      }
    }).then(fn => { unlistenTray = fn; });

    void listen<string>("hotkey-action", event => {
      if (event.payload === "toggle") {
        void toggleProxyRef.current();
      } else if (event.payload === "cycle-routing") {
        const order: RoutingMode[] = ["rule", "global", "direct"];
        const next = order[(order.indexOf(routingModeRef.current) + 1) % order.length];
        void changeRoutingRef.current(next);
      }
    }).then(fn => { unlistenHotkey = fn; });

    void listen<{ kind: string }>("network-watch", event => {
      if (event.payload.kind !== "interface" && event.payload.kind !== "resume") return;
      const cur = runningStateRef.current;
      if (!cur.running || cur.recovering || cur.busy || !cur.port) return;
      if (cur.mode === "system") {
        void invoke<boolean>("check_system_proxy_active", { port: cur.port })
          .then(active => setProxyTampered(!active))
          .catch(() => {});
      }
      if (Date.now() - lastProbeAt.current >= 3000) {
        void checkProxyRef.current(cur.port, true);
      }
    }).then(fn => { unlistenNetWatch = fn; });

    return () => {
      unlistenTray?.();
      unlistenHotkey?.();
      unlistenNetWatch?.();
    };
  }, []);

  useEffect(() => {
    if (!isTauri() || !running || recovering || busy || !port) return;
    function reprobeOnResume() {
      if (document.visibilityState === "hidden") return;
      if (Date.now() - lastProbeAt.current < 15_000) return;
      void checkProxyRef.current(port, true);
    }
    window.addEventListener("online", reprobeOnResume);
    document.addEventListener("visibilitychange", reprobeOnResume);
    return () => {
      window.removeEventListener("online", reprobeOnResume);
      document.removeEventListener("visibilitychange", reprobeOnResume);
    };
  }, [busy, port, recovering, running]);

  useEffect(() => {
    if (!isTauri() || !work.ready || autoConnectRan.current) return;
    autoConnectRan.current = true;
    if (autoConnect && !running && !busy && (originalProfile?.parsed.mihomo || preferred)) {
      void toggleProxy();
    }
  }, [autoConnect, busy, originalProfile?.parsed.mihomo, preferred, running, work.ready]);

  useEffect(() => {
    if (!dialog && !detailNode && !overrideModal) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key !== "Escape") return;
      if (detailNode) setDetailNode(undefined);
      else if (overrideModal) setOverrideModal(false);
      else if (dialog && !importing) setDialog(false);
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [detailNode, dialog, importing, overrideModal]);

  function copyLocalEndpoint() {
    if (!port) return;
    void navigator.clipboard.writeText(`127.0.0.1:${port}`).then(() => {
      setPortCopied(true);
      window.setTimeout(() => setPortCopied(false), 1600);
    }).catch(() => {});
  }

  function copyProxyEnv() {
    if (!port) return;
    const snippet = `$env:HTTP_PROXY="http://127.0.0.1:${port}"; $env:HTTPS_PROXY="http://127.0.0.1:${port}"`;
    void navigator.clipboard.writeText(snippet).then(() => {
      setEnvCopied(true);
      window.setTimeout(() => setEnvCopied(false), 1600);
    }).catch(() => {});
  }

  function cycleTheme() {
    const order: ThemeMode[] = ["system", "light", "dark"];
    const next = order[(order.indexOf(theme) + 1) % order.length];
    void saveSettings(state => ({ ...state, theme: next }));
  }

  const themeLabel = theme === "light" ? "浅色" : theme === "dark" ? "深色" : "跟随系统";
  const ThemeIcon = theme === "light" ? Sun : theme === "dark" ? Moon : SunMoon;
  const statusStateClass = recovering ? "is-recovering" : running ? "is-running" : "";
  const activeCount = telemetry.snapshot?.connections.length;
  const activeSub = liveOriginalProfile ?? originalProfile ?? (current ? subscriptions.find(s => s.parsed.nodes.some(n => n.id === current.id)) : undefined);
  const activeSubUsed = activeSub?.usage?.upload != null && activeSub?.usage?.download != null ? activeSub.usage.upload + activeSub.usage.download : null;
  const activeSubTotal = activeSub?.usage?.total;
  const activeSubExpiry = activeSub?.usage?.expire && Number.isFinite(activeSub.usage.expire * 1000)
    ? new Date(activeSub.usage.expire * 1000).toLocaleDateString()
    : undefined;
  const firstMihomoSub = subscriptions.find(s => s.parsed.mihomo);

  return (
    <div className="app">
      <aside>
        <div className="brand">
          <div className="brand-mark"><Cat size={18} /></div>
          <div>
            <strong>RelayDesk</strong>
            <small>v1.5.0</small>
          </div>
        </div>
        <nav>
          {navOrder.map(name => {
            const Icon = pageIcons[name];
            const badge = name === "节点" && nodes.length ? nodes.length
              : name === "订阅" && subscriptions.length ? subscriptions.length
              : name === "连接" && running && activeCount != null ? activeCount
              : undefined;
            return (
              <button
                className={page === name ? "active" : ""}
                onClick={() => setPage(name)}
                key={name}
              >
                <Icon size={17} />
                <span>{name}</span>
                {badge !== undefined && <span className="nav-badge">{badge}</span>}
              </button>
            );
          })}
        </nav>
        <TrafficSidebar telemetry={telemetry} />
      </aside>

      <div className="workspace">
        <header>
          <div className="header-left">
            <span className={`status-inline ${statusStateClass}`}>
              <span className="dot" />
              {recovering ? "正在恢复" : running ? (runningOriginal ? "Mihomo 运行中" : "sing-box 运行中") : "未连接"}
            </span>
            {running && port && (
              <>
                <button type="button" className="chip-button" onClick={copyLocalEndpoint} title="复制本地代理地址">
                  {portCopied ? <Check size={12} /> : <Copy size={12} />}
                  <span>{allowLan ? "0.0.0.0" : "127.0.0.1"}:{port}</span>
                </button>
                <button type="button" className="chip-button" onClick={copyProxyEnv} title="复制 PowerShell 终端/IDE 环境变量命令">
                  {envCopied ? <Check size={12} /> : <Terminal size={12} />}
                  <span>{envCopied ? "已复制变量" : "复制 env"}</span>
                </button>
              </>
            )}
          </div>
          <div className="header-right">
            {isTauri() && (
              <span className={`tag ${elevated ? "is-good" : ""}`} title={elevated ? "管理员权限" : "普通用户权限"}>
                {elevated ? <><ShieldCheck size={12} /> 管理员</> : <><ShieldAlert size={12} /> 普通权限</>}
              </span>
            )}
            <button type="button" className="chip-button" onClick={cycleTheme} title="切换主题">
              <ThemeIcon size={13} />
              <span>{themeLabel}</span>
            </button>
          </div>
        </header>

        <main>
          <div className="title">
            <h1>{page}</h1>
            <div className="title-actions">
              {["概览", "节点", "订阅"].includes(page) && (
                <button className="btn primary" disabled={!work.ready} onClick={() => setDialog(true)}>
                  <Plus size={16} />
                  导入订阅
                </button>
              )}
            </div>
          </div>

          {(work.storageError || settingsError) && (
            <p className="notice is-error" role="alert">{work.storageError || settingsError}</p>
          )}

          <div className="page-view" key={page}>
            {page === "概览" && (
              <OverviewPage
                running={running}
                recovering={recovering}
                busy={busy}
                checking={checking}
                testing={testing}
                port={port}
                allowLan={allowLan}
                mode={mode}
                routingMode={routingMode}
                connectionError={connectionError}
                recoveryMessage={recoveryMessage}
                checkResult={checkResult}
                originalName={originalName}
                current={current}
                runningOriginal={runningOriginal}
                originalUpdated={originalUpdated}
                proxyTampered={proxyTampered}
                rulesDirtyWhileRunning={rulesDirtyWhileRunning}
                elevated={elevated}
                serviceStatus={serviceStatus}
                serviceBusy={serviceBusy}
                workReady={work.ready}
                tunIpv6={tunIpv6}
                probeUrl={probeUrl}
                activeSubUsed={activeSubUsed}
                activeSubTotal={activeSubTotal}
                activeSubExpiry={activeSubExpiry}
                hasMihomoSub={!!firstMihomoSub}
                firstMihomoSubId={firstMihomoSub?.id}
                nodeHealth={nodeHealth}
                exitIp={exitIp}
                exitIpError={exitIpError}
                mihomoDelays={mihomoDelays}
                telemetry={telemetry}
                quickNodes={quickNodes}
                nodesCount={nodes.length}
                starred={starred}
                probe={probe}
                isSelected={isSelected}
                onCheckProxy={() => void checkProxy()}
                onChangeEntryMode={entryMode => void saveSettings(state => ({ ...state, entryMode }))}
                onChangeRouting={val => void changeRouting(val)}
                onToggleProxy={() => void toggleProxy()}
                onInstallService={() => void handleInstallService()}
                onRepairSystemProxy={() => void repairSystemProxy()}
                onApplyOriginalUpdate={() => void applyOriginalUpdate()}
                onReconnectNodeSession={() => void reconnectNodeSession()}
                onSwitchBackToNodeMode={() => void switchBackToNodeMode()}
                onSwitchToOriginal={id => void switchToOriginal(id)}
                onTestNode={node => void testNodes([node])}
                onShowExitIp={() => void showExitIp()}
                onMihomoDelays={setMihomoDelays}
                onOpenFullGroups={() => { setNodesTab("groups"); setPage("节点"); }}
                onSaveMihomoSelection={(profileId, group, choice) =>
                  saveSettings(state => ({
                    ...state,
                    subscriptions: state.subscriptions.map(profile =>
                      profile.id === profileId
                        ? { ...profile, mihomoSelections: { ...profile.mihomoSelections, [group]: choice } }
                        : profile,
                    ),
                  }))
                }
                onResetDiagnostics={resetDiagnostics}
                onOpenNodesPage={() => setPage("节点")}
                onSelectNode={node => void selectNode(node)}
                onConnectNode={node => void connectNode(node)}
                onOpenImport={() => setDialog(true)}
              />
            )}

            {page === "节点" && (
              <NodesPage
                running={running}
                busy={busy}
                recovering={recovering}
                workReady={work.ready}
                runningOriginal={runningOriginal}
                nodesTab={nodesTab}
                setNodesTab={setNodesTab}
                routingMode={routingMode}
                probeUrl={probeUrl}
                mihomoDelays={mihomoDelays}
                setMihomoDelays={setMihomoDelays}
                onChangeRouting={val => void changeRouting(val)}
                onResetDiagnostics={resetDiagnostics}
                onSaveMihomoSelection={(profileId, group, choice) =>
                  saveSettings(state => ({
                    ...state,
                    subscriptions: state.subscriptions.map(profile =>
                      profile.id === profileId
                        ? { ...profile, mihomoSelections: { ...profile.mihomoSelections, [group]: choice } }
                        : profile,
                    ),
                  }))
                }
                search={search}
                setSearch={setSearch}
                subscriptions={subscriptions}
                activeFilter={activeFilter}
                setSubscriptionFilter={setSubscriptionFilter}
                protocols={protocols}
                protocolFilter={protocolFilter}
                setProtocolFilter={setProtocolFilter}
                nodeSort={nodeSort}
                setNodeSort={setNodeSort}
                probeMode={probeMode}
                setProbeMode={setProbeMode}
                testing={testing}
                onlyFavorites={onlyFavorites}
                setOnlyFavorites={setOnlyFavorites}
                onlySupported={onlySupported}
                setOnlySupported={setOnlySupported}
                groupBySub={groupBySub}
                setGroupBySub={setGroupBySub}
                nodeView={nodeView}
                setNodeView={setNodeView}
                filtered={filtered}
                nodes={nodes}
                probeProgress={probeProgress}
                regionCounts={regionCounts}
                regionFilter={regionFilter}
                setRegionFilter={setRegionFilter}
                connectionError={connectionError}
                unavailableNodes={unavailableNodes}
                nodeSubName={nodeSubName}
                starred={starred}
                probe={probe}
                isSelected={isSelected}
                onStopNodeTests={stopNodeTests}
                onTestNodes={items => void testNodes(items)}
                onPickFastest={() => void pickFastestNode()}
                onConnectNode={node => void connectNode(node)}
                onSelectNode={node => void selectNode(node)}
                onShowDetail={node => { setDetailCopied(false); setDetailNode(node); }}
                onToggleFavorite={id =>
                  void saveSettings(state => ({
                    ...state,
                    favorites: state.favorites.includes(id)
                      ? state.favorites.filter(fav => fav !== id)
                      : [...state.favorites, id],
                  }))
                }
              />
            )}

            {page === "订阅" && (
              <SubscriptionsPage
                subscriptions={subscriptions}
                refreshStatus={work.refreshStatus}
                workReady={work.ready}
                busy={busy}
                recovering={recovering}
                originalProfileId={originalProfile?.id}
                refreshHours={work.workspace.refreshHours}
                mihomoOverrideEnabled={mihomoOverride.enabled}
                onRefreshAll={() => void refreshAllSubscriptions()}
                onChangeDefaultRefreshHours={hours => void saveSettings(state => ({ ...state, refreshHours: hours }))}
                onSelectOriginal={id => void switchToOriginal(id)}
                onRefreshOne={id => void work.refresh(id).catch(() => {})}
                onConfigure={(id, request, hours) => work.configureSubscription(id, { request, refreshHours: hours })}
                onBrowseNodes={id => {
                  setSubscriptionFilter(id);
                  setProtocolFilter("");
                  setRegionFilter("");
                  setSearch("");
                  setOnlyFavorites(false);
                  setOnlySupported(false);
                  setNodesTab("nodes");
                  setPage("节点");
                }}
                onRename={(id, name) =>
                  void saveSettings(state => ({
                    ...state,
                    subscriptions: state.subscriptions.map(item => (item.id === id ? { ...item, name } : item)),
                  }))
                }
                onRemove={profile =>
                  void saveSettings(state => {
                    const remaining = state.subscriptions.filter(item => item.id !== profile.id);
                    const nodeIds = new Set(profile.parsed.nodes.map(node => node.id));
                    const nextLatencies = { ...state.nodeLatencies };
                    for (const id of nodeIds) delete nextLatencies[id];
                    return {
                      ...state,
                      subscriptions: remaining,
                      selected: preferredNode(remaining, state.selected),
                      mihomoProfile: state.mihomoProfile === profile.id ? undefined : state.mihomoProfile,
                      favorites: state.favorites.filter(id => !nodeIds.has(id)),
                      nodeLatencies: nextLatencies,
                    };
                  })
                }
                onOpenOverrideModal={() => setOverrideModal(true)}
              />
            )}

            {page === "连接" && (
              <ConnectionMonitor
                telemetry={telemetry}
                running={running}
                onQuickRule={rule =>
                  void saveSettings(state => {
                    const exists = state.rules.some(
                      r => r.type === rule.type && r.value === rule.value && r.action === rule.action,
                    );
                    return exists ? state : { ...state, rules: [rule, ...state.rules] };
                  })
                }
              />
            )}

            {page === "规则" && (
              <RulesEditor
                rules={rules}
                ruleSets={ruleSets}
                targets={ruleTargets}
                defaultAction={ruleDefaultAction}
                dirtyWhileRunning={rulesDirtyWhileRunning}
                running={running}
                isMihomo={!!runningOriginal || !!originalProfile}
                onDefaultAction={action => void saveSettings(state => ({ ...state, ruleDefaultAction: action }))}
                onChange={edit => void saveSettings(state => ({ ...state, rules: edit(state.rules) }))}
                onChangeRuleSets={edit => void saveSettings(state => ({ ...state, ruleSets: edit(state.ruleSets) }))}
                onApplyReconnect={() => void (runningOriginal ? applyOriginalUpdate() : reconnectNodeSession())}
              />
            )}

            {page === "诊断" && (
              <DiagnosticsPage
                diagTab={diagTab}
                setDiagTab={setDiagTab}
                diagnosticsVersion={diagnosticsVersion}
                running={running}
                recovering={recovering}
                port={port}
                busy={busy}
                localTcp={localTcp}
                localTcpBusy={localTcpBusy}
                onTestLocalTcp={() => void testLocalTcp()}
              />
            )}

            {page === "设置" && (
              <SettingsPage
                workspace={work.workspace}
                ready={work.ready}
                busy={busy}
                running={running}
                elevated={elevated}
                serviceStatus={serviceStatus}
                serviceBusy={serviceBusy}
                hotkeyErrors={hotkeyErrors}
                onInstallService={() => void handleInstallService()}
                onUninstallService={() => void handleUninstallService()}
                onSave={saveSettings}
              />
            )}
          </div>
        </main>
      </div>

      {dialog && (
        <ImportModal
          ready={work.ready}
          importing={importing}
          error={error}
          onClose={() => setDialog(false)}
          onImport={importSubscription}
        />
      )}

      {overrideModal && (
        <MihomoOverrideModal
          initial={mihomoOverride}
          runningOriginal={!!runningOriginal}
          busy={busy || recovering}
          onClose={() => setOverrideModal(false)}
          onSave={async (next, reloadNow) => {
            await saveSettings(state => ({ ...state, mihomoOverride: next }));
            if (reloadNow && runningOriginal) {
              await applyOriginalUpdate(next);
            }
          }}
        />
      )}

      {detailNode && (
        <div className="overlay" onMouseDown={() => setDetailNode(undefined)}>
          <div className="modal" role="dialog" aria-modal="true" onMouseDown={e => e.stopPropagation()}>
            <div className="modal-head">
              <div>
                <h2>{detailNode.name}</h2>
                <p>{detailNode.protocol.toUpperCase()} · {detailNode.server}:{detailNode.port}</p>
              </div>
              <button className="icon-button" aria-label="关闭详情" onClick={() => setDetailNode(undefined)}>
                <X size={18} />
              </button>
            </div>
            {unavailableNodes.get(detailNode.id) && (
              <div className="notice is-error" style={{ marginBottom: 12 }}>
                不可用原因：{unavailableNodes.get(detailNode.id)}
              </div>
            )}
            <div className="env-row"><span>地区识别</span><strong>{nodeRegion(detailNode.name)}</strong></div>
            <div className="env-row"><span>所属订阅</span><strong>{nodeSubName.get(detailNode.id) ?? "—"}</strong></div>
            <div className="env-row"><span>协议</span><strong>{detailNode.protocol}</strong></div>
            <div className="env-row"><span>传输方式</span><strong>{detailNode.transport}</strong></div>
            <div className="env-row"><span>安全传输</span><strong>{detailNode.security}</strong></div>
            <div className="env-row"><span>订阅序号</span><strong>#{detailNode.sourceIndex ?? "—"}</strong></div>
            <div className="modal-actions">
              <button type="button" className="btn" onClick={() => setDetailNode(undefined)}>关闭</button>
              {detailNode.uri && (
                <button
                  type="button"
                  className="btn"
                  onClick={() => {
                    void navigator.clipboard.writeText(detailNode.uri!).then(() => {
                      setDetailCopied(true);
                      window.setTimeout(() => setDetailCopied(false), 1600);
                    }).catch(() => {});
                  }}
                >
                  {detailCopied ? <><Check size={14} /> 已复制链接</> : <><Copy size={14} /> 复制分享链接</>}
                </button>
              )}
              {!unavailableNodes.get(detailNode.id) && isTauri() && (
                <button
                  type="button"
                  className="btn primary"
                  disabled={busy || recovering}
                  onClick={() => {
                    const target = detailNode;
                    setDetailNode(undefined);
                    void connectNode(target);
                  }}
                >
                  {running ? "切换到此节点" : "立即连接此节点"}
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
