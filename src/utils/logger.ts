import fs from "node:fs";
import path from "node:path";
import { app } from "electron";
import pino from "pino";

const logDir = path.join(app.getPath("userData"), "logs");

// 确保日志目录存在
if (!fs.existsSync(logDir)) {
  fs.mkdirSync(logDir, { recursive: true });
}

// 创建日志文件流
const logFile = path.join(logDir, "main.log");
const errorFile = path.join(logDir, "error.log");

// 简化配置，避免 ES module 兼容性问题
export const logger = pino(
  {
    level: process.env.LOG_LEVEL || "info",
    formatters: {
      level: (label) => {
        return { level: label };
      },
    },
    timestamp: pino.stdTimeFunctions.isoTime,
  },
  pino.destination({
    dest: logFile,
    sync: true,
    mkdir: true,
  })
);

/**
 * 为指定模块创建子日志记录器
 * @param module 模块名称
 * @returns 子日志记录器实例
 */
export function createLogger(module: string) {
  return logger.child({ module });
}
