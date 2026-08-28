import { ORPCError, os } from "@orpc/server";
import { z } from "zod";
import {
  commitMainLocaleSelection,
  getMainLocalizationState,
  initializeMainLocalization,
  listMainLocalizationOptions,
  prepareMainLocaleSelection,
  previewMainLocaleSelection,
  restoreMainLocalePreview,
  revalidateMainLocalization,
  setMainLocaleSelection,
} from "@/localization/main-runtime";

const localeSchema = z.string().trim().min(1).max(64);
const providerSchema = z.string().trim().min(1).max(160).nullable().optional();

function rethrowLocaleError(error: unknown): never {
  const message = error instanceof Error ? error.message : String(error);
  throw new ORPCError("BAD_REQUEST", {
    data: { localizationCode: "invalid-selection" },
    message: message.slice(0, 240),
  });
}

async function runLocaleOperation<T>(
  operation: () => T | PromiseLike<T>
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    rethrowLocaleError(error);
  }
}

export const initialize = os
  .input(z.object({ legacyLocale: localeSchema.optional() }).strict())
  .handler(({ input }) =>
    runLocaleOperation(() => initializeMainLocalization(input.legacyLocale))
  );

export const getState = os
  .input(z.object({ legacyLocale: localeSchema.optional() }).strict())
  .handler(({ input }) =>
    runLocaleOperation(() => getMainLocalizationState(input.legacyLocale))
  );

export const listOptions = os.handler(() =>
  runLocaleOperation(() => listMainLocalizationOptions())
);

export const revalidate = os.handler(() =>
  runLocaleOperation(() => revalidateMainLocalization())
);

export const prepare = os
  .input(
    z
      .object({ locale: localeSchema, providerPluginId: providerSchema })
      .strict()
  )
  .handler(({ input }) =>
    runLocaleOperation(() => prepareMainLocaleSelection(input))
  );

export const commit = os
  .input(z.object({ token: z.string().min(1).max(128) }).strict())
  .handler(({ input }) =>
    runLocaleOperation(() => commitMainLocaleSelection(input))
  );

export const select = os
  .input(
    z
      .object({ locale: localeSchema, providerPluginId: providerSchema })
      .strict()
  )
  .handler(({ input }) =>
    runLocaleOperation(() => setMainLocaleSelection(input))
  );

export const preview = os
  .input(
    z
      .object({ locale: localeSchema, providerPluginId: providerSchema })
      .strict()
  )
  .handler(({ input }) =>
    runLocaleOperation(() => previewMainLocaleSelection(input))
  );

export const restorePreview = os.handler(() =>
  runLocaleOperation(() => restoreMainLocalePreview())
);
