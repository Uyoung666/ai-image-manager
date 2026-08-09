import fs from "node:fs";
import path from "node:path";
import { eq } from "drizzle-orm";
import { getDatabase } from "@/db";
import { cloudConfigs, cloudSyncLog, photos } from "@/db/schema";
import { decrypt, encrypt, needsMigration } from "@/services/credential-vault";
import type { CloudProvider, CloudProviderType } from "./abstract-provider";
import { s3Provider } from "./s3-provider";
import { webdavProvider } from "./webdav-provider";

const PATH_BASENAME_RE = /^.*[\\/]/;

export function getProvider(type: CloudProviderType): CloudProvider {
  return type === "webdav" ? webdavProvider : s3Provider;
}

export function buildPhotoRemotePath(
  photoId: number,
  filename: string
): string {
  const basename = filename.replace(PATH_BASENAME_RE, "") || `photo-${photoId}`;
  return `ai-image-manager/photos/${photoId}/${basename}`;
}

export function testConnection(configId: number) {
  const db = getDatabase();
  const cfg = db
    .select()
    .from(cloudConfigs)
    .where(eq(cloudConfigs.id, configId))
    .get();
  if (!cfg) {
    throw new Error("云配置不存在");
  }

  const configJson = cfg.configJson;
  const plaintext = decrypt(configJson);
  // 旧版格式惰性迁移到 safeStorage
  if (needsMigration(configJson)) {
    try {
      db.update(cloudConfigs)
        .set({ configJson: encrypt(plaintext) })
        .where(eq(cloudConfigs.id, configId))
        .run();
    } catch {
      // 迁移失败不影响正常使用，下次访问时重试
    }
  }
  const config = JSON.parse(plaintext);
  const provider = getProvider(cfg.provider as CloudProviderType);
  return provider.checkConnection(config);
}

export async function uploadPhoto(
  photoId: number,
  configId: number
): Promise<string> {
  const db = getDatabase();
  const photo = db.select().from(photos).where(eq(photos.id, photoId)).get();
  if (!photo) {
    throw new Error("照片不存在");
  }

  const cfg = db
    .select()
    .from(cloudConfigs)
    .where(eq(cloudConfigs.id, configId))
    .get();
  if (!cfg) {
    throw new Error("云配置不存在");
  }

  const configJson = cfg.configJson;
  const plaintext = decrypt(configJson);
  // 旧版格式惰性迁移到 safeStorage
  if (needsMigration(configJson)) {
    try {
      db.update(cloudConfigs)
        .set({ configJson: encrypt(plaintext) })
        .where(eq(cloudConfigs.id, configId))
        .run();
    } catch {
      // 迁移失败不影响正常使用
    }
  }
  const config = JSON.parse(plaintext);
  const provider = getProvider(cfg.provider as CloudProviderType);

  const buffer = fs.readFileSync(photo.path);
  const ext = path.extname(photo.filename);
  const remotePath = buildPhotoRemotePath(photo.id, photo.filename);

  // Log pending
  const logResult = db
    .insert(cloudSyncLog)
    .values({
      photoId,
      providerId: configId,
      action: "upload",
      status: "pending",
      remotePath,
    })
    .returning({ insertedId: cloudSyncLog.id })
    .get();

  try {
    const url = await provider.upload(
      buffer,
      remotePath,
      `image/${ext.replace(".", "") || "jpeg"}`,
      config
    );

    if (logResult) {
      db.update(cloudSyncLog)
        .set({ status: "success", remotePath: url })
        .where(eq(cloudSyncLog.id, logResult.insertedId))
        .run();
    }

    return url;
  } catch (err: unknown) {
    if (logResult) {
      db.update(cloudSyncLog)
        .set({
          status: "failed",
          error: err instanceof Error ? err.message : String(err),
        })
        .where(eq(cloudSyncLog.id, logResult.insertedId))
        .run();
    }
    throw err;
  }
}
