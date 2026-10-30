import { ipc } from "@/ipc/manager";

export function openFolderDialog(): Promise<{ path: string | null }> {
  return ipc.client.shell.openFolderDialog();
}

export function openExternalLink(url: string): Promise<void> {
  return ipc.client.shell.openExternalLink({ url });
}

export function openInExplorer(path: string): Promise<void> {
  return ipc.client.shell.openInExplorer({ path });
}
