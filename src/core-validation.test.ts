import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { buildConfig, withMihomoCustomRules } from './config';
import { parseSubscription } from './subscription';

const core = process.env.SING_BOX;
const mihomo = process.env.MIHOMO;
const uuid = '00000000-0000-4000-8000-000000000000';
describe.skipIf(!core)('real sing-box config validation', () => {
  const examples = [
    'vless://00000000-0000-4000-8000-000000000000@host.test:443?security=tls&sni=host.test&type=ws&path=%2Fws#ws',
    'hysteria2://password@host.test:443?sni=host.test&mport=2000-3000#hy',
    'trojan://password@host.test:443?sni=tls.host.test&type=grpc&serviceName=fixture#trojan',
    `vmess://${btoa(JSON.stringify({v:'2',ps:'VMess',add:'vmess.test',port:443,id:uuid,aid:0,net:'ws',type:'none',host:'cdn.test',path:'/test',tls:'tls',sni:'tls.test'}))}`,
    `ss://${btoa('aes-128-gcm:password')}@host.test:8388#ss`,
    `tuic://${uuid}:password@host.test:443?sni=tls.test&congestion_control=bbr&udp_relay_mode=quic#tuic`,
    `proxies:\n- { name: node, type: vless, server: host.test, port: 443, uuid: ${uuid}, tls: true, servername: tls.test, network: ws, ws-opts: { path: /relay, headers: { Host: cdn.test } } }`,
    JSON.stringify({outbounds: [{tag:'hy2',type:'hysteria2',server:'host.test',server_ports:['2000:4000'],
      password:'password',tls:{enabled:true,server_name:'tls.test'},up_mbps:10,down_mbps:20,
      obfs:{type:'salamander',password:'obfs-test'}}]}),
  ];
  for (const example of examples) it('accepts a generated configuration', () => {
    expect(existsSync(core!)).toBe(true);
    const folder = mkdtempSync(join(tmpdir(), 'relaydesk-test-'));
    try {
      const configPath = join(folder, 'config.json');
      writeFileSync(configPath, JSON.stringify(buildConfig(parseSubscription(example).nodes[0], 32123, [
        { type: 'domain', value: 'example.com', action: 'direct' },
        { type: 'domain_suffix', value: 'blocked.test', action: 'reject' },
        { type: 'ip_cidr', value: '2001:db8::/32', action: 'direct' },
        { type: 'process_name', value: 'Network Fixture.EXE', action: 'reject' },
      ])));
      const result = spawnSync(core!, ['check', '-c', configPath], { encoding: 'utf8' });
      expect(result.status, result.stderr).toBe(0);
    } finally { rmSync(folder, { recursive: true, force: true }); }
  });
});

describe.skipIf(!mihomo)('real mihomo custom rule injection validation', () => {
  it('accepts RelayDesk custom domain, CIDR and process rules prepended to Mihomo config', () => {
    const folder = mkdtempSync(join(tmpdir(), 'relaydesk-mihomo-rules-'));
    try {
      const cfg = withMihomoCustomRules({
        'mixed-port': 32124,
        mode: 'rule',
        proxies: [{ name: 'HK', type: 'socks5', server: '127.0.0.1', port: 18080 }],
        'proxy-groups': [{ name: 'Proxy', type: 'select', proxies: ['HK', 'DIRECT'] }],
        rules: ['MATCH,Proxy'],
      }, [
        { type: 'domain', value: 'example.com', action: 'direct' },
        { type: 'domain_suffix', value: 'blocked.test', action: 'reject' },
        { type: 'ip_cidr', value: '2001:db8::/32', action: 'direct' },
        { type: 'process_name', value: 'Network Fixture.EXE', action: 'proxy' },
      ]);
      const configPath = join(folder, 'config.yaml');
      writeFileSync(configPath, JSON.stringify(cfg));
      const result = spawnSync(mihomo!, ['-t', '-d', folder, '-f', configPath], { encoding: 'utf8' });
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    } finally { rmSync(folder, { recursive: true, force: true }); }
  });
});
