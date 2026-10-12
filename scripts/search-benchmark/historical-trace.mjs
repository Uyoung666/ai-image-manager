/** Read-only instrumentation of frozen historical modules; no score changes. */
export function historicalSearchTracePlugin(traceModule) {
  const insert = (source, anchor, payload) => {
    if (source.split(anchor).length !== 2) {
      throw new Error(`Historical trace anchor is not unique: ${anchor}`);
    }
    return source.replace(anchor, payload + anchor);
  };
  return {
    name: "search-historical-live-trace",
    enforce: "pre",
    transform(source, id) {
      const normalized = id.replaceAll("\\", "/");
      if (source.includes("traceSearchQuality")) {
        return null;
      }
      if (normalized.endsWith("/services/ai/semantic-query-plan.ts")) {
        const code =
          `import {traceSearchQuality as __qualityTrace} from ${JSON.stringify(traceModule)};\n` +
          source;
        return {
          code: insert(
            code,
            "const promptCandidates: SemanticQueryPrompt[] = [];",
            '__qualityTrace("translation", () => ({normalizedQuery,negativeTerms,translated,translatedNegatives,dictionary}));\n'
          ),
          map: null,
        };
      }
      if (normalized.endsWith("/ipc/photos/handlers/search.ts")) {
        const rewritten = source.includes("let rewrittenQuery:")
          ? "rewrittenQuery"
          : "null";
        let code =
          `import {traceSearchQuality as __qualityTrace} from ${JSON.stringify(traceModule)};\n` +
          source;
        const rewriteAnchor = source.includes(
          "const filters: PhotoSearchFilters = {"
        )
          ? "const filters: PhotoSearchFilters = {"
          : "    // ── Glob wildcard shortcut";
        code = insert(
          code,
          rewriteAnchor,
          `__qualityTrace("query-rewrite", () => ({query,searchText,rewrittenQuery:${rewritten}}));\n`
        );
        if (source.includes("if (rerankedList.length === 0)")) {
          code = insert(
            code,
            "if (rerankedList.length === 0)",
            '__qualityTrace("hybrid-ranking", () => ({semanticCandidates,exactEvidence,tagEvidence:tagPhotoRows,results:rerankedList,diagnostics:gated?.diagnostics}));\n'
          );
        } else {
          code = insert(
            code,
            "const combined = rerankedList.flatMap(",
            '__qualityTrace("hybrid-ranking", () => ({semanticCandidates,exactEvidence,tagEvidence:allowedTagRows,results:rerankedList,diagnostics:gated?.diagnostics}));\n'
          );
        }
        return { code, map: null };
      }
      if (!normalized.endsWith("/services/ai/search.ts")) {
        return null;
      }
      let code =
        `import {traceSearchQuality as __qualityTrace} from ${JSON.stringify(traceModule)};\n` +
        source;
      code = insert(
        code,
        "return vectors.filter((vector): vector is number[] => vector !== null);",
        '__qualityTrace("text-encoding", () => ({texts,vectors,cacheHits:texts.map((_,index)=>!missing.some(item=>item.index===index)),encoding:"historical-actual"}));\n'
      );
      code = insert(
        code,
        "const parseMs = Date.now() - parseStartedAt;",
        '__qualityTrace("query-plan", () => ({query,plan}));\n'
      );
      code = insert(
        code,
        "const fused = fuseRankedSearchEvidence(",
        '__qualityTrace("candidate-recall", () => ({plan,resultSets,candidateDepth,candidateMinimum,rowCount}));\n'
      );
      code = insert(
        code,
        "const penalized = applyNegativeSemanticPenalty(",
        '__qualityTrace("primary-and-negative-scores", () => ({fused,negativeResultSets}));\n'
      );
      code = insert(
        code,
        "const exhausted = candidateDepth >= rowCount;",
        '__qualityTrace("semantic-selection", () => ({penalized,selection}));\n'
      );
      return { code, map: null };
    },
  };
}
