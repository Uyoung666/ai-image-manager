/** Match production interactive inference: each text is a fixed single row. */
export function encodeTraceTexts(model, texts) {
  const pending = new Map();
  for (const text of texts) {
    if (!pending.has(text)) {
      pending.set(
        text,
        (async () => {
          const vectors = model.embedTexts
            ? await model.embedTexts([text])
            : [await model.embedText(text)];
          if (
            vectors.length !== 1 ||
            !vectors[0]?.length ||
            !vectors[0].every(Number.isFinite) ||
            !vectors[0].some((value) => value !== 0)
          ) {
            throw new Error("Invalid single-text quality trace vector");
          }
          return vectors[0];
        })()
      );
    }
  }
  return Promise.all(texts.map((text) => pending.get(text)));
}
