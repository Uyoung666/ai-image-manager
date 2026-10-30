import { act, renderHook, waitFor } from "@testing-library/react";
import { expect, it } from "vitest";
import { useCullSaveStatus } from "@/hooks/use-cull-save-status";
import { trackCullWrite } from "@/utils/cull-write-state";

it("waits for IPC acknowledgement and keeps a failed concurrent write visible", async () => {
  const { result } = renderHook(() => useCullSaveStatus([1]));
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  let success!: Promise<void>;
  let failure!: Promise<unknown>;
  act(() => {
    success = trackCullWrite(
      1,
      () =>
        new Promise<void>((done) => {
          resolve = done;
        })
    );
    failure = trackCullWrite(
      1,
      () =>
        new Promise<void>((_done, fail) => {
          reject = fail;
        })
    ).catch(() => undefined);
  });
  expect(result.current).toBe("saving");
  await act(async () => {
    reject(new Error("write failed"));
    await failure;
    resolve();
    await success;
  });
  expect(result.current).toBe("error");
  await act(async () => {
    await trackCullWrite(2, () => Promise.resolve());
  });
  expect(result.current).toBe("error");
  await act(async () => {
    await trackCullWrite(1, () => Promise.resolve());
  });
  await waitFor(() => expect(result.current).toBe("saved"));
});
