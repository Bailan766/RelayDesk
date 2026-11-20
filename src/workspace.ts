import { connectionSupport, type RouteRule } from "./config";
import { parseSubscription, type ImportResult, type NodeProfile } from "./subscription";

export type EntryMode = "system" | "tun" | "local";
export type RoutingMode = "rule" | "global" | "direct";
export type Usage = { upload?: number; download?: number; total?: number; expire?: number };
export type SubscriptionDownload = { content: string; usage: Usage | null };

export type Subscription = {
  id: string;
  name: string;
  source: string;
  content: string;
  updatedAt: number | null;
  usage: Usage | null;
  parsed: ImportResult;
};

export type Workspace = {
  subscriptions: Subscription[];
  selected?: string;
  rules: RouteRule[];
  entryMode: EntryMode;
  routingMode: RoutingMode;
  refreshHours: number;
};

export const emptyWorkspace: Workspace = {
  subscriptions: [],
  rules: [],
  entryMode: "system",
  routingMode: "rule",
  refreshHours: 0,
};

export function subscriptionHost(source: string): string {
  try { return new URL(source).hostname; }
  catch { return ""; }
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
  const nodes = parsed.nodes.map(node => ({
    ...node,
    id: JSON.stringify([id, node.protocol, node.name, node.server.toLowerCase(), node.port]),
  }));
  return { ...profile, id, content, parsed: { ...parsed, nodes } };
}

export function receiveSubscription(
  text: string,
  source: string,
  usage: Usage | null,
  previous?: Subscription,
): Subscription {
  return parseProfile({
    id: previous?.id ?? crypto.randomUUID(),
    name: previous?.name ?? (subscriptionHost(source) || "本地订阅"),
    source,
    content: text,
    updatedAt: Date.now(),
    usage: validUsage(usage),
  });
}

export function preferredNode(subscriptions: Subscription[], selected?: string): string | undefined {
  const nodes = subscriptions.flatMap(profile => profile.parsed.nodes);
  const retained = nodes.find(node => node.id === selected);
  return (retained && !connectionSupport(retained) ? retained : nodes.find(node => !connectionSupport(node)))?.id;
}

export function replaceSubscription(state: Workspace, profile: Subscription): Workspace {
  const old = state.subscriptions.find(item => item.id === profile.id);
  if (old?.parsed.nodes.some(node => !connectionSupport(node))
      && !profile.parsed.nodes.some(node => !connectionSupport(node))) {
    throw new Error("更新后的订阅没有可连接的节点，已保留原订阅");
  }
  const subscriptions = old
    ? state.subscriptions.map(item => item.id === profile.id ? { ...profile, name: item.name } : item)
    : [...state.subscriptions, profile];
  return { ...state, subscriptions, selected: preferredNode(subscriptions, state.selected) };
}

function isRule(value: unknown): value is RouteRule {
  if (value == null || typeof value !== "object") return false;
  const { type, value: domain, action } = value as Record<string, unknown>;
  return (type === "domain" || type === "domain_suffix")
    && typeof domain === "string"
    && (action === "direct" || action === "proxy" || action === "reject");
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
    });
    const selected: NodeProfile | undefined = Number.isInteger(saved.selected) ? profile.parsed.nodes[saved.selected] : undefined;
    return { ...emptyWorkspace, subscriptions: [profile], selected: preferredNode([profile], selected?.id) };
  }
  if (saved?.version !== 2 || !Array.isArray(saved.subscriptions) || !Array.isArray(saved.rules)
      || !saved.rules.every(isRule)) throw new Error("工作区数据格式无效");
  const ids = new Set<string>();
  const subscriptions = saved.subscriptions.map((profile: Omit<Subscription, "parsed">) => {
    if (!profile || typeof profile.id !== "string" || !profile.id || ids.has(profile.id)
        || typeof profile.name !== "string" || typeof profile.source !== "string"
        || typeof profile.content !== "string") throw new Error("订阅记录无效");
    ids.add(profile.id);
    return parseProfile({
      id: profile.id, name: profile.name, source: profile.source, content: profile.content,
      updatedAt: Number.isSafeInteger(profile.updatedAt) ? profile.updatedAt : null,
      usage: validUsage(profile.usage),
    });
  });
  return {
    subscriptions,
    selected: preferredNode(subscriptions, saved.selected),
    rules: saved.rules,
    entryMode: saved.entryMode === "local" || saved.entryMode === "tun" ? saved.entryMode : "system",
    routingMode: saved.routingMode === "direct" || saved.routingMode === "global" ? saved.routingMode : "rule",
    refreshHours: [1, 6, 24].includes(saved.refreshHours) ? saved.refreshHours : 0,
  };
}

export function serializeWorkspace(workspace: Workspace): string {
  return JSON.stringify({
    ...workspace,
    version: 2,
    subscriptions: workspace.subscriptions.map(({ parsed: _parsed, ...profile }) => profile),
  });
}
