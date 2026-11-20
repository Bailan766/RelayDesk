import { nodeRevision, type NodeProfile } from './subscription';
import { compileOutbound } from './outbound';

export type RouteRule = { type: 'domain' | 'domain_suffix'; value: string; action: 'direct' | 'proxy' | 'reject' };

export function normalizeRuleDomain(input: string): string {
  const domain = input.trim().toLowerCase().replace(/\.$/, '');
  if (!domain || domain.length > 253 || !domain.split('.').every(label =>
    /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) throw new Error('域名规则无效');
  return domain;
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
  loaded: Map<string, { tag: string; revision: string }>;
};

export function buildSessionConfig(selected: NodeProfile, candidates: NodeProfile[], port: number, rules: RouteRule[]): SessionPlan {
  const outbounds = [compileOutbound(selected, 'node-0')];
  const loaded = new Map([[selected.id, { tag: 'node-0', revision: nodeRevision(selected) }]]);
  for (const candidate of candidates) {
    if (loaded.has(candidate.id) || outbounds.length >= 2048) continue;
    const tag = `node-${outbounds.length}`;
    try {
      outbounds.push(compileOutbound(candidate, tag));
      loaded.set(candidate.id, { tag, revision: nodeRevision(candidate) });
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
