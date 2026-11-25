import { ORPCError, os } from "@orpc/server";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { getDatabase } from "@/db";
import { cloudConfigs } from "@/db/schema";
import type { CloudProviderType } from "@/services/cloud/abstract-provider";
import { getProvider } from "@/services/cloud/cloud-manager";
import { decrypt } from "@/services/credential-vault";
import { generateSharePage } from "@/services/share-page";
import { deliveryDisclosureSchema } from "@/types/photo-delivery";

export const generateAndUploadShare = os
  .input(
    z.object({
      photoIds: z
        .array(z.number().int().positive().max(2_147_483_646))
        .min(1)
        .max(100_000),
      cloudConfigId: z.number().int().positive(),
      locale: z.string().optional().default("zh-CN"),
      disclosure: deliveryDisclosureSchema.optional(),
    })
  )
  .handler(async ({ input }) => {
    const { photoIds, cloudConfigId, locale, disclosure } = input;
    const db = getDatabase();

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
    const html = await generateSharePage(photoIds, locale, disclosure).catch(
      (error: unknown) => {
        if (
          error instanceof Error &&
          error.message === "SHARE_PAGE_TOO_LARGE"
        ) {
          throw new ORPCError("PAYLOAD_TOO_LARGE", { message: error.message });
        }
        throw error;
      }
    );
    const buf = Buffer.from(html, "utf-8");
    const filename = `share-${Date.now()}`;
    const remotePath = `ai-image-manager/shares/${filename}`;

    const url = await provider.upload(
      buf,
      remotePath,
      "text/html; charset=utf-8",
      config
    );

    return { success: true, url, filename, provider: cfg.provider };
  });
