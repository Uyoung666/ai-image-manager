import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { ShootingProjectOutputAmbiguity } from "@/types/shooting-project";
import {
  resolveProjectDirectory,
  SHOOTING_PROJECT_IMAGE_EXTENSIONS,
} from "./shooting-project-files";

type SidecarKind = ShootingProjectOutputAmbiguity["files"][number]["kind"];

interface SidecarMatch {
  ambiguity?: {
    id: string;
    photos: ShootingProjectOutputAmbiguity["photos"];
  };
  kind: SidecarKind;
  originalPath: string;
  relativePath: string;
}

function nameKey(name: string): string {
  return process.platform === "win32" ? name.toLowerCase() : name;
}

function stem(name: string): string {
  return path.basename(name, path.extname(name));
}

function indexOriginals(
  names: string[],
  directory: string,
  selected: Map<string, string>
) {
  const photosByName = new Set<string>();
  const photosByStem = new Map<
    string,
    ShootingProjectOutputAmbiguity["photos"]
  >();
  for (const name of names) {
    if (
      !SHOOTING_PROJECT_IMAGE_EXTENSIONS.has(path.extname(name).toLowerCase())
    ) {
      continue;
    }
    const key = nameKey(name);
    const stemKey = nameKey(stem(name));
    photosByName.add(key);
    const photos = photosByStem.get(stemKey) ?? [];
    photos.push({
      relativePath: path.join(directory, name),
      selected: selected.has(key),
    });
    photosByStem.set(stemKey, photos);
  }
  return { photosByName, photosByStem };
}

export async function findShootingProjectSidecars(
  root: string,
  directory: string,
  selectedNames: string[],
  registeredNames: string[]
): Promise<SidecarMatch[]> {
  const source = await resolveProjectDirectory(root, directory);
  const entries = await fs.readdir(source, { withFileTypes: true });
  const names = entries
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .sort();
  const selected = new Map(selectedNames.map((name) => [nameKey(name), name]));
  const originals = new Map(
    [...registeredNames, ...names].map((name) => [nameKey(name), name])
  );
  const { photosByName, photosByStem } = indexOriginals(
    [...originals.values()].sort(),
    directory,
    selected
  );
  const matches: SidecarMatch[] = [];
  for (const name of names) {
    const extension = path.extname(name).toLowerCase();
    if (extension !== ".xmp" && extension !== ".acr") {
      continue;
    }
    const key = nameKey(stem(name));
    const relativePath = path.join(directory, name);
    const kind = extension === ".xmp" ? "xmp" : "acr";
    if (kind === "xmp" && photosByName.has(key)) {
      const original = selected.get(key);
      if (original) {
        matches.push({
          kind,
          originalPath: path.join(directory, original),
          relativePath,
        });
      }
      continue;
    }
    const photos = photosByStem.get(key);
    const original = photos?.find((photo) => photo.selected);
    if (photos && original) {
      const ambiguity = photos.some((photo) => !photo.selected)
        ? {
            id: createHash("sha256")
              .update(JSON.stringify([nameKey(directory), key]))
              .digest("hex"),
            photos,
          }
        : undefined;
      matches.push({
        ambiguity,
        kind,
        originalPath: original.relativePath,
        relativePath,
      });
    }
  }
  return matches;
}
