import path from "node:path";
import dotenv from "dotenv";
import { app } from "electron";
import { z } from "zod";

// 在开发环境加载 .env 文件
if (!app.isPackaged) {
  dotenv.config({ path: path.join(app.getAppPath(), ".env") });
}

const envSchema = z.object({
  HF_MIRROR: z.string().url().optional(),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
  NODE_ENV: z.enum(["development", "production", "test"]).default("production"),
  WORKER_POOL_SIZE: z.coerce.number().int().min(2).max(8).default(4),
  WORKER_TIMEOUT: z.coerce.number().int().positive().default(300_000),
});

export type AppConfig = z.infer<typeof envSchema>;

let config: AppConfig | null = null;

/**
 * 加载并验证环境配置
 * @returns 验证后的配置对象
 * @throws 如果配置验证失败
 */
export function loadConfig(): AppConfig {
  if (config) {
    return config;
  }

  const result = envSchema.safeParse(process.env);

  if (!result.success) {
    console.error("Invalid environment configuration:", result.error.format());
    throw new Error("Configuration validation failed");
  }

  config = result.data;
  return config;
}

/**
 * 获取当前配置（如果未加载则自动加载）
 * @returns 配置对象
 */
export function getConfig(): AppConfig {
  if (!config) {
    return loadConfig();
  }
  return config;
}
