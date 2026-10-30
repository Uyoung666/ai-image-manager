export const CULL_WRITE_STATE = "cull-write-state";
export interface CullWriteState {
  scopeId: number | string;
  state: "saving" | "saved" | "error";
}

/** Report actual IPC acknowledgements, including writes made from result views. */
export async function trackCullWrite<T>(
  scopeId: number | string,
  write: () => Promise<T>
): Promise<T> {
  const report = (state: CullWriteState["state"]) =>
    window.dispatchEvent(
      new CustomEvent<CullWriteState>(CULL_WRITE_STATE, {
        detail: { scopeId, state },
      })
    );
  report("saving");
  try {
    const result = await write();
    report("saved");
    return result;
  } catch (error) {
    report("error");
    throw error;
  }
}
