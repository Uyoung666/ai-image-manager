import fs from "node:fs";
import path from "node:path";
import { getDataPath } from "@/utils/data-path";
import { createLogger } from "@/utils/logger";
import {
  CHAR_DECOMPOSE,
  type DictCategory,
  type DictEntry,
  ZH_TO_EN_SEARCH,
} from "./ai/zh-en-dict";

const log = createLogger("dictionary-manager");

export interface CustomDictEntry extends DictEntry {
  createdAt?: number;
  note?: string;
  priority?: number;
  updatedAt?: number;
}

export interface CustomDictionaryData {
  disabled?: string[];
  entries: Record<string, CustomDictEntry>;
  overrides?: Record<string, CustomDictEntry>;
  version: string;
}

/**
 * 词典管理器 - 支持用户自定义词典
 *
 * 优先级：禁用 > 覆盖 > 自定义 > 内置
 */
export class DictionaryManager {
  private customDict: CustomDictionaryData | null = null;
  private readonly mergedCache: Map<string, DictEntry> = new Map();
  private readonly customDictPath: string;

  constructor() {
    this.customDictPath = path.join(
      getDataPath(),
      "dictionaries",
      "user-custom.json"
    );
    this.loadCustomDict();
    this.rebuildCache();
  }

  /**
   * 加载用户自定义词典
   */
  private loadCustomDict(): void {
    try {
      if (fs.existsSync(this.customDictPath)) {
        const content = fs.readFileSync(this.customDictPath, "utf-8");
        this.customDict = JSON.parse(content);
        log.info(
          {
            custom: Object.keys(this.customDict?.entries || {}).length,
            overrides: Object.keys(this.customDict?.overrides || {}).length,
            disabled: this.customDict?.disabled?.length || 0,
          },
          "Custom dictionary loaded"
        );
      }
    } catch (err: unknown) {
      log.error({ err }, "Failed to load custom dictionary");
    }
  }

  /**
   * 重建合并缓存
   */
  private rebuildCache(): void {
    this.mergedCache.clear();

    // 1. 添加内置词典
    for (const [zh, entry] of Object.entries(ZH_TO_EN_SEARCH)) {
      this.mergedCache.set(zh, entry);
    }

    // 2. 应用用户禁用
    if (this.customDict?.disabled) {
      for (const zh of this.customDict.disabled) {
        this.mergedCache.delete(zh);
      }
    }

    // 3. 应用用户覆盖
    if (this.customDict?.overrides) {
      for (const [zh, entry] of Object.entries(this.customDict.overrides)) {
        this.mergedCache.set(zh, entry);
      }
    }

    // 4. 添加用户自定义
    if (this.customDict?.entries) {
      for (const [zh, entry] of Object.entries(this.customDict.entries)) {
        this.mergedCache.set(zh, entry);
      }
    }

    log.info({ total: this.mergedCache.size }, "Dictionary cache rebuilt");
  }

  /**
   * 获取合并后的词典
   */
  getMergedDictionary(): Record<string, DictEntry> {
    return Object.fromEntries(this.mergedCache);
  }

  /**
   * 获取字符分解词典
   */
  getCharDecompose(): Record<string, { en: string; category: DictCategory }> {
    return CHAR_DECOMPOSE;
  }

