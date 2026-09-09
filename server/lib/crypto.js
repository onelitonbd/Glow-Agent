import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { AppError } from './errors.js';

const algorithm = 'aes-256-gcm';
const version = 'v1';

export function encryptJson(value, key) {
  const iv = randomBytes(12);
  const cipher = createCipheriv(algorithm, key, iv);
  const plaintext = Buffer.from(JSON.stringify(value), 'utf8');
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [version, iv.toString('base64url'), ciphertext.toString('base64url'), tag.toString('base64url')].join('.');
}

export function decryptJson(payload, key) {
  try {
    const [payloadVersion, encodedIv, encodedCiphertext, encodedTag, extra] = String(payload).split('.');
    if (payloadVersion !== version || !encodedIv || !encodedCiphertext || !encodedTag || extra) throw new Error('Invalid encrypted payload.');
    const decipher = createDecipheriv(algorithm, key, Buffer.from(encodedIv, 'base64url'));
    decipher.setAuthTag(Buffer.from(encodedTag, 'base64url'));
    const plaintext = Buffer.concat([decipher.update(Buffer.from(encodedCiphertext, 'base64url')), decipher.final()]);
    return JSON.parse(plaintext.toString('utf8'));
  } catch {
    throw new AppError(500, 'CREDENTIAL_DECRYPTION_FAILED', 'Stored provider credentials could not be read. Check APP_ENCRYPTION_KEY.', { expose: true });
  }
}
