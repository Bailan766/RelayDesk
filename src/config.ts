import type { NodeProfile } from './subscription';

export function buildConfig(node: NodeProfile, port: number): object {
  if (!node.uri || !['vless', 'hysteria2'].includes(node.protocol)) throw new Error('此节点类型尚不支持连接');
  const uri = new URL(node.uri);
  const query = uri.searchParams;
  const credential = decodeURIComponent(uri.username);
  if (!credential) throw new Error('节点缺少认证信息');
  const outbound: Record<string, unknown> = { type: node.protocol, tag: 'proxy', server: node.server, server_port: node.port };
  const security = query.get('security') || (node.protocol === 'hysteria2' ? 'tls' : 'none');
  const tls: Record<string, unknown> = { enabled: security !== 'none' };
  const serverName = query.get('sni') || query.get('peer');
  if (serverName) tls.server_name = serverName;
  if (query.get('insecure') === '1' || query.get('allowInsecure') === '1') tls.insecure = true;
  const alpn = query.get('alpn'); if (alpn) tls.alpn = alpn.split(',');
  const fingerprint = query.get('fp'); if (fingerprint) tls.utls = { enabled: true, fingerprint };
  if (security === 'reality') {
    const publicKey = query.get('pbk'); if (!publicKey) throw new Error('Reality 节点缺少公钥');
    tls.reality = { enabled: true, public_key: publicKey, short_id: query.get('sid') || '' };
  }
  if (node.protocol === 'vless') {
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
      if (ports.some(value => !/^\d{1,5}(:\d{1,5})?$/.test(value) || value.split(':').some(port => +port < 1 || +port > 65535))) throw new Error('Hysteria2 端口范围无效');
      delete outbound.server_port;
      outbound.server_ports = ports;
    }
  }
  if (tls.enabled) outbound.tls = tls;
  return { log: { level: 'warn' }, inbounds: [{ type: 'mixed', tag: 'local', listen: '127.0.0.1', listen_port: port }], outbounds: [outbound, { type: 'direct', tag: 'direct' }], route: { final: 'proxy', auto_detect_interface: true } };
}
