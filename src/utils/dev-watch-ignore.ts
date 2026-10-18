import path from "node:path";

const TEST_RUNTIME_DIRECTORY = /(^|[/\\])\.(cache|test-runtime)([/\\]|$)/;
const GENERATED_ROOT_DIRECTORIES = new Set(["reports", "out", ".face-dev"]);

export function createDevWatchIgnored(root: string) {
  return (file: string): boolean =>
    TEST_RUNTIME_DIRECTORY.test(file) ||
    GENERATED_ROOT_DIRECTORIES.has(
      path.relative(root, file.replaceAll("\\", "/")).split(path.sep)[0]
    );
}
