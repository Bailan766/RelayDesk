const ENCRYPTED_FORMAT = 'relaydesk-encrypted-backup';
const ENCRYPTED_VERSION = 1;
const KDF_ITERATIONS = 210_000;

export type EncryptedBackupEnvelope = {
  format: typeof ENCRYPTED_FORMAT;
  version: typeof ENCRYPTED_VERSION;
  kdf: 'PBKDF2-SHA256';
  iterations: number;
  cipher: 'AES-GCM';
  salt: string;
  iv: string;
  ciphertext: string;
};

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

function base64ToBytes(encoded: string): Uint8Array<ArrayBuffer> {
  const binary = atob(encoded);
  const buffer = new ArrayBuffer(binary.length);
  const out = new Uint8Array(buffer);
  for (let i = 0; i < binary.length; i++) {
    out[i] = binary.charCodeAt(i);
  }
  return out;
}

async function deriveAesKey(password: string, salt: BufferSource, iterations: number): Promise<CryptoKey> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    throw new Error('当前环境不支持加密备份接口');
  }
  const rawKey = await subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveKey'],
  );
  return subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt,
      iterations,
      hash: 'SHA-256',
    },
    rawKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

export function isEncryptedBackup(raw: string): boolean {
  try {
    const parsed = JSON.parse(raw) as Partial<EncryptedBackupEnvelope> | null;
    return Boolean(
      parsed &&
      typeof parsed === 'object' &&
      parsed.format === ENCRYPTED_FORMAT &&
      parsed.version === ENCRYPTED_VERSION &&
      typeof parsed.salt === 'string' &&
      typeof parsed.iv === 'string' &&
      typeof parsed.ciphertext === 'string',
    );
  } catch {
    return false;
  }
}

export async function encryptBackup(plaintext: string, password: string): Promise<string> {
  if (password.length < 4) {
    throw new Error('加密密码至少需要 4 个字符');
  }
  const salt = new Uint8Array(new ArrayBuffer(16));
  const iv = new Uint8Array(new ArrayBuffer(12));
  globalThis.crypto.getRandomValues(salt);
  globalThis.crypto.getRandomValues(iv);
  const key = await deriveAesKey(password, salt, KDF_ITERATIONS);
  const encrypted = await globalThis.crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    new TextEncoder().encode(plaintext),
  );
  const envelope: EncryptedBackupEnvelope = {
    format: ENCRYPTED_FORMAT,
    version: ENCRYPTED_VERSION,
    kdf: 'PBKDF2-SHA256',
    iterations: KDF_ITERATIONS,
    cipher: 'AES-GCM',
    salt: bytesToBase64(salt),
    iv: bytesToBase64(iv),
    ciphertext: bytesToBase64(new Uint8Array(encrypted)),
  };
  return JSON.stringify(envelope, null, 2);
}

export async function decryptBackup(rawEnvelope: string, password: string): Promise<string> {
  if (!password) {
    throw new Error('请输入备份解密密码');
  }
  let parsed: EncryptedBackupEnvelope;
  try {
    parsed = JSON.parse(rawEnvelope) as EncryptedBackupEnvelope;
  } catch {
    throw new Error('加密备份文件格式无效');
  }
  if (
    parsed.format !== ENCRYPTED_FORMAT ||
    parsed.version !== ENCRYPTED_VERSION ||
    parsed.kdf !== 'PBKDF2-SHA256' ||
    typeof parsed.iterations !== 'number' ||
    parsed.iterations < 10_000 ||
    parsed.iterations > 2_000_000 ||
    typeof parsed.salt !== 'string' ||
    typeof parsed.iv !== 'string' ||
    typeof parsed.ciphertext !== 'string'
  ) {
    throw new Error('不支持的加密备份版本或格式');
  }
  try {
    const salt = base64ToBytes(parsed.salt);
    const iv = base64ToBytes(parsed.iv);
    const ciphertext = base64ToBytes(parsed.ciphertext);
    const key = await deriveAesKey(password, salt, parsed.iterations);
    const decrypted = await globalThis.crypto.subtle.decrypt(
      { name: 'AES-GCM', iv },
      key,
      ciphertext,
    );
    return new TextDecoder().decode(decrypted);
  } catch {
    throw new Error('备份密码错误或文件已损坏');
  }
}
