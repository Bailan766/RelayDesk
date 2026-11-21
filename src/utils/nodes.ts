import type { SessionPlan } from "../config";
import { nodeRevision } from "../subscription";
import { isInfoNodeName, type EntryMode, type LatencyRecord, type RoutingMode, type Workspace } from "../workspace";

export type ExitIpDetail = {
  ip: string;
  country?: string | null;
  region?: string | null;
  city?: string | null;
  isp?: string | null;
};

export const nodeHealthLabels = {
  checking: "正在确认节点连通性",
  healthy: "节点探测成功",
  unreachable: "节点连续两次探测失败",
  unavailable: "暂时无法检测节点",
};

export type ProxyStatus = {
  phase: "running" | "recovering" | "stopped" | "busy";
  message: string | null;
  session_id: string | null;
  node_tag?: string | null;
  node_health?: keyof typeof nodeHealthLabels | null;
};

export const entryModes: { value: EntryMode; label: string }[] = [
  { value: "system", label: "系统代理" },
  { value: "tun", label: "TUN" },
  { value: "local", label: "本地端口" },
];

export const routingModes: { value: RoutingMode; label: string }[] = [
  { value: "rule", label: "规则" },
  { value: "global", label: "全局" },
  { value: "direct", label: "直连" },
];

export function fallbackGroups(
  plan: SessionPlan | undefined,
  subscriptions: Workspace["subscriptions"],
  favorites: Set<string>,
  latencies: Record<string, LatencyRecord> = {},
) {
  if (!plan) return [];
  return subscriptions
    .map(profile =>
      [...profile.parsed.nodes]
        .filter(node => !isInfoNodeName(node.name))
        .sort((first, second) => {
          const starDiff = Number(favorites.has(second.id)) - Number(favorites.has(first.id));
          if (starDiff !== 0) return starDiff;
          const aMs = latencies[first.id]?.revision === nodeRevision(first)
            ? latencies[first.id]?.milliseconds ?? Number.MAX_SAFE_INTEGER
            : Number.MAX_SAFE_INTEGER;
          const bMs = latencies[second.id]?.revision === nodeRevision(second)
            ? latencies[second.id]?.milliseconds ?? Number.MAX_SAFE_INTEGER
            : Number.MAX_SAFE_INTEGER;
          return aMs - bMs;
        })
        .flatMap(node => plan.loaded.get(node.id)?.tag ?? []),
    )
    .filter(group => group.length > 1);
}

export function latencyClass(ms?: number) {
  if (ms == null) return "";
  if (ms < 180) return "is-good";
  if (ms < 400) return "is-warn";
  return "is-bad";
}

const regionRules: [string, RegExp][] = [
  ["香港", /香港|hong\s*kong|\bhk\b/i],
  ["台湾", /台湾|台北|新北|taiwan|\btw\b/i],
  ["日本", /日本|东京|大阪|tokyo|osaka|japan|\bjp\b/i],
  ["新加坡", /新加坡|狮城|singapore|\bsg\b/i],
  ["美国", /美国|洛杉矶|硅谷|圣何塞|纽约|西雅图|达拉斯|芝加哥|united\s*states|\busa?\b/i],
  ["韩国", /韩国|首尔|korea|seoul|\bkr\b/i],
  ["英国", /英国|伦敦|united\s*kingdom|london|\buk\b|\bgb\b/i],
  ["德国", /德国|法兰克福|germany|frankfurt|\bde\b/i],
  ["法国", /法国|巴黎|france|paris|\bfr\b/i],
  ["加拿大", /加拿大|多伦多|温哥华|canada|\bca\b/i],
  ["澳大利亚", /澳大利亚|悉尼|澳洲|australia|\bau\b/i],
];

export function nodeRegion(name: string): string {
  for (const [label, pattern] of regionRules) {
    if (pattern.test(name)) return label;
  }
  return "其他";
}
