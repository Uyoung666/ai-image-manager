import { ipc } from "@/ipc/manager";

export function openExternalLink(url: string): Promise<void> {
  return ipc.client.shell.openExternalLink({ url });
}

export function openInExplorer(path: string): Promise<void> {
  return ipc.client.shell.openInExplorer({ path });
}
