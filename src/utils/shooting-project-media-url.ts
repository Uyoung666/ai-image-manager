import { getHttpPortSync } from "./http-port";

const UUID_PATTERN =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

export function toShootingProjectPreviewUrl(
  projectId: string,
  photoId: string,
  revision: string | number = 1
): string {
  const port = getHttpPortSync();
  if (!(port && UUID_PATTERN.test(projectId) && UUID_PATTERN.test(photoId))) {
    return "";
  }
  const token = window.electronAPI?.httpAuthToken;
  const query = new URLSearchParams({
    projectId,
    photoId,
    v: String(revision),
    token: typeof token === "string" ? token : "",
  });
  return `http://127.0.0.1:${port}/shooting-project-preview?${query}`;
}

export function toShootingProjectOriginalUrl(
  projectId: string,
  photoId: string,
  revision: string | number = 1
): string {
  return toShootingProjectPreviewUrl(projectId, photoId, revision).replace(
    "/shooting-project-preview?",
    "/shooting-project-original?"
  );
}
