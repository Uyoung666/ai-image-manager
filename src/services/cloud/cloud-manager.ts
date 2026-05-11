import fs from "node:fs";
import path from "node:path";
import { eq } from "drizzle-orm";
import { getDatabase } from "@/db";
import { cloudConfigs, cloudSyncLog, photos } from "@/db/schema";
import { decrypt } from "@/services/credential-vault";
import { type CloudProvider, type CloudProviderType } from "./abstract-provider";
import { s3Provider } from "./s3-provider";
import { webdavProvider } from "./webdav-provider";

function getProvider(type: CloudProviderType): CloudProvider {
  return type === "webdav" ? webdavProvider : s3Provider;
}

export async function testConnection(configId: number) {
  const db = getDatabase();
  const cfg = db.select().from(cloudConfigs).where(eq(cloudConfigs.id, configId)).get();
  if (!cfg) throw new Error("云配置不存在");

  const config = JSON.parse(decrypt(cfg.configJson));
  const provider = getProvider(cfg.provider as CloudProviderType);
  return provider.checkConnection(config);
}

export async function uploadPhoto(photoId: number, configId: number): Promise<string> {
  const db = getDatabase();
  const photo = db.select().from(photos).where(eq(photos.id, photoId)).get();
  if (!photo) throw new Error("照片不存在");

  const cfg = db.select().from(cloudConfigs).where(eq(cloudConfigs.id, configId)).get();
  if (!cfg) throw new Error("云配置不存在");

  const config = JSON.parse(decrypt(cfg.configJson));
  const provider = getProvider(cfg.provider as CloudProviderType);

  const buffer = fs.readFileSync(photo.path);
  const ext = path.extname(photo.filename);
  const remotePath = `ai-image-manager/${photo.filename}`;

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

    // Update log to success
    if (logResult) {
      db.update(cloudSyncLog)
        .set({ status: "success", remotePath: url })
        .where(eq(cloudSyncLog.id, logResult.insertedId))
        .run();
    }

    return url;
  } catch (err: any) {
    // Update log to failed
    if (logResult) {
      db.update(cloudSyncLog)
        .set({ status: "failed", error: err.message })
        .where(eq(cloudSyncLog.id, logResult.insertedId))
        .run();
    }
    throw err;
  }
}
