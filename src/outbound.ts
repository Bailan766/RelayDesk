import { decodeSubscriptionText, type Fields, type NodeProfile } from './subscription';
import { normalizeIpCidr } from './ip';

const protocolFields: Record<string, string> = {
  vless: 'uuid flow packet_encoding transport tls',
  vmess: 'uuid security alter_id global_padding authenticated_length packet_encoding transport tls',
  trojan: 'password transport tls',
  shadowsocks: 'method password plugin plugin_opts udp_over_tcp',
  hysteria2: 'password server_ports hop_interval up_mbps down_mbps obfs tls',
  tuic: 'uuid password congestion_control udp_relay_mode udp_over_stream zero_rtt_handshake heartbeat tls',
};

function object(value: unknown, field: string): Fields {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${field} 格式有误`);
  return value as Fields;
}

function fieldsOnly(value: Fields, allowed: string, label: string) {
  const keys = new Set(allowed.split(' '));
  const unknown = Object.keys(value).find(key => !keys.has(key));
  if (unknown !== undefined) {
    const field = /^[a-zA-Z0-9_-]{1,40}$/.test(unknown) ? ` ${unknown}` : '';
    throw new Error(`${label}包含暂不支持的字段${field}`);
  }
}

function optionalString(value: unknown, field = '节点参数'): string | undefined {
  if (value == null || value === '') return;
  if (typeof value !== 'string') throw new Error(`${field}须为文本`);
  return value;
}

function requiredString(value: unknown, field: string): string {
  const result = optionalString(value, field);
  if (!result) throw new Error(`节点缺少${field}`);
  return result;
}

function optionalBool(value: unknown): boolean | undefined {
  if (value == null) return;
  if (typeof value !== 'boolean') throw new Error('节点开关须为布尔值');
  return value;
}

function integer(value: unknown, field: string): number | undefined {
  if (value == null || value === '') return;
  if (!/^\d+$/.test(String(value)) || !Number.isSafeInteger(Number(value))) throw new Error(`${field}无效`);
  return Number(value);
}

function rate(value: unknown): number | undefined {
  if (typeof value === 'string') return integer(value.trim().replace(/\s*mbps$/i, ''), '带宽');
  return integer(value, '带宽');
}

function strings(value: unknown, field: string): string[] | undefined {
  if (value == null || value === '') return;
  const items = typeof value === 'string' ? value.split(',').map(item => item.trim()) : value;
  if (!Array.isArray(items) || items.some(item => typeof item !== 'string' || !item)) throw new Error(`${field}格式有误`);
  return items;
}

function ports(value: unknown): string[] | undefined {
  const list = strings(value, '端口范围')?.map(item => item.replace('-', ':'));
  if (list?.some(value => {
    const parts = value.split(':').map(Number);
    return !/^\d{1,5}(:\d{1,5})?$/.test(value) || parts.some(port => port < 1 || port > 65535)
      || (parts.length === 2 && parts[0] > parts[1]);
  })) throw new Error('Hysteria2 端口范围无效');
  return list;
}

function truthy(value: string | null) {
  return value === '1' || value?.toLowerCase() === 'true';
}

function tlsFields(enabled: boolean, sni: unknown, insecure?: boolean, alpn?: unknown, fingerprint?: unknown) {
  const fp = optionalString(fingerprint);
  return { enabled, server_name: optionalString(sni, 'SNI'), insecure,
    alpn: strings(alpn, 'ALPN'), utls: fp ? { enabled: true, fingerprint: fp } : undefined };
}

function transport(kind: string, options: Fields = {}): Fields | undefined {
  switch (kind) {
    case '':
    case 'tcp':
    case 'raw': return;
    case 'ws':
    case 'httpupgrade': {
      const headers = options.headers == null ? undefined : object(options.headers, '传输头');
      if (headers) fieldsOnly(headers, 'Host host', '传输头');
      const host = optionalString(options.host ?? headers?.Host ?? headers?.host);
      return { type: kind, path: optionalString(options.path) ?? '/',
        ...(kind === 'ws' ? { headers: host && { Host: host },
          max_early_data: integer(options.max_early_data, 'WebSocket 早期数据'),
          early_data_header_name: optionalString(options.early_data_header_name) } : { host }) };
    }
    case 'grpc': return { type: 'grpc', service_name: optionalString(options.service_name) ?? '' };
    default: throw new Error('此节点的传输方式暂不支持');
  }
}

function plugin(value: unknown, options: unknown): Fields {
  const raw = optionalString(value);
  if (!raw && options == null) return {};
  const name = raw === 'obfs' ? 'obfs-local' : raw;
  if (name !== 'obfs-local' && name !== 'v2ray-plugin') throw new Error('此 Shadowsocks 插件暂不支持');
  const opts = optionalString(options);
  if (opts?.split(';').some(item => item && !/^(?:(?:mode|host|path|obfs|obfs-host)=[^;\r\n]*|tls)$/.test(item))) {
    throw new Error('此 Shadowsocks 插件参数暂不支持');
  }
  return { plugin: name, plugin_opts: opts };
}

function shadowsocksUri(text: string): Fields {
  const separator = text.indexOf('://') + 3;
  const [userAndHost, tail = ''] = text.slice(separator).split(/(?=[?#])/s, 2);
  const at = userAndHost.lastIndexOf('@');
  const userinfo = at >= 0 ? decodeURIComponent(userAndHost.slice(0, at)) : decodeSubscriptionText(userAndHost);
  const user = at < 0 ? userinfo.slice(0, userinfo.lastIndexOf('@'))
    : userinfo.includes(':') ? userinfo : decodeSubscriptionText(userinfo);
  const colon = user.indexOf(':');
  if (colon < 1) throw new Error('Shadowsocks 凭据无效');
  const [name, ...options] = (new URL(`ss://node.invalid${tail}`).searchParams.get('plugin') ?? '').split(';');
  return { method: user.slice(0, colon), password: user.slice(colon + 1), ...plugin(name, options.length ? options.join(';') : undefined) };
}

