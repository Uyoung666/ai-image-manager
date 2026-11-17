import { ipc } from "@/ipc/manager";
import type { LibraryDirectoryInput } from "@/types/library-directory";

export function getLibraryDirectoryInfo() {
  return ipc.client.settings.getDataPathInfo({});
}

export function chooseLibraryDirectory(title: string) {
  return ipc.client.settings.chooseDataPath({ title });
}

export function changeLibraryDirectory(input: LibraryDirectoryInput) {
  return ipc.client.settings.setDataPath(input);
}
