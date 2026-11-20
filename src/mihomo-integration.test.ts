import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createSocket } from "node:dgram";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, request } from "node:http";
import { createServer as reserve } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { parseSubscription } from "./subscription";

const core = process.env.MIHOMO;
const installed = process.env.RELAYDESK_INSTALLED_SMOKE_APP;
const hostname = "media.relaydesk.test";
const selector = "线路 选择";

async function freePort() {
  const socket = reserve().listen(0, "127.0.0.1");
  await once(socket, "listening");
  const port = (socket.address() as { port: number }).port;
  await new Promise<void>(done => socket.close(() => done()));
  return port;
}

async function verifyProfile(executable: string, pack = false) {
  let targetCalls = 0;
  let dnsQueries = 0;
  let providerRequests = 0;
  const origin = createServer((req, res) => {
    if (req.url === "/rules") {
      providerRequests++;
      return res.end(`payload:\n  - DOMAIN,${hostname}\n`);
    }
    if (req.url === "/proxies") {
      providerRequests++;
      return res.end("proxies:\n  - {name: FromProvider, type: ss, server: 127.0.0.1, port: 9, cipher: aes-128-gcm, password: fixture}\n");
    }
    targetCalls++;
    res.end("relaydesk-mihomo-fixture");
  }).listen(0, "127.0.0.1");
  const dns = createSocket("udp4").bind(0, "127.0.0.1");
  dns.on("message", (query, caller) => {
    if (query.length < 17) return;
    let cursor = 12;
    const labels: string[] = [];
    while (query[cursor] > 0 && query[cursor] < 64) {
      const length = query[cursor++];
      labels.push(query.subarray(cursor, cursor + length).toString("ascii"));
      cursor += length;
    }
    if (query[cursor] !== 0 || cursor + 4 >= query.length) return;
    const answer = labels.join(".") === hostname && query.readUInt16BE(cursor + 1) === 1;
    const header = Buffer.from(query.subarray(0, 12));
    header.writeUInt16BE(0x8180, 2);
    header.writeUInt16BE(answer ? 1 : 0, 6);
    header.writeUInt16BE(0, 8);
    header.writeUInt16BE(0, 10);
    const body = [header, query.subarray(12, cursor + 5)];
    if (answer) {
      dnsQueries++;
      body.push(Buffer.from([0xc0, 12, 0, 1, 0, 1, 0, 0, 0, 30, 0, 4, 127, 0, 0, 1]));
    }
    dns.send(Buffer.concat(body), caller.port, caller.address);
  });
  const secret = randomUUID();
  const log: string[] = [];
  let readiness = "";
  let worker: ChildProcess | undefined;
  let exited: Promise<unknown[]> | undefined;
  let home: string | undefined;

  try {
    await Promise.all([once(origin, "listening"), once(dns, "listening")]);
    const upstream = (origin.address() as { port: number }).port;
    const port = await freePort();
    const controllerPort = await freePort();
    const config = {
      "proxy-providers": {
        RemoteProxy: { type: "http", proxy: "DIRECT", path: "./p.yaml", url: `http://127.0.0.1:${upstream}/proxies`, interval: 86400 },
      },
      "rule-providers": {
        RemoteRules: { type: "http", proxy: "DIRECT", path: "./r.yaml", url: `http://127.0.0.1:${upstream}/rules`, interval: 86400, behavior: "classical" },
      },
      "proxy-groups": [{ name: selector, type: "select", proxies: ["DIRECT", "REJECT"], use: ["RemoteProxy"] }],
      rules: [`RULE-SET,RemoteRules,${selector}`, "MATCH,REJECT"],
      dns: { enable: true, ipv6: false, "enhanced-mode": "normal", nameserver: [`udp://127.0.0.1:${dns.address().port}`] },
    };
    const imported = parseSubscription(JSON.stringify(config));
    expect(imported.nodes).toHaveLength(0);
    expect(imported.mihomo).toBeDefined();
    let args: string[];
    let payload: object;
    if (pack) {
      const harness = fileURLToPath(new URL("../.github/scripts/test-mihomo-worker.ps1", import.meta.url));
      args = ["-NoProfile", "-NonInteractive", "-File", harness, "-App", executable, "-Port", String(port)];
      payload = { config: imported.mihomo, core: "mihomo", routing_mode: "rule",
        controller: { port: controllerPort, secret }, selections: { [selector]: "FromProvider" } };
    } else {
      home = await mkdtemp(join(tmpdir(), "relaydesk-mihomo-"));
      args = ["-d", home, "-f", "-"];
      payload = {
        ...imported.mihomo, "mixed-port": port, "bind-address": "127.0.0.1", "allow-lan": false,
        "external-controller": `127.0.0.1:${controllerPort}`, secret, mode: "rule", "log-level": "warning",
      };
    }
    worker = spawn(pack ? "pwsh" : executable, args, { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    exited = once(worker, "exit");
    exited.catch(() => {});
    worker.stdout?.on("data", (chunk: Buffer) => {
      const line = chunk.toString().replaceAll(secret, "[redacted]");
      if (pack) readiness = (readiness + line).slice(-256);
      log.push(line);
    });
    worker.stderr?.on("data", (chunk: Buffer) => log.push(chunk.toString().replaceAll(secret, "[redacted]")));
    worker.stdin?.on("error", () => {});
    if (pack) worker.stdin?.write(JSON.stringify(payload) + "\n");
    else worker.stdin?.end(JSON.stringify(payload));

    const call = (path: string, init: RequestInit = {}, authenticated = true) => fetch(
      `http://127.0.0.1:${controllerPort}${path}`, {
        ...init, signal: AbortSignal.timeout(1800),
        headers: authenticated ? { Authorization: `Bearer ${secret}`, "Content-Type": "application/json" } : {},
      },
    );
    const groupPath = `/proxies/${encodeURIComponent(selector)}`;
    let providersReady = false;
    let providerState = "controller unavailable";
    for (let attempt = 0; attempt < 160 && worker.exitCode === null; attempt++) {
      providersReady = await Promise.all([call(groupPath), call("/providers/rules")]).then(async ([group, rules]) => {
        if (!group.ok || !rules.ok) {
          providerState = `group HTTP ${group.status}, rule provider HTTP ${rules.status}`;
          return false;
        }
        const [groupBody, ruleBody] = await Promise.all([group.json(), rules.json()]);
        const hasProxy = groupBody.all?.includes("FromProvider");
        const count = ruleBody.providers.RemoteRules?.ruleCount ?? 0;
        providerState = `proxy loaded: ${hasProxy}, rule count: ${count}`;
        return hasProxy && count === 1;
      }).catch(() => false);
      if (providersReady) break;
      await delay(120);
    }
    expect(providersReady, `${providerState}; origin requests: ${providerRequests}`).toBe(true);
    if (pack) {
      for (let attempt = 0; attempt < 80 && worker.exitCode === null && !readiness.split(/\r?\n/).includes("ready"); attempt++) {
        await delay(100);
      }
      expect(readiness.split(/\r?\n/)).toContain("ready");
      expect((await call(groupPath).then(result => result.json())).now).toBe("FromProvider");
      expect((await call(groupPath, { method: "PUT", body: '{"name":"DIRECT"}' })).status).toBe(204);
    }
    expect((await call("/version", {}, false)).status).toBe(401);
    const through = () => new Promise<{ status: number | undefined; text: string }>((resolve, reject) => {
      const host = `${hostname}:${upstream}`;
      const proxy = request({
        host: "127.0.0.1", port, path: `http://${host}/media`, headers: { Host: host }, timeout: 3500, agent: false,
      }, response => {
        let text = "";
        response.on("data", chunk => { text += chunk; });
        response.on("end", () => resolve({ status: response.statusCode, text }));
        response.on("error", reject);
      });
      proxy.on("error", reject);
      proxy.on("timeout", () => proxy.destroy(new Error("proxy request timed out")));
      proxy.end();
    });
    expect(await through()).toEqual({ status: 200, text: "relaydesk-mihomo-fixture" });
    expect(dnsQueries).toBeGreaterThan(0);
    expect((await call(groupPath, { method: "PUT", body: '{"name":"REJECT"}' })).status).toBe(204);
    expect((await call(groupPath).then(result => result.json())).now).toBe("REJECT");
    const rejection = await through().then(result => result.status ?? 0, () => 502);
    expect(rejection).toBeGreaterThanOrEqual(400);
    expect(targetCalls).toBe(1);
  } catch (error) {
    throw new Error(log.join("").slice(-3200) || "Mihomo profile test failed", { cause: error });
  } finally {
    if (worker && worker.exitCode === null && worker.signalCode === null) {
      if (pack) worker.stdin?.end("\n");
      else worker.kill();
    }
    const [code] = exited ? await Promise.race([exited, delay(13_000, ["timeout"], { ref: false })]) : [0];
    if (code === "timeout") worker?.kill();
    dns.close();
    origin.closeAllConnections();
    origin.close();
    if (home) await rm(home, { recursive: true, force: true });
    if (pack && code !== 0) throw new Error(log.join("").slice(-3200) || "Mihomo worker did not shut down cleanly");
  }
}

it.skipIf(!core || !!installed)("runs an original profile through the pinned Mihomo core", () => verifyProfile(core!), 42_000);
it.skipIf(!installed)("uses original providers, DNS, rules and group selection through the installed RelayDesk worker",
  () => verifyProfile(installed!, true), 52_000);
