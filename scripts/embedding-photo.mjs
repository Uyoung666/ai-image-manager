/** Decode failures are per-photo errors even when inference uses DirectML. */
export async function processEmbeddingPhoto(
  id,
  { prepare, infer, normalize, provider }
) {
  let stage = "decode";
  try {
    const input = await prepare();
    stage = "inference";
    const output = await infer(input);
    stage = "normalization";
    return { id, vector: normalize(output) };
  } catch (error) {
    return {
      id,
      stage,
      error: error instanceof Error ? error.message : String(error),
      errorCode:
        stage === "decode" ? "IMAGE_DECODE_FAILED" : "IMAGE_INFERENCE_FAILED",
      providerError: stage === "inference" && provider === "directml",
    };
  }
}
