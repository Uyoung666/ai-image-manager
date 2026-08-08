import { Info } from "lucide-react";
import { useTranslation } from "react-i18next";

type SearchSensitivity = "relaxed" | "standard" | "precise";
type SearchIntent = "object" | "scene" | "composed" | "unknown";

export interface SemanticSearchDiagnosticsProps {
  candidateMinimum?: number;
  cutoffReason?: string;
  finalCutoff?: number;
  intent?: SearchIntent;
  rejectedWeak?: number;
  sensitivity?: SearchSensitivity;
  sensitivityMultiplier?: number;
  topSimilarity?: number;
  used?: boolean;
}

const SENSITIVITY_LABEL_KEYS: Record<SearchSensitivity, string> = {
  precise: "searchSensitivityPrecise",
  relaxed: "searchSensitivityRelaxed",
  standard: "searchSensitivityStandard",
};

const INTENT_LABEL_KEYS: Record<SearchIntent, string> = {
  composed: "semanticSearchIntentComposed",
  object: "semanticSearchIntentObject",
  scene: "semanticSearchIntentScene",
  unknown: "semanticSearchIntentUnknown",
};

const CUTOFF_REASON_LABEL_KEYS: Record<string, string> = {
  "intent-floor": "semanticSearchCutoffReasonIntentFloor",
  legacy: "semanticSearchCutoffReasonLegacy",
  "relative-to-top": "semanticSearchCutoffReasonRelativeToTop",
  "score-gap": "semanticSearchCutoffReasonScoreGap",
};

function formatScore(value: number | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return "—";
  }
  return value.toFixed(4);
}

export function SemanticSearchDiagnostics({
  candidateMinimum,
  cutoffReason,
  finalCutoff,
  intent = "unknown",
  rejectedWeak = 0,
  sensitivity = "standard",
  sensitivityMultiplier = 1,
  topSimilarity,
  used = false,
}: SemanticSearchDiagnosticsProps) {
  const { t } = useTranslation();

  if (!used) {
    return null;
  }

  const cutoffReasonKey = cutoffReason
    ? CUTOFF_REASON_LABEL_KEYS[cutoffReason]
    : undefined;

  return (
    <details className="group relative flex h-7 w-5 flex-shrink-0 items-center justify-center text-muted-foreground/45">
      <summary
        aria-label={t("semanticSearchDiagnosticsTitle")}
        className="flex h-6 w-5 cursor-pointer list-none items-center justify-center rounded text-muted-foreground/45 outline-none transition-colors hover:bg-foreground/5 hover:text-muted-foreground focus-visible:ring-1 focus-visible:ring-ring [&::-webkit-details-marker]:hidden"
        title={t("semanticSearchDiagnosticsTitle")}
      >
        <Info className="h-3.5 w-3.5" />
      </summary>
      <div className="absolute top-full right-0 z-50 mt-1 w-[min(360px,calc(100vw-2rem))] rounded-md border border-border bg-popover p-3 text-[11px] text-muted-foreground shadow-lg">
        <div className="mb-2 font-medium text-foreground">
          {t("semanticSearchDiagnosticsTitle")}
        </div>
        <div className="grid grid-cols-2 gap-x-4 gap-y-1 sm:grid-cols-3">
          <span>
            {t("semanticSearchDiagnosticsSensitivity")}:{" "}
            {t(SENSITIVITY_LABEL_KEYS[sensitivity])} ×{" "}
            {sensitivityMultiplier.toFixed(1)}
          </span>
          <span>
            {t("semanticSearchDiagnosticsIntent")}:{" "}
            {t(INTENT_LABEL_KEYS[intent])}
          </span>
          <span>
            {t("semanticSearchDiagnosticsTopScore")}:{" "}
            {formatScore(topSimilarity)}
          </span>
          <span>
            {t("semanticSearchDiagnosticsCutoff")}: {formatScore(finalCutoff)}
            {cutoffReasonKey ? ` (${t(cutoffReasonKey)})` : ""}
          </span>
          <span>
            {t("semanticSearchDiagnosticsCandidateFloor")}:{" "}
            {formatScore(candidateMinimum)}
          </span>
          <span>
            {t("semanticSearchDiagnosticsRejected")}: {rejectedWeak}
          </span>
        </div>
        <div className="mt-2 text-[10px] text-muted-foreground/80">
          {t("semanticSearchDiagnosticsRawScoreHint")}
        </div>
      </div>
    </details>
  );
}
