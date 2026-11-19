import { os } from "@orpc/server";
import { z } from "zod";
import {
  hasContentCredentialTool,
  isContentCredentialCurrent,
  readSavedContentCredential,
  verifyPhotoContentCredential,
} from "@/services/content-credentials";
import { IdSchema } from "./shared";

export const contentCredentialAvailable = os.handler(hasContentCredentialTool);

export const savedContentCredential = os
  .input(IdSchema)
  .handler(({ input }) => readSavedContentCredential(input.id));

export const verifyContentCredential = os
  .input(IdSchema)
  .handler(({ input }) => verifyPhotoContentCredential(input.id));

export const contentCredentialCurrent = os
  .input(IdSchema.extend({ stamp: z.string().length(64) }))
  .handler(({ input }) => isContentCredentialCurrent(input.id, input.stamp));
