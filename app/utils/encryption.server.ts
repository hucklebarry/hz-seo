import crypto from "node:crypto";

function getKey(): Buffer {
  const keyHex = process.env.ENCRYPTION_KEY;
  if (!keyHex) {
    throw new Error(
      "ENCRYPTION_KEY environment variable is not set. " +
        "Generate one by running:\n" +
        "  node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\"\n" +
        "Then add ENCRYPTION_KEY=<result> to your .env file.",
    );
  }
  const key = Buffer.from(keyHex, "hex");
  if (key.length !== 32) {
    throw new Error("ENCRYPTION_KEY must be exactly 64 hex characters (32 bytes / 256 bits).");
  }
  return key;
}

/**
 * Encrypt plaintext using AES-256-GCM.
 * Returns "ivHex:authTagHex:ciphertextHex"
 */
export function encrypt(text: string): string {
  const key = getKey();
  const iv = crypto.randomBytes(12); // 96-bit IV (recommended for GCM)
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return [iv.toString("hex"), authTag.toString("hex"), encrypted.toString("hex")].join(":");
}

/**
 * Decrypt a value produced by encrypt().
 */
export function decrypt(encryptedText: string): string {
  const key = getKey();
  const parts = encryptedText.split(":");
  if (parts.length !== 3) throw new Error("Invalid encrypted text format.");
  const [ivHex, authTagHex, ciphertextHex] = parts;
  const iv = Buffer.from(ivHex, "hex");
  const authTag = Buffer.from(authTagHex, "hex");
  const ciphertext = Buffer.from(ciphertextHex, "hex");
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(authTag);
  return decipher.update(ciphertext).toString("utf8") + decipher.final("utf8");
}
