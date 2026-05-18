import crypto from "node:crypto";
import os from "node:os";

const ALGORITHM = "aes-256-gcm";
const SALT = "ai-image-manager-cred-vault";
const KEY_LEN = 32;
const IV_LEN = 16;
const TAG_LEN = 16;

function deriveKey(): Buffer {
  const seed = `${os.hostname()}:${os.userInfo().username}:${process.env.APPDATA || process.env.HOME || ""}`;
  return crypto.scryptSync(seed, SALT, KEY_LEN);
}

export function encrypt(plaintext: string): string {
  const key = deriveKey();
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([
    cipher.update(plaintext, "utf-8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  // Format: base64(iv + tag + ciphertext)
  return Buffer.concat([iv, tag, encrypted]).toString("base64");
}

export function decrypt(encoded: string): string {
  const key = deriveKey();
  const buf = Buffer.from(encoded, "base64");
  const iv = buf.subarray(0, IV_LEN);
  const tag = buf.subarray(IV_LEN, IV_LEN + TAG_LEN);
  const encrypted = buf.subarray(IV_LEN + TAG_LEN);
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString(
    "utf-8"
  );
}
