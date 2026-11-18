import path from "node:path";

const TEST_RUNTIME_DIRECTORY = /(^|[/\\])\.(cache|test-runtime)([/\\]|$)/;
const GENERATED_ROOT_DIRECTORIES = new Set(["reports", "out", ".face-dev"]);

export function createDevWatchIgnored(root: string) {
  return (file: string): boolean => {
    const relative = path.relative(root, file.replaceAll("\\", "/"));
    return (
      TEST_RUNTIME_DIRECTORY.test(relative) ||
      GENERATED_ROOT_DIRECTORIES.has(relative.split(path.sep)[0])
    );
  };
}
