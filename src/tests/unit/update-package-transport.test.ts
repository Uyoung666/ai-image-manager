/** @vitest-environment node */
import { EventEmitter } from "node:events";
import { PassThrough, Readable } from "node:stream";
import { beforeEach, expect, it, vi } from "vitest";
import { fetchUpdatePackage } from "@/services/update-package-transport";

const mocks = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock("electron", () => ({ net: { request: mocks.request } }));
let request: EventEmitter & {
  abort: ReturnType<typeof vi.fn>;
  end: ReturnType<typeof vi.fn>;
  setHeader: ReturnType<typeof vi.fn>;
};
beforeEach(() => {
  request = Object.assign(new EventEmitter(), {
    abort: vi.fn(() => request.emit("close")),
    end: vi.fn(),
    setHeader: vi.fn(),
  });
  mocks.request.mockReturnValue(request);
});
const url = "https://github.com/example/releases/download/v1/pkg";

it("exposes the redirect event without net.fetch's manual redirect rejection", async () => {
  const pending = fetchUpdatePackage(
    url,
    { Range: "bytes=8-" },
    new AbortController().signal
  );
  request.emit(
    "redirect",
    302,
    "GET",
    "https://release-assets.githubusercontent.com/pkg"
  );
  const response = await pending;
  expect(response.status).toBe(302);
  expect(response.headers.get("location")).toBe(
    "https://release-assets.githubusercontent.com/pkg"
  );
  expect(request.abort).toHaveBeenCalledOnce();
  expect(request.setHeader).toHaveBeenCalledWith("Range", "bytes=8-");
});

it("streams response bytes and preserves range headers", async () => {
  const pending = fetchUpdatePackage(url, {}, new AbortController().signal);
  request.emit(
    "response",
    Object.assign(Readable.from([Buffer.from("bytes")]), {
      statusCode: 206,
      headers: { "content-range": "bytes 8-12/13" },
    })
  );
  const response = await pending;
  expect(response.status).toBe(206);
  expect(response.headers.get("content-range")).toBe("bytes 8-12/13");
  expect(await response.text()).toBe("bytes");
});

it("aborts streaming requests when the timeout signal fires", async () => {
  const abort = new AbortController();
  const pending = fetchUpdatePackage(url, {}, abort.signal);
  request.emit(
    "response",
    Object.assign(new PassThrough(), { statusCode: 200, headers: {} })
  );
  const response = await pending;
  const reading = response.text();
  abort.abort();
  await expect(reading).rejects.toThrow("ECONNABORTED");
  expect(request.abort).toHaveBeenCalled();
});

it("rejects a connection error before headers arrive", async () => {
  const pending = fetchUpdatePackage(url, {}, new AbortController().signal);
  request.emit("error", new Error("ECONNRESET"));
  await expect(pending).rejects.toThrow("ECONNRESET");
});

it("keeps waiting when the writable closes before the redirect arrives", async () => {
  const pending = fetchUpdatePackage(url, {}, new AbortController().signal);
  request.emit("close");
  request.emit(
    "redirect",
    302,
    "GET",
    "https://release-assets.githubusercontent.com/pkg"
  );
  expect((await pending).status).toBe(302);
});
