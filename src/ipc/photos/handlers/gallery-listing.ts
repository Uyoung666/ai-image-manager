import { os } from "@orpc/server";
import { z } from "zod";
import {
  getGalleryLayoutPrefix,
  getGalleryPhotosByIds,
  listGalleryPhotos,
} from "@/services/gallery-listing";
import { describeGalleryThumbnails } from "@/services/thumbnail-identity";
import { GALLERY_CONFIG } from "@/utils/gallery-config";
import { BatchPhotoIdsSchema, ListSchema } from "./shared";

const schema = ListSchema.omit({ offset: true }).extend({
  cursor: z.string().max(4096).nullish(),
  direction: z.enum(["next", "previous"]).optional(),
  layoutOnly: z.boolean().optional(),
  limit: z.number().int().min(1).max(200).default(100),
});
// Seed the leading cards without waiting for source-file stats for a whole
// page. Other mounted cards use the shared on-demand descriptor endpoint.
export const listPhotoPage = os
  .input(schema)
  .errors({
    GALLERY_CURSOR_EXPIRED: { status: 409, message: "GALLERY_CURSOR_EXPIRED" },
  })
  .handler(async ({ input, errors }) => {
    let page: ReturnType<typeof listGalleryPhotos>;
    try {
      page = listGalleryPhotos(input);
    } catch (error) {
      if (
        error instanceof Error &&
        error.message === "GALLERY_CURSOR_EXPIRED"
      ) {
        // Plain Error messages are hidden by the message-port RPC transport.
        // Keep cursor recovery distinguishable from an unexpected server fault.
        throw errors.GALLERY_CURSOR_EXPIRED();
      }
      throw error;
    }
    if (input.layoutOnly) {
      return page;
    }
    const count = GALLERY_CONFIG.pageThumbnailDescriptors;
    const leading = await describeGalleryThumbnails(page.items.slice(0, count));
    return { ...page, items: [...leading, ...page.items.slice(count)] };
  });
export const getPhotoLayoutPrefix = os
  .input(
    schema.extend({
      targetId: z.number().int().positive(),
      fallbackIds: z.array(z.number().int().positive()).max(2).optional(),
      fallbackIndex: z.number().int().nonnegative().optional(),
    })
  )
  .handler(({ input }) =>
    getGalleryLayoutPrefix(
      input,
      input.targetId,
      input.fallbackIds,
      input.fallbackIndex
    )
  );
export const getPhotosByIds = os
  .input(BatchPhotoIdsSchema)
  .handler(({ input }) => getGalleryPhotosByIds(input.ids));

export const getPhotoThumbnailVersions = os
  .input(BatchPhotoIdsSchema)
  .handler(async ({ input }) => {
    const records = await describeGalleryThumbnails(
      getGalleryPhotosByIds(input.ids)
    );
    return records.map(({ id, thumbnailVersion }) => ({
      id,
      thumbnailVersion,
    }));
  });
