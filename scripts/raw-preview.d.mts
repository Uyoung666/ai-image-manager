export function buildExiftoolArgFile(tag: string, filePath: string): Buffer;

export function extractRawPreview(
  filePath: string,
  runExiftool?: (
    executable: string,
    args: readonly string[],
    options: {
      input: Buffer;
      maxBuffer: number;
      timeout: number;
    }
  ) => Buffer
): Buffer | null;
