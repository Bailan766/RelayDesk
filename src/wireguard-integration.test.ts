import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createSocket } from 'node:dgram';
import { once } from 'node:events';
import { createServer as httpServer, request } from 'node:http';
import { createServer as tcpServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { buildSessionConfig } from './config';
import { parseSubscription } from './subscription';

const core = process.env.SING_BOX;
const installedApp = process.env.RELAYDESK_INSTALLED_SMOKE_APP;

async function defaultIPv4() {
  const socket = createSocket('udp4');
  try {
    socket.connect(1, '192.0.2.1');
    await once(socket, 'connect');
    return socket.address().address;
  } finally {
    socket.close();
  }
}

function key() {
  const generated = spawnSync(core!, ['generate', 'wg-keypair'], { windowsHide: true, encoding: 'utf8' });
  const privateKey = generated.stdout.match(/PrivateKey:?\s+(\S+)/i)?.[1];
  const publicKey = generated.stdout.match(/PublicKey:?\s+(\S+)/i)?.[1];
  if (!privateKey || !publicKey) throw new Error('Cannot generate WireGuard fixture keys');
  return { privateKey, publicKey };
}

async function relayTraffic(peerHost: string, app?: string) {
  const peerIP = peerHost === 'wg.fixture.test' ? await defaultIPv4() : peerHost;
  const udp = createSocket('udp4').bind(0, '0.0.0.0');
  await once(udp, 'listening');
  const wireguardPort = udp.address().port;
  await new Promise<void>(done => udp.close(done));
  const reserved = tcpServer().listen(0, '127.0.0.1');
  await once(reserved, 'listening');
  const mixedPort = (reserved.address() as { port: number }).port;
  await new Promise<void>(done => reserved.close(() => done()));

  const endpoint = httpServer((_, response) => response.end('wireguard-fixture')).listen(0, '127.0.0.1');
  await once(endpoint, 'listening');
  const destinationPort = (endpoint.address() as { port: number }).port;
  const client = key();
  const server = key();
  const children: ChildProcess[] = [];
  const log: string[] = [];
  let tun: ChildProcess | undefined;
  let tunExit: Promise<unknown[]> | undefined;

  async function boot(config: object) {
    const process = spawn(core!, ['run', '-c', 'stdin'], {
      windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    });
    children.push(process);
    let ready = false;
    let previous = '';
    const collect = (chunk: Buffer) => {
      const filtered = chunk.toString().replaceAll(client.privateKey, '[redacted]').replaceAll(server.privateKey, '[redacted]');
      log.push(filtered);
      previous = (previous + filtered).slice(-1024);
      if (previous.includes('sing-box started')) ready = true;
    };
    process.stdout.on('data', collect);
    process.stderr.on('data', collect);
    process.stdin.on('error', () => {});
    process.stdin.end(JSON.stringify(config));
    for (let attempt = 0; attempt < 60 && process.exitCode === null; attempt++) {
      if (ready) return;
      await delay(75);
    }
    throw new Error('WireGuard fixture did not start');
  }

  try {
    const peer = {
      type: 'wireguard', tag: 'wg-server', system: false, address: ['198.18.0.1/32'], private_key: server.privateKey,
      listen_port: wireguardPort, peers: [{ public_key: client.publicKey, allowed_ips: ['198.18.0.2/32'] }],
    };
    await boot({
      endpoints: [peer], outbounds: [{ type: 'direct', tag: 'direct' }],
      route: { rules: [{ inbound: ['wg-server'], outbound: 'direct', override_address: '127.0.0.1' }], final: 'direct' },
    });
    const content = `proxies:
- name: fixture
  type: wireguard
  server: ${peerHost}
  port: ${wireguardPort}
  ip: 198.18.0.2
  private-key: "${client.privateKey}"
  public-key: "${server.publicKey}"
  allowed-ips: ["198.18.0.1/32"]
  udp: true`;
    const nodes = parseSubscription(content).nodes;
    const { config } = buildSessionConfig(nodes[0], nodes, mixedPort, []);
    expect(config.endpoints?.[0].system).toBe(false);
    expect(config.dns?.servers[0].type).toBe('local');
    const dns = peerHost === 'wg.fixture.test'
      ? { ...config.dns, servers: [{ type: 'hosts', tag: 'bootstrap', predefined: { [peerHost]: peerIP } }] }
      : config.dns;
    if (app) {
      const harness = fileURLToPath(new URL('../.github/scripts/test-wireguard-tun.ps1', import.meta.url));
      tun = spawn('pwsh', ['-NoProfile', '-NonInteractive', '-File', harness, '-App', app], {
        windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
      });
      tunExit = once(tun, 'exit');
      tunExit.catch(() => {});
      tun.stderr?.on('data', (chunk: Buffer) => log.push(chunk.toString()));
      tun.stdin?.on('error', () => {});
      const ready = new Promise<boolean>(resolve => {
        let output = '';
        tun?.stdout?.on('data', (chunk: Buffer) => {
          output += chunk.toString();
          if (output.split(/\r?\n/).includes('ready')) resolve(true);
        });
      });
      tun.stdin?.write(JSON.stringify(config) + '\n');
      if (!await Promise.race([ready, tunExit.then(() => false), delay(32_000, false, { ref: false })])) {
        throw new Error('Installed WireGuard TUN did not start');
      }
    } else {
      await boot({ ...config, dns, log: { level: 'info' } });
    }
    const data = await new Promise<string>((resolve, reject) => {
      const target = app
        ? { host: '198.18.0.1', port: destinationPort, path: '/' }
        : { host: '127.0.0.1', port: mixedPort, path: `http://198.18.0.1:${destinationPort}/` };
      const proxy = request({ ...target, timeout: 6500, agent: false }, response => {
        let text = '';
        response.setEncoding('utf8');
        response.on('data', chunk => { text += chunk; });
        response.on('end', () => resolve(text));
        response.on('error', reject);
      });
      proxy.on('error', reject);
      proxy.on('timeout', () => proxy.destroy(new Error('WireGuard request timed out')));
      proxy.end();
    });
    expect(data).toBe('wireguard-fixture');
  } catch (error) {
    throw new Error(log.join('').slice(-2400), { cause: error });
  } finally {
    const tunWasRunning = tun?.exitCode === null && tun.signalCode === null;
    if (tunWasRunning) tun?.stdin?.end('\n');
    endpoint.closeAllConnections();
    endpoint.close();
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = once(child, 'exit');
        child.kill();
        await exited;
      }
    }
    if (tunWasRunning && tunExit) {
      const [exit] = await Promise.race([tunExit, delay(14_000, ['timeout'], { ref: false })]);
      if (exit === 'timeout') tun?.kill();
      if (exit !== 0) throw new Error(log.join('').slice(-2400) || 'Installed WireGuard TUN did not stop cleanly');
    }
  }
}

it.skipIf(!core).each(['127.0.0.1', 'wg.fixture.test'])('relays traffic from a Clash WireGuard node to %s',
  peerHost => relayTraffic(peerHost), 18_000);

it.skipIf(!core || !installedApp)('relays real traffic through the installed Windows TUN worker',
  () => relayTraffic('127.0.0.1', installedApp), 58_000);
