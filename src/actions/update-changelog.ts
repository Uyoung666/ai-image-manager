import { ipc } from "@/ipc/manager";

export interface UpdateWelcomeResult {
  version: string | null;
}

export function consumeUpdateWelcome(): Promise<UpdateWelcomeResult> {
  return ipc.client.app.consumeUpdateWelcome({});
}
