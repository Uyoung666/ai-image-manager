import crypto from "node:crypto";
import os from "node:os";
import { safeStorage } from "electron";

// ── 常量 ──────────────────────────────────────────────────────────
const PREFIX = "AI_IMAGE_MANAGER_SAFESTORAGE_V1:";
const ALGORITHM = "aes-256-gcm";
const SALT = "ai-image-manager-cred-vault";
const KEY_LEN = 32;
const IV_LEN = 16;
const TAG_LEN = 16;

// ── 旧版密钥派生（仅用于迁移解密旧数据）────────────────────────
function deriveKey(): Buffer {
  const seed = `${os.hostname()}:${os.userInfo().username}:${process.env.APPDATA || process.env.HOME || ""}`;
  return crypto.scryptSync(seed, SALT, KEY_LEN);
}

/** 使用旧版 AES-256-GCM 解密（仅迁移用） */
function decryptLegacy(encoded: string): string {
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

/** 判断加密值是否为旧版格式（无前缀的 base64 原始 AES 密文） */
function isLegacyFormat(encoded: string): boolean {
  return !encoded.startsWith(PREFIX);
}

// ── 公开 API ──────────────────────────────────────────────────────

/**
 * 加密明文配置。
 * 使用操作系统级安全存储（Windows DPAPI / macOS Keychain / Linux libsecret）。
 * 如果 safeStorage 不可用则抛出异常。
 */
export function encrypt(plaintext: string): string {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error(
      "系统安全存储不可用，无法加密云服务凭据。请检查桌面环境是否正常。"
    );
  }
  const encrypted = safeStorage.encryptString(plaintext);
  return PREFIX + encrypted.toString("base64");
}

/**
 * 解密密文配置。
 * 自动检测格式：新版 safeStorage（带前缀）或旧版 AES-256-GCM（无前缀）。
 * 旧版格式解密后不会自动迁移——调用方应使用 {@link needsMigration} 判断并按需调用 {@link encrypt} 回写。
 */
export function decrypt(encoded: string): string {
  if (isLegacyFormat(encoded)) {
    return decryptLegacy(encoded);
  }
  // 去掉前缀，base64 解码后交给 safeStorage
  const payload = encoded.slice(PREFIX.length);
  const buffer = Buffer.from(payload, "base64");
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error(
      "系统安全存储不可用，无法解密云服务凭据。请检查桌面环境是否正常。"
    );
  }
  return safeStorage.decryptString(buffer);
}

/**
 * 检查已存储的密文是否需要从旧版格式迁移到 safeStorage。
 * 用于云配置读取时惰性迁移。
 */
export function needsMigration(encoded: string): boolean {
  return isLegacyFormat(encoded) && safeStorage.isEncryptionAvailable();
}
