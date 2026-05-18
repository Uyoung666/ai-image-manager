import { loadModel } from "./model-loader";
import { embeddingModel } from "./state";

export async function embedText(text: string): Promise<number[]> {
  await loadModel();
  if (!embeddingModel) {
    throw new Error("[AI] embedText: model not loaded");
  }
  return embeddingModel.embedText(text);
}
