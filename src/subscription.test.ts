import { describe, expect, it } from 'vitest';
import { parseSubscription } from './subscription';
describe('subscription import', () => {
  it('parses URI lists and rejects invalid entries without exposing secrets', () => {
    const result = parseSubscription('vless://id@example.com:443?security=reality&type=ws#Node\ninvalid secret');
    expect(result.nodes[0]).toMatchObject({ name: 'Node', protocol: 'vless', port: 443, security: 'reality', transport: 'ws' });
    expect(result.warnings.join()).not.toContain('secret');
  });
  it('decodes base64 subscriptions', () => expect(parseSubscription(btoa('trojan://password@example.org:443#Test')).nodes[0].protocol).toBe('trojan'));
  it('imports YAML and JSON node lists', () => {
    expect(parseSubscription('proxies:\n  - name: Test\n    type: vless\n    server: example.org\n    port: 443').nodes).toHaveLength(1);
    expect(parseSubscription('{"outbounds":[{"tag":"Test","type":"hysteria2","server":"example.org","server_port":443}]}').nodes).toHaveLength(1);
  });
  it('rejects invalid inputs', () => expect(() => parseSubscription('')).toThrow());
});