function uriFields(node: NodeProfile): Fields {
  const text = node.uri!;
  if (node.protocol === 'shadowsocks') return shadowsocksUri(text);
  const uri = new URL(text);
  const q = uri.searchParams;
  const user = decodeURIComponent(uri.username);
  const secret = decodeURIComponent(uri.password);
  const security = q.get('security') ?? (node.protocol === 'vless' ? 'none' : 'tls');
  if (!['none', 'tls', 'reality'].includes(security)) throw new Error('此节点的 TLS 模式暂不支持');
  if (q.has('pinSHA256') || q.has('pin-sha256')) throw new Error('当前内核无法保留此证书指纹校验');
  if (q.get('headerType') && q.get('headerType') !== 'none') throw new Error('此节点的传输头暂不支持');
  if (q.get('mode') && q.get('mode') !== 'gun' && (q.get('type') === 'grpc' || q.get('network') === 'grpc')) {
    throw new Error('此节点的 gRPC 工作模式暂不支持');
  }
  const tls: Fields = tlsFields(security !== 'none', q.get('sni') || q.get('servername') || q.get('peer'),
    truthy(q.get('insecure')) || truthy(q.get('allowInsecure')), q.get('alpn'), q.get('fp'));
  if (security === 'reality') tls.reality = { enabled: true, public_key: requiredString(q.get('pbk'), 'Reality 公钥'), short_id: q.get('sid') || '' };
  const auth = secret ? `${user}:${secret}` : user;
  switch (node.protocol) {
    case 'vless':
    case 'trojan':
      if (q.get('encryption') && q.get('encryption') !== 'none') throw new Error('暂不支持此 VLESS 加密方式');
      return { ...(node.protocol === 'vless' ? { uuid: user, flow: optionalString(q.get('flow')),
        packet_encoding: optionalString(q.get('packetEncoding')) } : { password: auth }),
        tls: tls.enabled ? tls : undefined,
        transport: transport(q.get('type') || q.get('network') || 'tcp', {
          path: q.get('path'), host: q.get('host'), service_name: q.get('serviceName'),
          max_early_data: q.get('ed'), early_data_header_name: q.get('eh'),
        }) };
    case 'hysteria2': {
      const obfs = q.get('obfs');
      return { password: auth, tls, server_ports: ports(q.get('mport')),
        obfs: obfs ? { type: obfs, password: q.get('obfs-password') } : undefined };
    }
    case 'tuic':
      if (q.has('token')) throw new Error('TUIC v4 需另一个兼容内核');
      return { uuid: user, password: secret, tls, congestion_control: optionalString(q.get('congestion_control') ?? q.get('congestion-control')),
        udp_relay_mode: optionalString(q.get('udp_relay_mode') ?? q.get('udp-relay-mode')),
        zero_rtt_handshake: q.has('zero_rtt_handshake') ? truthy(q.get('zero_rtt_handshake')) : undefined };
    default: throw new Error('此节点类型尚不支持连接');
  }
}

