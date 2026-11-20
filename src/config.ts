import type { NodeProfile } from './subscription';

export type RouteRule = { type: 'domain' | 'domain_suffix'; value: string; action: 'direct' | 'proxy' | 'reject' };

export function normalizeRuleDomain(input: string): string {
  const domain = input.trim().toLowerCase().replace(/\.$/, '');
  if (!domain || domain.length > 253 || !domain.split('.').every(label =>
    /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) throw new Error('域名规则无效');
  return domain;
}

function compileOutbound(node: NodeProfile, tag: string): Record<string, unknown> {
  if (!node.uri || !['vless', 'hysteria2'].includes(node.protocol)) throw new Error('此节点类型尚不支持连接');
  const uri = new URL(node.uri);
  const query = uri.searchParams;
  const credential = decodeURIComponent(uri.username);
  if (!credential) throw new Error('节点缺少认证信息');
  const outbound: Record<string, unknown> = { type: node.protocol, tag, server: node.server, server_port: node.port };
  const security = query.get('security') || (node.protocol === 'hysteria2' ? 'tls' : 'none');
  const tls: Record<string, unknown> = { enabled: security !== 'none' };
  const serverName = query.get('sni') || query.get('servername') || query.get('peer');
  if (serverName) tls.server_name = serverName;
  if (query.get('insecure') === '1' || query.get('allowInsecure') === '1') tls.insecure = true;
  const alpn = query.get('alpn'); if (alpn) tls.alpn = alpn.split(',');
  const fingerprint = query.get('fp'); if (fingerprint) tls.utls = { enabled: true, fingerprint };
  if (security === 'reality') {
    const publicKey = query.get('pbk'); if (!publicKey) throw new Error('Reality 节点缺少公钥');
    tls.reality = { enabled: true, public_key: publicKey, short_id: query.get('sid') || '' };
  }
  if (node.protocol === 'vless') {
    if (query.get('encryption') && query.get('encryption') !== 'none') throw new Error('暂不支持此 VLESS 加密方式');
    outbound.uuid = credential;
    const flow = query.get('flow'); if (flow) outbound.flow = flow;
    const type = query.get('type') || 'tcp';
    if (type === 'ws') {
      const transport: Record<string, unknown> = { type: 'ws', path: query.get('path') || '/' };
      const host = query.get('host'); if (host) transport.headers = { Host: host };
      outbound.transport = transport;
    } else if (type === 'grpc') outbound.transport = { type: 'grpc', service_name: query.get('serviceName') || '' };
    else if (type !== 'tcp') throw new Error(`暂不支持 ${type} 传输`);
  } else {
    outbound.password = credential;
    const multiPort = query.get('mport');
    if (multiPort) {
      const ports = multiPort.split(',').map(value => value.trim().replace('-', ':'));
      if (ports.some(value => !/^\d{1,5}(:\d{1,5})?$/.test(value) || value.split(':').some(port => +port < 1 || +port > 65535) || (value.includes(':') && +value.split(':')[0] > +value.split(':')[1]))) throw new Error('Hysteria2 端口范围无效');
      delete outbound.server_port;
      outbound.server_ports = ports;
    }
  }
  if (tls.enabled) outbound.tls = tls;
  return outbound;
}

function compileConfig(outbounds: object[], port: number, rules: RouteRule[]) {
  const compiledRules = rules.map(rule => {
    const value = normalizeRuleDomain(rule.value);
    return rule.action === 'reject' ? { [rule.type]: [value], action: 'reject' } : { [rule.type]: [value], outbound: rule.action };
  });
  return { log: { level: 'warn' }, inbounds: [{ type: 'mixed', tag: 'local', listen: '127.0.0.1', listen_port: port }], outbounds: [...outbounds, { type: 'direct', tag: 'direct' }], route: { rules: compiledRules, final: 'proxy', auto_detect_interface: true } };
}

export function buildConfig(node: NodeProfile, port: number, rules: RouteRule[] = []) {
  return compileConfig([compileOutbound(node, 'proxy')], port, rules);
}

export type SessionPlan = {
  config: ReturnType<typeof compileConfig>;
  loaded: Map<string, { tag: string; uri?: string }>;
};

export function buildSessionConfig(selected: NodeProfile, candidates: NodeProfile[], port: number, rules: RouteRule[]): SessionPlan {
  const outbounds = [compileOutbound(selected, 'node-0')];
  const loaded = new Map([[selected.id, { tag: 'node-0', uri: selected.uri }]]);
  for (const candidate of candidates) {
    if (loaded.has(candidate.id) || outbounds.length >= 2048) continue;
    const tag = `node-${outbounds.length}`;
    try {
      outbounds.push(compileOutbound(candidate, tag));
      loaded.set(candidate.id, { tag, uri: candidate.uri });
    } catch { /* Unsupported nodes remain visible in the node list. */ }
  }
  return {
    config: compileConfig([{
      type: 'selector', tag: 'proxy', outbounds: outbounds.map(outbound => outbound.tag),
      default: 'node-0', interrupt_exist_connections: false,
    }, ...outbounds], port, rules),
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
