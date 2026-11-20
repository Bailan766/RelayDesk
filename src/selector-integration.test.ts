import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { connect, createServer, type Server, type Socket } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { expect, it } from "vitest";
import { buildSessionConfig } from "./config";
import { parseSubscription } from "./subscription";

const core = process.env.SING_BOX;
async function open(server: Server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return (server.address() as { port: number }).port;
}

async function availablePorts(count: number): Promise<number[]> {
  const listeners = Array.from({ length: count }, () => createServer());
  try { return await Promise.all(listeners.map(open)); }
  finally { listeners.forEach(listener => listener.close()); }
}

function read(socket: Socket, expected: (value: string) => boolean): Promise<string> {
  return new Promise((resolve, reject) => {
    let value = "";
    const timeout = setTimeout(() => finish(new Error("TCP read timed out")), 2500);
    const onClose = () => finish(new Error("TCP connection closed"));
    const onData = (chunk: Buffer) => {
      value += chunk.toString();
      if (expected(value)) finish();
    };
    function finish(error?: Error) {
      clearTimeout(timeout);
      socket.off("data", onData);
      socket.off("close", onClose);
      if (error) reject(error); else resolve(value);
    }
    socket.on("data", onData);
    socket.once("close", onClose);
  });
}

it.skipIf(!core)("switches live outgoing traffic without closing an existing TCP tunnel", async () => {
  const server = createServer(socket => socket.pipe(socket));
  const sockets: Socket[] = [];
  const children: ChildProcess[] = [];
  const secret = "selector-fixture";
  const user = "00000000-0000-4000-8000-000000000000";
  function start(config: object) {
    const process = spawn(core!, ["run", "-c", "stdin"], { stdio: ["pipe", "ignore", "ignore"], windowsHide: true });
    children.push(process);
    process.stdin.on("error", () => {});
    process.stdin.end(JSON.stringify(config));
  }

  try {
    const target = await open(server);
    const [firstNode, secondNode, mixed, api] = await availablePorts(4);
    start({
      inbounds: [firstNode, secondNode].map((port, index) => ({
        type: "vless", tag: `server-${index}`, listen: "127.0.0.1", listen_port: port,
        users: [{ uuid: user }],
      })),
      outbounds: [{ type: "direct", tag: "direct" }],
    });
    const nodes = parseSubscription([firstNode, secondNode].map((port, index) =>
      `vless://${user}@127.0.0.1:${port}#node-${index}`).join("\n")).nodes;
    const { config } = buildSessionConfig(nodes[0], nodes, mixed, []);
    start({ ...config, experimental: { clash_api: {
      external_controller: `127.0.0.1:${api}`, secret,
    } } });

    const controller = (path: string, init?: RequestInit) => fetch(`http://127.0.0.1:${api}${path}`, {
      ...init, headers: { Authorization: `Bearer ${secret}`, "Content-Type": "application/json" },
      signal: AbortSignal.timeout(1500),
    });
    let ready = false;
    for (let attempt = 0; attempt < 30; attempt++) {
      ready = await controller("/proxies/proxy").then(response => response.ok).catch(() => false);
      if (ready) break;
      await delay(75);
    }
    expect(ready).toBe(true);

    async function tunnel(): Promise<Socket> {
      const socket = connect(mixed, "127.0.0.1");
      sockets.push(socket);
      await once(socket, "connect");
      socket.on("error", () => {});
      const headers = read(socket, value => value.includes("\r\n\r\n"));
      socket.write(`CONNECT 127.0.0.1:${target} HTTP/1.1\r\nHost: 127.0.0.1:${target}\r\n\r\n`);
      expect(await headers).toMatch(/^HTTP\/1\.1 200/);
      return socket;
    }
    async function echo(socket: Socket, message: string) {
      const response = read(socket, value => value.length >= message.length);
      socket.write(message);
      expect(await response).toBe(message);
    }
    const first = await tunnel();
    await echo(first, "before");
    expect((await controller("/proxies/proxy", { method: "PUT", body: '{"name":"node-1"}' })).status).toBe(204);
    const second = await tunnel();
    await Promise.all([echo(first, "existing"), echo(second, "new")]);
    const response = await controller("/connections");
    const body = await response.json() as { connections: { chains: string[] }[] };
    expect(body.connections.some(connection => connection.chains.includes("node-0"))).toBe(true);
    expect(body.connections.some(connection => connection.chains.includes("node-1"))).toBe(true);
  } finally {
    sockets.forEach(socket => socket.destroy());
    server.close();
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) {
        const stopped = once(child, "exit");
        child.kill();
        await stopped;
      }
    }
  }
}, 10_000);
