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
  LayoutGrid,
  LayoutList,
  Link2,
  List,
  Moon,
  Plus,
  RefreshCw,
  Search,
  Settings2,
  Shield,
  ShieldAlert,
  ShieldCheck,
  Star,
  Sun,
  SunMoon,
  X,
  Zap,
} from "lucide-react";
import { nodeRevision, type NodeProfile } from "./subscription";
import {
  buildConfig,
  buildSessionConfig,
  connectionSupport,
  withSelectedOutbound,
  type RouteRule,
  type SessionPlan,
} from "./config";
import { ConnectionMonitor, TrafficDashboard, TrafficSidebar, useTelemetry } from "./telemetry";
import { SubscriptionCard } from "./SubscriptionCard";
import { WebsiteChecks } from "./WebsiteChecks";
import { DownloadCheck } from "./DownloadCheck";
import { MihomoGroups } from "./MihomoGroups";
import { EventLog } from "./EventLog";
import { RulesEditor } from "./components/RulesEditor";
import { UnlockTests } from "./components/UnlockTests";
import { SettingsPage } from "./components/SettingsPage";
import { ImportModal } from "./components/ImportModal";
import { useWorkspace } from "./useWorkspace";
import {
  parseRefreshHours,
  preferredNode,
  refreshOptions,
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

type Page = "概览" | "节点" | "订阅" | "连接" | "规则" | "日志" | "测试" | "设置";
type ExitIpDetail = { ip: string; country?: string | null; region?: string | null; city?: string | null; isp?: string | null };

const nodeHealthLabels = {
  checking: "正在确认节点连通性",
  healthy: "节点探测成功",
  unreachable: "节点连续两次探测失败",
  unavailable: "暂时无法检测节点",
};

type ProxyStatus = {
  phase: "running" | "recovering" | "stopped" | "busy";
  message: string | null;
  session_id: string | null;
  node_tag?: string | null;
  node_health?: keyof typeof nodeHealthLabels | null;
};

function fallbackGroups(plan: SessionPlan | undefined, subscriptions: Workspace["subscriptions"], favorites: Set<string>) {
  if (!plan) return [];
  return subscriptions
    .map(profile =>
      [...profile.parsed.nodes]
        .sort((first, second) => Number(favorites.has(second.id)) - Number(favorites.has(first.id)))
        .flatMap(node => plan.loaded.get(node.id)?.tag ?? []),
    )
    .filter(group => group.length > 1);
}

const entryModes: { value: EntryMode; label: string }[] = [
  { value: "system", label: "系统代理" },
  { value: "tun", label: "TUN" },
  { value: "local", label: "本地端口" },
];

const routingModes: { value: RoutingMode; label: string }[] = [
  { value: "rule", label: "规则" },
  { value: "global", label: "全局" },
  { value: "direct", label: "直连" },
];

const pageMeta: Record<Page, { subtitle: string; icon: typeof Activity }> = {
  概览: { subtitle: "连接控制、核心状态与快捷节点切换", icon: LayoutDashboard },
  节点: { subtitle: "浏览、筛选、测速并选择代理节点", icon: Globe2 },
  订阅: { subtitle: "导入与管理多订阅来源及 Mihomo 原配置", icon: Boxes },
  连接: { subtitle: "查看、搜索、管理活跃连接及快速分流", icon: Link2 },
  规则: { subtitle: "管理节点模式的分流规则与默认动作", icon: Shield },
  日志: { subtitle: "实时查看脱敏后的内核运行日志与网络事件", icon: List },
  测试: { subtitle: "下载测速、网站连通性、服务解锁与本地诊断", icon: FlaskConical },
  设置: { subtitle: "外观主题、Windows 权限、入口与恢复选项", icon: Settings2 },
};

const navOrder: Page[] = ["概览", "节点", "订阅", "连接", "规则", "日志", "测试", "设置"];

function latencyClass(ms?: number) {
  if (ms == null) return "";
  if (ms < 180) return "is-good";
  if (ms < 400) return "is-warn";
  return "is-bad";
}

const regionRules: [string, RegExp][] = [
  ["🇭🇰 香港", /香港|hong\s*kong|\bhk\b/i],
  ["🇹🇼 台湾", /台湾|台北|新北|taiwan|\btw\b/i],
  ["🇯🇵 日本", /日本|东京|大阪|tokyo|osaka|japan|\bjp\b/i],
  ["🇸🇬 新加坡", /新加坡|狮城|singapore|\bsg\b/i],
  ["🇺🇸 美国", /美国|洛杉矶|硅谷|圣何塞|纽约|西雅图|达拉斯|芝加哥|united\s*states|\busa?\b/i],
  ["🇰🇷 韩国", /韩国|首尔|korea|seoul|\bkr\b/i],
  ["🇬🇧 英国", /英国|伦敦|united\s*kingdom|london|\buk\b|\bgb\b/i],
  ["🇩🇪 德国", /德国|法兰克福|germany|frankfurt|\bde\b/i],
  ["🇫🇷 法国", /法国|巴黎|france|paris|\bfr\b/i],
  ["🇨🇦 加拿大", /加拿大|多伦多|温哥华|canada|\bca\b/i],
  ["🇦🇺 澳大利亚", /澳大利亚|悉尼|澳洲|australia|\bau\b/i],
];

function nodeRegion(name: string): string {
  for (const [label, pattern] of regionRules) {
    if (pattern.test(name)) return label;
  }
  return "🌐 其他";
}

function App() {
  const [page, setPage] = useState<Page>("概览");
  const work = useWorkspace();
  const {
    subscriptions,
    rules,
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

  const [subscriptionFilter, setSubscriptionFilter] = useState("");
  const [protocolFilter, setProtocolFilter] = useState("");
  const [regionFilter, setRegionFilter] = useState("");
  const [nodeSort, setNodeSort] = useState("source");
  const [nodeView, setNodeView] = useState<"list" | "grid">("list");
  const [groupBySub, setGroupBySub] = useState(false);
  const [onlyFavorites, setOnlyFavorites] = useState(false);
  const [onlySupported, setOnlySupported] = useState(false);
  const [nodesTab, setNodesTab] = useState<"groups" | "nodes">("groups");
  const [dialog, setDialog] = useState(false);
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
  const cancelTesting = useRef(false);
  const probeBatch = useRef<string>();
  const probeSessionId = useRef<string>();
  const autoConnectRan = useRef(false);

  const currentRulesKey = useMemo(() => JSON.stringify({ rules, ruleDefaultAction }), [rules, ruleDefaultAction]);
  const rulesDirtyWhileRunning = running && !runningOriginal && appliedRulesKey !== "" && appliedRulesKey !== currentRulesKey;

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  useEffect(() => {
    setLatencies(prev => ({ ...nodeLatencies, ...prev }));
  }, [nodeLatencies]);

  useEffect(() => {
    if (!isTauri() || !work.ready) return;
    void invoke<boolean>("is_elevated").then(setElevated).catch(() => {});
    void invoke("set_close_action", { exitOnClose: closeAction === "exit" }).catch(() => {});
  }, [closeAction, work.ready]);

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
    setAppliedRulesKey("");
    resetDiagnostics();
  }

  useEffect(() => {
    if (!isTauri() || busy || !running) return;
    let cancelled = false;
    let timer: number;
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
  }, [busy, running]);

  useEffect(() => {
    if (!isTauri() || !work.ready) return;
    void invoke("configure_recovery", { enabled: autoReconnect }).catch(() =>
      setSettingsError("无法更新当前会话的自动恢复设置"),
    );
  }, [autoReconnect, work.ready]);

  useEffect(() => {
    if (!isTauri() || !running || runningOriginal || !work.ready) return;
    void invoke("configure_failover", { enabled: autoFailover, fallbackGroups: fallbackGroups(session.current, subscriptions, starred) })
      .catch(() => setSettingsError("无法更新当前会话的自动换线设置"));
  }, [autoFailover, running, runningOriginal, starred, subscriptions, work.ready]);

  const preferred = nodes.find(n => n.id === selected);
  const current = running ? runningNode ?? preferred : preferred;

  useEffect(() => {
    if (!isTauri() || !work.ready) return;
    const summary = originalName
      ? `${originalName} (Mihomo)`
      : current?.name ?? "未选择节点";
    void invoke("update_tray_state", { running, summary, routingMode }).catch(() => {});
  }, [current?.name, originalName, routingMode, running, work.ready]);

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
      setPage(original ? "订阅" : "节点");
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

  async function checkProxy() {
    if (!port || busy || recovering) return;
    const epoch = diagnosticsEpoch.current;
    setChecking(true);
    setCheckResult("");
    try {
      const ms = await invoke<number>("check_connection", { port, probeUrl });
      if (epoch === diagnosticsEpoch.current) setCheckResult(`当前路由可达 · ${ms} ms`);
    } catch (e) {
      if (epoch === diagnosticsEpoch.current) setCheckResult(typeof e === "string" ? e : "网络验证失败");
    } finally {
      if (epoch === diagnosticsEpoch.current) setChecking(false);
    }
  }

  async function prepareSession(node: NodeProfile, localPort: number): Promise<SessionPlan> {
    const candidate = buildSessionConfig(node, nodes, localPort, rules, ruleDefaultAction);
    if (await invoke<boolean>("validate_proxy_config", { config: candidate.config })) return candidate;
    const single = buildConfig(node, localPort, rules, ruleDefaultAction);
    if (!(await invoke<boolean>("validate_proxy_config", { config: single }))) {
      throw new Error("所选节点或规则未通过内核配置检查");
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
      fallbackGroups: fallbackGroups(plan, subscriptions, starred),
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

    // Start (or switch from Mihomo original config) directly into this node.
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
      const localPort = proxyPort ?? (await invoke<number>("allocate_port"));
      const next = await prepareSession(node, localPort);
      await invoke("start_proxy", {
        config: next.config,
        mode,
        routingMode: work.workspace.routingMode,
        autoReconnect,
        autoFailover,
        fallbackGroups: fallbackGroups(next, subscriptions, starred),
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
      const localPort = proxyPort ?? (await invoke<number>("allocate_port"));
      const originalMode =
        profile.mihomoMode ??
        (profile.parsed.mihomo.mode === "global" || profile.parsed.mihomo.mode === "direct"
          ? profile.parsed.mihomo.mode
          : "rule");
      await invoke("start_mihomo", {
        config: profile.parsed.mihomo,
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
      setPort(localPort);
      setRunning(true);
      setPage("概览");
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

  async function testNodes(items: NodeProfile[]) {
    if (!isTauri() || testing) return;
    if (probeMode === "url" && running && runningOriginal && mode === "tun") {
      setConnectionError("Mihomo TUN 运行期间不支持直接对 sing-box 节点做 URL 测速（会产生回环延迟）。请使用「Mihomo 策略组」测速，或切换为「TCP 握手延迟」。");
      return;
    }
    cancelTesting.current = false;
    setTesting(true);
    setConnectionError("");
    const queue = items.filter(node => !unavailableNodes.get(node.id));
    if (!queue.length) {
      setTesting(false);
      return;
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
  }

  function stopNodeTests() {
    cancelTesting.current = true;
    const sid = probeSessionId.current;
    if (sid) void invoke("stop_probe_session", { session: sid }).catch(() => {});
    const batch = probeBatch.current;
    if (batch) void invoke("cancel_probe_batch", { batch }).catch(() => setConnectionError("无法取消正在运行的测速"));
  }

  function pickFastestNode() {
    const candidates = filtered
      .filter(n => !unavailableNodes.get(n.id))
      .map(n => ({ node: n, ms: probe(n)?.milliseconds }))
      .filter((item): item is { node: NodeProfile; ms: number } => typeof item.ms === "number")
      .sort((a, b) => a.ms - b.ms);
    if (!candidates.length) {
      setConnectionError("当前列表暂无有效延迟结果，请先点击「一键测速」。");
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

  async function applyOriginalUpdate() {
    const next = liveOriginalProfile;
    if (busy || recovering || !runningOriginal || !next?.parsed.mihomo) return;
    setBusy(true);
    setConnectionError("");
    try {
      await invoke("reload_mihomo", { config: next.parsed.mihomo });
      setRunningOriginal({ id: next.id, name: next.name, content: next.content });
      resetDiagnostics();
    } catch (failure) {
      setConnectionError(typeof failure === "string" ? failure : "配置更新失败");
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
        const original = originalProfile?.parsed.mihomo;
        if (!original && !preferred) throw new Error("请先导入并选择节点或原配置");
        const localPort = proxyPort ?? (await invoke<number>("allocate_port"));
        if (original && originalProfile) {
          const originalMode =
            originalProfile.mihomoMode ??
            (original.mode === "global" || original.mode === "direct" ? original.mode : "rule");
          await invoke("start_mihomo", {
            config: original,
            port: localPort,
            mode,
            routingMode: originalMode,
            autoReconnect,
            selections: originalProfile.mihomoSelections,
            allowLan,
            bypass: systemProxyBypass,
            tunIpv6,
          });
          setRunningOriginal({ id: originalProfile.id, name: originalProfile.name, content: originalProfile.content });
          setLiveRouting(originalMode);
        } else if (preferred) {
          const next = await prepareSession(preferred, localPort);
          await startProxy(next);
          session.current = next;
          setRunningNode(preferred);
          setLiveRouting(routingMode);
          setAppliedRulesKey(currentRulesKey);
        }
        setPort(localPort);
        setRunning(true);
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
      const localPort = proxyPort ?? (await invoke<number>("allocate_port"));
      const next = await prepareSession(current, localPort);
      await startProxy(next);
      session.current = next;
      setRunningNode(current);
      setLiveRouting(routingMode);
      setAppliedRulesKey(currentRulesKey);
      setPort(localPort);
      setRunning(true);
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

  useEffect(() => {
    if (!isTauri()) return;
    let unlisten: (() => void) | undefined;
    void listen<string>("tray-action", event => {
      const action = event.payload;
      if (action === "toggle") void toggleProxyRef.current();
      else if (action === "mode:rule") void changeRoutingRef.current("rule");
      else if (action === "mode:global") void changeRoutingRef.current("global");
      else if (action === "mode:direct") void changeRoutingRef.current("direct");
    }).then(fn => {
      unlisten = fn;
    });
    return () => {
      unlisten?.();
    };
  }, []);

  useEffect(() => {
    if (!isTauri() || !work.ready || autoConnectRan.current) return;
    autoConnectRan.current = true;
    if (autoConnect && !running && !busy && (originalProfile?.parsed.mihomo || preferred)) {
      void toggleProxy();
    }
  }, [autoConnect, busy, originalProfile?.parsed.mihomo, preferred, running, work.ready]);

  function copyLocalEndpoint() {
    if (!port) return;
    void navigator.clipboard.writeText(`127.0.0.1:${port}`).then(() => {
      setPortCopied(true);
      window.setTimeout(() => setPortCopied(false), 1600);
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

  return (
    <div className="app">
      <aside>
        <div className="brand">
          <div className="brand-mark"><Cat size={20} /></div>
          <div>
            <strong>RelayDesk</strong>
            <small>Windows 代理工作台</small>
          </div>
        </div>
        <nav>
          {navOrder.map(name => {
            const Icon = pageMeta[name].icon;
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
            <span className={`status-pill ${statusStateClass}`}>
              <span className="dot" />
              {recovering ? "正在恢复" : running ? (runningOriginal ? "Mihomo 运行中" : "sing-box 运行中") : "未连接"}
            </span>
            {running && port && (
              <button type="button" className="chip-button" onClick={copyLocalEndpoint} title="点击复制本地代理地址">
                {portCopied ? <Check size={12} /> : <Copy size={12} />}
                <span>{allowLan ? "0.0.0.0" : "127.0.0.1"}:{port}</span>
              </button>
            )}
          </div>
          <div className="header-right">
            {isTauri() && (
              <span className={`badge ${elevated ? "is-good" : ""}`} title={elevated ? "管理员权限" : "普通用户权限"}>
                {elevated ? <><ShieldCheck size={12} /> 管理员</> : <><ShieldAlert size={12} /> 普通权限</>}
              </span>
            )}
            <button type="button" className="chip-button" onClick={cycleTheme} title="切换主题模式">
              <ThemeIcon size={13} />
              <span>{themeLabel}</span>
            </button>
          </div>
        </header>

        <main>
          <div className="title">
            <div>
              <h1>{page}</h1>
              <p>{pageMeta[page].subtitle}</p>
            </div>
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

          {page === "概览" && (
            <>
              <section className="connection">
                <div className="connection-info">
                  <div className="section-label">连接控制中心</div>
                  <div className={`status ${statusStateClass}`}>
                    <span className="status-dot" />
                    {recovering ? "正在恢复代理连接" : running ? "代理内核运行中" : "代理未连接"}
                  </div>
                  <p>
                    {connectionError || recoveryMessage || (running
                      ? `本地混合入口：${allowLan ? "0.0.0.0" : "127.0.0.1"}:${port}`
                      : originalName
                        ? `已准备使用 Mihomo 原配置：${originalName}`
                        : current
                          ? `已就绪节点：${current.name}`
                          : "请先导入订阅并选择节点或 Mihomo 原配置")}
                    {running && !recovering && (
                      <>
                        {" · "}
                        <span>{checkResult || "尚未检测远程路由"}</span>
                        <button className="link inline-action" disabled={checking || busy} onClick={() => void checkProxy()}>
                          {checking ? "检测中…" : "测试连通性"}
                        </button>
                      </>
                    )}
                  </p>
                </div>

                <div className="connection-actions">
                  <div className="connection-controls">
                    <label style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12 }}>
                      <span className="muted">接管</span>
                      <select
                        aria-label="接管方式"
                        value={mode}
                        disabled={busy || running || !work.ready}
                        onChange={e => {
                          const entryMode = e.target.value as EntryMode;
                          void saveSettings(state => ({ ...state, entryMode }));
                        }}
                      >
                        {entryModes.map(({ value, label }) => <option key={value} value={value}>{label}</option>)}
                      </select>
                    </label>

                    <div className="mode-switch" role="group" aria-label="路由模式">
                      {routingModes.map(option => (
                        <button
                          key={option.value}
                          type="button"
                          aria-pressed={routingMode === option.value}
                          disabled={busy || recovering || !work.ready}
                          onClick={() => void changeRouting(option.value)}
                        >
                          {option.label}
                        </button>
                      ))}
                    </div>

                    <button
                      className={`connect ${running ? "is-stop" : ""}`}
                      disabled={busy || (!running && !current && !originalName) || !isTauri()}
                      onClick={() => void toggleProxy()}
                    >
                      {busy ? "处理中…" : running ? "断开连接" : "立即连接"}
                    </button>
                  </div>
                  {mode === "tun" && !running && !elevated && (
                    <small className="muted">当前为普通权限，启动 TUN 时将请求管理员授权（可在设置中切换管理员重启）</small>
                  )}
                </div>
              </section>

              {connectionError && <div className="notice is-error" role="alert">{connectionError}</div>}
              {rulesDirtyWhileRunning && (
                <div className="notice is-warn" role="status">
                  <span>分流规则已修改，重新连接后生效。</span>
                  <button type="button" className="mini-btn is-primary" disabled={busy} onClick={() => void reconnectNodeSession()}>
                    立即重连应用
                  </button>
                </div>
              )}
              {originalName && mode === "tun" && (
                <div className="notice">
                  TUN 转发模式下，Mihomo 的进程/来源地址/入口规则按内部转发连接匹配。
                </div>
              )}
              {originalUpdated && (
                <div className="notice is-warn" role="status">
                  <span>当前使用的 Mihomo 订阅内容已更新。</span>
                  <button className="mini-btn is-primary" disabled={busy || recovering} onClick={() => void applyOriginalUpdate()}>
                    立即热重载应用
                  </button>
                </div>
              )}

              <div className="stats">
                <div className="stat-card">
                  <div className="stat-card-head">
                    <span>{originalName ? "当前配置（Mihomo）" : "当前节点（sing-box）"}</span>
                    {originalName ? (
                      <button type="button" className="link" disabled={busy || recovering} onClick={() => void switchBackToNodeMode()}>
                        切回节点模式
                      </button>
                    ) : subscriptions.some(s => s.parsed.mihomo) ? (
                      <button
                        type="button"
                        className="link"
                        disabled={busy || recovering}
                        onClick={() => {
                          const firstMihomo = subscriptions.find(s => s.parsed.mihomo);
                          if (firstMihomo) void switchToOriginal(firstMihomo.id);
                        }}
                      >
                        切到原配置
                      </button>
                    ) : null}
                  </div>
                  <strong title={originalName || current?.name}>{originalName || current?.name || "尚未选择"}</strong>
                  <small>
                    {originalName ? "保留原策略组与完整规则" : current ? `${current.protocol.toUpperCase()} · ${current.server}:${current.port}` : "导入订阅后选择节点"}
                  </small>
                </div>

                <div className="stat-card">
                  <div className="stat-card-head">
                    <span>入口与路由</span>
                    <span className="badge">{allowLan ? "允许局域网" : "仅本机"}</span>
                  </div>
                  <strong>{entryModes.find(e => e.value === mode)?.label} · {routingModes.find(r => r.value === routingMode)?.label}模式</strong>
                  <small>{mode === "tun" ? (tunIpv6 ? "虚拟网卡双栈接管" : "虚拟网卡仅 IPv4") : mode === "system" ? "自动管理 WinINet 系统代理" : "手动配置应用代理端口"}</small>
                </div>

                <div className="stat-card">
                  <div className="stat-card-head">
                    <span>节点健康与延迟</span>
                    {!originalName && current && isTauri() && (
                      <button type="button" className="link" disabled={testing} onClick={() => void testNodes([current])}>
                        {testing ? "测速中…" : "测速"}
                      </button>
                    )}
                  </div>
                  <strong style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <span>{(!originalName && current && probe(current)?.label) || (running ? "运行中" : "待连接")}</span>
                    {nodeHealth && (
                      <span className={`badge ${nodeHealth === "healthy" ? "is-good" : nodeHealth === "unreachable" ? "is-bad" : "is-warn"}`}>
                        {nodeHealth === "healthy" ? "正常" : nodeHealth === "checking" ? "探测中" : nodeHealth === "unreachable" ? "失联" : "不可检测"}
                      </span>
                    )}
                  </strong>
                  <small>{checkResult || "点击上方“测试连通性”核实当前路由出站"}</small>
                </div>

                <div className="stat-card">
                  <div className="stat-card-head">
                    <span>当前出口 IP</span>
                    <button type="button" className="link" disabled={!running || recovering || checking || busy} onClick={() => void showExitIp()}>
                      {checking ? "查询中…" : "查询"}
                    </button>
                  </div>
                  <strong title={exitIp?.ip}>{exitIp?.ip || exitIpError || (running ? "点击右上角查询" : "未连接")}</strong>
                  <small>
                    {exitIp
                      ? [exitIp.country, exitIp.city, exitIp.isp].filter(Boolean).join(" · ") || "出口 IP 已确认"
                      : "通过当前路由访问 IP 归属服务"}
                  </small>
                </div>
              </div>

              {runningOriginal && (
                <MihomoGroups
                  mode={routingMode}
                  disabled={busy || recovering}
                  probeUrl={probeUrl}
                  delays={mihomoDelays}
                  compact
                  onDelays={setMihomoDelays}
                  onOpenFull={() => { setNodesTab("groups"); setPage("节点"); }}
                  onMode={value => void changeRouting(value)}
                  onChange={async (group, choice) => {
                    resetDiagnostics();
                    await saveSettings(state => ({
                      ...state,
                      subscriptions: state.subscriptions.map(profile =>
                        profile.id === runningOriginal.id
                          ? { ...profile, mihomoSelections: { ...profile.mihomoSelections, [group]: choice } }
                          : profile,
                      ),
                    }));
                  }}
                />
              )}

              <TrafficDashboard telemetry={telemetry} />

              <div className="columns">
                <WebsiteChecks key={diagnosticsVersion} port={running && !recovering ? port : undefined} disabled={busy} />
                <section className="panel">
                  <div className="panel-head">
                    <h2>快捷切换节点</h2>
                    <button className="link" onClick={() => setPage("节点")}>全部节点 ({nodes.length})</button>
                  </div>
                  {originalName ? (
                    <div className="empty">
                      当前正在使用 Mihomo 原配置「{originalName}」，请在上方「Mihomo 策略组」切换节点，或
                      <button type="button" className="link inline-action" onClick={() => void switchBackToNodeMode()}>
                        切回节点模式
                      </button>
                    </div>
                  ) : quickNodes.length ? (
                    quickNodes.map(n => {
                      const p = probe(n);
                      const active = isSelected(n);
                      return (
                        <div
                          className={`node-row is-clickable ${active ? "is-selected" : ""}`}
                          key={n.id}
                          onClick={() => void selectNode(n)}
                        >
                          <div className="node-name">
                            <span className="node-icon">
                              {starred.has(n.id) ? <Star size={15} fill="#fbbf24" color="#d97706" /> : <Globe2 size={15} />}
                            </span>
                            <div>
                              <strong>{n.name}</strong>
                              <small>{n.protocol.toUpperCase()} · {n.transport}</small>
                            </div>
                          </div>
                          <div style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
                            <span className={`badge ${p?.milliseconds != null ? latencyClass(p.milliseconds) : ""}`}>
                              {p?.label ?? "未测速"}
                            </span>
                            {active ? (
                              <span className="badge is-accent">{running ? "使用中" : "已选中"}</span>
                            ) : (
                              <button
                                type="button"
                                className="mini-btn"
                                disabled={busy || recovering}
                                onClick={e => {
                                  e.stopPropagation();
                                  void connectNode(n);
                                }}
                              >
                                {running ? "切换" : "连接"}
                              </button>
                            )}
                          </div>
                        </div>
                      );
                    })
                  ) : (
                    <div className="empty">
                      还没有可用节点。
                      <button className="link inline-action" onClick={() => setDialog(true)}>导入订阅 →</button>
                    </div>
                  )}
                </section>
              </div>
            </>
          )}

          {page === "节点" && (
            <section>
              {runningOriginal && (
                <div className="panel" style={{ marginBottom: 14, padding: "12px 16px" }}>
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 10 }}>
                    <span className="muted">
                      当前正在运行 Mihomo 原配置「<strong>{runningOriginal.name}</strong>」
                    </span>
                    <div className="mode-switch" role="tablist" aria-label="节点页视图">
                      <button type="button" aria-pressed={nodesTab === "groups"} onClick={() => setNodesTab("groups")}>
                        Mihomo 策略组
                      </button>
                      <button type="button" aria-pressed={nodesTab === "nodes"} onClick={() => setNodesTab("nodes")}>
                        提取节点（sing-box）
                      </button>
                    </div>
                  </div>
                </div>
              )}

              {runningOriginal && nodesTab === "groups" ? (
                <MihomoGroups
                  mode={routingMode}
                  disabled={busy || recovering}
                  probeUrl={probeUrl}
                  delays={mihomoDelays}
                  onDelays={setMihomoDelays}
                  onMode={value => void changeRouting(value)}
                  onChange={async (group, choice) => {
                    resetDiagnostics();
                    await saveSettings(state => ({
                      ...state,
                      subscriptions: state.subscriptions.map(profile =>
                        profile.id === runningOriginal.id
                          ? { ...profile, mihomoSelections: { ...profile.mihomoSelections, [group]: choice } }
                          : profile,
                      ),
                    }));
                  }}
                />
              ) : (
                <>
                  <div className="toolbar">
                    <label className="search">
                      <Search size={15} />
                      <input placeholder="搜索节点名、序号、协议或域名" value={search} onChange={e => setSearch(e.target.value)} />
                    </label>
                    {subscriptions.length > 1 && (
                      <select className="toolbar-select" aria-label="筛选订阅来源" value={activeFilter?.id ?? ""} onChange={e => setSubscriptionFilter(e.target.value)}>
                        <option value="">全部订阅</option>
                        {subscriptions.map(profile => <option key={profile.id} value={profile.id}>{profile.name}</option>)}
                      </select>
                    )}
                    {protocols.length > 1 && (
                      <select className="toolbar-select" aria-label="筛选协议" value={protocolFilter} onChange={e => setProtocolFilter(e.target.value)}>
                        <option value="">全部协议</option>
                        {protocols.map(p => <option key={p} value={p}>{p.toUpperCase()}</option>)}
                      </select>
                    )}
                    <select className="toolbar-select" aria-label="排序节点" value={nodeSort} onChange={e => setNodeSort(e.target.value)}>
                      <option value="source">订阅顺序</option>
                      <option value="latency">延迟优先</option>
                      <option value="name">名称排序</option>
                    </select>
                    <select className="toolbar-select" aria-label="测速模式" value={probeMode} disabled={testing} onChange={e => setProbeMode(e.target.value as "url" | "tcp")}>
                      <option value="url">真连接延迟 (URL)</option>
                      <option value="tcp">TCP 握手延迟</option>
                    </select>
                    <button type="button" className="toolbar-pill" aria-pressed={onlyFavorites} onClick={() => setOnlyFavorites(v => !v)}>
                      收藏
                    </button>
                    <button type="button" className="toolbar-pill" aria-pressed={onlySupported} onClick={() => setOnlySupported(v => !v)}>
                      仅可用
                    </button>
                    {subscriptions.length > 1 && !activeFilter && (
                      <button type="button" className="toolbar-pill" aria-pressed={groupBySub} onClick={() => setGroupBySub(v => !v)}>
                        按订阅分组
                      </button>
                    )}
                    <div className="mode-switch" role="group" aria-label="视图模式">
                      <button type="button" aria-pressed={nodeView === "list"} onClick={() => setNodeView("list")} title="列表视图">
                        <LayoutList size={14} />
                      </button>
                      <button type="button" aria-pressed={nodeView === "grid"} onClick={() => setNodeView("grid")} title="卡片视图">
                        <LayoutGrid size={14} />
                      </button>
                    </div>
                    <button
                      type="button"
                      className="mini-btn is-primary"
                      disabled={(!testing && !filtered.length) || !isTauri()}
                      onClick={() => (testing ? stopNodeTests() : void testNodes(filtered))}
                    >
                      {testing ? `停止 (${probeProgress?.done ?? 0}/${probeProgress?.total ?? filtered.length})` : "一键测速"}
                    </button>
                    <button
                      type="button"
                      className="mini-btn"
                      disabled={busy || recovering || !filtered.length || !isTauri()}
                      onClick={pickFastestNode}
                      title="自动选择当前列表延迟最低的节点"
                    >
                      <Zap size={13} /> 选最快
                    </button>
                    <div className="mode-switch" role="group" aria-label="路由模式" style={{ marginLeft: "auto" }}>
                      {routingModes.map(option => (
                        <button
                          key={option.value}
                          type="button"
                          aria-pressed={routingMode === option.value}
                          disabled={busy || recovering || !work.ready}
                          onClick={() => void changeRouting(option.value)}
                        >
                          {option.label}
                        </button>
                      ))}
                    </div>
                  </div>

                  {regionCounts.length > 1 && (
                    <div className="region-bar" role="group" aria-label="按地区筛选">
                      <button
                        type="button"
                        className="toolbar-pill"
                        aria-pressed={regionFilter === ""}
                        onClick={() => setRegionFilter("")}
                      >
                        全部 ({(activeFilter?.parsed.nodes ?? nodes).length})
                      </button>
                      {regionCounts.map(([reg, count]) => (
                        <button
                          key={reg}
                          type="button"
                          className="toolbar-pill"
                          aria-pressed={regionFilter === reg}
                          onClick={() => setRegionFilter(prev => (prev === reg ? "" : reg))}
                        >
                          {reg} ({count})
                        </button>
                      ))}
                    </div>
                  )}

                  {connectionError && <div className="notice is-error" role="alert" style={{ marginBottom: 12 }}>{connectionError}</div>}
                  {activeFilter?.parsed.warnings.length ? (
                    <div className="notice is-warn" style={{ marginBottom: 12 }}>
                      <span>该订阅有 {activeFilter.parsed.warnings.length} 项因格式或协议不支持未导入。</span>
                    </div>
                  ) : null}

                  {(() => {
                    const renderNodeItem = (n: NodeProfile) => {
                      const reason = unavailableNodes.get(n.id);
                      const p = probe(n);
                      const active = isSelected(n);
                      const region = nodeRegion(n.name);
                      const subLabel = !activeFilter && subscriptions.length > 1 && !groupBySub ? nodeSubName.get(n.id) : undefined;

                      if (nodeView === "list") {
                        return (
                          <div
                            className={`node-list-row ${active ? "selected" : ""} ${reason ? "is-unavailable" : ""}`}
                            key={n.id}
                            onDoubleClick={() => { if (!reason) void connectNode(n); }}
                          >
                            <div className="node-list-main">
                              <div className="node-list-title">
                                <span className="badge">{region}</span>
                                <span className="source-index">#{n.sourceIndex}</span>
                                <strong>{n.name}</strong>
                                {active && <span className="badge is-accent">{running ? "使用中" : "已选中"}</span>}
                              </div>
                              <div className="node-list-sub">
                                <span>{n.server}:{n.port}</span>
                                <span>· {n.protocol.toUpperCase()} / {n.transport}{n.security !== "none" ? ` / ${n.security}` : ""}</span>
                                {subLabel && <span>· {subLabel}</span>}
                                {reason && <span className="error">· {reason}</span>}
                              </div>
                            </div>
                            <span className={`badge ${reason ? "is-bad" : p?.milliseconds != null ? latencyClass(p.milliseconds) : ""}`}>
                              {reason ? "不可用" : p?.label || "未测速"}
                            </span>
                            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                              {!reason && (
                                <>
                                  <button
                                    type="button"
                                    className={`mini-btn ${active ? "is-primary" : ""}`}
                                    disabled={busy || recovering || (running && !runningOriginal && active)}
                                    onClick={() => void selectNode(n)}
                                  >
                                    {active ? (running ? "使用中" : "已选中") : running ? "切换" : "选中"}
                                  </button>
                                  {(!running || runningOriginal) && (
                                    <button
                                      type="button"
                                      className="mini-btn is-primary"
                                      disabled={busy || recovering || !isTauri()}
                                      onClick={() => void connectNode(n)}
                                    >
                                      连接
                                    </button>
                                  )}
                                </>
                              )}
                              <button type="button" className="link" onClick={() => { setDetailCopied(false); setDetailNode(n); }}>详情</button>
                              <button
                                type="button"
                                className="link node-favorite"
                                aria-pressed={starred.has(n.id)}
                                aria-label={starred.has(n.id) ? `取消收藏 ${n.name}` : `收藏 ${n.name}`}
                                onClick={() =>
                                  void saveSettings(state => ({
                                    ...state,
                                    favorites: state.favorites.includes(n.id)
                                      ? state.favorites.filter(id => id !== n.id)
                                      : [...state.favorites, n.id],
                                  }))
                                }
                              >
                                <Star size={16} aria-hidden />
                              </button>
                            </div>
                          </div>
                        );
                      }

                      return (
                        <div
                          className={`node-card ${active ? "selected" : ""} ${reason ? "is-unavailable" : ""}`}
                          key={n.id}
                          onDoubleClick={() => { if (!reason) void connectNode(n); }}
                        >
                          <div className="node-name">
                            <span className="node-icon"><Globe2 size={17} /></span>
                            <div>
                              <strong title={n.name} style={{ whiteSpace: "normal", display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical" }}>
                                <span className="source-index">#{n.sourceIndex}</span> {n.name}
                              </strong>
                              <small>{n.server}:{n.port}</small>
                            </div>
                          </div>
                          <div className="node-meta-row">
                            <span className="badge">{region} · {n.protocol.toUpperCase()} · {n.transport}</span>
                            <span className={`badge ${reason ? "is-bad" : p?.milliseconds != null ? latencyClass(p.milliseconds) : ""}`}>
                              {reason ? "不可用" : p?.label || "未测速"}
                            </span>
                          </div>
                          {reason && <div className="error" style={{ lineHeight: 1.4 }}>{reason}</div>}
                          <div className="node-actions">
                            <div className="node-actions-left">
                              {!reason && (
                                <>
                                  <button
                                    type="button"
                                    className={`mini-btn ${active ? "is-primary" : ""}`}
                                    disabled={busy || recovering || (running && !runningOriginal && active)}
                                    onClick={() => void selectNode(n)}
                                  >
                                    {active ? (running ? "使用中" : "已选中") : running ? "切换" : "选中"}
                                  </button>
                                  {(!running || runningOriginal) && (
                                    <button
                                      type="button"
                                      className="mini-btn is-primary"
                                      disabled={busy || recovering || !isTauri()}
                                      onClick={() => void connectNode(n)}
                                    >
                                      连接
                                    </button>
                                  )}
                                </>
                              )}
                              <button type="button" className="link" onClick={() => { setDetailCopied(false); setDetailNode(n); }}>详情</button>
                            </div>
                            <button
                              type="button"
                              className="link node-favorite"
                              aria-pressed={starred.has(n.id)}
                              aria-label={starred.has(n.id) ? `取消收藏 ${n.name}` : `收藏 ${n.name}`}
                              onClick={() =>
                                void saveSettings(state => ({
                                  ...state,
                                  favorites: state.favorites.includes(n.id)
                                    ? state.favorites.filter(id => id !== n.id)
                                    : [...state.favorites, n.id],
                                }))
                              }
                            >
                              <Star size={16} aria-hidden />
                            </button>
                          </div>
                        </div>
                      );
                    };

                    if (!filtered.length) {
                      return (
                        <div className="empty">
                          {nodes.length ? "没有符合筛选条件的节点" : "还没有节点，点击右上角「导入订阅」。"}
                        </div>
                      );
                    }

                    if (groupBySub && subscriptions.length > 1 && !activeFilter) {
                      const filteredIds = new Set(filtered.map(n => n.id));
                      return subscriptions.map(sub => {
                        const groupNodes = sub.parsed.nodes.filter(n => filteredIds.has(n.id));
                        if (!groupNodes.length) return null;
                        const sortedGroup = nodeSort === "latency"
                          ? [...groupNodes].sort((a, b) => (probe(a)?.milliseconds ?? Number.MAX_SAFE_INTEGER) - (probe(b)?.milliseconds ?? Number.MAX_SAFE_INTEGER))
                          : nodeSort === "name"
                            ? [...groupNodes].sort((a, b) => a.name.localeCompare(b.name, "zh-CN"))
                            : groupNodes;
                        return (
                          <div className="node-group-box" key={sub.id}>
                            <div className="node-group-head">
                              <strong>{sub.name} ({sortedGroup.length})</strong>
                              <button type="button" className="mini-btn" disabled={testing || !isTauri()} onClick={() => void testNodes(sortedGroup)}>
                                测本组
                              </button>
                            </div>
                            <div className={nodeView === "list" ? "node-list" : "node-grid"}>
                              {sortedGroup.map(renderNodeItem)}
                            </div>
                          </div>
                        );
                      });
                    }

                    return (
                      <div className={nodeView === "list" ? "node-list" : "node-grid"}>
                        {filtered.map(renderNodeItem)}
                      </div>
                    );
                  })()}
                  <p className="rule-hint" style={{ marginTop: 12 }}>
                    提示：真连接延迟（URL）使用统一单实例 Clash API 测速，反映完整代理+TLS 握手耗时；TCP 握手延迟反映节点服务器直连 RTT。双击节点即可连接/切换。
                  </p>
                </>
              )}
            </section>
          )}

          {page === "订阅" && (
            <section className="panel">
              <div className="panel-head">
                <h2>订阅来源</h2>
                <div className="event-controls">
                  {subscriptions.some(s => !!s.source) && (
                    <button
                      type="button"
                      className="mini-btn"
                      disabled={!isTauri() || Object.values(work.refreshStatus).some(s => s?.pending)}
                      onClick={() => void refreshAllSubscriptions()}
                    >
                      <RefreshCw size={13} /> 更新全部
                    </button>
                  )}
                  <label className="refresh-setting">默认自动更新
                    <select
                      value={work.workspace.refreshHours}
                      disabled={!work.ready || !isTauri()}
                      onChange={event => {
                        const refreshHours = parseRefreshHours(Number(event.target.value)) ?? 0;
                        void saveSettings(state => ({ ...state, refreshHours }));
                      }}
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
                      pending={work.refreshStatus[profile.id]?.pending ?? false}
                      error={work.refreshStatus[profile.id]?.error}
                      refreshable={isTauri()}
                      originalSelected={originalProfile?.id === profile.id}
                      canSelectOriginal={isTauri() && !busy && !recovering}
                      onSelectOriginal={() => void switchToOriginal(profile.id)}
                      onRefresh={() => void work.refresh(profile.id).catch(() => {})}
                      onConfigure={(request, refreshHours) => work.configureSubscription(profile.id, { request, refreshHours })}
                      onBrowse={() => {
                        setSubscriptionFilter(profile.id);
                        setProtocolFilter("");
                        setRegionFilter("");
                        setSearch("");
                        setOnlyFavorites(false);
                        setOnlySupported(false);
                        setNodesTab("nodes");
                        setPage("节点");
                      }}
                      onRename={name =>
                        void saveSettings(state => ({
                          ...state,
                          subscriptions: state.subscriptions.map(item => (item.id === profile.id ? { ...item, name } : item)),
                        }))
                      }
                      onRemove={() =>
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
                    />
                  ))}
                </div>
              ) : (
                <p className="empty">{work.ready ? "尚未导入订阅，点击右上角「导入订阅」开始。" : "正在读取本地加密工作区…"}</p>
              )}
            </section>
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
              targets={ruleTargets}
              defaultAction={ruleDefaultAction}
              dirtyWhileRunning={rulesDirtyWhileRunning}
              running={running && !runningOriginal}
              onDefaultAction={action => void saveSettings(state => ({ ...state, ruleDefaultAction: action }))}
              onChange={edit => void saveSettings(state => ({ ...state, rules: edit(state.rules) }))}
              onApplyReconnect={() => void reconnectNodeSession()}
            />
          )}

          {page === "日志" && <EventLog />}

          {page === "测试" && (
            <>
              <DownloadCheck key={diagnosticsVersion} port={running && !recovering ? port : undefined} disabled={busy} />
              <WebsiteChecks key={`site-${diagnosticsVersion}`} port={running && !recovering ? port : undefined} disabled={busy} />
              <UnlockTests port={running && !recovering ? port : undefined} disabled={busy} />
              <section className="panel" style={{ marginTop: 16 }}>
                <div className="panel-head">
                  <h2>本机直连诊断</h2>
                  <button className="mini-btn" disabled={localTcpBusy || !isTauri()} onClick={() => void testLocalTcp()}>
                    {localTcpBusy ? "测试中…" : "测试 TCP 443"}
                  </button>
                </div>
                <div className="env-row">
                  <span>Google TCP 443（含本机 DNS 解析）</span>
                  <span className="badge">{localTcp}</span>
                </div>
                <p className="rule-hint">此诊断直接从本机发起连接以排查底层网络问题（启用 TUN 时可能经过虚拟网卡）。</p>
              </section>
            </>
          )}

          {page === "设置" && (
            <SettingsPage
              workspace={work.workspace}
              ready={work.ready}
              busy={busy}
              running={running}
              elevated={elevated}
              onSave={saveSettings}
            />
          )}
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
                    void navigator.clipboard.writeText(detailNode.uri!).then(() => setDetailCopied(true)).catch(() => {});
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
