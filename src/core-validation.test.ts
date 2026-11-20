import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { buildConfig } from './config';
import { parseSubscription } from './subscription';

const core = process.env.SING_BOX;
describe.skipIf(!core)('real sing-box config validation', () => {
  const examples = [
    'vless://00000000-0000-4000-8000-000000000000@host.test:443?security=tls&sni=host.test&type=ws&path=%2Fws#ws',
    'hysteria2://password@host.test:443?sni=host.test&mport=2000-3000#hy',
  ];
  for (const example of examples) it('accepts a generated configuration', () => {
    expect(existsSync(core!)).toBe(true);
    const folder = mkdtempSync(join(tmpdir(), 'relaydesk-test-'));
    try {
      const configPath = join(folder, 'config.json');
      writeFileSync(configPath, JSON.stringify(buildConfig(parseSubscription(example).nodes[0], 32123)));
      const result = spawnSync(core!, ['check', '-c', configPath], { encoding: 'utf8' });
      expect(result.status, result.stderr).toBe(0);
    } finally { rmSync(folder, { recursive: true, force: true }); }
  });
});
