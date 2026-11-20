import { parse as parseYaml } from 'yaml';

export interface NodeProfile { id: string; name: string; protocol: string; server: string; port: number; transport: string; security: string; uri?: string }
export interface ImportResult { nodes: NodeProfile[]; warnings: string[]; format: string }
const protocols = new Set(['vless', 'vmess', 'trojan', 'ss', 'hysteria2', 'hy2', 'tuic', 'shadowsocks']);
const decode = (value: string) => new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(atob(value.replace(/\s/g, '').replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0)));
const clean = (value: unknown) => typeof value === 'string' ? value : '';
function node(name: string, protocol: string, server: string, port: unknown, transport = 'tcp', security = 'none'): NodeProfile {
  const n = Number(port); if (!server || !Number.isInteger(n) || n < 1 || n > 65535) throw new Error('节点地址或端口无效');
  return { id: crypto.randomUUID(), name: name || server, protocol: protocol === 'hy2' ? 'hysteria2' : protocol === 'ss' ? 'shadowsocks' : protocol, server, port: n, transport, security };
}
function fromUri(line: string): NodeProfile {
  const scheme = line.slice(0, line.indexOf('://')).toLowerCase();
  if (!protocols.has(scheme)) throw new Error('不支持的协议');
  if (scheme === 'vmess') {
    const v = JSON.parse(decode(line.slice(8)));
    return node(clean(v.ps), 'vmess', clean(v.add), v.port, clean(v.net) || 'tcp', clean(v.tls) || 'none');
  }
  let uri = line;
  if (scheme === 'ss' && !line.slice(5).split(/[?#]/)[0].includes('@')) {
    const [payload, suffix = ''] = line.slice(5).split(/(?=[?#])/s, 2); uri = `ss://${decode(payload)}${suffix}`;
  }
  const url = new URL(uri);
  const p = url.searchParams;
  return node(decodeURIComponent(url.hash.slice(1)), scheme, url.hostname, url.port, p.get('type') || p.get('network') || 'tcp', p.get('security') || (['trojan', 'hy2', 'hysteria2', 'tuic'].includes(scheme) ? 'tls' : 'none'));
}
function fromObject(v: Record<string, unknown>): NodeProfile {
  const protocol = clean(v.type).toLowerCase(); if (!protocols.has(protocol)) throw new Error('不支持的协议');
  const transport = v.transport && typeof v.transport === 'object' ? v.transport as Record<string, unknown> : {};
  const tls = v.tls && typeof v.tls === 'object' ? v.tls as Record<string, unknown> : {};
  return node(clean(v.name) || clean(v.tag), protocol, clean(v.server), v.port ?? v.server_port, clean(v.network) || clean(transport.type) || 'tcp', tls.enabled || v.tls === true ? 'tls' : 'none');
}
export function parseSubscription(input: string): ImportResult {
  let text = input.trim(); if (!text) throw new Error('订阅内容为空');
  let format = 'URI'; let entries: unknown[];
  if (!text.includes('://') && !text.startsWith('{') && !text.startsWith('[') && !/^(proxies|outbounds):/m.test(text)) {
    try { text = decode(text).trim(); format = 'Base64'; } catch { throw new Error('无法识别订阅格式'); }
  }
  if (text.startsWith('{') || text.startsWith('[')) {
    const data = JSON.parse(text); entries = Array.isArray(data) ? data : data.outbounds; format = 'sing-box JSON';
    if (!Array.isArray(entries)) throw new Error('JSON 中没有 outbounds 列表');
  } else if (/^\s*(proxies|outbounds):/m.test(text)) {
    const data = parseYaml(text); entries = data?.proxies ?? data?.outbounds; format = 'Clash YAML';
    if (!Array.isArray(entries)) throw new Error('YAML 中没有代理节点列表');
  } else entries = text.split(/\r?\n/).map(x => x.trim()).filter(x => x && !x.startsWith('#'));
  const nodes: NodeProfile[] = [], warnings: string[] = [], seen = new Set<string>();
  entries.forEach((entry, index) => {
    try {
      const n = typeof entry === 'string' ? { ...fromUri(entry), uri: entry } : fromObject(entry as Record<string, unknown>);
      const key = `${n.protocol}|${n.server}|${n.port}|${n.name}`;
      if (!seen.has(key)) { nodes.push(n); seen.add(key); }
    } catch { warnings.push(`第 ${index + 1} 项未导入：格式无效或协议不支持`); }
  });
  if (!nodes.length) throw new Error(`没有找到可识别的节点（${entries.length} 项）`);
  return { nodes, warnings, format };
}
