/**
 * Encryption/Decryption utility for sensitive URLs and data
 * Used for encrypting track download URLs from Jio Saavn before sending to client
 * Client sends encrypted URL to backend, backend decrypts and processes
 */

const crypto = require('crypto');
const logger = require('./logger');

const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');
const ENCRYPTION_ALGORITHM = 'aes-256-cbc';

/**
 * Encrypts a URL or data string
 * @param {string} data - Data to encrypt (usually URL)
 * @returns {string} Encrypted data with IV prepended (hex format)
 * @throws {Error} If encryption fails
 */
function encryptData(data) {
  try {
    const key = Buffer.from(ENCRYPTION_KEY, 'hex');
    const iv = crypto.randomBytes(16);
    
    const cipher = crypto.createCipheriv(ENCRYPTION_ALGORITHM, key, iv);
    let encrypted = cipher.update(data, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    
    // Prepend IV to encrypted data so it can be extracted during decryption
    const result = iv.toString('hex') + ':' + encrypted;
    
    logger.debug(`[Encryption] Encrypted data of length ${data.length}`);
    return result;
  } catch (error) {
    logger.error('[Encryption] Encryption failed:', error);
    throw new Error('Failed to encrypt data');
  }
}

/**
 * Decrypts an encrypted URL or data string
 * @param {string} encryptedData - Encrypted data with IV (hex format)
 * @returns {string} Decrypted original data
 * @throws {Error} If decryption fails
 */
function decryptData(encryptedData) {
  try {
    const parts = encryptedData.split(':');
    if (parts.length !== 2) {
      throw new Error('Invalid encrypted data format');
    }
    
    const iv = Buffer.from(parts[0], 'hex');
    const encrypted = parts[1];
    const key = Buffer.from(ENCRYPTION_KEY, 'hex');
    
    const decipher = crypto.createDecipheriv(ENCRYPTION_ALGORITHM, key, iv);
    let decrypted = decipher.update(encrypted, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    
    logger.debug('[Decryption] Successfully decrypted data');
    return decrypted;
  } catch (error) {
    logger.error('[Decryption] Decryption failed:', error);
    throw new Error('Failed to decrypt data');
  }
}

/**
 * Creates a hash of data (useful for validation)
 * @param {string} data - Data to hash
 * @returns {string} SHA256 hash
 */
function hashData(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

module.exports = {
  encryptData,
  decryptData,
  hashData,
  ENCRYPTION_KEY,
  ENCRYPTION_ALGORITHM
};
