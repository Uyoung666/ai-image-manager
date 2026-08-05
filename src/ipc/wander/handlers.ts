import { os } from "@orpc/server";
import {
  GetWanderSessionSchema,
  RecordWanderExposureSchema,
  SaveWanderSessionToAlbumSchema,
} from "./schemas";
import {
  getCuratedWanderSession,
  recordExposure,
  saveSessionToAlbum,
} from "./service";

export const getWanderSession = os
  .input(GetWanderSessionSchema)
  .handler(({ input }) => getCuratedWanderSession(input));

export const recordWanderExposure = os
  .input(RecordWanderExposureSchema)
  .handler(({ input }) => {
    recordExposure(input.photoId, input.source);
    return { ok: true as const };
  });

export const saveWanderSessionToAlbum = os
  .input(SaveWanderSessionToAlbumSchema)
  .handler(({ input }) => ({
    albumId: saveSessionToAlbum(input.title, input.photoIds),
  }));