function clashFields(node: NodeProfile, value: Fields): Fields {
  const protocol = node.protocol;
  if (!protocolFields[protocol]) throw new Error('此节点类型尚不支持连接');
  const connectionKeys: Record<string, string> = {
    vless: 'uuid flow packet-encoding encryption network ws-opts grpc-opts http-upgrade-opts',
    vmess: 'uuid alterId cipher packet-encoding network ws-opts grpc-opts http-upgrade-opts',
    trojan: 'password network ws-opts grpc-opts http-upgrade-opts',
    shadowsocks: 'cipher password plugin plugin-opts udp-over-tcp',
    hysteria2: 'password ports hop-interval up down obfs obfs-password',
    tuic: 'uuid password congestion-controller udp-relay-mode reduce-rtt heartbeat-interval udp-over-stream',
  };
  fieldsOnly(value, `name type server port udp tls servername sni skip-cert-verify client-fingerprint alpn reality-opts ${connectionKeys[protocol]}`, 'Clash 节点');
  if (protocol === 'shadowsocks') {
    const options = value['plugin-opts'] == null ? {} : object(value['plugin-opts'], '插件选项');
    fieldsOnly(options, 'mode host path tls', '插件选项');
    const pluginName = optionalString(value.plugin);
    const obfs = pluginName === 'obfs' || pluginName === 'obfs-local';
    const encoded = Object.entries(options).flatMap(([name, item]) =>
      name === 'tls' ? (optionalBool(item) ? ['tls'] : []) : [`${obfs ? (name === 'mode' ? 'obfs' : name === 'host' ? 'obfs-host' : name) : name}=${requiredString(item, '插件选项')}`]);
    return { method: value.cipher, password: value.password, network: value.udp === false ? 'tcp' : undefined,
      udp_over_tcp: optionalBool(value['udp-over-tcp']), ...plugin(pluginName, encoded.length ? encoded.join(';') : undefined) };
  }
  const network = optionalBool(value.udp) === false ? 'tcp' : undefined;
  const tls: Fields = tlsFields(protocol === 'trojan' || protocol === 'tuic' || protocol === 'hysteria2'
    || optionalBool(value.tls) === true || !!value['reality-opts'], value.servername ?? value.sni,
    optionalBool(value['skip-cert-verify']), value.alpn, value['client-fingerprint']);
  if (value['reality-opts'] !== undefined) {
    const reality = object(value['reality-opts'], 'Reality 配置');
    fieldsOnly(reality, 'public-key short-id', 'Reality');
    tls.reality = { enabled: true, public_key: requiredString(reality['public-key'], 'Reality 公钥'), short_id: optionalString(reality['short-id']) ?? '' };
  }
  if (protocol === 'hysteria2') {
    const obfs = optionalString(value.obfs);
    const hop = integer(value['hop-interval'], '端口跳跃间隔');
    return { password: value.password, tls, network, server_ports: ports(value.ports),
      hop_interval: hop !== undefined ? `${hop}s` : undefined, up_mbps: rate(value.up), down_mbps: rate(value.down),
      obfs: obfs ? { type: obfs, password: value['obfs-password'] } : undefined };
  }
  if (protocol === 'tuic') {
    const interval = integer(value['heartbeat-interval'], '心跳间隔');
    return { uuid: value.uuid, password: value.password, tls, network, congestion_control: value['congestion-controller'],
      udp_relay_mode: value['udp-relay-mode'], udp_over_stream: optionalBool(value['udp-over-stream']),
      zero_rtt_handshake: optionalBool(value['reduce-rtt']), heartbeat: interval !== undefined ? `${interval}ms` : undefined };
  }
  if (value.encryption && value.encryption !== 'none') throw new Error('暂不支持此 VLESS 加密方式');
  const kind = optionalString(value.network) ?? 'tcp';
  const optionsKey = kind === 'ws' ? 'ws-opts' : kind === 'grpc' ? 'grpc-opts' : kind === 'httpupgrade' ? 'http-upgrade-opts' : undefined;
  const options = optionsKey && value[optionsKey] !== undefined ? object(value[optionsKey], '传输配置') : {};
  fieldsOnly(options, kind === 'grpc' ? 'grpc-service-name' : 'path headers max-early-data early-data-header-name', '传输配置');
  return { tls: tls.enabled ? tls : undefined, network,
    ...(protocol === 'trojan' ? { password: value.password } : { uuid: value.uuid, packet_encoding: value['packet-encoding'] }),
    ...(protocol === 'vless' ? { flow: value.flow } : protocol === 'vmess'
      ? { security: value.cipher ?? 'auto', alter_id: integer(value.alterId, 'Alter ID') ?? 0 } : {}),
    transport: transport(kind, { ...options, service_name: options['grpc-service-name'],
      max_early_data: options['max-early-data'], early_data_header_name: options['early-data-header-name'] }) };
}

