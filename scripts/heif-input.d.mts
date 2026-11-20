import type { HeifDecodeOptions, HeifDecodeResult } from "./heif-decoder.mjs";
import type { ChildProcess } from "node:child_process";
export interface HeifDecodeRequest {
  priority?: () => number;
  signal?: AbortSignal;
}
export function createHeifResolver(options?: {
  workerPath?: string | (() => string);
  useProcess?: boolean;
  track?: (child: ChildProcess) => ChildProcess;
  timeoutMs?: number;
  onDecode?: (options: HeifDecodeOptions) => void;
}): {
  resolveResult: (
    input: string | Buffer,
    options?: HeifDecodeOptions,
    request?: HeifDecodeRequest
  ) => Promise<HeifDecodeResult | null>;
  resolveInput: (input: string | Buffer) => Promise<string | Buffer>;
  stop: () => void;
};
export function resolveHeifInput(
  input: string | Buffer
): Promise<string | Buffer>;
export function stopHeifDecoder(): void;

export function resolveHeifResult(
  input: string | Buffer,
  options?: HeifDecodeOptions
): Promise<HeifDecodeResult | null>;
