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
  {
    id: 'ai-services-proxy',
    label: 'AI 服务走代理',
    description: '将 OpenAI / ChatGPT、Claude、Gemini、Perplexity 与 Cursor 域名设为代理',
    rules: [
      'openai.com', 'chatgpt.com', 'oaistatic.com', 'oaiusercontent.com',
      'anthropic.com', 'claude.ai', 'gemini.google.com', 'generativelanguage.googleapis.com',
      'aistudio.google.com', 'makersuite.google.com', 'perplexity.ai',
      'cursor.sh', 'cursor.com', 'copilot.github.com',
    ].map(value => ({ type: 'domain_suffix', value, action: 'proxy' })),
  },
  {
    id: 'dev-github-proxy',
    label: 'GitHub / 开发走代理',
    description: '将 GitHub、npm、PyPI、Crates、Docker Hub、HuggingFace 等开发服务设为代理',
    rules: [
      'github.com', 'githubusercontent.com', 'githubassets.com', 'github.io',
      'npmjs.org', 'pypi.org', 'crates.io', 'docker.io', 'gcr.io', 'quay.io',
      'stackoverflow.com', 'huggingface.co',
    ].map(value => ({ type: 'domain_suffix', value, action: 'proxy' })),
  },
  {
    id: 'telegram-proxy',
    label: 'Telegram 走代理',
    description: '将 Telegram 域名与官方 DC 网段设为代理',
    rules: [
      ...['t.me', 'telegram.org', 'telegram.me', 'tdesktop.com', 'telesco.pe']
        .map((value): RouteRule => ({ type: 'domain_suffix', value, action: 'proxy' })),
      ...['91.108.4.0/22', '91.108.8.0/22', '91.108.56.0/22', '149.154.160.0/20']
        .map((value): RouteRule => ({ type: 'ip_cidr', value, action: 'proxy' })),
    ],
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
      final: ruleDefaultAction, auto_detect_interface: true, find_process: true,
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


export type RuleMatchEvaluation = {
  inputKind: 'domain' | 'ip' | 'process_name';
  normalized: string;
  matchedIndex: number | null;
  matchedRule?: RouteRule;
  action: 'direct' | 'proxy' | 'reject';
  target?: string;
};

function parseIpv4BigInt(ip: string): bigint | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let value = 0n;
  for (const part of parts) {
    if (!/^(?:0|[1-9]\d{0,2})$/.test(part)) return null;
    const n = Number(part);
    if (n > 255) return null;
    value = (value << 8n) + BigInt(n);
  }
  return value;
}

function parseIpv6BigInt(ip: string): bigint | null {
  if (!ip.includes(':') || !/^[\da-f:.]+$/i.test(ip)) return null;
  try {
    const normalized = new URL(`http://[${ip}]/`).hostname.slice(1, -1);
    const halves = normalized.split('::');
    if (halves.length > 2) return null;
    const expandGroup = (side: string): string[] => (side ? side.split(':') : []);
    const left = expandGroup(halves[0] ?? '');
    const right = halves.length === 2 ? expandGroup(halves[1] ?? '') : [];
    const groups: string[] = [];
    for (const seg of left) {
      if (seg.includes('.')) {
        const v4 = parseIpv4BigInt(seg);
        if (v4 == null) return null;
        groups.push(Number((v4 >> 16n) & 0xffffn).toString(16), Number(v4 & 0xffffn).toString(16));
      } else groups.push(seg);
    }
    const rightGroups: string[] = [];
    for (const seg of right) {
      if (seg.includes('.')) {
        const v4 = parseIpv4BigInt(seg);
        if (v4 == null) return null;
        rightGroups.push(Number((v4 >> 16n) & 0xffffn).toString(16), Number(v4 & 0xffffn).toString(16));
      } else rightGroups.push(seg);
    }
    if (halves.length === 2) {
      const missing = 8 - (groups.length + rightGroups.length);
      if (missing < 1) return null;
      groups.push(...Array(missing).fill('0'), ...rightGroups);
    } else if (groups.length !== 8) {
      return null;
    }
    let out = 0n;
    for (const hex of groups) {
      if (!/^[\da-f]{1,4}$/i.test(hex)) return null;
      out = (out << 16n) + BigInt(parseInt(hex, 16));
    }
    return out;
  } catch {
    return null;
  }
}

function cidrContains(cidr: string, candidateIp: string): boolean {
  const [net, prefixStr] = cidr.split('/');
  if (!net || !prefixStr) return false;
  const prefix = Number(prefixStr);
  if (!Number.isInteger(prefix)) return false;
  if (net.includes(':') !== candidateIp.includes(':')) return false;
  if (net.includes(':')) {
    const netVal = parseIpv6BigInt(net);
    const candVal = parseIpv6BigInt(candidateIp);
    if (netVal == null || candVal == null || prefix < 0 || prefix > 128) return false;
    const shift = BigInt(128 - prefix);
    return (netVal >> shift) === (candVal >> shift);
  }
  const netVal = parseIpv4BigInt(net);
  const candVal = parseIpv4BigInt(candidateIp);
  if (netVal == null || candVal == null || prefix < 0 || prefix > 32) return false;
  const shift = BigInt(32 - prefix);
  return (netVal >> shift) === (candVal >> shift);
}

export function evaluateRuleMatch(
  rawInput: string,
  rules: RouteRule[],
  defaultAction: RuleDefaultAction = 'proxy',
): RuleMatchEvaluation {
  let trimmed = rawInput.trim();
  if (!trimmed) throw new Error('请输入要测试的域名、IP 或 .exe 进程名');
  if (/^https?:\/\//i.test(trimmed)) {
    try {
      trimmed = new URL(trimmed).hostname;
    } catch {
      throw new Error('URL 地址格式无效');
    }
  }
  const maybeExe = trimmed.split(/[\\/]/).pop()?.trim() ?? trimmed;
  let inputKind: RuleMatchEvaluation['inputKind'];
  let normalized: string;
  if (/\.exe$/i.test(maybeExe)) {
    normalized = normalizeRuleValue('process_name', maybeExe);
    inputKind = 'process_name';
  } else {
    const bareIp = trimmed.replace(/^\[|\]$/g, '');
    if (parseIpv4BigInt(bareIp) != null || parseIpv6BigInt(bareIp) != null) {
      normalized = bareIp.includes(':') ? new URL(`http://[${bareIp}]/`).hostname.slice(1, -1) : bareIp;
      inputKind = 'ip';
    } else {
      normalized = normalizeRuleDomain(trimmed);
      inputKind = 'domain';
    }
  }

  for (let i = 0; i < rules.length; i++) {
    const rule = rules[i];
    try {
      const ruleVal = normalizeRuleValue(rule.type, rule.value);
      let matched = false;
      if (inputKind === 'domain') {
        if (rule.type === 'domain') matched = normalized === ruleVal;
        else if (rule.type === 'domain_suffix') matched = normalized === ruleVal || normalized.endsWith(`.${ruleVal}`);
      } else if (inputKind === 'ip' && rule.type === 'ip_cidr') {
        matched = cidrContains(ruleVal, normalized);
      } else if (inputKind === 'process_name' && rule.type === 'process_name') {
        matched = normalized.toLowerCase() === ruleVal.toLowerCase();
      }
      if (matched) {
        return {
          inputKind,
          normalized,
          matchedIndex: i,
          matchedRule: rule,
          action: rule.action,
          target: rule.target,
        };
      }
    } catch { /* ignore invalid draft rules */ }
  }

  return {
    inputKind,
    normalized,
    matchedIndex: null,
    action: defaultAction,
  };
}
