import { describe, expect, it } from "vitest";
import { deserializeWorkspace, emptyWorkspace, receiveSubscription, replaceSubscription, serializeWorkspace } from "./workspace";

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

  it("preserves the legacy selected index when an earlier subscription line is a transport variant", () => {
    const legacy = deserializeWorkspace(JSON.stringify({ source, selected: 1,
      content: [primary, primary.replace("security=tls", "security=tls&type=ws"), backup].join("\n") }));
    expect(legacy.subscriptions[0].parsed.nodes.find(node => node.id === legacy.selected)?.name).toBe("backup");
  });
});
