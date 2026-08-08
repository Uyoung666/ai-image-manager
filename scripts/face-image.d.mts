export interface NormalizedFaceImage {
  data: Uint8Array;
  height: number;
  width: number;
}

export interface YuNetBox {
  h: number;
  w: number;
  x1: number;
  y1: number;
}

export function normalizeImageInput(
  input: string | Buffer,
  originalPath: string | Buffer
): Promise<NormalizedFaceImage>;

export function mapYuNetBoxToImage(
  box: YuNetBox,
  imageWidth: number,
  imageHeight: number,
  inputSize: number
): { height: number; width: number; x: number; y: number } | null;
