import { RPCHandler } from "@orpc/server/message-port";
import type { MessagePortMain } from "electron";
import { router } from "./router";

export const rpcHandler: RPCHandler<Record<never, never>> = new RPCHandler(
  router
);

export function upgradeRpcPort(port: MessagePortMain): boolean {
  if (
    !port ||
    typeof port.start !== "function" ||
    typeof port.postMessage !== "function"
  ) {
    return false;
  }

  rpcHandler.upgrade(port);
  port.start();
  return true;
}
