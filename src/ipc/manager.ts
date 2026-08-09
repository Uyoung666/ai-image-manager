import { type ClientContext, createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/message-port";
import type { RouterClient } from "@orpc/server";
import { IPC_CHANNELS } from "@/constants";
import type { router } from "./router";

type RPCClient = RouterClient<typeof router>;

class IPCManager {
  private readonly clientPort: MessagePort;
  private readonly serverPort: MessagePort;

  private readonly rpcLink: RPCLink<ClientContext>;

  private initialized = false;

  readonly client: RPCClient;

  constructor() {
    const { port1: clientChannelPort, port2: serverChannelPort } =
      new MessageChannel();
    this.clientPort = clientChannelPort;
    this.serverPort = serverChannelPort;

    this.rpcLink = new RPCLink({
      port: this.clientPort,
    });
    this.client = createORPCClient(this.rpcLink);
  }

  initialize() {
    if (this.initialized) {
      return;
    }

    this.clientPort.start();

    window.postMessage(IPC_CHANNELS.START_ORPC_SERVER, "*", [this.serverPort]);
    this.initialized = true;
  }
}

export const ipc = new IPCManager();

// Defer initialization: preload must register its message listener first.
function tryInitialize(attempts = 0) {
  if (window.electronAPI?.preloadReady) {
    console.log("[IPC] preloadReady detected, calling initialize");
    ipc.initialize();
  } else if (attempts < 100) {
    setTimeout(() => tryInitialize(attempts + 1), 10);
  } else {
    console.error(
      "[IPC] preloadReady never became available after 1s — oRPC will not work"
    );
  }
}
tryInitialize();
