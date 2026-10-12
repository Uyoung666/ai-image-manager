import { randomUUID } from "node:crypto";
import path from "node:path";

const EXPORT_NAME_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/** Keep package CJS/native loading in Electron's loader, outside Vite SSR. */
export function createNativeModuleBridge() {
  const key = `searchBenchmarkModules_${randomUUID().replaceAll("-", "")}`;
  const registry = new Map();
  const prefix = "\0search-native:";
  globalThis[key] = registry;
  return {
    name: "search-benchmark-native-packages",
    enforce: "pre",
    resolveId(id) {
      if (
        id === "electron" ||
        id.startsWith("@/") ||
        id.startsWith(".") ||
        id.startsWith("\0") ||
        id.startsWith("node:") ||
        path.isAbsolute(id)
      ) {
        return null;
      }
      return prefix + id;
    },
    async load(id) {
      if (!id.startsWith(prefix)) {
        return null;
      }
      const specifier = id.slice(prefix.length);
      const namespace = await import(specifier);
      registry.set(specifier, namespace);
      const exports = Object.keys(namespace)
        .filter((name) => name !== "default" && EXPORT_NAME_RE.test(name))
        .map(
          (name) => `export const ${name}=namespace[${JSON.stringify(name)}];`
        )
        .join("\n");
      return `const namespace=globalThis[${JSON.stringify(key)}].get(${JSON.stringify(specifier)});export default namespace.default??namespace;${exports}`;
    },
    closeBundle() {
      delete globalThis[key];
    },
  };
}
