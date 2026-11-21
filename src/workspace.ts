import {
  connectionSupport,
  rulePresets,
  ruleTypes,
  validateRuleSet,
  type RouteRule,
  type RuleDefaultAction,
  type RuleSetConfig,
} from "./config";
import { defaultMihomoOverride, sanitizeMihomoOverride, type MihomoOverride } from "./mihomoOverride";
import { nodeRevision, parseSubscription, type ImportResult, type NodeProfile } from "./subscription";

export type EntryMode = "system" | "tun" | "local";
export type RoutingMode = "rule" | "global" | "direct";
export type TunStack = "mixed" | "gvisor" | "system";
export type ThemeMode = "system" | "light" | "dark";
export type CloseAction = "tray" | "exit";
export type GlobalHotkeys = { toggleProxy: string; cycleRouting: string; showWindow: string };
export const defaultHotkeys: GlobalHotkeys = { toggleProxy: "", cycleRouting: "", showWindow: "" };
export type LatencyRecord = { revision: string; label: string; milliseconds?: number; testedAt?: number };
export type Usage = { upload?: number; download?: number; total?: number; expire?: number };
export type SubscriptionDownload = { content: string; usage: Usage | null };
export type SubscriptionRequest = { route: "automatic" | "direct" | "relaydesk"; userAgent: string; allowHttp?: boolean };
export const defaultSubscriptionRequest: SubscriptionRequest = { route: "automatic", userAgent: "" };
export const defaultSystemProxyBypass = "localhost;127.*;192.168.*;10.*;172.16.*;172.17.*;172.18.*;172.19.*;172.20.*;172.21.*;172.22.*;172.23.*;172.24.*;172.25.*;172.26.*;172.27.*;172.28.*;172.29.*;172.30.*;172.31.*;[::1];<local>";
export const defaultProbeUrl = "https://www.gstatic.com/generate_204";

export const refreshOptions = [[0, "关闭"], [1, "每小时"], [6, "每 6 小时"], [24, "每天"]] as const;
export type RefreshHours = (typeof refreshOptions)[number][0];

export type Subscription = {
  id: string;
  name: string;
  source: string;
  content: string;
  updatedAt: number | null;
  usage: Usage | null;
  request: SubscriptionRequest;
  refreshHours?: RefreshHours;
  mihomoSelections: Record<string, string>;
  mihomoMode?: RoutingMode;
  parsed: ImportResult;
};

export type Workspace = {
  subscriptions: Subscription[];
  selected?: string;
  mihomoProfile?: string;
  rules: RouteRule[];
  ruleSets: RuleSetConfig[];
  mihomoOverride: MihomoOverride;
  hotkeys: GlobalHotkeys;
  entryMode: EntryMode;
  routingMode: RoutingMode;
  refreshHours: number;
  favorites: string[];
  autoReconnect: boolean;
  autoFailover: boolean;
  proxyPort: number | null;
  theme: ThemeMode;
  autoConnect: boolean;
  closeAction: CloseAction;
  allowLan: boolean;
  systemProxyBypass: string;
  systemProxyGuard: boolean;
  probeUrl: string;
  tunIpv6: boolean;
  tunStack: TunStack;
  tunStrictRoute: boolean;
  ruleDefaultAction: RuleDefaultAction;
  nodeLatencies: Record<string, LatencyRecord>;
};

export const defaultRules: RouteRule[] = [
  ...rulePresets[0].rules,
  ...rulePresets[1].rules,
];

export const emptyWorkspace: Workspace = {
  subscriptions: [],
  rules: defaultRules,
  ruleSets: [],
  mihomoOverride: defaultMihomoOverride(),
  hotkeys: { ...defaultHotkeys },
  entryMode: "system",
  routingMode: "rule",
  refreshHours: 0,
  favorites: [],
  autoReconnect: true,
  autoFailover: true,
  proxyPort: null,
  theme: "system",
  autoConnect: false,
  closeAction: "tray",
  allowLan: false,
  systemProxyBypass: defaultSystemProxyBypass,
  systemProxyGuard: true,
  probeUrl: defaultProbeUrl,
  tunIpv6: true,
  tunStack: "mixed",
  tunStrictRoute: true,
  ruleDefaultAction: "proxy",
  nodeLatencies: {},
};

export function subscriptionHost(source: string): string {
  try { return new URL(source).hostname; }
  catch { return ""; }
}

export function parseRefreshHours(value: unknown): RefreshHours | undefined {
  return refreshOptions.find(([hours]) => hours === value)?.[0];
}

