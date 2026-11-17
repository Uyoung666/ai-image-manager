export type LibraryDirectoryMode = "create" | "open" | "migrate";

export type LibraryDirectoryInput =
  | { mode: "create" | "open"; newPath: string }
  | { cleanupSource?: boolean; mode: "migrate"; newPath: string };

export type LibraryDirectoryError =
  | "busy"
  | "invalidPath"
  | "nestedPath"
  | "notEmpty"
  | "notLibrary"
  | "unavailable"
  | "stopFailed"
  | "copyFailed"
  | "startFailed"
  | "saveFailed"
  | "restoreFailed";

export type LibraryDirectoryResult =
  | {
      alreadyOpen?: boolean;
      cleaned: number;
      cleanupErrors?: string[];
      copied: number;
      ok: true;
      path: string;
    }
  | { cleanupErrors?: string[]; error: LibraryDirectoryError; ok: false };

export type LibraryDirectoryProgress =
  | { phase: "stopping-services" | "starting-services" | "cleaning" }
  | { phase: "copying"; dir: string; index: number; total: number };
