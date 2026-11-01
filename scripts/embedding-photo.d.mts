export function processEmbeddingPhoto<Input, Output>(
  id: number,
  operations: {
    prepare: () => Promise<Input>;
    infer: (input: Input) => Promise<Output>;
    normalize: (output: Output) => number[];
    provider: string;
  }
): Promise<{
  id: number;
  vector?: number[];
  error?: string;
  errorCode?: string;
  stage?: string;
  providerError?: boolean;
}>;