export function subscriptionRefreshDue(
  profile: Pick<Subscription, "source" | "refreshHours" | "updatedAt">,
  defaultHours: number,
  now: number,
  lastAttempt?: number,
): boolean {
  const hours = profile.refreshHours ?? defaultHours;
  return !!profile.source && hours > 0
    && (profile.updatedAt === null || now - profile.updatedAt >= hours * 3_600_000)
    && (lastAttempt === undefined || now - lastAttempt >= 15 * 60_000);
}

function subscriptionRequest(value: unknown): SubscriptionRequest {
  const settings = value as Partial<SubscriptionRequest> | null | undefined;
  return {
    route: settings?.route === "direct" || settings?.route === "relaydesk" ? settings.route : "automatic",
    userAgent: typeof settings?.userAgent === "string" && /^[\x20-\x7e]{0,256}$/.test(settings.userAgent)
      ? settings.userAgent.trim() : "",
    ...(settings?.allowHttp === true ? { allowHttp: true } : {}),
  };
}

function validLatencies(value: unknown, known: Set<string>, recoverId: (id: string) => string): Record<string, LatencyRecord> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const result: Record<string, LatencyRecord> = {};
  for (const [rawId, entry] of Object.entries(value)) {
    const id = recoverId(rawId);
    if (!known.has(id) || !entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const item = entry as Partial<LatencyRecord>;
    if (typeof item.revision !== "string" || typeof item.label !== "string") continue;
    result[id] = {
      revision: item.revision,
      label: item.label.slice(0, 120),
      ...(typeof item.milliseconds === "number" && Number.isFinite(item.milliseconds) && item.milliseconds >= 0
        ? { milliseconds: Math.round(item.milliseconds) } : {}),
      ...(typeof item.testedAt === "number" && Number.isSafeInteger(item.testedAt) ? { testedAt: item.testedAt } : {}),
    };
  }
  return result;
}

function validProbeUrl(value: unknown): string {
  if (typeof value !== "string") return defaultProbeUrl;
  const trimmed = value.trim();
  if (!trimmed) return defaultProbeUrl;
  try {
    const url = new URL(trimmed);
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : defaultProbeUrl;
  } catch {
    return defaultProbeUrl;
  }
}

function mihomoSelections(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).filter(([name, target]) =>
    name.length > 0 && name.length <= 512 && typeof target === "string" && target.length > 0 && target.length <= 512,
  ).slice(0, 128));
}

function validUsage(value: unknown): Usage | null {
  if (value == null || typeof value !== "object") return null;
  const usage: Usage = {};
  for (const key of ["upload", "download", "total", "expire"] as const) {
    const field = (value as Record<string, unknown>)[key];
    if (typeof field === "number" && Number.isSafeInteger(field) && field >= 0) usage[key] = field;
  }
  return Object.keys(usage).length > 0 ? usage : null;
}

function parseProfile({ id, content, ...profile }: Omit<Subscription, "parsed">): Subscription {
  const parsed = parseSubscription(content);
  const keys = parsed.nodes.map(node => JSON.stringify([id, node.protocol, node.name, node.server.toLowerCase(), node.port]));
  const counts = new Map<string, number>();
  for (const key of keys) counts.set(key, (counts.get(key) ?? 0) + 1);
  const nodes = parsed.nodes.map((node, index) => {
    const key = keys[index];
    if (counts.get(key) === 1) return { ...node, id: key };
    // Keep credentials out of the UI key while distinguishing otherwise identical endpoints.
    let hash = 0xcbf29ce484222325n;
    for (const unit of nodeRevision(node)) {
      hash = BigInt.asUintN(64, (hash ^ BigInt(unit.codePointAt(0)!)) * 0x100000001b3n);
    }
    return { ...node, id: `${key}:${hash.toString(16)}` };
  });
  return { ...profile, id, content, parsed: { ...parsed, nodes } };
}

export function receiveSubscription(
  text: string,
  source: string,
  usage: Usage | null,
  previous?: Subscription,
  request?: SubscriptionRequest,
): Subscription {
  return parseProfile({
    id: previous?.id ?? crypto.randomUUID(),
    name: previous?.name ?? (subscriptionHost(source) || "本地订阅"),
    source,
    content: text,
    updatedAt: Date.now(),
    usage: validUsage(usage),
    request: request ?? previous?.request ?? defaultSubscriptionRequest,
    refreshHours: previous?.refreshHours,
    mihomoSelections: previous?.mihomoSelections ?? {},
    mihomoMode: previous?.mihomoMode,
  });
}

const infoNodePattern = /^(?:.*(?:剩余流量|距离下次重置|套餐到期|过期时间|官方网址|最新官网|域名防走失|TG群组|官方频道|邀请返利|使用说明|重置流量|账号到期))|\s*(?:剩余|到期|官网)[:：]/i;

export function isInfoNodeName(name: string): boolean {
  return infoNodePattern.test(name);
}

