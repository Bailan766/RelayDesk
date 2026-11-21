import { describe, it, expect } from 'vitest';
import {
  buildConfig, buildSessionConfig, evaluateRuleMatch, normalizeRuleValue,
  remoteRuleSetPresets, rulePresets, validateRuleSet, withMihomoCustomRules,
} from './config';
import { aggregateConnectionsByProcess } from './telemetry';
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
  it('pins matching destinations to a loaded outbound and rejects rather than falling back when unavailable', () => {
    const nodes = parseSubscription('trojan://password@a.test:443#A\ntrojan://password@b.test:443#B').nodes;
    const rules = [
      { type: 'ip_cidr', value: '192.0.2.3', action: 'proxy', target: nodes[1].id },
      { type: 'process_name', value: 'Example (Test).EXE', action: 'direct' },
    ] as const;
    expect(buildSessionConfig(nodes[0], nodes, 12345, [...rules]).config.route.rules).toEqual([
      { ip_cidr: ['192.0.2.3/32'], outbound: 'node-1' },
      { process_path_regex: ['(?i)(?:^|[\\\\/])Example \\(Test\\)\\.EXE$'], outbound: 'direct' },
    ]);
    expect(buildConfig(nodes[0], 12345, [...rules]).route.rules[0]).toEqual({ ip_cidr: ['192.0.2.3/32'], action: 'reject' });
    expect(normalizeRuleValue('ip_cidr', '2001:db8:0::/48')).toBe('2001:db8::/48');
    expect(() => normalizeRuleValue('ip_cidr', '255.1.1.256/24')).toThrow('IP');
    expect(() => normalizeRuleValue('ip_cidr', '2001:db8::/129')).toThrow('IP');
  });

  it('ignores harmless Clash node metadata while keeping security checks and supports default direct final', () => {
    const source = 'proxies:\n- {name: tuned, type: vless, server: example.org, port: 443, uuid: id, tls: true, servername: tls.test, tfo: true, mptcp: true, ip-version: dual, disable-sni: true}';
    const node = parseSubscription(source).nodes[0];
    const built = buildConfig(node, 12345, rulePresets[0].rules, 'direct') as any;
    expect(built.outbounds[0].tls).toMatchObject({ enabled: true, server_name: 'tls.test', disable_sni: true });
    expect(built.route.final).toBe('direct');
    expect(built.route.rules.length).toBe(rulePresets[0].rules.length);
  });

  it('compiles custom RelayDesk rules cleanly ahead of Mihomo original rules', () => {
    const base = {
      proxies: [{ name: 'HK-01', type: 'trojan', server: 'hk.test', port: 443, password: 'x' }],
      'proxy-groups': [{ name: 'Proxy', type: 'select', proxies: ['HK-01', 'DIRECT'] }],
      rules: ['MATCH,Proxy'],
    };
    const merged = withMihomoCustomRules(base, [
      { type: 'domain', value: 'internal.corp', action: 'direct' },
      { type: 'domain_suffix', value: 'ads.test', action: 'reject' },
      { type: 'ip_cidr', value: '192.168.0.0/16', action: 'direct' },
      { type: 'process_name', value: 'antigravity.exe', action: 'proxy', target: 'node-hk' },
    ], new Map([['node-hk', 'HK-01']]));
    expect(merged.rules).toEqual([
      'DOMAIN,internal.corp,DIRECT',
      'DOMAIN-SUFFIX,ads.test,REJECT',
      'IP-CIDR,192.168.0.0/16,DIRECT,no-resolve',
      'PROCESS-NAME,antigravity.exe,HK-01',
      'MATCH,Proxy',
    ]);
  });

  it('compiles enabled remote rule_set entries after manual rules and omits route.rule_set when empty', () => {
    const node = parseSubscription('vless://id@host.test:443#Test').nodes[0];
    const withoutSets = buildConfig(node, 12345, []) as any;
    expect(withoutSets.route.rule_set).toBeUndefined();

    const sets = remoteRuleSetPresets.map(item =>
      item.tag === 'geosite-cn' || item.tag === 'geosite-category-ads-all'
        ? { ...item, enabled: true }
        : item,
    );
    const built = buildConfig(
      node,
      12345,
      [{ type: 'domain', value: 'manual.example.com', action: 'direct' }],
      'proxy',
      sets,
    ) as any;
    expect(built.route.rule_set).toEqual([
      {
        tag: 'geosite-cn',
        type: 'remote',
        format: 'binary',
        url: 'https://raw.githubusercontent.com/SagerNet/sing-geosite/rule-set/geosite-cn.srs',
        download_detour: 'proxy',
        update_interval: '24h',
      },
      {
        tag: 'geosite-category-ads-all',
        type: 'remote',
        format: 'binary',
        url: 'https://raw.githubusercontent.com/SagerNet/sing-geosite/rule-set/geosite-category-ads-all.srs',
        download_detour: 'proxy',
        update_interval: '24h',
      },
    ]);
    expect(built.route.rules).toEqual([
      { domain: ['manual.example.com'], outbound: 'direct' },
      { rule_set: ['geosite-cn'], outbound: 'direct' },
      { rule_set: ['geosite-category-ads-all'], action: 'reject' },
    ]);

    expect(() => validateRuleSet({
      tag: 'bad-http',
      label: 'HTTP',
      url: 'http://example.com/rules.srs',
      format: 'binary',
      action: 'direct',
      enabled: true,
    })).toThrow('HTTPS');
  });
});


