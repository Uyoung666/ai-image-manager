/** Equivalent, pre-reviewed main translations; diagnostics only. */
export function diagnosticTranslationPlugin(translations) {
  return {
    name: "search-counterfactual-main-translation",
    enforce: "pre",
    transform(source, id) {
      if (
        !id
          .replaceAll("\\", "/")
          .endsWith("/services/ai/semantic-query-plan.ts")
      ) {
        return null;
      }
      const anchor = "translateSafely(normalizedQuery, translate)";
      if (source.split(anchor).length !== 2) {
        throw new Error("Diagnostic translation anchor differs");
      }
      return {
        code:
          `const diagnosticMainTranslations: Record<string,string> = ${JSON.stringify(translations)};\n` +
          source.replace(
            anchor,
            "translateSafely(normalizedQuery, (text) => Promise.resolve(diagnosticMainTranslations[text] ?? translate(text)))"
          ),
        map: null,
      };
    },
  };
}
