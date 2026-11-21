import { describe, expect, it } from 'vitest';
import { decryptBackup, encryptBackup, isEncryptedBackup } from './backupCrypto';

describe('encrypted workspace backup', () => {
  it('round-trips workspace JSON with PBKDF2-SHA256 + AES-GCM and rejects wrong password or tampered payload', async () => {
    const sample = JSON.stringify({ version: 2, subscriptions: [{ id: '1', source: 'https://secret.example/sub?token=abc' }] });
    expect(isEncryptedBackup(sample)).toBe(false);

    const encrypted = await encryptBackup(sample, 's3cr3t-pass');
    expect(encrypted).not.toContain('secret.example');
    expect(isEncryptedBackup(encrypted)).toBe(true);

    const decrypted = await decryptBackup(encrypted, 's3cr3t-pass');
    expect(decrypted).toBe(sample);

    await expect(decryptBackup(encrypted, 'wrong-pass')).rejects.toThrow('密码错误');

    const tampered = JSON.parse(encrypted);
    tampered.ciphertext = 'A'.repeat(tampered.ciphertext.length);
    await expect(decryptBackup(JSON.stringify(tampered), 's3cr3t-pass')).rejects.toThrow('损坏');
  });

  it('requires at least 4 characters for backup encryption passwords', async () => {
    await expect(encryptBackup('{}', '123')).rejects.toThrow('至少需要 4 个字符');
  });
});