function vmessUri(value: Fields): Fields {
  fieldsOnly(value, 'v ps add port id aid scy net type host path tls sni alpn fp', 'VMess');
  if (value.type && value.type !== 'none') throw new Error('此 VMess 传输头暂不支持');
  if (value.tls && value.tls !== 'tls' && value.tls !== 'none') throw new Error('此 VMess TLS 模式暂不支持');
  const kind = optionalString(value.net) ?? 'tcp';
  return { uuid: value.id, security: value.scy ?? 'auto', alter_id: integer(value.aid, 'Alter ID') ?? 0,
    tls: value.tls === 'tls' ? tlsFields(true, value.sni, undefined, value.alpn, value.fp) : undefined,
    transport: transport(kind, { host: value.host, path: value.path, service_name: value.path }) };
}

function cleanFields(value: Fields): Fields {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item != null).map(([key, item]) =>
    [key, item && typeof item === 'object' && !Array.isArray(item) ? cleanFields(item as Fields) : item]));
}

function validate(value: Fields, protocol: string) {
  fieldsOnly(value, `network ${protocolFields[protocol]}`, '节点');
  if (['vless', 'vmess', 'tuic'].includes(protocol)) requiredString(value.uuid, 'UUID');
  if (['trojan', 'hysteria2', 'shadowsocks'].includes(protocol)) requiredString(value.password, '密码');
  if (protocol === 'shadowsocks') {
    requiredString(value.method, '加密方式');
    Object.assign(value, plugin(value.plugin, value.plugin_opts));
  }
  if (value.network !== undefined && value.network !== 'tcp' && value.network !== 'udp') throw new Error('节点网络模式无效');
  if (value.tls !== undefined) {
    const tls = object(value.tls, 'TLS');
    fieldsOnly(tls, 'enabled server_name insecure alpn min_version max_version disable_sni certificate_public_key_sha256 utls reality', 'TLS');
    for (const key of ['enabled','insecure','disable_sni']) optionalBool(tls[key]);
    for (const key of ['server_name','min_version','max_version']) optionalString(tls[key]);
    for (const key of ['alpn','certificate_public_key_sha256']) if (tls[key] !== undefined) tls[key] = strings(tls[key], key);
    if (tls.utls !== undefined) {
      const utls = object(tls.utls, 'uTLS');
      fieldsOnly(utls, 'enabled fingerprint', 'uTLS');
      optionalBool(utls.enabled); optionalString(utls.fingerprint);
    }
    if (tls.reality !== undefined) {
      const reality = object(tls.reality, 'Reality');
      fieldsOnly(reality, 'enabled public_key short_id', 'Reality');
      optionalBool(reality.enabled); if (reality.enabled) requiredString(reality.public_key, 'Reality 公钥');
      optionalString(reality.short_id);
    }
  }
  if (['hysteria2', 'tuic'].includes(protocol) && (value.tls as Fields | undefined)?.enabled !== true) throw new Error('此协议需要 TLS');
  if (value.transport !== undefined) {
    const item = object(value.transport, '传输');
    const kind = requiredString(item.type, '传输方式');
    fieldsOnly(item, kind === 'grpc' ? 'type service_name' : kind === 'httpupgrade' ? 'type host path'
      : 'type path headers max_early_data early_data_header_name', '传输');
    value.transport = transport(kind, item);
  }
  if (value.obfs !== undefined) {
    const obfs = object(value.obfs, '混淆');
    fieldsOnly(obfs, 'type password', '混淆');
    if (obfs.type !== 'salamander') throw new Error('此 Hysteria2 混淆暂不支持');
    requiredString(obfs.password, '混淆密码');
  }
  if (value.server_ports !== undefined) value.server_ports = ports(value.server_ports);
  for (const key of ['password','flow','packet_encoding','security','hop_interval','congestion_control','udp_relay_mode','heartbeat']) optionalString(value[key]);
  for (const key of ['global_padding','authenticated_length','udp_over_tcp','udp_over_stream','zero_rtt_handshake']) optionalBool(value[key]);
  for (const key of ['alter_id','up_mbps','down_mbps']) if (value[key] !== undefined) value[key] = integer(value[key], key);
}

