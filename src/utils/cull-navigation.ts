/** Keep return destinations local and restricted to the two culling lists. */
export function rememberCullReturn(
  kind: string,
  id: string | number,
  archived: boolean,
  settingsReturn = false
) {
  const archiveDestination = settingsReturn ? "archive-from-cull" : "archive";
  try {
    sessionStorage.setItem(
      `cull.return.${kind}:${id}`,
      archived ? archiveDestination : "list"
    );
  } catch {
    /* Navigation also works without session storage. */
  }
}

export function cullReturnPath(
  kind: string,
  id: string | number
): "/cull" | "/settings/cull-archive" {
  try {
    if (
      sessionStorage.getItem(`cull.return.${kind}:${id}`)?.startsWith("archive")
    ) {
      return "/settings/cull-archive";
    }
  } catch {
    /* Fall back to the normal list. */
  }
  return "/cull";
}

export function cullReturnOptions(kind: string, id: string | number) {
  let cullSettingsReturn = false;
  try {
    cullSettingsReturn =
      sessionStorage.getItem(`cull.return.${kind}:${id}`) ===
      "archive-from-cull";
  } catch {
    /* Fall back to the normal settings entry point. */
  }
  return { to: cullReturnPath(kind, id), state: { cullSettingsReturn } };
}

export function readCullSearch(archived: boolean): string {
  try {
    return sessionStorage.getItem(`cull.search.${archived}`) ?? "";
  } catch {
    return "";
  }
}

export function saveCullSearch(archived: boolean, search: string) {
  try {
    sessionStorage.setItem(`cull.search.${archived}`, search);
  } catch {
    /* Search remains usable without session storage. */
  }
}
