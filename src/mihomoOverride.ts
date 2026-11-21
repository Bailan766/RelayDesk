import { parse } from 'yaml';

export type MihomoOverride = {
  enabled: boolean;
  dnsEnabled: 'inherit' | 'enable' | 'disable';
  enhancedMode: '' | 'fake-ip' | 'redir-host';
  nameservers: string[];
  fallback: string[];
  fakeIpFilter: string[];
  extraRules: string[];
  extraYaml: string;
};

export function defaultMihomoOverride(): MihomoOverride {
  return {
    enabled: false,
    dnsEnabled: 'inherit',
    enhancedMode: '',
    nameservers: [],
    fallback: [],
    fakeIpFilter: [],
    extraRules: [],
    extraYaml: '',
  };
}

const ALLOWED_OVERRIDE_FIELDS = new Set([
  'dns',
  'hosts',
  'sniffer',
  'ipv6',
  'tcp-concurrent',
  'unified-delay',
  'find-process-mode',
  'keep-alive-idle',
  'keep-alive-interval',
  'global-client-fingerprint',
  'geodata-mode',
  'rule-providers',
  'proxy-providers',
  'rules',
]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function deepMerge(target: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = { ...target };
  for (const [key, value] of Object.entries(patch)) {
    const existing = result[key];
    if (isPlainObject(existing) && isPlainObject(value)) {
      result[key] = deepMerge(existing, value);
    } else if (Array.isArray(value)) {
      result[key] = [...value];
    } else {
      result[key] = value;
    }
  }
  return result;
}

export function parseOverrideYaml(text: string): Record<string, unknown> {
  const trimmed = text.trim();
  if (!trimmed) return {};
  let parsed: unknown;
  try {
    parsed = parse(trimmed);
  } catch (err) {
    const detail = err instanceof Error ? err.message : '语法错误';
    throw new Error(`Mihomo 覆写 YAML 解析失败：${detail}`);
  }
  if (parsed === null || parsed === undefined) return {};
  if (!isPlainObject(parsed)) {
    throw new Error('Mihomo 覆写 YAML 顶层必须是键值对映射对象');
  }
  const filtered: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (ALLOWED_OVERRIDE_FIELDS.has(key)) {
      filtered[key] = value;
    }
  }
  return filtered;
}

function cleanStringList(input: unknown, maxItems = 256): string[] {
  if (!Array.isArray(input)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of input) {
    if (typeof item !== 'string') continue;
    const trimmed = item.trim();
    if (!trimmed || trimmed.length > 512 || trimmed.startsWith('#')) continue;
    if (!seen.has(trimmed)) {
      seen.add(trimmed);
      out.push(trimmed);
      if (out.length >= maxItems) break;
    }
  }
  return out;
}

export function sanitizeMihomoOverride(raw: unknown): MihomoOverride {
  if (!isPlainObject(raw)) return defaultMihomoOverride();
  return {
    enabled: raw.enabled === true,
    dnsEnabled: raw.dnsEnabled === 'enable' || raw.dnsEnabled === 'disable' ? raw.dnsEnabled : 'inherit',
    enhancedMode: raw.enhancedMode === 'fake-ip' || raw.enhancedMode === 'redir-host' ? raw.enhancedMode : '',
    nameservers: cleanStringList(raw.nameservers, 64),
    fallback: cleanStringList(raw.fallback, 64),
    fakeIpFilter: cleanStringList(raw.fakeIpFilter, 256),
    extraRules: cleanStringList(raw.extraRules, 512),
    extraYaml: typeof raw.extraYaml === 'string' && raw.extraYaml.length <= 64 * 1024 ? raw.extraYaml : '',
  };
}

export function applyMihomoOverride(
  profile: Record<string, unknown>,
  override?: MihomoOverride,
): Record<string, unknown> {
  if (!override?.enabled) return profile;

  let next: Record<string, unknown> = { ...profile };

  // Apply extra YAML fields first so structured DNS controls and extraRules layer deterministically on top.
  if (override.extraYaml.trim()) {
    try {
      const yamlPatch = parseOverrideYaml(override.extraYaml);
      const { rules: yamlRules, ...restPatch } = yamlPatch;
      next = deepMerge(next, restPatch);
      if (Array.isArray(yamlRules)) {
        const existingRules = Array.isArray(next.rules) ? next.rules.map(String) : [];
        const injected = yamlRules.map(String).filter(line => line.trim() && !existingRules.includes(line));
        if (injected.length) {
          next.rules = [...injected, ...existingRules];
        }
      }
    } catch {
      // Ignore malformed YAML at runtime; Settings/Override modal surfaces validation interactively.
    }
  }

  const hasDnsTweaks =
    override.dnsEnabled !== 'inherit' ||
    override.enhancedMode !== '' ||
    override.nameservers.length > 0 ||
    override.fallback.length > 0 ||
    override.fakeIpFilter.length > 0;

  if (hasDnsTweaks) {
    const dns: Record<string, unknown> = isPlainObject(next.dns) ? { ...next.dns } : {};
    if (override.dnsEnabled === 'enable') dns.enable = true;
    else if (override.dnsEnabled === 'disable') dns.enable = false;

    if (override.enhancedMode) {
      dns['enhanced-mode'] = override.enhancedMode;
    }
    if (override.nameservers.length > 0) {
      dns.nameserver = [...override.nameservers];
    }
    if (override.fallback.length > 0) {
      dns.fallback = [...override.fallback];
    }
    if (override.fakeIpFilter.length > 0) {
      const current = Array.isArray(dns['fake-ip-filter']) ? dns['fake-ip-filter'].map(String) : [];
      const merged = [...current];
      for (const pattern of override.fakeIpFilter) {
        if (!merged.includes(pattern)) merged.push(pattern);
      }
      dns['fake-ip-filter'] = merged;
    }
    next.dns = dns;
  }

  const extraRules = cleanStringList(override.extraRules, 512);
  if (extraRules.length > 0) {
    const existing = Array.isArray(next.rules) ? next.rules.map(String) : [];
    const prepended = extraRules.filter(rule => !existing.includes(rule));
    if (prepended.length > 0) {
      next.rules = [...prepended, ...existing];
    }
  }

  return next;
}
