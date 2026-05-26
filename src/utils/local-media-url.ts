export function toLocalMediaUrl(filePath: string | null | undefined): string {
  if (!filePath) {
    return "";
  }
  const encoded = filePath
    .replace(/\\/g, "/")
    .split("/")
    .map((s) => encodeURIComponent(s))
    .join("/");
  return `local-media://${encoded}`;
}