function wireguardKey(value: unknown): string {
  const key = requiredString(value, 'WireGuard 密钥');
  if (!/^[A-Za-z0-9+/]{43}=$/.test(key) || atob(key).length !== 32) throw new Error('WireGuard 密钥格式无效');
  return key;
}

function wireguardAddresses(value: unknown): string[] {
  const addresses = strings(value, 'WireGuard 地址');
  if (!addresses?.length || addresses.length > 64) throw new Error('WireGuard 地址列表无效');
  return addresses.map(normalizeIpCidr);
}

function wireguardPeer(data: Fields, clash: boolean, defaultAddresses?: string[], keepaliveDefault?: unknown): Fields {
  fieldsOnly(data, clash ? 'server port public-key pre-shared-key allowed-ips reserved persistent-keepalive'
    : 'address port public_key pre_shared_key allowed_ips reserved persistent_keepalive_interval', 'WireGuard 对端');
  const destination = requiredString(clash ? data.server : data.address, 'WireGuard 对端地址')
    .replace(/^\[([^\]]+)\]$/, '$1');
  if (destination.length > 253 || !/^[A-Za-z0-9:._-]+$/.test(destination)) {
    throw new Error('WireGuard 对端地址无效');
  }
  const port = integer(data.port, 'WireGuard 端口');
  if (!port || port > 65535) throw new Error('WireGuard 端口无效');
  const preshared = clash ? data['pre-shared-key'] : data.pre_shared_key;
  if (destination.includes(':')) normalizeIpCidr(destination);
  const keepalive = integer(clash ? data['persistent-keepalive'] ?? keepaliveDefault : data.persistent_keepalive_interval, 'WireGuard 保活间隔');
  if (keepalive !== undefined && keepalive > 65535) throw new Error('WireGuard 保活间隔无效');
  const reserved = typeof data.reserved === 'string' ? Array.from(atob(data.reserved), byte => byte.charCodeAt(0)) : data.reserved;
  if (reserved != null && (!Array.isArray(reserved) || reserved.length !== 3
      || reserved.some(value => !Number.isInteger(value) || value < 0 || value > 255))) {
    throw new Error('WireGuard 保留字段须为 3 字节');
  }
  return {
    address: destination, port,
    public_key: wireguardKey(clash ? data['public-key'] : data.public_key),
    pre_shared_key: preshared == null || preshared === '' ? undefined : wireguardKey(preshared),
    allowed_ips: (clash ? data['allowed-ips'] : data.allowed_ips) == null && defaultAddresses
      ? defaultAddresses : wireguardAddresses(clash ? data['allowed-ips'] : data.allowed_ips),
    reserved,
    persistent_keepalive_interval: keepalive,
  };
}

