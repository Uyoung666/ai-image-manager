const BENIGN_RENDERER_ERROR_MESSAGES = new Set([
  "ResizeObserver loop completed with undelivered notifications.",
  "ResizeObserver loop limit exceeded",
]);

export function isBenignRendererErrorMessage(message: string): boolean {
  return BENIGN_RENDERER_ERROR_MESSAGES.has(message.trim());
}
