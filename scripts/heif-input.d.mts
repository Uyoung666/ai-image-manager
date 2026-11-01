import type { ChildProcess } from "node:child_process";
export function createHeifResolver(options?: {
  workerPath?: string;
  useProcess?: boolean;
  track?: (child: ChildProcess) => ChildProcess;
  timeoutMs?: number;
}): {
  resolveInput: (input: string | Buffer) => Promise<string | Buffer>;
  stop: () => void;
};
export function resolveHeifInput(
  input: string | Buffer
): Promise<string | Buffer>;
export function stopHeifDecoder(): void;
