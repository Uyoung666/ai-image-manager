import { os } from "@orpc/server";
import { z } from "zod";
import {
  getGalleryLayoutPrefix,
  getGalleryPhotosByIds,
  listGalleryPhotos,
} from "@/services/gallery-listing";
import { describeGalleryThumbnails } from "@/services/thumbnail-identity";
import { getGalleryThumbnailHint } from "@/services/thumbnailer";
import { BatchPhotoIdsSchema, ListSchema } from "./shared";

const schema = ListSchema.omit({ offset: true }).extend({
  cursor: z.string().max(4096).nullish(),
  direction: z.enum(["next", "previous"]).optional(),
  layoutOnly: z.boolean().optional(),
  limit: z.number().int().min(1).max(200).default(100),
});
// Listing never waits for filesystem metadata. Visible cards share the bounded
// on-demand descriptor queue, including the first dense viewport.
export const listPhotoPage = os
  .input(schema)
  .errors({
    GALLERY_CURSOR_EXPIRED: { status: 409, message: "GALLERY_CURSOR_EXPIRED" },
  })
  .handler(({ input, errors }) => {
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
    return page;
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
  .input(
    BatchPhotoIdsSchema.extend({
      priority: z.number().int().min(0).max(2).default(2),
      edge: z
        .union([
          z.literal(256),
          z.literal(512),
          z.literal(1024),
          z.literal(2048),
        ])
        .optional(),
      edges: z
        .array(
          z.object({
            id: z.number().int().positive(),
            edge: z.union([
              z.literal(256),
              z.literal(512),
              z.literal(1024),
              z.literal(2048),
            ]),
          })
        )
        .max(1000)
        .optional(),
    })
  )
  .handler(async ({ input }) => {
    const edges = new Map(input.edges?.map((item) => [item.id, item.edge]));
    const records = await describeGalleryThumbnails(
      getGalleryPhotosByIds(input.ids),
      input.priority,
      input.edge || edges.size > 0
        ? (photo, stat, readStat) =>
            getGalleryThumbnailHint(
              photo,
              edges.get(photo.id) ?? input.edge ?? 512,
              stat,
              readStat
            )
        : undefined
    );
    return records.map(({ id, thumbnailVersion, availableEdge }) => ({
      id,
      thumbnailVersion,
      availableEdge,
    }));
  });
