const crypto = require('crypto');
const config = require('../config');

// Generate 32-byte key from master secret
const key = crypto.createHash('sha256').update(config.ENCRYPTION_KEY).digest();

/**
 * Encrypts a sensitive string (e.g. Kick stream key) using AES-256-GCM.
 * @param {string} text Plaintext to encrypt
 * @returns {{ cipherText: string, iv: string, tag: string }}
 */
function encrypt(text) {
  if (!text) return { cipherText: '', iv: '', tag: '' };
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  let encrypted = cipher.update(text, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const tag = cipher.getAuthTag().toString('hex');
  return {
    cipherText: encrypted,
    iv: iv.toString('hex'),
    tag
  };
}

/**
 * Decrypts an AES-256-GCM ciphertext.
 * @param {string} cipherText Hex ciphertext
 * @param {string} ivHex Hex IV
 * @param {string} tagHex Hex Auth Tag
 * @returns {string} Plaintext
 */
function decrypt(cipherText, ivHex, tagHex) {
  if (!cipherText || !ivHex || !tagHex) return '';
  const iv = Buffer.from(ivHex, 'hex');
  const tag = Buffer.from(tagHex, 'hex');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  let decrypted = decipher.update(cipherText, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  return decrypted;
}

/**
 * Masks a stream key for secure display in API responses and logs.
 * e.g. "sk_us-west-2_1234567890abcdef" -> "sk_us****ef"
 */
function maskStreamKey(key) {
  if (!key || typeof key !== 'string') return '';
  if (key.length <= 8) return '****';
  return key.slice(0, 5) + '****' + key.slice(-4);
}

module.exports = {
  encrypt,
  decrypt,
  maskStreamKey
};
