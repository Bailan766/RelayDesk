import { describe, it, expect } from 'vitest';
import { buildConfig } from './config';
import { parseSubscription } from './subscription';

describe('sing-box configuration', () => {
  it('compiles ordered domain routing rules and rejects invalid values', () => {
    const node = parseSubscription('vless://id@host.test:443#Test').nodes[0];
    const config = buildConfig(node, 12345, [
      { type: 'domain', value: 'example.com', action: 'direct' },
      { type: 'domain_suffix', value: 'blocked.test', action: 'reject' },
    ]) as any;
    expect(config.route.rules).toEqual([
      { domain: ['example.com'], outbound: 'direct' },
      { domain_suffix: ['blocked.test'], action: 'reject' },
    ]);
    expect(() => buildConfig(node, 12345, [{ type: 'domain', value: 'bad domain', action: 'proxy' }])).toThrow('域名规则无效');
  });
  it('preserves VLESS Reality connection parameters', () => {
    const node = parseSubscription('vless://00000000-0000-4000-8000-000000000000@host.test:443?security=reality&pbk=public-key&sid=1234&sni=site.test&fp=chrome&flow=xtls-rprx-vision#Test').nodes[0];
    const result = buildConfig(node, 12345) as any;
    expect(result.outbounds[0]).toMatchObject({ type: 'vless', uuid: '00000000-0000-4000-8000-000000000000', flow: 'xtls-rprx-vision', tls: { server_name: 'site.test', reality: { public_key: 'public-key', short_id: '1234' } } });
  });
  it('preserves Hysteria2 credentials and SNI', () => {
    const node = parseSubscription('hysteria2://password@host.test:443?sni=site.test#Test').nodes[0];
    expect((buildConfig(node, 12345) as any).outbounds[0]).toMatchObject({ type: 'hysteria2', password: 'password', tls: { enabled: true, server_name: 'site.test' } });
  });
  it('preserves Hysteria2 port hopping', () => {
    const node = parseSubscription('hysteria2://password@host.test:443?mport=2000-3000,4000#Test').nodes[0];
    const outbound = (buildConfig(node, 12345) as any).outbounds[0];
    expect(outbound.server_ports).toEqual(['2000:3000', '4000']);
    expect(outbound.server_port).toBeUndefined();
  });
  it('refuses unsupported encryption and invalid port ranges', () => {
    const vless = parseSubscription('vless://id@host.test:443?encryption=custom#Test').nodes[0];
    expect(() => buildConfig(vless, 12345)).toThrow('加密');
    const hy = parseSubscription('hysteria2://password@host.test:443?mport=3000-2000#Test').nodes[0];
    expect(() => buildConfig(hy, 12345)).toThrow('端口');
  });
  it('preserves legacy Shadowsocks credentials and percent-encoded modern credentials', () => {
    for (const uri of [`ss://${btoa('aes-128-gcm:a:@b@host.test:8388')}#legacy`,
      'ss://aes-128-gcm:a%3A%40b@host.test:8388#sip002']) {
      const outbound = buildConfig(parseSubscription(uri).nodes[0], 12345).outbounds[0];
      expect(outbound).toMatchObject({ type: 'shadowsocks', method: 'aes-128-gcm', password: 'a:@b', server: 'host.test' });
    }
  });
  it('preserves structured TLS hostname and transport, and flags certificate semantics it cannot preserve', () => {
    const source = 'proxies:\n- {name: test, type: vless, server: example.org, port: 443, uuid: id, tls: true, servername: tls.test, network: ws, ws-opts: {path: /a, headers: {Host: edge.test}}}';
    const node = parseSubscription(source).nodes[0];
    expect(buildConfig(node, 12345).outbounds[0]).toMatchObject({
      uuid: 'id', tls: { enabled: true, server_name: 'tls.test' },
      transport: { type: 'ws', path: '/a', headers: { Host: 'edge.test' } },
    });
    const outbound = { type: 'trojan', server: 'test.example.org', server_port: 443, password: 'fixture',
      tls: { enabled: true, certificate_path: 'fixture.pem' } };
    expect(() => buildConfig(parseSubscription(JSON.stringify([outbound])).nodes[0], 12345)).toThrow('certificate_path');
  });
});
