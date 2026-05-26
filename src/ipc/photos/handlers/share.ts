import { os } from "@orpc/server";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { getDatabase } from "@/db";
import { cloudConfigs } from "@/db/schema";
import type { CloudProviderType } from "@/services/cloud/abstract-provider";
import { getProvider } from "@/services/cloud/cloud-manager";
import { decrypt } from "@/services/credential-vault";
import { generateSharePage } from "@/services/share-page";

export const generateAndUploadShare = os
  .input(
    z.object({
      photoIds: z.array(z.number()),
      cloudConfigId: z.number(),
      locale: z.string().optional().default("zh-CN"),
    })
  )
  .handler(async ({ input }) => {
    const { photoIds, cloudConfigId, locale } = input;
    const db = getDatabase();

    // Generate share page HTML
    const html = await generateSharePage(photoIds, locale);

    const buf = Buffer.from(html, "utf-8");
    const filename = `share-${Date.now()}`;
    const remotePath = `ai-image-manager/shares/${filename}`;

    // Resolve cloud config
    const cfg = db
      .select()
      .from(cloudConfigs)
      .where(eq(cloudConfigs.id, cloudConfigId))
      .get();
    if (!cfg) {
      throw new Error("云配置不存在");
    }

    const config = JSON.parse(decrypt(cfg.configJson));
    const provider = getProvider(cfg.provider as CloudProviderType);

    const url = await provider.upload(
      buf,
      remotePath,
      "text/html; charset=utf-8",
      config
    );

    return { success: true, url, filename, provider: cfg.provider };
  });
