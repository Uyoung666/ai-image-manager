// @vitest-environment node
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { downloadUpdatePackage } from "@/services/update-download";
import { TestRuntime } from "../helpers/test-runtime";

const mocks = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock("electron", () => ({ net: { fetch: mocks.fetch } }));
const bytes = Buffer.from("verified immutable update package");
const info = {
  filename: "test-2.2.4-delta.nupkg",
  size: bytes.length,
  sha1: createHash("sha1").update(bytes).digest("hex"),
  sha256: createHash("sha256").update(bytes).digest("hex"),
  url: "https://github.com/example/releases/download/v2.2.4/test.nupkg",
};
let runtime: TestRuntime;
let destination: string;
beforeEach(() => {
  mocks.fetch.mockReset();
  runtime = new TestRuntime("update-download");
  destination = path.join(runtime.root, info.filename);
});
afterEach(() => {
  vi.useRealTimers();
  runtime.cleanup();
});

describe("production package transport", () => {
  it("reports a stalled connection after fifteen seconds and cancels at the idle deadline", async () => {
    vi.useFakeTimers({
      toFake: [
        "setTimeout",
        "setInterval",
        "clearTimeout",
        "clearInterval",
        "Date",
      ],
    });
    const progress = vi.fn();
    mocks.fetch.mockImplementationOnce(
      (_url, options) =>
        new Promise((_resolve, reject) =>
          options.signal.addEventListener("abort", () =>
            reject(new Error("aborted"))
          )
        )
    );
    mocks.fetch.mockResolvedValueOnce(new Response(bytes));
    const result = downloadUpdatePackage(info, destination, progress);
    await vi.waitFor(() => expect(mocks.fetch).toHaveBeenCalledOnce());
    await vi.advanceTimersByTimeAsync(15_000);
    expect(progress).toHaveBeenCalledWith(
      expect.objectContaining({ networkWaiting: true, bytesPerSecond: 0 })
    );
    await vi.advanceTimersByTimeAsync(105_000);
    expect(progress).toHaveBeenCalledWith(
      expect.objectContaining({ phase: "retry-wait", message: "NETWORK_ERROR" })
    );
    await vi.advanceTimersByTimeAsync(2000);
    await result;
  });

  it("closes a broken response and resumes bytes already flushed to disk", async () => {
    vi.useFakeTimers({
      toFake: [
        "setTimeout",
        "setInterval",
        "clearTimeout",
        "clearInterval",
        "Date",
      ],
    });
    let first = true;
    const body = new ReadableStream(
      {
        pull(controller) {
          if (first) {
            first = false;
            controller.enqueue(bytes.subarray(0, 8));
          } else {
            controller.error(new Error("ECONNRESET"));
          }
        },
      },
      { highWaterMark: 0 }
    );
    mocks.fetch.mockResolvedValueOnce(new Response(body)).mockResolvedValueOnce(
      new Response(bytes.subarray(8), {
        status: 206,
        headers: {
          "content-range": `bytes 8-${bytes.length - 1}/${bytes.length}`,
        },
      })
    );
    const progress = vi.fn();
    const result = downloadUpdatePackage(info, destination, progress);
    await vi.waitFor(() =>
      expect(progress).toHaveBeenCalledWith(
        expect.objectContaining({ phase: "retry-wait" })
      )
    );
    expect(await fs.readFile(`${destination}.download`)).toEqual(
      bytes.subarray(0, 8)
    );
    await vi.advanceTimersByTimeAsync(2000);
    await result;
    expect(mocks.fetch.mock.calls[1][1].headers.Range).toBe("bytes=8-");
  });
  it("reuses a verified complete file without network requests", async () => {
    await fs.writeFile(destination, bytes);
    await downloadUpdatePackage(info, destination, vi.fn());
    expect(mocks.fetch).not.toHaveBeenCalled();
  });
  it("resumes a partial package and verifies the combined hashes", async () => {
    await fs.writeFile(`${destination}.download`, bytes.subarray(0, 8));
    mocks.fetch.mockResolvedValue(
      new Response(bytes.subarray(8), {
        status: 206,
        headers: {
          "content-range": `bytes 8-${bytes.length - 1}/${bytes.length}`,
        },
      })
    );
    await downloadUpdatePackage(info, destination, vi.fn());
    expect(mocks.fetch.mock.calls[0][1].headers.Range).toBe("bytes=8-");
    expect(await fs.readFile(destination)).toEqual(bytes);
  });
  it("restarts safely when the server ignores Range", async () => {
    await fs.writeFile(`${destination}.download`, bytes.subarray(0, 8));
    mocks.fetch.mockResolvedValue(new Response(bytes));
    await downloadUpdatePackage(info, destination, vi.fn());
    expect(await fs.readFile(destination)).toEqual(bytes);
  });
  it("rejects incorrect ranges and redownloads from zero once", async () => {
    await fs.writeFile(`${destination}.download`, bytes.subarray(0, 8));
    mocks.fetch
      .mockResolvedValueOnce(
        new Response(bytes, {
          status: 206,
          headers: {
            "content-range": `bytes 0-${bytes.length - 1}/${bytes.length}`,
          },
        })
      )
      .mockResolvedValueOnce(new Response(bytes));
    await downloadUpdatePackage(info, destination, vi.fn());
    expect(mocks.fetch.mock.calls[1][1].headers.Range).toBeUndefined();
    expect(await fs.readFile(destination)).toEqual(bytes);
  });
  it("cancels the response and closes the file when a disk write fails", async () => {
    const file = await fs.open(`${destination}.download`, "w");
    const close = vi.spyOn(file, "close");
    vi.spyOn(file, "writeFile").mockRejectedValue(new Error("ENOSPC"));
    const open = vi.spyOn(fs, "open").mockResolvedValue(file);
    const cancel = vi.fn();
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(bytes.subarray(0, 8));
      },
      cancel,
    });
    mocks.fetch.mockResolvedValue(new Response(body));
    try {
      await expect(
        downloadUpdatePackage(info, destination, vi.fn())
      ).rejects.toThrow("ENOSPC");
      expect(cancel).toHaveBeenCalledOnce();
      expect(close).toHaveBeenCalledOnce();
      expect(mocks.fetch).toHaveBeenCalledOnce();
    } finally {
      open.mockRestore();
    }
  });
  it("retries a proxy change using a new request to the same asset", async () => {
    vi.useFakeTimers({
      toFake: [
        "setTimeout",
        "setInterval",
        "clearTimeout",
        "clearInterval",
        "Date",
      ],
    });
    mocks.fetch
      .mockRejectedValueOnce(new Error("net::ERR_NETWORK_CHANGED"))
      .mockResolvedValueOnce(new Response(bytes));
    const progress = vi.fn();
    const result = downloadUpdatePackage(info, destination, progress);
    await vi.waitFor(() =>
      expect(progress).toHaveBeenCalledWith(
        expect.objectContaining({ phase: "retry-wait" })
      )
    );
    await vi.advanceTimersByTimeAsync(2000);
    await result;
    expect(mocks.fetch.mock.calls.map(([url]) => url)).toEqual([
      info.url,
      info.url,
    ]);
  });
  it("preserves partial bytes after all four network attempts fail", async () => {
    vi.useFakeTimers({
      toFake: [
        "setTimeout",
        "setInterval",
        "clearTimeout",
        "clearInterval",
        "Date",
      ],
    });
    await fs.writeFile(`${destination}.download`, bytes.subarray(0, 8));
    mocks.fetch.mockRejectedValue(new Error("ECONNRESET"));
    const result = downloadUpdatePackage(info, destination, vi.fn()).catch(
      (error) => error
    );
    for (const count of [1, 2, 3]) {
      await vi.waitFor(() => expect(mocks.fetch).toHaveBeenCalledTimes(count));
      await vi.advanceTimersByTimeAsync([2000, 5000, 15_000][count - 1]);
    }
    expect((await result).message).toBe("ECONNRESET");
    expect(mocks.fetch).toHaveBeenCalledTimes(4);
    expect(await fs.readFile(`${destination}.download`)).toEqual(
      bytes.subarray(0, 8)
    );
  });
  it("honors Retry-After before retrying a rate limit", async () => {
    vi.useFakeTimers({
      toFake: [
        "setTimeout",
        "setInterval",
        "clearTimeout",
        "clearInterval",
        "Date",
      ],
    });
    const progress = vi.fn();
    mocks.fetch
      .mockResolvedValueOnce(
        new Response(null, { status: 429, headers: { "retry-after": "10" } })
      )
      .mockResolvedValueOnce(new Response(bytes));
    const result = downloadUpdatePackage(info, destination, progress);
    await vi.waitFor(() =>
      expect(progress).toHaveBeenCalledWith(
        expect.objectContaining({ phase: "retry-wait" })
      )
    );
    await vi.advanceTimersByTimeAsync(9000);
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1000);
    await result;
  });
  it.each([
    "net::ERR_CERT_AUTHORITY_INVALID",
    "EACCES",
    "ENOSPC",
  ])("does not retry %s", async (message) => {
    mocks.fetch.mockRejectedValue(new Error(message));
    await expect(
      downloadUpdatePackage(info, destination, vi.fn())
    ).rejects.toThrow(message);
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
  });
  it("never accepts an HTTP redirect or a corrupted full file", async () => {
    mocks.fetch.mockResolvedValueOnce(
      Response.redirect("http://unsafe.example/pkg", 302)
    );
    await expect(
      downloadUpdatePackage(info, destination, vi.fn())
    ).rejects.toThrow("UPDATE_TLS_ERROR");
    mocks.fetch.mockImplementation(
      async () => new Response(Buffer.alloc(bytes.length))
    );
    await expect(
      downloadUpdatePackage(info, destination, vi.fn())
    ).rejects.toThrow("UPDATE_PACKAGE_CORRUPT");
    await expect(fs.stat(destination)).rejects.toThrow();
  });
});
