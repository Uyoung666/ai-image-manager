import { Component, type ErrorInfo, type ReactNode, useState } from "react";
import { useTranslation } from "react-i18next";
import { recordRendererIncident } from "@/actions/diagnostics";
import { DiagnosticsReportDialog } from "@/components/diagnostics-report-form";

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
}

interface State {
  error: Error | null;
  incidentId?: string;
}

export function ErrorBoundaryMessage({ error }: { error: Error }) {
  const { t } = useTranslation();

  return (
    <>
      <div className="flex h-10 w-10 items-center justify-center rounded-full bg-danger/10">
        <svg
          aria-hidden="true"
          className="h-5 w-5 text-danger"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          viewBox="0 0 24 24"
        >
          <path
            d="M12 9v3.75m9-.75a9 9 0 1 1-18 0 9 9 0 0 1 18 0Zm-9 3.75h.008v.008H12v-.008Z"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </div>
      <div className="min-w-0 max-w-full">
        <p className="font-medium text-[13px] text-foreground">
          {t("errorBoundaryTitle")}
        </p>
        <p className="mt-1 break-words text-[12px] text-muted-foreground">
          {error.message || t("errorUnknown")}
        </p>
      </div>
    </>
  );
}

function ErrorBoundaryInner({
  error,
  incidentId,
  onReset,
}: {
  error: Error;
  incidentId?: string;
  onReset: () => void;
}) {
  const { t } = useTranslation();
  const [showDetails, setShowDetails] = useState(false);
  const [reportOpen, setReportOpen] = useState(false);

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col items-center justify-center gap-3 overflow-y-auto px-4 py-4 text-center sm:px-6">
      <ErrorBoundaryMessage error={error} />
      <p className="text-[12px] text-muted-foreground">{t("errorGeneric")}</p>
      <details
        className="max-h-[min(120px,32dvh)] w-full max-w-[min(500px,100%)] overflow-auto overscroll-contain rounded-[6px] bg-muted/50 p-2 text-left"
        onToggle={(e) => setShowDetails(e.currentTarget.open)}
        open={showDetails}
      >
        <summary className="cursor-pointer text-[11px] text-muted-foreground/70">
          {t("errorShowDetails")}
        </summary>
        <pre className="mt-1 whitespace-pre-wrap break-words font-mono text-[10px] text-muted-foreground">
          {error.message || t("errorUnknown")}
          {"\n\n"}
          {error.stack}
        </pre>
      </details>
      <div className="flex max-w-full flex-wrap justify-center gap-2">
        <button
          className="rounded-[6px] bg-primary/10 px-3 py-1.5 font-medium text-[12px] text-primary transition-colors hover:bg-primary/20"
          onClick={onReset}
          type="button"
        >
          {t("retry")}
        </button>
        <button
          className="rounded-[6px] bg-primary px-3 py-1.5 font-medium text-[12px] text-primary-foreground transition-opacity hover:opacity-90"
          onClick={() => setReportOpen(true)}
          type="button"
        >
          {t("diagnosticsFeedbackThisError")}
        </button>
        <button
          className="rounded-[6px] border border-border px-3 py-1.5 text-[12px] text-muted-foreground transition-colors hover:text-foreground"
          onClick={() => {
            navigator.clipboard.writeText(
              `${error.message}\n\n${error.stack || ""}`
            );
          }}
          type="button"
        >
          {t("errorCopy")}
        </button>
        <button
          className="rounded-[6px] border border-border px-3 py-1.5 text-[12px] text-muted-foreground transition-colors hover:text-foreground"
          onClick={() => {
            window.location.reload();
          }}
          type="button"
        >
          {t("refresh")}
        </button>
      </div>
      <DiagnosticsReportDialog
        actualBehavior={error.message}
        incidentId={incidentId}
        onOpenChange={setReportOpen}
        open={reportOpen}
      />
    </div>
  );
}

export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { error, incidentId: undefined };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("[ErrorBoundary]", error.message, info.componentStack);
    recordRendererIncident({
      action: "react-render",
      message: error.message || "React render error",
      stack: error.stack,
      componentStack: info.componentStack ?? undefined,
      route: window.location.pathname,
    })
      .then(({ id }) => {
        if (this.state.error === error) {
          this.setState({ incidentId: id });
        }
      })
      .catch(() => {
        // The report dialog can still create a manual incident if IPC failed.
      });
  }

  handleReset = () => {
    this.setState({ error: null, incidentId: undefined });
  };

  render() {
    if (this.state.error) {
      if (this.props.fallback) {
        return this.props.fallback;
      }

      return (
        <ErrorBoundaryInner
          error={this.state.error}
          incidentId={this.state.incidentId}
          onReset={this.handleReset}
        />
      );
    }

    return this.props.children;
  }
}
