import { parse as parseYaml } from 'yaml';

export type Fields = Record<string, unknown>;
export interface NodeProfile {
  id: string; sourceIndex?: number; name: string; protocol: string; server: string; port: number;
  transport: string; security: string; uri?: string;
  definition?: { format: 'clash' | 'sing-box' | 'vmess-uri'; fields: Fields };
  revision?: string;
}
export interface ImportResult { nodes: NodeProfile[]; warnings: string[]; format: string; policySections?: string[]; mihomo?: Fields }
const protocols = new Set(['vless', 'vmess', 'trojan', 'ss', 'hysteria2', 'hy2', 'tuic', 'shadowsocks', 'wireguard']);
export const decodeSubscriptionText = (value: string) => new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(atob(value.replace(/\s/g, '').replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0)));
const clean = (value: unknown) => typeof value === 'string' ? value : '';
function node(name: string, protocol: string, server: string, port: unknown, transport = 'tcp', security = 'none'): NodeProfile {
  const n = Number(port); if (!server || !Number.isInteger(n) || n < 1 || n > 65535) throw new Error('节点地址或端口无效');
  const host = server.replace(/^\[([^\]]+)\]$/, '$1');
  return { id: crypto.randomUUID(), name: name || host, protocol: protocol === 'hy2' ? 'hysteria2' : protocol === 'ss' ? 'shadowsocks' : protocol, server: host, port: n, transport, security };
}
function fromUri(line: string): NodeProfile {
  const scheme = line.slice(0, line.indexOf('://')).toLowerCase();
  if (!protocols.has(scheme) || scheme === 'wireguard') throw new Error('不支持的分享链接');
  if (scheme === 'vmess') {
    const v = JSON.parse(decodeSubscriptionText(line.slice(line.indexOf('://') + 3)));
    return { ...node(clean(v.ps), 'vmess', clean(v.add), v.port, clean(v.net) || 'tcp', clean(v.tls) || 'none'),
      definition: { format: 'vmess-uri', fields: v } };
  }
  let uri = line;
  if (scheme === 'ss' && !line.slice(5).split(/[?#]/)[0].includes('@')) {
    const [payload, suffix = ''] = line.slice(5).split(/(?=[?#])/s, 2);
    const decoded = decodeSubscriptionText(payload);
    const hostStart = decoded.lastIndexOf('@');
    if (hostStart < 1) throw new Error('Shadowsocks 地址无效');
    uri = `ss://${decoded.slice(hostStart + 1)}${suffix}`;
  }
  const url = new URL(uri);
  const p = url.searchParams;
  const firstHop = (p.get('mport') ?? '').split(/[:,\-]/)[0];
  return node(decodeURIComponent(url.hash.slice(1)), scheme, url.hostname, url.port || firstHop, p.get('type') || p.get('network') || 'tcp', p.get('security') || (['trojan', 'hy2', 'hysteria2', 'tuic'].includes(scheme) ? 'tls' : 'none'));
}
function fromObject(v: Fields, format: 'clash' | 'sing-box'): NodeProfile {
  const protocol = clean(v.type).toLowerCase(); if (!protocols.has(protocol)) throw new Error('不支持的协议');
  const transport = v.transport && typeof v.transport === 'object' ? v.transport as Record<string, unknown> : {};
  const tls = v.tls && typeof v.tls === 'object' ? v.tls as Record<string, unknown> : {};
  const firstPeer = Array.isArray(v.peers) && v.peers[0] && typeof v.peers[0] === 'object' ? v.peers[0] as Fields : undefined;
  const firstHop = (Array.isArray(v.server_ports) ? clean(v.server_ports[0]) : clean(v.ports)).split(/[:,\-]/)[0];
  const profile = node(clean(v.name) || clean(v.tag), protocol,
    protocol === 'wireguard' ? clean(firstPeer?.address ?? firstPeer?.server ?? v.server) : clean(v.server),
    protocol === 'wireguard' ? firstPeer?.port ?? v.port : v.port ?? v.server_port ?? firstHop,
    protocol === 'wireguard' ? 'udp' : clean(transport.type) || clean(v.network) || 'tcp',
    tls.reality || v['reality-opts'] ? 'reality' : tls.enabled || v.tls === true || ['trojan','tuic','hysteria2','hy2'].includes(protocol) ? 'tls' : 'none');
  return { ...profile, definition: { format, fields: v } };
}

function serialized(value: unknown): string {
  return JSON.stringify(value, (_, nested: unknown) => {
    if (!nested || typeof nested !== 'object' || Array.isArray(nested)) return nested;
    const fields = nested as Fields;
    return Object.fromEntries(Object.keys(fields).sort().map(key => [key, fields[key]]));
  });
}

export function nodeRevision(node: NodeProfile): string {
  return node.revision ?? node.uri ?? '';
}

function policySections(document: unknown): string[] | undefined {
  if (!document || typeof document !== 'object' || Array.isArray(document)) return;
  const value = document as Fields;
  const known = [
    ['策略组', ['proxy-groups']],
    ['订阅提供者', ['proxy-providers']],
    ['分流', ['rules', 'route', 'rule-providers', 'rule_set']],
    ['DNS', ['dns']],
    ['入站', ['inbounds', 'listeners']],
  ] as const;
  const selected = known.filter(([, keys]) => keys.some(key => Object.hasOwn(value, key))).map(([name]) => name);
  return selected.length ? selected : undefined;
}

const structuredKeys = /^[ \t]*["']?(?:proxies|proxy-groups|proxy-providers|rules|rule-providers|outbounds|endpoints)["']?[ \t]*:/m;

function mihomoDocument(document: unknown): Fields | undefined {
  if (!document || typeof document !== 'object' || Array.isArray(document)) return;
  const fields = document as Fields;
  const hasTraffic = ['proxies', 'proxy-groups', 'rules'].some(key =>
    Array.isArray(fields[key]) && fields[key].length > 0);
  const hasProviders = ['proxy-providers', 'rule-providers'].some(key => {
    const providers = fields[key];
    return providers && typeof providers === 'object' && !Array.isArray(providers) && Object.keys(providers).length > 0;
  });
  return hasTraffic || hasProviders ? fields : undefined;
}

export function parseSubscription(input: string): ImportResult {
  let text = input.trim(); if (!text) throw new Error('订阅内容为空');
  let format = 'URI'; let entries: unknown; let schema: 'clash' | 'sing-box' = 'sing-box';
  let sections: string[] | undefined;
  let mihomo: Fields | undefined;
  if (!text.includes('://') && !text.startsWith('{') && !text.startsWith('[') && !structuredKeys.test(text)) {
    try { text = decodeSubscriptionText(text).trim(); format = 'Base64'; } catch { throw new Error('无法识别订阅格式'); }
  }
  if (text.startsWith('{') || text.startsWith('[')) {
    const data = JSON.parse(text);
    mihomo = mihomoDocument(data);
    schema = mihomo ? 'clash' : 'sing-box';
    entries = Array.isArray(data) ? data : mihomo ? mihomo.proxies ?? [] : singBoxEntries(data);
    sections = policySections(data);
    format = schema === 'clash' ? 'Clash JSON' : 'sing-box JSON';
    if (!Array.isArray(entries)) throw new Error('JSON 中没有代理节点列表');
  } else if (structuredKeys.test(text)) {
    const data = parseYaml(text, { maxAliasCount: 100 });
    mihomo = mihomoDocument(data);
    entries = mihomo ? mihomo.proxies ?? [] : singBoxEntries(data);
    sections = policySections(data);
    schema = mihomo ? 'clash' : 'sing-box'; format = schema === 'clash' ? 'Clash YAML' : 'sing-box YAML';
    if (!Array.isArray(entries)) throw new Error('YAML 中没有代理节点列表');
  } else entries = text.split(/\r?\n/).map(x => x.trim()).filter(x => x && !x.startsWith('#'));
  if (!Array.isArray(entries)) throw new Error('配置中没有代理节点列表');
  const nodes: NodeProfile[] = [], warnings: string[] = [], seen = new Set<string>();
  entries.forEach((entry, index) => {
    try {
      const n = typeof entry === 'string' ? { ...fromUri(entry), uri: entry } : fromObject(entry as Fields, schema);
      const revision = typeof entry === 'string' ? entry : serialized(entry);
      if (!seen.has(revision)) { nodes.push({ ...n, revision, sourceIndex: index + 1 }); seen.add(revision); }
    } catch { warnings.push(`第 ${index + 1} 项未导入：格式无效或协议不支持`); }
  });
  if (!nodes.length && !mihomo) throw new Error(`没有找到可识别的节点（${entries.length} 项）`);
  return { nodes, warnings, format, policySections: sections, mihomo };
}

function singBoxEntries(document: unknown): unknown[] {
  if (!document || typeof document !== 'object' || Array.isArray(document)) throw new Error('配置不是对象');
  const { outbounds, endpoints } = document as Fields;
  if (!Array.isArray(outbounds) && !Array.isArray(endpoints)) throw new Error('配置中没有 outbounds 或 endpoints 列表');
  return [
    ...(Array.isArray(outbounds) ? outbounds : []),
    ...(Array.isArray(endpoints) ? endpoints : []),
  ];
}
