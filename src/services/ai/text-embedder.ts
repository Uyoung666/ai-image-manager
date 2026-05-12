import { embeddingModel } from "./state";
import { loadModel } from "./model-loader";

export async function embedText(text: string): Promise<number[]> {
  await loadModel();
  if (!embeddingModel) {
    throw new Error("[AI] embedText: model not loaded");
  }
  return embeddingModel.embedText(text);
}
