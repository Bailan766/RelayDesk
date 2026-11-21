import { nodeRevision, type Fields, type NodeProfile } from './subscription';
import { compileOutbound } from './outbound';
import { normalizeIpCidr } from './ip';

export type RuleType = 'domain' | 'domain_suffix' | 'ip_cidr' | 'process_name';
export type RouteRule = { type: RuleType; value: string; action: 'direct' | 'proxy' | 'reject'; target?: string };
export type RuleDefaultAction = 'proxy' | 'direct';
export const ruleTypes: { value: RuleType; label: string; example: string }[] = [
  { value: 'domain', label: '域名', example: 'example.com' },
  { value: 'domain_suffix', label: '域名后缀', example: 'example.com' },
  { value: 'ip_cidr', label: 'IP 地址或网段', example: '192.0.2.0/24' },
  { value: 'process_name', label: 'Windows 进程', example: 'chrome.exe' },
];

export const rulePresets: { id: string; label: string; description: string; rules: RouteRule[] }[] = [
  {
    id: 'lan-direct',
    label: '绕过局域网与保留地址',
    description: '将内网 IPv4/IPv6 与 CGNAT 地址设为直连，避免局域网访问走代理',
    rules: [
      { type: 'ip_cidr', value: '10.0.0.0/8', action: 'direct' },
      { type: 'ip_cidr', value: '172.16.0.0/12', action: 'direct' },
      { type: 'ip_cidr', value: '192.168.0.0/16', action: 'direct' },
      { type: 'ip_cidr', value: '127.0.0.0/8', action: 'direct' },
      { type: 'ip_cidr', value: '169.254.0.0/16', action: 'direct' },
      { type: 'ip_cidr', value: '100.64.0.0/10', action: 'direct' },
      { type: 'ip_cidr', value: 'fc00::/7', action: 'direct' },
      { type: 'ip_cidr', value: 'fe80::/10', action: 'direct' },
    ],
  },
  {
    id: 'cn-common-direct',
    label: '常见国内站点直连',
    description: '将 .cn 及常用国内服务域名后缀设为直连',
    rules: [
      'cn', 'qq.com', 'wechat.com', 'taobao.com', 'tmall.com', 'jd.com',
      'alipay.com', 'baidu.com', 'bilibili.com', 'zhihu.com', 'douyin.com',
      '163.com', '126.com', 'xiaomi.com', 'mi.com', 'huawei.com', 'apple.com', 'icloud.com',
    ].map(value => ({ type: 'domain_suffix', value, action: 'direct' })),
  },
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

function compileConfig(
  outbounds: Fields[],
  port: number,
  rules: RouteRule[],
  loaded: LoadedOutbounds,
  ruleDefaultAction: RuleDefaultAction = 'proxy',
) {
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
      final: ruleDefaultAction, auto_detect_interface: true,
      ...(wireguard ? { default_domain_resolver: 'bootstrap' } : {}),
    },
  };
}

export function buildConfig(
  node: NodeProfile,
  port: number,
  rules: RouteRule[] = [],
  ruleDefaultAction: RuleDefaultAction = 'proxy',
) {
  if (node.protocol === 'wireguard') return buildSessionConfig(node, [], port, rules, ruleDefaultAction).config;
  return compileConfig([compileOutbound(node, 'proxy')], port, rules, new Map([[node.id, { tag: 'proxy' }]]), ruleDefaultAction);
}

export type SessionPlan = {
  config: ReturnType<typeof compileConfig>;
  loaded: Map<string, { tag: string; revision: string; node: NodeProfile }>;
};

export function buildSessionConfig(
  selected: NodeProfile,
  candidates: NodeProfile[],
  port: number,
  rules: RouteRule[],
  ruleDefaultAction: RuleDefaultAction = 'proxy',
): SessionPlan {
  const outbounds = [compileOutbound(selected, 'node-0')];
  const loaded = new Map([[selected.id, { tag: 'node-0', revision: nodeRevision(selected), node: selected }]]);
  let wireguardCount = selected.protocol === 'wireguard' ? 1 : 0;
  for (const candidate of candidates) {
    if (loaded.has(candidate.id) || outbounds.length >= 2048) continue;
    if (candidate.protocol === 'wireguard' && wireguardCount >= 32) continue;
    const tag = `node-${outbounds.length}`;
    try {
      outbounds.push(compileOutbound(candidate, tag));
      loaded.set(candidate.id, { tag, revision: nodeRevision(candidate), node: candidate });
      if (candidate.protocol === 'wireguard') wireguardCount++;
    } catch { /* Unsupported nodes remain visible in the node list. */ }
  }
  return {
    config: compileConfig([{
      type: 'selector', tag: 'proxy', outbounds: outbounds.map(outbound => outbound.tag),
      default: 'node-0', interrupt_exist_connections: false,
    }, ...outbounds], port, rules, loaded, ruleDefaultAction),
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

export function withMihomoCustomRules(
  config: Fields,
  rules: RouteRule[],
  targetNames?: ReadonlyMap<string, string>,
): Fields {
  if (!rules.length) return config;
  const groups = Array.isArray(config['proxy-groups']) ? (config['proxy-groups'] as Fields[]) : [];
  const proxies = Array.isArray(config.proxies) ? (config.proxies as Fields[]) : [];
  const validTargets = new Set<string>(['DIRECT', 'REJECT']);
  for (const g of groups) if (typeof g?.name === 'string' && g.name) validTargets.add(g.name);
  for (const p of proxies) if (typeof p?.name === 'string' && p.name) validTargets.add(p.name);

  const primaryGroup =
    groups.find(g => g?.type === 'select' && typeof g.name === 'string' && g.name !== 'GLOBAL')?.name ??
    groups.find(g => typeof g?.name === 'string' && g.name !== 'GLOBAL')?.name ??
    (typeof proxies[0]?.name === 'string' ? proxies[0].name : 'DIRECT');

  const compiled: string[] = [];
  for (const rule of rules) {
    try {
      const value = normalizeRuleValue(rule.type, rule.value);
      let actionTarget = rule.action === 'direct' ? 'DIRECT' : rule.action === 'reject' ? 'REJECT' : String(primaryGroup);
      if (rule.action === 'proxy' && rule.target) {
        const mapped = targetNames?.get(rule.target);
        if (!mapped || !validTargets.has(mapped)) actionTarget = 'REJECT';
        else actionTarget = mapped;
      }
      if (rule.type === 'domain') compiled.push(`DOMAIN,${value},${actionTarget}`);
      else if (rule.type === 'domain_suffix') compiled.push(`DOMAIN-SUFFIX,${value},${actionTarget}`);
      else if (rule.type === 'ip_cidr') compiled.push(`IP-CIDR,${value},${actionTarget},no-resolve`);
      else if (rule.type === 'process_name') compiled.push(`PROCESS-NAME,${value},${actionTarget}`);
    } catch { /* ignore malformed draft rule */ }
  }
  if (!compiled.length) return config;
  const existing = Array.isArray(config.rules) ? config.rules.map(String) : [];
  const prepended = compiled.filter((item, idx) => compiled.indexOf(item) === idx && !existing.includes(item));
  return { ...config, rules: [...prepended, ...existing] };
}
