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
    const settings = { ...legacy, entryMode: "tun" as const, refreshHours: 6,
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

  it("preserves an existing usable source when the replacement contains no usable nodes", () => {
    const original = receiveSubscription(primary, source, null);
    const workspace = replaceSubscription(emptyWorkspace, original);
    const candidate = receiveSubscription("trojan://sample@example.com:443#unsupported", source, null, original);
    expect(() => replaceSubscription(workspace, candidate)).toThrow("已保留原订阅");
    expect(workspace.subscriptions[0]).toBe(original);
  });

  it("rejects unknown workspace versions so they cannot be overwritten by an empty default", () => {
    expect(() => deserializeWorkspace('{"version":13,"subscriptions":[],"rules":[]}')).toThrow();
  });
});
