import { ipc } from "@/ipc/manager";

export function openExternalLink(url: string): Promise<void> {
  return ipc.client.shell.openExternalLink({ url });
}
