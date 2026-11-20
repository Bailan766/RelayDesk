import { nodeRevision, type Fields, type NodeProfile } from './subscription';
import { compileOutbound } from './outbound';
import { normalizeIpCidr } from './ip';

export type RuleType = 'domain' | 'domain_suffix' | 'ip_cidr' | 'process_name';
export type RouteRule = { type: RuleType; value: string; action: 'direct' | 'proxy' | 'reject'; target?: string };
export const ruleTypes: { value: RuleType; label: string; example: string }[] = [
  { value: 'domain', label: '域名', example: 'example.com' },
  { value: 'domain_suffix', label: '域名后缀', example: 'example.com' },
  { value: 'ip_cidr', label: 'IP 地址或网段', example: '192.0.2.0/24' },
  { value: 'process_name', label: 'Windows 进程', example: 'chrome.exe' },
];

export function normalizeRuleDomain(input: string): string {
  const domain = input.trim().toLowerCase().replace(/\.$/, '');
  if (!domain || domain.length > 253 || !domain.split('.').every(label =>
    /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) throw new Error('域名规则无效');
  return domain;
}

export function normalizeRuleValue(type: RuleType, input: string): string {
  if (type === 'domain' || type === 'domain_suffix') return normalizeRuleDomain(type === 'domain_suffix' ? input.replace(/^\s*\./, '') : input);
  const value = input.trim();
  if (type === 'process_name') {
    if (!/^[^<>:"/\\|?*\u0000-\u001f]{1,128}\.exe$/i.test(value)) throw new Error('请填写 .exe 文件名');
    return value;
  }
  return normalizeIpCidr(value);
}

type LoadedOutbounds = ReadonlyMap<string, { tag: string }>;

function compileConfig(outbounds: Fields[], port: number, rules: RouteRule[], loaded: LoadedOutbounds) {
  const compiledRules = rules.map(rule => {
    const value = normalizeRuleValue(rule.type, rule.value);
    const match = rule.type === 'process_name'
      ? { process_path_regex: [`(?i)(?:^|[\\\\/])${value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`] }
      : { [rule.type]: [value] };
    const outbound = rule.action === 'proxy' && rule.target ? loaded.get(rule.target)?.tag : rule.action;
    return !outbound || outbound === 'reject' ? { ...match, action: 'reject' } : { ...match, outbound };
  });
  const endpoints = outbounds.filter(outbound => outbound.type === 'wireguard');
  const wireguard = endpoints.length > 0;
  return {
    log: { level: 'warn' },
    inbounds: [{ type: 'mixed', tag: 'local', listen: '127.0.0.1', listen_port: port }],
    outbounds: [
      ...outbounds.filter(outbound => outbound.type !== 'wireguard'),
      ...(wireguard ? [{ type: 'direct', tag: 'wireguard-uplink', connect_timeout: '5s' }] : []),
      { type: 'direct', tag: 'direct' },
    ],
    ...(wireguard ? { endpoints, dns: { servers: [{ type: 'local', tag: 'bootstrap' }], final: 'bootstrap' } } : {}),
    route: {
      rules: wireguard
        ? [{ inbound: endpoints.map(endpoint => endpoint.tag), action: 'reject' }, ...compiledRules]
        : compiledRules,
      final: 'proxy', auto_detect_interface: true,
      ...(wireguard ? { default_domain_resolver: 'bootstrap' } : {}),
    },
  };
}

export function buildConfig(node: NodeProfile, port: number, rules: RouteRule[] = []) {
  if (node.protocol === 'wireguard') return buildSessionConfig(node, [], port, rules).config;
  return compileConfig([compileOutbound(node, 'proxy')], port, rules, new Map([[node.id, { tag: 'proxy' }]]));
}

export type SessionPlan = {
  config: ReturnType<typeof compileConfig>;
  loaded: Map<string, { tag: string; revision: string }>;
};

export function buildSessionConfig(selected: NodeProfile, candidates: NodeProfile[], port: number, rules: RouteRule[]): SessionPlan {
  const outbounds = [compileOutbound(selected, 'node-0')];
  const loaded = new Map([[selected.id, { tag: 'node-0', revision: nodeRevision(selected) }]]);
  let wireguardCount = selected.protocol === 'wireguard' ? 1 : 0;
  for (const candidate of candidates) {
    if (loaded.has(candidate.id) || outbounds.length >= 2048) continue;
    if (candidate.protocol === 'wireguard' && wireguardCount >= 32) continue;
    const tag = `node-${outbounds.length}`;
    try {
      outbounds.push(compileOutbound(candidate, tag));
      loaded.set(candidate.id, { tag, revision: nodeRevision(candidate) });
      if (candidate.protocol === 'wireguard') wireguardCount++;
    } catch { /* Unsupported nodes remain visible in the node list. */ }
  }
  return {
    config: compileConfig([{
      type: 'selector', tag: 'proxy', outbounds: outbounds.map(outbound => outbound.tag),
      default: 'node-0', interrupt_exist_connections: false,
    }, ...outbounds], port, rules, loaded),
    loaded,
  };
}

export function withSelectedOutbound(plan: SessionPlan, tag: string): SessionPlan {
  const [selector, ...outbounds] = plan.config.outbounds;
  return { ...plan, config: { ...plan.config, outbounds: [{ ...selector, default: tag }, ...outbounds] } };
}

export function connectionSupport(node: NodeProfile): string | null {
  try { buildConfig(node, 12345); return null; }
  catch (error) { return error instanceof Error ? error.message : '此节点暂不支持连接'; }
}
