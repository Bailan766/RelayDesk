import { describe, expect, it } from "vitest";
import {
  deserializeWorkspace, emptyWorkspace, preferredNode, receiveSubscription, replaceSubscription,
  serializeWorkspace, subscriptionRefreshDue,
} from "./workspace";

const vless = (server: string, label: string, user = "00000000-0000-4000-8000-000000000000") =>
  `vless://${user}@${server}:443?security=tls#${label}`;
const primary = vless("primary.example.com", "primary");
const backup = vless("backup.example.com", "backup");
const source = "https://subscriptions.example.com/token";

describe("encrypted workspace data", () => {
  it("migrates the legacy selected index and keeps the source and rules across restarts", () => {
    const legacy = deserializeWorkspace(JSON.stringify({ content: [primary, backup].join("\n"), selected: 1, source }));
    const settings = { ...legacy, entryMode: "tun" as const, routingMode: "global" as const, refreshHours: 6, proxyPort: 17890, autoReconnect: false, autoFailover: true,
      favorites: [legacy.subscriptions[0].parsed.nodes[1].id],
      rules: [{ type: "domain" as const, value: "example.com", action: "reject" as const }] };
    const saved = serializeWorkspace(settings);
    const restored = deserializeWorkspace(saved);
    expect(saved).not.toContain('"parsed"');
    expect(restored).toEqual(settings);
    expect(restored.subscriptions[0].parsed.nodes[1].id).toBe(restored.selected);
  });

  it("adds independent sources and preserves the selected node across reorder and credential rotation", () => {
    const profile = receiveSubscription([primary, backup].join("\n"), source, null);
    const second = receiveSubscription(primary, "https://other.example.com/private", null);
    const existing = replaceSubscription(replaceSubscription(emptyWorkspace, profile), second);
    const updated = receiveSubscription([backup, vless("primary.example.com", "primary", "99999999-9999-4999-8999-999999999999")].join("\n"), source, { total: 25 }, profile);
    const merged = replaceSubscription(existing, updated);
    expect(merged.subscriptions[1]).toBe(second);
    expect(merged.selected).toBe(existing.selected);
    expect(updated.parsed.nodes[1].id).toBe(merged.selected);
    expect(second.parsed.nodes[0].id).not.toBe(merged.selected);
    expect(merged.subscriptions[0].usage).toEqual({ total: 25 });
  });

  it("keeps a subscription's request settings through refresh and workspace reload", () => {
    const request = { route: "relaydesk" as const, userAgent: "SubscriptionClient/1.0" };
    const profile = receiveSubscription(primary, source, null, undefined, request);
    const updated = receiveSubscription(backup, source, { total: 1024 }, profile);
    const workspace = replaceSubscription(emptyWorkspace, updated);
    expect(deserializeWorkspace(serializeWorkspace(workspace)).subscriptions[0].request).toEqual(request);
    expect(deserializeWorkspace(JSON.stringify({ content: primary, source })).subscriptions[0].request)
      .toEqual({ route: "automatic", userAgent: "" });
  });

  it("applies per-source refresh intervals, preserving explicit off and inherited defaults on reload", () => {
    const hour = 3_600_000;
    const inherited = { ...receiveSubscription(primary, source, null), updatedAt: hour };
    const hourly = { ...receiveSubscription(backup, "https://hourly.example.com/profile", null),
      updatedAt: hour, refreshHours: 1 as const };
    const disabled = { ...receiveSubscription(primary, "https://manual.example.com/profile", null),
      updatedAt: hour, refreshHours: 0 as const };
    const local = { ...receiveSubscription(primary, "", null), updatedAt: hour };
    const settings = { ...emptyWorkspace, refreshHours: 6, subscriptions: [inherited, hourly, disabled, local] };
    const restored = deserializeWorkspace(serializeWorkspace(settings));
    expect(restored.subscriptions.map(profile => profile.refreshHours)).toEqual([undefined, 1, 0, undefined]);

    const due = (now: number, defaultHours: number) => restored.subscriptions
      .filter(profile => subscriptionRefreshDue(profile, defaultHours, now))
      .map(profile => profile.id);
    expect(due(2 * hour, restored.refreshHours)).toEqual([hourly.id]);
    expect(due(7 * hour, restored.refreshHours)).toEqual([inherited.id, hourly.id]);
    expect(due(7 * hour, 0)).toEqual([hourly.id]);
    expect(subscriptionRefreshDue(hourly, 6, 2 * hour, 2 * hour - 60_000)).toBe(false);

    const updated = receiveSubscription(primary, hourly.source, null, hourly);
    expect(updated.refreshHours).toBe(1);
    const legacy = deserializeWorkspace(JSON.stringify({ content: primary, source }));
    expect(subscriptionRefreshDue(legacy.subscriptions[0], 6, 7 * hour)).toBe(true);
  });

  it("retains a provider-only original and its strategy after reload and refresh", () => {
    const raw = "proxy-providers:\n  Inlined:\n    type: inline\n    payload: []\nproxy-groups:\n- {name: Choice, type: select, use: [Inlined]}";
    const initial = { ...receiveSubscription(raw, source, null),
      mihomoMode: "global" as const, mihomoSelections: { Choice: "DIRECT" } };
    const workspace = { ...replaceSubscription(emptyWorkspace, initial), mihomoProfile: initial.id };
    const updated = receiveSubscription(raw + "\nrules: ['MATCH,Choice']", source, null, initial);
    const loaded = deserializeWorkspace(serializeWorkspace(replaceSubscription(workspace, updated)));
    expect(loaded.mihomoProfile).toBe(initial.id);
    expect(loaded.subscriptions[0].parsed.nodes).toHaveLength(0);
    expect(loaded.subscriptions[0].mihomoSelections).toEqual(initial.mihomoSelections);
    expect(loaded.subscriptions[0].mihomoMode).toBe("global");
    expect(() => replaceSubscription(workspace, receiveSubscription(primary, source, null, initial)))
      .toThrow("已保留原订阅");
  });

  it("preserves an existing usable source when the replacement contains no usable nodes", () => {
    const original = receiveSubscription(primary, source, null);
    const workspace = replaceSubscription(emptyWorkspace, original);
    const candidate = receiveSubscription("vless://sample@example.com:443?encryption=unsupported#unsupported", source, null, original);
    expect(() => replaceSubscription(workspace, candidate)).toThrow("已保留原订阅");
    expect(workspace.subscriptions[0]).toBe(original);
  });

  it("rejects unknown workspace versions so they cannot be overwritten by an empty default", () => {
    expect(() => deserializeWorkspace('{"version":13,"subscriptions":[],"rules":[]}')).toThrow();
  });

  it("preserves same-name transport variants and remaps the selected node and bookmark when a variant appears", () => {
    const profile = receiveSubscription(primary, source, null);
    const original = replaceSubscription(emptyWorkspace, profile);
    const variant = primary.replace("security=tls", "security=tls&type=ws&path=%2Fvariant");
    const updated = receiveSubscription([variant, primary, primary].join("\n"), source, null, profile);
    const saved = { ...original, favorites: [original.selected!] };
    const result = replaceSubscription(saved, updated);
    expect(result.subscriptions[0].parsed.nodes).toHaveLength(2);
    expect(updated.parsed.nodes[0].id).not.toBe(updated.parsed.nodes[1].id);
    expect(result.selected).toBe(updated.parsed.nodes[1].id);
    expect(result.favorites).toEqual([updated.parsed.nodes[1].id]);
  });

  it("persists extended desktop settings, allowHttp request option, and remaps nodeLatencies", () => {
    const profile = receiveSubscription([primary, backup].join("\n"), source, null, undefined, {
      route: "automatic",
      userAgent: "RelayDesk/1.0",
      allowHttp: true,
    });
    const base = replaceSubscription(emptyWorkspace, profile);
    const firstId = base.subscriptions[0].parsed.nodes[0].id;
    const configured = {
      ...base,
      theme: "dark" as const,
      autoConnect: true,
      closeAction: "exit" as const,
      allowLan: true,
      systemProxyBypass: "localhost;<local>",
      systemProxyGuard: false,
      probeUrl: "https://cp.cloudflare.com/generate_204",
      tunIpv6: false,
      tunStack: "gvisor" as const,
      tunStrictRoute: false,
      ruleDefaultAction: "direct" as const,
      nodeLatencies: {
        [firstId]: { revision: primary, label: "42 ms", milliseconds: 42, testedAt: 1700000000000 },
      },
    };
    const restored = deserializeWorkspace(serializeWorkspace(configured));
    expect(restored).toEqual(configured);
    expect(restored.subscriptions[0].request.allowHttp).toBe(true);

    const reordered = receiveSubscription([backup, primary].join("\n"), source, null, profile);
    const updated = replaceSubscription(restored, reordered);
    expect(updated.nodeLatencies[reordered.parsed.nodes[1].id]).toEqual(configured.nodeLatencies[firstId]);
  });

  it("persists remote ruleSets, mihomoOverride, and hotkeys across serialization and subscription refresh", () => {
    const clashYaml = [
      "proxies:",
      "  - { name: HK, type: trojan, server: hk.example.com, port: 443, password: secret }",
      "proxy-groups:",
      "  - { name: Proxy, type: select, proxies: [HK] }",
      "rules:",
      "  - MATCH,Proxy",
    ].join("\n");
    const sub = receiveSubscription(clashYaml, source, null);
    const configured = {
      ...replaceSubscription(emptyWorkspace, sub),
      ruleSets: [{
        tag: "geosite-cn",
        label: "CN",
        url: "https://raw.githubusercontent.com/SagerNet/sing-geosite/rule-set/geosite-cn.srs",
        format: "binary" as const,
        action: "direct" as const,
        enabled: true,
      }],
      mihomoOverride: {
        enabled: true,
        dnsEnabled: "enable" as const,
        enhancedMode: "fake-ip" as const,
        nameservers: ["https://223.5.5.5/dns-query"],
        fallback: [],
        fakeIpFilter: ["*.internal"],
        extraRules: ["DOMAIN,custom.test,DIRECT"],
        extraYaml: "",
      },
      hotkeys: {
        toggleProxy: "Ctrl+Alt+P",
        cycleRouting: "Ctrl+Alt+M",
        showWindow: "Ctrl+Alt+R",
      },
    };
    const restored = deserializeWorkspace(serializeWorkspace(configured));
    expect(restored.ruleSets).toMatchObject([{ tag: "geosite-cn", enabled: true }]);
    expect(restored.mihomoOverride).toEqual(configured.mihomoOverride);
    expect(restored.hotkeys).toEqual(configured.hotkeys);

    const refreshed = receiveSubscription(clashYaml + "\n# refreshed", source, null, sub);
    const afterRefresh = replaceSubscription(restored, refreshed);
    expect(afterRefresh.mihomoOverride).toEqual(configured.mihomoOverride);
  });

  it("preserves the legacy selected index when an earlier subscription line is a transport variant", () => {
    const legacy = deserializeWorkspace(JSON.stringify({ source, selected: 1,
      content: [primary, primary.replace("security=tls", "security=tls&type=ws"), backup].join("\n") }));
    expect(legacy.subscriptions[0].parsed.nodes.find(node => node.id === legacy.selected)?.name).toBe("backup");
  });

  it("skips subscription info banner rows when picking an automatic fallback node", () => {
    const infoNode = vless("127.0.0.1", "剩余流量：100GB");
    const expiryNode = vless("127.0.0.1", "过期时间：2026-12-31");
    const sub = receiveSubscription([infoNode, expiryNode, backup].join("\n"), source, null);
    const chosen = preferredNode([sub]);
    expect(sub.parsed.nodes.find(node => node.id === chosen)?.name).toBe("backup");
  });

  it("provides LAN/CN split rules and auto-failover by default and auto-activates first Mihomo profile", () => {
    expect(emptyWorkspace.rules.length).toBeGreaterThan(10);
    expect(emptyWorkspace.autoFailover).toBe(true);
    const clashYaml = [
      "proxies:",
      "  - { name: HK, type: trojan, server: hk.example.com, port: 443, password: secret }",
      "proxy-groups:",
      "  - { name: Proxy, type: select, proxies: [HK] }",
      "rules:",
      "  - MATCH,Proxy",
    ].join("\n");
    const sub = receiveSubscription(clashYaml, source, null);
    const next = replaceSubscription(emptyWorkspace, sub);
    expect(next.mihomoProfile).toBe(sub.id);
    expect(next.selected).toBe(sub.parsed.nodes[0].id);
    expect(emptyWorkspace.systemProxyGuard).toBe(true);
    expect(emptyWorkspace.tunStack).toBe("mixed");
    expect(emptyWorkspace.tunStrictRoute).toBe(true);
    const invalidFallback = deserializeWorkspace(JSON.stringify({
      ...JSON.parse(serializeWorkspace(emptyWorkspace)),
      tunStack: "weird",
      systemProxyGuard: "nope",
      tunStrictRoute: "nope",
    }));
    expect(invalidFallback.tunStack).toBe("mixed");
    expect(invalidFallback.systemProxyGuard).toBe(true);
    expect(invalidFallback.tunStrictRoute).toBe(true);
  });
});
