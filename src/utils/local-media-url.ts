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

export function preloadImage(filePath: string | null | undefined): void {
  if (!filePath) return;
  const img = new Image();
  img.src = toLocalMediaUrl(filePath);
}
