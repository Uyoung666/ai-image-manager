import { os } from "@orpc/server";
import { desc, eq } from "drizzle-orm";
import { z } from "zod";
import { getDatabase } from "@/db";
import { cloudConfigs } from "@/db/schema";
import { testConnection, uploadPhoto } from "@/services/cloud/cloud-manager";
import { encrypt } from "@/services/credential-vault";

export const listCloudConfigs = os.handler(() => {
  const db = getDatabase();
  return db
    .select()
    .from(cloudConfigs)
    .orderBy(desc(cloudConfigs.createdAt))
    .all();
});

export const createCloudConfig = os
  .input(
    z.object({
      name: z.string().min(1),
      provider: z.enum(["webdav", "s3"]),
      config: z.record(z.string(), z.string()),
      isDefault: z.boolean().optional(),
    })
  )
  .handler(({ input }) => {
    const db = getDatabase();
    const result = db
      .insert(cloudConfigs)
      .values({
        name: input.name,
        provider: input.provider,
        configJson: encrypt(JSON.stringify(input.config)),
        isDefault: input.isDefault ?? false,
      })
      .returning({ insertedId: cloudConfigs.id })
      .get();
    return db
      .select()
      .from(cloudConfigs)
      .where(eq(cloudConfigs.id, result?.insertedId))
      .get();
  });

export const deleteCloudConfig = os
  .input(z.object({ id: z.number() }))
  .handler(({ input }) => {
    const db = getDatabase();
    db.delete(cloudConfigs).where(eq(cloudConfigs.id, input.id)).run();
    return { ok: true };
  });

export const testCloudConnection = os
  .input(z.object({ id: z.number() }))
  .handler(({ input }) => {
    return testConnection(input.id);
  });

export const uploadPhotoToCloud = os
  .input(z.object({ cloudConfigId: z.number(), photoId: z.number() }))
  .handler(async ({ input }) => {
    try {
      const url = await uploadPhoto(input.photoId, input.cloudConfigId);
      return { success: true, remotePath: url };
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  });