export function preferredNode(subscriptions: Subscription[], selected?: string): string | undefined {
  const nodes = subscriptions.flatMap(profile => profile.parsed.nodes);
  const retained = nodes.find(node => node.id === selected);
  if (retained && !connectionSupport(retained)) return retained.id;
  const realNode = nodes.find(node => !connectionSupport(node) && !infoNodePattern.test(node.name));
  return (realNode ?? nodes.find(node => !connectionSupport(node)))?.id;
}

export function replaceSubscription(state: Workspace, profile: Subscription): Workspace {
  const old = state.subscriptions.find(item => item.id === profile.id);
  if (state.mihomoProfile === profile.id && old?.parsed.mihomo && !profile.parsed.mihomo) {
    throw new Error("该更新缺少原配置的策略和节点，已保留原订阅");
  }
  if (state.mihomoProfile !== profile.id && old?.parsed.nodes.some(node => !connectionSupport(node))
      && !profile.parsed.nodes.some(node => !connectionSupport(node))) {
    throw new Error("更新后的订阅没有可连接的节点，已保留原订阅");
  }
  const subscriptions = old
    ? state.subscriptions.map(item => item.id === profile.id ? { ...profile, name: item.name } : item)
    : [...state.subscriptions, profile];
  const matches = new Map(profile.parsed.nodes.map(node => [nodeRevision(node), node.id]));
  const remapped = new Map(old?.parsed.nodes.flatMap(node => {
    const successor = matches.get(nodeRevision(node));
    return successor ? [[node.id, successor] as const] : [];
  }));
  const selection = state.selected ? remapped.get(state.selected) ?? state.selected : undefined;
  const favorites = Array.from(new Set(state.favorites.map(id => remapped.get(id) ?? id)));
  const rules = state.rules.map(rule => rule.target && remapped.has(rule.target)
    ? { ...rule, target: remapped.get(rule.target)! } : rule);
  const validIds = new Set(subscriptions.flatMap(item => item.parsed.nodes.map(node => node.id)));
  const nodeLatencies: Record<string, LatencyRecord> = {};
  for (const [id, record] of Object.entries(state.nodeLatencies)) {
    const nextId = remapped.get(id) ?? id;
    if (validIds.has(nextId)) nodeLatencies[nextId] = record;
  }
  const autoMihomo = !old && !state.subscriptions.length && !state.mihomoProfile && profile.parsed.mihomo
    ? profile.id
    : state.mihomoProfile;
  return { ...state, subscriptions, selected: preferredNode(subscriptions, selection), mihomoProfile: autoMihomo, favorites, rules, nodeLatencies };
}

function isRule(value: unknown): value is RouteRule {
  if (value == null || typeof value !== "object") return false;
  const { type, value: key, action, target } = value as Record<string, unknown>;
  return ruleTypes.some(rule => rule.value === type) && typeof key === "string"
    && (action === "direct" || action === "proxy" || action === "reject")
    && (target === undefined || (action === "proxy" && typeof target === "string"));
}

