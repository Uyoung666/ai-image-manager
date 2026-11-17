import path from "node:path";

interface StartupProfileOptions {
  appPath: string;
  e2ePath?: string;
  isE2E: boolean;
  isPackaged: boolean;
  overridePath?: string;
}

export function resolveStartupProfile({
  appPath,
  e2ePath,
  isE2E,
  isPackaged,
  overridePath,
}: StartupProfileOptions): string | undefined {
  const explicitPath = e2ePath || overridePath;
  if (explicitPath) {
    return path.resolve(explicitPath);
  }
  if (!(isPackaged || isE2E)) {
    const root = path.resolve(appPath);
    return path.join(path.dirname(root), `${path.basename(root)}-dev-data`);
  }
}
