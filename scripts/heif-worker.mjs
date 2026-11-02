import { parentPort } from "node:worker_threads";
import { decodeHeif } from "./heif-decoder.mjs";

process.on("disconnect", () => process.exit(0));
const channel = parentPort ?? process;
const send = (message) =>
  parentPort ? parentPort.postMessage(message) : process.send?.(message);
channel.on("message", async ({ input, options }) => {
  try {
    send({ result: await decodeHeif(input, options) });
  } catch (error) {
    send({
      error: error instanceof Error ? error.message : String(error),
    });
  }
});