export function deserializeWorkspace(raw: string): Workspace {
  const saved = JSON.parse(raw);
  if (saved?.version === undefined && typeof saved?.content === "string") {
    const source = typeof saved.source === "string" ? saved.source : "";
    const profile = parseProfile({
      id: "legacy",
      source,
      content: saved.content,
      name: subscriptionHost(source) || "原有订阅",
      updatedAt: null,
      usage: null,
      request: defaultSubscriptionRequest,
      mihomoSelections: {},
    });
    // Earlier clients indexed the first appearance of each display name and endpoint.
    const seen = new Set<string>();
    const legacyNodes = profile.parsed.nodes.filter(node => {
      if (node.protocol === "wireguard") return false;
      const endpoint = JSON.stringify([node.protocol, node.server, node.port, node.name]);
      if (seen.has(endpoint)) return false;
      seen.add(endpoint);
      return true;
    });
    const selected: NodeProfile | undefined = Number.isInteger(saved.selected) ? legacyNodes[saved.selected] : undefined;
    return { ...emptyWorkspace, subscriptions: [profile], selected: preferredNode([profile], selected?.id) };
  }
  if (saved?.version !== 2 || !Array.isArray(saved.subscriptions) || !Array.isArray(saved.rules)
      || !saved.rules.every(isRule)) throw new Error("工作区数据格式无效");
  const ids = new Set<string>();
  const subscriptions: Subscription[] = saved.subscriptions.map((profile: Omit<Subscription, "parsed">) => {
    if (!profile || typeof profile.id !== "string" || !profile.id || ids.has(profile.id)
        || typeof profile.name !== "string" || typeof profile.source !== "string"
        || typeof profile.content !== "string") throw new Error("订阅记录无效");
    ids.add(profile.id);
    return parseProfile({
      id: profile.id, name: profile.name, source: profile.source, content: profile.content,
      updatedAt: Number.isSafeInteger(profile.updatedAt) ? profile.updatedAt : null,
      usage: validUsage(profile.usage),
      request: subscriptionRequest(profile.request),
      refreshHours: profile.source ? parseRefreshHours(profile.refreshHours) : undefined,
      mihomoSelections: mihomoSelections(profile.mihomoSelections),
      mihomoMode: ["global", "direct", "rule"].includes(profile.mihomoMode ?? "") ? profile.mihomoMode : undefined,
    });
  });
  const known = new Set<string>();
  const firstByLegacyKey = new Map<string, string>();
  for (const profile of subscriptions) {
    for (const node of profile.parsed.nodes) {
      known.add(node.id);
      for (const server of node.server.includes(":") ? [node.server, `[${node.server}]`] : [node.server]) {
        const legacy = JSON.stringify([profile.id, node.protocol, node.name, server.toLowerCase(), node.port]);
        if (!firstByLegacyKey.has(legacy)) firstByLegacyKey.set(legacy, node.id);
      }
    }
  }
  const recoverId = (id: string) => known.has(id) ? id : firstByLegacyKey.get(id) ?? id;
  return {
    subscriptions,
    selected: preferredNode(subscriptions, typeof saved.selected === "string" ? recoverId(saved.selected) : undefined),
    mihomoProfile: subscriptions.find(profile => profile.id === saved.mihomoProfile && profile.parsed.mihomo)?.id,
    rules: (saved.rules as RouteRule[]).map(rule => rule.target ? { ...rule, target: recoverId(rule.target) } : rule),
    ruleSets: sanitizeRuleSets(saved.ruleSets),
    mihomoOverride: sanitizeMihomoOverride(saved.mihomoOverride),
    hotkeys: sanitizeHotkeys(saved.hotkeys),
    entryMode: saved.entryMode === "local" || saved.entryMode === "tun" ? saved.entryMode : "system",
    routingMode: saved.routingMode === "direct" || saved.routingMode === "global" ? saved.routingMode : "rule",
    refreshHours: parseRefreshHours(saved.refreshHours) ?? 0,
    favorites: Array.isArray(saved.favorites)
      ? [...new Set<string>(saved.favorites.filter((id: unknown): id is string => typeof id === "string").map(recoverId))]
      : [],
    autoReconnect: saved.autoReconnect !== false,
    autoFailover: saved.autoFailover !== false,
    proxyPort: Number.isInteger(saved.proxyPort) && saved.proxyPort >= 1024 && saved.proxyPort <= 65535
      ? saved.proxyPort : null,
    theme: saved.theme === "light" || saved.theme === "dark" ? saved.theme : "system",
    autoConnect: saved.autoConnect === true,
    closeAction: saved.closeAction === "exit" ? "exit" : "tray",
    allowLan: saved.allowLan === true,
    systemProxyBypass: typeof saved.systemProxyBypass === "string" && saved.systemProxyBypass.length <= 2048
      ? saved.systemProxyBypass : defaultSystemProxyBypass,
    systemProxyGuard: saved.systemProxyGuard !== false,
    probeUrl: validProbeUrl(saved.probeUrl),
    tunIpv6: saved.tunIpv6 !== false,
    tunStack: saved.tunStack === "gvisor" || saved.tunStack === "system" ? saved.tunStack : "mixed",
    tunStrictRoute: saved.tunStrictRoute !== false,
    ruleDefaultAction: saved.ruleDefaultAction === "direct" ? "direct" : "proxy",
    nodeLatencies: validLatencies(saved.nodeLatencies, known, recoverId),
  };
}

function sanitizeRuleSets(raw: unknown): RuleSetConfig[] {
  if (!Array.isArray(raw)) return [];
  const out: RuleSetConfig[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    try {
      const valid = validateRuleSet(item as RuleSetConfig);
      if (seen.has(valid.tag)) continue;
      seen.add(valid.tag);
      out.push(valid);
      if (out.length >= 64) break;
    } catch { /* ignore malformed rule set entry */ }
  }
  return out;
}

function sanitizeHotkeys(raw: unknown): GlobalHotkeys {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ...defaultHotkeys };
  const record = raw as Record<string, unknown>;
  const clean = (value: unknown) => (typeof value === "string" && value.length <= 48 ? value.trim() : "");
  return {
    toggleProxy: clean(record.toggleProxy),
    cycleRouting: clean(record.cycleRouting),
    showWindow: clean(record.showWindow),
  };
}

export function serializeWorkspace(workspace: Workspace): string {
  return JSON.stringify({
    ...workspace,
    version: 2,
    subscriptions: workspace.subscriptions.map(({ parsed: _parsed, ...profile }) => profile),
  });
}
