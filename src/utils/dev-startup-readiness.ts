export const DEV_RENDERER_FIRST_FRAME_MARK = "aim:dev-renderer-first-frame";

/** Only the development window handoff uses this mark; it is not home-ready. */
export function scheduleDevRendererFirstFrame(): () => void {
  let secondFrame = 0;
  const firstFrame = requestAnimationFrame(() => {
    secondFrame = requestAnimationFrame(() => {
      if (
        performance.getEntriesByName(DEV_RENDERER_FIRST_FRAME_MARK).length === 0
      ) {
        performance.mark(DEV_RENDERER_FIRST_FRAME_MARK);
      }
    });
  });
  return () => {
    cancelAnimationFrame(firstFrame);
    cancelAnimationFrame(secondFrame);
  };
}