  /**
   * 添加自定义词条
   */
  async addCustomEntry(zh: string, entry: CustomDictEntry): Promise<void> {
    if (!this.customDict) {
      this.customDict = { version: "1.0.0", entries: {} };
    }

    this.customDict.entries[zh] = {
      ...entry,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    await this.saveCustomDict();
    this.rebuildCache();

    log.info({ zh, entry }, "Custom entry added");
  }

  /**
   * 更新自定义词条
   */
  async updateCustomEntry(
    zh: string,
    entry: Partial<CustomDictEntry>
  ): Promise<void> {
    if (!this.customDict?.entries[zh]) {
      throw new Error(`Entry "${zh}" not found in custom dictionary`);
    }

    this.customDict.entries[zh] = {
      ...this.customDict.entries[zh],
      ...entry,
      updatedAt: Date.now(),
    };

    await this.saveCustomDict();
    this.rebuildCache();

    log.info({ zh }, "Custom entry updated");
  }

  /**
   * 删除自定义词条
   */
  async deleteCustomEntry(zh: string): Promise<void> {
    if (!this.customDict?.entries[zh]) {
      throw new Error(`Entry "${zh}" not found in custom dictionary`);
    }

    delete this.customDict.entries[zh];

    await this.saveCustomDict();
    this.rebuildCache();

    log.info({ zh }, "Custom entry deleted");
  }

  /**
   * 覆盖内置词条
   */
  async overrideBuiltinEntry(
    zh: string,
    entry: CustomDictEntry
  ): Promise<void> {
    if (!this.customDict) {
      this.customDict = { version: "1.0.0", entries: {}, overrides: {} };
    }

    if (!this.customDict.overrides) {
      this.customDict.overrides = {};
    }

    this.customDict.overrides[zh] = {
      ...entry,
      updatedAt: Date.now(),
    };

    await this.saveCustomDict();
    this.rebuildCache();

    log.info({ zh }, "Builtin entry overridden");
  }

  /**
   * 禁用内置词条
   */
  async disableBuiltinEntry(zh: string): Promise<void> {
    if (!this.customDict) {
      this.customDict = { version: "1.0.0", entries: {}, disabled: [] };
    }

    if (!this.customDict.disabled) {
      this.customDict.disabled = [];
    }

    if (!this.customDict.disabled.includes(zh)) {
      this.customDict.disabled.push(zh);
    }

    await this.saveCustomDict();
    this.rebuildCache();

    log.info({ zh }, "Builtin entry disabled");
  }

  /**
   * 启用内置词条
   */
  async enableBuiltinEntry(zh: string): Promise<void> {
    if (!this.customDict?.disabled) {
      return;
    }

    this.customDict.disabled = this.customDict.disabled.filter(
      (item) => item !== zh
    );

    await this.saveCustomDict();
    this.rebuildCache();

    log.info({ zh }, "Builtin entry enabled");
  }

  /**
   * 保存自定义词典
   */
  private saveCustomDict(): void {
    const dir = path.dirname(this.customDictPath);

    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    fs.writeFileSync(
      this.customDictPath,
      JSON.stringify(this.customDict, null, 2),
      "utf-8"
    );
    log.info({ path: this.customDictPath }, "Custom dictionary saved");
  }

  /**
   * 导出自定义词典
   */
  exportCustomDict(): string {
    return JSON.stringify(this.customDict, null, 2);
  }

  /**
   * 导入自定义词典
   */
  async importCustomDict(
    jsonData: string
  ): Promise<{ added: number; updated: number; errors: string[] }> {
    const imported = JSON.parse(jsonData) as CustomDictionaryData;
    const result = { added: 0, updated: 0, errors: [] as string[] };

    if (!this.customDict) {
      this.customDict = { version: "1.0.0", entries: {} };
    }

    for (const [zh, entry] of Object.entries(imported.entries || {})) {
      try {
        if (this.customDict.entries[zh]) {
          this.customDict.entries[zh] = { ...entry, updatedAt: Date.now() };
          result.updated++;
        } else {
          this.customDict.entries[zh] = {
            ...entry,
            createdAt: Date.now(),
            updatedAt: Date.now(),
          };
          result.added++;
        }
      } catch (err: unknown) {
        result.errors.push(
          `${zh}: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }

    await this.saveCustomDict();
    this.rebuildCache();

    log.info(result, "Custom dictionary imported");

    return result;
  }

  /**
   * 搜索词条
   */
  searchEntries(
    query: string,
    limit = 50
  ): Array<{
    zh: string;
    entry: DictEntry;
    source: "builtin" | "custom" | "override";
  }> {
    const results: Array<{
      zh: string;
      entry: DictEntry;
      source: "builtin" | "custom" | "override";
    }> = [];
    const lowerQuery = query.toLowerCase();

    for (const [zh, entry] of this.mergedCache) {
      if (zh.includes(query) || entry.en.toLowerCase().includes(lowerQuery)) {
        let source: "builtin" | "custom" | "override" = "builtin";

        if (this.customDict?.entries[zh]) {
          source = "custom";
        } else if (this.customDict?.overrides?.[zh]) {
          source = "override";
        }

        results.push({ zh, entry, source });
        if (results.length >= limit) {
          break;
        }
      }
    }

    return results;
  }

  /**
   * 获取统计信息
   */
  getStats(): {
    builtin: number;
    custom: number;
    overrides: number;
    disabled: number;
    total: number;
  } {
    return {
      builtin: Object.keys(ZH_TO_EN_SEARCH).length,
      custom: this.customDict ? Object.keys(this.customDict.entries).length : 0,
      overrides: this.customDict?.overrides
        ? Object.keys(this.customDict.overrides).length
        : 0,
      disabled: this.customDict?.disabled ? this.customDict.disabled.length : 0,
      total: this.mergedCache.size,
    };
  }
}

// 单例
let managerInstance: DictionaryManager | null = null;

export function getDictionaryManager(): DictionaryManager {
  if (!managerInstance) {
    managerInstance = new DictionaryManager();
  }
  return managerInstance;
}
