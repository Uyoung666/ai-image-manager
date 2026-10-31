import { Readable } from "node:stream";
import { net } from "electron";

/** A single Chromium request; expose redirects before following any target. */
export function fetchUpdatePackage(
  url: string,
  headers: Record<string, string>,
  signal: AbortSignal
): Promise<Response> {
  return new Promise((resolve, reject) => {
    const request = net.request({ url, redirect: "manual" });
    let settled = false;
    let body: Readable | undefined;
    const fail = (error: Error) => {
      signal.removeEventListener("abort", abort);
      if (settled) {
        body?.destroy(error);
      } else {
        settled = true;
        reject(error);
      }
    };
    const abort = () => {
      fail(new Error("ECONNABORTED"));
      request.abort();
    };
    request.on("error", fail);
    // ClientRequest's Writable 'close' can precede redirects/response headers.
    // It is not proof that the HTTP response has finished.
    request.on("abort", () => signal.removeEventListener("abort", abort));
    request.on("redirect", (status, _method, location) => {
      // net.fetch(..., redirect: "manual") rejects instead of exposing 302.
      // Return the target to the caller's HTTPS/redirect-limit validation.
      settled = true;
      resolve(new Response(null, { status, headers: { location } }));
      request.abort();
    });
    request.on("response", (response) => {
      const responseHeaders = new Headers();
      for (const [key, values] of Object.entries(response.headers)) {
        for (const value of Array.isArray(values) ? values : [values]) {
          responseHeaders.append(key, value);
        }
      }
      // Electron documents IncomingMessage as a Node readable stream, while
      // its declarations expose only the EventEmitter portion of that API.
      const stream = response as unknown as Readable;
      body = stream;
      response.on("end", () => signal.removeEventListener("abort", abort));
      response.on("aborted", () => body?.destroy(new Error("ECONNRESET")));
      stream.once("close", () => request.abort());
      settled = true;
      const noBody = [204, 205, 304].includes(response.statusCode);
      resolve(
        new Response(
          noBody
            ? null
            : (Readable.toWeb(stream, {
                strategy: {
                  highWaterMark: 64 * 1024,
                  size: (chunk: Uint8Array) => chunk.byteLength,
                },
              }) as ReadableStream<Uint8Array>),
          { status: response.statusCode, headers: responseHeaders }
        )
      );
      if (noBody) {
        request.abort();
      }
    });
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) {
      abort();
      return;
    }
    for (const [key, value] of Object.entries(headers)) {
      request.setHeader(key, value);
    }
    request.end();
  });
}
