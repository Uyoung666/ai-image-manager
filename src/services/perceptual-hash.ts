import sharp from "sharp";

function dct1D(input: Float64Array): Float64Array {
  const N = input.length;
  const output = new Float64Array(N);
  const piOver2N = Math.PI / (2 * N);
  for (let k = 0; k < N; k++) {
    let sum = 0;
    for (let n = 0; n < N; n++) {
      sum += input[n] * Math.cos((2 * n + 1) * k * piOver2N);
    }
    output[k] = sum;
  }
  return output;
}

function dct2D(matrix: Float64Array[], size: number): Float64Array[] {
  // DCT on rows
  const rowTransformed: Float64Array[] = [];
  for (let i = 0; i < size; i++) {
    rowTransformed.push(dct1D(matrix[i]));
  }
  // DCT on columns
  const result: Float64Array[] = Array.from(
    { length: size },
    () => new Float64Array(size)
  );
  for (let j = 0; j < size; j++) {
    const col = new Float64Array(size);
    for (let i = 0; i < size; i++) {
      col[i] = rowTransformed[i][j];
    }
    const colDct = dct1D(col);
    for (let i = 0; i < size; i++) {
      result[i][j] = colDct[i];
    }
  }
  return result;
}

export async function computePHash(
  input: string | Buffer
): Promise<string | null> {
  try {
    const SIZE = 32;
    const { data } = await sharp(input)
      .rotate()
      .resize(SIZE, SIZE, { fit: "fill" })
      .grayscale()
      .raw()
      .toBuffer({ resolveWithObject: true });

    const pixels = new Uint8Array(data);

    // Build 32×32 float matrix
    const matrix: Float64Array[] = [];
    for (let i = 0; i < SIZE; i++) {
      const row = new Float64Array(SIZE);
      for (let j = 0; j < SIZE; j++) {
        row[j] = pixels[i * SIZE + j];
      }
      matrix.push(row);
    }

    // 2D DCT
    const dct = dct2D(matrix, SIZE);

    // Extract top-left 8×8 (lowest frequency coefficients, excluding DC at [0][0])
    const lowFreq: number[] = [];
    for (let i = 0; i < 8; i++) {
      for (let j = 0; j < 8; j++) {
        if (i === 0 && j === 0) {
          continue; // skip DC component
        }
        lowFreq.push(dct[i][j]);
      }
    }

    // Median threshold
    const sorted = [...lowFreq].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];

    // 64-bit hash (63 values from 8×8 minus DC = 63, pad to 64)
    let hash = 0n;
    for (let i = 0; i < lowFreq.length; i++) {
      if (lowFreq[i] > median) {
        hash += 2n ** BigInt(i);
      }
    }

    return hash.toString(16).padStart(16, "0");
  } catch {
    return null;
  }
}