describe('rule matching evaluator and process aggregation', () => {
  it('evaluates ordered domain, IPv4/IPv6 CIDR, URL, and Windows process matches cleanly', () => {
    const rules = [
      { type: 'domain' as const, value: 'direct.openai.com', action: 'direct' as const },
      ...rulePresets.find(p => p.id === 'ai-services-proxy')!.rules,
      ...rulePresets.find(p => p.id === 'lan-direct')!.rules,
      { type: 'process_name' as const, value: 'Antigravity.exe', action: 'proxy' as const, target: 'node-hk' },
    ];
    expect(evaluateRuleMatch('https://direct.openai.com/v1', rules, 'proxy')).toMatchObject({
      inputKind: 'domain',
      normalized: 'direct.openai.com',
      matchedIndex: 0,
      action: 'direct',
    });
    expect(evaluateRuleMatch('generativelanguage.googleapis.com', rules, 'direct')).toMatchObject({
      inputKind: 'domain',
      action: 'proxy',
    });
    expect(evaluateRuleMatch('192.168.50.12', rules, 'proxy')).toMatchObject({
      inputKind: 'ip',
      normalized: '192.168.50.12',
      action: 'direct',
    });
    expect(evaluateRuleMatch('fe80::1', rules, 'proxy')).toMatchObject({
      inputKind: 'ip',
      action: 'direct',
    });
    expect(evaluateRuleMatch('C:\\Program Files\\Antigravity\\antigravity.exe', rules, 'direct')).toMatchObject({
      inputKind: 'process_name',
      normalized: 'antigravity.exe',
      action: 'proxy',
      target: 'node-hk',
    });
    expect(evaluateRuleMatch('unmatched.example.org', rules, 'direct')).toMatchObject({
      matchedIndex: null,
      action: 'direct',
    });
  });

  it('includes valid AI, Dev, and Telegram rule presets', () => {
    for (const id of ['ai-services-proxy', 'dev-github-proxy', 'telegram-proxy']) {
      const preset = rulePresets.find(p => p.id === id);
      expect(preset).toBeDefined();
      expect(preset!.rules.length).toBeGreaterThan(3);
    }
  });

  it('aggregates active connections by process with accurate totals and sorting', () => {
    const aggregated = aggregateConnectionsByProcess([
      {
        id: '1',
        metadata: { host: 'api.github.com', sourceIP: '127.0.0.1', sourcePort: '1', destinationIP: null, destinationPort: '443', processPath: 'C:\\Tools\\antigravity.exe', network: 'tcp', type: 'HTTP' },
        upload: 100,
        download: 500,
        chains: ['HK-01'],
        rule: 'final',
      },
      {
        id: '2',
        metadata: { host: 'generativelanguage.googleapis.com', sourceIP: '127.0.0.1', sourcePort: '2', destinationIP: null, destinationPort: '443', processPath: 'C:\\Tools\\Antigravity.exe', network: 'tcp', type: 'HTTP' },
        upload: 50,
        download: 900,
        chains: ['HK-01'],
        rule: 'final',
      },
      {
        id: '3',
        metadata: { host: 'baidu.com', sourceIP: '127.0.0.1', sourcePort: '3', destinationIP: null, destinationPort: '443', process: 'chrome.exe', network: 'tcp', type: 'HTTP' },
        upload: 300,
        download: 200,
        chains: ['DIRECT'],
        rule: 'DomainSuffix',
      },
    ], 'download');
    expect(aggregated).toHaveLength(2);
    expect(aggregated[0]).toMatchObject({
      process: 'antigravity.exe',
      count: 2,
      upload: 150,
      download: 1400,
      canProcessRule: true,
    });
    expect(aggregated[0].ids).toEqual(['1', '2']);
    expect(aggregated[1]).toMatchObject({ process: 'chrome.exe', count: 1, upload: 300, download: 200 });
  });
});