function wireguardEndpoint(node: NodeProfile, tag: string): Fields {
  const source = node.definition;
  if (!source || source.format === 'vmess-uri') throw new Error('缺少 WireGuard 配置');
  const data = source.fields;
  const clash = source.format === 'clash';
  let addresses: string[];
  let peers: unknown[];
  let defaultKeepalive: unknown;
  let singleClashPeer = false;
  if (clash) {
    const { name: _name, type: _type, ip, ipv6, 'private-key': _key, mtu: _mtu, udp,
      'persistent-keepalive': keepalive, peers: explicitPeers, ...peer } = data;
    defaultKeepalive = keepalive;
    if (optionalBool(udp) === false) throw new Error('当前内核无法关闭此 WireGuard 节点的 UDP 转发');
    addresses = wireguardAddresses([ip, ipv6].filter(value => value != null && value !== ''));
    if (explicitPeers != null) {
      if (Object.keys(peer).length) throw new Error('WireGuard 配置混用了单对端和多对端参数');
      if (!Array.isArray(explicitPeers)) throw new Error('WireGuard 对端列表格式有误');
      peers = explicitPeers;
    } else {
      peers = [peer];
      singleClashPeer = true;
    }
  } else {
    fieldsOnly(data, 'type tag system mtu address private_key peers', 'WireGuard 端点');
    if (optionalBool(data.system) === true) throw new Error('独立节点仅支持 WireGuard 用户态端点');
    addresses = wireguardAddresses(data.address);
    if (!Array.isArray(data.peers)) throw new Error('WireGuard 对端列表格式有误');
    peers = data.peers;
  }
  if (!peers.length || peers.length > 32) throw new Error('WireGuard 对端列表大小无效');
  const allowed = [
    ...(addresses.some(address => !address.includes(':')) ? ['0.0.0.0/0'] : []),
    ...(addresses.some(address => address.includes(':')) ? ['::/0'] : []),
  ];
  const outputPeers = peers.map(peer => cleanFields(wireguardPeer(object(peer, 'WireGuard 对端'), clash,
    singleClashPeer ? allowed : undefined, defaultKeepalive)));
  const mtu = integer(data.mtu, 'WireGuard MTU');
  if (mtu !== undefined && (mtu < 576 || mtu > 65535)) throw new Error('WireGuard MTU 无效');
  return cleanFields({
    // Dial the peer through the physical interface without opening unsolicited UDP listeners.
    type: 'wireguard', tag, system: false, detour: 'wireguard-uplink', address: addresses, peers: outputPeers,
    private_key: wireguardKey(clash ? data['private-key'] : data.private_key), mtu,
  });
}

export function compileOutbound(node: NodeProfile, tag: string): Fields {
  if (node.protocol === 'wireguard') return wireguardEndpoint(node, tag);
  if (!protocolFields[node.protocol]) throw new Error('此节点类型尚不支持连接');
  const source = node.definition;
  let settings: Fields;
  if (source?.format === 'sing-box') {
    const { type: _type, tag: _tag, name: _name, server: _server, server_port: _port, ...fields } = source.fields;
    settings = cleanFields(fields);
  } else if (source?.format === 'clash') settings = clashFields(node, source.fields);
  else if (source?.format === 'vmess-uri') settings = vmessUri(source.fields);
  else if (node.uri) settings = uriFields(node);
  else throw new Error('缺少节点配置');
  settings = cleanFields(settings);
  validate(settings, node.protocol);
  return cleanFields({ type: node.protocol, tag, server: node.server,
    server_port: settings.server_ports ? undefined : node.port, ...settings });
}
