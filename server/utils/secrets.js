import crypto from 'node:crypto';

const encryptionKey = () => {
  const configured = String(process.env.SHOP_SECRET_ENCRYPTION_KEY || process.env.JWT_SECRET || '').trim();
  if (!configured) throw new Error('Set SHOP_SECRET_ENCRYPTION_KEY (or JWT_SECRET) before saving shop secrets.');
  return crypto.createHash('sha256').update(configured).digest();
};

export function encryptSecret(value) {
  const secret = String(value || '').trim();
  if (!secret) return '';
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
  return `v1:${iv.toString('base64url')}:${cipher.getAuthTag().toString('base64url')}:${encrypted.toString('base64url')}`;
}

export function decryptSecret(value) {
  const packed = String(value || '');
  if (!packed) return '';
  const [version, ivText, tagText, encryptedText] = packed.split(':');
  if (version !== 'v1' || !ivText || !tagText || !encryptedText) throw new Error('The shop Gemini key cannot be decrypted. Check SHOP_SECRET_ENCRYPTION_KEY.');
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey(), Buffer.from(ivText, 'base64url'));
    decipher.setAuthTag(Buffer.from(tagText, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(encryptedText, 'base64url')), decipher.final()]).toString('utf8');
  } catch {
    throw new Error('The shop Gemini key cannot be decrypted. Check SHOP_SECRET_ENCRYPTION_KEY.');
  }
}
