import { describe, expect, it } from 'vitest';
import { applyMihomoOverride, defaultMihomoOverride, parseOverrideYaml, sanitizeMihomoOverride } from './mihomoOverride';

describe('Mihomo persistent override', () => {
  const baseProfile = {
    proxies: [{ name: 'HK', type: 'trojan', server: 'hk.test', port: 443, password: 'x' }],
    'proxy-groups': [{ name: 'Proxy', type: 'select', proxies: ['HK', 'DIRECT'] }],
    dns: {
      enable: true,
      'enhanced-mode': 'fake-ip',
      nameserver: ['https://dns.sub.test/dns-query'],
      'fake-ip-filter': ['*.lan', 'localhost.ptlogin2.qq.com'],
    },
    rules: ['GEOIP,CN,DIRECT', 'MATCH,Proxy'],
  };

  it('returns the original profile unchanged when override is disabled', () => {
    const off = { ...defaultMihomoOverride(), nameservers: ['https://1.1.1.1/dns-query'] };
    expect(applyMihomoOverride(baseProfile, off)).toBe(baseProfile);
  });

  it('persists custom DNS, fake-ip-filter deduplication, extra rules ahead of profile rules, and YAML merge fields', () => {
    const override = sanitizeMihomoOverride({
      enabled: true,
      dnsEnabled: 'enable',
      enhancedMode: 'fake-ip',
      nameservers: ['https://223.5.5.5/dns-query', 'https://1.12.12.12/dns-query'],
      fallback: ['tls://8.8.8.8:853'],
      fakeIpFilter: ['*.lan', '+.msftconnecttest.com'],
      extraRules: ['DOMAIN-SUFFIX,corp.internal,DIRECT', 'GEOIP,CN,DIRECT'],
      extraYaml: [
        'sniffer:',
        '  enable: true',
        '  sniff:',
        '    TLS:',
        '      ports: [443]',
        'rules:',
        '  - DOMAIN,yaml.test,DIRECT',
        'mixed-port: 9999',
      ].join('\n'),
    });

    const merged = applyMihomoOverride(baseProfile, override) as any;
    expect(merged.dns).toEqual({
      enable: true,
      'enhanced-mode': 'fake-ip',
      nameserver: ['https://223.5.5.5/dns-query', 'https://1.12.12.12/dns-query'],
      fallback: ['tls://8.8.8.8:853'],
      'fake-ip-filter': ['*.lan', 'localhost.ptlogin2.qq.com', '+.msftconnecttest.com'],
    });
    expect(merged.rules).toEqual([
      'DOMAIN-SUFFIX,corp.internal,DIRECT',
      'DOMAIN,yaml.test,DIRECT',
      'GEOIP,CN,DIRECT',
      'MATCH,Proxy',
    ]);
    expect(merged.sniffer).toMatchObject({ enable: true });
    // Port/listener keys outside the allowlist are ignored by parseOverrideYaml.
    expect(merged['mixed-port']).toBeUndefined();
  });

  it('rejects non-object or malformed YAML clearly', () => {
    expect(() => parseOverrideYaml('- a\n- b')).toThrow('映射对象');
    expect(() => parseOverrideYaml('dns: [unclosed')).toThrow('解析失败');
  });
});
