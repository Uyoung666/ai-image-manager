import { os } from "@orpc/server";
import { z } from "zod";
import { getAllSettings, getSetting, setSetting } from "@/services/settings-manager";

export const getAppSetting = os
  .input(z.object({ key: z.string() }))
  .handler(async ({ input }) => {
    const value = getSetting(input.key);
    if (value === null) return null;
    return { key: input.key, value };
  });

export const setAppSetting = os
  .input(z.object({ key: z.string(), value: z.string() }))
  .handler(async ({ input }) => {
    setSetting(input.key, input.value);
    return { ok: true };
  });

export const getAllAppSettings = os
  .input(z.object({ prefix: z.string().optional() }))
  .handler(async ({ input }) => {
    const settings = getAllSettings(input.prefix);
    return { settings };
  });
