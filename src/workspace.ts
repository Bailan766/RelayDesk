import { connectionSupport, ruleTypes, type RouteRule } from "./config";
import { nodeRevision, parseSubscription, type ImportResult, type NodeProfile } from "./subscription";

export type EntryMode = "system" | "tun" | "local";
export type RoutingMode = "rule" | "global" | "direct";
export type Usage = { upload?: number; download?: number; total?: number; expire?: number };
export type SubscriptionDownload = { content: string; usage: Usage | null };
export type SubscriptionRequest = { route: "automatic" | "direct" | "relaydesk"; userAgent: string };
export const defaultSubscriptionRequest: SubscriptionRequest = { route: "automatic", userAgent: "" };

export type Subscription = {
  id: string;
  name: string;
  source: string;
  content: string;
  updatedAt: number | null;
  usage: Usage | null;
  request: SubscriptionRequest;
  parsed: ImportResult;
};

export type Workspace = {
  subscriptions: Subscription[];
  selected?: string;
  mihomoProfile?: string;
  rules: RouteRule[];
  entryMode: EntryMode;
  routingMode: RoutingMode;
  refreshHours: number;
  favorites: string[];
  autoReconnect: boolean;
  autoFailover: boolean;
  proxyPort: number | null;
};

export const emptyWorkspace: Workspace = {
  subscriptions: [],
  rules: [],
  entryMode: "system",
  routingMode: "rule",
  refreshHours: 0,
  favorites: [],
  autoReconnect: true,
  autoFailover: false,
  proxyPort: null,
};

export function subscriptionHost(source: string): string {
  try { return new URL(source).hostname; }
  catch { return ""; }
}

function subscriptionRequest(value: unknown): SubscriptionRequest {
  const settings = value as Partial<SubscriptionRequest> | null | undefined;
  return {
    route: settings?.route === "direct" || settings?.route === "relaydesk" ? settings.route : "automatic",
    userAgent: typeof settings?.userAgent === "string" && /^[\x20-\x7e]{0,256}$/.test(settings.userAgent)
      ? settings.userAgent.trim() : "",
  };
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
  });
}

export function preferredNode(subscriptions: Subscription[], selected?: string): string | undefined {
  const nodes = subscriptions.flatMap(profile => profile.parsed.nodes);
  const retained = nodes.find(node => node.id === selected);
  return (retained && !connectionSupport(retained) ? retained : nodes.find(node => !connectionSupport(node)))?.id;
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
  return { ...state, subscriptions, selected: preferredNode(subscriptions, selection), favorites, rules };
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
    entryMode: saved.entryMode === "local" || saved.entryMode === "tun" ? saved.entryMode : "system",
    routingMode: saved.routingMode === "direct" || saved.routingMode === "global" ? saved.routingMode : "rule",
    refreshHours: [1, 6, 24].includes(saved.refreshHours) ? saved.refreshHours : 0,
    favorites: Array.isArray(saved.favorites)
      ? [...new Set<string>(saved.favorites.filter((id: unknown): id is string => typeof id === "string").map(recoverId))]
      : [],
    autoReconnect: saved.autoReconnect !== false,
    autoFailover: saved.autoFailover === true,
    proxyPort: Number.isInteger(saved.proxyPort) && saved.proxyPort >= 1024 && saved.proxyPort <= 65535
      ? saved.proxyPort : null,
  };
}

export function serializeWorkspace(workspace: Workspace): string {
  return JSON.stringify({
    ...workspace,
    version: 2,
    subscriptions: workspace.subscriptions.map(({ parsed: _parsed, ...profile }) => profile),
  });
}
