import { ORPCError } from "@orpc/server";
import { RPCHandler } from "@orpc/server/message-port";
import type { MessagePortMain } from "electron";
import { router } from "./router";

const pendingRequests = new Set<Promise<unknown>>();
let directoryRequest = false;

async function drainRequests() {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.allSettled(pendingRequests).then(() => true),
      new Promise<boolean>((resolve) => {
        timeout = setTimeout(() => resolve(false), 2000);
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

export const rpcHandler: RPCHandler<Record<never, never>> = new RPCHandler(
  router,
  {
    clientInterceptors: [
      async ({ path, next }) => {
        if (path[0] === "settings" && path[1] === "setDataPath") {
          if (directoryRequest) {
            return { error: "busy", ok: false };
          }
          directoryRequest = true;
          try {
            return (await drainRequests())
              ? await next()
              : { error: "busy", ok: false };
          } finally {
            directoryRequest = false;
          }
        }
        if (directoryRequest) {
          throw new ORPCError("SERVICE_UNAVAILABLE", {
            message: "Library directory is changing",
          });
        }
        const request = next();
        pendingRequests.add(request);
        try {
          return await request;
        } finally {
          pendingRequests.delete(request);
        }
      },
    ],
  }
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
