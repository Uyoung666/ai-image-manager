export const MAX_HEIF_PIXELS: number;
export function isHeifHeader(bytes: Buffer): boolean;
export function isHeifInput(input: string | Buffer): Promise<boolean>;
export function decodeHeif(input: string | Buffer): Promise<{
  buffer: Buffer;
  width: number;
  height: number;
  originalWidth: number;
  originalHeight: number;
  orientationApplied: true;
}>;
