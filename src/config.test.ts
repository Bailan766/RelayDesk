import { describe, it, expect } from 'vitest';
import { buildConfig } from './config';
import { parseSubscription } from './subscription';

describe('sing-box configuration', () => {
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
});
